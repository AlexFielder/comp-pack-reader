// Finds code references in a comprehension pack's Markdown.
//
// Two forms are recognised:
//   - links (the comp-pack reference contract): [src/A.cs:131](/src/A.cs#L131),
//     [src/A.cs:58-92](/src/A.cs#L58-L92), and the Claude desktop form [A.cs:42](src/A.cs:42);
//   - legacy code spans: `src/A.cs:131`, `A.cs:58-92`, `A.cs:437, 495`, `A.cs` and the
//     line-only shorthand `:32`, which borrows the file of the previous reference in the section.
//
// This module has no VS Code dependency so the unit tests can run under plain Node.

export interface LineSpan {
  start: number;
  end: number;
  /** Document offsets of this line spec's text (for a link: the whole link text). */
  from: number;
  to: number;
}

export interface Reference {
  kind: 'link' | 'code';
  /** Document offsets of the whole reference (code span content, or link text plus target). */
  from: number;
  to: number;
  /** Document offsets of the clickable text: the code span content, or the link text without brackets. */
  textFrom: number;
  textTo: number;
  /** The path as written: the link target, or the path part of a code span. Percent-decoded for links. */
  path: string;
  lines: LineSpan[];
  /** The path came from an earlier reference in the same section (line-only shorthand such as `:32`). */
  inherited: boolean;
  /** Earlier file-like paths in the same section, most recent first. Used to break ties for bare filenames. */
  context: string[];
  /**
   * The text is certainly meant as a file reference: a link, a line number, or a path with both a folder
   * and an extension. A weak reference (`Program.cs`, `Datum.Web`) is linked only if it resolves, and is
   * never reported as broken.
   */
  strong: boolean;
}

const SOURCE_EXTENSIONS = new Set(
  (
    'cs csx vb fs razor cshtml vbhtml xaml csproj vbproj fsproj sln slnx props targets config resx ' +
    'ts tsx js jsx mjs cjs vue svelte json jsonc yml yaml toml ini env md mdx txt html htm css scss less ' +
    'ps1 psm1 psd1 sh bash bat cmd py rb go rs java kt kts swift php c h cc cpp hpp m mm sql graphql proto ' +
    'tf bicep xml xsd dockerfile gradle lock iss nsi wxs ilogic iLogicVb'
  )
    .toLowerCase()
    .split(/\s+/),
);

const CODE_SPAN_REF =
  /^(?<path>(?:[A-Za-z]:(?=[\\/]))?[^\s:*?"'<>|(){}[\]`,;=$#%!^]+?)?(?::(?<lines>\d+(?:\s*[-\u2013]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-\u2013]\s*\d+)?)*))?$/;
const LINE_SPEC = /(\d+)(?:\s*[-\u2013]\s*(\d+))?/g;
const URI_SCHEME = /^[a-z][a-z0-9+.-]+:/i; // two or more characters, so `C:/x` stays a path
const LINK_FRAGMENT = /^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i;
const DESKTOP_LINE_SUFFIX = /^(?<path>.+?):(?<start>\d+)(?:[-:](?<end>\d+))?$/;

export function lastSegment(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export function extensionOf(p: string): string | undefined {
  const m = /\.([A-Za-z][A-Za-z0-9]{0,11})$/.exec(lastSegment(p));
  return m ? m[1] : undefined;
}

function hasSeparator(p: string): boolean {
  return /[\\/]/.test(p);
}

function hasSourceExtension(p: string): boolean {
  const ext = extensionOf(p);
  return !!ext && SOURCE_EXTENSIONS.has(ext.toLowerCase());
}

/** A path that looks like a file in a source tree, as opposed to a type name such as `PeopleLib.TrustState`. */
export function isFileLike(p: string): boolean {
  const ext = extensionOf(p);
  if (hasSourceExtension(p)) return true;
  return hasSeparator(p) && (ext !== undefined || /[\\/]$/.test(p));
}

/** Parses one code span's content (already trimmed). Offsets in the result are relative to `content`. */
export function parseCodeSpan(content: string):
  | { path?: string; pathTo: number; lines: { start: number; end: number; from: number; to: number }[] }
  | undefined {
  if (!content || /\s{2,}/.test(content)) return undefined;
  const m = CODE_SPAN_REF.exec(content);
  if (!m || !m.groups) return undefined;
  const path = m.groups.path;
  const linesText = m.groups.lines;
  if (!path && !linesText) return undefined;
  if (path) {
    if (/\.$/.test(path) || /^[./\\]+$/.test(path)) return undefined;
    if (!linesText && !hasSeparator(path) && extensionOf(path) === undefined) return undefined;
  }
  const lines: { start: number; end: number; from: number; to: number }[] = [];
  if (linesText) {
    const base = content.length - linesText.length;
    LINE_SPEC.lastIndex = 0;
    let lm: RegExpExecArray | null;
    while ((lm = LINE_SPEC.exec(linesText))) {
      const start = Number(lm[1]);
      const end = lm[2] ? Number(lm[2]) : start;
      lines.push({ start, end, from: base + lm.index, to: base + lm.index + lm[0].length });
    }
  }
  return { path: path || undefined, pathTo: path ? path.length : 0, lines };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parses a link target into a path and optional line range. Returns undefined for URLs and in-page anchors. */
export function parseLinkTarget(target: string): { path: string; start?: number; end?: number } | undefined {
  let t = target.trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
  if (!t || t.startsWith('#') || URI_SCHEME.test(t)) return undefined;
  const hash = t.indexOf('#');
  let pathPart = hash >= 0 ? t.slice(0, hash) : t;
  const fragment = hash >= 0 ? t.slice(hash + 1) : '';
  let start: number | undefined;
  let end: number | undefined;
  const fm = LINK_FRAGMENT.exec(fragment);
  if (fm) {
    start = Number(fm[1]);
    end = fm[2] ? Number(fm[2]) : start;
  } else if (!fragment) {
    // The Claude desktop app's own form: path:42 or path:42-50.
    const dm = DESKTOP_LINE_SUFFIX.exec(pathPart);
    if (dm && dm.groups && !/^[A-Za-z]$/.test(dm.groups.path)) {
      pathPart = dm.groups.path;
      start = Number(dm.groups.start);
      end = dm.groups.end ? Number(dm.groups.end) : start;
    }
  }
  const path = safeDecode(pathPart);
  if (!path) return undefined;
  return { path, start, end };
}

interface Fence {
  char: string;
  length: number;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const LINK = /(!?)\[((?:[^[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*(<[^>]*>|(?:[^\s()\\]|\\.|\([^\s()]*\))+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/**
 * Finds every reference in a Markdown document, skipping fenced code blocks (Mermaid included).
 * The section context (for `:32` shorthand and bare-filename tie-breaks) resets at every heading.
 */
export function parseReferences(text: string): Reference[] {
  const refs: Reference[] = [];
  let context: string[] = [];
  let lastFilePath: string | undefined;
  let fence: Fence | undefined;
  let offset = 0;

  const remember = (p: string) => {
    if (!isFileLike(p)) return;
    lastFilePath = p;
    context = [p, ...context.filter((c) => c !== p)].slice(0, 20);
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const lineStart = offset;
    offset += rawLine.length + 1;

    const fo = FENCE_OPEN.exec(line);
    if (fence) {
      if (fo && fo[1][0] === fence.char && fo[1].length >= fence.length && line.trim() === fo[1]) fence = undefined;
      continue;
    }
    if (fo) {
      fence = { char: fo[1][0], length: fo[1].length };
      continue;
    }
    if (/^ {0,3}#{1,6}(\s|$)/.test(line)) {
      context = [];
      lastFilePath = undefined;
      continue;
    }

    // Links first; code spans inside a link's text belong to the link.
    const taken: [number, number][] = [];
    const found: Reference[] = [];
    LINK.lastIndex = 0;
    let lm: RegExpExecArray | null;
    while ((lm = LINK.exec(line))) {
      taken.push([lm.index, lm.index + lm[0].length]);
      if (lm[1] === '!') continue;
      const target = parseLinkTarget(lm[3]);
      if (!target) continue;
      const textFrom = lineStart + lm.index + 1;
      const textTo = textFrom + lm[2].length;
      const lines: LineSpan[] =
        target.start !== undefined
          ? [{ start: target.start, end: target.end ?? target.start, from: textFrom, to: textTo }]
          : [];
      found.push({
        kind: 'link',
        from: lineStart + lm.index,
        to: lineStart + lm.index + lm[0].length,
        textFrom,
        textTo,
        path: target.path,
        lines,
        inherited: false,
        context: [],
        strong: true,
      });
    }

    const codeRe = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
    let cm: RegExpExecArray | null;
    while ((cm = codeRe.exec(line))) {
      const s = cm.index;
      const e = s + cm[0].length;
      if (taken.some(([a, b]) => s >= a && e <= b)) continue;
      const inner = cm[2];
      const lead = inner.length - inner.trimStart().length;
      const content = inner.trim();
      const parsed = parseCodeSpan(content);
      if (!parsed) continue;
      const contentFrom = lineStart + s + cm[1].length + lead;
      found.push({
        kind: 'code',
        from: contentFrom,
        to: contentFrom + content.length,
        textFrom: contentFrom,
        textTo: contentFrom + content.length,
        path: parsed.path ?? '',
        lines: parsed.lines.map((l) => ({ ...l, from: contentFrom + l.from, to: contentFrom + l.to })),
        inherited: !parsed.path,
        context: [],
        strong: parsed.lines.length > 0 || (!!parsed.path && hasSeparator(parsed.path) && hasSourceExtension(parsed.path)),
      });
    }

    found.sort((a, b) => a.from - b.from);
    for (const ref of found) {
      if (ref.inherited) {
        if (!lastFilePath) continue;
        ref.path = lastFilePath;
      }
      ref.context = [...context];
      refs.push(ref);
      if (!ref.inherited) remember(ref.path);
    }
  }
  return refs;
}

/** GitHub-style fragment for a line span: L42 or L40-L55. */
export function lineFragment(span: { start: number; end: number } | undefined): string {
  if (!span) return '';
  return span.end > span.start ? `L${span.start}-L${span.end}` : `L${span.start}`;
}
