import { readFile } from "node:fs/promises";
import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { URI } from "vscode-uri";
import { startServer } from "./server";

const connection = createConnection(ProposedFeatures.all);

startServer(connection, {
    async readFile(uri) {
        const parsed = URI.parse(uri);
        if (parsed.scheme === "file") {
            try {
                return await readFile(parsed.fsPath, "utf8");
            } catch {
                return undefined;
            }
        }
        // Remote and virtual file systems: ask the client.
        return (await connection.sendRequest<string | null>("altitude-asl/readFile", uri)) ?? undefined;
    }
});
