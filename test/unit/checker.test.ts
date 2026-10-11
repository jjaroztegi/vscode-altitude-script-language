import { describe, expect, it } from "vitest";
import { codes, diagnose, fixtureProject, script } from "./helpers";

const POPUP_MODULE = `version "8.7"
subroutine Ask(question: text)
{
	open window 'QUESTION' size 390, 200 caption ' ' overlay arguments question
}
function AskNow(question: text): number
{
	open window 'QUESTION' size 390, 200 caption ' ' overlay arguments question, gAnswer
	AskNow := gAnswer
}
variables {
	gAnswer: number
}
node "QUESTION" {
	parameters {
		Question: text
		ref Answer: number
	}
	on enter {}
}
`;

describe("checker: references", () => {
    it("accepts the fixture project", async () => {
        expect(await codes(fixtureProject(), "Orders.ags")).toEqual(["popup-then-goto", "unused-declaration"]);
        expect(await codes(fixtureProject(), "Popups.agm")).toEqual([]);
    });

    it("reports undeclared names, types, fields and enum members", async () => {
        const text = script(
            "\ton enter {\n\t\tvTotal := vMissing + 1\n\t\tvRec.nope := 1\n\t\tvState := Colour::purple\n\t\tcall Nowhere()\n\t}",
            "types {\n\tColour: enumeration { red green }\n\tRec: record { a: text }\n}\nvariables {\n\tvTotal: number\n\tvRec: Rec\n\tvState: Colour\n\tvBad: Unknown\n}\n"
        );
        const diagnostics = await diagnose({ "A.ags": text }, "A.ags");
        expect(diagnostics.map((d) => [d.code, d.message])).toEqual(
            expect.arrayContaining([
                ["unresolved-name", "Cannot find 'vMissing'."],
                ["unresolved-member", "'nope' is not a field of Rec."],
                ["unresolved-name", "'purple' is not a member of Colour."],
                ["unresolved-name", "Cannot find subroutine 'Nowhere'."],
                ["unresolved-type", "Cannot find type 'Unknown'."]
            ])
        );
    });

    it("resolves names through namespaced and plain imports", async () => {
        const main = script("\ton event Go() {\n\t\tcall P::Ask('x')\n\t\tvName := JoinNames('a', 'b')\n\t\tcall P::Missing()\n\t}", 'modules {\n\timport <"Popups.agm"> into namespace P\n\timport <"Utils.gem">\n}\nvariables {\n\tvName: text\n}\n');
        const diagnostics = await diagnose({ "Main.ags": main, "Popups.agm": POPUP_MODULE, "Utils.gem": 'function JoinNames(a: text, b: text): text {\n\tJoinNames := a\n}\n' }, "Main.ags");
        expect(diagnostics.map((d) => d.message)).toEqual(["'Missing' is not declared in popups."]);
    });

    it("reports missing modules and wrong module kinds", async () => {
        const main = script("", 'modules {\n\timport <"Nope.agm"> into namespace N\n\timport <"Ivr.irm">\n}\n');
        expect(await codes({ "Main.ags": main, "Ivr.irm": "" }, "Main.ags")).toEqual(expect.arrayContaining(["missing-import", "module-kind"]));
    });

    it("checks argument counts of routines and built-ins", async () => {
        const text = script("\ton enter {\n\t\tcall Two(1)\n\t\tx := text_length('a', 'b')\n\t\tx := Two(1, 2)\n\t}", "variables {\n\tx: number\n}\nsubroutine Two(a: number, b: number) {}\n");
        expect(await codes({ "A.ags": text }, "A.ags")).toEqual(["argument-count", "argument-count", "invalid-call"]);
    });

    it("reports nodes, events, controls and images that do not exist", async () => {
        const text = script("\ton enter {\n\t\tgoto node 'NOWHERE'\n\t}\n\ton event Click() {\n\t\tset timer to 1 trigger event NeverHandled\n\t\tgraphical element 'missing' set focus\n\t}\n\tpush button {\n\t\tsize 10,10 at 0,0\n\t\timage 'NoImage' {}\n\t}");
        expect(await codes({ "A.ags": text }, "A.ags")).toEqual(expect.arrayContaining(["unresolved-node", "unresolved-event", "unresolved-control", "unresolved-image"]));
    });
});

describe("checker: declarations", () => {
    it("reports duplicates case-insensitively and shadowed globals", async () => {
        const text = script("\tvariables {\n\t\tvGlobal: text\n\t}\n\ton enter { vGlobal := 'x' }", "variables {\n\tvGlobal: text\n\tvDup: text\n\tvdup: number\n}\n");
        expect(await codes({ "A.ags": text }, "A.ags", { rules: { "unused-declaration": "off" } })).toEqual(["duplicate-declaration", "shadowed-declaration"]);
    });

    it("reports unreachable actions after node navigation", async () => {
        const text = script("\ton enter {\n\t\tgoto node 'MAIN'\n\t\tx := 1\n\t}", "variables {\n\tx: number\n}\n");
        const diagnostics = await diagnose({ "A.ags": text }, "A.ags");
        expect(diagnostics.find((d) => d.code === "unreachable-code")?.tags).toEqual(["unnecessary"]);
    });

    it("reports navigation in on exit and a missing on start", async () => {
        const text = 'version "8.7"\nnode "MAIN" {\n\ton exit {\n\t\tgoto node \'MAIN\'\n\t}\n}\n';
        expect(await codes({ "A.ags": text }, "A.ags")).toEqual(["navigation-in-exit", "script-start"]);
    });

    it("reports nodes in generic modules", async () => {
        expect(await codes({ "U.gem": 'node "X" {}\n' }, "U.gem")).toEqual(["module-kind", "unreachable-module"]);
    });

    it("reports undocumented events", async () => {
        const text = script("\ton event phone conected {}\n\tpush button {\n\t\tsize 10,10 at 0,0\n\t\ton lose focus {}\n\t}");
        expect(await codes({ "A.ags": text }, "A.ags")).toEqual(["unknown-event", "unknown-event"]);
    });
});

describe("checker: Agent Portal (ASL Web Edition)", () => {
    it("reports modal windows, function keys and legacy built-ins", async () => {
        const text = script("\tfunction key 5 {}\n\ton enter {\n\t\topen modal window 'MAIN'\n\t\tvColour := rgbcolor(1, 2, 3)\n\t}", "variables {\n\tvColour: RGBColor\n}\n");
        const diagnostics = await diagnose({ "A.ags": text }, "A.ags");
        expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([
            ["web-unsupported", "warning"],
            ["web-unsupported", "error"],
            ["deprecated", "hint"]
        ]);
        expect(await codes({ "A.ags": text }, "A.ags", { webEdition: false })).toEqual(["deprecated"]);
    });

    it("lists the remaining rules in a stable order", async () => {
        expect(await codes({ "U.gem": 'node "X" {}\n' }, "U.gem")).toEqual(["module-kind", "unreachable-module"]);
    });

    it("flags native DLL dependencies", async () => {
        expect(await codes({ "A.ags": script("", 'dependencies {\n\tdll native "Legacy" in file <"legacy.dll">\n}\n') }, "A.ags")).toEqual(["native-dll"]);
    });
});

describe("checker: asynchronous popups", () => {
    const quiet = { rules: { "unused-declaration": "off" as const } };
    const files = (body: string, extra = "") => ({ "Main.ags": script(body, `modules {\n\timport <"Popups.agm">\n}\nvariables {\n\tvAnswer: number\n}\n${extra}`), "Popups.agm": POPUP_MODULE });

    it("reports navigation and a second popup after an overlay", async () => {
        const body = "\ton event E() {\n\t\topen window 'QUESTION' size 390, 200 overlay on close trigger event E arguments 'x', vAnswer\n\t\topen window 'QUESTION' size 390, 200 overlay\n\t\tgoto node 'MAIN'\n\t}";
        expect(await codes(files(body), "Main.ags", quiet)).toEqual(["popup-then-goto", "popup-then-popup"]);
    });

    it("treats then/else branches as separate paths", async () => {
        const body = "\ton event E() {\n\t\tif vAnswer = 1 then {\n\t\t\tcall Ask('x')\n\t\t}\n\t\telse {\n\t\t\tgoto node 'MAIN'\n\t\t}\n\t}";
        expect(await codes(files(body), "Main.ags", quiet)).toEqual([]);
    });

    it("reports reading the overlay answer right after opening it", async () => {
        const body = "\ton event E() {\n\t\topen window 'QUESTION' size 390, 200 overlay on close trigger event E arguments 'Sure?', vAnswer\n\t\tif vAnswer = 1 then {}\n\t}";
        expect(await codes(files(body), "Main.ags", quiet)).toEqual(["overlay-result-read"]);
    });

    it("reports popups opened directly in on enter unless deferred with a timer", async () => {
        expect(await codes(files("\ton enter {\n\t\tcall Ask('x')\n\t}"), "Main.ags", quiet)).toEqual(["overlay-in-enter"]);
        expect(await codes(files("\ton enter {\n\t\tset timer to 1 trigger event Open\n\t}\n\ton event Open() {\n\t\tcall Ask('x')\n\t}"), "Main.ags", quiet)).toEqual([]);
    });

    it("reports using the value of a function that opens a popup", async () => {
        expect(await codes(files("\ton event E() {\n\t\tvAnswer := AskNow('x')\n\t}"), "Main.ags", quiet)).toEqual(["async-function-result"]);
    });

    it("reports overlay positions and offers to remove them", async () => {
        const diagnostics = await diagnose(files("\ton event E() {\n\t\topen window 'QUESTION' at 700, 300 size 390, 200 overlay\n\t}"), "Main.ags", quiet);
        expect(diagnostics[0]).toMatchObject({ code: "overlay-position", data: { fix: "remove-range" } });
    });

    it("reports email editor fields set twice in one block", async () => {
        const body = "\ton enter {\n\t\temail editor 'mail' set html body field to 'a'\n\t\temail editor 'mail' set html body field to 'b'\n\t}\n\temail editor \"mail\" {\n\t\tsize 100,100 at 0,0\n\t}";
        expect(await codes(files(body), "Main.ags", quiet)).toEqual(["email-async"]);
    });

    it("reports buttons without actions over master buttons", async () => {
        const text = 'version "8.7"\non start { goto node \'CHILD\' }\nnode "BASE" {\n\tpush button {\n\t\tsize 80,25 at 10,10\n\t\ton click commit { goto node \'OTHER\' }\n\t}\n}\nnode "OTHER" { master "BASE" }\nnode "CHILD" {\n\tmaster "BASE"\n\tpush button {\n\t\tsize 80,25 at 10,10\n\t\ton click commit {}\n\t}\n}\n';
        expect(await codes({ "A.ags": text }, "A.ags")).toEqual(["button-shadows-master"]);
    });
});

describe("checker: configuration", () => {
    it("applies severity overrides and turns rules off", async () => {
        const text = script("\ton enter {\n\t\tgoto node 'MAIN'\n\t\tx := 1\n\t}", "variables {\n\tx: number\n}\n");
        expect((await diagnose({ "A.ags": text }, "A.ags", { rules: { "unreachable-code": "error" } }))[0].severity).toBe("error");
        expect(await codes({ "A.ags": text }, "A.ags", { rules: { "unreachable-code": "off" } })).toEqual([]);
    });

    it("honours suppression comments", async () => {
        const text = script("\ton enter {\n\t\tgoto node 'MAIN'\n\t\tcomment {asl-disable-next-line unreachable-code}\n\t\tx := 1\n\t}", "variables {\n\tx: number\n}\n");
        expect(await codes({ "A.ags": text }, "A.ags")).toEqual([]);
        const fileWide = `comment {asl-disable unused-declaration}\n${script("", "variables {\n\tunused: number\n}\n")}`;
        expect(await codes({ "A.ags": fileWide }, "A.ags")).toEqual([]);
    });
});
