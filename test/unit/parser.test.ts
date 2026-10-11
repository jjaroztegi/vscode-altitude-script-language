import { describe, expect, it } from "vitest";
import type { ActionStmt, ControlDecl, HandlerDecl, NodeDecl, Stmt } from "../../src/language/ast";
import { ACTIONS } from "../../src/language/catalog";
import { parse } from "../../src/language/parser";
import { fixture, script } from "./helpers";

function statements(body: string): Stmt[] {
    const source = parse(`on start {\n${body}\n}`);
    expect(source.diagnostics).toEqual([]);
    return (source.decls[0] as HandlerDecl).body.statements;
}

describe("parser", () => {
    it("parses the fixture project without diagnostics", () => {
        for (const name of ["Orders.ags", "Popups.agm", "Utils.gem"]) {
            expect(parse(fixture(name), name.endsWith(".ags") ? "ags" : name.endsWith(".agm") ? "agm" : "gem").diagnostics).toEqual([]);
        }
    });

    it("recognises actions by their keywords, in any clause order", () => {
        const [open, sql, fetch] = statements(
            [
                "open window 'POPUP' size 390, 200 caption 'Hi' overlay on close trigger event Closed arguments 'x', vAnswer",
                "sql select 'SELECT name FROM t WHERE id = $(vId)' into",
                "\tvariable vName",
                "fetch cursor c into ?, variable vA, record vRow match by name"
            ].join("\n")
        ) as ActionStmt[];
        expect(ACTIONS[open.action].name).toBe("open window");
        expect(open.slots.find((s) => s.after === "event")?.expr).toMatchObject({ kind: "name", name: { text: "Closed" } });
        expect(ACTIONS[sql.action].name).toBe("sql select");
        expect(sql.slots.map((s) => s.cls)).toEqual(["expr", "var"]);
        expect(ACTIONS[fetch.action].name).toBe("fetch cursor");
        expect(fetch.slots).toHaveLength(3);
    });

    it("does not let an optional clause swallow the next statement", () => {
        const stmts = statements("fetch cursor c into record r\nif x then {}\nclose cursor c");
        expect(stmts.map((s) => s.kind)).toEqual(["action", "if", "action"]);
    });

    it("accepts variables named like keywords", () => {
        const stmts = statements("sql execute Sql\nMessage := 'x'\nmessage Message");
        expect(stmts.map((s) => s.kind)).toEqual(["action", "assign", "action"]);
    });

    it("parses control flow", () => {
        const stmts = statements(
            ["if a = 1 and not b then { x := 1 } else if c then { x := 2 } else { x := 3 }", "case x {", "\twhen 1 do {}", "\tdefault {}", "}", "for i := 1 to 10 step 2 do {}", "while i > 0 do { i := i - 1 }", "repeat { i := i + 1 } until i > 5", "var t: text(10) := 'a' 'b'", "goto node 'NEXT' arguments 1, 'two'", "call Sub(1, ref x)"].join("\n")
        );
        expect(stmts.map((s) => s.kind)).toEqual(["if", "case", "for", "while", "repeat", "var", "goto", "call"]);
    });

    it("parses graphical elements and their clauses", () => {
        const source = parse(script("\tpush button \"ok\" {\n\t\tsize 80,25 at 10,10\n\t\tlabel \"OK\" { font { name \"Arial\" bold } align center }\n\t\ton click commit { x := 1 }\n\t}\n\tcombo box for vChoice {\n\t\tsize 100,24 at 10,40\n\t\titems \"A\" label \"Option A\", \"B\" label \"Option B\"\n\t\tdrop on demand\n\t}"));
        expect(source.diagnostics).toEqual([]);
        const node = source.decls.find((d) => d.kind === "node") as NodeDecl;
        const button = node.members.find((m) => m.kind === "control") as ControlDecl;
        expect(button.control).toBe("push button");
        expect(button.size).toEqual({ width: 80, height: 25, x: 10, y: 10 });
        expect(button.handlers[0].modifier).toBe("commit");
    });

    it("parses handler parameters written on the following lines", () => {
        const source = parse(script("\ton error phone extend\n\t(\n\t\terr: PhoneError,\n\t\tuser_name: text,\n\t\tnum: text\n\t)\n\t{\n\t}"));
        expect(source.diagnostics).toEqual([]);
        const handler = (source.decls.find((d) => d.kind === "node") as NodeDecl).members.find((m) => m.kind === "handler") as HandlerDecl;
        expect(handler.event).toBe("error phone extend");
        expect(handler.params.map((p) => p.name.text)).toEqual(["err", "user_name", "num"]);
    });

    it("parses external DLL routines", () => {
        const source = parse('external stdcall function OrdSuffix(nbr: number as int, ref suffix: text as char*): number as int\nin "ScriptDLL" named "_ordinalSuffix@8" compiler "VisualC"', "gem");
        expect(source.diagnostics).toEqual([]);
        expect(source.decls[0]).toMatchObject({ kind: "routine", routine: "function", external: { convention: "stdcall" } });
    });

    it("reports unknown actions and malformed statements", () => {
        const source = parse("on start {\n\tsett timer to 1\n\tif x {\n\t}\n}");
        const messages = source.diagnostics.map((d) => d.message);
        expect(messages).toContain("Unknown action 'sett'.");
        expect(messages.some((m) => m.includes("'then'"))).toBe(true);
    });

    it("recovers from an unclosed brace", () => {
        const source = parse('node "A" {\n\ton enter {\n\t\tx := 1\n}\nnode "B" {}');
        expect(source.diagnostics.some((d) => d.message.includes("to close node"))).toBe(true);
    });
});
