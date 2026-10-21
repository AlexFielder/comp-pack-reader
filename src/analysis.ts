// Parses and resolves every reference in one pack, and lists the problems worth reporting.

import * as path from 'path';
import { parseReferences, Reference, LineSpan } from './parser';
import { resolveReference, Resolution, RepoIndex, FileSystemProbe } from './resolver';

export interface Problem {
  from: number;
  to: number;
  severity: 'warning' | 'info';
  message: string;
}

export interface AnalysedReference {
  ref: Reference;
  resolution: Resolution;
}

export interface Analysis {
  repoRoot: string;
  references: AnalysedReference[];
  problems: Problem[];
}

export interface AnalysisDeps {
  findRepoRoot(dir: string): string | undefined;
  index(root: string): RepoIndex;
  probe: FileSystemProbe;
  readLines(file: string): string[] | undefined;
}

export function displayPath(target: string, repoRoot: string): string {
  const rel = path.relative(repoRoot, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : target;
}

function lineProblems(span: LineSpan, file: string, shown: string, deps: AnalysisDeps): Problem[] {
  const lines = deps.readLines(file);
  if (!lines) return [];
  const at = { from: span.from, to: span.to };
  if (span.start < 1 || span.end < span.start) {
    return [{ ...at, severity: 'warning', message: `Line range ${span.start}-${span.end} is backwards or zero.` }];
  }
  if (span.start > lines.length) {
    return [{ ...at, severity: 'warning', message: `Line ${span.start} is past the end of ${shown} (${lines.length} lines). The file may have changed since the pack was written.` }];
  }
  if (span.end > lines.length) {
    return [{ ...at, severity: 'warning', message: `Lines ${span.start}-${span.end} run past the end of ${shown} (${lines.length} lines).` }];
  }
  return [];
}

export function analyse(text: string, documentPath: string, deps: AnalysisDeps): Analysis {
  const docDir = path.dirname(documentPath);
  const repoRoot = deps.findRepoRoot(docDir) ?? docDir;
  let index: RepoIndex | undefined;
  const lazyIndex = (): RepoIndex => (index ??= deps.index(repoRoot));
  // The index is only built when a reference needs a search, so a pack of full links never walks the repo.
  const indexProxy: RepoIndex = {
    root: repoRoot,
    get files() {
      return lazyIndex().files;
    },
    get dirs() {
      return lazyIndex().dirs;
    },
  };

  const references: AnalysedReference[] = [];
  const problems: Problem[] = [];
  for (const ref of parseReferences(text)) {
    const resolution = resolveReference({ path: ref.path, documentPath, context: ref.context }, indexProxy, deps.probe);
    const at = { from: ref.textFrom, to: ref.textTo };
    if (resolution.status === 'missing') {
      if (ref.strong) {
        problems.push({ ...at, severity: 'warning', message: `Can't find ${ref.path} in ${path.basename(repoRoot)}.` });
      }
      continue;
    }
    references.push({ ref, resolution });
    if (resolution.status === 'ambiguous') {
      const shown = resolution.candidates.slice(0, 5).map((c) => displayPath(c, repoRoot));
      const more = resolution.candidates.length > 5 ? ` and ${resolution.candidates.length - 5} more` : '';
      problems.push({
        ...at,
        severity: 'info',
        message: `${ref.path} matches ${resolution.candidates.length} files: ${shown.join(', ')}${more}. Write the full path.`,
      });
      continue;
    }
    if (!resolution.isFolder) {
      const shown = displayPath(resolution.target, repoRoot);
      for (const span of ref.lines) problems.push(...lineProblems(span, resolution.target, shown, deps));
    }
    if (ref.kind === 'link' && resolution.via !== 'relative' && resolution.via !== 'absolute') {
      const suggested = path.relative(docDir, resolution.target).replace(/\\/g, '/');
      const why = ref.path.startsWith('/')
        ? "A leading / breaks in the Claude desktop app and in VS Code opened on a parent folder"
        : 'GitHub, the desktop app and VS Code resolve a target from the pack\'s folder, so only this extension can open it';
      problems.push({ ...at, severity: 'info', message: `${why}. Use ${suggested}.` });
    }
  }
  return { repoRoot, references, problems };
}
