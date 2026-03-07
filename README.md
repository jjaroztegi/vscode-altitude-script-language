# Altitude Script Language

Language support for Altitude Script Language (ASL) in Visual Studio Code.

## Features

- Syntax highlighting for ASL keywords, controls, events, built-ins, system variables, path strings, and interpolation.
- IntelliSense for sections, controls, properties, events, nodes, variables, cursors, and built-in functions.
- Diagnostics for unresolved references, duplicate declarations, brace issues, and invalid control properties.
- Hover, Go to Definition, and Outline support for faster navigation.
- Document formatting with configurable indentation fallback.
- Embedded SQL highlighting inside ASL SQL statements.
- Snippets for common controls and screen patterns.

## File Support

Supported file extensions: `.ags`, `.irs`, `.gem`, `.agm`, `.irm`, `.bak`.

## Settings

- `altitudeScriptLanguage.format.indentSize`
- `altitudeScriptLanguage.diagnostics.undefinedReferences`
- `altitudeScriptLanguage.diagnostics.controlProperties`

## Development

Repository: https://github.com/jjaroztegi/vscode-altitude-script-language

```bash
npm install
npm run compile
```

Use `F5` in VS Code to launch an Extension Development Host.

To build a VSIX:

```bash
npm run package
```

## License

MIT