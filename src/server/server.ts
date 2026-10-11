/**
 * Language server shared by the desktop (Node) and web (worker) entry points.
 * File access goes through `host.readFile`, so the same code runs in vscode.dev.
 */
import {
    CodeActionKind,
    DiagnosticSeverity,
    DiagnosticTag,
    DocumentDiagnosticReportKind,
    FileChangeType,
    TextDocumentSyncKind,
    TextDocuments,
    type Connection,
    type Diagnostic,
    type InitializeParams,
    type InitializeResult
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { AslDiagnostic } from "../language/checker";
import { lineMap, toRange } from "../language/features/common";
import { complete, signatureHelp } from "../language/features/completion";
import { codeActions, format, incomingCalls, inlayHints, outgoingCalls, prepareCallHierarchy, type DiagnosticWithData } from "../language/features/edits";
import { definition, documentHighlights, documentLinks, hover, prepareRename, references, rename, typeDefinition } from "../language/features/navigation";
import { documentSymbols, foldingRanges, selectionRanges, workspaceSymbols } from "../language/features/outline";
import { LEGEND, semanticTokens } from "../language/features/semanticTokens";
import { isAslUri, Workspace, type Settings } from "../language/workspace";

export interface ServerHost {
    readFile(uri: string): Promise<string | undefined>;
}

interface ClientSettings {
    webEdition?: boolean;
    lint?: { rules?: Settings["rules"] };
    inlayHints?: { parameterNames?: boolean };
}

const SEVERITY: Record<AslDiagnostic["severity"], DiagnosticSeverity> = {
    error: DiagnosticSeverity.Error,
    warning: DiagnosticSeverity.Warning,
    info: DiagnosticSeverity.Information,
    hint: DiagnosticSeverity.Hint
};

export function startServer(connection: Connection, host: ServerHost): void {
    const documents = new TextDocuments(TextDocument);
    let settings: ClientSettings = {};
    let supportsConfiguration = false;
    const workspace = new Workspace({
        readFile: (uri) => host.readFile(uri),
        settings: () => ({ webEdition: settings.webEdition ?? true, rules: settings.lint?.rules })
    });

    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = (): void => {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            void connection.languages.diagnostics.refresh();
            void connection.languages.semanticTokens.refresh();
            void connection.languages.inlayHint.refresh();
        }, 300);
    };

    const loadSettings = async (): Promise<void> => {
        if (!supportsConfiguration) return;
        settings = ((await connection.workspace.getConfiguration("altitudeScriptLanguage")) as ClientSettings | null) ?? {};
    };

    /** Loads the document's module graph and returns the analysis entry points. */
    const ready = async (uri: string): Promise<{ file: NonNullable<ReturnType<Workspace["model"]>>; program: NonNullable<ReturnType<Workspace["program"]>> } | undefined> => {
        await workspace.prepare(uri);
        const file = workspace.model(uri);
        const program = workspace.program(uri);
        return file && program ? { file, program } : undefined;
    };

    const offsetOf = (uri: string, position: { line: number; character: number }): number | undefined => {
        const file = workspace.model(uri);
        return file ? lineMap(file).offsetAt(position) : undefined;
    };

    connection.onInitialize((params: InitializeParams): InitializeResult => {
        supportsConfiguration = params.capabilities.workspace?.configuration === true;
        return {
            capabilities: {
                textDocumentSync: TextDocumentSyncKind.Incremental,
                diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
                completionProvider: { triggerCharacters: [".", ":", "@", "'", '"', "<"] },
                hoverProvider: true,
                signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
                definitionProvider: true,
                typeDefinitionProvider: true,
                referencesProvider: true,
                documentHighlightProvider: true,
                renameProvider: { prepareProvider: true },
                documentSymbolProvider: { label: "ASL" },
                workspaceSymbolProvider: true,
                semanticTokensProvider: { legend: LEGEND, full: true, range: true },
                foldingRangeProvider: true,
                selectionRangeProvider: true,
                documentFormattingProvider: true,
                documentRangeFormattingProvider: true,
                documentOnTypeFormattingProvider: { firstTriggerCharacter: "}" },
                codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
                inlayHintProvider: true,
                documentLinkProvider: { resolveProvider: false },
                callHierarchyProvider: true
            },
            serverInfo: { name: "Altitude ASL Language Server" }
        };
    });

    connection.onInitialized(async () => {
        await loadSettings();
    });

    connection.onDidChangeConfiguration(async () => {
        await loadSettings();
        scheduleRefresh();
    });

    // The client sends every ASL file of the workspace once, then file events.
    connection.onNotification("altitude-asl/files", async (uris: string[]) => {
        for (const uri of uris) if (isAslUri(uri)) workspace.setDiskFile(uri);
        await workspace.prepareAll();
        scheduleRefresh();
    });

    connection.onDidChangeWatchedFiles((params) => {
        for (const change of params.changes) {
            if (!isAslUri(change.uri)) continue;
            if (change.type === FileChangeType.Deleted) workspace.removeFile(change.uri);
            else workspace.fileChanged(change.uri);
        }
        scheduleRefresh();
    });

    documents.onDidOpen((event) => {
        workspace.setDocument(event.document.uri, event.document.getText(), event.document.version);
    });
    documents.onDidChangeContent((event) => {
        workspace.setDocument(event.document.uri, event.document.getText(), event.document.version);
        scheduleRefresh();
    });
    documents.onDidClose((event) => {
        workspace.closeDocument(event.document.uri);
        workspace.setDiskFile(event.document.uri);
    });

    // ------------------------------------------------------------ diagnostics

    connection.languages.diagnostics.on(async (params) => {
        const uri = params.textDocument.uri;
        const analysis = await ready(uri);
        if (!analysis) return { kind: DocumentDiagnosticReportKind.Full, items: [] };
        const items: Diagnostic[] = workspace.diagnose(uri).map((d) => ({
            range: toRange(analysis.file, d),
            severity: SEVERITY[d.severity],
            code: d.code,
            codeDescription: { href: `https://github.com/jjaroztegi/vscode-altitude-script-language/blob/main/docs/rules.md#${d.code}` },
            source: "asl",
            message: d.message,
            tags: d.tags?.map((t) => (t === "unnecessary" ? DiagnosticTag.Unnecessary : DiagnosticTag.Deprecated)),
            data: d.data
        }));
        return { kind: DocumentDiagnosticReportKind.Full, items };
    });

    // ------------------------------------------------------------ language features

    connection.onCompletion(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        const offset = offsetOf(params.textDocument.uri, params.position);
        return analysis && offset !== undefined ? complete(workspace, analysis.file, analysis.program, offset) : null;
    });

    connection.onHover(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        const offset = offsetOf(params.textDocument.uri, params.position);
        return analysis && offset !== undefined ? (hover(workspace, analysis.file, analysis.program, offset) ?? null) : null;
    });

    connection.onSignatureHelp(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        const offset = offsetOf(params.textDocument.uri, params.position);
        return analysis && offset !== undefined ? (signatureHelp(workspace, analysis.file, analysis.program, offset) ?? null) : null;
    });

    connection.onDefinition(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        const offset = offsetOf(params.textDocument.uri, params.position);
        return analysis && offset !== undefined ? definition(workspace, analysis.file, analysis.program, offset) : null;
    });

    connection.onTypeDefinition(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        const offset = offsetOf(params.textDocument.uri, params.position);
        return analysis && offset !== undefined ? typeDefinition(workspace, analysis.file, analysis.program, offset) : null;
    });

    connection.onReferences(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        await workspace.prepareAll();
        const offset = offsetOf(params.textDocument.uri, params.position);
        return analysis && offset !== undefined ? references(workspace, analysis.file, analysis.program, offset, params.context.includeDeclaration) : null;
    });

    connection.onDocumentHighlight(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        const offset = offsetOf(params.textDocument.uri, params.position);
        return analysis && offset !== undefined ? documentHighlights(workspace, analysis.file, analysis.program, offset) : null;
    });

    connection.onPrepareRename(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        const offset = offsetOf(params.textDocument.uri, params.position);
        return analysis && offset !== undefined ? (prepareRename(workspace, analysis.file, analysis.program, offset) ?? null) : null;
    });

    connection.onRenameRequest(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        await workspace.prepareAll();
        const offset = offsetOf(params.textDocument.uri, params.position);
        return analysis && offset !== undefined ? (rename(workspace, analysis.file, analysis.program, offset, params.newName) ?? null) : null;
    });

    connection.onDocumentSymbol(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        return analysis ? documentSymbols(analysis.file) : null;
    });

    connection.onWorkspaceSymbol(async (params) => {
        await workspace.prepareAll();
        return workspaceSymbols(workspace, params.query);
    });

    connection.languages.semanticTokens.on(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        return { data: analysis ? semanticTokens(analysis.file, analysis.program) : [] };
    });

    connection.languages.semanticTokens.onRange(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        if (!analysis) return { data: [] };
        const map = lineMap(analysis.file);
        return { data: semanticTokens(analysis.file, analysis.program, { start: map.offsetAt(params.range.start), end: map.offsetAt(params.range.end) }) };
    });

    connection.onFoldingRanges(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        return analysis ? foldingRanges(analysis.file) : null;
    });

    connection.onSelectionRanges(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        if (!analysis) return null;
        const map = lineMap(analysis.file);
        return selectionRanges(analysis.file, params.positions.map((p) => map.offsetAt(p)));
    });

    connection.onDocumentFormatting(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        return analysis ? format(analysis.file, params.options) : null;
    });

    connection.onDocumentRangeFormatting(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        return analysis ? format(analysis.file, params.options, { startLine: params.range.start.line, endLine: params.range.end.line }) : null;
    });

    connection.onDocumentOnTypeFormatting(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        return analysis ? format(analysis.file, params.options, { startLine: params.position.line, endLine: params.position.line }) : null;
    });

    connection.onCodeAction(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        return analysis ? codeActions(analysis.file, params.textDocument.uri, params.context.diagnostics as DiagnosticWithData[]) : null;
    });

    connection.languages.inlayHint.on(async (params) => {
        if (!settings.inlayHints?.parameterNames) return [];
        const analysis = await ready(params.textDocument.uri);
        if (!analysis) return null;
        const map = lineMap(analysis.file);
        return inlayHints(workspace, analysis.file, analysis.program, { start: map.offsetAt(params.range.start), end: map.offsetAt(params.range.end) });
    });

    connection.onDocumentLinks(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        return analysis ? documentLinks(workspace, analysis.file) : null;
    });

    connection.languages.callHierarchy.onPrepare(async (params) => {
        const analysis = await ready(params.textDocument.uri);
        const offset = offsetOf(params.textDocument.uri, params.position);
        return analysis && offset !== undefined ? prepareCallHierarchy(workspace, analysis.file, analysis.program, offset) : null;
    });

    connection.languages.callHierarchy.onIncomingCalls(async (params) => {
        await workspace.prepareAll();
        return incomingCalls(workspace, params.item);
    });

    connection.languages.callHierarchy.onOutgoingCalls(async (params) => {
        await ready(params.item.uri);
        return outgoingCalls(workspace, params.item);
    });

    documents.listen(connection);
    connection.listen();
}
