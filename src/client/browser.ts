import * as vscode from "vscode";
import { LanguageClient, type LanguageClientOptions } from "vscode-languageclient/browser";
import { activateClient, LANGUAGE_ID } from "./common";

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel("Altitude ASL", { log: true });
    const serverMain = vscode.Uri.joinPath(context.extensionUri, "dist/server/browser.js");
    const worker = new Worker(serverMain.toString(true));
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ language: LANGUAGE_ID }],
        outputChannel: output,
        synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{ags,agm,gem,irs,irm}") }
    };
    client = new LanguageClient("altitudeAsl", "Altitude ASL", worker, clientOptions);
    context.subscriptions.push(output);
    await activateClient(context, client, output);
}

export async function deactivate(): Promise<void> {
    await client?.stop();
}
