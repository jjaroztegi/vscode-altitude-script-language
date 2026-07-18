# Changelog

All notable changes to this extension are documented here.

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
- Parser fixes validated against 72 production campaign scripts (343 ASL files, zero false positives left): nested record fields, module-qualified types and cursor references (`ns::name`), string-literal masking with `\'` escapes, cross-module node references, action statements misread as control declarations, and control-name duplicate noise.
- Tooling modernized: esbuild bundling, VS Code >= 1.100, implicit activation events, Node-based analyzer test harness (`npm test`).

## [0.1.0] - 2026-03-15

- Initial release of the VS Code extension for Altitude Script Language.
- Syntax highlighting, IntelliSense, navigation, formatting, snippets, and parser-based diagnostics for ASL files.
- Optional Script Developer compiler validation for `.ags` and `.irs` with auto-discovery of Script Developer, Visual Studio Build Tools, and `rc.exe`.
