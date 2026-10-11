import { describe, expect, it } from "vitest";
import { complete, signatureHelp } from "../../src/language/features/completion";
import { codeActions, format } from "../../src/language/features/edits";
import { definition, documentLinks, hover, references, rename } from "../../src/language/features/navigation";
import { documentSymbols, foldingRanges } from "../../src/language/features/outline";
import { semanticTokens } from "../../src/language/features/semanticTokens";
import type { Workspace } from "../../src/language/workspace";
import { fixtureProject, offsetOf, uri, workspaceOf } from "./helpers";

async function open(name = "Orders.ags", files = fixtureProject()): Promise<{ workspace: Workspace; text: string; file: NonNullable<ReturnType<Workspace["model"]>>; program: NonNullable<ReturnType<Workspace["program"]>> }> {
    const workspace = await workspaceOf(files);
    await workspace.prepare(uri(name));
    return { workspace, text: files[name], file: workspace.model(uri(name))!, program: workspace.program(uri(name))! };
}

const hoverText = (h: ReturnType<typeof hover>): string => (h && typeof h.contents === "object" && "value" in h.contents ? h.contents.value : "");

describe("hover", () => {
    it("documents built-in functions, attributes and actions", async () => {
        const { workspace, text, file, program } = await open();
        expect(hoverText(hover(workspace, file, program, offsetOf(text, "text_to_upper") + 2))).toContain("text_to_upper(Text: text): text");
        expect(hoverText(hover(workspace, file, program, offsetOf(text, "@login_info") + 3))).toContain("@login_info");
        expect(hoverText(hover(workspace, file, program, offsetOf(text, "sql execute") + 1))).toContain("docs.enghouseinteractive.com/altitude/8.7");
    });

    it("shows user declarations with their comment and origin", async () => {
        const { workspace, text, file, program } = await open();
        const constant = hoverText(hover(workspace, file, program, offsetOf(text, "MAX_RETRIES") + 1));
        expect(constant).toContain("const MAX_RETRIES := 3");
        expect(constant).toContain("How many times the agent may retry a call.");
        expect(hoverText(hover(workspace, file, program, offsetOf(text, "ShowError") + 1))).toContain("from `Popups.agm`");
    });
});

describe("navigation", () => {
    it("goes to definitions across modules, including node names in strings", async () => {
        const { workspace, text, file, program } = await open();
        expect(definition(workspace, file, program, offsetOf(text, "ShowError") + 1)[0].uri).toBe(uri("Popups.agm"));
        expect(definition(workspace, file, program, offsetOf(text, "Popups::QUESTION") + 10)[0]).toMatchObject({ uri: uri("Popups.agm") });
        expect(definition(workspace, file, program, offsetOf(text, "'DONE'") + 2)[0]).toMatchObject({ uri: uri("Orders.ags") });
        expect(definition(workspace, file, program, offsetOf(text, "Popups.agm") + 2)[0].uri).toBe(uri("Popups.agm"));
    });

    it("finds references and renames across files", async () => {
        const { workspace, text, file, program } = await open();
        const refs = references(workspace, file, program, offsetOf(text, "ShowInfo") + 1, true);
        expect(refs.map((r) => r.uri).sort()).toEqual([uri("Orders.ags"), uri("Popups.agm")]);
        const edit = rename(workspace, file, program, offsetOf(text, "vCustomer") + 1, "vClient");
        expect(Object.values(edit!.changes!).flat()).toHaveLength(3);
        expect(() => rename(workspace, file, program, offsetOf(text, "vCustomer") + 1, "not valid")).toThrow();
    });

    it("links imports to module files", async () => {
        const { workspace, file } = await open();
        expect(documentLinks(workspace, file).map((l) => l.target)).toContain(uri("Popups.agm"));
    });
});

describe("completion", () => {
    const labels = async (files: Record<string, string>, name: string, marker: string, delta = marker.length): Promise<string[]> => {
        const { workspace, text, file, program } = await open(name, files);
        return complete(workspace, file, program, offsetOf(text, marker) + delta).items.map((i) => i.label);
    };

    it("offers record fields after a dot", async () => {
        const files = fixtureProject();
        files["Orders.ags"] = files["Orders.ags"].replace("vOrder.code := text_to_upper(vOrder.code)", "vOrder.code := text_to_upper(vOrder.)");
        expect(await labels(files, "Orders.ags", "text_to_upper(vOrder.")).toEqual(expect.arrayContaining(["code", "quantity", "price"]));
    });

    it("offers module exports after a namespace and enum members after the type", async () => {
        const files = fixtureProject();
        files["Orders.ags"] = files["Orders.ags"].replace("call Popups::ShowInfo(", "call Popups::").replace("vState := OrderState::draft", "vState := OrderState::");
        expect(await labels(files, "Orders.ags", "call Popups::")).toEqual(expect.arrayContaining(["ShowError", "ShowInfo", "QUESTION"]));
        expect(await labels(files, "Orders.ags", "OrderState::")).toEqual(["draft", "confirmed", "cancelled"]);
    });

    it("offers actions at the start of a statement and node names inside goto strings", async () => {
        const files = fixtureProject();
        expect(await labels(files, "Orders.ags", "\t\tcall SaveOrder", 2)).toEqual(expect.arrayContaining(["if", "open window overlay", "sql select", "vAnswer"]));
        expect(await labels(files, "Orders.ags", "goto node 'DO", 11)).toEqual(expect.arrayContaining(["MAIN", "DONE", "Popups::QUESTION"]));
    });

    it("offers element clauses inside a graphical element and handlers inside a node", async () => {
        const files = fixtureProject();
        expect(await labels(files, "Orders.ags", "\t\ton lose focus commit {}", 2)).toEqual(expect.arrayContaining(["hidden if", "password", "on lose focus"]));
        expect(await labels(files, "Orders.ags", "\ton first enter {", 1)).toEqual(expect.arrayContaining(["on event phone connected", "push button", "variables"]));
    });
});

describe("signature help", () => {
    it("shows built-in and user routine parameters", async () => {
        const { workspace, text, file, program } = await open();
        const builtin = signatureHelp(workspace, file, program, offsetOf(text, "text_to_upper(") + 14);
        expect(builtin?.signatures[0].label).toBe("text_to_upper(Text: text): text");
        const user = signatureHelp(workspace, file, program, offsetOf(text, "LineTotal(vOrder") + 10);
        expect(user?.signatures[0].label).toBe("LineTotal(line: OrderLine): number");
    });
});

describe("formatting", () => {
    it("leaves well-formatted files unchanged", async () => {
        for (const name of ["Orders.ags", "Popups.agm", "Utils.gem"]) {
            const { file } = await open(name);
            expect(format(file, { tabSize: 4, insertSpaces: false })).toEqual([]);
        }
    });

    it("re-indents blocks and continuation lines without touching line endings", async () => {
        const text = 'node "A" {\r\non enter {\r\nif x then {\r\ny := 1\r\n}\r\nsql select \'SELECT 1\' into\r\nvariable z\r\n}\r\n}\r\n';
        const { file } = await open("A.ags", { "A.ags": text });
        const edits = format(file, { tabSize: 4, insertSpaces: false });
        const lines = text.split("\r\n");
        for (const edit of [...edits].reverse()) {
            const line = lines[edit.range.start.line];
            lines[edit.range.start.line] = line.slice(0, edit.range.start.character) + edit.newText + line.slice(edit.range.end.character);
        }
        expect(lines.join("\r\n")).toBe('node "A" {\r\n\ton enter {\r\n\t\tif x then {\r\n\t\t\ty := 1\r\n\t\t}\r\n\t\tsql select \'SELECT 1\' into\r\n\t\t\tvariable z\r\n\t}\r\n}\r\n');
    });
});

describe("outline and tokens", () => {
    it("lists nodes, routines and sections, and folds blocks", async () => {
        const { file } = await open();
        const names = documentSymbols(file).map((s) => s.name);
        expect(names).toEqual(expect.arrayContaining(["MAIN", "DONE", "SaveOrder", "LineTotal", "variables", "on start"]));
        expect(foldingRanges(file).length).toBeGreaterThan(10);
    });

    it("produces semantic tokens", async () => {
        const { file, program } = await open();
        const data = semanticTokens(file, program);
        expect(data.length % 5).toBe(0);
        expect(data.length).toBeGreaterThan(100);
    });
});

describe("code actions", () => {
    it("fixes renamed built-ins and offers suppressions", async () => {
        const text = 'version "8.7"\non start {\n\tx := rgbcolor(1, 2, 3)\n\tgoto node \'A\'\n}\nnode "A" {}\nvariables {\n\tx: RGBColor\n}\n';
        const { workspace, file } = await open("A.ags", { "A.ags": text });
        const diagnostic = workspace.diagnose(uri("A.ags")).find((d) => d.code === "deprecated")!;
        const range = { start: { line: 2, character: 6 }, end: { line: 2, character: 14 } };
        const actions = codeActions(file, uri("A.ags"), [{ range, message: diagnostic.message, code: diagnostic.code, data: diagnostic.data }]);
        expect(actions.map((a) => a.title)).toEqual(["Replace with 'rgb_color'", "Suppress 'deprecated' on this line", "Turn off 'deprecated' in settings"]);
    });
});
