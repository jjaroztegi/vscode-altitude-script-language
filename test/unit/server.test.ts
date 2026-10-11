import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";
import { URI } from "vscode-uri";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface PublishParams {
    uri: string;
    diagnostics: { code: string; severity: number }[];
}

const FIXTURES = path.join(__dirname, "..", "fixtures", "project");
let server: ChildProcess;
let connection: MessageConnection;
const published: PublishParams[] = [];

/** Waits for a diagnostics notification for the file that satisfies `accept`. */
async function diagnosticsFor(name: string, accept: (codes: string[]) => boolean): Promise<string[]> {
    const uri = URI.file(path.join(FIXTURES, name)).toString();
    const started = Date.now();
    for (;;) {
        const last = published.filter((p) => p.uri === uri).at(-1);
        const codes = last?.diagnostics.map((d) => d.code).sort();
        if (codes && accept(codes)) return codes;
        if (Date.now() - started > 10000) throw new Error(`no matching diagnostics for ${name}: ${JSON.stringify(codes)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

const open = (name: string): Promise<void> =>
    connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri: URI.file(path.join(FIXTURES, name)).toString(), languageId: "altitude-asl", version: 1, text: fs.readFileSync(path.join(FIXTURES, name), "utf8") }
    });

beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asl-server-"));
    const bundle = path.join(dir, "node.js");
    await build({ entryPoints: [path.join(__dirname, "..", "..", "src", "server", "node.ts")], outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "warning" });
    server = spawn(process.execPath, [bundle, "--stdio"], { stdio: "pipe" });
    connection = createMessageConnection(new StreamMessageReader(server.stdout!), new StreamMessageWriter(server.stdin!));
    connection.onNotification("textDocument/publishDiagnostics", (params: PublishParams) => void published.push(params));
    connection.listen();
    // A bare client: no workspace/configuration, no pull diagnostics, no altitude-asl/files.
    const result = await connection.sendRequest("initialize", {
        processId: process.pid,
        rootUri: URI.file(FIXTURES).toString(),
        capabilities: {},
        initializationOptions: { lint: { rules: { "unused-declaration": "off" } } }
    });
    expect(result).toMatchObject({ capabilities: { hoverProvider: true }, serverInfo: { name: "Altitude ASL Language Server" } });
    await connection.sendNotification("initialized", {});
});

afterAll(() => {
    connection?.dispose();
    server?.kill();
});

describe("language server over stdio", () => {
    it("scans the workspace itself, so modules see their importers", async () => {
        // Orders.ags is not open: without the scan, Popups.agm would be an unreachable module.
        await open("Popups.agm");
        expect(await diagnosticsFor("Popups.agm", () => true)).toEqual([]);
    });

    it("pushes diagnostics with settings from initializationOptions", async () => {
        await open("Orders.ags");
        expect(await diagnosticsFor("Orders.ags", (codes) => codes.length > 0)).toEqual(["popup-then-goto"]);
    });

    it("applies settings from workspace/didChangeConfiguration", async () => {
        await connection.sendNotification("workspace/didChangeConfiguration", { settings: { altitudeScriptLanguage: { lint: { rules: { "popup-then-goto": "off" } } } } });
        expect(await diagnosticsFor("Orders.ags", (codes) => !codes.includes("popup-then-goto"))).toEqual(["unused-declaration"]);
    });
});
