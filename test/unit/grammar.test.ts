import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as oniguruma from "vscode-oniguruma";
import { INITIAL, Registry, type IGrammar } from "vscode-textmate";

let grammar: IGrammar;

beforeAll(async () => {
    const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
    await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    const registry = new Registry({
        onigLib: Promise.resolve({ createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns), createOnigString: (s) => new oniguruma.OnigString(s) }),
        loadGrammar: async (scopeName) => {
            if (scopeName !== "source.altitude-asl") return null;
            const file = path.join(__dirname, "..", "..", "syntaxes", "asl.tmLanguage.json");
            return JSON.parse(fs.readFileSync(file, "utf8"));
        }
    });
    grammar = (await registry.loadGrammar("source.altitude-asl"))!;
});

/** Scopes of each token on a line, as `text => last scope`. */
function scopes(line: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const token of grammar.tokenizeLine(line, INITIAL).tokens) {
        const text = line.slice(token.startIndex, token.endIndex).trim();
        if (text) result[text] = token.scopes[token.scopes.length - 1];
    }
    return result;
}

describe("TextMate grammar", () => {
    it("tokenizes the whole fixture without errors", () => {
        let state = INITIAL;
        for (const line of fs.readFileSync(path.join(__dirname, "..", "fixtures", "project", "Orders.ags"), "utf8").split(/\r?\n/)) {
            state = grammar.tokenizeLine(line, state).ruleStack;
        }
        expect(state).toBeDefined();
    });

    it("colours declarations, actions, strings and interpolations", () => {
        expect(scopes('node "MAIN" {')).toMatchObject({ node: "storage.type.node.altitude-asl", '"MAIN"': "entity.name.type.node.altitude-asl" });
        expect(scopes("open window 'POPUP' overlay")).toMatchObject({ "open window": "keyword.other.action.altitude-asl", overlay: "keyword.other.modifier.altitude-asl" });
        const fib = scopes("message 'Hi $(vName)'");
        expect(fib.vName).toBe("source.altitude-asl.embedded");
        expect(scopes("x := text_length(@login_info.name)")).toMatchObject({ text_length: "support.function.builtin.altitude-asl", "@login_info": "variable.language.attribute.altitude-asl" });
        expect(scopes("comment { a {b} c }")["c"]).toMatch(/^comment\.block/);
        expect(scopes("y := PhoneState::connected").PhoneState).toBe("support.class.enum.altitude-asl");
    });
});
