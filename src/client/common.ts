import * as vscode from "vscode";
import type { BaseLanguageClient } from "vscode-languageclient";
import { normalizeBytes } from "../language/encoding";

export const LANGUAGE_ID = "altitude-asl";
export const SECTION = "altitudeScriptLanguage";
const ASL_GLOB = "**/*.{ags,agm,gem,irs,irm,AGS,AGM,GEM,IRS,IRM}";

/** Wiring shared by the desktop and web clients. */
export async function activateClient(context: vscode.ExtensionContext, client: BaseLanguageClient, output: vscode.OutputChannel): Promise<void> {
    // The server reads files that are not open through the client (virtual and remote file systems).
    client.onRequest("altitude-asl/readFile", async (uri: string) => {
        try {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(uri));
            return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
        } catch {
            return null;
        }
    });

    await client.start();

    const sendFiles = async (): Promise<void> => {
        const uris = await vscode.workspace.findFiles(ASL_GLOB, "**/{node_modules,.git}/**", 20000);
        await client.sendNotification("altitude-asl/files", uris.map((u) => u.toString()));
    };
    void sendFiles();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(SECTION)) void client.sendNotification("workspace/didChangeConfiguration", { settings: null });
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => void sendFiles()),
        vscode.commands.registerCommand(`${SECTION}.restartServer`, async () => {
            await client.stop();
            await client.start();
            await sendFiles();
        }),
        vscode.commands.registerCommand(`${SECTION}.showOutput`, () => output.show()),
        vscode.commands.registerCommand(`${SECTION}.disableRule`, async (rule: string) => {
            const config = vscode.workspace.getConfiguration(SECTION);
            const rules = { ...(config.get<Record<string, string>>("lint.rules") ?? {}), [rule]: "off" };
            const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
            await config.update("lint.rules", rules, target);
            void vscode.window.showInformationMessage(`Rule '${rule}' turned off in ${target === vscode.ConfigurationTarget.Workspace ? "workspace" : "user"} settings.`);
        })
    );

    registerEncodingCheck(context);
}

// ------------------------------------------------------------ file encoding

/**
 * Script Developer reads and writes scripts as UTF-8 with BOM and CRLF line endings. Editors that drop the BOM
 * or convert to LF cause noisy diffs and broken imports, so open ASL files are checked and can be fixed in place.
 */
function registerEncodingCheck(context: vscode.ExtensionContext): void {
    const collection = vscode.languages.createDiagnosticCollection("asl-encoding");
    const check = (document: vscode.TextDocument): void => {
        if (document.languageId !== LANGUAGE_ID || document.uri.scheme === "git" || document.isUntitled) return;
        const problems: string[] = [];
        if (document.encoding && document.encoding !== "utf8bom") problems.push(`encoded as ${document.encoding}, not UTF-8 with BOM`);
        if (document.eol === vscode.EndOfLine.LF && document.lineCount > 1) problems.push("uses LF line endings, not CRLF");
        if (problems.length === 0) {
            collection.delete(document.uri);
            return;
        }
        const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, Math.min(document.lineAt(0).text.length, 40) || 1), `This file ${problems.join(" and ")}. Script Developer saves ASL files as UTF-8 with BOM and CRLF.`, vscode.DiagnosticSeverity.Warning);
        diagnostic.source = "asl";
        diagnostic.code = "encoding";
        collection.set(document.uri, [diagnostic]);
    };
    context.subscriptions.push(
        collection,
        vscode.workspace.onDidOpenTextDocument(check),
        vscode.workspace.onDidSaveTextDocument(check),
        vscode.workspace.onDidChangeTextDocument((e) => check(e.document)),
        vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri)),
        vscode.languages.registerCodeActionsProvider(
            { language: LANGUAGE_ID },
            {
                provideCodeActions(document, _range, ctx) {
                    if (!ctx.diagnostics.some((d) => d.code === "encoding")) return [];
                    const action = new vscode.CodeAction("Save as UTF-8 with BOM and CRLF", vscode.CodeActionKind.QuickFix);
                    action.isPreferred = true;
                    action.command = { title: action.title, command: `${SECTION}.fixEncoding`, arguments: [document.uri] };
                    return [action];
                }
            },
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
        ),
        vscode.commands.registerCommand(`${SECTION}.fixEncoding`, async (uri?: vscode.Uri) => {
            const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
            if (!document) return;
            if (document.isDirty) await document.save();
            const text = document.getText().replace(/\r?\n/g, "\r\n");
            const bytes = await vscode.workspace.encode(text, { encoding: "utf8bom" });
            await vscode.workspace.fs.writeFile(document.uri, bytes);
            const reopened = await vscode.workspace.openTextDocument(document.uri, { encoding: "utf8bom" });
            check(reopened);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(`${SECTION}.fixEncodingAll`, async () => {
            const uris = await vscode.workspace.findFiles(ASL_GLOB, "**/{node_modules,.git}/**", 20000);
            const dirty = new Set(vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => d.uri.toString()));
            const changed: vscode.Uri[] = [];
            const skipped: string[] = [];
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Checking ASL file encodings…" }, async () => {
                for (const uri of uris) {
                    if (dirty.has(uri.toString())) {
                        skipped.push(vscode.workspace.asRelativePath(uri));
                        continue;
                    }
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    const fixed = normalizeBytes(bytes);
                    if (fixed) {
                        await vscode.workspace.fs.writeFile(uri, fixed);
                        changed.push(uri);
                    }
                }
            });
            const message = changed.length ? `Converted ${changed.length} of ${uris.length} ASL files to UTF-8 with BOM and CRLF.` : `All ${uris.length} ASL files already use UTF-8 with BOM and CRLF.`;
            void vscode.window.showInformationMessage(skipped.length ? `${message} Skipped ${skipped.length} file(s) with unsaved changes.` : message);
        })
    );
    vscode.workspace.textDocuments.forEach(check);
}
