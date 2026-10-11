# Altitude ASL for Visual Studio Code

Language support for the Altitude Scripting Language (ASL) of Altitude 8.7, for people who write and maintain scripts by hand: agent scripts (`.ags`), IVR and routing scripts (`.irs`), agent modules (`.agm`), IVR modules (`.irm`) and generic modules (`.gem`).

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

## Notes

- The language data (actions, built-in functions, graphical elements, events, attributes and enumerations) comes from the public [Altitude documentation](https://docs.enghouseinteractive.com/altitude/), version 8.7.
- The language ID is `altitude-asl`. It changed in 2.0 to avoid clashing with Amazon States Language, so `[asl]` editor settings should be renamed to `[altitude-asl]`.
- In untrusted workspaces everything works except compiler validation.

## Development

```bash
npm install
npm run build              # bundles client and server (desktop and web) into dist/
npm run watch
npm test                   # unit tests (vitest)
npm run test:integration   # starts VS Code with the extension and the fixture project
npm run corpus -- <folder> # runs the checker over a folder of scripts and summarises the diagnostics
npm run vsix
```

Use **Run Extension** or **Run Web Extension** in the debugger to try changes. `scripts/generate-grammar.mjs` regenerates the TextMate grammar from the language data in `src/language/data`.

Issues and ideas: [GitHub](https://github.com/jjaroztegi/vscode-altitude-script-language/issues).
