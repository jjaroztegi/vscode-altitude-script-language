/**
 * Runs the parser and checker over a folder of real scripts and summarises the diagnostics.
 * Nothing from the corpus is written anywhere; use it to hunt false positives before a release.
 *
 *   npm run corpus -- <folder> [--show=N] [--code=rule-id]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { LineMap } from "../src/language/lexer";
import { fileKindOf, parse } from "../src/language/parser";
import { URI } from "vscode-uri";
import { Workspace } from "../src/language/workspace";
import { findAslFiles } from "../src/node/files";

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--"));
if (!root) {
    console.error("usage: corpus-check <folder> [--show=N] [--code=id] [--parse-only]");
    process.exit(2);
}
const show = Number(args.find((a) => a.startsWith("--show="))?.slice(7) ?? 3);
const onlyCode = args.find((a) => a.startsWith("--code="))?.slice(7);
const parseOnly = args.includes("--parse-only");

const files = findAslFiles(path.resolve(root));

const byMessage = new Map<string, { count: number; samples: string[] }>();
let total = 0;
const started = Date.now();
const record = (file: string, text: string, lines: LineMap, start: number, code: string, message: string, severity: string): void => {
    if (onlyCode && code !== onlyCode) return;
    total += 1;
    const key = `${severity} ${code}: ${message.replace(/'[^']*'/g, "'…'").replace(/"[^"]*"/g, '"…"')}`;
    const entry = byMessage.get(key) ?? { count: 0, samples: [] };
    entry.count += 1;
    if (entry.samples.length < show) {
        const pos = lines.positionAt(start);
        entry.samples.push(`${path.relative(root, file)}:${pos.line + 1}  ${lines.lineText(pos.line).trim().slice(0, 140)}`);
    }
    byMessage.set(key, entry);
    void text;
};

if (parseOnly) {
    for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        const lines = new LineMap(text);
        const source = parse(text, fileKindOf(file));
        for (const d of source.diagnostics) record(file, text, lines, d.start, d.code, d.message, d.severity);
    }
} else {
    const workspace = new Workspace({ readFile: (uri) => fs.promises.readFile(URI.parse(uri).fsPath, "utf8").catch(() => undefined), settings: () => ({}) });
    for (const file of files) workspace.setDiskFile(URI.file(file).toString(), fs.readFileSync(file, "utf8"));
    for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        const lines = new LineMap(text);
        for (const d of workspace.diagnose(URI.file(file).toString())) record(file, text, lines, d.start, d.code, d.message, d.severity);
    }
}

const sorted = [...byMessage.entries()].sort((a, b) => b[1].count - a[1].count);
for (const [key, entry] of sorted) {
    console.log(`${String(entry.count).padStart(6)}  ${key}`);
    for (const sample of entry.samples) console.log(`          ${sample}`);
}
console.log(`\n${files.length} files, ${total} diagnostics, ${Date.now() - started} ms`);
