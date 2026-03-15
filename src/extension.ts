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
type CompilerValidationTrigger = "save" | "command" | "type";

export function activate(context: vscode.ExtensionContext): void {
    const analysisService = new AslAnalysisService();
    const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
    const compilerValidationService = new AslCompilerValidationService();
    const pendingValidationTimers = new Map<string, NodeJS.Timeout>();

    const clearPendingValidation = (uri: vscode.Uri): void => {
        const key = uri.toString();
        const timer = pendingValidationTimers.get(key);
        if (timer) {
            clearTimeout(timer);
            pendingValidationTimers.delete(key);
        }
    };

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
        const enabled = configuration.get<boolean>("enabled", false);
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

    const scheduleTypeValidation = (document: vscode.TextDocument): void => {
        if (document.languageId !== LANGUAGE_ID || document.uri.scheme !== "file") {
            return;
        }

        const configuration = vscode.workspace.getConfiguration(COMPILER_CONFIGURATION_ROOT);
        const enabled = configuration.get<boolean>("enabled", false);
        const runOnType = configuration.get<boolean>("runOnType", false);
        if (!enabled || !runOnType) {
            clearPendingValidation(document.uri);
            return;
        }

        const debounceMs = Math.max(configuration.get<number>("debounceMs", 1200), 200);
        clearPendingValidation(document.uri);
        const timer = setTimeout(() => {
            pendingValidationTimers.delete(document.uri.toString());
            void runCompilerValidation(document, "type");
        }, debounceMs);

        pendingValidationTimers.set(document.uri.toString(), timer);
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
            clearPendingValidation(document.uri);
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            analysisService.clear(event.document);
            refreshDiagnostics(event.document);
            scheduleTypeValidation(event.document);
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
                        clearPendingValidation(document.uri);
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

    context.subscriptions.push({
        dispose: () => {
            for (const timer of pendingValidationTimers.values()) {
                clearTimeout(timer);
            }
            pendingValidationTimers.clear();
        }
    });

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

interface PreparedCompilerInput {
    acceptedPaths?: string[];
    cleanup?: () => Promise<void>;
    errFilePath?: string;
    filePath: string;
    tempDirectory?: string;
}

interface ErrDiagnosticAnchor {
    kind: "block" | "statement";
    text: string;
}

interface ErrDiagnosticLocation {
    endLineIndex?: number;
    lineIndex: number;
}

interface EcCompilerEnvironment {
    cCompilerRoot: string;
    executablePath: string;
    rcExecutablePath: string;
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

        const installRoot = await this.resolveInstallRoot(configuration);
        if (!installRoot) {
            return {
                diagnostics: [
                    createDocumentStartDiagnostic(
                        document,
                        "Script Developer validation requires an Altitude Script Developer installation. Configure altitudeScriptLanguage.compiler.installRoot if auto-discovery is not enough.",
                        vscode.DiagnosticSeverity.Warning
                    )
                ],
                executionMessage: "Script Developer validation prerequisites were not found."
            };
        }

        const timeoutMs = configuration.get<number>("timeoutMs", 20000);
        const workingDirectory = this.resolveWorkingDirectory(document);
        const ecEnvironment = await this.resolveEcCompilerEnvironment(installRoot);
        if (!ecEnvironment) {
            return {
                diagnostics: [
                    createDocumentStartDiagnostic(
                        document,
                        "Script Developer compiler validation requires ec.exe, Visual Studio Build Tools (VC), and rc.exe. Configure altitudeScriptLanguage.compiler.installRoot if Script Developer auto-discovery is not enough.",
                        vscode.DiagnosticSeverity.Warning
                    )
                ],
                executionMessage: "Script Developer compiler validation prerequisites were not found."
            };
        }

        const input = await this.prepareEcCompilerInput(document, trigger);
        const args = this.buildEcCompilerArguments(document, ecEnvironment.cCompilerRoot, input);
        const processEnvironment = createCompilerProcessEnvironment(ecEnvironment.rcExecutablePath);
        this.outputChannel.appendLine(`Running: ${ecEnvironment.executablePath} ${args.join(" ")}`);
        this.outputChannel.appendLine(`Working directory: ${workingDirectory}`);

        try {
            return await this.runEcCompilerProcess(ecEnvironment.executablePath, args, workingDirectory, timeoutMs, processEnvironment, document, input);
        } finally {
            if (input.cleanup) {
                await input.cleanup();
            }
        }
    }

    private async resolveInstallRoot(configuration: vscode.WorkspaceConfiguration): Promise<string | undefined> {
        const configuredRoot = configuration.get<string>("installRoot", "").trim();
        if (configuredRoot) {
            const normalized = path.normalize(configuredRoot);
            if (await isScriptDeveloperInstallRoot(normalized)) {
                return normalized;
            }
            return undefined;
        }

        for (const candidate of getCommonScriptDeveloperRoots()) {
            if (await isScriptDeveloperInstallRoot(candidate)) {
                return candidate;
            }
        }

        return undefined;
    }

    private async resolveEcCompilerEnvironment(installRoot: string): Promise<EcCompilerEnvironment | undefined> {
        const executablePath = await this.resolveEcCompilerExecutable(installRoot);
        const cCompilerRoot = await this.resolveCCompilerRoot();
        const rcExecutablePath = await this.resolveRcExecutablePath();
        if (!executablePath || !cCompilerRoot || !rcExecutablePath) {
            return undefined;
        }

        return { cCompilerRoot, executablePath, rcExecutablePath };
    }

    private async resolveEcCompilerExecutable(installRoot: string): Promise<string | undefined> {
        const candidates = [path.join(installRoot, "bin", "ec.exe"), path.join(installRoot, "ec.exe")];
        for (const candidate of candidates) {
            if (await fileExists(candidate)) {
                return candidate;
            }
        }
        return undefined;
    }

    private buildEcCompilerArguments(document: vscode.TextDocument, cCompilerRoot: string, input: PreparedCompilerInput): string[] {
        return [`/st=${inferScriptType(document)}`, "/go", `/ccr=${cCompilerRoot}`, `/odir=${input.tempDirectory ?? path.dirname(input.filePath)}`, input.filePath];
    }

    private resolveWorkingDirectory(document: vscode.TextDocument): string {
        return path.dirname(document.fileName);
    }

    private async prepareEcCompilerInput(document: vscode.TextDocument, trigger: CompilerValidationTrigger): Promise<PreparedCompilerInput> {
        const tempFolder = await fs.promises.mkdtemp(path.join(os.tmpdir(), "asl-vscode-"));
        if (trigger !== "type" || !document.isDirty) {
            return {
                acceptedPaths: [document.fileName],
                cleanup: async () => {
                    await fs.promises.rm(tempFolder, { recursive: true, force: true });
                },
                errFilePath: replaceFileExtension(document.fileName, ".err"),
                filePath: document.fileName,
                tempDirectory: tempFolder
            };
        }

        const extension = path.extname(document.fileName);
        const basename = path.basename(document.fileName, extension);
        const tempFilePath = path.join(path.dirname(document.fileName), `.${basename}.vscode-asl-${Date.now()}${extension}`);
        await fs.promises.writeFile(tempFilePath, document.getText(), "utf8");
        const tempErrPath = replaceFileExtension(tempFilePath, ".err");
        return {
            acceptedPaths: [document.fileName, tempFilePath],
            cleanup: async () => {
                await fs.promises.rm(tempFilePath, { force: true });
                await fs.promises.rm(tempErrPath, { force: true });
                await fs.promises.rm(tempFolder, { recursive: true, force: true });
            },
            errFilePath: tempErrPath,
            filePath: tempFilePath,
            tempDirectory: tempFolder
        };
    }

    private async resolveCCompilerRoot(): Promise<string | undefined> {
        for (const candidate of getCommonCCompilerRoots()) {
            if (await fileExists(candidate)) {
                return candidate;
            }
        }

        return undefined;
    }

    private async resolveRcExecutablePath(): Promise<string | undefined> {
        const fromPath = await findExecutableOnPath("rc.exe");
        if (fromPath) {
            return fromPath;
        }

        for (const candidate of await getCommonRcExecutablePaths()) {
            if (await fileExists(candidate)) {
                return candidate;
            }
        }

        return undefined;
    }

    private async runEcCompilerProcess(
        executablePath: string,
        args: string[],
        cwd: string,
        timeoutMs: number,
        env: NodeJS.ProcessEnv,
        document: vscode.TextDocument,
        input: PreparedCompilerInput
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

            const process = spawn(executablePath, args, { cwd, env, windowsHide: true });
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

                const diagnostics = deduplicateDiagnostics([
                    ...parseCompilerOutput(combinedOutput, document, cwd, input.acceptedPaths ?? [document.fileName]),
                    ...(input.errFilePath ? await readCompilerErrDiagnostics(input.errFilePath, document) : [])
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

function parseCompilerOutput(output: string, document: vscode.TextDocument, cwd: string, acceptedPaths: string[]): vscode.Diagnostic[] {
    if (!output.trim()) {
        return [];
    }

    const diagnostics: vscode.Diagnostic[] = [];
    const acceptedPathSet = new Set(acceptedPaths.map((candidate) => path.normalize(candidate).toLowerCase()));

    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }

        const filePatternA = line.match(/^(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(?:(error|warning|info)\s*[:\-]?\s*)?(.+)$/i);
        if (filePatternA) {
            const targetPath = resolveDiagnosticPath(filePatternA[1], cwd);
            if (targetPath && !acceptedPathSet.has(targetPath)) {
                continue;
            }
            diagnostics.push(createCompilerDiagnostic(document, Number.parseInt(filePatternA[2], 10), parseOptionalNumber(filePatternA[3]), filePatternA[5], toDiagnosticSeverity(filePatternA[4])));
            continue;
        }

        const filePatternB = line.match(/^(.+?):(\d+):(\d+):\s*(?:(error|warning|info)\s*[:\-]?\s*)?(.+)$/i);
        if (filePatternB) {
            const targetPath = resolveDiagnosticPath(filePatternB[1], cwd);
            if (targetPath && !acceptedPathSet.has(targetPath)) {
                continue;
            }
            diagnostics.push(createCompilerDiagnostic(document, Number.parseInt(filePatternB[2], 10), Number.parseInt(filePatternB[3], 10), filePatternB[5], toDiagnosticSeverity(filePatternB[4])));
            continue;
        }

        const linePattern = line.match(/^(?:(error|warning|info)\s*[:\-]?\s*)?line\s+(\d+)(?:\s*(?:,|:)\s*(?:col|column)\s*(\d+))?\s*[:\-]\s*(.+)$/i);
        if (linePattern) {
            diagnostics.push(createCompilerDiagnostic(document, Number.parseInt(linePattern[2], 10), parseOptionalNumber(linePattern[3]), linePattern[4], toDiagnosticSeverity(linePattern[1])));
            continue;
        }

        const ecPattern = line.match(/^(error|warning|info)\s*:\s*(\d+)\s*,\s*(\d+)\s*(?:\[(\d+)\])?\s*:\s*(.+)$/i);
        if (ecPattern) {
            const codeSuffix = ecPattern[4] ? ` [${ecPattern[4]}]` : "";
            diagnostics.push(
                createCompilerDiagnostic(
                    document,
                    Number.parseInt(ecPattern[2], 10),
                    Number.parseInt(ecPattern[3], 10),
                    `${ecPattern[5]}${codeSuffix}`,
                    toDiagnosticSeverity(ecPattern[1])
                )
            );
        }
    }

    return diagnostics;
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

function resolveDiagnosticPath(filePath: string, cwd: string): string | undefined {
    const normalized = filePath.trim();
    if (!normalized) {
        return undefined;
    }

    const absolutePath = path.isAbsolute(normalized) ? normalized : path.join(cwd, normalized);
    return path.normalize(absolutePath).toLowerCase();
}

function createCompilerDiagnostic(document: vscode.TextDocument, lineNumber: number, columnNumber: number | undefined, message: string, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
    const lineIndex = Math.min(Math.max(lineNumber - 1, 0), Math.max(document.lineCount - 1, 0));
    const lineText = document.lineAt(lineIndex).text;
    const characterIndex = columnNumber ? Math.max(columnNumber - 1, 0) : getFirstMeaningfulCharacterIndex(lineText);
    const startCharacter = Math.min(characterIndex, lineText.length);
    const endCharacter = Math.min(startCharacter + Math.max(getIdentifierLength(lineText, startCharacter), 1), Math.max(lineText.length, startCharacter + 1));
    return new vscode.Diagnostic(new vscode.Range(lineIndex, startCharacter, lineIndex, endCharacter), message.trim(), severity);
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

function getIdentifierLength(text: string, start: number): number {
    const remainder = text.slice(start);
    const match = remainder.match(/^[A-Za-z_\p{L}][A-Za-z0-9_\p{L}\p{N}]*/u);
    return match ? match[0].length : 1;
}

function getFirstMeaningfulCharacterIndex(text: string): number {
    const match = text.match(/\S/u);
    return match?.index ?? 0;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
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

function createCompilerProcessEnvironment(rcExecutablePath: string): NodeJS.ProcessEnv {
    const rcDirectory = path.dirname(rcExecutablePath);
    return {
        ...process.env,
        PATH: prependDirectoryToPath(rcDirectory, process.env.PATH)
    };
}

function prependDirectoryToPath(directory: string, currentPath: string | undefined): string {
    const entries = (currentPath ?? "")
        .split(path.delimiter)
        .filter((entry) => entry.length > 0);
    const normalizedDirectory = path.normalize(directory).toLowerCase();
    if (!entries.some((entry) => path.normalize(entry).toLowerCase() === normalizedDirectory)) {
        entries.unshift(directory);
    }
    return entries.join(path.delimiter);
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

async function findExecutableOnPath(executableName: string): Promise<string | undefined> {
    const pathEntries = (process.env.PATH ?? "")
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    for (const entry of pathEntries) {
        const candidate = path.join(entry, executableName);
        if (await fileExists(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

async function getCommonRcExecutablePaths(): Promise<string[]> {
    const candidates: string[] = [];

    for (const driveRoot of getCandidateDriveRoots()) {
        const basePath = path.join(driveRoot, "Program Files (x86)", "Windows Kits", "10", "bin");
        const versionDirectories = await getVersionDirectories(basePath);
        for (const versionDirectory of versionDirectories) {
            candidates.push(path.join(versionDirectory, "x64", "rc.exe"));
            candidates.push(path.join(versionDirectory, "x86", "rc.exe"));
        }

        candidates.push(path.join(basePath, "x64", "rc.exe"));
        candidates.push(path.join(basePath, "x86", "rc.exe"));
    }

    return deduplicateStrings(candidates);
}

async function getVersionDirectories(basePath: string): Promise<string[]> {
    try {
        const entries = await fs.promises.readdir(basePath, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(entry.name))
            .map((entry) => path.join(basePath, entry.name))
            .sort((left, right) => compareVersionStrings(path.basename(right), path.basename(left)));
    } catch {
        return [];
    }
}

async function isScriptDeveloperInstallRoot(root: string): Promise<boolean> {
    return (await fileExists(path.join(root, "bin", "Altitude.ASL.Compiler.dll"))) || (await fileExists(path.join(root, "Altitude.ASL.Compiler.dll")));
}

function compareVersionStrings(left: string, right: string): number {
    const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
    const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
    const length = Math.max(leftParts.length, rightParts.length);

    for (let index = 0; index < length; index += 1) {
        const leftPart = leftParts[index] ?? 0;
        const rightPart = rightParts[index] ?? 0;
        if (leftPart !== rightPart) {
            return leftPart - rightPart;
        }
    }

    return 0;
}

function getCommonScriptDeveloperRoots(): string[] {
    const candidates: string[] = [];
    for (const driveRoot of getCandidateDriveRoots()) {
        candidates.push(path.join(driveRoot, "Program Files (x86)", "Altitude", "Altitude uCI 8", "Altitude Script Developer"));
        candidates.push(path.join(driveRoot, "Program Files", "Altitude", "Altitude uCI 8", "Altitude Script Developer"));
    }
    return deduplicateStrings(candidates);
}

function getCommonCCompilerRoots(): string[] {
    const candidates: string[] = [];
    const skus = ["BuildTools", "Community", "Professional", "Enterprise"];
    const versions = ["2022", "2019"];
    const programFilesRoots = ["Program Files (x86)", "Program Files"];

    for (const driveRoot of getCandidateDriveRoots()) {
        for (const programFilesRoot of programFilesRoots) {
            for (const version of versions) {
                for (const sku of skus) {
                    candidates.push(path.join(driveRoot, programFilesRoot, "Microsoft Visual Studio", version, sku, "VC"));
                }
            }
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
