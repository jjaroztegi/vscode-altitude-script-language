# Altitude Script Language Support

Language support for Altitude Script Language (ASL) in Visual Studio Code.


This extension is focused on practical ASL authoring: readable highlighting, parser-backed diagnostics, and editor navigation that works on real Altitude scripts.

## Features

- Syntax highlighting for ASL keywords, controls, events, built-ins, record fields, path literals, interpolation, and embedded SQL.
- IntelliSense for sections, controls, properties, events, nodes, variables, cursors, routines, built-ins, and common ASL actions.
- Diagnostics for unresolved references, duplicate declarations, brace issues, and unsupported control properties.
- Navigation support including hover, go to definition, find references, rename, document outline, and workspace symbols.
- Formatting support with configurable indentation fallback.
- Snippets for common controls and UI patterns.

## Supported Files

The extension activates for `.ags`, `.irs`, `.gem`, `.agm`, `.irm`, and `.bak` files.

## Settings

- `altitudeScriptLanguage.format.indentSize`: Fallback indentation width for the formatter.
- `altitudeScriptLanguage.diagnostics.undefinedReferences`: Enable unresolved node, variable, and cursor diagnostics.
- `altitudeScriptLanguage.diagnostics.controlProperties`: Validate control properties against documented ASL control schemas.

## Development

Repository: https://github.com/jjaroztegi/vscode-altitude-script-language

```bash
npm install
npm run compile
```

Launch an Extension Development Host with `F5`.

To build a VSIX:

```bash
npm run package
```

## Support

Issues and feature requests: https://github.com/jjaroztegi/vscode-altitude-script-language/issues

## License

See [LICENSE](LICENSE).