import type { SemanticTokensLegend } from "vscode-languageserver-types";
import type { Decl, Span, Stmt } from "../ast";
import { childBlocks, forEachBody, type AslSymbol, type FileModel } from "../binder";
import type { Program } from "../program";
import { lineMap } from "./common";

export const TOKEN_TYPES = ["namespace", "type", "class", "enum", "interface", "struct", "parameter", "variable", "property", "enumMember", "event", "function", "keyword", "string", "macro"] as const;
export const TOKEN_MODIFIERS = ["declaration", "readonly", "deprecated", "defaultLibrary", "static"] as const;

export const LEGEND: SemanticTokensLegend = { tokenTypes: [...TOKEN_TYPES], tokenModifiers: [...TOKEN_MODIFIERS] };

type TokenType = (typeof TOKEN_TYPES)[number];
type TokenModifier = (typeof TOKEN_MODIFIERS)[number];

interface RawToken {
    start: number;
    end: number;
    type: TokenType;
    modifiers: TokenModifier[];
}

function typeOfSymbol(symbol: AslSymbol): TokenType | undefined {
    switch (symbol.kind) {
        case "variable":
            return "variable";
        case "parameter":
            return "parameter";
        case "constant":
            return "variable";
        case "type":
            return symbol.type?.kind === "enumeration" ? "enum" : "type";
        case "field":
            return "property";
        case "enumMember":
            return "enumMember";
        case "cursor":
            return "variable";
        case "subroutine":
        case "function":
            return "function";
        case "node":
            return "class";
        case "block":
            return "interface";
        case "event":
            return "event";
        case "namespace":
            return "namespace";
        case "businessRecord":
            return "variable";
        case "control":
        case "image":
        case "exitPoint":
            return "macro";
        default:
            return undefined;
    }
}

/** Semantic tokens: resolved names (variables vs. functions vs. enums...) and context-dependent action keywords. */
export function semanticTokens(file: FileModel, program: Program, range?: Span): number[] {
    const raw: RawToken[] = [];
    const inRange = (span: Span): boolean => !range || (span.end >= range.start && span.start <= range.end);
    const push = (span: Span, type: TokenType, modifiers: TokenModifier[] = []): void => {
        if (span.end > span.start && inRange(span)) raw.push({ start: span.start, end: span.end, type, modifiers });
    };

    for (const symbol of file.symbols) {
        if (symbol.kind === "node" || symbol.kind === "block" || symbol.kind === "image" || symbol.kind === "control" || symbol.kind === "businessRecord") continue;
        const type = typeOfSymbol(symbol);
        if (!type) continue;
        const modifiers: TokenModifier[] = ["declaration"];
        if (symbol.kind === "constant") modifiers.push("readonly");
        push(symbol.nameSpan, type, modifiers);
    }

    for (const ref of file.references) {
        if (ref.inString) continue;
        for (const q of ref.qualifierSpans) push(q, "namespace");
        const resolution = program.resolve(file, ref);
        switch (resolution.kind) {
            case "symbol": {
                const symbol = resolution.symbols[0];
                const type = typeOfSymbol(symbol);
                if (!type) break;
                const modifiers: TokenModifier[] = [];
                if (symbol.kind === "constant") modifiers.push("readonly");
                push(ref.span, type, modifiers);
                break;
            }
            case "function":
                push(ref.span, "function", resolution.fn.deprecated ? ["defaultLibrary", "deprecated"] : ["defaultLibrary"]);
                break;
            case "attribute":
                push(ref.span, "variable", ["defaultLibrary", "readonly"]);
                break;
            case "enumMember":
                push(ref.span, "enumMember", ["defaultLibrary"]);
                break;
            case "enum":
                push(ref.span, "enum", ["defaultLibrary"]);
                break;
            case "field":
                push(ref.span, "property", ["defaultLibrary"]);
                break;
            case "business":
                push(ref.span, "variable", ["defaultLibrary"]);
                break;
            case "constant":
                push(ref.span, "variable", ["defaultLibrary", "readonly"]);
                break;
            case "record":
            case "builtinType":
                push(ref.span, "type", ["defaultLibrary"]);
                break;
            default:
                break;
        }
        if (ref.kind === "type" && resolution.kind === "unknown") push(ref.span, "type");
    }

    // Keywords of actions and graphical element clauses depend on the action, so TextMate cannot colour them reliably.
    const visitStmt = (stmt: Stmt): void => {
        if (stmt.kind === "action") for (const keyword of stmt.keywords) push(keyword, "keyword");
        for (const block of childBlocks(stmt)) block.statements.forEach(visitStmt);
    };
    forEachBody(file.source.decls, (body) => body.statements.forEach(visitStmt));
    const visitDecls = (decls: Decl[]): void => {
        for (const decl of decls) {
            if (decl.kind === "node" || decl.kind === "block") visitDecls(decl.members);
            if (decl.kind === "control") {
                for (const clause of decl.clauses) for (const keyword of clause.keywords) push(keyword, "keyword");
            }
        }
    };
    visitDecls(file.source.decls);

    raw.sort((a, b) => a.start - b.start || b.end - a.end);
    const map = lineMap(file);
    const data: number[] = [];
    let previousLine = 0;
    let previousChar = 0;
    let lastEnd = -1;
    for (const token of raw) {
        if (token.start < lastEnd) continue;
        const start = map.positionAt(token.start);
        const end = map.positionAt(token.end);
        if (end.line !== start.line) continue;
        const deltaLine = start.line - previousLine;
        const deltaChar = deltaLine === 0 ? start.character - previousChar : start.character;
        let modifiers = 0;
        for (const modifier of token.modifiers) modifiers |= 1 << TOKEN_MODIFIERS.indexOf(modifier);
        data.push(deltaLine, deltaChar, end.character - start.character, TOKEN_TYPES.indexOf(token.type), modifiers);
        previousLine = start.line;
        previousChar = start.character;
        lastEnd = token.end;
    }
    return data;
}
