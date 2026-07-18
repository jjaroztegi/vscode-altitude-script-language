# Altitude Script Language Support

Language support for Altitude Script Language (ASL) in Visual Studio Code, targeting Altitude 8.7 (web).

## Features

- Syntax highlighting for ASL keywords, controls, events, built-ins, interpolation, and embedded SQL.
- IntelliSense for sections, controls, properties, events, nodes, variables, cursors, routines, and common ASL actions, based on the Altitude 8.7 ASL reference.
- Diagnostics for unresolved references, duplicate declarations (ASL is case-insensitive), brace issues, and undocumented control properties.
- Hover, go to definition, find references, rename, document symbols, and workspace symbols.
- Compiler validation with Script Developer's `ec.exe` on save and on demand for `.ags` and `.irs` (errors and warnings mapped back to source lines from the `.err` report).
- Script Developer file conventions enforced: UTF-8 with BOM, CRLF line endings (normalized on save), and tab indentation by default for ASL files.
- Formatting with configurable indentation fallback.
- Snippets for common controls and 8.7-web patterns (async overlay popups with `on close trigger event`, deferred popups from `on enter`).

## Supported Files

The extension activates for `.ags`, `.irs`, `.gem`, `.agm`, and `.irm`.

## Commands

- `Altitude Script: Validate Current File`

## Requirements

Compiler validation runs `ec.exe /generateOnly` from a local Altitude Script Developer installation (auto-detected under `Program Files (x86)\Altitude\Altitude uCI 8\`, including versioned 8.5/8.6/8.7 and unversioned install folders). No Visual Studio or Windows SDK is needed. If auto-detection is not enough, set `altitudeScriptLanguage.compiler.installRoot`.

Modules (`.gem`, `.agm`, `.irm`) use the built-in analyzer only.

## Extension Settings

- `altitudeScriptLanguage.format.indentSize`
- `altitudeScriptLanguage.diagnostics.undefinedReferences`
- `altitudeScriptLanguage.diagnostics.controlProperties`
- `altitudeScriptLanguage.compiler.enabled`
- `altitudeScriptLanguage.compiler.runOnSave`
- `altitudeScriptLanguage.compiler.installRoot`
- `altitudeScriptLanguage.compiler.timeoutMs`

## Development

```bash
npm install
npm run compile   # type-check + esbuild bundle to dist/
npm run watch     # esbuild watch
npm test          # run the analyzer over sample/campaign scripts
npm run vsix      # package
```

## Issues

Issues and feature requests: [GitHub repository](https://github.com/jjaroztegi/vscode-altitude-script-language/issues)
