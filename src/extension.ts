import * as vscode from "vscode";
import {
    ACTION_KEYWORDS,
    BUSINESS_DATA_VARIABLES,
    BUILTIN_FUNCTIONS,
    CONTROL_DEFINITIONS,
    FLOW_KEYWORDS,
    LANGUAGE_KEYWORDS,
    SCRIPT_EVENTS,
    SYSTEM_VARIABLES,
    TOP_LEVEL_BLOCKS,
    TYPE_NAMES,
    AslHelpEntry,
    findControlDefinition,
    findHelpEntry,
    normalizeAslName
} from "./aslData";
import {
    AslAnalysis,
    AslAnalysisService,
    AslSymbol,
    findSymbolAtPosition,
    findSymbolReferenceAtPosition,
    getMemberSymbols,
    getNearestControlDefinition,
    getNearestNode,
    getNearestSection,
    isTopLevelContext,
    resolveReferenceSymbols
} from "./aslParser";

const LANGUAGE_ID = "asl";

export function activate(context: vscode.ExtensionContext): void {
    const analysisService = new AslAnalysisService();
    const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);

    const refreshDiagnostics = (document: vscode.TextDocument): void => {
        if (document.languageId !== LANGUAGE_ID) {
            return;
        }

        const analysis = analysisService.getAnalysis(document);
        const configuration = vscode.workspace.getConfiguration("altitudeScriptLanguage");
        const undefinedEnabled = configuration.get<boolean>("diagnostics.undefinedReferences", true);
        const propertiesEnabled = configuration.get<boolean>("diagnostics.controlProperties", true);

        const filtered = analysis.issues.filter((issue) => {
            if (!undefinedEnabled && issue.message.startsWith("Unresolved ")) {
                return false;
            }
            if (!propertiesEnabled && issue.message.startsWith("Property or event")) {
                return false;
            }
            return true;
        });

        diagnostics.set(document.uri, filtered.map((issue) => new vscode.Diagnostic(issue.range, issue.message, issue.severity)));
    };

    for (const document of vscode.workspace.textDocuments) {
        refreshDiagnostics(document);
    }

    context.subscriptions.push(
        diagnostics,
        vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
        vscode.workspace.onDidCloseTextDocument((document) => {
            diagnostics.delete(document.uri);
            analysisService.clear(document);
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            analysisService.clear(event.document);
            refreshDiagnostics(event.document);
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("altitudeScriptLanguage")) {
                for (const document of vscode.workspace.textDocuments) {
                    analysisService.clear(document);
                    refreshDiagnostics(document);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider({ language: LANGUAGE_ID }, new AslCompletionProvider(analysisService), " ", ":", ".", "\"", "'"),
        vscode.languages.registerHoverProvider({ language: LANGUAGE_ID }, new AslHoverProvider(analysisService)),
        vscode.languages.registerDefinitionProvider({ language: LANGUAGE_ID }, new AslDefinitionProvider(analysisService)),
        vscode.languages.registerDocumentSymbolProvider({ language: LANGUAGE_ID }, new AslDocumentSymbolProvider(analysisService)),
        vscode.languages.registerDocumentFormattingEditProvider({ language: LANGUAGE_ID }, new AslFormattingProvider())
    );
}

export function deactivate(): void {
    return;
}

class AslCompletionProvider implements vscode.CompletionItemProvider {
    public constructor(private readonly analysisService: AslAnalysisService) {}

    public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
        const analysis = this.analysisService.getAnalysis(document);
        const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
        const completions: vscode.CompletionItem[] = [];

        const memberAccessMatch = linePrefix.match(/(@?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_0-9]*)$/);
        if (memberAccessMatch) {
            return deduplicateCompletions(
                getMemberSymbols(analysis, memberAccessMatch[1]).map((symbol) => createSymbolCompletion(symbol, vscode.CompletionItemKind.Field))
            );
        }

        if (/\b(?:goto node|call node|master)\s+["']?[^"']*$/i.test(linePrefix)) {
            return getSymbolsByKind(analysis, ["node"]).map((symbol) => createSymbolCompletion(symbol, vscode.CompletionItemKind.Reference));
        }

        if (/\b(?:open cursor|close cursor|fetch cursor)\s+[A-Za-z_0-9]*$/i.test(linePrefix)) {
            return getSymbolsByKind(analysis, ["cursor"]).map((symbol) => createSymbolCompletion(symbol, vscode.CompletionItemKind.Variable));
        }

        if (/\bfor\s+[A-Za-z_0-9]*$/i.test(linePrefix) || /\bcursor\s+[A-Za-z_0-9]*$/i.test(linePrefix)) {
            return getSymbolsByKind(analysis, ["variable", "parameter", "constant", "cursor"]).map((symbol) => createSymbolCompletion(symbol, vscode.CompletionItemKind.Variable));
        }

        if (/\b(?:into\s+variable|kill timer event|into)\s+[A-Za-z_0-9.]*$/i.test(linePrefix)) {
            return getSymbolsByKind(analysis, ["variable", "parameter", "constant"]).map((symbol) => createSymbolCompletion(symbol, vscode.CompletionItemKind.Variable));
        }

        if (/^\s*on\s+[A-Za-z\s]*$/i.test(linePrefix)) {
            return getEventCompletions(analysis, position.line);
        }

        const controlDefinition = getNearestControlDefinition(analysis, position.line);
        if (controlDefinition) {
            completions.push(...controlDefinition.properties.map((property) => createKeywordCompletion(property, vscode.CompletionItemKind.Property)));
            completions.push(...controlDefinition.events.map((eventName) => createKeywordCompletion(eventName, vscode.CompletionItemKind.Event)));
        }

        if (getNearestNode(analysis, position.line)) {
            completions.push(...CONTROL_DEFINITIONS.map((definition) => createKeywordCompletion(definition.name, vscode.CompletionItemKind.Class, definition.description)));
            completions.push(...SCRIPT_EVENTS.map((entry) => createKeywordCompletion(entry.name, vscode.CompletionItemKind.Event, entry.description)));
            completions.push(...FLOW_KEYWORDS.map((entry) => createKeywordCompletion(entry.name, vscode.CompletionItemKind.Keyword, entry.description)));
            completions.push(...LANGUAGE_KEYWORDS.map((entry) => createKeywordCompletion(entry.name, vscode.CompletionItemKind.Keyword, entry.description)));
            completions.push(...ACTION_KEYWORDS.map((entry) => createKeywordCompletion(entry.name, vscode.CompletionItemKind.Keyword, entry.description, entry.insertText)));
        }

        const section = getNearestSection(analysis, position.line);
        if (section && normalizeAslName(section) === "types") {
            completions.push(...TYPE_NAMES.map((name) => createKeywordCompletion(name, vscode.CompletionItemKind.TypeParameter)));
        }

        if (isTopLevelContext(analysis, position.line)) {
            completions.push(...TOP_LEVEL_BLOCKS.map((entry) => createKeywordCompletion(entry.name, vscode.CompletionItemKind.Module, entry.description, entry.insertText)));
            completions.push(...SCRIPT_EVENTS.slice(0, 2).map((entry) => createKeywordCompletion(entry.name, vscode.CompletionItemKind.Event, entry.description, entry.insertText)));
        }

        completions.push(...BUILTIN_FUNCTIONS.map((entry) => createKeywordCompletion(entry.name, vscode.CompletionItemKind.Function, entry.description)));
        completions.push(...BUSINESS_DATA_VARIABLES.map((entry) => createKeywordCompletion(entry.name, vscode.CompletionItemKind.Variable, entry.description)));
        completions.push(...SYSTEM_VARIABLES.map((entry) => createKeywordCompletion(entry.name, vscode.CompletionItemKind.Variable, entry.description)));
        completions.push(...getSymbolsByKind(analysis, ["variable", "parameter", "constant", "cursor", "type", "namespace", "node"]).map((symbol) => createSymbolCompletion(symbol, vscode.CompletionItemKind.Variable)));

        return deduplicateCompletions(completions);
    }
}

class AslHoverProvider implements vscode.HoverProvider {
    public constructor(private readonly analysisService: AslAnalysisService) {}

    public provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        const analysis = this.analysisService.getAnalysis(document);
        const reference = findSymbolReferenceAtPosition(document, position);
        if (!reference) {
            return undefined;
        }

        const declared = resolveReferenceSymbols(analysis, reference);
        if (declared.length > 0) {
            const symbol = declared[0];
            return new vscode.Hover(createSymbolMarkdown(symbol));
        }

        const symbolText = reference.text;

        const control = findControlDefinition(symbolText);
        if (control) {
            return new vscode.Hover(createControlMarkdown(control));
        }

        const help = findHelpEntry(symbolText);
        if (help) {
            return new vscode.Hover(createHelpMarkdown(help));
        }

        return undefined;
    }
}

class AslDefinitionProvider implements vscode.DefinitionProvider {
    public constructor(private readonly analysisService: AslAnalysisService) {}

    public provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | undefined {
        const analysis = this.analysisService.getAnalysis(document);
        const reference = findSymbolReferenceAtPosition(document, position);
        if (!reference) {
            return undefined;
        }

        const matches = resolveReferenceSymbols(analysis, reference);
        if (matches.length === 0) {
            return undefined;
        }

        return matches.map((symbol) => new vscode.Location(document.uri, symbol.selectionRange));
    }
}

class AslDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    public constructor(private readonly analysisService: AslAnalysisService) {}

    public provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
        const analysis = this.analysisService.getAnalysis(document);
        return analysis.topLevelSymbols.map((symbol) => toDocumentSymbol(symbol));
    }
}

class AslFormattingProvider implements vscode.DocumentFormattingEditProvider {
    public provideDocumentFormattingEdits(document: vscode.TextDocument, options: vscode.FormattingOptions): vscode.TextEdit[] {
        const indentUnit = detectIndentUnit(document, options.tabSize);
        let indentLevel = 0;
        const formattedLines: string[] = [];

        for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
            const original = document.lineAt(lineNumber).text;
            const trimmed = original.trim();
            if (!trimmed) {
                formattedLines.push("");
                continue;
            }

            const structural = maskQuotedContent(trimmed);
            const closeCount = countOccurrences(structural, "}");
            const openCount = countOccurrences(structural, "{");
            const startsWithClose = structural.startsWith("}");
            const effectiveIndent = Math.max(indentLevel - (startsWithClose ? 1 : 0), 0);
            formattedLines.push(`${indentUnit.repeat(effectiveIndent)}${trimmed}`);
            indentLevel = Math.max(effectiveIndent + openCount - closeCount, 0);
        }

        const formattedText = formattedLines.join(document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
        const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        return [vscode.TextEdit.replace(fullRange, formattedText)];
    }
}

function getSymbolsByKind(analysis: AslAnalysis, kinds: Array<AslSymbol["kind"]>): AslSymbol[] {
    return analysis.symbols.filter((symbol) => kinds.includes(symbol.kind));
}

function createKeywordCompletion(label: string, kind: vscode.CompletionItemKind, description?: string, insertText?: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(label, kind);
    item.detail = description;
    if (insertText) {
        item.insertText = new vscode.SnippetString(insertText);
    }
    return item;
}

function createSymbolCompletion(symbol: AslSymbol, kind: vscode.CompletionItemKind): vscode.CompletionItem {
    const item = new vscode.CompletionItem(symbol.name, kind);
    item.detail = symbol.detail ? `${symbol.kind}: ${symbol.detail}` : symbol.kind;
    return item;
}

function getEventCompletions(analysis: AslAnalysis, line: number): vscode.CompletionItem[] {
    const control = getNearestControlDefinition(analysis, line);
    if (control) {
        return control.events.map((eventName) => createKeywordCompletion(eventName, vscode.CompletionItemKind.Event));
    }

    if (getNearestNode(analysis, line)) {
        return SCRIPT_EVENTS.map((entry) => createKeywordCompletion(entry.name, vscode.CompletionItemKind.Event, entry.description, entry.insertText));
    }

    return SCRIPT_EVENTS.slice(0, 2).map((entry) => createKeywordCompletion(entry.name, vscode.CompletionItemKind.Event, entry.description, entry.insertText));
}

function createHelpMarkdown(help: AslHelpEntry): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.appendMarkdown(`**${help.name}**\n\n`);
    markdown.appendMarkdown(`${help.description}`);
    if (help.detail) {
        markdown.appendCodeblock(help.detail, "asl");
    }
    if (help.insertText) {
        markdown.appendMarkdown("\n\nSnippet:\n");
        markdown.appendCodeblock(help.insertText, "asl");
    }
    return markdown;
}

function createControlMarkdown(control: ReturnType<typeof findControlDefinition>): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString(undefined, true);
    if (!control) {
        return markdown;
    }
    markdown.appendMarkdown(`**${control.name}**\n\n${control.description}`);
    if (control.documentation) {
        markdown.appendMarkdown(`\n\n${control.documentation}`);
    }
    if (control.requiresTarget) {
        markdown.appendMarkdown(`\n\nRequires: \`${control.requiresTarget}\` after \`for\`.`);
    }
    markdown.appendMarkdown(`\n\nProperties: ${control.properties.join(", ") || "none"}`);
    markdown.appendMarkdown(`\n\nEvents: ${control.events.join(", ") || "none"}`);
    return markdown;
}

function createSymbolMarkdown(symbol: AslSymbol): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.appendMarkdown(`**${symbol.name}**\n\n`);
    markdown.appendMarkdown(`Kind: \`${symbol.kind}\``);
    if (symbol.detail) {
        markdown.appendMarkdown(`\n\nDetail: \`${symbol.detail}\``);
    }
    return markdown;
}

function toDocumentSymbol(symbol: AslSymbol): vscode.DocumentSymbol {
    const documentSymbol = new vscode.DocumentSymbol(symbol.name, symbol.detail ?? symbol.kind, mapSymbolKind(symbol.kind), symbol.range, symbol.selectionRange);
    documentSymbol.children = symbol.children.map((child) => toDocumentSymbol(child));
    return documentSymbol;
}

function mapSymbolKind(kind: AslSymbol["kind"]): vscode.SymbolKind {
    switch (kind) {
        case "node":
        case "block":
            return vscode.SymbolKind.Object;
        case "event":
            return vscode.SymbolKind.Event;
        case "type":
            return vscode.SymbolKind.Struct;
        case "field":
            return vscode.SymbolKind.Field;
        case "variable":
        case "parameter":
        case "constant":
            return vscode.SymbolKind.Variable;
        case "cursor":
            return vscode.SymbolKind.Array;
        case "namespace":
        case "section":
            return vscode.SymbolKind.Namespace;
        case "control":
            return vscode.SymbolKind.Interface;
        default:
            return vscode.SymbolKind.Object;
    }
}

function deduplicateCompletions(items: vscode.CompletionItem[]): vscode.CompletionItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        const key = `${item.label.toString()}:${item.kind ?? ""}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function detectIndentUnit(document: vscode.TextDocument, fallbackTabSize: number): string {
    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
        const line = document.lineAt(lineNumber).text;
        if (/^\t+/.test(line)) {
            return "\t";
        }
        const spacesMatch = line.match(/^( +)\S/);
        if (spacesMatch) {
            return spacesMatch[1];
        }
    }

    const configured = vscode.workspace.getConfiguration("altitudeScriptLanguage").get<number>("format.indentSize", fallbackTabSize);
    return " ".repeat(Math.max(configured, 1));
}

function maskQuotedContent(text: string): string {
    let result = "";
    let inSingle = false;
    let inDouble = false;
    let inPath = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (!inSingle && !inDouble && char === "<" && next === '"') {
            inPath = true;
            result += "  ";
            index += 1;
            continue;
        }
        if (inPath) {
            if (char === '"' && next === ">") {
                inPath = false;
                result += "  ";
                index += 1;
            } else {
                result += " ";
            }
            continue;
        }
        if (!inSingle && char === '"') {
            inDouble = !inDouble;
            result += " ";
            continue;
        }
        if (!inDouble && char === "'") {
            inSingle = !inSingle;
            result += " ";
            continue;
        }
        result += inSingle || inDouble ? " " : char;
    }
    return result;
}

function countOccurrences(text: string, target: string): number {
    let count = 0;
    for (const char of text) {
        if (char === target) {
            count += 1;
        }
    }
    return count;
}