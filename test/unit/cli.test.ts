import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const FIXTURES = path.join(__dirname, "..", "fixtures", "project");
let bundle: string;
let project: string;

/** Runs the bundled CLI in the temporary copy of the fixture project. */
function run(...args: string[]): { code: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [bundle, ...args], { cwd: project, encoding: "utf8" });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const json = (...args: string[]) => JSON.parse(run("--format", "json", ...args).stdout) as { file: string; line: number; severity: string; rule: string; new?: boolean }[];

beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asl-check-"));
    bundle = path.join(dir, "asl-check.js");
    await build({ entryPoints: [path.join(__dirname, "..", "..", "src", "cli", "check.ts")], outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "warning" });
});

beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "asl-project-"));
    fs.cpSync(FIXTURES, project, { recursive: true });
});

describe("asl-check", () => {
    it("prints sorted text findings and a summary", () => {
        const { code, stdout } = run();
        expect(code).toBe(0);
        const lines = stdout.trim().split("\n");
        expect(lines[0]).toMatch(/^Orders\.ags:17:2 hint unused-declaration Constant 'MAX_RETRIES' is never used\.$/);
        expect(lines[1]).toMatch(/^Orders\.ags:111:4 info popup-then-goto /);
        expect(lines[2]).toBe("3 file(s) checked, 2 problem(s) (1 info, 1 hint)");
    });

    it("prints stable JSON for the given paths only, with modules elsewhere resolved", () => {
        fs.mkdirSync(path.join(project, "sub"));
        fs.renameSync(path.join(project, "Popups.agm"), path.join(project, "sub", "Popups.agm"));
        fs.writeFileSync(path.join(project, "Orders.ags"), fs.readFileSync(path.join(project, "Orders.ags"), "utf8").replace('<"Popups.agm">', '<"sub\\Popups.agm">'));
        // Popups.agm is imported by Orders.ags, which is loaded but not reported, so it is not an unreachable module.
        expect(json("sub")).toEqual([]);
        const rows = json("Orders.ags");
        expect(rows.map((r) => r.rule)).toEqual(["unused-declaration", "popup-then-goto"]);
        expect(Object.keys(rows[0])).toEqual(["file", "line", "column", "endLine", "endColumn", "severity", "rule", "message"]);
        expect(rows[0]).toMatchObject({ file: "Orders.ags", line: 17, column: 2, endLine: 17, endColumn: 13, severity: "hint" });
    });

    it("applies --rule overrides and .asl-check.json", () => {
        expect(run("--rule", "popup-then-goto=error").code).toBe(1);
        expect(json("--rule", "popup-then-goto=off").map((r) => r.rule)).toEqual(["unused-declaration"]);
        fs.writeFileSync(path.join(project, ".asl-check.json"), JSON.stringify({ rules: { "unused-declaration": "off", "popup-then-goto": "warning" } }));
        expect(json().map((r) => [r.rule, r.severity])).toEqual([["popup-then-goto", "warning"]]);
        expect(json("--rule", "popup-then-goto=hint").map((r) => r.severity)).toEqual(["hint"]);
    });

    it("uses exit codes 0, 1 and 2", () => {
        expect(run("--fail-on", "info").code).toBe(1);
        expect(run("--fail-on", "warning").code).toBe(0);
        expect(run("--fail-on", "fatal").code).toBe(2);
        expect(run("--format", "xml").code).toBe(2);
        expect(run("--rule", "popup-then-goto=loud").code).toBe(2);
        expect(run("--unknown").code).toBe(2);
        expect(run("missing-folder").code).toBe(2);
    });

    it("round-trips a baseline that ignores line moves", () => {
        expect(run("--write-baseline", "baseline.json", "--fail-on", "hint").code).toBe(0);
        const keys = JSON.parse(fs.readFileSync(path.join(project, "baseline.json"), "utf8")) as string[];
        expect(keys).toEqual([...keys].sort());
        expect(keys).toHaveLength(2);
        expect(keys[0]).toMatch(/^orders\.ags\|popup-then-goto\|.*\|0$/);

        expect(run("--baseline", "baseline.json", "--fail-on", "hint")).toMatchObject({ code: 0, stdout: "3 file(s) checked, 2 problem(s) (1 info, 1 hint); 0 new, 2 known\n" });

        // Move every finding down and add a new unused constant.
        const orders = path.join(project, "Orders.ags");
        fs.writeFileSync(orders, fs.readFileSync(orders, "utf8").replace("constants {\r\n", "constants {\r\n\tUNUSED_TOO := 1\r\n\r\n\r\n"));
        const result = run("--baseline", "baseline.json", "--fail-on", "hint");
        expect(result.code).toBe(1);
        expect(result.stdout).toMatch(/^Orders\.ags:17:2 hint unused-declaration Constant 'UNUSED_TOO' is never used\.\n.*; 1 new, 2 known\n$/);
        expect(json("--baseline", "baseline.json").map((r) => [r.line, r.new])).toEqual([
            [17, true],
            [20, false],
            [114, false]
        ]);
        expect(run("--baseline", "baseline.json", "--fail-on", "info").code).toBe(0);
    });

    it("reports and fixes file encodings", () => {
        const utils = path.join(project, "Utils.gem");
        const original = fs.readFileSync(utils);
        fs.writeFileSync(utils, original.subarray(3).toString("utf8").replace(/\r\n/g, "\n"));
        const [finding] = json("Utils.gem");
        expect(finding).toMatchObject({ rule: "encoding", severity: "warning", line: 1 });
        expect((finding as unknown as { message: string }).message).toBe("This file is not UTF-8 with BOM and uses LF line endings. Script Developer saves ASL files as UTF-8 with BOM and CRLF.");
        expect(json("Utils.gem", "--no-encoding")).toEqual([]);
        expect(run("--fail-on", "warning", "Utils.gem").code).toBe(1);

        expect(run("--fix-encoding", "--fail-on", "warning", "Utils.gem").code).toBe(0);
        expect(fs.readFileSync(utils).equals(original)).toBe(true);
    });

    it("writes SARIF", () => {
        const log = JSON.parse(run("--format", "sarif").stdout);
        expect(log.version).toBe("2.1.0");
        expect(log.runs[0].results.map((r: { ruleId: string; level: string }) => [r.ruleId, r.level])).toEqual([
            ["unused-declaration", "note"],
            ["popup-then-goto", "note"]
        ]);
    });
});
