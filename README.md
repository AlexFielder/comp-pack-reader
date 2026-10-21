# Comp Pack Reader

A VS Code extension that makes a comprehension pack's code references clickable. Hold Ctrl and click `src/Datum.Web/Program.cs:131` (or a bare `AssessmentRun.razor:437, 495`) in a pack, and VS Code opens that file with the lines selected. Hover a reference to read the lines without leaving the pack. The extension also flags references whose file is missing or whose line is past the end of the file.

It works in any repository and has no AFAutomations-specific paths. A pack is any Markdown file under `docs/comprehension/`; the `compPackReader.documentGlobs` setting changes that.

## What it reads

| Form | Example | Editor | Preview |
|---|---|---|---|
| Contract v2 link (current) | `[src/A.cs:131](../../src/A.cs#L131)` | link text and target clickable | VS Code handles it |
| Contract v1 link | `[src/A.cs:131](/src/A.cs#L131)` | resolved from the git root, not the open folder | rewritten to `../../src/A.cs#L131` |
| Claude desktop app link | `[A.cs:42](src/A.cs:42)` | yes | rewritten |
| Code span, full path | `` `src/A.cs:131` ``, `` `src/A.cs:58-92` `` | yes | becomes a link |
| Code span, list of lines | `` `A.cs:437, 495` ``, `` `A.cs:11-14, 45-52` `` | one link per line | one link per line |
| Bare filename or partial path | `` `PeopleLib.cs:12` ``, `` `Services/Access.cs:36` `` | found by searching the repository | yes |
| Shortened filename | `` `McpV2DataModel.cs:4670` `` after `` `Migrations/20261016130210_McpV2DataModel.cs:4715` `` | matched to the earlier file | yes |
| Line-only shorthand | `` (`:32`) `` | uses the previous file in the same section | yes |
| Folder | `` `src/Datum.Web` ``, `[src/Rules/](../../src/Rules/)` | reveals it in the Explorer | VS Code handles it |

**How a bare filename resolves:** the extension searches the repository holding the pack (found by its `.git`), skipping `.git`, `node_modules`, `bin`, `obj`, `.vs`, `.idea`, `TestResults` and `.claude/worktrees` (setting `compPackReader.excludeDirectories`).
- **One match:** it opens.
- **Several matches:** the extension picks the one sharing the most folders with the earlier references in the same section (since the last heading).
- **Still tied:** the editor link shows a picker, and the Problems panel lists the candidates.

**Code spans that aren't file references stay plain.** Type names (`PeopleLib.TrustState`), routes (`/business`), globs (`src/*.cs`), commands and identifiers don't become links. A span is reported as broken only when it is unmistakably a file reference: it has a line number, or a folder and a source-file extension.

**Commands:**
- **Comp Pack: Check References in This File** re-indexes the repository and summarises what resolved.
- **Comp Pack: Open Reference** is what the links call.

## Install

Download `comp-pack-reader-<version>.vsix` from the [releases page](https://github.com/AlexFielder/comp-pack-reader/releases), then:

```powershell
code-insiders --install-extension C:\AFAutomations\GitHub\comp-pack-reader\comp-pack-reader-0.1.0.vsix
```

Use `code` instead of `code-insiders` for stable VS Code. It needs VS Code 1.95 or later, and passes the integration run in both stable 1.139.1 and Insiders 1.142.0.

To build it yourself: `npm ci --ignore-scripts`, then `npm run package`.

## Findings

### Which VS Code mechanism to use

I chose a **`DocumentLinkProvider`** as the core, plus three small additions on the same parser. One parser and resolver (`src/parser.ts`, `src/resolver.ts`, `src/analysis.ts`) feeds all four.

| Option | Verdict | Why |
|---|---|---|
| `DocumentLinkProvider` (editor) | **Built** | The editor is where a pack gets studied beside the code. Ctrl+click is the native gesture, and it works for every legacy form, which plain Markdown can't link. |
| Hover provider | **Built** | Reading the cited lines in place is the cheapest way to check a claim, and it costs about 50 lines of code. |
| Diagnostics (instead of a tree view) | **Built** | A tree view of every reference duplicates the document. Diagnostics put only the broken ones in the Problems panel, with a squiggle on the reference itself, which is what a pack revision needs. |
| markdown-it plugin (preview) | **Built** | VS Code's preview already opens `../../src/A.cs#L131` links and selects the lines. The plugin adds the legacy code spans and fixes root-relative targets. |
| CodeLens | Rejected | It puts a lens above each line, and a pack has a hundred references, so the lenses would bury the prose. |
| Tree view | Rejected for now | See diagnostics. Worth adding only if packs grow cross-pack navigation. |

**Things I verified by reading VS Code 1.139.1's own code:**
- The Markdown preview's click handler sends every scheme-less `href` to VS Code. VS Code parses the fragment with `^L?(\d+)(?:,(\d+))?(?:-L?(\d+)(?:,(\d+))?)?$`, so `#L42` and `#L40-L55` both select the right lines.
- A `command:` link in the preview falls through to the webview and does nothing. So an ambiguous bare filename stays plain text in the preview; the editor link offers the picker instead.
- The Markdown engine tokenises a document **without** telling plugins which file it is (`currentDocument: undefined`), and it caches the tokens. It passes the document only at render time. The plugin therefore rewrites at render time, on copies of the tokens.

### Why the links didn't open in the Claude desktop app

Both suspected causes are real, and the second has a twist. I took these findings from the app's front-end bundle (version 3.1623.0). I read them from its code and didn't test them by clicking.

1. **Code spans aren't links, and the app links only some of them.** It turns an inline code span into a file link only when the span has at least one `/` and an extension, and it resolves that path against the **session's working directory**, not against the pack.
   - A bare `` `AssessmentRun.razor:437` `` is never clickable.
   - `` `src/Datum.Web/Program.cs:131` `` opens only when the session's working directory is the Datum repository itself. From a session started in `C:\AFAutomations\GitHub`, it points at `C:\AFAutomations\GitHub\src\Datum.Web\Program.cs`, which doesn't exist.
2. **The file pane opens only files inside the session's folders** (its working directory plus any added folders). A local session shows "This file is outside this session's folders" with an **Add folder** button. A remote session blocks the link outright: "This file is outside this session's folders, so it can't be opened here."
3. **The twist: a leading `/` breaks the desktop app.** When the file pane renders a Markdown file, it resolves link targets relative to **that file's folder**, which is what we want. It passes an absolute target straight through, though, so `/src/A.cs` means the root of the drive. That ruled out version 1 of the comp-pack contract.

**What the desktop app accepts** in a link target: `#L42`, `#L42-L50`, `:42`, `:42-50` and percent-encoding (`%20`).

### The reference format (agreed with the comp-pack skill, contract version 2)

```markdown
[src/Datum.Web/Program.cs:131](../../src/Datum.Web/Program.cs#L131)
[src/Datum.Web/Services/DatumStore.cs:58-92](../../src/Datum.Web/Services/DatumStore.cs#L58-L92)
```

- **Link text:** the repository-root path, so the reader sees where the file lives.
- **Target:** the same path relative to the pack (`../../` from `docs/comprehension/`), with GitHub-style line anchors.
- **No absolute paths.** They break on every other machine and on GitHub.

| Consumer | `../../src/A.cs#L131` (v2) | `/src/A.cs#L131` (v1) | `` `src/A.cs:131` `` |
|---|---|---|---|
| GitHub | works | works | text only |
| Claude desktop app file pane | works (target inside the session's folders) | **broken**: resolves from the drive root | only if the session's working directory is the repo |
| VS Code, no extension, repo opened as the folder | works | works | text only |
| VS Code, no extension, parent folder open | works | **broken**: resolves from the open folder | text only |
| VS Code with this extension | works, plus hover and checks | works | works |

The `comp-pack` skill's `references/reference-format.md` now carries this as contract version 2.

**Opening a pack in the desktop app:** start the session in the repository, or add the repository folder to the session.

## Tests

- **`npm test`:** 49 unit tests under Node's built-in test runner.
  - **Parser:** every form above, plus the non-references in the Datum pack.
  - **Resolver:** a fixture repository with duplicate filenames, excluded worktrees, folders, abbreviations and absolute paths.
  - **Preview plugin:** run with markdown-it the way VS Code calls it, which is parse without the document, then render twice from the cached tokens.
  - **Datum pack:** when the pack exists on this machine, it must resolve with no missing files. On 2026-10-21 that was 114 references, 0 problems, in its original code-span form.
- **`integration\run.ps1 [-Pack <pack.md>] [-Insiders]`:** installs the packaged `.vsix` into a throwaway VS Code profile, so yours isn't touched. It opens the **parent** of a fixture repository, as when you open `C:\AFAutomations\GitHub`, and checks inside real VS Code that:
  - every form opens the right file and selects the right lines;
  - the ambiguous name offers a picker;
  - non-references aren't linked;
  - the hover shows the code;
  - the diagnostics match;
  - the rendered preview HTML carries the right `href`s.
  
  With `-Pack`, it also smoke-tests a real pack.

## What's left

- **A click in the preview webview:** I checked the rendered HTML and VS Code's click-handling code, but nobody has clicked a link in the preview yet. Do that once by hand.
- **A click in the Claude desktop app:** the findings above come from reading its bundle. Open a v2 pack in a session started in the repository and click a link to confirm.
- **Marketplace:** there's no listing. Releases on [GitHub](https://github.com/AlexFielder/comp-pack-reader/releases) carry the `.vsix`, and the repository is private, so only collaborators can download them.
- **Line drift:** packs pin a commit, but the extension checks lines against the working tree. A check against the pinned commit (with `git show <sha>:<path>`) would catch drift exactly.
- **Very large repositories:** the index caps at 200,000 entries and is rebuilt after 5 minutes or on file create and delete. Monorepos may want a narrower `excludeDirectories`.

## Licence

Released into the public domain under [the Unlicense](LICENSE).
