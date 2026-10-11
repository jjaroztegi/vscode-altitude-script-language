/**
 * The set of ASL files the language server knows about: open documents (with unsaved text) and
 * files on disk. Parses and binds lazily, caches per text, and builds programs on demand.
 */
import { URI, Utils } from "vscode-uri";
import { bind, type FileModel } from "./binder";
import { check, RULE_SEVERITY, type AslDiagnostic, type Severity } from "./checker";
import { fileKindOf, parse } from "./parser";
import { Program } from "./program";

export interface Settings {
    webEdition?: boolean;
    rules?: Record<string, "off" | Severity>;
}

export interface WorkspaceHost {
    /** Reads a file that is not open; undefined when it does not exist. */
    readFile(uri: string): Promise<string | undefined>;
    settings(): Settings;
}

interface Entry {
    uri: string;
    text?: string;
    version?: number;
    open: boolean;
    model?: FileModel;
}

const ASL_EXTENSIONS = /\.(ags|agm|gem|irs|irm)$/i;

export function isAslUri(uri: string): boolean {
    return ASL_EXTENSIONS.test(uri.split(/[?#]/)[0]);
}

/** Key used to match file names case-insensitively, as Windows and Script Developer do. */
export function uriKey(uri: string): string {
    try {
        return URI.parse(uri).toString().toLowerCase();
    } catch {
        return uri.toLowerCase();
    }
}

export class Workspace {
    private readonly entries = new Map<string, Entry>();
    private programCache = new Map<string, Program>();
    private generation = 0;

    constructor(readonly host: WorkspaceHost) {}

    // ------------------------------------------------------------ file set

    /** Registers or updates an open document. */
    setDocument(uri: string, text: string, version: number): void {
        const key = uriKey(uri);
        const entry = this.entries.get(key);
        if (entry && entry.text === text && entry.open) {
            entry.version = version;
            return;
        }
        this.entries.set(key, { uri: entry?.uri ?? uri, text, version, open: true });
        this.invalidate();
    }

    closeDocument(uri: string): void {
        const entry = this.entries.get(uriKey(uri));
        if (entry) {
            entry.open = false;
            entry.text = undefined;
            entry.model = undefined;
            this.invalidate();
        }
    }

    /** Registers a file on disk; text is optional and read lazily. */
    setDiskFile(uri: string, text?: string): void {
        const key = uriKey(uri);
        const entry = this.entries.get(key);
        if (entry?.open) return;
        this.entries.set(key, { uri: entry?.uri ?? uri, text, open: false });
        this.invalidate();
    }

    removeFile(uri: string): void {
        const key = uriKey(uri);
        const entry = this.entries.get(key);
        if (entry && !entry.open) {
            this.entries.delete(key);
            this.invalidate();
        }
    }

    /** Disk content changed: drop the cached text unless the document is open. */
    fileChanged(uri: string): void {
        const entry = this.entries.get(uriKey(uri));
        if (entry && !entry.open) {
            entry.text = undefined;
            entry.model = undefined;
            this.invalidate();
        } else if (!entry) {
            this.setDiskFile(uri);
        }
    }

    knownUris(): string[] {
        return [...this.entries.values()].map((e) => e.uri);
    }

    isOpen(uri: string): boolean {
        return this.entries.get(uriKey(uri))?.open ?? false;
    }

    version(): number {
        return this.generation;
    }

    private invalidate(): void {
        this.generation += 1;
        this.programCache = new Map();
    }

    // ------------------------------------------------------------ loading

    /** Loads the text of a file and of everything it imports, so that analysis can run synchronously. */
    async prepare(uri: string): Promise<void> {
        const pending = [uri];
        const seen = new Set<string>();
        while (pending.length > 0) {
            const current = pending.pop()!;
            const key = uriKey(current);
            if (seen.has(key)) continue;
            seen.add(key);
            const model = await this.loadModel(current);
            if (!model) continue;
            for (const item of model.imports) {
                const target = this.resolveImportUri(model.uri, item.path.value);
                if (target) pending.push(target);
            }
        }
    }

    /** Reads every known file's text (used by workspace-wide features). */
    async prepareAll(): Promise<void> {
        await Promise.all([...this.entries.values()].filter((e) => e.text === undefined).map((e) => this.loadText(e)));
    }

    private async loadText(entry: Entry): Promise<string | undefined> {
        if (entry.text !== undefined) return entry.text;
        const text = await this.host.readFile(entry.uri);
        // The entry may have been opened meanwhile.
        if (entry.text === undefined && text !== undefined) entry.text = text;
        return entry.text;
    }

    private async loadModel(uri: string): Promise<FileModel | undefined> {
        let entry = this.entries.get(uriKey(uri));
        if (!entry) {
            const text = await this.host.readFile(uri);
            if (text === undefined) return undefined;
            entry = { uri, text, open: false };
            this.entries.set(uriKey(uri), entry);
        }
        await this.loadText(entry);
        return this.model(entry.uri);
    }

    /** Text of a known file, if loaded. */
    text(uri: string): string | undefined {
        return this.entries.get(uriKey(uri))?.text;
    }

    /** Parsed and bound file, if its text is loaded. */
    model(uri: string): FileModel | undefined {
        const entry = this.entries.get(uriKey(uri));
        if (!entry || entry.text === undefined) return undefined;
        if (!entry.model) {
            const source = parse(entry.text, fileKindOf(entry.uri));
            entry.model = bind(entry.uri, source);
        }
        return entry.model;
    }

    /**
     * Resolves an import path (`Popups.agm`, `..\shared\x.agm`, `C:\libs\x.gem`) against the importing
     * file, matching known files case-insensitively.
     */
    resolveImportUri(fromUri: string, path: string): string | undefined {
        const normalized = path.replace(/\\/g, "/");
        let target: URI;
        const from = URI.parse(fromUri);
        if (/^[A-Za-z]:\//.test(normalized)) {
            target = URI.file(normalized);
        } else if (normalized.startsWith("/")) {
            target = from.with({ path: normalized });
        } else {
            target = Utils.joinPath(Utils.dirname(from), normalized);
        }
        const key = uriKey(target.toString());
        const known = this.entries.get(key);
        if (known) return known.uri;
        // Fall back to a known file with the same name in the same folder (case-insensitive).
        return target.toString();
    }

    // ------------------------------------------------------------ programs

    /** The program rooted at a file: the file plus its transitive imports. */
    program(uri: string): Program | undefined {
        const key = uriKey(uri);
        const cached = this.programCache.get(key);
        if (cached) return cached;
        const root = this.model(uri);
        if (!root) return undefined;
        const program = new Program(root, (from, path) => {
            const target = this.resolveImportUri(from.uri, path);
            return target ? this.model(target) : undefined;
        });
        this.programCache.set(key, program);
        return program;
    }

    /** Files whose program includes `uri` (the file itself and every script/module importing it). */
    importers(uri: string): string[] {
        const key = uriKey(uri);
        const result: string[] = [];
        for (const entry of this.entries.values()) {
            const model = this.model(entry.uri);
            if (!model) continue;
            if (uriKey(entry.uri) === key) {
                result.push(entry.uri);
                continue;
            }
            const program = this.program(entry.uri);
            if (program?.files.some((f) => uriKey(f.uri) === key)) result.push(entry.uri);
        }
        return result;
    }

    /** Whether any loaded file imports the module (undefined while texts are not all loaded). */
    private isImportedAnywhere(file: FileModel): boolean | undefined {
        const key = uriKey(file.uri);
        for (const entry of this.entries.values()) {
            if (entry.text === undefined) return undefined;
            if (uriKey(entry.uri) === key) continue;
            const name = file.uri.split("/").pop()!.toLowerCase();
            if (!entry.text.toLowerCase().includes(decodeURIComponent(name))) continue;
            const model = this.model(entry.uri);
            if (model?.imports.some((item) => uriKey(this.resolveImportUri(model.uri, item.path.value) ?? "") === key)) return true;
        }
        return false;
    }

    // ------------------------------------------------------------ diagnostics

    diagnose(uri: string): AslDiagnostic[] {
        const program = this.program(uri);
        const file = program?.root;
        if (!program || !file) return [];
        const settings = this.host.settings();
        const raw = check(file, program, { webEdition: settings.webEdition ?? true, isModuleImportedAnywhere: (f) => this.isImportedAnywhere(f) });
        return applySettings(raw, file, settings).sort((a, b) => a.start - b.start || a.end - b.end);
    }
}

/** Applies severity overrides and `comment { asl-disable ... }` suppressions. */
export function applySettings(diagnostics: AslDiagnostic[], file: FileModel, settings: Settings): AslDiagnostic[] {
    const text = file.source.text;
    const fileDisabled = new Set<string>();
    const lineDisabled = new Map<number, Set<string>>();
    const lineOf = (offset: number): number => {
        let line = 0;
        for (let i = 0; i < offset; i += 1) if (text.charCodeAt(i) === 10) line += 1;
        return line;
    };
    for (const comment of file.source.comments) {
        const match = comment.text.match(/\basl-disable(-next-line|-line)?\b\s*([\w\-,\s]*)/i);
        if (!match) continue;
        const rules = match[2].split(/[\s,]+/).filter(Boolean);
        const list = rules.length ? rules : ["*"];
        if (!match[1]) {
            list.forEach((r) => fileDisabled.add(r));
            continue;
        }
        const line = lineOf(match[1] === "-line" ? comment.start : comment.end) + (match[1] === "-next-line" ? 1 : 0);
        const set = lineDisabled.get(line) ?? new Set<string>();
        list.forEach((r) => set.add(r));
        lineDisabled.set(line, set);
    }
    const result: AslDiagnostic[] = [];
    for (const diagnostic of diagnostics) {
        const override = settings.rules?.[diagnostic.code];
        if (override === "off") continue;
        if (fileDisabled.has(diagnostic.code) || fileDisabled.has("*")) continue;
        if (lineDisabled.size > 0) {
            const set = lineDisabled.get(lineOf(diagnostic.start));
            if (set && (set.has(diagnostic.code) || set.has("*"))) continue;
        }
        result.push(override ? { ...diagnostic, severity: override } : diagnostic);
    }
    void RULE_SEVERITY;
    return result;
}
