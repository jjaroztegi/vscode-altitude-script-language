/// <reference types="mocha" />
import * as assert from "node:assert";
import * as vscode from "vscode";

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 30000): Promise<T> {
    const started = Date.now();
    for (;;) {
        const value = await probe();
        if (value !== undefined) return value;
        if (Date.now() - started > timeoutMs) throw new Error("timed out");
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

suite("Altitude ASL extension", () => {
    let document: vscode.TextDocument;

    suiteSetup(async () => {
        const [uri] = await vscode.workspace.findFiles("Orders.ags");
        document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
    });

    test("activates for .ags files", () => {
        assert.strictEqual(document.languageId, "altitude-asl");
    });

    test("reports diagnostics from the language server", async () => {
        const code = (d: vscode.Diagnostic): unknown => (typeof d.code === "object" ? d.code.value : d.code);
        const diagnostics = await waitFor(() => {
            const list = vscode.languages.getDiagnostics(document.uri).filter((d) => d.source === "asl");
            return list.some((d) => code(d) === "popup-then-goto") ? list : undefined;
        });
        // The fixtures are saved as Script Developer does, so the encoding check stays quiet.
        assert.ok(!diagnostics.some((d) => code(d) === "encoding"), JSON.stringify(diagnostics.map((d) => d.message)));
    });

    test("resolves definitions across modules", async () => {
        const offset = document.getText().indexOf("ShowError") + 2;
        const locations = await waitFor(async () => {
            const result = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeDefinitionProvider", document.uri, document.positionAt(offset));
            return result?.length ? result : undefined;
        });
        assert.ok(locations[0].uri.path.endsWith("Popups.agm"));
    });

    test("completes built-in functions", async () => {
        const offset = document.getText().indexOf("text_to_upper(") + 4;
        const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", document.uri, document.positionAt(offset));
        assert.ok(list.items.some((item) => (typeof item.label === "string" ? item.label : item.label.label) === "text_to_upper"));
    });

    test("formats without changing a well-formatted file", async () => {
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>("vscode.executeFormatDocumentProvider", document.uri, { tabSize: 4, insertSpaces: false });
        assert.strictEqual(edits?.length ?? 0, 0);
    });
});
