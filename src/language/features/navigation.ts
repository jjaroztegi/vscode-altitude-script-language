import type { DocumentHighlight, DocumentLink, Hover, Location, Range, TextEdit, WorkspaceEdit } from "vscode-languageserver-types";
import type { AslSymbol, FileModel } from "../binder";
import { ACTIONS, CONTROLS, EVENTS } from "../catalog";
import type { Program } from "../program";
import type { Workspace } from "../workspace";
import {
    actionMarkdown,
    attributeMarkdown,
    contains,
    enumMarkdown,
    functionMarkdown,
    link,
    symbolMarkdown,
    targetAt,
    toLocation,
    toRange
} from "./common";

// ------------------------------------------------------------ hover

export function hover(workspace: Workspace, file: FileModel, program: Program, offset: number): Hover | undefined {
    const target = targetAt(workspace, file, program, offset);
    if (target) {
        const range = target.reference ? toRange(file, target.reference.span) : target.symbols[0]?.uri === file.uri ? toRange(file, target.symbols[0].nameSpan) : undefined;
        if (target.namespaceTarget) {
            const name = decodeURIComponent(target.namespaceTarget.uri.split("/").pop() ?? "");
            return { contents: { kind: "markdown", value: `\`\`\`altitude-asl\nnamespace ${target.reference?.name ?? ""}\n\`\`\`\n\nModule \`${name}\`` }, range };
        }
        if (target.symbols.length) {
            return { contents: { kind: "markdown", value: symbolMarkdown(workspace, target.symbols[0], file) }, range };
        }
        const resolution = target.resolution;
        if (resolution) {
            let value: string | undefined;
            switch (resolution.kind) {
                case "function":
                    value = functionMarkdown(resolution.fn);
                    break;
                case "attribute":
                    value = attributeMarkdown(resolution.attribute);
                    break;
                case "enum":
                    value = enumMarkdown(resolution.def);
                    break;
                case "enumMember":
                    value = enumMarkdown(resolution.def, resolution.member);
                    break;
                case "record":
                    value = `\`\`\`altitude-asl\n${resolution.def.name}: record\n\`\`\`\n\n${resolution.def.doc ?? ""}\n\n${resolution.def.fields.map((f) => `- \`${f.name}\`${f.type ? `: ${f.type}` : ""}`).join("\n")}\n\n${link(resolution.def.url)}`;
                    break;
                case "field":
                    value = `\`\`\`altitude-asl\n${resolution.owner}.${resolution.field.name}${resolution.field.type ? `: ${resolution.field.type}` : ""}\n\`\`\`\n\n${resolution.field.doc ?? ""}`;
                    break;
                case "business":
                    value = `\`\`\`altitude-asl\n${resolution.name}: ${resolution.type}\n\`\`\`\n\n${resolution.doc}\n\n${link("ref/expr/script-data.html")}`;
                    break;
                case "constant":
                    value = `\`\`\`altitude-asl\n${resolution.name}${resolution.value !== undefined ? ` = ${resolution.value}` : ""}\n\`\`\`\n\nPredefined constant. ${resolution.doc ?? ""}`;
                    break;
                case "builtinType":
                    value = `\`\`\`altitude-asl\n${resolution.name}\n\`\`\`\n\nBuilt-in type.\n\n${link("ref/decl/type-builtin.html")}`;
                    break;
                default:
                    break;
            }
            if (value) return { contents: { kind: "markdown", value }, range };
        }
    }
    return keywordHover(file, offset);
}

/** Hover on action, handler and graphical element keywords. */
function keywordHover(file: FileModel, offset: number): Hover | undefined {
    let result: Hover | undefined;
    const visitStatements = (statements: import("../ast").Stmt[]): void => {
        for (const stmt of statements) {
            if (!contains(stmt, offset)) continue;
            if (stmt.kind === "action" && stmt.action >= 0 && stmt.keywords.some((k) => contains(k, offset))) {
                const keyword = stmt.keywords.find((k) => contains(k, offset))!;
                result = { contents: { kind: "markdown", value: actionMarkdown(ACTIONS[stmt.action]) }, range: toRange(file, keyword) };
                return;
            }
            const blocks = stmt.kind === "if" ? [stmt.then, ...(stmt.else ? ["statements" in stmt.else ? stmt.else : { statements: [stmt.else], start: 0, end: 0 }] : [])] : stmt.kind === "case" ? [...stmt.whens.map((w) => w.body), ...(stmt.default ? [stmt.default] : [])] : stmt.kind === "while" || stmt.kind === "for" || stmt.kind === "repeat" ? [stmt.body] : stmt.kind === "action" ? stmt.blocks : [];
            for (const block of blocks) visitStatements(block.statements);
            if (result) return;
        }
    };
    const visitDecls = (decls: import("../ast").Decl[]): void => {
        for (const decl of decls) {
            if (!contains(decl, offset)) continue;
            switch (decl.kind) {
                case "node":
                case "block":
                    visitDecls(decl.members);
                    break;
                case "control": {
                    const def = CONTROLS.get(decl.control);
                    if (def && contains(decl.keyword, offset)) {
                        result = { contents: { kind: "markdown", value: `\`\`\`altitude-asl\n${def.syntax}\n\`\`\`\n\n${def.doc}${def.deprecated ? `\n\n**Deprecated:** ${def.deprecated}` : ""}\n\n${link(def.url)}` }, range: toRange(file, decl.keyword) };
                        return;
                    }
                    for (const clause of decl.clauses) {
                        if (contains(clause, offset) && def) {
                            const clauseDef = def.clauses.find((c) => c.phrase === clause.words);
                            if (clauseDef && clause.keywords.some((k) => contains(k, offset))) {
                                result = { contents: { kind: "markdown", value: `\`\`\`altitude-asl\n${clauseDef.syntax}\n\`\`\`\n\n${clauseDef.doc ?? ""}\n\n${link(def.url)}` }, range: toRange(file, clause.keywords.find((k) => contains(k, offset))!) };
                                return;
                            }
                        }
                    }
                    for (const handler of decl.handlers) {
                        if (contains(handler.eventSpan, offset) && def) {
                            const event = def.events.find((e) => e.words.test(handler.event));
                            if (event) {
                                result = { contents: { kind: "markdown", value: `\`\`\`altitude-asl\n${event.syntax}\n\`\`\`\n\n${event.doc ?? ""}\n\n${link(def.url)}` }, range: toRange(file, handler.eventSpan) };
                                return;
                            }
                        }
                        if (contains(handler.body, offset)) visitStatements(handler.body.statements);
                    }
                    break;
                }
                case "handler": {
                    if (contains(decl.eventSpan, offset)) {
                        const event = EVENTS.get(decl.event);
                        const value = event ? `\`\`\`altitude-asl\non ${event.words}${event.params}\n\`\`\`\n\n${event.doc}${event.deprecated ? `\n\n**Deprecated:** ${event.deprecated}` : ""}\n\n${link(event.url)}` : handlerDoc(decl.event);
                        if (value) result = { contents: { kind: "markdown", value }, range: toRange(file, decl.eventSpan) };
                        return;
                    }
                    visitStatements(decl.body.statements);
                    break;
                }
                case "routine":
                    if (decl.body) visitStatements(decl.body.statements);
                    break;
                case "exitPoint":
                case "functionKey":
                case "nodeLoop":
                    visitStatements(decl.body.statements);
                    break;
                default:
                    break;
            }
            if (result) return;
        }
    };
    visitDecls(file.source.decls);
    return result;
}

const HANDLER_DOCS: Record<string, [string, string]> = {
    start: ["Runs when the script starts. It should end with `goto node` to the first node.", "ref/decl/script.html"],
    end: ["Runs when the script ends (end, abort, discard or restart script). Node navigation is ignored here.", "ref/decl/script.html"],
    load: ["Modules: runs when the importing script starts. Blocks: runs when a container displays the block.", "ref/decl/module.html"],
    unload: ["Modules: runs when the importing script ends. Blocks: runs when a container stops displaying the block.", "ref/decl/module.html"],
    "first enter": ["Runs the first time the script enters the node, after the master's handler.", "ref/decl/node.html"],
    enter: ["Runs every time the script enters the node, after `on first enter`. Events are not delivered until it ends.", "ref/decl/node.html"],
    exit: ["Runs every time the script leaves the node. It cannot move to another node.", "ref/decl/node.html"]
};

function handlerDoc(event: string): string | undefined {
    const doc = HANDLER_DOCS[event];
    return doc ? `\`\`\`altitude-asl\non ${event} { ... }\n\`\`\`\n\n${doc[0]}\n\n${link(doc[1])}` : undefined;
}

// ------------------------------------------------------------ definition

export function definition(workspace: Workspace, file: FileModel, program: Program, offset: number): Location[] {
    const importItem = file.imports.find((item) => contains(item.path, offset));
    if (importItem) {
        const target = program.linksFrom(file).find((l) => file.imports[l.importIndex] === importItem)?.target;
        return target ? [{ uri: target.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] : [];
    }
    const target = targetAt(workspace, file, program, offset);
    if (!target) return [];
    if (target.namespaceTarget) return [{ uri: target.namespaceTarget.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }];
    return target.symbols.map((s) => toLocation(workspace, s)).filter((l): l is Location => l !== undefined);
}

export function typeDefinition(workspace: Workspace, file: FileModel, program: Program, offset: number): Location[] {
    const target = targetAt(workspace, file, program, offset);
    const symbol = target?.symbols[0];
    if (!symbol?.type || symbol.type.kind !== "named") return [];
    const owner = workspace.model(symbol.uri) ?? file;
    const resolution = program.resolveType(owner, symbol.scope, symbol.type.name.text, symbol.type.qualifier.map((q) => q.text));
    return resolution.kind === "symbol" ? resolution.symbols.map((s) => toLocation(workspace, s)).filter((l): l is Location => l !== undefined) : [];
}

// ------------------------------------------------------------ references

function sameSymbol(a: AslSymbol, b: AslSymbol): boolean {
    return a === b || (a.uri === b.uri && a.nameSpan.start === b.nameSpan.start && a.kind === b.kind);
}

/** All occurrences of the symbols, across every file whose program can see them. */
export function findReferences(workspace: Workspace, symbols: AslSymbol[], includeDeclaration: boolean): Location[] {
    const locations: Location[] = [];
    const seen = new Set<string>();
    const add = (uri: string, file: FileModel, span: { start: number; end: number }): void => {
        const key = `${uri}:${span.start}`;
        if (seen.has(key)) return;
        seen.add(key);
        locations.push({ uri, range: toRange(file, span) });
    };
    for (const symbol of symbols) {
        if (includeDeclaration) {
            const owner = workspace.model(symbol.uri);
            if (owner) add(symbol.uri, owner, symbol.nameSpan);
        }
        const needle = symbol.name.toLowerCase();
        const candidates = symbol.scope.kind === "file" || symbol.kind === "node" || symbol.kind === "event" || symbol.kind === "control" || symbol.kind === "block" || symbol.kind === "image" || symbol.kind === "field" ? workspace.importers(symbol.uri) : [symbol.uri];
        for (const uri of candidates) {
            const text = workspace.text(uri);
            if (!text || !text.toLowerCase().includes(needle)) continue;
            const file = workspace.model(uri);
            const program = workspace.program(uri);
            if (!file || !program) continue;
            for (const ref of file.references) {
                if (ref.name.toLowerCase() !== needle && !(ref.kind === "node" && ref.name.toLowerCase().endsWith(`::${needle}`))) continue;
                const resolution = program.resolve(file, ref);
                if (resolution.kind === "symbol" && resolution.symbols.some((s) => sameSymbol(s, symbol))) {
                    const span = ref.kind === "node" && ref.name.includes("::") ? { start: ref.span.end - symbol.name.length, end: ref.span.end } : ref.span;
                    add(uri, file, span);
                }
            }
        }
    }
    return locations;
}

export function references(workspace: Workspace, file: FileModel, program: Program, offset: number, includeDeclaration: boolean): Location[] {
    const target = targetAt(workspace, file, program, offset);
    if (!target?.symbols.length) return [];
    return findReferences(workspace, target.symbols, includeDeclaration);
}

export function documentHighlights(workspace: Workspace, file: FileModel, program: Program, offset: number): DocumentHighlight[] {
    const target = targetAt(workspace, file, program, offset);
    if (!target?.symbols.length) return [];
    const highlights: DocumentHighlight[] = [];
    for (const symbol of target.symbols) {
        if (symbol.uri === file.uri) highlights.push({ range: toRange(file, symbol.nameSpan), kind: 3 });
    }
    for (const ref of file.references) {
        if (ref.name.toLowerCase() !== target.symbols[0].key && !ref.name.toLowerCase().endsWith(`::${target.symbols[0].key}`)) continue;
        const resolution = program.resolve(file, ref);
        if (resolution.kind === "symbol" && resolution.symbols.some((s) => target.symbols.some((t) => sameSymbol(s, t)))) {
            highlights.push({ range: toRange(file, ref.span), kind: ref.write ? 3 : 2 });
        }
    }
    return highlights;
}

// ------------------------------------------------------------ rename

const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;

export function prepareRename(workspace: Workspace, file: FileModel, program: Program, offset: number): { range: Range; placeholder: string } | undefined {
    const target = targetAt(workspace, file, program, offset);
    const symbol = target?.symbols[0];
    if (!symbol || symbol.kind === "businessRecord") return undefined;
    const span = target.reference?.span ?? symbol.nameSpan;
    return { range: toRange(file, span), placeholder: symbol.name };
}

export function rename(workspace: Workspace, file: FileModel, program: Program, offset: number, newName: string): WorkspaceEdit | undefined {
    const target = targetAt(workspace, file, program, offset);
    const symbol = target?.symbols[0];
    if (!symbol) return undefined;
    const stringNamed = ["node", "block", "image", "control"].includes(symbol.kind);
    if (!stringNamed && !IDENTIFIER.test(newName)) {
        throw new Error(`'${newName}' is not a valid ASL identifier.`);
    }
    if (stringNamed && /["'\\]/.test(newName)) throw new Error("Names cannot contain quotes or backslashes.");
    const changes: Record<string, TextEdit[]> = {};
    for (const location of findReferences(workspace, target.symbols, true)) {
        (changes[location.uri] ??= []).push({ range: location.range, newText: newName });
    }
    return { changes };
}

// ------------------------------------------------------------ links

export function documentLinks(workspace: Workspace, file: FileModel): DocumentLink[] {
    const links: DocumentLink[] = [];
    for (const item of file.imports) {
        const target = workspace.resolveImportUri(file.uri, item.path.value);
        const quote = file.source.text[item.path.start] === "<" ? 2 : 1;
        if (target) links.push({ range: toRange(file, { start: item.path.start + quote, end: item.path.end - quote }), target, tooltip: "Open module" });
    }
    for (const decl of file.source.decls) {
        if (decl.kind !== "dependencies") continue;
        for (const dep of decl.items) {
            if (dep.file?.kind === "string" && dep.dependencyKind !== "web service") {
                const target = workspace.resolveImportUri(file.uri, dep.file.value);
                const quote = file.source.text[dep.file.start] === "<" ? 2 : 1;
                if (target && !/\.dll$/i.test(dep.file.value)) links.push({ range: toRange(file, { start: dep.file.start + quote, end: dep.file.end - quote }), target });
            }
        }
    }
    return links;
}
