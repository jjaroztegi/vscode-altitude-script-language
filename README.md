# Altitude Script Language Support

Language support for Altitude Script Language (ASL) in Visual Studio Code.

## Features

- Syntax highlighting for ASL keywords, controls, events, built-ins, interpolation, and embedded SQL.
- IntelliSense for sections, controls, properties, events, nodes, variables, cursors, routines, and common ASL actions.
- Diagnostics for unresolved references, duplicate declarations, brace issues, and unsupported control properties.
- Hover, go to definition, find references, rename, document symbols, and workspace symbols.
- Formatting with configurable indentation fallback.
- Snippets for common controls and UI patterns.
- Optional Script Developer compiler validation for `.ags` and `.irs`.

## Supported Files

The extension activates for `.ags`, `.irs`, `.gem`, `.agm`, `.irm`, and `.bak`.

## Commands

- `Altitude Script: Validate Current File`

## Requirements

Compiler validation uses `ec.exe /go` from Altitude Script Developer and is available for `.ags` and `.irs` files.

Required for compiler validation:

- Altitude Script Developer installed locally.
- Visual Studio Build Tools with the VC toolchain.
- `rc.exe` available on `PATH` or through a Windows SDK install.

Other ASL file types use the built-in analyzer only.

## Extension Settings

- `altitudeScriptLanguage.format.indentSize`
- `altitudeScriptLanguage.diagnostics.undefinedReferences`
- `altitudeScriptLanguage.diagnostics.controlProperties`
- `altitudeScriptLanguage.compiler.enabled`
- `altitudeScriptLanguage.compiler.runOnSave`
- `altitudeScriptLanguage.compiler.runOnType`
- `altitudeScriptLanguage.compiler.debounceMs`
- `altitudeScriptLanguage.compiler.installRoot`
- `altitudeScriptLanguage.compiler.timeoutMs`

## Issues

Issues and feature requests: [GitHub repository](https://github.com/jjaroztegi/vscode-altitude-script-language/issues)
