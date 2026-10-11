import type { DocumentSymbol, FoldingRange, SelectionRange, SymbolInformation, SymbolKind } from "vscode-languageserver-types";
import type { Decl, Span } from "../ast";
import type { AslSymbol, FileModel } from "../binder";
import type { Workspace } from "../workspace";
import { fuzzyMatch, lineMap, toRange } from "./common";

// LSP SymbolKind values.
const SK = { File: 1, Module: 2, Namespace: 3, Class: 5, Method: 6, Property: 7, Field: 8, Enum: 10, Interface: 11, Function: 12, Variable: 13, Constant: 14, String: 15, Struct: 23, Event: 24, EnumMember: 22, Object: 19, Key: 20 } as const;

export function symbolKind(symbol: AslSymbol): SymbolKind {
    switch (symbol.kind) {
        case "node":
            return SK.Class;
        case "block":
            return SK.Interface;
        case "subroutine":
        case "function":
            return SK.Function;
        case "event":
            return SK.Event;
        case "type":
            return symbol.type?.kind === "enumeration" ? SK.Enum : SK.Struct;
        case "enumMember":
            return SK.EnumMember;
        case "field":
            return SK.Field;
        case "constant":
            return SK.Constant;
        case "namespace":
            return SK.Namespace;
        case "cursor":
            return SK.Object;
        case "control":
            return SK.Property;
        case "image":
        case "dll":
            return SK.File;
        case "exitPoint":
            return SK.Key;
        case "businessRecord":
            return SK.Struct;
        default:
            return SK.Variable;
    }
}

export function documentSymbols(file: FileModel): DocumentSymbol[] {
    const bySpan = new Map<number, AslSymbol>();
    for (const symbol of file.symbols) bySpan.set(symbol.nameSpan.start, symbol);
    const make = (name: string, kind: SymbolKind, span: Span, selection: Span, detail?: string, children: DocumentSymbol[] = []): DocumentSymbol => ({
        name: name || "(unnamed)",
        kind,
        detail,
        range: toRange(file, span),
        selectionRange: toRange(file, selection),
        children
    });
    const fromSymbol = (symbol: AslSymbol, children: DocumentSymbol[] = []): DocumentSymbol => make(symbol.name, symbolKind(symbol), symbol.span, symbol.nameSpan, symbol.detail ?? (symbol.type ? file.source.text.slice(symbol.type.start, symbol.type.end).split("\n")[0].trim() : undefined), children);
    const visit = (decls: Decl[]): DocumentSymbol[] => {
        const out: DocumentSymbol[] = [];
        for (const decl of decls) {
            switch (decl.kind) {
                case "section": {
                    const children = decl.items.map((item) => {
                        const symbol = bySpan.get(item.name.start);
                        if (!symbol) return undefined;
                        const members = symbol.members ? [...symbol.members.values()].map((m) => fromSymbol(m)) : [];
                        return fromSymbol(symbol, members);
                    }).filter((s): s is DocumentSymbol => s !== undefined);
                    if (children.length) out.push(make(decl.section, SK.Namespace, decl, decl.keyword, undefined, children));
                    break;
                }
                case "modules":
                    for (const item of decl.imports) {
                        out.push(make(item.namespace?.text ?? item.path.value, SK.Module, item, item.namespace ?? item.path, item.path.value));
                    }
                    break;
                case "routine": {
                    const symbol = bySpan.get(decl.name.start);
                    if (symbol) out.push(fromSymbol(symbol));
                    break;
                }
                case "handler":
                    out.push(make(`on ${decl.event}`, decl.userEvent ? SK.Event : SK.Method, decl, decl.eventSpan));
                    break;
                case "node":
                case "block": {
                    const symbol = bySpan.get(decl.name.start);
                    out.push(make(decl.name.value, decl.kind === "node" ? SK.Class : SK.Interface, decl, decl.name, symbol?.doc, visit(decl.members)));
                    break;
                }
                case "control":
                    if (decl.name) out.push(make(decl.name.value, SK.Property, decl, decl.name, decl.control, decl.handlers.map((h) => make(`on ${h.event}`, SK.Method, h, h.eventSpan))));
                    else if (decl.handlers.some((h) => h.body.statements.length > 0)) out.push(make(decl.control, SK.Property, decl, decl.keyword, undefined, decl.handlers.map((h) => make(`on ${h.event}`, SK.Method, h, h.eventSpan))));
                    break;
                case "exitPoint":
                    out.push(make(decl.name.text, SK.Key, decl, decl.name, "exit point"));
                    break;
                default:
                    break;
            }
        }
        return out;
    };
    return visit(file.source.decls);
}

export function workspaceSymbols(workspace: Workspace, query: string): SymbolInformation[] {
    const results: SymbolInformation[] = [];
    const kinds = new Set(["node", "block", "subroutine", "function", "type", "constant", "variable", "cursor", "event"]);
    for (const uri of workspace.knownUris()) {
        const file = workspace.model(uri);
        if (!file) continue;
        for (const symbol of file.symbols) {
            if (!kinds.has(symbol.kind) || symbol.isLocal) continue;
            if (symbol.scope.kind !== "file" && symbol.kind !== "event" && symbol.kind !== "subroutine" && symbol.kind !== "function") continue;
            if (!fuzzyMatch(query, symbol.name)) continue;
            results.push({ name: symbol.name, kind: symbolKind(symbol), location: { uri, range: toRange(file, symbol.nameSpan) }, containerName: symbol.container?.name ?? decodeURIComponent(uri.split("/").pop() ?? "") });
            if (results.length >= 2000) return results;
        }
    }
    return results;
}

// ------------------------------------------------------------ folding

export function foldingRanges(file: FileModel): FoldingRange[] {
    const map = lineMap(file);
    const ranges: FoldingRange[] = [];
    const seen = new Set<number>();
    const add = (span: Span, kind?: string): void => {
        const start = map.positionAt(span.start).line;
        // Keep the closing brace visible when folded.
        const end = map.positionAt(span.end).line - (file.source.text[span.end - 1] === "}" ? 1 : 0);
        if (end > start && !seen.has(start)) {
            seen.add(start);
            ranges.push({ startLine: start, endLine: end, kind });
        }
    };
    walkSpans(file.source.decls, (node) => {
        if ("statements" in node || ["section", "modules", "dependencies", "using", "node", "block", "control", "routine", "handler", "exitPoint"].includes((node as { kind?: string }).kind ?? "")) add(node);
    });
    for (const comment of file.source.comments) add(comment, "comment");
    if (file.source.trailerStart !== undefined) {
        ranges.push({ startLine: map.positionAt(file.source.trailerStart).line, endLine: map.lineCount - 1, kind: "region" });
    }
    return ranges;
}

// ------------------------------------------------------------ selection ranges

export function selectionRanges(file: FileModel, offsets: number[]): SelectionRange[] {
    return offsets.map((offset) => {
        const chain: Span[] = [];
        walkSpans(file.source.decls, (node) => {
            if (node.start <= offset && offset <= node.end) chain.push({ start: node.start, end: node.end });
        });
        const token = file.source.tokens.find((t) => t.start <= offset && offset <= t.end);
        if (token) chain.push({ start: token.start, end: token.end });
        const unique = chain.filter((span, i) => !chain.slice(0, i).some((s) => s.start === span.start && s.end === span.end)).sort((a, b) => b.end - b.start - (a.end - a.start));
        let parent: SelectionRange | undefined;
        for (const span of unique) parent = { range: toRange(file, span), parent };
        return parent ?? { range: toRange(file, { start: offset, end: offset }) };
    });
}

/** Visits every AST object that has a span, depth first. */
export function walkSpans(root: unknown, visit: (node: Span & Record<string, unknown>) => void): void {
    const stack: unknown[] = [root];
    const seen = new Set<unknown>();
    while (stack.length) {
        const value = stack.pop();
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) stack.push(item);
            continue;
        }
        const node = value as Span & Record<string, unknown>;
        if (typeof node.start === "number" && typeof node.end === "number") visit(node);
        for (const key in node) {
            if (key === "scope" || key === "parent") continue;
            const child = node[key];
            if (child && typeof child === "object") stack.push(child);
        }
    }
}
