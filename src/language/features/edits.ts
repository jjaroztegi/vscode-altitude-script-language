import type { CallHierarchyIncomingCall, CallHierarchyItem, CallHierarchyOutgoingCall, CodeAction, Diagnostic, InlayHint, Range, TextEdit } from "vscode-languageserver-types";
import type { ActionStmt, Decl, Span, Stmt } from "../ast";
import { childBlocks, forEachBody, type AslSymbol, type FileModel } from "../binder";
import { CONTROLS, controlDefs } from "../catalog";
import { collectKeywords } from "../template";
import { TokenKind, type Token } from "../lexer";
import type { Program } from "../program";
import type { Workspace } from "../workspace";
import { contains, lineMap, targetAt, toRange } from "./common";
import { findReferences } from "./navigation";
import { symbolKind, walkSpans } from "./outline";

// ------------------------------------------------------------ formatting

export interface FormatOptions {
    tabSize: number;
    insertSpaces: boolean;
}

/**
 * Re-indents lines from the brace structure. A block's contents sit one level below the line that opens it;
 * continuation lines sit at least one level deeper (deeper alignment chosen by the author is kept), and
 * comments keep their position unless they are outdented. Only leading and trailing whitespace changes.
 */
export function format(file: FileModel, options: FormatOptions, range?: { startLine: number; endLine: number }): TextEdit[] {
    const map = lineMap(file);
    const unit = options.insertSpaces ? " ".repeat(options.tabSize) : "	";
    const itemStarts = collectItemStarts(file.source.decls, file.source.tokens);
    const tokensByLine = new Map<number, Token[]>();
    for (const token of file.source.tokens) {
        if (token.kind === TokenKind.EOF) break;
        const line = map.positionAt(token.start).line;
        const list = tokensByLine.get(line);
        if (list) list.push(token);
        else tokensByLine.set(line, [token]);
    }
    const commentStarts = new Map<number, number>();
    const commentInner = new Set<number>();
    for (const comment of file.source.comments) {
        const first = map.positionAt(comment.start).line;
        const last = map.positionAt(comment.end).line;
        commentStarts.set(first, comment.start);
        for (let line = first + 1; line <= last; line += 1) commentInner.add(line);
    }

    const edits: TextEdit[] = [];
    const lastLine = file.source.trailerStart !== undefined ? map.positionAt(file.source.trailerStart).line - 1 : map.lineCount - 1;
    /** Level of the contents of each open brace. */
    const stack: number[] = [];
    let previous: Token | undefined;
    /** Level of the line where the current item started (continuation lines do not change it). */
    let itemLevel = 0;
    for (let line = 0; line <= lastLine; line += 1) {
        const lineText = map.lineText(line);
        const tokens = tokensByLine.get(line) ?? [];
        const trimmed = lineText.replace(/^[ 	]+/, "");
        const leading = lineText.length - trimmed.length;
        const current = lineText.slice(0, leading);
        const startOffset = map.lineStart(line) + leading;
        const base = stack.length ? stack[stack.length - 1] : 0;
        const first = tokens[0];
        let level = base;
        let keep = false;
        let continuation = false;
        if (commentInner.has(line) || trimmed.trim() === "") {
            keep = true;
        } else if (commentStarts.get(line) === startOffset) {
            keep = indentLevel(current, options.tabSize) >= base;
        } else if (first && first.start === startOffset) {
            if (first.kind === TokenKind.Punct && first.text === "}") {
                level = Math.max(0, base - 1);
            } else if (
                !itemStarts.has(first.start) &&
                !(first.kind === TokenKind.Punct && first.text === "{") &&
                !CLAUSE_LINE_WORDS.has(first.lower) &&
                !(previous?.kind === TokenKind.Punct && (previous.text === "{" || previous.text === "}"))
            ) {
                level = base + 1;
                keep = indentLevel(current, options.tabSize) >= level;
                continuation = true;
            }
        }
        let lineLevel = keep ? indentLevel(current, options.tabSize) : level;
        // A brace that ends a wrapped expression (`label 'a'` + `'b' {`, `if a` + `or b then {`) belongs to the
        // statement; a brace on a clause line of its own (`flow view {`) belongs to that line.
        const expressionLine = continuation && first !== undefined && (first.kind !== TokenKind.Identifier || ["and", "or", "xor", "not"].includes(first.lower));
        if (!continuation && first) itemLevel = lineLevel;
        const owner = expressionLine ? itemLevel : lineLevel;
        for (const token of tokens) {
            previous = token;
            if (token.kind !== TokenKind.Punct) continue;
            if (token.text === "{") stack.push(owner + 1);
            else if (token.text === "}") stack.pop();
        }
        if (range && (line < range.startLine || line > range.endLine)) continue;
        if (trimmed.trim() === "") {
            if (lineText.length > 0 && !commentInner.has(line)) edits.push({ range: { start: { line, character: 0 }, end: { line, character: lineText.length } }, newText: "" });
            continue;
        }
        if (commentInner.has(line)) continue;
        const consistent = options.insertSpaces ? !current.includes("	") : !current.includes(" ");
        const indent = keep && consistent ? current : unit.repeat(lineLevel);
        lineLevel = 0;
        if (current !== indent) {
            edits.push({ range: { start: { line, character: 0 }, end: { line, character: leading } }, newText: indent });
        }
        const trailing = trimmed.length - trimmed.replace(/[ 	]+$/, "").length;
        if (trailing > 0) {
            edits.push({ range: { start: { line, character: lineText.length - trailing }, end: { line, character: lineText.length } }, newText: "" });
        }
    }
    return edits;
}

/** Words that start a line of their own in the grammar even when they are not separate items. */
const CLAUSE_LINE_WORDS = new Set(["else", "until", "when", "default", "id", "without"]);

function indentLevel(whitespace: string, tabSize: number): number {
    let width = 0;
    for (const ch of whitespace) width += ch === "	" ? tabSize : 1;
    return Math.floor(width / tabSize);
}

/** Offsets where a declaration, statement, clause or section item starts (anything else on a new line continues it). */
function collectItemStarts(decls: Decl[], tokens: import("../lexer").Token[]): Set<number> {
    const starts = new Set<number>();
    const add = (span: Span): void => {
        starts.add(span.start);
    };
    const addClauses = (clauses: import("../ast").ControlClause[] | undefined): void => {
        for (const clause of clauses ?? []) {
            add(clause);
            addClauses(clause.children);
        }
    };
    const addType = (type: import("../ast").TypeRef | undefined): void => {
        if (type?.kind === "record") type.fields.forEach((f) => {
            add(f);
            addType(f.type);
        });
        if (type?.kind === "enumeration") type.members.forEach(add);
        if (type?.kind === "array") addType(type.element);
    };
    const addBlock = (block: import("../ast").Block | undefined): void => {
        if (!block) return;
        const visit = (statements: Stmt[]): void => {
            for (const stmt of statements) {
                add(stmt);
                if (stmt.kind === "var") addType(stmt.decl.type);
                if (stmt.kind === "action") addClauses(stmt.children);
                for (const child of childBlocks(stmt)) visit(child.statements);
            }
        };
        visit(block.statements);
    };
    const visit = (list: Decl[]): void => {
        for (const decl of list) {
            add(decl);
            switch (decl.kind) {
                case "section":
                    for (const item of decl.items) {
                        add(item);
                        if (item.kind === "variable" || item.kind === "type") addType(item.type);
                        if (item.kind === "extensionRecord") item.fields.forEach(add);
                    }
                    break;
                case "modules":
                    decl.imports.forEach(add);
                    break;
                case "dependencies":
                    decl.items.forEach(add);
                    break;
                case "using":
                    decl.items.forEach(add);
                    break;
                case "clause":
                    addClauses(decl.children);
                    break;
                case "node":
                case "block":
                    if (decl.master) add(decl.master.span);
                    visit(decl.members);
                    break;
                case "control": {
                    addClauses(decl.clauses);
                    // Lines starting with one of the element's keywords are clauses (`multiline` + `wordwrap`).
                    const def = CONTROLS.get(decl.control);
                    if (def) {
                        const keywords = new Set<string>();
                        for (const clause of def.clauses) collectKeywords(clause.pattern, controlDefs(def), keywords);
                        for (const token of tokens) {
                            if (token.start > decl.start && token.end < decl.end && token.lineBreakBefore && keywords.has(token.lower)) starts.add(token.start);
                        }
                    }
                    for (const handler of decl.handlers) {
                        add(handler);
                        addBlock(handler.body);
                    }
                    break;
                }
                case "routine":
                    addBlock(decl.body);
                    break;
                case "handler":
                case "exitPoint":
                case "functionKey":
                case "nodeLoop":
                    addBlock(decl.body);
                    break;
            }
        }
    };
    visit(decls);
    return starts;
}

// ------------------------------------------------------------ code actions

export interface DiagnosticWithData extends Diagnostic {
    data?: { fix?: string; replacement?: string; start?: number; end?: number };
}

export function codeActions(file: FileModel, uri: string, diagnostics: DiagnosticWithData[]): CodeAction[] {
    const actions: CodeAction[] = [];
    const map = lineMap(file);
    const offsetOf = (range: Range): Span => ({ start: map.offsetAt(range.start), end: map.offsetAt(range.end) });
    for (const diagnostic of diagnostics) {
        const data = diagnostic.data;
        const code = typeof diagnostic.code === "string" ? diagnostic.code : undefined;
        if (data?.fix === "replace" && data.replacement) {
            actions.push({ title: `Replace with '${data.replacement}'`, kind: "quickfix", isPreferred: true, diagnostics: [diagnostic], edit: { changes: { [uri]: [{ range: diagnostic.range, newText: data.replacement }] } } });
        }
        if (data?.fix === "remove-range" && data.start !== undefined && data.end !== undefined) {
            let start = data.start;
            while (start > 0 && /[ \t]/.test(file.source.text[start - 1])) start -= 1;
            actions.push({ title: "Remove the fixed position", kind: "quickfix", isPreferred: true, diagnostics: [diagnostic], edit: { changes: { [uri]: [{ range: toRange(file, { start, end: data.end }), newText: "" }] } } });
        }
        if (data?.fix === "modal-to-overlay") {
            const stmt = actionAt(file, offsetOf(diagnostic.range).start);
            if (stmt) {
                const words = stmt.keywords.map((k) => ({ span: k, word: file.source.text.slice(k.start, k.end).toLowerCase() }));
                const modal = words.find((w) => w.word === "modal");
                const before = words.find((w) => ["on", "with", "id", "arguments"].includes(w.word) && w.span.start > (modal?.span.end ?? 0));
                if (modal) {
                    const edits: TextEdit[] = [{ range: toRange(file, { start: modal.span.start, end: modal.span.end + 1 }), newText: "" }];
                    const insertAt = before ? before.span.start : stmt.end;
                    edits.push({ range: toRange(file, { start: insertAt, end: insertAt }), newText: before ? "overlay " : " overlay" });
                    actions.push({ title: "Convert to an overlay window (then move the result handling to 'on close trigger event')", kind: "quickfix", diagnostics: [diagnostic], edit: { changes: { [uri]: edits } } });
                }
            }
        }
        if (code && code !== "syntax") {
            const offset = offsetOf(diagnostic.range).start;
            if (actionAt(file, offset) || insideActionBlock(file, offset)) {
                const line = diagnostic.range.start.line;
                const lineText = map.lineText(line);
                const indent = lineText.match(/^[ \t]*/)?.[0] ?? "";
                const eol = file.source.text.includes("\r\n") ? "\r\n" : "\n";
                actions.push({ title: `Suppress '${code}' on this line`, kind: "quickfix", diagnostics: [diagnostic], edit: { changes: { [uri]: [{ range: { start: { line, character: 0 }, end: { line, character: 0 } }, newText: `${indent}comment {asl-disable-next-line ${code}}${eol}` }] } } });
            }
            actions.push({ title: `Turn off '${code}' in settings`, kind: "quickfix", diagnostics: [diagnostic], command: { title: "Turn off rule", command: "altitudeScriptLanguage.disableRule", arguments: [code] } });
        }
    }
    return actions;
}

function actionAt(file: FileModel, offset: number): ActionStmt | undefined {
    let found: ActionStmt | undefined;
    forEachBody(file.source.decls, (body) => {
        const visit = (statements: Stmt[]): void => {
            for (const stmt of statements) {
                if (!contains(stmt, offset)) continue;
                if (stmt.kind === "action") found = stmt;
                for (const block of childBlocks(stmt)) visit(block.statements);
            }
        };
        if (contains(body, offset)) visit(body.statements);
    });
    return found;
}

function insideActionBlock(file: FileModel, offset: number): boolean {
    let inside = false;
    forEachBody(file.source.decls, (body) => {
        if (offset > body.start && offset < body.end) inside = true;
    });
    return inside;
}

// ------------------------------------------------------------ inlay hints

export function inlayHints(workspace: Workspace, file: FileModel, program: Program, range: Span): InlayHint[] {
    const hints: InlayHint[] = [];
    walkSpans(file.source.decls, (node) => {
        const expr = node as unknown as import("../ast").Expr;
        if (expr.kind !== "call" && !((node as { kind?: string }).kind === "call" && "callee" in node)) return;
        if (node.start > range.end || node.end < range.start) return;
        const call = node as unknown as { callee: import("../ast").Expr; args: import("../ast").Arg[] };
        if (call.callee.kind !== "name" || call.args.length === 0) return;
        const calleeName = call.callee.name;
        const ref = file.references.find((r) => r.span.start === calleeName.start && (r.kind === "call" || r.kind === "routine"));
        if (!ref) return;
        const resolution = program.resolve(file, ref);
        let names: string[] = [];
        if (resolution.kind === "function") names = resolution.fn.params.map((p) => p.name);
        else if (resolution.kind === "symbol" && resolution.symbols[0].params) names = resolution.symbols[0].params.map((p) => p.name.text);
        call.args.forEach((arg, index) => {
            const name = names[index];
            if (!name) return;
            const argText = file.source.text.slice(arg.expr.start, arg.expr.end);
            if (argText.toLowerCase() === name.toLowerCase() || argText.toLowerCase().endsWith(`.${name.toLowerCase()}`)) return;
            hints.push({ position: lineMap(file).positionAt(arg.start), label: `${name}:`, kind: 2, paddingRight: true });
        });
    });
    void workspace;
    return hints;
}

// ------------------------------------------------------------ call hierarchy

export function prepareCallHierarchy(workspace: Workspace, file: FileModel, program: Program, offset: number): CallHierarchyItem[] {
    const target = targetAt(workspace, file, program, offset);
    return (target?.symbols ?? []).filter((s) => ["subroutine", "function", "node", "event"].includes(s.kind)).map((s) => hierarchyItem(workspace, s)).filter((i): i is CallHierarchyItem => i !== undefined);
}

function hierarchyItem(workspace: Workspace, symbol: AslSymbol): CallHierarchyItem | undefined {
    const file = workspace.model(symbol.uri);
    if (!file) return undefined;
    return { name: symbol.name, kind: symbolKind(symbol), uri: symbol.uri, range: toRange(file, symbol.span), selectionRange: toRange(file, symbol.nameSpan), detail: symbol.container?.name, data: { offset: symbol.nameSpan.start } };
}

function symbolFromItem(workspace: Workspace, item: CallHierarchyItem): AslSymbol | undefined {
    const file = workspace.model(item.uri);
    const offset = (item.data as { offset?: number } | undefined)?.offset;
    return file?.symbols.find((s) => s.nameSpan.start === offset);
}

/** The routine, handler or node whose body contains an offset. */
function containerAt(file: FileModel, offset: number): AslSymbol | undefined {
    let best: AslSymbol | undefined;
    for (const symbol of file.symbols) {
        if (!["subroutine", "function", "node", "block", "event"].includes(symbol.kind)) continue;
        if (contains(symbol.span, offset) && (!best || symbol.span.end - symbol.span.start < best.span.end - best.span.start)) best = symbol;
    }
    return best;
}

export function incomingCalls(workspace: Workspace, item: CallHierarchyItem): CallHierarchyIncomingCall[] {
    const symbol = symbolFromItem(workspace, item);
    if (!symbol) return [];
    const byCaller = new Map<string, CallHierarchyIncomingCall>();
    for (const location of findReferences(workspace, [symbol], false)) {
        const file = workspace.model(location.uri);
        if (!file) continue;
        const offset = lineMap(file).offsetAt(location.range.start);
        const caller = containerAt(file, offset);
        const callerItem: CallHierarchyItem | undefined = caller ? hierarchyItem(workspace, caller) : { name: decodeURIComponent(location.uri.split("/").pop() ?? ""), kind: 1, uri: location.uri, range: location.range, selectionRange: location.range };
        if (!callerItem) continue;
        const key = `${callerItem.uri}:${callerItem.selectionRange.start.line}:${callerItem.name}`;
        const entry: CallHierarchyIncomingCall = byCaller.get(key) ?? { from: callerItem, fromRanges: [] };
        entry.fromRanges.push(location.range);
        byCaller.set(key, entry);
    }
    return [...byCaller.values()];
}

export function outgoingCalls(workspace: Workspace, item: CallHierarchyItem): CallHierarchyOutgoingCall[] {
    const symbol = symbolFromItem(workspace, item);
    const file = symbol ? workspace.model(symbol.uri) : undefined;
    const program = symbol ? workspace.program(symbol.uri) : undefined;
    if (!symbol || !file || !program) return [];
    const byTarget = new Map<string, CallHierarchyOutgoingCall>();
    for (const ref of file.references) {
        if (!contains(symbol.span, ref.span.start)) continue;
        if (!["routine", "call", "node", "event"].includes(ref.kind)) continue;
        const resolution = program.resolve(file, ref);
        if (resolution.kind !== "symbol") continue;
        const target = resolution.symbols.find((s) => ["subroutine", "function", "node", "event"].includes(s.kind));
        if (!target || target === symbol) continue;
        const targetItem = hierarchyItem(workspace, target);
        if (!targetItem) continue;
        const key = `${target.uri}:${target.nameSpan.start}`;
        const entry: CallHierarchyOutgoingCall = byTarget.get(key) ?? { to: targetItem, fromRanges: [] };
        entry.fromRanges.push(toRange(file, ref.span));
        byTarget.set(key, entry);
    }
    return [...byTarget.values()];
}

export function isDecl(value: unknown): value is Decl {
    return typeof value === "object" && value !== null && "kind" in value;
}
