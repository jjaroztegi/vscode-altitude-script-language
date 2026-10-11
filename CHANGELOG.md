# Changelog

All notable changes to this extension are documented here.

## [2.0.0] - 2026-10-11

Rewrite as a language server, with a real ASL parser. Not backwards compatible with 1.x settings or language ID.

### Language
- New tokenizer and parser driven by the syntax of the Altitude 8.7 ASL reference: every documented action, declaration, cursor and graphical element clause, with clauses accepted in any order. Parses real Script Developer output (including its XML trailer) without false errors.
- Names are resolved across the script, its modules (namespaced and plain imports, transitively), master nodes, default masters and blocks, with case-insensitive matching.
- Language ID is now `altitude-asl` (it clashed with Amazon States Language). Rename `[asl]` editor settings to `[altitude-asl]`.

### Diagnostics
- Undeclared names, types, record fields, enumeration members, nodes, events, controls, images and blocks; missing modules; wrong argument counts; subroutines used as values; duplicate and shadowing declarations; unused declarations; unreachable actions; undocumented events and misplaced handlers; navigation in `on exit`.
- ASL Web Edition: modal windows, function keys, `run application`, legacy built-ins and element actions; deprecated constructs (`rgbcolor`, chat control, instant messaging actions, script parameters); native DLL dependencies.
- Asynchronous popups in the Agent Portal: navigation or a second popup after an overlay on the same path, popups in `on enter`, reading the answer right after `open window`, functions that return before the answer, email editor fields set twice, buttons that hide master buttons, fixed overlay positions.
- Per-rule severity (`altitudeScriptLanguage.lint.rules`), `comment {asl-disable-next-line rule}` suppressions and `altitudeScriptLanguage.webEdition`. Rules are documented in `docs/rules.md`.

### Editor features
- Completion for actions, handlers, element clauses, record fields, module members, enumeration members, attributes, node names in strings, cursors, events and types; signature help; hover with links to the 8.7 reference.
- Go to definition and type definition, references, rename and call hierarchy across files; document and workspace symbols; semantic highlighting; folding; smart selection; document links; quick fixes; optional parameter-name inlay hints.
- Formatter that fixes structural indentation only and leaves Script Developer's layout unchanged.
- TextMate grammar generated from the language data, with embedded SQL and interpolation highlighting.
- Runs in vscode.dev and github.dev.

### Files and compiler
- Warning with a quick fix for ASL files that are not UTF-8 with BOM or use LF, and a command to convert a whole workspace.
- Compiler validation clears stale results when the file changes and shows progress when run on demand.

## [1.1.0] - 2026-07-18

- Cross-file module resolution. Scripts' `modules {}` imports are resolved transitively (open editors preferred over disk, cached by version/mtime):
  - Go to definition, hover, and find references work on `NS::symbol` across files; `NS::` offers module-symbol completions.
  - Unresolved-reference diagnostics now check imported modules: dead `goto node` targets, broken `call NS::Sub(...)` calls, and `NS::cursor` references are reported; module files themselves skip unqualified node checks (they may target host-script nodes).
  - `.gem` DLL wrappers parse correctly (`external session stdcall subroutine/function` declarations).
  - Subroutine/function call references (`call [ns::]Name(...)`) are now validated everywhere.

## [1.0.0] - 2026-07-18

Retargeted to Altitude 8.7 (web). No backwards compatibility with the 0.x line.

- Control schemas, events, and built-in functions refreshed from the Altitude 8.7 ASL reference (e.g. `background color` on radio button/check box, email editor toolbar/button/header clauses and email events, table `on selection change`/`on sort request`; removed the nonexistent `list` element).
- Compiler validation reworked to match Script Developer's own invocation: `ec.exe /generateOnly` with the Script Developer `bin` as compiler root. Visual Studio Build Tools and `rc.exe` are no longer required. Versioned install folders (8.5/8.6/8.7) are auto-detected. Diagnostics come from the `.err` report, with stdout as fallback. On-type validation removed (on save + command remain).
- Script Developer file conventions: ASL files default to UTF-8 with BOM, CRLF (normalized on save), and tab indentation.
- Parser fixes validated against a large set of real scripts: nested record fields, module-qualified types and cursor references (`ns::name`), string-literal masking with `\'` escapes, cross-module node references, action statements misread as control declarations, and control-name duplicate noise.
- Tooling modernized: esbuild bundling, VS Code >= 1.100, implicit activation events, Node-based analyzer test harness (`npm test`).

## [0.1.0] - 2026-03-15

- Initial release of the VS Code extension for Altitude Script Language.
- Syntax highlighting, IntelliSense, navigation, formatting, snippets, and parser-based diagnostics for ASL files.
- Optional Script Developer compiler validation for `.ags` and `.irs` with auto-discovery of Script Developer, Visual Studio Build Tools, and `rc.exe`.
