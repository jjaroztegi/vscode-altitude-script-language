#!/usr/bin/env node
/**
 * Command-line checker for CI and AI agents: the language server's analysis over files and folders.
 * Bundled into a single dependency-free file, dist/cli/asl-check.js. Run it with --help for usage.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { URI } from "vscode-uri";
import { RULES, type Severity } from "../language/checker";
import { normalizeBytes } from "../language/encoding";
import { LineMap } from "../language/lexer";
import { Workspace, type Settings } from "../language/workspace";
import { decodeText, findAslFiles } from "../node/files";

const USAGE = `Usage: asl-check [paths...] [options]

Checks the Altitude ASL files (.ags .agm .gem .irs .irm) under the given files and folders (default: the current folder).
Modules elsewhere under the project root (the folder of .asl-check.json, or the current folder) are loaded so imports resolve.

Options:
  --format text|json|sarif  Output format (default: text).
  --rule <id>=<severity>    Rule severity: off, hint, info, warning or error. Repeatable.
  --config <file>           Config file (default: the nearest .asl-check.json from the current folder up).
  --no-web-edition          Do not report constructs that ASL Web Edition does not support.
  --fail-on <severity>      Exit with 1 when a finding has this severity or higher (default: error).
  --baseline <file>         Only findings missing from this baseline are new and count toward --fail-on.
  --write-baseline <file>   Write every current finding to a baseline file, and exit with 0.
  --no-encoding             Do not report files that are not UTF-8 with BOM and CRLF (rule "encoding").
  --fix-encoding            Rewrite the checked files as UTF-8 with BOM and CRLF first.
  --quiet                   Only print the findings that count toward --fail-on, without a summary.
  -h, --help                Show this help.

Exit codes: 0 no failing findings, 1 failing findings, 2 usage error.`;

const RULES_DOC = "https://github.com/jjaroztegi/vscode-altitude-script-language/blob/main/docs/rules.md";
const SEVERITIES: Severity[] = ["hint", "info", "warning", "error"];
const ENCODING_RULE = { id: "encoding", severity: "warning" as Severity, description: "A file that is not UTF-8 with BOM, or uses LF or CR line endings." };
const RULE_INFO = new Map([...RULES, ENCODING_RULE].map((r) => [r.id, r]));

class UsageError extends Error {}

interface Config {
    webEdition?: boolean;
    rules?: Settings["rules"];
}

interface Finding {
    file: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    severity: Severity;
    rule: string;
    message: string;
    new?: boolean;
}

const warn = (message: string): void => void process.stderr.write(`asl-check: ${message}\n`);
const slash = (file: string): string => file.split(path.sep).join("/");
const isInside = (file: string, folder: string): boolean => {
    const relative = path.relative(folder, file);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

function checkRule(id: string, severity: unknown, where: string): void {
    if (severity !== "off" && !SEVERITIES.includes(severity as Severity)) {
        throw new UsageError(`${where}: invalid severity '${String(severity)}' for rule '${id}' (use off, hint, info, warning or error)`);
    }
    if (!RULE_INFO.has(id)) warn(`${where}: unknown rule '${id}'`);
}

function findConfig(dir: string): string | undefined {
    for (let current = dir; ; current = path.dirname(current)) {
        const candidate = path.join(current, ".asl-check.json");
        if (existsSync(candidate)) return candidate;
        if (path.dirname(current) === current) return undefined;
    }
}

function readJson(file: string, what: string): unknown {
    try {
        return JSON.parse(decodeText(readFileSync(file)));
    } catch (error) {
        throw new UsageError(`cannot read ${what} ${file}: ${(error as Error).message}`);
    }
}

function readConfig(file: string): Config {
    const value = readJson(file, "config");
    const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
    if (!isObject(value)) throw new UsageError(`${file}: expected a JSON object`);
    const { webEdition, rules } = value;
    if (webEdition !== undefined && typeof webEdition !== "boolean") throw new UsageError(`${file}: "webEdition" must be true or false`);
    if (rules !== undefined && !isObject(rules)) throw new UsageError(`${file}: "rules" must be an object of rule id to severity`);
    for (const [id, severity] of Object.entries(rules ?? {})) checkRule(id, severity, file);
    return { webEdition, rules: rules as Settings["rules"] };
}

/** Why the bytes are not what Script Developer writes (UTF-8 with BOM, CRLF), or undefined when they are. */
function encodingProblem(bytes: Uint8Array): string | undefined {
    const problems: string[] = [];
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) problems.push("is not UTF-8 with BOM");
    } catch {
        problems.push("is not valid UTF-8");
    }
    let lf = false;
    let cr = false;
    for (let i = 0; i < bytes.length; i += 1) {
        if (bytes[i] === 10 && bytes[i - 1] !== 13) lf = true;
        else if (bytes[i] === 13 && bytes[i + 1] !== 10) cr = true;
    }
    if (lf) problems.push("uses LF line endings");
    if (cr) problems.push("uses CR line endings");
    if (problems.length === 0) return undefined;
    return `This file ${problems.join(", ").replace(/, ([^,]*)$/, " and $1")}. Script Developer saves ASL files as UTF-8 with BOM and CRLF.`;
}

/**
 * Baseline keys that survive edits elsewhere in the file: path relative to the baseline's folder, rule,
 * normalised message (whitespace, case, and the "line N" some messages cite) and the occurrence index among
 * identical ones (findings must be sorted by position).
 */
function fingerprints(findings: Finding[], baselineFile: string): string[] {
    const base = path.dirname(path.resolve(baselineFile));
    const seen = new Map<string, number>();
    return findings.map((f) => {
        const file = slash(path.relative(base, path.resolve(f.file))).toLowerCase();
        const key = `${file}|${f.rule}|${f.message.replace(/\s+/g, " ").replace(/\bline \d+/gi, "line #").trim().toLowerCase()}`;
        const index = seen.get(key) ?? 0;
        seen.set(key, index + 1);
        return `${key}|${index}`;
    });
}

function sarif(findings: Finding[], withBaseline: boolean): unknown {
    const ids = [...new Set(findings.map((f) => f.rule))].sort();
    return {
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.1.0",
        runs: [
            {
                tool: {
                    driver: {
                        name: "asl-check",
                        informationUri: "https://github.com/jjaroztegi/vscode-altitude-script-language",
                        rules: ids.map((id) => ({ id, helpUri: `${RULES_DOC}#${id}`, shortDescription: { text: RULE_INFO.get(id)?.description ?? id } }))
                    }
                },
                results: findings.map((f) => ({
                    ruleId: f.rule,
                    level: f.severity === "error" || f.severity === "warning" ? f.severity : "note",
                    message: { text: f.message },
                    locations: [{ physicalLocation: { artifactLocation: { uri: encodeURI(f.file) }, region: { startLine: f.line, startColumn: f.column, endLine: f.endLine, endColumn: f.endColumn } } }],
                    ...(withBaseline ? { baselineState: f.new ? "new" : "unchanged" } : {})
                }))
            }
        ]
    };
}

async function main(argv: string[]): Promise<number> {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                format: { type: "string", default: "text" },
                rule: { type: "string", multiple: true, default: [] },
                config: { type: "string" },
                "no-web-edition": { type: "boolean", default: false },
                "fail-on": { type: "string", default: "error" },
                baseline: { type: "string" },
                "write-baseline": { type: "string" },
                encoding: { type: "boolean", default: true },
                "no-encoding": { type: "boolean", default: false },
                "fix-encoding": { type: "boolean", default: false },
                quiet: { type: "boolean", default: false },
                help: { type: "boolean", short: "h", default: false }
            }
        });
    } catch (error) {
        throw new UsageError((error as Error).message);
    }
    const { values: options, positionals } = parsed;
    if (options.help) {
        process.stdout.write(`${USAGE}\n`);
        return 0;
    }
    const format = options.format;
    if (format !== "text" && format !== "json" && format !== "sarif") throw new UsageError(`invalid --format '${format}' (use text, json or sarif)`);
    const failOn = SEVERITIES.indexOf(options["fail-on"] as Severity);
    if (failOn < 0) throw new UsageError(`invalid --fail-on '${options["fail-on"]}' (use error, warning, info or hint)`);

    const cwd = process.cwd();
    const discovered = options.config ? undefined : findConfig(cwd);
    const configFile = options.config ?? discovered;
    if (options.config && !existsSync(options.config)) throw new UsageError(`no such config file: ${options.config}`);
    const config = configFile ? readConfig(configFile) : {};
    const rules: NonNullable<Settings["rules"]> = { ...config.rules };
    for (const item of options.rule) {
        const [id, severity] = item.split("=");
        if (!id || !severity) throw new UsageError(`invalid --rule '${item}' (use --rule <id>=<severity>)`);
        checkRule(id, severity, "--rule");
        rules[id] = severity as Severity | "off";
    }
    const settings: Settings = { webEdition: options["no-web-edition"] ? false : (config.webEdition ?? true), rules };
    const reportEncoding = options.encoding && !options["no-encoding"] && rules.encoding !== "off";

    let known: Set<string> | undefined;
    if (options.baseline) {
        const value = readJson(options.baseline, "baseline");
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new UsageError(`${options.baseline}: expected a JSON array of strings`);
        known = new Set(value as string[]);
    }

    // Files: everything under the project root (and under paths outside it) is loaded; only the given paths are reported.
    const targets = (positionals.length > 0 ? positionals : ["."]).map((p) => {
        if (!existsSync(p)) throw new UsageError(`no such file or folder: ${p}`);
        return path.resolve(p);
    });
    const root = discovered ? path.dirname(discovered) : cwd;
    const roots = [root, ...targets.filter((t) => !isInside(t, root)).map((t) => (statSync(t).isDirectory() ? t : path.dirname(t)))];
    const files = new Map<string, string>();
    for (const folder of roots) for (const file of findAslFiles(folder)) files.set(file.toLowerCase(), file);
    for (const target of targets) if (!statSync(target).isDirectory()) files.set(target.toLowerCase(), target);
    const checked = [...files.values()].filter((file) => targets.some((target) => isInside(file, target))).sort();

    if (options["fix-encoding"]) {
        let fixed = 0;
        for (const file of checked) {
            const bytes = normalizeBytes(readFileSync(file));
            if (bytes) {
                writeFileSync(file, bytes);
                fixed += 1;
            }
        }
        if (fixed > 0 && !options.quiet) warn(`converted ${fixed} file(s) to UTF-8 with BOM and CRLF`);
    }

    const workspace = new Workspace({
        readFile: async (uri) => {
            try {
                return decodeText(readFileSync(URI.parse(uri).fsPath));
            } catch {
                return undefined;
            }
        },
        settings: () => settings
    });
    const contents = new Map<string, { bytes: Uint8Array; text: string }>();
    for (const file of files.values()) {
        try {
            const bytes = readFileSync(file);
            const text = decodeText(bytes);
            contents.set(file, { bytes, text });
            workspace.setDiskFile(URI.file(file).toString(), text);
        } catch (error) {
            warn(`cannot read ${file}: ${(error as Error).message}`);
        }
    }

    const findings: Finding[] = [];
    for (const file of checked) {
        const content = contents.get(file);
        if (!content) continue;
        const lines = new LineMap(content.text);
        const relative = slash(path.relative(cwd, file));
        const add = (start: number, end: number, severity: Severity, rule: string, message: string): void => {
            const from = lines.positionAt(start);
            const to = lines.positionAt(end);
            findings.push({ file: relative, line: from.line + 1, column: from.character + 1, endLine: to.line + 1, endColumn: to.character + 1, severity, rule, message });
        };
        const problem = reportEncoding ? encodingProblem(content.bytes) : undefined;
        if (problem) add(0, Math.min(lines.lineText(0).length, 40), (rules.encoding as Severity | undefined) ?? ENCODING_RULE.severity, ENCODING_RULE.id, problem);
        const uri = URI.file(file).toString();
        await workspace.prepare(uri);
        for (const d of workspace.diagnose(uri)) add(d.start, d.end, d.severity, d.code, d.message);
    }
    const compare = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);
    findings.sort((a, b) => compare(a.file, b.file) || a.line - b.line || a.column - b.column || compare(a.rule, b.rule) || compare(a.message, b.message));

    if (known && options.baseline) {
        const keys = fingerprints(findings, options.baseline);
        findings.forEach((f, i) => (f.new = !known.has(keys[i])));
    }
    const failing = findings.filter((f) => f.new !== false && SEVERITIES.indexOf(f.severity) >= failOn);

    // Text output lists only new findings when there is a baseline; JSON and SARIF list all, flagged.
    const shown = options.quiet ? failing : format === "text" ? findings.filter((f) => f.new !== false) : findings;
    if (format === "json") {
        const rows = shown.map((f) => ({ file: f.file, line: f.line, column: f.column, endLine: f.endLine, endColumn: f.endColumn, severity: f.severity, rule: f.rule, message: f.message, ...(f.new === undefined ? {} : { new: f.new }) }));
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    } else if (format === "sarif") {
        process.stdout.write(`${JSON.stringify(sarif(shown, known !== undefined), null, 2)}\n`);
    } else if (shown.length > 0) {
        process.stdout.write(`${shown.map((f) => `${f.file}:${f.line}:${f.column} ${f.severity} ${f.rule} ${f.message}`).join("\n")}\n`);
    }

    if (!options.quiet) {
        const counts = [...SEVERITIES].reverse().flatMap((s) => {
            const n = findings.filter((f) => f.severity === s).length;
            return n ? [`${n} ${s}${n === 1 || s === "info" ? "" : "s"}`] : [];
        });
        let summary = `${checked.length} file(s) checked, ${findings.length} problem(s)${counts.length ? ` (${counts.join(", ")})` : ""}`;
        if (known) {
            const added = findings.filter((f) => f.new).length;
            summary += `; ${added} new, ${findings.length - added} known`;
        }
        // Keep stdout parseable for JSON and SARIF.
        (format === "text" ? process.stdout : process.stderr).write(`${summary}\n`);
    }

    if (options["write-baseline"]) {
        const keys = [...new Set(fingerprints(findings, options["write-baseline"]))].sort();
        writeFileSync(options["write-baseline"], `${JSON.stringify(keys, null, 2)}\n`);
        if (!options.quiet) warn(`wrote ${keys.length} finding(s) to ${options["write-baseline"]}`);
        return 0;
    }
    return failing.length > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
        if (error instanceof UsageError) warn(`${error.message}\nRun 'asl-check --help' for usage.`);
        else process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
        process.exitCode = 2;
    }
);
