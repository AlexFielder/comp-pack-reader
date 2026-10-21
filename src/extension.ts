import * as path from 'path';
import * as vscode from 'vscode';
import { analyse, Analysis, AnalysedReference, AnalysisDeps, displayPath } from './analysis';
import { lineFragment, LineSpan } from './parser';
import { compPackPlugin } from './markdownItPlugin';
import { findRepoRoot, IndexCache, nodeProbe, readLines } from './workspace';

const OPEN_COMMAND = 'compPackReader.openReference';

interface OpenArgs {
  file?: string;
  candidates?: string[];
  start?: number;
  end?: number;
}

function config() {
  return vscode.workspace.getConfiguration('compPackReader');
}

function isPackPath(fsPath: string): boolean {
  const globs = config().get<string[]>('documentGlobs', ['**/docs/comprehension/**/*.md']);
  const uri = vscode.Uri.file(fsPath);
  return globs.some((pattern) => vscode.languages.match({ pattern, scheme: 'file' }, { uri, languageId: 'markdown' } as vscode.TextDocument) > 0);
}

function isPack(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'markdown' && doc.uri.scheme === 'file' && isPackPath(doc.uri.fsPath);
}

export function activate(context: vscode.ExtensionContext) {
  const indexes = new IndexCache(() => config().get<string[]>('excludeDirectories', []));
  const deps: AnalysisDeps = { findRepoRoot, index: (root) => indexes.get(root), probe: nodeProbe, readLines };
  const analyses = new Map<string, { version: number; analysis: Analysis }>();

  const analysisFor = (doc: vscode.TextDocument): Analysis => {
    const key = doc.uri.toString();
    const hit = analyses.get(key);
    if (hit && hit.version === doc.version) return hit.analysis;
    const analysis = analyse(doc.getText(), doc.uri.fsPath, deps);
    analyses.set(key, { version: doc.version, analysis });
    return analysis;
  };

  const rangeOf = (doc: vscode.TextDocument, from: number, to: number) =>
    new vscode.Range(doc.positionAt(from), doc.positionAt(to));

  const openUri = (args: OpenArgs) => vscode.Uri.parse(`command:${OPEN_COMMAND}?${encodeURIComponent(JSON.stringify([args]))}`);

  /** Clickable ranges for one reference: the path and first line together, then each further line on its own. */
  const linksFor = (doc: vscode.TextDocument, a: AnalysedReference, repoRoot: string): vscode.DocumentLink[] => {
    const { ref, resolution: r } = a;
    const pieces: { from: number; to: number; span?: LineSpan }[] = [];
    if (ref.kind === 'link' || ref.lines.length <= 1) {
      pieces.push({ from: ref.textFrom, to: ref.textTo, span: ref.lines[0] });
    } else {
      ref.lines.forEach((span, i) => pieces.push({ from: i === 0 ? ref.textFrom : span.from, to: span.to, span }));
    }
    return pieces.map(({ from, to, span }) => {
      let link: vscode.DocumentLink;
      if (r.status === 'ambiguous') {
        link = new vscode.DocumentLink(rangeOf(doc, from, to), openUri({ candidates: r.candidates, start: span?.start, end: span?.end }));
        link.tooltip = `${r.candidates.length} files match: pick one`;
      } else if (r.status === 'ok' && r.isFolder) {
        link = new vscode.DocumentLink(rangeOf(doc, from, to), vscode.Uri.parse(`command:revealInExplorer?${encodeURIComponent(JSON.stringify([vscode.Uri.file(r.target)]))}`));
        link.tooltip = `Reveal ${displayPath(r.target, repoRoot)} in the Explorer`;
      } else if (r.status === 'ok') {
        link = new vscode.DocumentLink(rangeOf(doc, from, to), openUri({ file: r.target, start: span?.start, end: span?.end }));
        link.tooltip = `Open ${displayPath(r.target, repoRoot)}${span ? ':' + lineFragment(span).replace(/L/g, '') : ''}`;
      } else {
        return undefined;
      }
      return link;
    }).filter((l): l is vscode.DocumentLink => !!l);
  };

  const linkProvider: vscode.DocumentLinkProvider = {
    provideDocumentLinks(doc) {
      if (!isPack(doc)) return [];
      const analysis = analysisFor(doc);
      return analysis.references.flatMap((a) => linksFor(doc, a, analysis.repoRoot));
    },
  };

  const hoverProvider: vscode.HoverProvider = {
    provideHover(doc, position) {
      if (!isPack(doc)) return undefined;
      const offset = doc.offsetAt(position);
      const analysis = analysisFor(doc);
      const a = analysis.references.find((x) => offset >= x.ref.textFrom && offset <= x.ref.textTo);
      if (!a) return undefined;
      const r = a.resolution;
      const md = new vscode.MarkdownString();
      if (r.status === 'ambiguous') {
        md.appendMarkdown(`**${r.candidates.length} files match \`${a.ref.path}\`:**\n\n`);
        for (const c of r.candidates) md.appendMarkdown(`- ${displayPath(c, analysis.repoRoot)}\n`);
        return new vscode.Hover(md, rangeOf(doc, a.ref.textFrom, a.ref.textTo));
      }
      if (r.status !== 'ok') return undefined;
      const shown = displayPath(r.target, analysis.repoRoot);
      if (r.isFolder) {
        md.appendMarkdown(`Folder **${shown}**`);
        return new vscode.Hover(md);
      }
      const lines = readLines(r.target);
      const spanAtCursor = a.ref.lines.find((s) => offset >= s.from && offset <= s.to) ?? a.ref.lines[0];
      const spans = spanAtCursor ? [spanAtCursor, ...a.ref.lines.filter((s) => s !== spanAtCursor)].slice(0, 3) : [];
      md.appendMarkdown(`**${shown}**${lines ? ` (${lines.length} lines)` : ''}\n\n`);
      if (lines && spans.length > 0) {
        const extra = Math.max(0, config().get<number>('hoverContextLines', 2));
        const lang = path.extname(r.target).slice(1);
        for (const s of spans) {
          if (s.start > lines.length) {
            md.appendMarkdown(`Line ${s.start} is past the end of the file.\n\n`);
            continue;
          }
          const from = Math.max(1, s.start - extra);
          const to = Math.min(lines.length, Math.min(s.end, s.start + 39) + extra);
          const width = String(to).length;
          const body = lines
            .slice(from - 1, to)
            .map((l, i) => {
              const n = from + i;
              const mark = n >= s.start && n <= s.end ? '>' : ' ';
              return `${mark}${String(n).padStart(width)}  ${l}`;
            })
            .join('\n');
          md.appendMarkdown(`Lines ${s.start}${s.end > s.start ? '-' + s.end : ''}:\n`);
          md.appendCodeblock(body, lang);
        }
      }
      return new vscode.Hover(md);
    },
  };

  const diagnostics = vscode.languages.createDiagnosticCollection('comp-pack');
  const refreshDiagnostics = (doc: vscode.TextDocument) => {
    if (!isPack(doc) || !config().get<boolean>('diagnostics', true)) {
      diagnostics.delete(doc.uri);
      return;
    }
    const analysis = analysisFor(doc);
    diagnostics.set(
      doc.uri,
      analysis.problems.map((p) => {
        const d = new vscode.Diagnostic(
          rangeOf(doc, p.from, p.to),
          p.message,
          p.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
        );
        d.source = 'comp pack';
        return d;
      }),
    );
  };

  let pending: NodeJS.Timeout | undefined;
  const scheduleRefresh = (doc: vscode.TextDocument) => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => refreshDiagnostics(doc), 400);
  };

  const openReference = async (args: OpenArgs) => {
    let file = args?.file;
    if (!file && args?.candidates?.length) {
      const items = args.candidates.map((c) => ({ label: path.basename(c), description: vscode.workspace.asRelativePath(c), file: c }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Several files match this reference. Pick one.' });
      file = picked?.file;
    }
    if (!file) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (args.start) {
      const last = Math.max(0, doc.lineCount - 1);
      const start = Math.min(args.start - 1, last);
      const end = Math.min((args.end ?? args.start) - 1, last);
      options.selection = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
    }
    const editor = await vscode.window.showTextDocument(doc, options);
    if (options.selection) editor.revealRange(options.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };

  const checkReferences = async () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'markdown') {
      vscode.window.showInformationMessage('Open a comprehension pack (a Markdown file) first.');
      return;
    }
    indexes.invalidate();
    analyses.delete(doc.uri.toString());
    const analysis = analyse(doc.getText(), doc.uri.fsPath, deps);
    analyses.set(doc.uri.toString(), { version: doc.version, analysis });
    refreshDiagnostics(doc);
    const warnings = analysis.problems.filter((p) => p.severity === 'warning').length;
    const notes = analysis.problems.length - warnings;
    const msg = `${analysis.references.length} references open in ${path.basename(analysis.repoRoot)}. ${warnings} broken, ${notes} notes.`;
    const choice = await vscode.window.showInformationMessage(msg, ...(analysis.problems.length ? ['Show problems'] : []));
    if (choice) vscode.commands.executeCommand('workbench.actions.view.problems');
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
  const onTreeChange = (uri: vscode.Uri) => {
    indexes.invalidate(uri.fsPath);
    analyses.clear();
  };

  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider({ language: 'markdown', scheme: 'file' }, linkProvider),
    vscode.languages.registerHoverProvider({ language: 'markdown', scheme: 'file' }, hoverProvider),
    vscode.commands.registerCommand(OPEN_COMMAND, openReference),
    vscode.commands.registerCommand('compPackReader.checkReferences', checkReferences),
    diagnostics,
    watcher,
    watcher.onDidCreate(onTreeChange),
    watcher.onDidDelete(onTreeChange),
    vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
    vscode.workspace.onDidSaveTextDocument((d) => {
      analyses.clear(); // a saved source file can change line counts
      refreshDiagnostics(d);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleRefresh(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => {
      diagnostics.delete(d.uri);
      analyses.delete(d.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('compPackReader')) return;
      indexes.invalidate();
      analyses.clear();
      vscode.workspace.textDocuments.forEach(refreshDiagnostics);
    }),
  );
  vscode.workspace.textDocuments.forEach(refreshDiagnostics);

  return {
    extendMarkdownIt(md: Parameters<typeof compPackPlugin>[0]) {
      compPackPlugin(md, { deps, isPack: isPackPath });
      return md;
    },
  };
}

export function deactivate() {}
