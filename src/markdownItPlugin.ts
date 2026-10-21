// markdown-it plugin for VS Code's built-in Markdown preview.
//
// - Code spans that resolve to a file (`src/A.cs:131`, `A.cs:437, 495`, `:32`) become links,
//   one per line number, so the legacy form is clickable in the rendered view.
// - Link targets the preview would resolve wrongly are rewritten to paths relative to the pack:
//   a root-relative `/src/A.cs#L131` resolves against the workspace folder in the preview, which
//   is only right when the repository itself is the open folder.
// - Ambiguous bare filenames stay plain: the preview only routes scheme-less links to VS Code, so a
//   command: link to the picker would do nothing there. The editor's link offers the picker instead.

import * as path from 'path';
import type MarkdownIt from 'markdown-it';
import { analyse, AnalysedReference, AnalysisDeps, displayPath } from './analysis';
import { lineFragment, parseLinkTarget, LineSpan } from './parser';
import { resolveReference } from './resolver';

type StateCore = Parameters<Parameters<MarkdownIt['core']['ruler']['push']>[1]>[0];
type Token = StateCore['tokens'][number];

export interface PluginOptions {
  deps: AnalysisDeps;
  /** Whether the document at this path is a comprehension pack. */
  isPack(documentPath: string): boolean;
}

function documentPathFromEnv(env: unknown): string | undefined {
  const doc = (env as { currentDocument?: unknown } | undefined)?.currentDocument;
  if (!doc) return undefined;
  if (typeof doc === 'string') return doc;
  const fsPath = (doc as { fsPath?: unknown }).fsPath;
  return typeof fsPath === 'string' ? fsPath : undefined;
}

export function hrefFor(target: string, documentPath: string, span?: { start: number; end: number }): string {
  const rel = path.relative(path.dirname(documentPath), target).replace(/\\/g, '/');
  const encoded = rel
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const frag = lineFragment(span);
  return frag ? `${encoded}#${frag}` : encoded;
}

function lineOf(offset: number, starts: number[]): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const SOURCE = Symbol('compPackSource');

/**
 * VS Code tokenizes a document without saying which file it is (`currentDocument` is only in the
 * render-time env) and caches the tokens, so the rewrite happens at render time on copies.
 */
export function compPackPlugin(md: MarkdownIt, options: PluginOptions): void {
  md.core.ruler.push('comp_pack_source', (state: StateCore) => {
    (state.tokens as unknown as Record<symbol, string>)[SOURCE] = state.src;
  });
  const render = md.renderer.render.bind(md.renderer);
  md.renderer.render = (tokens, opts, env) => {
    const src = (tokens as unknown as Record<symbol, string | undefined>)[SOURCE];
    const documentPath = documentPathFromEnv(env);
    if (src === undefined || !documentPath || !options.isPack(documentPath)) return render(tokens, opts, env);
    return render(rewrite(tokens, src, documentPath), opts, env);
  };

  const TokenCtor = (md.core.State.prototype as unknown as { Token: new (type: string, tag: string, nesting: number) => Token }).Token;
  const clone = (t: Token): Token => {
    const c = Object.assign(Object.create(Object.getPrototypeOf(t)), t) as Token;
    c.attrs = t.attrs ? t.attrs.map((a) => [a[0], a[1]] as [string, string]) : null;
    return c;
  };

  function rewrite(tokens: Token[], src: string, documentPath: string): Token[] {
    const analysis = analyse(src, documentPath, options.deps);
    const lineStarts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);

    const codeRefs = analysis.references
      .filter((a) => a.ref.kind === 'code' && a.resolution.status === 'ok')
      .map((a) => ({ a, line: lineOf(a.ref.textFrom, lineStarts), used: false }));

    const linkFor = (a: AnalysedReference, span: LineSpan | undefined): { href: string; title: string } => {
      const r = a.resolution;
      if (r.status !== 'ok') return { href: '', title: '' };
      const shown = displayPath(r.target, analysis.repoRoot);
      return {
        href: hrefFor(r.target, documentPath, r.isFolder ? undefined : span),
        title: span ? `${shown}:${span.start}${span.end > span.start ? '-' + span.end : ''}` : shown,
      };
    };

    const makeLink = (link: { href: string; title: string }, inner: Token[]): Token[] => {
      const open = new TokenCtor('link_open', 'a', 1);
      open.attrSet('href', link.href);
      if (link.title) open.attrSet('title', link.title);
      open.attrSet('class', 'comp-pack-ref');
      const close = new TokenCtor('link_close', 'a', -1);
      return [open, ...inner, close];
    };
    const code = (content: string): Token => {
      const t = new TokenCtor('code_inline', 'code', 0);
      t.markup = '`';
      t.content = content;
      return t;
    };
    const textToken = (content: string): Token => {
      const t = new TokenCtor('text', '', 0);
      t.content = content;
      return t;
    };

    return tokens.map((original) => {
      if (original.type !== 'inline' || !original.children) return original;
      const block = clone(original);
      const [startLine, endLine] = block.map ?? [0, lineStarts.length];
      const out: Token[] = [];
      let linkDepth = 0;
      for (const child of original.children) {
        let tok = child;
        if (tok.type === 'link_close') linkDepth--;
        if (tok.type === 'link_open') {
          linkDepth++;
          tok = clone(child);
          const href = tok.attrGet('href') ?? '';
          const target = parseLinkTarget(href);
          if (target && !href.startsWith('command:')) {
            const r = resolveReference({ path: target.path, documentPath, context: [] }, { root: analysis.repoRoot, files: [], dirs: [] }, options.deps.probe);
            if (r.status === 'ok' && r.via !== 'relative') {
              const span = target.start !== undefined ? { start: target.start, end: target.end ?? target.start } : undefined;
              tok.attrSet('href', hrefFor(r.target, documentPath, r.isFolder ? undefined : span));
            }
          }
          out.push(tok);
          continue;
        }
        if (tok.type !== 'code_inline' || linkDepth > 0) {
          out.push(tok);
          continue;
        }
        const content = tok.content.trim();
        const match = codeRefs.find(
          (c) => !c.used && c.line >= startLine && c.line < endLine && src.slice(c.a.ref.textFrom, c.a.ref.textTo) === content,
        );
        if (!match) {
          out.push(tok);
          continue;
        }
        match.used = true;
        const a = match.a;
        const spans = a.ref.lines;
        if (spans.length <= 1) {
          out.push(...makeLink(linkFor(a, spans[0]), [tok]));
          continue;
        }
        // One link per line number: `A.cs:437, 495` renders as [A.cs:437], [495].
        const base = a.ref.textFrom;
        let cursor = 0;
        spans.forEach((span, i) => {
          const pieceFrom = i === 0 ? 0 : span.from - base;
          if (pieceFrom > cursor) out.push(textToken(content.slice(cursor, pieceFrom)));
          out.push(...makeLink(linkFor(a, span), [code(content.slice(pieceFrom, span.to - base))]));
          cursor = span.to - base;
        });
        if (cursor < content.length) out.push(textToken(content.slice(cursor)));
      }
      block.children = out;
      return block;
    });
  }
}
