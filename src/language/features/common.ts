import type { Location, Range } from "vscode-languageserver-types";
import type { NodeDecl, Span } from "../ast";
import type { AslSymbol, FileModel, Reference, Scope } from "../binder";
import { ACTIONS, docsUrl, type ActionDef, type AttributeDef, type EnumDef, type FunctionDef } from "../catalog";
import { LineMap, TokenKind, type Token } from "../lexer";
import type { Program, Resolution } from "../program";
import type { Workspace } from "../workspace";

const lineMaps = new WeakMap<FileModel, LineMap>();

export function lineMap(file: FileModel): LineMap {
    let map = lineMaps.get(file);
    if (!map) {
        map = new LineMap(file.source.text);
        lineMaps.set(file, map);
    }
    return map;
}

export function toRange(file: FileModel, span: Span): Range {
    const map = lineMap(file);
    return { start: map.positionAt(span.start), end: map.positionAt(span.end) };
}

export function toLocation(workspace: Workspace, symbol: AslSymbol): Location | undefined {
    const file = workspace.model(symbol.uri);
    if (!file) return undefined;
    return { uri: symbol.uri, range: toRange(file, symbol.nameSpan) };
}

export function contains(span: Span, offset: number): boolean {
    return offset >= span.start && offset <= span.end;
}

/** Token at or immediately before an offset. */
export function tokenAt(file: FileModel, offset: number): Token | undefined {
    const tokens = file.source.tokens;
    let low = 0;
    let high = tokens.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const token = tokens[mid];
        if (offset < token.start) high = mid - 1;
        else if (offset > token.end) low = mid + 1;
        else return token.kind === TokenKind.EOF ? undefined : token;
    }
    return undefined;
}

export function tokenIndexBefore(file: FileModel, offset: number): number {
    const tokens = file.source.tokens;
    let index = -1;
    for (let i = 0; i < tokens.length && tokens[i].start < offset; i += 1) index = i;
    return index;
}

export function referenceAt(file: FileModel, offset: number): Reference | undefined {
    let best: Reference | undefined;
    for (const ref of file.references) {
        if (contains(ref.span, offset) && (!best || ref.span.end - ref.span.start < best.span.end - best.span.start)) best = ref;
        for (let i = 0; i < ref.qualifierSpans.length; i += 1) {
            if (contains(ref.qualifierSpans[i], offset)) return { ...ref, kind: "namespace", name: ref.qualifier[i], qualifier: ref.qualifier.slice(0, i), qualifierSpans: ref.qualifierSpans.slice(0, i), span: ref.qualifierSpans[i] };
        }
    }
    return best;
}

export function declarationAt(file: FileModel, offset: number): AslSymbol | undefined {
    return file.symbols.find((symbol) => contains(symbol.nameSpan, offset));
}

/** Innermost scope containing an offset. */
export function scopeAt(file: FileModel, offset: number): Scope {
    let best = file.root;
    for (const scope of file.scopes) {
        if (scope.span.start <= offset && offset <= scope.span.end && scope.span.end - scope.span.start <= best.span.end - best.span.start) best = scope;
    }
    return best;
}

export function nodeAt(file: FileModel, offset: number): NodeDecl | undefined {
    return file.source.decls.find((d): d is NodeDecl => (d.kind === "node" || d.kind === "block") && contains(d, offset));
}

export interface Target {
    symbols: AslSymbol[];
    resolution?: Resolution;
    reference?: Reference;
    namespaceTarget?: FileModel;
}

/** What the name at a position refers to: declared symbols, or a built-in. */
export function targetAt(workspace: Workspace, file: FileModel, program: Program, offset: number): Target | undefined {
    const declared = declarationAt(file, offset);
    if (declared) return { symbols: [declared] };
    const ref = referenceAt(file, offset);
    if (!ref) {
        const importItem = file.imports.find((item) => item.namespaceSpan && contains(item.namespaceSpan, offset));
        if (importItem) {
            const symbol = file.root.symbols.get(importItem.namespace!.toLowerCase())?.[0];
            return symbol ? { symbols: [symbol] } : undefined;
        }
        return undefined;
    }
    if (ref.kind === "namespace") {
        let current: FileModel | undefined = file;
        for (const part of ref.qualifier) current = current ? (program.namespaceTarget(current, part) ?? undefined) : undefined;
        const target = current ? program.namespaceTarget(current, ref.name) : undefined;
        const symbol = current?.root.symbols.get(ref.name.toLowerCase())?.find((s) => s.kind === "namespace");
        if (target || symbol) return { symbols: symbol ? [symbol] : [], namespaceTarget: target ?? undefined, reference: ref };
        // Not a namespace: an enumeration qualifier.
        const enumResolution = program.resolveType(file, ref.scope, ref.name, ref.qualifier);
        return { symbols: enumResolution.kind === "symbol" ? enumResolution.symbols : [], resolution: enumResolution, reference: ref };
    }
    const resolution = program.resolve(file, ref);
    void workspace;
    return { symbols: resolution.kind === "symbol" ? resolution.symbols : [], resolution, reference: ref };
}

// ------------------------------------------------------------ markdown

const FENCE = "```altitude-asl";

export function link(url: string | undefined, label = "Altitude 8.7 reference"): string {
    const full = docsUrl(url);
    return full ? `[${label}](${full})` : "";
}

export function symbolSignature(symbol: AslSymbol, text: (span: Span) => string): string {
    const type = symbol.type ? `: ${text(symbol.type)}` : "";
    const params = symbol.params?.map((p) => `${p.isRef ? "ref " : ""}${p.name.text}${p.type ? `: ${text(p.type)}` : ""}`).join(", ") ?? "";
    switch (symbol.kind) {
        case "subroutine":
            return `${symbol.isPrivate ? "private " : ""}subroutine ${symbol.name}(${params})`;
        case "function":
            return `${symbol.isPrivate ? "private " : ""}function ${symbol.name}(${params})${type}`;
        case "node":
            return `node "${symbol.name}"`;
        case "block":
            return `block "${symbol.name}"`;
        case "event":
            return `on event ${symbol.name}(${params})`;
        case "constant":
            return `const ${symbol.name}${symbol.detail ? ` := ${symbol.detail}` : ""}`;
        case "cursor":
            return `${symbol.name}: ${symbol.detail ?? ""} cursor`;
        case "type":
            return `type ${symbol.name}${symbol.type ? ` = ${text(symbol.type).split("\n")[0]}` : ""}`;
        case "namespace":
            return `namespace ${symbol.name}  // ${symbol.detail ?? ""}`;
        case "image":
            return `image "${symbol.name}"`;
        case "dll":
            return `${symbol.detail ?? "dll"} "${symbol.name}"`;
        case "control":
            return `${symbol.detail ?? "control"} "${symbol.name}"`;
        case "businessRecord":
            return `${symbol.name}: ${symbol.detail ?? "record"}`;
        case "exitPoint":
            return `exit point ${symbol.name}`;
        case "enumMember":
            return `${symbol.container?.name ?? ""}::${symbol.name}`;
        case "parameter":
            return `${symbol.detail === "ref" ? "ref " : ""}${symbol.name}${type}  // parameter`;
        case "field":
            return `${symbol.container ? `${symbol.container.name}.` : ""}${symbol.name}${type}`;
        default:
            return `${symbol.isLocal ? "var " : ""}${symbol.name}${type}`;
    }
}

export function symbolMarkdown(workspace: Workspace, symbol: AslSymbol, from: FileModel): string {
    const owner = workspace.model(symbol.uri) ?? from;
    const text = (span: Span): string => owner.source.text.slice(span.start, span.end).replace(/\s+/g, " ");
    const parts = [`${FENCE}\n${symbolSignature(symbol, text)}\n\`\`\``];
    if (symbol.doc) parts.push(symbol.doc);
    const where: string[] = [];
    if (symbol.container && symbol.kind !== "field" && symbol.kind !== "enumMember") where.push(`in ${symbol.container.kind} \`${symbol.container.name}\``);
    if (symbol.uri !== from.uri) where.push(`from \`${decodeURIComponent(symbol.uri.split("/").pop() ?? "")}\``);
    if (symbol.isPrivate) where.push("private");
    if (where.length) parts.push(`*${where.join(" · ")}*`);
    return parts.join("\n\n");
}

export function functionMarkdown(fn: FunctionDef): string {
    const parts = [`${FENCE}\n${[fn.signature, ...(fn.overloads ?? [])].join("\n")}\n\`\`\``, fn.doc];
    const params = fn.params.filter((p) => p.doc).map((p) => `- \`${p.name}\`${p.optional ? " (optional)" : ""}: ${p.doc}`);
    if (params.length) parts.push(params.join("\n"));
    if (fn.deprecated) parts.push("**Deprecated.**");
    if (fn.webNotes) parts.push(`**Agent Portal:** ${fn.webNotes}`);
    parts.push(link(fn.url));
    return parts.filter(Boolean).join("\n\n");
}

export function attributeMarkdown(attribute: AttributeDef): string {
    const fields = attribute.fields.slice(0, 40).map((f) => `- \`${f.name}\`${f.type ? `: ${f.type}` : ""}${f.doc ? ` — ${f.doc}` : ""}`);
    return [`${FENCE}\n${attribute.name}${attribute.type ? `: ${attribute.type}` : ""}\n\`\`\``, attribute.doc, fields.join("\n"), link(attribute.url)].filter(Boolean).join("\n\n");
}

export function enumMarkdown(def: EnumDef, member?: EnumDef["members"][number]): string {
    if (member) {
        return [`${FENCE}\n${def.name}::${member.name}${member.value !== undefined ? ` = ${member.value}` : ""}\n\`\`\``, member.doc ?? "", link(def.url)].filter(Boolean).join("\n\n");
    }
    const members = def.members.slice(0, 30).map((m) => `\`${m.name}\``).join(", ");
    return [`${FENCE}\n${def.name}: enumeration\n\`\`\``, members + (def.members.length > 30 ? `, … (${def.members.length})` : ""), link(def.url)].filter(Boolean).join("\n\n");
}

export function actionMarkdown(action: ActionDef): string {
    const parts = [`${FENCE}\n${action.syntax.join("\n")}\n\`\`\``, action.doc];
    if (action.web) parts.push(`**Agent Portal:** ${action.web.message}`);
    if (action.deprecated) parts.push(`**Deprecated:** ${action.deprecated}`);
    parts.push(link(action.url));
    return parts.filter(Boolean).join("\n\n");
}

export function actionByIndex(index: number): ActionDef | undefined {
    return index >= 0 ? ACTIONS[index] : undefined;
}

/** Fuzzy match used by workspace symbols: query characters in order. */
export function fuzzyMatch(query: string, name: string): boolean {
    if (!query) return true;
    const q = query.toLowerCase();
    const n = name.toLowerCase();
    let i = 0;
    for (const ch of n) {
        if (ch === q[i]) i += 1;
        if (i === q.length) return true;
    }
    return false;
}
