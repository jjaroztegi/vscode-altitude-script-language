import { readFile } from "node:fs/promises";
import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { URI } from "vscode-uri";
import { decodeText, findAslFiles } from "../node/files";
import { startServer } from "./server";

// The transport comes from argv: --node-ipc (VS Code), --stdio or --socket=<port> (other editors).
const connection = createConnection(ProposedFeatures.all);

startServer(connection, {
    async readFile(uri) {
        const parsed = URI.parse(uri);
        if (parsed.scheme === "file") {
            try {
                return decodeText(await readFile(parsed.fsPath));
            } catch {
                return undefined;
            }
        }
        // Remote and virtual file systems: ask the client. Only the VS Code extension implements this request.
        try {
            return (await connection.sendRequest<string | null>("altitude-asl/readFile", uri)) ?? undefined;
        } catch {
            return undefined;
        }
    },
    listFiles(folderUri) {
        const folder = URI.parse(folderUri);
        return folder.scheme === "file" ? findAslFiles(folder.fsPath).map((file) => URI.file(file).toString()) : [];
    }
});
