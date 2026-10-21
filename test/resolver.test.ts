import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveReference, breakTie } from '../src/resolver';
import { buildIndex, findRepoRoot, nodeProbe } from '../src/workspace';
import { analyse } from '../src/analysis';
import { readLines } from '../src/workspace';

let root: string;
let pack: string;

function write(rel: string, lines = 10) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-pack-'));
  fs.mkdirSync(path.join(root, '.git'));
  write('src/Web/Program.cs', 200);
  write('src/Web/Pages/AssessmentRun.razor', 500);
  write('src/Web/Services/Access.cs');
  write('src/Api/Program.cs');
  write('src/Domain/Rules/McpCode.cs');
  write('tests/Domain/Rules/McpCodeTests.cs');
  write('.claude/worktrees/phase-c/src/Web/Program.cs');
  write('node_modules/x/index.js');
  pack = path.join(root, 'docs', 'comprehension', '2026-10-21-comprehension-pass.md');
  fs.mkdirSync(path.dirname(pack), { recursive: true });
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

const index = () => buildIndex(root, ['.git', 'node_modules', '.claude/worktrees']);
const resolve = (p: string, context: string[] = []) => resolveReference({ path: p, documentPath: pack, context }, index(), nodeProbe);
const rel = (abs: string) => path.relative(root, abs).replace(/\\/g, '/');

test('finds the repository root from the pack folder', () => {
  assert.equal(findRepoRoot(path.dirname(pack)), root);
});

test('index skips excluded folder names and paths', () => {
  const files = index().files;
  assert.ok(!files.some((f) => f.includes('node_modules') || f.includes('worktrees')));
  assert.ok(files.includes('src/Web/Program.cs'));
});

test('pack-relative target (contract v2)', () => {
  const r = resolve('../../src/Web/Program.cs');
  assert.equal(r.status, 'ok');
  assert.equal(r.status === 'ok' && r.via, 'relative');
});

test('root-relative target (contract v1) resolves against the git root', () => {
  const r = resolve('/src/Web/Program.cs');
  assert.equal(r.status === 'ok' && rel(r.target), 'src/Web/Program.cs');
  assert.equal(r.status === 'ok' && r.via, 'root');
});

test('repo-root-relative code span', () => {
  const r = resolve('src/Web/Services/Access.cs');
  assert.equal(r.status === 'ok' && r.via, 'root');
});

test('bare filename with a unique match', () => {
  const r = resolve('AssessmentRun.razor');
  assert.equal(r.status === 'ok' && rel(r.target), 'src/Web/Pages/AssessmentRun.razor');
  assert.equal(r.status === 'ok' && r.via, 'search');
});

test('partial path', () => {
  const r = resolve('Services/Access.cs');
  assert.equal(r.status === 'ok' && rel(r.target), 'src/Web/Services/Access.cs');
});

test('suffix search matches whole segments only', () => {
  assert.equal(resolve('Code.cs').status, 'missing');
});

test('ambiguous bare filename without context', () => {
  const r = resolve('Program.cs');
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.status === 'ambiguous' && r.candidates.map(rel).sort(), ['src/Api/Program.cs', 'src/Web/Program.cs']);
});

test('ambiguity broken by the section context', () => {
  const r = resolve('Program.cs', ['src/Web/Pages/AssessmentRun.razor']);
  assert.equal(r.status === 'ok' && rel(r.target), 'src/Web/Program.cs');
});

test('breakTie falls through to older context and gives up on a draw', () => {
  assert.equal(breakTie(['src/Web/A.cs', 'src/Api/A.cs'], ['docs/x.md', 'src/Api/B.cs']), 'src/Api/A.cs');
  assert.equal(breakTie(['src/Web/A.cs', 'src/Api/A.cs'], ['src/Other/B.cs']), undefined);
});

test('folders resolve, with or without a trailing slash', () => {
  const r = resolve('src/Domain/Rules/');
  assert.equal(r.status === 'ok' && r.isFolder, true);
  const bare = resolve('Rules');
  assert.equal(bare.status, 'ambiguous'); // src/Domain/Rules and tests/Domain/Rules
});

test('absolute paths', () => {
  assert.equal(resolve(path.join(root, 'src', 'Api', 'Program.cs')).status, 'ok');
  assert.equal(resolve('C:\\definitely\\not\\here.cs').status, 'missing');
});

test('an abbreviated filename resolves to the earlier file it shortens', () => {
  write('src/Data/Migrations/20261016130210_McpV2DataModel.cs');
  const r = resolve('McpV2DataModel.cs', ['Migrations/20261016130210_McpV2DataModel.cs']);
  assert.equal(r.status === 'ok' && rel(r.target), 'src/Data/Migrations/20261016130210_McpV2DataModel.cs');
  assert.equal(resolve('McpV2DataModel.cs').status, 'missing');
});

test('a leading slash is anchored at the root and never searched for', () => {
  fs.mkdirSync(path.join(root, 'src', 'Web', 'Business'), { recursive: true });
  assert.equal(resolve('/business').status, 'missing');
  assert.equal(resolve('/Program.cs').status, 'missing');
});

test('missing file', () => {
  assert.equal(resolve('src/Nope.cs').status, 'missing');
});

test('analyse reports broken references and out-of-range lines, not weak misses', () => {
  const text = [
    '`Program.cs:5` ambiguous',
    '`src/Web/Program.cs:131` ok',
    '`src/Web/Program.cs:4715` past the end',
    '`src/Nope.cs:3` missing',
    '`Nope.TypeName` weak, ignored',
    '`tests/Web.Tests` weak folder name, ignored',
    '[src/Web/Program.cs:1](/src/Web/Program.cs#L1) v1 form',
  ].join('\n');
  const a = analyse(text, pack, { findRepoRoot, index: () => index(), probe: nodeProbe, readLines });
  const msgs = a.problems.map((p) => `${p.severity}: ${text.slice(p.from, p.to)}`);
  assert.deepEqual(msgs, [
    'info: Program.cs:5',
    'warning: 4715',
    'warning: src/Nope.cs:3',
    'info: src/Web/Program.cs:1',
  ]);
  assert.match(a.problems[3].message, /\.\.\/\.\.\/src\/Web\/Program\.cs/);
});
