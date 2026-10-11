/**
 * Validation with Script Developer's compiler (ec.exe), the same invocation Script Developer uses:
 * `/generateOnly` with its own `bin` folder as compiler root, so Visual Studio is not needed.
 * Errors come from stdout (syntax errors, located) and from the `.err` report (semantic errors and warnings).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { LANGUAGE_ID, SECTION } from "./common";

export function registerCompiler(context: vscode.ExtensionContext, output: vscode.LogOutputChannel): void {
    const collection = vscode.languages.createDiagnosticCollection("asl-compiler");
    const running = new Map<string, ChildProcessWithoutNullStreams>();
    let warnedUntrusted = false;

    const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(`${SECTION}.compiler`);

    const validate = async (document: vscode.TextDocument, fromCommand: boolean): Promise<void> => {
        if (process.platform !== "win32") {
            if (fromCommand) void vscode.window.showWarningMessage("Compiler validation needs Altitude Script Developer, which only runs on Windows.");
            return;
        }
        if (!vscode.workspace.isTrusted) {
            if (!warnedUntrusted || fromCommand) void vscode.window.showWarningMessage("Compiler validation is disabled in untrusted workspaces.");
            warnedUntrusted = true;
            return;
        }
        const ext = path.extname(document.fileName).toLowerCase();
        if (ext !== ".ags" && ext !== ".irs") {
            if (fromCommand) void vscode.window.showInformationMessage("The compiler validates scripts (.ags, .irs). Modules are checked when you validate a script that imports them.");
            return;
        }
        if (document.uri.scheme !== "file") return;
        const ec = await findCompiler(config().get<string>("installRoot", "").trim());
        if (!ec) {
            if (fromCommand) {
                const choice = await vscode.window.showWarningMessage("ec.exe was not found. Install Altitude Script Developer or set the install folder.", "Open Settings");
                if (choice) void vscode.commands.executeCommand("workbench.action.openSettings", `${SECTION}.compiler.installRoot`);
            }
            return;
        }
        if (document.isDirty) await document.save();
        const run = async (): Promise<void> => {
            const diagnostics = await runCompiler(ec, document, config().get<number>("timeoutMs", 60000), running, output);
            collection.set(document.uri, diagnostics);
            if (fromCommand) {
                const errors = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
                const warnings = diagnostics.length - errors;
                void vscode.window.showInformationMessage(errors || warnings ? `Script Developer compiler: ${errors} error(s), ${warnings} warning(s).` : "Script Developer compiler: no errors or warnings.");
            }
        };
        if (fromCommand) {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Compiling ${path.basename(document.fileName)} with Script Developer…` }, run);
        } else {
            await run();
        }
    };

    context.subscriptions.push(
        collection,
        vscode.commands.registerCommand(`${SECTION}.validateWithCompiler`, async () => {
            const document = vscode.window.activeTextEditor?.document;
            if (!document || document.languageId !== LANGUAGE_ID) {
                void vscode.window.showInformationMessage("Open an ASL script to validate it.");
                return;
            }
            await validate(document, true);
        }),
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.languageId !== LANGUAGE_ID || !config().get<boolean>("enabled", true) || !config().get<boolean>("runOnSave", true)) return;
            void validate(document, false);
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            // Compiler results describe the saved file; drop them once it changes.
            if (event.contentChanges.length && collection.has(event.document.uri)) collection.delete(event.document.uri);
        }),
        { dispose: () => running.forEach((p) => p.kill()) }
    );
}

async function findCompiler(installRoot: string): Promise<string | undefined> {
    const roots = installRoot ? [path.normalize(installRoot)] : candidateRoots();
    for (const root of roots) {
        for (const candidate of [path.join(root, "bin", "ec.exe"), path.join(root, "ec.exe")]) {
            if (await exists(candidate)) return candidate;
        }
    }
    return undefined;
}

function candidateRoots(): string[] {
    // Newest first; the unversioned folder holds in-place upgraded installs.
    const names = ["Altitude Script Developer 8.7", "Altitude Script Developer", "Altitude Script Developer 8.6", "Altitude Script Developer 8.5"];
    const drives = new Set<string>([process.env.SystemDrive ? `${process.env.SystemDrive}\\` : "C:\\", "C:\\", "D:\\"]);
    const roots: string[] = [];
    for (const name of names) {
        for (const drive of drives) {
            for (const programFiles of ["Program Files (x86)", "Program Files"]) roots.push(path.join(drive, programFiles, "Altitude", "Altitude uCI 8", name));
        }
    }
    return roots;
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.promises.access(file, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function runCompiler(ec: string, document: vscode.TextDocument, timeoutMs: number, running: Map<string, ChildProcessWithoutNullStreams>, output: vscode.LogOutputChannel): Promise<vscode.Diagnostic[]> {
    const bin = path.dirname(ec);
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "asl-vscode-"));
    const scriptType = path.extname(document.fileName).slice(1).toUpperCase();
    const args = [`/scriptType=${scriptType}`, `/cCompilerRoot=${bin}`, "/generateOnly", "/maxErrors=1000", "/maxWarnings=1000", `/tempDirectory=${temp}`, `/targetDir=${temp}`, `/shareDir=${bin}`, document.fileName];
    const errFile = path.join(path.dirname(document.fileName), `${path.parse(document.fileName).name}.err`);
    output.info(`Running: "${ec}" ${args.join(" ")}`);
    const key = document.uri.toString();
    running.get(key)?.kill();
    try {
        const result = await new Promise<{ stdout: string; code: number | null; error?: string; timedOut?: boolean }>((resolve) => {
            let stdout = "";
            const child = spawn(ec, args, { cwd: path.dirname(document.fileName), windowsHide: true });
            running.set(key, child);
            const timer = setTimeout(() => {
                child.kill();
                resolve({ stdout, code: null, timedOut: true });
            }, Math.max(timeoutMs, 1000));
            child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
            child.stderr.on("data", (chunk) => (stdout += chunk.toString()));
            child.on("error", (error) => {
                clearTimeout(timer);
                resolve({ stdout, code: null, error: error.message });
            });
            child.on("close", (code) => {
                clearTimeout(timer);
                resolve({ stdout, code });
            });
        });
        running.delete(key);
        if (result.stdout.trim()) output.info(result.stdout.trim());
        if (result.error) return [atStart(document, `Could not start ec.exe: ${result.error}`, vscode.DiagnosticSeverity.Error)];
        if (result.timedOut) return [atStart(document, `Compiler validation timed out after ${timeoutMs} ms.`, vscode.DiagnosticSeverity.Warning)];
        const located = parseStdout(result.stdout, document);
        const fromErr = await readErrFile(errFile, document);
        const diagnostics = dedupe([...located.filter((d) => d.range.start.line > 0 || d.range.start.character > 0), ...fromErr]);
        if (diagnostics.length === 0 && located.length > 0) return located;
        if (diagnostics.length === 0 && result.code !== 0) {
            return [atStart(document, firstMeaningfulLine(result.stdout) ?? `ec.exe exited with code ${result.code}.`, vscode.DiagnosticSeverity.Error)];
        }
        return diagnostics;
    } finally {
        await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
}

function make(range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
    const diagnostic = new vscode.Diagnostic(range, message.trim(), severity);
    diagnostic.source = "ec.exe";
    return diagnostic;
}

function atStart(document: vscode.TextDocument, message: string, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
    return make(new vscode.Range(0, 0, 0, Math.max(document.lineAt(0).text.length, 1)), message, severity);
}

function severityOf(word: string): vscode.DiagnosticSeverity {
    const lower = word.toLowerCase();
    return lower === "warning" ? vscode.DiagnosticSeverity.Warning : lower === "info" ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Error;
}

/** Syntax errors are printed with a location: `Error: 652,53 [23516]: symbol '}' expected.` */
function parseStdout(stdout: string, document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        const located = line.match(/^(error|warning|info)\s*:\s*(\d+)\s*,\s*(\d+)\s*(?:\[(\d+)\])?\s*:\s*(.+)$/i);
        if (located) {
            const lineIndex = Math.min(Math.max(Number(located[2]) - 1, 0), document.lineCount - 1);
            const text = document.lineAt(lineIndex).text;
            const start = Math.min(Math.max(Number(located[3]) - 1, 0), text.length);
            const word = text.slice(start).match(/^[\p{L}_][\p{L}\p{N}_]*/u)?.[0].length ?? 1;
            const diagnostic = make(new vscode.Range(lineIndex, start, lineIndex, Math.min(start + word, Math.max(text.length, start + 1))), located[5], severityOf(located[1]));
            if (located[4]) diagnostic.code = Number(located[4]);
            diagnostics.push(diagnostic);
            continue;
        }
        const plain = line.match(/^(error|warning|info)\s*:\s*(.+)$/i);
        if (plain) diagnostics.push(atStart(document, plain[2], severityOf(plain[1])));
    }
    return diagnostics;
}

/**
 * The `.err` report repeats source lines followed by `### message` markers. The marker is matched back to the
 * document by the nearest preceding source line (or the graphical element block, for overlap errors).
 */
async function readErrFile(errFile: string, document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
    let content: string;
    try {
        content = await fs.promises.readFile(errFile, "utf8");
    } catch {
        return [];
    } finally {
        await fs.promises.rm(errFile, { force: true }).catch(() => undefined);
    }
    const normalize = (value: string): string => value.trim().replace(/\s+/g, " ");
    const sourceLines = Array.from({ length: document.lineCount }, (_, i) => normalize(document.lineAt(i).text));
    const lines = content.split(/\r?\n/);
    const diagnostics: vscode.Diagnostic[] = [];
    let searchFrom = 0;
    for (let i = 0; i < lines.length; i += 1) {
        const marker = lines[i].match(/^\s*###\s+(.+?)\s*$/);
        if (!marker) continue;
        const message = marker[1];
        const severity = /^error\b/i.test(message) ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
        let anchor: string | undefined;
        for (let j = i - 1; j >= 0; j -= 1) {
            const candidate = normalize(lines[j]);
            if (!candidate || candidate === "..." || candidate === "[...]" || candidate === "-*-" || candidate.startsWith("### ") || candidate === "{" || candidate === "}") continue;
            anchor = candidate;
            break;
        }
        let found: number | undefined;
        if (anchor) {
            for (let k = 0; k < sourceLines.length; k += 1) {
                const index = (searchFrom + k) % sourceLines.length;
                if (sourceLines[index] === anchor) {
                    found = index;
                    break;
                }
            }
        }
        if (found === undefined) {
            diagnostics.push(atStart(document, message, severity));
            continue;
        }
        searchFrom = found + 1;
        const text = document.lineAt(found).text;
        const start = text.search(/\S/);
        diagnostics.push(make(new vscode.Range(found, Math.max(start, 0), found, Math.max(text.length, start + 1)), message, severity));
    }
    return diagnostics;
}

function dedupe(diagnostics: vscode.Diagnostic[]): vscode.Diagnostic[] {
    const seen = new Set<string>();
    return diagnostics.filter((d) => {
        const key = `${d.range.start.line}:${d.range.start.character}:${d.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function firstMeaningfulLine(stdout: string): string | undefined {
    return stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !/^(script loaded|script compiled|errors\/warnings have been written|\*{4,}|active code page|\d+ warnings found)/i.test(l) && !/^[A-Z]:\\.+>$/.test(l))
        ?.slice(0, 500);
}
