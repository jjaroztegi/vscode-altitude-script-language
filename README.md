# Altitude ASL for Visual Studio Code

Language support for the Altitude Scripting Language (ASL) of Altitude 8.7: agent scripts (`.ags`), IVR and routing scripts (`.irs`), agent modules (`.agm`), IVR modules (`.irm`) and generic modules (`.gem`).

It is built as a language server, so it works on the desktop and in the browser (vscode.dev, github.dev) with the same features. Compiler validation needs a local Script Developer install on Windows.

## Features

**Diagnostics while you type.** The parser follows the 8.7 ASL reference for actions, declarations and graphical elements, and resolves names across the script and every module it imports. It reports, among others:

- syntax errors, unknown actions and undocumented element clauses;
- undeclared variables, routines, cursors, types, record fields and enumeration members;
- node names in `goto node`, `master` or `open window` that do not exist, events that no node handles, and missing controls, images and blocks;
- wrong argument counts, duplicate declarations (names are case-insensitive), node declarations that hide script ones, unused declarations and unreachable actions;
- constructs dropped from ASL Web Edition, such as modal windows, function keys and `run application`, plus deprecated ones (`rgbcolor`, the chat control) and native DLL dependencies;
- asynchronous-popup mistakes in the Agent Portal: navigating or opening a second popup after an overlay on the same path, popups opened directly in `on enter`, and reading the answer right after `open window`.

Every rule can be tuned or turned off. See [docs/rules.md](docs/rules.md).

**Navigation across files.** Go to definition, find references, rename, call hierarchy, document outline and workspace symbols all follow `import <"Module.agm"> into namespace NS`, node names in strings (`goto node 'NS::NODE'`) and master-node inheritance.

**IntelliSense.** Context-aware completion for actions (as snippets), node and element handlers, element clauses, record fields after `.`, module members after `NS::`, enumeration members, `@` attributes, node names inside `goto node '...'`, and cursors, events and types. Hover and signature help show the documented syntax with a link to the Altitude 8.7 reference.

**Editing.** Semantic highlighting on top of a TextMate grammar (embedded SQL, `$(...)` interpolation), folding, smart selection, document links for imports, quick fixes, optional parameter-name inlay hints, and a formatter that only fixes indentation and leaves Script Developer's own layout alone.

**Script Developer conventions.** ASL files default to UTF-8 with BOM, CRLF line endings and tab indentation, matching what Script Developer writes. Files that drifted (no BOM, LF endings) get a warning with a one-click fix, and **Altitude ASL: Convert All ASL Files to UTF-8 with BOM and CRLF** fixes a whole workspace. Keep Git from rewriting them with a `.gitattributes` such as:

```gitattributes
*.ags -text
*.agm -text
*.gem -text
*.irs -text
*.irm -text
```

**Compiler validation.** On Windows, scripts (`.ags`, `.irs`) are compiled with Script Developer's `ec.exe` on save, or on demand with **Altitude ASL: Validate with Script Developer Compiler**, and its errors and warnings appear next to the language server's. Script Developer is detected under `Program Files (x86)\Altitude\Altitude uCI 8\`, or you can set `altitudeScriptLanguage.compiler.installRoot`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `altitudeScriptLanguage.webEdition` | `true` | Report constructs that ASL Web Edition (Agent Portal) dropped or does not support. |
| `altitudeScriptLanguage.lint.rules` | `{}` | Severity per rule: `off`, `hint`, `info`, `warning` or `error`. |
| `altitudeScriptLanguage.inlayHints.parameterNames` | `false` | Parameter name hints in calls. |
| `altitudeScriptLanguage.compiler.enabled` | `true` | Use `ec.exe` when Script Developer is installed. |
| `altitudeScriptLanguage.compiler.runOnSave` | `true` | Compile scripts on save. |
| `altitudeScriptLanguage.compiler.installRoot` | `""` | Script Developer folder that contains `bin\ec.exe`. |
| `altitudeScriptLanguage.compiler.timeoutMs` | `60000` | Timeout of one compiler run. |

## Command line and other editors

`npm run build` (or `npm run package`) also produces two standalone Node files with no dependencies, which run outside VS Code.

**`dist/cli/asl-check.js`** checks files and folders, for CI and AI agents:

```bash
node dist/cli/asl-check.js [paths...] [--format text|json|sarif] [--rule id=severity ...] [--config file]
    [--no-web-edition] [--fail-on error|warning|info|hint] [--baseline file] [--write-baseline file]
    [--no-encoding] [--fix-encoding] [--quiet]
```

- Paths default to the current folder. Diagnostics are reported for the ASL files under the given paths only, but every module under the project root (the folder of `.asl-check.json`, or the current folder) is loaded, so imports resolve.
- Text output is `path:line:col severity rule message`, then a summary. `--format json` prints an array of `{ file, line, column, endLine, endColumn, severity, rule, message }` (paths relative to the current folder, 1-based positions), plus `new` when a baseline is used. `--format sarif` prints SARIF 2.1.0.
- `.asl-check.json`, found from the current folder up, holds the project's choices: `{ "webEdition": true, "rules": { "unused-declaration": "off" } }`. `--rule` overrides it.
- `--write-baseline file` records the current findings and `--baseline file` reports only new ones (text output lists only new ones; JSON and SARIF flag them). Entries are keyed by file, rule and message, not line, so edits elsewhere do not invalidate them.
- The `encoding` rule (warning) reports files that are not UTF-8 with BOM or that use LF or CR line endings. `--fix-encoding` rewrites them as UTF-8 with BOM and CRLF first.
- Exit code 0 when nothing reaches `--fail-on` (default `error`), 1 when something does, 2 on usage errors.

**`dist/server/node.js`** is the language server. Start it with `node dist/server/node.js --stdio` from any LSP client and register it for `.ags`, `.agm`, `.gem`, `.irs` and `.irm` files. It scans the workspace folders for ASL files itself, pushes diagnostics to clients without pull diagnostics, and accepts settings shaped like the extension's (`{ "webEdition": false, "lint": { "rules": { ... } } }`, bare or under `altitudeScriptLanguage`) in `initializationOptions` and `workspace/didChangeConfiguration`.

## Notes

- The language data (actions, built-in functions, graphical elements, events, attributes and enumerations) comes from the public [Altitude documentation](https://docs.enghouseinteractive.com/altitude/), version 8.7.
- The language ID is `altitude-asl`. It changed in 2.0 to avoid clashing with Amazon States Language, so `[asl]` editor settings should be renamed to `[altitude-asl]`.
- In untrusted workspaces everything works except compiler validation.

## Development

```bash
npm install
npm run build              # bundles client, server (desktop and web) and CLI into dist/
npm run watch
npm test                   # unit tests (vitest)
npm run test:integration   # starts VS Code with the extension and the fixture project
npm run corpus -- <folder> # runs the checker over a folder of scripts and summarises the diagnostics
npm run vsix
```

Use **Run Extension** or **Run Web Extension** in the debugger to try changes. `scripts/generate-grammar.mjs` regenerates the TextMate grammar from the language data in `src/language/data`.

Issues and ideas: [GitHub](https://github.com/jjaroztegi/vscode-altitude-script-language/issues).
