import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import MarkdownIt from 'markdown-it';
import { compPackPlugin } from '../src/markdownItPlugin';
import { buildIndex, findRepoRoot, nodeProbe, readLines } from '../src/workspace';
import { parseReferences } from '../src/parser';

let root: string;
let pack: string;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-pack-md-'));
  fs.mkdirSync(path.join(root, '.git'));
  for (const f of ['src/Web/Pages/AssessmentRun.razor', 'src/Web/Program.cs', 'src/Api/Program.cs']) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), 'x\n'.repeat(600));
  }
  pack = path.join(root, 'docs', 'comprehension', 'pack.md');
  fs.mkdirSync(path.dirname(pack), { recursive: true });
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

function render(src: string) {
  const md = new MarkdownIt();
  compPackPlugin(md, {
    deps: { findRepoRoot, index: (r) => buildIndex(r, ['.git']), probe: nodeProbe, readLines },
    isPack: () => true,
  });
  return md.render(src, { currentDocument: { fsPath: pack } });
}

test('code span with a full path becomes a pack-relative link', () => {
  const html = render('See `src/Web/Program.cs:131`.');
  assert.match(html, /<a href="..\/..\/src\/Web\/Program.cs#L131" title="src\/Web\/Program.cs:131" class="comp-pack-ref"><code>src\/Web\/Program.cs:131<\/code><\/a>/);
});

test('a list of lines becomes one link per line', () => {
  const html = render('`AssessmentRun.razor:437, 495`');
  assert.match(html, /href="..\/..\/src\/Web\/Pages\/AssessmentRun.razor#L437"[^>]*><code>AssessmentRun.razor:437<\/code><\/a>, <a href="..\/..\/src\/Web\/Pages\/AssessmentRun.razor#L495"[^>]*><code>495<\/code><\/a>/);
});

test('ranges use GitHub anchors', () => {
  assert.match(render('`src/Web/Program.cs:58-92`'), /Program.cs#L58-L92"/);
});

test('line-only shorthand links to the inherited file', () => {
  assert.match(render('- `src/Web/Program.cs:1`\n- literal (`:32`)'), /href="..\/..\/src\/Web\/Program.cs#L32"[^>]*><code>:32<\/code>/);
});

test('root-relative links are rewritten relative to the pack', () => {
  assert.match(render('[src/Web/Program.cs:5](/src/Web/Program.cs#L5)'), /href="..\/..\/src\/Web\/Program.cs#L5"/);
});

test('pack-relative links are left alone', () => {
  assert.match(render('[x](../../src/Web/Program.cs#L5)'), /href="..\/..\/src\/Web\/Program.cs#L5"/);
});

test('ambiguous filenames stay plain code in the preview', () => {
  assert.doesNotMatch(render('`Program.cs:3`'), /<a /);
});

test('non-references and unresolved spans stay plain code', () => {
  const html = render('`DatumStore`, `src/Nope.cs:1`, `PeopleLib.TrustState`');
  assert.doesNotMatch(html, /<a /);
});

test('VS Code style: parse without the document, render cached tokens twice', () => {
  const md = new MarkdownIt();
  compPackPlugin(md, { deps: { findRepoRoot, index: (r) => buildIndex(r, ['.git']), probe: nodeProbe, readLines }, isPack: () => true });
  const tokens = md.parse('`AssessmentRun.razor:437, 495` and [x](/src/Web/Program.cs#L5)', { currentDocument: undefined });
  const env = { currentDocument: { fsPath: pack } };
  const first = md.renderer.render(tokens, md.options, env);
  const second = md.renderer.render(tokens, md.options, env);
  assert.equal(first, second);
  assert.equal((first.match(/class="comp-pack-ref"/g) ?? []).length, 2);
  assert.match(first, /href="..\/..\/src\/Web\/Program.cs#L5"/);
  assert.doesNotMatch(md.renderer.render(tokens, md.options, {}), /comp-pack-ref/, 'cached tokens were mutated');
});

test('documents that are not packs are untouched', () => {
  const md = new MarkdownIt();
  compPackPlugin(md, { deps: { findRepoRoot, index: (r) => buildIndex(r, []), probe: nodeProbe, readLines }, isPack: () => false });
  assert.doesNotMatch(md.render('`src/Web/Program.cs:1`', { currentDocument: { fsPath: pack } }), /<a /);
});

// The first real pack, if this machine has it: every strong reference must resolve.
const datumPack = 'C:/AFAutomations/GitHub/Datum/docs/comprehension/2026-10-21-comprehension-pass.md';
test('Datum pack: every strong reference resolves', { skip: !fs.existsSync(datumPack) }, async () => {
  const { analyse } = await import('../src/analysis');
  const text = fs.readFileSync(datumPack, 'utf8');
  const a = analyse(text, path.resolve(datumPack), {
    findRepoRoot,
    index: (r) => buildIndex(r, ['.git', 'node_modules', 'bin', 'obj', '.vs', '.claude/worktrees']),
    probe: nodeProbe,
    readLines,
  });
  const strong = parseReferences(text).filter((r) => r.strong).length;
  const report = a.problems.map((p) => `${p.severity} ${text.slice(p.from, p.to)}: ${p.message}`);
  console.log(`Datum pack: ${strong} strong references, ${a.references.length} resolved, ${a.problems.length} problems`);
  for (const line of report) console.log('  ' + line);
  assert.equal(a.problems.filter((p) => p.severity === 'warning' && /Can't find/.test(p.message)).length, 0, report.join('\n'));
});
