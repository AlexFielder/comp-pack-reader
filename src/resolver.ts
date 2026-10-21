// Resolves a reference's path to a file or folder in the pack's repository.
//
// Order: an absolute path as written; a root-relative link (/src/A.cs) against the repository root;
// a relative path against the pack's folder, then the repository root; and finally a suffix search
// of the repository for bare filenames and partial paths (`AssessmentRun.razor`, `Services/Access.cs`).
// A suffix search with several matches is broken by the section's earlier references, else it's ambiguous.

import * as path from 'path';

export interface RepoIndex {
  /** Absolute repository root. */
  root: string;
  /** Repository-relative file paths with forward slashes. */
  files: string[];
  /** Repository-relative folder paths with forward slashes, no trailing slash. */
  dirs: string[];
}

export type Resolution =
  | { status: 'ok'; target: string; isFolder: boolean; via: 'absolute' | 'root' | 'relative' | 'search' }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'missing' };

export interface ResolveInput {
  path: string;
  /** Absolute path of the Markdown file holding the reference. */
  documentPath: string;
  /** Earlier paths in the same section, most recent first. */
  context: string[];
}

export interface FileSystemProbe {
  /** 'file', 'dir' or undefined when nothing exists at the absolute path. */
  kind(absolutePath: string): 'file' | 'dir' | undefined;
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

function norm(s: string): string {
  return caseInsensitive ? s.toLowerCase() : s;
}

function toSlash(s: string): string {
  return s.replace(/\\/g, '/');
}

function isAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || (process.platform !== 'win32' && p.startsWith('/') && !p.startsWith('//'));
}

function dirSegments(rel: string): string[] {
  const parts = toSlash(rel).split('/').filter(Boolean);
  parts.pop();
  return parts;
}

function commonPrefix(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && norm(a[n]) === norm(b[n])) n++;
  return n;
}

function suffixMatches(entries: string[], suffix: string): string[] {
  const s = norm(suffix);
  return entries.filter((e) => {
    const ne = norm(e);
    return ne === s || ne.endsWith('/' + s);
  });
}

/** Picks the candidate sharing the most leading folders with the section's most recent references. */
export function breakTie(candidates: string[], context: string[]): string | undefined {
  for (const c of context) {
    const ctx = dirSegments(c.replace(/^\/+/, ''));
    if (ctx.length === 0) continue;
    const scored = candidates.map((cand) => ({ cand, score: commonPrefix(dirSegments(cand), ctx) }));
    const best = Math.max(...scored.map((s) => s.score));
    if (best === 0) continue;
    const top = scored.filter((s) => s.score === best);
    if (top.length === 1) return top[0].cand;
  }
  return undefined;
}

/**
 * A shortened name for a file cited earlier in the section, such as `McpV2DataModel.cs` after
 * `Migrations/20261016130210_McpV2DataModel.cs`: the earlier path's filename ends with this one.
 */
function abbreviation(suffix: string, input: ResolveInput, index: RepoIndex, fsProbe: FileSystemProbe): Resolution | undefined {
  if (suffix.includes('/')) return undefined;
  const name = norm(suffix);
  for (const c of input.context) {
    const base = norm(toSlash(c).split('/').filter(Boolean).pop() ?? '');
    if (base === name || !base.endsWith(name)) continue;
    const r = resolveReference({ ...input, path: c, context: [] }, index, fsProbe);
    if (r.status === 'ok') return r;
  }
  return undefined;
}

export function resolveReference(input: ResolveInput, index: RepoIndex, fsProbe: FileSystemProbe): Resolution {
  const written = input.path.trim();
  if (!written) return { status: 'missing' };
  const wantsFolder = /[\\/]$/.test(written);
  const ok = (abs: string, via: 'absolute' | 'root' | 'relative' | 'search'): Resolution | undefined => {
    const kind = fsProbe.kind(abs);
    if (!kind) return undefined;
    return { status: 'ok', target: path.normalize(abs), isFolder: kind === 'dir', via };
  };

  if (isAbsolute(written)) {
    return ok(written, 'absolute') ?? { status: 'missing' };
  }

  const relative = toSlash(written).replace(/^\.\//, '');
  if (relative.startsWith('/')) {
    // Anchored at the root, so never searched for: in a code span `/business` is a web route.
    return ok(path.join(index.root, relative.slice(1)), 'root') ?? { status: 'missing' };
  } else {
    const hit =
      ok(path.resolve(path.dirname(input.documentPath), relative), 'relative') ??
      ok(path.join(index.root, relative), 'root');
    if (hit) return hit;
  }

  // Suffix search: bare filenames and partial paths. `../` prefixes can't be searched for.
  const suffix = relative.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!suffix || suffix.split('/').some((s) => s === '..' || s === '.')) return { status: 'missing' };
  let matches = wantsFolder ? [] : suffixMatches(index.files, suffix);
  if (matches.length === 0) matches = suffixMatches(index.dirs, suffix);
  if (matches.length === 0) return abbreviation(suffix, input, index, fsProbe) ?? { status: 'missing' };
  const pick = matches.length === 1 ? matches[0] : breakTie(matches, input.context);
  if (pick) return ok(path.join(index.root, pick), 'search') ?? { status: 'missing' };
  return { status: 'ambiguous', candidates: matches.map((m) => path.join(index.root, m)) };
}
