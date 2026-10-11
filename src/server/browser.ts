import { BrowserMessageReader, BrowserMessageWriter, createConnection } from "vscode-languageserver/browser";
import { startServer } from "./server";

declare const self: DedicatedWorkerGlobalScope;

const connection = createConnection(new BrowserMessageReader(self), new BrowserMessageWriter(self));

startServer(connection, {
    async readFile(uri) {
        return (await connection.sendRequest<string | null>("altitude-asl/readFile", uri)) ?? undefined;
    }
});
