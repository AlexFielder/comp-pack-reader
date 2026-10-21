import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseReferences, parseCodeSpan, parseLinkTarget, isFileLike } from '../src/parser';

const simple = (text: string) =>
  parseReferences(text).map((r) => ({
    kind: r.kind,
    path: r.path,
    lines: r.lines.map((l) => [l.start, l.end]),
    inherited: r.inherited,
    strong: r.strong,
  }));

test('code span with full path and one line', () => {
  assert.deepEqual(simple('See `src/Datum.Web/Program.cs:131`.'), [
    { kind: 'code', path: 'src/Datum.Web/Program.cs', lines: [[131, 131]], inherited: false, strong: true },
  ]);
});

test('code span with a range', () => {
  assert.deepEqual(simple('(`src/Datum.Web/Services/DatumStore.cs:58-92`)')[0].lines, [[58, 92]]);
});

test('code span with a list, with and without spaces, and mixed ranges', () => {
  assert.deepEqual(simple('`AssessmentRun.razor:437, 495`')[0].lines, [[437, 437], [495, 495]]);
  assert.deepEqual(simple('`src/Datum.Web/Components/App.razor:12,17`')[0].lines, [[12, 12], [17, 17]]);
  assert.deepEqual(simple('`Components/Person/PersonBenchmark.razor:11-14, 45-52`')[0].lines, [[11, 14], [45, 52]]);
  assert.deepEqual(simple('`CompanyGrading.cs:130-131, 171`')[0].lines, [[130, 131], [171, 171]]);
});

test('line offsets point at each number', () => {
  const text = 'x `AssessmentRun.razor:437, 495` y';
  const [ref] = parseReferences(text);
  assert.equal(text.slice(ref.textFrom, ref.textTo), 'AssessmentRun.razor:437, 495');
  assert.equal(text.slice(ref.lines[0].from, ref.lines[0].to), '437');
  assert.equal(text.slice(ref.lines[1].from, ref.lines[1].to), '495');
});

test('bare filename with and without a line', () => {
  assert.deepEqual(simple('`PeopleLib.cs:12`'), [{ kind: 'code', path: 'PeopleLib.cs', lines: [[12, 12]], inherited: false, strong: true }]);
  assert.deepEqual(simple('`McpCode.cs`'), [{ kind: 'code', path: 'McpCode.cs', lines: [], inherited: false, strong: false }]);
});

test('folder and partial paths', () => {
  assert.equal(simple('`src/Datum.Web`')[0].strong, false);
  assert.equal(simple('`.github/workflows/deploy.yml`')[0].strong, true);
  assert.equal(simple('`Migrations/20261016130210_McpV2DataModel.cs:4715-4766`')[0].path, 'Migrations/20261016130210_McpV2DataModel.cs');
});

test('line-only shorthand inherits the previous file in the section', () => {
  const text = [
    '- shows `BadgeAward` (`Components/Pages/BusinessProfile.razor:227-235`).',
    '- "In good standing" is a literal (`:32`).',
    '- falls back (`:243-245`).',
  ].join('\n');
  const refs = simple(text);
  assert.deepEqual(refs.slice(1), [
    { kind: 'code', path: 'Components/Pages/BusinessProfile.razor', lines: [[32, 32]], inherited: true, strong: true },
    { kind: 'code', path: 'Components/Pages/BusinessProfile.razor', lines: [[243, 245]], inherited: true, strong: true },
  ]);
});

test('a heading resets the section context', () => {
  const refs = simple('`src/A.cs:1`\n\n## Next\n\nline only (`:32`)');
  assert.equal(refs.length, 1);
});

test('type names do not become the inherited file', () => {
  const refs = parseReferences('`src/A.cs:1` then `PeopleLib.TrustState` then (`:5`)');
  assert.equal(refs.at(-1)!.path, 'src/A.cs');
  assert.deepEqual(refs.at(-1)!.context, ['src/A.cs']);
});

test('context lists earlier file paths, most recent first', () => {
  const refs = parseReferences('`src/Web/Pages/A.razor:1`, `src/Web/Pages/B.razor:2`, `C.razor:3`');
  assert.deepEqual(refs[2].context, ['src/Web/Pages/B.razor', 'src/Web/Pages/A.razor']);
});

test('non-references in code spans are ignored', () => {
  const ignored = [
    'master', 'DatumStore', 'List<T>', '/people/{anyId}', 'MCP-{P|B|A}-XXXX-XXXX', 'char(9)', 'datum-user',
    'src/Datum.Domain/Entities/*.cs', 'docs/**', '*.md', "EXEC(N'...')", 'sqlcmd -I -b -i', 'GET /demo/view/{id}',
    '((List<T>)Store.X).Add(...)', 'Keycloak__ClientSecret', '412b59e', '`', '2026.0.22.26', 'a  b.cs',
  ];
  for (const s of ignored) assert.equal(parseCodeSpan(s), undefined, s);
});

test('weak candidates parse but are not strong', () => {
  for (const s of ['PeopleLib.TrustState', 'datum.afautomations.co.uk', '/business', 'C:\\inetpub\\dpkeys\\datum', 'web.config']) {
    const refs = parseReferences('`' + s + '`');
    assert.equal(refs.length, 1, s);
    assert.equal(refs[0].strong, false, s);
  }
});

test('fenced code and Mermaid blocks are skipped', () => {
  const text = '```mermaid\nA --> B[`src/A.cs:1`]\n```\n~~~\n`src/B.cs:2`\n~~~\n`src/C.cs:3`';
  assert.deepEqual(simple(text).map((r) => r.path), ['src/C.cs']);
});

test('contract v2 links: pack-relative targets with #L anchors', () => {
  const refs = simple(
    '[src/A.cs:131](../../src/A.cs#L131), [src/A.cs:58-92](../../src/A.cs#L58-L92), [src/Rules/](../../src/Rules/)',
  );
  assert.deepEqual(refs, [
    { kind: 'link', path: '../../src/A.cs', lines: [[131, 131]], inherited: false, strong: true },
    { kind: 'link', path: '../../src/A.cs', lines: [[58, 92]], inherited: false, strong: true },
    { kind: 'link', path: '../../src/Rules/', lines: [], inherited: false, strong: true },
  ]);
});

test('contract v1 root-relative links and the desktop app path:line form', () => {
  assert.deepEqual(simple('[x](/src/A.cs#L5-10)')[0].lines, [[5, 10]]);
  assert.deepEqual(simple('[x](/src/A.cs#L5)')[0].path, '/src/A.cs');
  assert.deepEqual(simple('[Bar.tsx:42](app/Bar.tsx:42)')[0], { kind: 'link', path: 'app/Bar.tsx', lines: [[42, 42]], inherited: false, strong: true });
  assert.deepEqual(simple('[x](app/Bar.tsx:42-50)')[0].lines, [[42, 50]]);
});

test('link text range excludes the brackets', () => {
  const text = 'a [src/A.cs:1](../../src/A.cs#L1) b';
  const [ref] = parseReferences(text);
  assert.equal(text.slice(ref.textFrom, ref.textTo), 'src/A.cs:1');
});

test('URLs, anchors and images are not references', () => {
  assert.deepEqual(simple('[a](https://github.com/x/y) [b](#section) ![c](img.png) [d](mailto:x@y.z)'), []);
});

test('a code span inside link text belongs to the link', () => {
  const refs = simple('[`src/A.cs:1`](../../src/A.cs#L1)');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, 'link');
});

test('link targets: encoding, angle brackets, Windows paths and other fragments', () => {
  assert.deepEqual(parseLinkTarget('../../My%20Docs/a.md#L3'), { path: '../../My Docs/a.md', start: 3, end: 3 });
  assert.deepEqual(parseLinkTarget('<../../My Docs/a.md>'), { path: '../../My Docs/a.md', start: undefined, end: undefined });
  assert.deepEqual(parseLinkTarget('C:/repo/a.cs#L2'), { path: 'C:/repo/a.cs', start: 2, end: 2 });
  assert.deepEqual(parseLinkTarget('other.md#some-heading'), { path: 'other.md', start: undefined, end: undefined });
  assert.equal(parseLinkTarget('vscode://file/x'), undefined);
});

test('CRLF line endings keep offsets right', () => {
  const text = 'one\r\n`src/A.cs:7`\r\n';
  const [ref] = parseReferences(text);
  assert.equal(text.slice(ref.textFrom, ref.textTo), 'src/A.cs:7');
});

test('isFileLike', () => {
  assert.ok(isFileLike('McpCode.cs'));
  assert.ok(isFileLike('src/Datum.Web/'));
  assert.ok(!isFileLike('PeopleLib.TrustState'));
  assert.ok(!isFileLike('Datum.Web'));
});
