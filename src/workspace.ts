// File-system side of resolution: finding the repository root, indexing its files for bare-filename
// lookups, and counting lines. Plain Node, so it works for a pack opened outside any workspace folder.

import * as fs from 'fs';
import * as path from 'path';
import { RepoIndex, FileSystemProbe } from './resolver';

const MAX_ENTRIES = 200_000;

/** The nearest folder at or above `startDir` holding `.git` (a folder, or a file in a worktree). */
export function findRepoRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Walks `root` and lists files and folders, skipping `exclude` entries. An entry without a slash
 * skips that folder name anywhere; one with a slash skips that repository-relative path.
 */
export function buildIndex(root: string, exclude: string[]): RepoIndex {
  const names = new Set(exclude.filter((e) => !e.includes('/')).map((e) => e.toLowerCase()));
  const paths = new Set(exclude.filter((e) => e.includes('/')).map((e) => e.replace(/^\/+|\/+$/g, '').toLowerCase()));
  const files: string[] = [];
  const dirs: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0 && files.length + dirs.length < MAX_ENTRIES) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (names.has(e.name.toLowerCase()) || paths.has(childRel.toLowerCase())) continue;
        dirs.push(childRel);
        stack.push(childRel);
      } else if (e.isFile()) {
        files.push(childRel);
      }
    }
  }
  return { root, files, dirs };
}

export const nodeProbe: FileSystemProbe = {
  kind(p) {
    try {
      const s = fs.statSync(p);
      return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : undefined;
    } catch {
      return undefined;
    }
  },
};

const lineCache = new Map<string, { mtimeMs: number; lines: string[] }>();

/** The file's lines (cached by modification time), or undefined if it can't be read as text. */
export function readLines(file: string): string[] | undefined {
  try {
    const stat = fs.statSync(file);
    const cached = lineCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.lines;
    if (stat.size > 20 * 1024 * 1024) return undefined;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    lineCache.set(file, { mtimeMs: stat.mtimeMs, lines });
    return lines;
  } catch {
    return undefined;
  }
}

/** Caches one index per repository root; `invalidate` drops the ones containing a changed path. */
export class IndexCache {
  private readonly cache = new Map<string, { index: RepoIndex; builtAt: number }>();
  constructor(private readonly exclude: () => string[], private readonly maxAgeMs = 5 * 60_000) {}

  get(root: string): RepoIndex {
    const hit = this.cache.get(root);
    if (hit && Date.now() - hit.builtAt < this.maxAgeMs) return hit.index;
    const index = buildIndex(root, this.exclude());
    this.cache.set(root, { index, builtAt: Date.now() });
    return index;
  }

  invalidate(changedPath?: string): void {
    if (!changedPath) {
      this.cache.clear();
      return;
    }
    const p = path.resolve(changedPath).toLowerCase();
    for (const root of [...this.cache.keys()]) {
      if (p.startsWith(root.toLowerCase() + path.sep)) this.cache.delete(root);
    }
  }
}
