// Runs inside VS Code (--extensionTestsPath) against the INSTALLED comp-pack-reader.
// 1. Builds a fixture repository with every reference form under COMP_PACK_WORKSPACE/repo (VS Code has the
//    parent folder open, as when Alex opens C:\AFAutomations\GitHub) and checks links, hovers, diagnostics
//    and the preview's rendered HTML.
// 2. If COMP_PACK names a real pack, smoke-tests it: counts links and lists diagnostics.
const vscode = require('vscode');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(200);
  }
}

const PACK = [
  '# Fixture pack',
  '',
  '## Forms',
  '',
  '- v2 link: [src/Web/Program.cs:137](../../src/Web/Program.cs#L137)',
  '- v2 range: [src/Web/Program.cs:58-92](../../src/Web/Program.cs#L58-L92)',
  '- v1 link: [src/Web/Program.cs:12](/src/Web/Program.cs#L12)',
  '- desktop link: [Program.cs:20](src/Web/Program.cs:20)',
  '- full code span: `src/Web/Pages/AssessmentAuthor.razor:371`',
  '  - bare list: `AssessmentRun.razor:437, 495`',
  '- partial: `Migrations/20261016130210_McpV2DataModel.cs:4715-4766`, abbreviated `McpV2DataModel.cs:4670-4691`',
  '- line-only shorthand (`:32`)',
  '',
  '## A new section, so no earlier path breaks the tie',
  '',
  '- ambiguous: `Program.cs:3`',
  '- folder: [src/Web/](../../src/Web/)',
  '- broken: `src/Nope.cs:5`, past the end `src/Web/Program.cs:9999`',
  '- not references: `DatumStore`, `/business`, `List<T>`',
].join('\n');

function buildFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
  const file = (rel, n) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Array.from({ length: n }, (_, i) => `// ${rel} line ${i + 1}`).join('\n') + '\n');
  };
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  file('src/Web/Program.cs', 200);
  file('src/Api/Program.cs', 50);
  file('src/Web/Pages/AssessmentAuthor.razor', 400);
  file('src/Web/Pages/AssessmentRun.razor', 600);
  file('src/Data/Migrations/20261016130210_McpV2DataModel.cs', 5000);
  const pack = path.join(root, 'docs', 'comprehension', '2026-10-21-comprehension-pass.md');
  fs.mkdirSync(path.dirname(pack), { recursive: true });
  fs.writeFileSync(pack, PACK);
  return pack;
}

exports.run = async function () {
  const out = [];
  const log = (s) => { out.push(s); console.log(s); };
  try {
    const ext = vscode.extensions.getExtension('afautomations.comp-pack-reader');
    assert.ok(ext, 'extension not installed');
    log(`installed at ${ext.extensionPath}`);
    log(`workspace folders: ${(vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath).join(', ')}`);

    const repo = path.join(process.env.COMP_PACK_WORKSPACE, 'repo');
    const packPath = buildFixture(repo);
    const doc = await vscode.workspace.openTextDocument(packPath);
    await vscode.window.showTextDocument(doc);
    await waitFor(() => ext.isActive);
    const text = doc.getText();

    const links = await vscode.commands.executeCommand('vscode.executeLinkProvider', doc.uri);
    const ours = links.filter((l) => l.target && l.target.scheme === 'command');
    log(`fixture links: ${links.length} total, ${ours.length} from comp pack reader`);
    const linkAt = (needle, nth = 0) => {
      let at = -1;
      for (let i = 0; i <= nth; i++) at = text.indexOf(needle, at + 1);
      assert.ok(at >= 0, `needle not found: ${needle}`);
      return ours.find((l) => doc.offsetAt(l.range.start) <= at && doc.offsetAt(l.range.end) > at);
    };

    const cases = [
      ['src/Web/Program.cs:137', 'src/Web/Program.cs', 137, 137],
      ['src/Web/Program.cs:58-92', 'src/Web/Program.cs', 58, 92],
      ['src/Web/Program.cs:12', 'src/Web/Program.cs', 12, 12],
      ['Program.cs:20', 'src/Web/Program.cs', 20, 20],
      ['src/Web/Pages/AssessmentAuthor.razor:371', 'src/Web/Pages/AssessmentAuthor.razor', 371, 371],
      ['AssessmentRun.razor:437', 'src/Web/Pages/AssessmentRun.razor', 437, 437],
      ['495', 'src/Web/Pages/AssessmentRun.razor', 495, 495],
      ['Migrations/20261016130210', 'src/Data/Migrations/20261016130210_McpV2DataModel.cs', 4715, 4766],
      ['McpV2DataModel.cs:4670', 'src/Data/Migrations/20261016130210_McpV2DataModel.cs', 4670, 4691],
      [':32', 'src/Data/Migrations/20261016130210_McpV2DataModel.cs', 32, 32],
    ];
    for (const [needle, file, start, end] of cases) {
      const link = linkAt(needle);
      assert.ok(link, `no link at ${needle}`);
      const args = JSON.parse(decodeURIComponent(link.target.query))[0];
      await vscode.commands.executeCommand('compPackReader.openReference', args);
      const ed = await waitFor(() => {
        const e = vscode.window.activeTextEditor;
        return e && e.document.uri.fsPath !== doc.uri.fsPath && e;
      });
      const rel = path.relative(repo, ed.document.uri.fsPath).split(path.sep).join('/');
      assert.equal(rel, file, needle);
      assert.deepEqual([ed.selection.start.line + 1, ed.selection.end.line + 1], [start, end], needle);
      log(`OK ${needle.padEnd(28)} -> ${rel}:${start}-${end}`);
      await vscode.window.showTextDocument(doc);
    }

    const amb = linkAt('Program.cs:3');
    assert.ok(amb && JSON.parse(decodeURIComponent(amb.target.query))[0].candidates.length === 2, 'ambiguous link');
    log('OK Program.cs:3 -> picker with 2 candidates');
    for (const n of ['DatumStore', '/business', 'List<T>', 'src/Nope.cs']) assert.equal(linkAt(n), undefined, `unexpected link at ${n}`);
    log('OK non-references and broken references are not linked');

    const pos = doc.positionAt(text.indexOf('AssessmentRun.razor:437') + 3);
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, pos);
    const hoverText = hovers.flatMap((h) => h.contents.map((c) => c.value || String(c))).join('\n');
    assert.match(hoverText, /src\/Web\/Pages\/AssessmentRun\.razor/);
    assert.match(hoverText, />437  \/\/ src\/Web\/Pages\/AssessmentRun\.razor line 437/);
    log('OK hover shows the referenced lines');

    const diags = await waitFor(() => {
      const d = vscode.languages.getDiagnostics(doc.uri).filter((x) => x.source === 'comp pack');
      return d.length ? d : undefined;
    });
    const shown = diags.map((d) => `${d.severity === 0 ? 'error' : d.severity === 1 ? 'warning' : 'info'} ${doc.getText(d.range)}`).sort();
    log('diagnostics: ' + shown.join(' | '));
    assert.deepEqual(shown, ['info Program.cs:20', 'info Program.cs:3', 'info src/Web/Program.cs:12', 'warning 9999', 'warning src/Nope.cs:5']);

    const html = await vscode.commands.executeCommand('markdown.api.render', doc);
    fs.writeFileSync(path.join(process.env.COMP_PACK_WORKSPACE, 'fixture-preview.html'), html);
    for (const href of [
      '../../src/Web/Pages/AssessmentRun.razor#L437',
      '../../src/Web/Pages/AssessmentRun.razor#L495',
      '../../src/Web/Program.cs#L12', // v1 root-relative link rewritten for the preview
      '../../src/Data/Migrations/20261016130210_McpV2DataModel.cs#L4715-L4766',
    ]) {
      assert.ok(html.includes(`href="${href}"`), `preview href ${href}`);
    }
    assert.ok(!html.includes('href="command:'), 'no command links in the preview');
    log(`OK preview: ${(html.match(/class="comp-pack-ref"/g) || []).length} code-span links, v1 link rewritten`);

    // Live pack smoke test.
    if (process.env.COMP_PACK && fs.existsSync(process.env.COMP_PACK)) {
      const live = await vscode.workspace.openTextDocument(process.env.COMP_PACK);
      await vscode.window.showTextDocument(live);
      const liveLinks = await vscode.commands.executeCommand('vscode.executeLinkProvider', live.uri);
      await sleep(1500);
      const liveDiags = vscode.languages.getDiagnostics(live.uri).filter((x) => x.source === 'comp pack');
      log(`live pack ${path.basename(process.env.COMP_PACK)}: ${liveLinks.length} links (${liveLinks.filter((l) => l.target && l.target.scheme === 'command').length} from the reader), ${liveDiags.length} diagnostics`);
      for (const d of liveDiags) log(`  ${d.severity === 1 ? 'warning' : 'info'} line ${d.range.start.line + 1} ${live.getText(d.range)}: ${d.message}`);
      const liveHtml = await vscode.commands.executeCommand('markdown.api.render', live);
      log(`  preview: ${(liveHtml.match(/class="comp-pack-ref"/g) || []).length} code-span links`);
    }
    log('PASS');
  } catch (e) {
    log('FAIL ' + ((e && e.stack) || e));
    throw e;
  } finally {
    fs.writeFileSync(path.join(__dirname, 'result.txt'), out.join('\n'));
  }
};
