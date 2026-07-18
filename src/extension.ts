import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
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
    collectDocumentSymbolReferences,
    findSymbolReferenceAtPosition,
    getMemberSymbols,
    getNearestControlDefinition,
    getNearestNode,
    getNearestSection,
    isTopLevelContext,
    resolveReferenceSymbols
} from "./aslParser";

const LANGUAGE_ID = "asl";
const ASL_WORKSPACE_GLOB = "**/*.{ags,irs,gem,agm,irm,bak}";
const COMPILER_CONFIGURATION_ROOT = "altitudeScriptLanguage.compiler";
const IDENTIFIER_START = "\\p{L}_";
const IDENTIFIER_CONTINUE = "\\p{L}\\p{N}_";
const IDENTIFIER_PATTERN = `[${IDENTIFIER_START}][${IDENTIFIER_CONTINUE}]*`;
const QUALIFIED_IDENTIFIER_PATTERN = `${IDENTIFIER_PATTERN}(?:\\.${IDENTIFIER_PATTERN})*`;
const MEMBER_ACCESS_AT_END_REGEX = new RegExp(`(@?${QUALIFIED_IDENTIFIER_PATTERN})\\.(${IDENTIFIER_PATTERN})?$`, "u");
type CompilerValidationTrigger = "save" | "command";

export function activate(context: vscode.ExtensionContext): void {
    const analysisService = new AslAnalysisService();
    const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
    const compilerValidationService = new AslCompilerValidationService();

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

        const parserDiagnostics = filtered.map((issue) => new vscode.Diagnostic(issue.range, issue.message, issue.severity));
        const compilerDiagnostics = compilerValidationService.getDiagnostics(document.uri);
        diagnostics.set(document.uri, [...parserDiagnostics, ...compilerDiagnostics]);
    };

    const runCompilerValidation = async (document: vscode.TextDocument, trigger: CompilerValidationTrigger): Promise<void> => {
        if (document.languageId !== LANGUAGE_ID || document.uri.scheme !== "file") {
            return;
        }

        const configuration = vscode.workspace.getConfiguration(COMPILER_CONFIGURATION_ROOT);
        const enabled = configuration.get<boolean>("enabled", true);
        if (!enabled) {
            compilerValidationService.clearDiagnostics(document.uri);
            refreshDiagnostics(document);
            if (trigger === "command") {
                void vscode.window.showInformationMessage("Script Developer validation is disabled. Enable altitudeScriptLanguage.compiler.enabled to run it.");
            }
            return;
        }

        const result = await compilerValidationService.validateDocument(document, configuration, trigger);
        compilerValidationService.setDiagnostics(document.uri, result.diagnostics);
        refreshDiagnostics(document);

        if (result.executionMessage && trigger === "command") {
            void vscode.window.showWarningMessage(result.executionMessage);
        }

        if (!result.executionMessage && trigger === "command") {
            const diagnosticsCount = result.diagnostics.length;
            const suffix = diagnosticsCount === 1 ? "issue" : "issues";
            void vscode.window.showInformationMessage(`Script Developer validation finished with ${diagnosticsCount} ${suffix}.`);
        }
    };

    for (const document of vscode.workspace.textDocuments) {
        refreshDiagnostics(document);
    }

    context.subscriptions.push(
        compilerValidationService,
        diagnostics,
        vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
        vscode.workspace.onDidCloseTextDocument((document) => {
            diagnostics.delete(document.uri);
            analysisService.clear(document);
            compilerValidationService.clearDiagnostics(document.uri);
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            analysisService.clear(event.document);
            refreshDiagnostics(event.document);
        }),
        vscode.workspace.onWillSaveTextDocument((event) => {
            // Script Developer requires CRLF (plus UTF-8 BOM, which the
            // [asl] files.encoding default handles). Normalize silently on save.
            if (event.document.languageId === LANGUAGE_ID && event.document.eol === vscode.EndOfLine.LF) {
                event.waitUntil(Promise.resolve([vscode.TextEdit.setEndOfLine(vscode.EndOfLine.CRLF)]));
            }
        }),
        vscode.workspace.onDidSaveTextDocument((document) => {
            const configuration = vscode.workspace.getConfiguration(COMPILER_CONFIGURATION_ROOT);
            if (!configuration.get<boolean>("runOnSave", true)) {
                return;
            }

            void runCompilerValidation(document, "save");
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("altitudeScriptLanguage")) {
                for (const document of vscode.workspace.textDocuments) {
                    analysisService.clear(document);
                    if (event.affectsConfiguration(COMPILER_CONFIGURATION_ROOT)) {
                        compilerValidationService.clearDiagnostics(document.uri);
                    }
                    refreshDiagnostics(document);
                }
            }
        }),
        vscode.commands.registerCommand("altitudeScriptLanguage.validateWithCompiler", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== LANGUAGE_ID) {
                void vscode.window.showWarningMessage("Open an ASL file to run compiler validation.");
                return;
            }

            await runCompilerValidation(editor.document, "command");
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider({ language: LANGUAGE_ID }, new AslCompletionProvider(analysisService), " ", ":", ".", "\"", "'"),
        vscode.languages.registerHoverProvider({ language: LANGUAGE_ID }, new AslHoverProvider(analysisService)),
        vscode.languages.registerDefinitionProvider({ language: LANGUAGE_ID }, new AslDefinitionProvider(analysisService)),
        vscode.languages.registerReferenceProvider({ language: LANGUAGE_ID }, new AslReferenceProvider(analysisService)),
        vscode.languages.registerDocumentHighlightProvider({ language: LANGUAGE_ID }, new AslDocumentHighlightProvider(analysisService)),
        vscode.languages.registerRenameProvider({ language: LANGUAGE_ID }, new AslRenameProvider(analysisService)),
        vscode.languages.registerDocumentSymbolProvider({ language: LANGUAGE_ID }, new AslDocumentSymbolProvider(analysisService)),
        vscode.languages.registerWorkspaceSymbolProvider(new AslWorkspaceSymbolProvider(analysisService)),
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
        const previousNonEmptyLine = getPreviousNonEmptyLineText(document, position.line);
        const statementContext = `${previousNonEmptyLine}\n${linePrefix}`.trim();
        const completions: vscode.CompletionItem[] = [];

        const memberAccessMatch = linePrefix.match(MEMBER_ACCESS_AT_END_REGEX);
        if (memberAccessMatch) {
            return deduplicateCompletions(
                getMemberSymbols(analysis, memberAccessMatch[1]).map((symbol) => createSymbolCompletion(symbol, vscode.CompletionItemKind.Field))
            );
        }

        if (/\b(?:goto node|call node|master)\s+["']?[^"']*$/i.test(linePrefix)) {
            return getSymbolsByKind(analysis, ["node"]).map((symbol) => createSymbolCompletion(symbol, vscode.CompletionItemKind.Reference));
        }

        if (/\bcall\s+[A-Za-z_0-9:]*$/i.test(linePrefix) && !/\bcall node\b/i.test(linePrefix)) {
            return deduplicateCompletions([
                ...getSymbolsByKind(analysis, ["subroutine"]).map((symbol) => createSymbolCompletion(symbol, vscode.CompletionItemKind.Function)),
                ...getSymbolsByKind(analysis, ["namespace"]).map((symbol) => createSymbolCompletion(symbol, vscode.CompletionItemKind.Module))
            ]);
        }

        if (/\b(?:open cursor|close cursor|fetch cursor)\s+[A-Za-z_0-9]*$/i.test(linePrefix)) {
            return getSymbolsByKind(analysis, ["cursor"]).map((symbol) => createSymbolCompletion(symbol, vscode.CompletionItemKind.Variable));
        }

        if (/\b(?:fetch cursor|sql select|system select)\b[\s\S]*\binto\s*$/i.test(statementContext)) {
            return deduplicateCompletions([
                createKeywordCompletion("variable", vscode.CompletionItemKind.Keyword, "Store the next value into a variable.", "variable ${1:targetVar}"),
                createKeywordCompletion("record", vscode.CompletionItemKind.Keyword, "Store the row into a record target.", "record ${1:targetRecord} match by name"),
                createKeywordCompletion("?", vscode.CompletionItemKind.Keyword, "Ignore one returned column.")
            ]);
        }

        if (/\b(?:fetch cursor|sql select|system select)\b[\s\S]*\binto\s+(?:variable|record)\s+[A-Za-z_0-9.]*$/i.test(statementContext)) {
            return getSymbolsByKind(analysis, ["variable", "parameter", "constant"]).map((symbol) => createSymbolCompletion(symbol, vscode.CompletionItemKind.Variable));
        }

        if (/\b(?:get current|update current)\s+[A-Za-z_0-9_]*$/i.test(linePrefix)) {
            return BUSINESS_DATA_VARIABLES.map((entry) => createKeywordCompletion(entry.name, vscode.CompletionItemKind.Variable, entry.description));
        }

        if (/\b(?:get current|update current)\b[\s\S]*\bwith\s+array\s+[A-Za-z_0-9.]*$/i.test(statementContext) || /\bget current\b[\s\S]*\binto\s+array\s+[A-Za-z_0-9.]*$/i.test(statementContext)) {
            return getSymbolsByKind(analysis, ["variable", "parameter", "constant"]).map((symbol) => createSymbolCompletion(symbol, vscode.CompletionItemKind.Variable));
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
        completions.push(...getSymbolsByKind(analysis, ["function", "subroutine"]).map((symbol) => createSymbolCompletion(symbol, vscode.CompletionItemKind.Function)));
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
        const declaredSymbol = getDeclaredSymbolAtPosition(analysis, position);
        if (declaredSymbol) {
            return new vscode.Hover(createSymbolMarkdown(declaredSymbol));
        }

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
        const declaredSymbol = getDeclaredSymbolAtPosition(analysis, position);
        if (declaredSymbol) {
            return [new vscode.Location(document.uri, declaredSymbol.selectionRange)];
        }

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

class AslReferenceProvider implements vscode.ReferenceProvider {
    public constructor(private readonly analysisService: AslAnalysisService) {}

    public async provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext, token: vscode.CancellationToken): Promise<vscode.Location[]> {
        const target = getRenameTarget(document, position, this.analysisService);
        if (!target) {
            return [];
        }

        return findWorkspaceReferences(this.analysisService, target.symbol, context.includeDeclaration, token);
    }
}

class AslDocumentHighlightProvider implements vscode.DocumentHighlightProvider {
    public constructor(private readonly analysisService: AslAnalysisService) {}

    public provideDocumentHighlights(document: vscode.TextDocument, position: vscode.Position): vscode.DocumentHighlight[] {
        const target = getRenameTarget(document, position, this.analysisService);
        if (!target) {
            return [];
        }

        const analysis = this.analysisService.getAnalysis(document);
        const references = collectDocumentSymbolReferences(document, analysis)
            .filter((reference) => referenceMatchesSymbol(analysis, reference, target.symbol))
            .map((reference) => new vscode.DocumentHighlight(reference.range, vscode.DocumentHighlightKind.Read));

        references.push(new vscode.DocumentHighlight(target.symbol.selectionRange, vscode.DocumentHighlightKind.Text));
        return deduplicateHighlights(references);
    }
}

class AslRenameProvider implements vscode.RenameProvider {
    public constructor(private readonly analysisService: AslAnalysisService) {}

    public prepareRename(document: vscode.TextDocument, position: vscode.Position): vscode.Range | { range: vscode.Range; placeholder: string } {
        const target = getRenameTarget(document, position, this.analysisService);
        if (!target) {
            throw new Error("Rename is only available for uniquely resolved user-defined ASL symbols.");
        }

        return { range: target.reference.range, placeholder: target.reference.text };
    }

    public async provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string, token: vscode.CancellationToken): Promise<vscode.WorkspaceEdit | undefined> {
        const target = getRenameTarget(document, position, this.analysisService);
        if (!target) {
            return undefined;
        }

        if (!(new RegExp(`^${IDENTIFIER_PATTERN}$`, "u")).test(newName)) {
            throw new Error("ASL symbol names must start with a letter or underscore and contain only letters, digits, or underscores.");
        }

        const locations = await findWorkspaceReferences(this.analysisService, target.symbol, true, token);
        const edit = new vscode.WorkspaceEdit();
        for (const location of locations) {
            edit.replace(location.uri, location.range, newName);
        }

        return edit;
    }
}

class AslDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    public constructor(private readonly analysisService: AslAnalysisService) {}

    public provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
        const analysis = this.analysisService.getAnalysis(document);
        return analysis.topLevelSymbols.map((symbol) => toDocumentSymbol(symbol));
    }
}

class AslWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
    public constructor(private readonly analysisService: AslAnalysisService) {}

    public async provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): Promise<vscode.SymbolInformation[]> {
        const files = await vscode.workspace.findFiles(ASL_WORKSPACE_GLOB, undefined, 200, token);
        const normalizedQuery = normalizeAslName(query);
        const symbols: vscode.SymbolInformation[] = [];

        for (const uri of files) {
            if (token.isCancellationRequested) {
                break;
            }

            const document = await vscode.workspace.openTextDocument(uri);
            const analysis = this.analysisService.getAnalysis(document);
            for (const symbol of collectWorkspaceSymbols(analysis.topLevelSymbols)) {
                if (!shouldIncludeWorkspaceSymbol(symbol, normalizedQuery)) {
                    continue;
                }

                symbols.push(new vscode.SymbolInformation(
                    symbol.name,
                    mapSymbolKind(symbol.kind),
                    symbol.containerName ?? "",
                    new vscode.Location(uri, symbol.selectionRange)
                ));
            }
        }

        return symbols;
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
    item.detail = getSymbolDisplayDetail(symbol);
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
        if (symbol.kind === "function" || symbol.kind === "subroutine") {
            markdown.appendMarkdown("\n\nSignature:");
            markdown.appendCodeblock(`${symbol.kind} ${symbol.name}${symbol.detail}`, "asl");
        } else {
            markdown.appendMarkdown(`\n\nDetail: \`${symbol.detail}\``);
        }
    }
    return markdown;
}

function getSymbolDisplayDetail(symbol: AslSymbol): string {
    if ((symbol.kind === "function" || symbol.kind === "subroutine") && symbol.detail) {
        return `${symbol.kind} ${symbol.name}${symbol.detail}`;
    }

    return symbol.detail ? `${symbol.kind}: ${symbol.detail}` : symbol.kind;
}

function getRenameTarget(document: vscode.TextDocument, position: vscode.Position, analysisService: AslAnalysisService): { reference: NonNullable<ReturnType<typeof findSymbolReferenceAtPosition>>; symbol: AslSymbol } | undefined {
    const analysis = analysisService.getAnalysis(document);
    const declaredSymbol = getDeclaredSymbolAtPosition(analysis, position);
    if (declaredSymbol && isRenameableSymbol(declaredSymbol)) {
        return {
            reference: {
                text: declaredSymbol.name,
                parts: [declaredSymbol.name],
                activePartIndex: 0,
                range: declaredSymbol.selectionRange,
                fullText: declaredSymbol.name,
                fullRange: declaredSymbol.selectionRange,
                referenceKind: "symbol"
            },
            symbol: declaredSymbol
        };
    }

    const reference = findSymbolReferenceAtPosition(document, position);
    if (!reference) {
        return undefined;
    }

    const matches = resolveReferenceSymbols(analysis, reference);
    if (matches.length !== 1) {
        return undefined;
    }

    const symbol = matches[0];
    if (!isRenameableSymbol(symbol)) {
        return undefined;
    }

    return { reference, symbol };
}

function getDeclaredSymbolAtPosition(analysis: AslAnalysis, position: vscode.Position): AslSymbol | undefined {
    return analysis.symbols.find((symbol) => symbol.selectionRange.contains(position));
}

async function findWorkspaceReferences(analysisService: AslAnalysisService, target: AslSymbol, includeDeclaration: boolean, token: vscode.CancellationToken): Promise<vscode.Location[]> {
    const files = await vscode.workspace.findFiles(ASL_WORKSPACE_GLOB, undefined, 300, token);
    const locations: vscode.Location[] = [];
    const targetIdentity = getSymbolIdentity(target);

    for (const uri of files) {
        if (token.isCancellationRequested) {
            break;
        }

        const document = await vscode.workspace.openTextDocument(uri);
        const analysis = analysisService.getAnalysis(document);

        if (includeDeclaration) {
            for (const symbol of analysis.symbols) {
                if (getSymbolIdentity(symbol) === targetIdentity) {
                    locations.push(new vscode.Location(uri, symbol.selectionRange));
                }
            }
        }

        for (const reference of collectDocumentSymbolReferences(document, analysis)) {
            if (referenceMatchesSymbol(analysis, reference, target)) {
                locations.push(new vscode.Location(uri, reference.range));
            }
        }
    }

    return deduplicateLocations(locations);
}

function referenceMatchesSymbol(analysis: AslAnalysis, reference: ReturnType<typeof collectDocumentSymbolReferences>[number], target: AslSymbol): boolean {
    const targetIdentity = getSymbolIdentity(target);
    return resolveReferenceSymbols(analysis, reference).some((symbol) => getSymbolIdentity(symbol) === targetIdentity);
}

function isRenameableSymbol(symbol: AslSymbol): boolean {
    return ["node", "block", "subroutine", "function", "type", "field", "variable", "parameter", "constant", "cursor"].includes(symbol.kind);
}

function getSymbolIdentity(symbol: AslSymbol): string {
    return `${symbol.kind}:${symbol.name}:${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}`;
}

function deduplicateLocations(locations: vscode.Location[]): vscode.Location[] {
    const seen = new Set<string>();
    return locations.filter((location) => {
        const key = `${location.uri.toString()}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
        if (seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

function deduplicateHighlights(highlights: vscode.DocumentHighlight[]): vscode.DocumentHighlight[] {
    const seen = new Set<string>();
    return highlights.filter((highlight) => {
        const key = `${highlight.range.start.line}:${highlight.range.start.character}:${highlight.range.end.line}:${highlight.range.end.character}`;
        if (seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

function collectWorkspaceSymbols(symbols: AslSymbol[], containerName?: string): Array<AslSymbol & { containerName?: string }> {
    const results: Array<AslSymbol & { containerName?: string }> = [];
    for (const symbol of symbols) {
        if (["node", "block", "subroutine", "function", "type"].includes(symbol.kind)) {
            results.push({ ...symbol, containerName });
        }
        results.push(...collectWorkspaceSymbols(symbol.children, symbol.name));
    }
    return results;
}

function shouldIncludeWorkspaceSymbol(symbol: AslSymbol, normalizedQuery: string): boolean {
    if (!normalizedQuery) {
        return true;
    }

    return normalizeAslName(symbol.name).includes(normalizedQuery) || normalizeAslName(symbol.detail ?? "").includes(normalizedQuery);
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
        case "subroutine":
        case "function":
            return vscode.SymbolKind.Function;
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
        if ((inSingle || inDouble) && char === "\\") {
            result += "  ";
            index += 1;
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

function getPreviousNonEmptyLineText(document: vscode.TextDocument, line: number): string {
    for (let current = line - 1; current >= 0; current -= 1) {
        const text = document.lineAt(current).text.trim();
        if (text.length > 0) {
            return text;
        }
    }

    return "";
}

interface CompilerValidationResult {
    diagnostics: vscode.Diagnostic[];
    executionMessage?: string;
}

interface ErrDiagnosticAnchor {
    kind: "block" | "statement";
    text: string;
}

interface ErrDiagnosticLocation {
    endLineIndex?: number;
    lineIndex: number;
}

class AslCompilerValidationService implements vscode.Disposable {
    private readonly diagnosticsByUri = new Map<string, vscode.Diagnostic[]>();
    private readonly runningProcessByUri = new Map<string, ChildProcessWithoutNullStreams>();
    private readonly outputChannel = vscode.window.createOutputChannel("Altitude Script Developer");
    private warnedUntrustedWorkspace = false;

    public dispose(): void {
        for (const process of this.runningProcessByUri.values()) {
            process.kill();
        }
        this.runningProcessByUri.clear();
        this.outputChannel.dispose();
    }

    public getDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
        return this.diagnosticsByUri.get(uri.toString()) ?? [];
    }

    public setDiagnostics(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void {
        this.diagnosticsByUri.set(uri.toString(), diagnostics);
    }

    public clearDiagnostics(uri: vscode.Uri): void {
        this.diagnosticsByUri.delete(uri.toString());
    }

    public async validateDocument(document: vscode.TextDocument, configuration: vscode.WorkspaceConfiguration, trigger: CompilerValidationTrigger): Promise<CompilerValidationResult> {
        if (!vscode.workspace.isTrusted) {
            if (!this.warnedUntrustedWorkspace) {
                this.warnedUntrustedWorkspace = true;
                void vscode.window.showWarningMessage("Script Developer validation is disabled in untrusted workspaces.");
            }
            return { diagnostics: [] };
        }

        if (!supportsEcCompilerValidation(document)) {
            return {
                diagnostics: [],
                executionMessage:
                    trigger === "command"
                        ? "Script Developer compiler validation is only available for .ags and .irs files. Other ASL files keep using the built-in analyzer."
                        : undefined
            };
        }

        const ecExecutablePath = await this.resolveEcExecutable(configuration);
        if (!ecExecutablePath) {
            return {
                diagnostics: [],
                executionMessage:
                    trigger === "command"
                        ? "ec.exe was not found. Install Altitude Script Developer or set altitudeScriptLanguage.compiler.installRoot to the install folder containing bin\\ec.exe."
                        : undefined
            };
        }

        const timeoutMs = configuration.get<number>("timeoutMs", 60000);
        const workingDirectory = path.dirname(document.fileName);
        const binDirectory = path.dirname(ecExecutablePath);
        const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "asl-vscode-"));
        // Mirrors the invocation Script Developer itself uses: /generateOnly with the
        // Script Developer bin as cCompilerRoot/shareDir — no Visual Studio needed.
        const args = [
            `/scriptType=${inferScriptType(document)}`,
            `/cCompilerRoot=${binDirectory}`,
            "/generateOnly",
            "/maxErrors=1000",
            "/maxWarnings=1000",
            `/tempDirectory=${tempDirectory}`,
            `/targetDir=${tempDirectory}`,
            `/shareDir=${binDirectory}`,
            document.fileName
        ];
        const errFilePath = replaceFileExtension(document.fileName, ".err");
        this.outputChannel.appendLine(`Running: ${ecExecutablePath} ${args.join(" ")}`);

        try {
            return await this.runEcCompilerProcess(ecExecutablePath, args, workingDirectory, timeoutMs, document, errFilePath);
        } finally {
            await fs.promises.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    private async resolveEcExecutable(configuration: vscode.WorkspaceConfiguration): Promise<string | undefined> {
        const configuredRoot = configuration.get<string>("installRoot", "").trim();
        const roots = configuredRoot ? [path.normalize(configuredRoot)] : getCommonScriptDeveloperRoots();

        for (const root of roots) {
            for (const candidate of [path.join(root, "bin", "ec.exe"), path.join(root, "ec.exe")]) {
                if (await fileExists(candidate)) {
                    return candidate;
                }
            }
        }

        return undefined;
    }

    private async runEcCompilerProcess(
        executablePath: string,
        args: string[],
        cwd: string,
        timeoutMs: number,
        document: vscode.TextDocument,
        errFilePath: string
    ): Promise<CompilerValidationResult> {
        const key = document.uri.toString();
        const previousProcess = this.runningProcessByUri.get(key);
        if (previousProcess) {
            previousProcess.kill();
        }

        return await new Promise<CompilerValidationResult>((resolve) => {
            let stdout = "";
            let stderr = "";
            let timedOut = false;

            const process = spawn(executablePath, args, { cwd, windowsHide: true });
            this.runningProcessByUri.set(key, process);

            const timeout = setTimeout(() => {
                timedOut = true;
                process.kill();
            }, Math.max(timeoutMs, 1000));

            process.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
            });

            process.stderr.on("data", (chunk) => {
                stderr += chunk.toString();
            });

            process.on("error", (error) => {
                clearTimeout(timeout);
                this.runningProcessByUri.delete(key);
                resolve({
                    diagnostics: [createDocumentStartDiagnostic(document, `Failed to start compiler validation: ${error.message}`, vscode.DiagnosticSeverity.Error)],
                    executionMessage: `Failed to start compiler validation: ${error.message}`
                });
            });

            process.on("close", async (code) => {
                clearTimeout(timeout);
                this.runningProcessByUri.delete(key);

                const combinedOutput = [stdout, stderr].filter((part) => part.trim().length > 0).join("\n");
                if (combinedOutput) {
                    this.outputChannel.appendLine(combinedOutput);
                }

                if (timedOut) {
                    resolve({
                        diagnostics: [createDocumentStartDiagnostic(document, `Compiler validation timed out after ${timeoutMs}ms.`, vscode.DiagnosticSeverity.Warning)],
                        executionMessage: `Compiler validation timed out after ${timeoutMs}ms.`
                    });
                    return;
                }

                // Two report channels: located stdout lines ("Error: 652,53 [23516]: ...",
                // emitted for syntax errors, which produce no .err file) always count;
                // the .err file anchors semantic errors/warnings to source lines; plain
                // unlocated stdout lines are only a fallback when the .err gave nothing.
                const stdoutDiagnostics = parseCompilerOutput(combinedOutput, document);
                const locatedStdout = stdoutDiagnostics.filter((diagnostic) => diagnostic.range.start.line > 0 || diagnostic.range.start.character > 0);
                const errDiagnostics = await readCompilerErrDiagnostics(errFilePath, document);
                const diagnostics = deduplicateDiagnostics([
                    ...locatedStdout,
                    ...errDiagnostics,
                    ...(errDiagnostics.length === 0 && locatedStdout.length === 0 ? stdoutDiagnostics : [])
                ]);
                if (diagnostics.length > 0) {
                    resolve({ diagnostics });
                    return;
                }

                if (code === 0) {
                    resolve({ diagnostics: [] });
                    return;
                }

                const fallbackMessage = compactCompilerMessage(combinedOutput, code);
                resolve({
                    diagnostics: [createDocumentStartDiagnostic(document, fallbackMessage, vscode.DiagnosticSeverity.Error)],
                    executionMessage: `Compiler validation exited with code ${code ?? "unknown"}.`
                });
            });
        });
    }
}

function parseCompilerOutput(output: string, document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];

    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();

        // Syntax errors carry a location: "Error: 652,53 [23516]: symbol '}' expected."
        const located = line.match(/^(error|warning|info)\s*:\s*(\d+)\s*,\s*(\d+)\s*(?:\[(\d+)\])?\s*:\s*(.+)$/i);
        if (located) {
            const codeSuffix = located[4] ? ` [${located[4]}]` : "";
            diagnostics.push(createCompilerDiagnostic(
                document,
                Number.parseInt(located[2], 10),
                Number.parseInt(located[3], 10),
                `${located[5]}${codeSuffix}`,
                toDiagnosticSeverity(located[1])
            ));
            continue;
        }

        const plain = line.match(/^(error|warning|info)\s*:\s*(.+)$/i);
        if (plain) {
            diagnostics.push(createDocumentStartDiagnostic(document, plain[2], toDiagnosticSeverity(plain[1])));
        }
    }

    return diagnostics;
}

function createCompilerDiagnostic(document: vscode.TextDocument, lineNumber: number, columnNumber: number | undefined, message: string, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
    const lineIndex = Math.min(Math.max(lineNumber - 1, 0), Math.max(document.lineCount - 1, 0));
    const lineText = document.lineAt(lineIndex).text;
    const characterIndex = columnNumber ? Math.max(columnNumber - 1, 0) : getFirstMeaningfulCharacterIndex(lineText);
    const startCharacter = Math.min(characterIndex, lineText.length);
    const endCharacter = Math.min(startCharacter + Math.max(getIdentifierLength(lineText, startCharacter), 1), Math.max(lineText.length, startCharacter + 1));
    return new vscode.Diagnostic(new vscode.Range(lineIndex, startCharacter, lineIndex, endCharacter), message.trim(), severity);
}

function getIdentifierLength(text: string, start: number): number {
    const remainder = text.slice(start);
    const match = remainder.match(/^[A-Za-z_\p{L}][A-Za-z0-9_\p{L}\p{N}]*/u);
    return match ? match[0].length : 1;
}

async function readCompilerErrDiagnostics(errFilePath: string, document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
    if (!(await fileExists(errFilePath))) {
        return [];
    }

    try {
        const content = await fs.promises.readFile(errFilePath, "utf8");
        return parseCompilerErrFile(content, document);
    } catch {
        return [];
    } finally {
        await fs.promises.rm(errFilePath, { force: true }).catch(() => undefined);
    }
}

function parseCompilerErrFile(content: string, document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    const sourceLines = Array.from({ length: document.lineCount }, (_, index) => normalizeComparableLine(document.lineAt(index).text));
    const errLines = content.split(/\r?\n/);
    let searchStart = 0;

    for (let index = 0; index < errLines.length; index += 1) {
        const match = errLines[index].match(/^\s*###\s+(.+?)\s*$/);
        if (!match) {
            continue;
        }

        const message = match[1].trim();
        const anchor = findErrFileAnchor(errLines, index, message);
        const location = anchor ? findErrFileLocation(anchor, sourceLines, document, searchStart) : undefined;
        if (!location) {
            diagnostics.push(createDocumentStartDiagnostic(document, message, inferErrFileSeverity(message)));
            continue;
        }

        searchStart = (location.endLineIndex ?? location.lineIndex) + 1;
        diagnostics.push(createErrFileDiagnostic(document, location, message, inferErrFileSeverity(message)));
    }

    return diagnostics;
}

function createErrFileDiagnostic(document: vscode.TextDocument, location: ErrDiagnosticLocation, message: string, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
    const startLine = document.lineAt(location.lineIndex);
    const startCharacter = getFirstMeaningfulCharacterIndex(startLine.text);

    if (location.endLineIndex === undefined || location.endLineIndex <= location.lineIndex) {
        return new vscode.Diagnostic(
            new vscode.Range(location.lineIndex, startCharacter, location.lineIndex, Math.max(startCharacter + 1, startLine.text.length)),
            message.trim(),
            severity
        );
    }

    const endLine = document.lineAt(location.endLineIndex);
    return new vscode.Diagnostic(
        new vscode.Range(location.lineIndex, startCharacter, location.endLineIndex, Math.max(endLine.text.length, 1)),
        message.trim(),
        severity
    );
}

function createDocumentStartDiagnostic(document: vscode.TextDocument, message: string, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
    const line = document.lineCount > 0 ? document.lineAt(0) : undefined;
    const range = line ? new vscode.Range(line.lineNumber, 0, line.lineNumber, Math.max(line.text.length, 1)) : new vscode.Range(0, 0, 0, 1);
    return new vscode.Diagnostic(range, message.trim(), severity);
}

function getFirstMeaningfulCharacterIndex(text: string): number {
    const match = text.match(/\S/u);
    return match?.index ?? 0;
}

function toDiagnosticSeverity(value: string | undefined): vscode.DiagnosticSeverity {
    const normalized = (value ?? "").toLowerCase();
    if (normalized === "warning") {
        return vscode.DiagnosticSeverity.Warning;
    }
    if (normalized === "info") {
        return vscode.DiagnosticSeverity.Information;
    }
    return vscode.DiagnosticSeverity.Error;
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function deduplicateDiagnostics(diagnostics: vscode.Diagnostic[]): vscode.Diagnostic[] {
    const seen = new Set<string>();
    const result: vscode.Diagnostic[] = [];

    for (const diagnostic of diagnostics) {
        const key = [
            diagnostic.range.start.line,
            diagnostic.range.start.character,
            diagnostic.range.end.line,
            diagnostic.range.end.character,
            diagnostic.severity ?? "",
            diagnostic.message
        ].join("|");
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(diagnostic);
    }

    return result;
}

function compactCompilerMessage(output: string, code: number | null): string {
    const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => !/^script loaded/i.test(line))
        .filter((line) => !/^script compiled/i.test(line))
        .filter((line) => !/^errors\/warnings have been written/i.test(line))
        .filter((line) => !/^\*{4,}/.test(line))
        .filter((line) => !/^active code page/i.test(line))
        .filter((line) => !/^\[vcvarsall\.bat\]/i.test(line))
        .filter((line) => !/^\d+\s+warnings found$/i.test(line))
        .filter((line) => !/^[A-Z]:\\.+>$/.test(line));

    return (lines[0] ?? `Compiler exited with code ${code ?? "unknown"}.`).slice(0, 500);
}

function normalizeComparableLine(value: string): string {
    return value.trim().replace(/\s+/g, " ");
}

function findErrFileAnchor(lines: string[], markerIndex: number, message: string): ErrDiagnosticAnchor | undefined {
    if (isBlockScopedErrMessage(message)) {
        return findErrFileBlockAnchor(lines, markerIndex);
    }

    for (let index = markerIndex - 1; index >= 0; index -= 1) {
        const candidate = normalizeComparableLine(lines[index]);
        if (shouldSkipErrAnchorLine(candidate) || candidate === "}" || candidate === "{") {
            continue;
        }
        return { kind: "statement", text: candidate };
    }

    return undefined;
}

function findErrFileBlockAnchor(lines: string[], markerIndex: number): ErrDiagnosticAnchor | undefined {
    let braceDepth = 0;

    for (let index = markerIndex - 1; index >= 0; index -= 1) {
        const candidate = normalizeComparableLine(lines[index]);
        if (shouldSkipErrAnchorLine(candidate)) {
            continue;
        }

        if (candidate === "}") {
            braceDepth += 1;
            continue;
        }

        if (candidate === "{") {
            if (braceDepth > 0) {
                braceDepth -= 1;
            }
            continue;
        }

        if (candidate.endsWith("{")) {
            if (braceDepth > 0) {
                braceDepth -= 1;
            }

            if (looksLikeGraphicalElementStart(candidate)) {
                return { kind: "block", text: candidate };
            }

            continue;
        }

        if (braceDepth > 0) {
            continue;
        }
    }

    return undefined;
}

function shouldSkipErrAnchorLine(candidate: string): boolean {
    return !candidate || candidate === "..." || candidate === "[...]" || candidate === "-*-" || candidate.startsWith("### ");
}

function findComparableLineIndex(anchor: string, sourceLines: string[], searchStart: number): number | undefined {
    for (let index = searchStart; index < sourceLines.length; index += 1) {
        if (sourceLines[index] === anchor) {
            return index;
        }
    }

    for (let index = 0; index < searchStart; index += 1) {
        if (sourceLines[index] === anchor) {
            return index;
        }
    }

    return undefined;
}

function findErrFileLocation(anchor: ErrDiagnosticAnchor, sourceLines: string[], document: vscode.TextDocument, searchStart: number): ErrDiagnosticLocation | undefined {
    const lineIndex = findComparableLineIndex(anchor.text, sourceLines, searchStart);
    if (lineIndex === undefined) {
        return undefined;
    }

    if (anchor.kind !== "block") {
        return { lineIndex };
    }

    const endLineIndex = findMatchingBlockEndLine(document, lineIndex);
    return endLineIndex === undefined ? { lineIndex } : { lineIndex, endLineIndex };
}

function findMatchingBlockEndLine(document: vscode.TextDocument, startLineIndex: number): number | undefined {
    let braceDepth = 0;

    for (let lineIndex = startLineIndex; lineIndex < document.lineCount; lineIndex += 1) {
        const text = document.lineAt(lineIndex).text;
        for (const character of text) {
            if (character === "{") {
                braceDepth += 1;
            } else if (character === "}") {
                braceDepth -= 1;
                if (braceDepth === 0) {
                    return lineIndex;
                }
            }
        }
    }

    return undefined;
}

function isBlockScopedErrMessage(message: string): boolean {
    return /overlapped elements/i.test(message);
}

function looksLikeGraphicalElementStart(candidate: string): boolean {
    const normalized = candidate.trim().toLowerCase();
    if (!normalized.endsWith("{")) {
        return false;
    }

    const excludedPrefixes = [
        "on start {",
        "on end {",
        "on event ",
        "on click",
        "on enter",
        "on exit",
        "on first enter",
        "on double click",
        "if ",
        "else {",
        "case ",
        "when ",
        "default",
        "node ",
        "label ",
        "font {",
        "header font",
        "flow view {",
        "modules ",
        "dependencies ",
        "constants ",
        "types ",
        "variables ",
        "parameters ",
        "cursors ",
        "using namespaces ",
        "contact profile extensions "
    ];

    return !excludedPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function inferErrFileSeverity(message: string): vscode.DiagnosticSeverity {
    return /^error\b/i.test(message) ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
}

function replaceFileExtension(filePath: string, extension: string): string {
    const parsed = path.parse(filePath);
    return path.join(parsed.dir, `${parsed.name}${extension}`);
}

function getCommonScriptDeveloperRoots(): string[] {
    // Newest first; the unversioned root hosts in-place-upgraded installs.
    const installNames = [
        "Altitude Script Developer 8.7",
        "Altitude Script Developer 8.6",
        "Altitude Script Developer",
        "Altitude Script Developer 8.5"
    ];
    const candidates: string[] = [];
    for (const installName of installNames) {
        for (const driveRoot of getCandidateDriveRoots()) {
            candidates.push(path.join(driveRoot, "Program Files (x86)", "Altitude", "Altitude uCI 8", installName));
            candidates.push(path.join(driveRoot, "Program Files", "Altitude", "Altitude uCI 8", installName));
        }
    }
    return deduplicateStrings(candidates);
}

function getCandidateDriveRoots(): string[] {
    const roots = new Set<string>();
    roots.add(path.parse(process.cwd()).root);

    for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
        roots.add(path.parse(workspaceFolder.uri.fsPath).root);
    }

    if (process.env.SystemDrive) {
        roots.add(path.parse(process.env.SystemDrive).root || `${process.env.SystemDrive}\\`);
    }

    roots.add("C:\\");
    roots.add("D:\\");
    return [...roots].filter((root) => root.length > 0);
}

function deduplicateStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const value of values) {
        const normalized = path.normalize(value).toLowerCase();
        if (seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(value);
    }

    return result;
}

function inferScriptType(document: vscode.TextDocument): "AGS" | "IRS" | "GEM" | "AGM" | "IRM" {
    const extension = path.extname(document.fileName).toLowerCase();
    switch (extension) {
        case ".irs":
            return "IRS";
        case ".gem":
            return "GEM";
        case ".agm":
            return "AGM";
        case ".irm":
            return "IRM";
        case ".ags":
        default:
            return "AGS";
    }
}

function supportsEcCompilerValidation(document: vscode.TextDocument): boolean {
    const scriptType = inferScriptType(document);
    return scriptType === "AGS" || scriptType === "IRS";
}
