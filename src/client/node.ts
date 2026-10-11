import * as vscode from "vscode";
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";
import { activateClient, LANGUAGE_ID } from "./common";
import { registerCompiler } from "./compiler";

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel("Altitude ASL", { log: true });
    const module = vscode.Uri.joinPath(context.extensionUri, "dist/server/node.js").fsPath;
    const serverOptions: ServerOptions = {
        run: { module, transport: TransportKind.ipc },
        debug: { module, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6009"] } }
    };
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ language: LANGUAGE_ID }],
        outputChannel: output,
        // activateClient sends the workspace's ASL files, so the server does not scan the disk itself.
        initializationOptions: { clientProvidesFiles: true },
        synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{ags,agm,gem,irs,irm}") }
    };
    client = new LanguageClient("altitudeAsl", "Altitude ASL", serverOptions, clientOptions);
    context.subscriptions.push(output);
    registerCompiler(context, output);
    await activateClient(context, client, output);
}

export async function deactivate(): Promise<void> {
    await client?.stop();
}
