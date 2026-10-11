import type { CompletionItem, CompletionItemKind, CompletionList, MarkupContent, ParameterInformation, SignatureHelp, SignatureInformation } from "vscode-languageserver-types";
import type { ControlDecl, Decl, NodeDecl, Span, Stmt } from "../ast";
import { childBlocks, type AslSymbol, type FileModel, type Scope } from "../binder";
import { ACTIONS, ATTRIBUTES, BUILTIN_TYPES, BUSINESS_VARIABLES, CONTROLS, ENUMS, EVENTS, FUNCTIONS, RECORDS, type ActionDef, type ControlDef } from "../catalog";
import { TokenKind, type Token } from "../lexer";
import { parseExpressionAt } from "../parser";
import type { Program } from "../program";
import type { Pattern } from "../template";
import type { Workspace } from "../workspace";
import { actionMarkdown, attributeMarkdown, contains, enumMarkdown, functionMarkdown, link, scopeAt, symbolMarkdown, symbolSignature } from "./common";

// LSP CompletionItemKind values.
const CK = { Text: 1, Method: 2, Function: 3, Field: 5, Variable: 6, Class: 7, Interface: 8, Module: 9, Property: 10, Value: 12, Enum: 13, Keyword: 14, Snippet: 15, File: 17, Reference: 18, EnumMember: 20, Constant: 21, Struct: 22, Event: 23 } as const;
const SNIPPET = 2;

type Context =
    | { kind: "top" }
    | { kind: "node"; node: NodeDecl }
    | { kind: "control"; control: ControlDecl; def: ControlDef }
    | { kind: "section"; section: string }
    | { kind: "actions"; node?: NodeDecl };

export function complete(workspace: Workspace, file: FileModel, program: Program, offset: number): CompletionList {
    const text = file.source.text;
    const items: CompletionItem[] = [];
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const linePrefix = text.slice(lineStart, offset);
    if (file.source.comments.some((c) => c.start < offset && offset < c.end)) return { isIncomplete: false, items };
    const scope = scopeAt(file, offset);
    const md = (value: string): MarkupContent => ({ kind: "markdown", value });

    // Inside a string literal: node, image, control and block names.
    const stringToken = file.source.tokens.find((t) => (t.kind === TokenKind.String || t.kind === TokenKind.Fib) && t.start < offset && (offset < t.end || (offset === t.end && !/["'>]$/.test(t.text))));
    if (stringToken) {
        const inInterpolation = stringToken.parts?.some((p) => p.start <= offset && offset <= p.end);
        if (!inInterpolation) {
            stringNameCompletions(workspace, file, program, stringToken, items);
            return { isIncomplete: false, items };
        }
    }

    // Member access: `record.field`, `@attribute.field`.
    const member = linePrefix.match(/((?:@?[\p{L}_][\p{L}\p{N}_]*|\))(?:::[\p{L}_][\p{L}\p{N}_]*)*(?:\[[^\]]*\]|\([^()]*\))?(?:\.[\p{L}_][\p{L}\p{N}_]*(?:\[[^\]]*\]|\([^()]*\))?)*)\.([\p{L}\p{N}_]*)$/u);
    if (member && !/::$/.test(member[1])) {
        const chainStart = lineStart + linePrefix.length - member[0].length;
        const expr = parseExpressionAt(text, chainStart, chainStart + member[1].length);
        if (expr) {
            const type = program.typeOf(file, expr, scope);
            if (type.kind === "record") {
                for (const field of type.fields.values()) {
                    items.push({ label: field.name, kind: CK.Field, detail: field.symbol ? symbolSignature(field.symbol, (s) => (workspace.model(field.symbol!.uri) ?? file).source.text.slice(s.start, s.end)) : field.def?.type, documentation: field.def?.doc ? md(field.def.doc) : field.symbol?.doc ? md(field.symbol.doc) : undefined });
                }
            }
        }
        return { isIncomplete: false, items };
    }

    // Qualified names: `Namespace::name`, `Enum::member`.
    const qualified = linePrefix.match(/([\p{L}_][\p{L}\p{N}_]*(?:::[\p{L}_][\p{L}\p{N}_]*)*)::([\p{L}\p{N}_]*)$/u);
    if (qualified) {
        qualifiedCompletions(workspace, file, program, scope, qualified[1].split("::"), items);
        return { isIncomplete: false, items };
    }

    if (/@[\p{L}\p{N}_]*$/u.test(linePrefix)) {
        for (const attribute of ATTRIBUTES.values()) {
            items.push({ label: attribute.name, kind: CK.Variable, detail: attribute.type, documentation: md(attributeMarkdown(attribute)), filterText: attribute.name, insertText: attribute.name.slice(1) });
        }
        return { isIncomplete: false, items };
    }

    const context = contextAt(file, offset);
    const tokens = file.source.tokens;
    const wordStart = offset - (linePrefix.match(/[\p{L}\p{N}_]*$/u)?.[0].length ?? 0);
    let prevIndex = -1;
    for (let i = 0; i < tokens.length && tokens[i].end <= wordStart; i += 1) prevIndex = i;
    const prev = prevIndex >= 0 ? tokens[prevIndex] : undefined;
    const prev2 = prevIndex >= 1 ? tokens[prevIndex - 1] : undefined;
    const prevWords = (n: number): string =>
        tokens
            .slice(Math.max(0, prevIndex - n + 1), prevIndex + 1)
            .map((t) => t.lower)
            .join(" ");

    // Import paths.
    if (context.kind === "section" && context.section === "modules") {
        moduleFileCompletions(workspace, file, items);
        items.push(snippet("import", 'import <"${1:Module.agm}"> into namespace ${2:Name}', "Import a module"));
        return { isIncomplete: false, items };
    }

    // Type positions: `name: |` in declarations and parameter lists.
    if (prev?.text === ":" && (context.kind !== "actions" || prev2?.kind === TokenKind.Identifier) && isTypePosition(tokens, prevIndex)) {
        typeCompletions(file, program, scope, items);
        return { isIncomplete: false, items };
    }
    if (prev && prevWords(2) === "array of") {
        typeCompletions(file, program, scope, items);
        return { isIncomplete: false, items };
    }

    switch (context.kind) {
        case "top":
            topLevelCompletions(file, items);
            return { isIncomplete: false, items };
        case "section":
            return { isIncomplete: false, items };
        case "node":
            nodeCompletions(context.node, items);
            return { isIncomplete: false, items };
        case "control":
            controlCompletions(context.def, items);
            return { isIncomplete: false, items };
        case "actions":
            break;
    }

    // Action blocks.
    const last2 = prevWords(2);
    const last3 = prevWords(3);
    if (["open cursor", "close cursor", "fetch cursor"].includes(last2) || last2 === "table for") {
        symbolCompletions(workspace, file, program, scope, offset, items, (s) => s.kind === "cursor");
        return { isIncomplete: false, items };
    }
    if (last2 === "trigger event" || last3 === "set timer event" || last2 === "handler from" || last2 === "handler to") {
        const events = new Map<string, AslSymbol>();
        for (const f of program.files) for (const nodeScope of f.nodeScopes.values()) for (const list of nodeScope.symbols.values()) for (const s of list) if (s.kind === "event" && !events.has(s.key)) events.set(s.key, s);
        for (const event of events.values()) items.push({ label: event.name, kind: CK.Event, detail: symbolSignature(event, (s) => (workspace.model(event.uri) ?? file).source.text.slice(s.start, s.end)) });
        return { isIncomplete: false, items };
    }
    if (last2 === "exit through") {
        symbolCompletions(workspace, file, program, scope, offset, items, (s) => s.kind === "exitPoint");
        return { isIncomplete: false, items };
    }
    if (prev?.lower === "call") {
        symbolCompletions(workspace, file, program, scope, offset, items, (s) => s.kind === "subroutine" || s.kind === "function");
        items.push(keyword("node"), keyword("master event handler"), keyword("supervisor phone"));
        return { isIncomplete: false, items };
    }
    if (prev?.lower === "goto") {
        items.push(keyword("node"));
        return { isIncomplete: false, items };
    }

    const statementStart = !prev || prev.text === "{" || prev.text === "}" || ["then", "else", "do"].includes(prev.lower) || (prev.lineBreakBefore !== undefined && isLineStart(text, wordStart) && !continuesStatement(prev));
    const enclosing = statementAt(file, wordStart);
    if (statementStart) {
        statementCompletions(items);
        for (const action of uniqueActions()) items.push(actionCompletion(action));
    } else if (enclosing?.kind === "action" && enclosing.action >= 0) {
        const action = ACTIONS[enclosing.action];
        const used = new Set(enclosing.keywords.map((k) => text.slice(k.start, k.end).toLowerCase()));
        for (const word of action.keywords) if (!used.has(word)) items.push({ ...keyword(word), sortText: `0${word}` });
    } else if (enclosing?.kind === "if" && !text.slice(enclosing.start, wordStart).includes("then")) {
        items.push({ ...keyword("then"), sortText: "0then" });
    }
    valueCompletions(workspace, file, program, scope, offset, items, statementStart);
    return { isIncomplete: false, items };
}

// ------------------------------------------------------------ context

function contextAt(file: FileModel, offset: number): Context {
    const inBody = (decl: { start: number; end: number }, bodyStart: number): boolean => offset > bodyStart && offset < decl.end;
    for (const decl of file.source.decls) {
        if (!contains(decl, offset)) continue;
        const found = declContext(decl, offset, inBody);
        if (found) return found;
    }
    return { kind: "top" };
}

function declContext(decl: Decl, offset: number, inBody: (d: Span, bodyStart: number) => boolean, node?: NodeDecl): Context | undefined {
    switch (decl.kind) {
        case "node":
        case "block": {
            if (!inBody(decl, decl.name.end)) return undefined;
            for (const member of decl.members) {
                if (contains(member, offset)) {
                    const found = declContext(member, offset, inBody, decl);
                    if (found) return found;
                }
            }
            return { kind: "node", node: decl };
        }
        case "control": {
            const def = CONTROLS.get(decl.control);
            for (const handler of decl.handlers) {
                if (contains(handler.body, offset) && offset > handler.body.start) return { kind: "actions", node };
            }
            if (def && offset > (decl.name?.end ?? decl.keyword.end)) return { kind: "control", control: decl, def };
            return undefined;
        }
        case "handler":
        case "exitPoint":
        case "functionKey":
        case "nodeLoop":
            return offset > decl.body.start && offset <= decl.body.end ? { kind: "actions", node } : undefined;
        case "routine":
            return decl.body && offset > decl.body.start && offset <= decl.body.end ? { kind: "actions", node } : undefined;
        case "section":
            return offset > decl.keyword.end ? { kind: "section", section: decl.section } : undefined;
        case "modules":
            return { kind: "section", section: "modules" };
        case "dependencies":
            return { kind: "section", section: "dependencies" };
        default:
            return undefined;
    }
}

function statementAt(file: FileModel, offset: number): Stmt | undefined {
    let found: Stmt | undefined;
    const visit = (statements: Stmt[]): void => {
        for (const stmt of statements) {
            if (stmt.start <= offset && offset <= stmt.end + 1) {
                found = stmt;
                for (const block of childBlocks(stmt)) if (contains(block, offset)) visit(block.statements);
            }
        }
    };
    const visitDecls = (decls: Decl[]): void => {
        for (const decl of decls) {
            if (!contains(decl, offset)) continue;
            if (decl.kind === "node" || decl.kind === "block") visitDecls(decl.members);
            else if (decl.kind === "routine" && decl.body) visit(decl.body.statements);
            else if (decl.kind === "handler" || decl.kind === "exitPoint" || decl.kind === "functionKey" || decl.kind === "nodeLoop") visit(decl.body.statements);
            else if (decl.kind === "control") decl.handlers.forEach((h) => contains(h.body, offset) && visit(h.body.statements));
        }
    };
    visitDecls(file.source.decls);
    return found;
}

function isLineStart(text: string, offset: number): boolean {
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    return /^\s*$/.test(text.slice(lineStart, offset));
}

/** The previous token leaves the statement open (operator, comma, assignment, opening parenthesis). */
function continuesStatement(token: Token): boolean {
    return token.kind === TokenKind.Punct ? [",", ":=", "(", "[", "=", "<>", "<", ">", "<=", ">=", "+", "-", "*", "/", "::", "."].includes(token.text) : ["and", "or", "xor", "not", "into", "to", "variable", "record", "values", "arguments", "if"].includes(token.lower);
}

function isTypePosition(tokens: Token[], colonIndex: number): boolean {
    const name = tokens[colonIndex - 1];
    if (!name || name.kind !== TokenKind.Identifier) return false;
    const before = tokens[colonIndex - 2];
    // `var x:`, a declaration at line start, a parameter after `(` or `,`, or a function result `): `.
    return !before || before.lower === "var" || before.text === "(" || before.text === "," || before.lower === "ref" || name.lineBreakBefore || before.text === "{";
}

// ------------------------------------------------------------ item builders

function keyword(word: string): CompletionItem {
    return { label: word, kind: CK.Keyword };
}

function snippet(label: string, body: string, detail: string, documentation?: string): CompletionItem {
    return { label, kind: CK.Snippet, insertText: body, insertTextFormat: SNIPPET, detail, documentation: documentation ? { kind: "markdown", value: documentation } : undefined };
}

let uniqueActionsCache: ActionDef[] | undefined;
function uniqueActions(): ActionDef[] {
    if (!uniqueActionsCache) {
        const seen = new Set<string>();
        uniqueActionsCache = [];
        for (const action of ACTIONS) {
            const key = `${action.phrase}|${action.name}`;
            if (seen.has(key) || action.web || action.name === "web browser legacy action") continue;
            seen.add(key);
            uniqueActionsCache.push(action);
        }
    }
    return uniqueActionsCache;
}

/** Turns the first syntax of an action into a snippet: keywords and the mandatory slots before the first option. */
export function actionSnippet(action: ActionDef): string {
    const pattern = action.patterns[0];
    const items = pattern.t === "seq" ? pattern.items : [pattern];
    const parts: string[] = [];
    let index = 1;
    const render = (p: Pattern): boolean => {
        switch (p.t) {
            case "lit":
                parts.push(p.word);
                return true;
            case "slot":
                if (p.cls === "actions") {
                    parts.push("{\n\t$0\n}");
                    return true;
                }
                parts.push(`\${${index++}:${p.placeholder}}`);
                return true;
            case "seq":
                return p.items.every(render);
            case "brace":
                parts.push("{\n\t$0\n}");
                return true;
            default:
                return false;
        }
    };
    for (const item of items) {
        if (!render(item)) break;
    }
    return parts.join(" ").replace(/ ,/g, ",").replace(/\( /g, "(").replace(/ \)/g, ")");
}

function actionCompletion(action: ActionDef): CompletionItem {
    const label = action.phrase === action.name.toLowerCase() || !action.phrase ? action.name.toLowerCase() : `${action.phrase} … ${action.name.toLowerCase()}`;
    return {
        label,
        kind: CK.Keyword,
        detail: action.syntax[0].length > 80 ? `${action.syntax[0].slice(0, 77)}…` : action.syntax[0],
        documentation: { kind: "markdown", value: actionMarkdown(action) },
        insertText: actionSnippet(action),
        insertTextFormat: SNIPPET,
        filterText: label.replace(" … ", " "),
        tags: action.deprecated ? [1] : undefined,
        sortText: `5${label}`
    };
}

function statementCompletions(items: CompletionItem[]): void {
    items.push(
        snippet("if", "if ${1:condition} then {\n\t$0\n}", "if … then { }"),
        snippet("if else", "if ${1:condition} then {\n\t$2\n}\nelse {\n\t$0\n}", "if … then { } else { }"),
        snippet("case", "case ${1:expression} {\n\twhen ${2:value} do {\n\t\t$0\n\t}\n\tdefault {}\n}", "case … { when … do { } }"),
        snippet("while", "while ${1:condition} do {\n\t$0\n}", "while … do { }"),
        snippet("repeat", "repeat {\n\t$0\n}\nuntil ${1:condition}", "repeat { } until …"),
        snippet("for", "for ${1:i} := ${2:1} to ${3:n} do {\n\t$0\n}", "for … := … to … do { }"),
        snippet("var", "var ${1:name}: ${2:text}", "Local variable"),
        snippet("const", "const ${1:NAME} := ${2:value}", "Local constant"),
        snippet("goto node", "goto node '${1:NODE}'", "Move to another node"),
        snippet("call node", "call node '${1:NODE}'", "Call a node (push the call stack)"),
        snippet("call", "call ${1:subroutine}($2)", "Call a subroutine"),
        snippet(
            "open window overlay",
            "open window '${1:NODE}' size ${2:390}, ${3:200} caption '${4: }' overlay on close trigger event ${5:OnClosed} arguments ${6:args}",
            "Agent Portal popup",
            "Opens a node as an overlay popup. The Agent Portal centres it when `at` is omitted. Handle the result in `on event ${5}()`, never right after opening it."
        ),
        snippet("set timer", "set timer to ${1:1} trigger event ${2:EventName}", "Trigger an event after N seconds")
    );
}

function topLevelCompletions(file: FileModel, items: CompletionItem[]): void {
    const isScript = file.source.fileKind === "ags" || file.source.fileKind === "irs";
    const sections = ["constants", "types", "variables", "cursors", "campaign record", "contact record", "workflow record", "transferred record", "outcome record", "contact profile extensions"];
    items.push(snippet("modules", "modules {\n\timport <\"${1:Module.agm}\"> into namespace ${2:Name}\n}", "Import modules"));
    items.push(snippet("dependencies", "dependencies {\n\t${1|image,dll managed,dll native,web service|} \"${2:name}\" in file <\"${3:file}\">\n}", "Images, DLLs and web services"));
    items.push(snippet("using namespaces", "using namespaces {\n\t${1:System::Collections::Generic}\n}", "Import .NET namespaces"));
    for (const section of sections) items.push(snippet(section, `${section} {\n\t$0\n}`, `${section} section`));
    items.push(snippet("node", 'node "${1:NAME}" {\n\tvariables {}\n\ton first enter {}\n\ton enter {\n\t\t$0\n\t}\n\ton exit {}\n}', "Node"));
    items.push(snippet("private node", 'private node "${1:NAME}" {\n\t$0\n}', "Node hidden from importers"));
    items.push(snippet("block", 'block "${1:NAME}" {\n\tvariables {}\n\ton load {}\n\ton unload {}\n}', "Block for containers"));
    items.push(snippet("subroutine", "subroutine ${1:Name}(${2})\n{\n\t$0\n}", "Subroutine"));
    items.push(snippet("function", "function ${1:Name}(${2}): ${3:text}\n{\n\t${1:Name} := $0\n}", "Function (assign the result to its name)"));
    if (isScript) {
        items.push(snippet("on start", "on start {\n\tgoto node '${1:MAIN}'\n}", "Script start"));
        items.push(snippet("on end", "on end {\n\t$0\n}", "Script end"));
    } else {
        items.push(snippet("on load", "on load {\n\t$0\n}", "Module load"));
        items.push(snippet("on unload", "on unload {\n\t$0\n}", "Module unload"));
    }
}

function nodeCompletions(node: NodeDecl, items: CompletionItem[]): void {
    items.push(
        snippet("variables", "variables {\n\t$0\n}", "Node variables"),
        snippet("parameters", "parameters {\n\t${1:name}: ${2:text}\n}", "Node parameters"),
        snippet("cursors", "cursors {\n\t${1:name}: sql for '${2:SELECT}'\n}", "Node cursors"),
        snippet("master", 'master "${1:MASTER}"', "Inherit from a master node"),
        snippet("on first enter", "on first enter {\n\t$0\n}", "First visit"),
        snippet("on enter", "on enter {\n\t$0\n}", "Every visit"),
        snippet("on exit", "on exit {\n\t$0\n}", "Leaving the node"),
        snippet("on event", "on event ${1:Name}(${2})\n{\n\t$0\n}", "User-defined event"),
        snippet("subroutine", "subroutine ${1:Name}(${2})\n{\n\t$0\n}", "Node subroutine"),
        snippet("function", "function ${1:Name}(${2}): ${3:text}\n{\n\t$0\n}", "Node function"),
        snippet("exit point", "exit point ${1:Name} {\n\t$0\n}", "Template exit point")
    );
    if (node.kind === "block") items.push(snippet("on load", "on load {\n\t$0\n}", "Block displayed"), snippet("on unload", "on unload {\n\t$0\n}", "Block hidden"));
    for (const event of EVENTS.values()) {
        if (event.deprecated) continue;
        const params = event.params.replace(/^\(\s*\)$/, "");
        items.push({ label: `on ${event.words}`, kind: CK.Event, detail: params || undefined, insertText: `on ${event.words}${params}\n{\n\t$0\n}`, insertTextFormat: SNIPPET, documentation: { kind: "markdown", value: `${event.doc}\n\n${link(event.url)}` }, sortText: `7${event.words}` });
    }
    for (const def of CONTROLS.values()) {
        if (def.deprecated || def.name === "group") continue;
        const target = def.target ? ` for \${2:${def.target === "cursor" ? "cursorName" : "variable"}}` : "";
        const label = def.name === "push button" || def.name === "text button" || def.name === "static text" || def.name === "check box" || def.name === "radio button" ? '\tlabel "${3:Label}" {}\n' : "";
        const event = def.events[0] ? `\t${def.events[0].syntax.replace(/\[\[?commit\|rollback\]?\]|\[commit\]/, "commit").replace(/\{ ACTION\* \}/, "{\n\t\t$0\n\t}").replace(/\s*\(exact textual.*$/, "")}\n` : "";
        items.push({
            label: def.name,
            kind: CK.Class,
            detail: "graphical element",
            documentation: { kind: "markdown", value: `\`\`\`altitude-asl\n${def.syntax}\n\`\`\`\n\n${def.doc}\n\n${link(def.url)}` },
            insertText: `${def.name} "\${1:name}"${target} {\n\tsize \${4:120},\${5:25} at \${6:10},\${7:10}\n${label}${event}}`,
            insertTextFormat: SNIPPET,
            sortText: `6${def.name}`
        });
    }
    items.push(snippet("background color", "background color ${1:\"White\"}", "Node background"));
}

function controlCompletions(def: ControlDef, items: CompletionItem[]): void {
    for (const clause of def.clauses) {
        if (!clause.phrase) continue;
        items.push({ label: clause.phrase, kind: CK.Property, detail: clause.syntax, documentation: clause.doc ? { kind: "markdown", value: `${clause.doc}\n\n${link(def.url)}` } : undefined });
    }
    for (const event of def.events) {
        const body = event.syntax.replace(/\[\[?commit\|rollback\]?\]|\[commit\]/, "commit").replace(/\{ ACTION\* \}/, "{\n\t$0\n}").replace(/\s*\(exact textual.*$/, "");
        items.push({ label: event.name, kind: CK.Event, insertText: body.replace(/\[([^\]|]+)\|[^\]]*\]/g, "$1"), insertTextFormat: SNIPPET, documentation: event.doc ? { kind: "markdown", value: event.doc } : undefined });
    }
}

function typeCompletions(file: FileModel, program: Program, scope: Scope, items: CompletionItem[]): void {
    for (const type of BUILTIN_TYPES) items.push({ label: type, kind: CK.Keyword, sortText: `0${type}` });
    items.push(snippet("text(n)", "text(${1:50})", "Text with a maximum size"), snippet("number(p,s)", "number(${1:10},${2:2})", "Number with precision and scale"));
    items.push(snippet("array of", "array of ${1:text}", "Array type"), snippet("record", "record {\n\t${1:field}: ${2:text}\n}", "Record type"));
    const seen = new Set<string>();
    for (let s: Scope | undefined = scope; s; s = s.parent) {
        for (const list of s.symbols.values()) for (const symbol of list) if (symbol.kind === "type" && !seen.has(symbol.key)) {
            seen.add(symbol.key);
            items.push({ label: symbol.name, kind: symbol.type?.kind === "enumeration" ? CK.Enum : CK.Struct });
        }
    }
    for (const link of program.linksFrom(file)) {
        if (!link.target) continue;
        if (link.namespace) {
            items.push({ label: link.namespace, kind: CK.Module, detail: "namespace" });
            continue;
        }
        for (const list of program.exportsOf(link.target).values()) for (const symbol of list) if (symbol.kind === "type" && !seen.has(symbol.key)) {
            seen.add(symbol.key);
            items.push({ label: symbol.name, kind: CK.Struct });
        }
    }
    for (const record of RECORDS.values()) items.push({ label: record.name, kind: CK.Struct, detail: "built-in record", sortText: `8${record.name}` });
    for (const def of ENUMS.values()) if (!def.name.endsWith("ErrorCode")) items.push({ label: def.name, kind: CK.Enum, detail: "built-in enumeration", sortText: `8${def.name}` });
}

function symbolCompletions(workspace: Workspace, file: FileModel, program: Program, scope: Scope, offset: number, items: CompletionItem[], accept: (s: AslSymbol) => boolean): void {
    for (const symbol of visibleSymbols(file, program, scope, offset)) {
        if (!accept(symbol)) continue;
        items.push(symbolItem(workspace, file, symbol));
    }
}

function visibleSymbols(file: FileModel, program: Program, scope: Scope, offset: number): AslSymbol[] {
    const result = new Map<string, AslSymbol>();
    const add = (symbol: AslSymbol): void => {
        if (symbol.isLocal && symbol.span.start > offset) return;
        if (!result.has(`${symbol.kind}:${symbol.key}`)) result.set(`${symbol.kind}:${symbol.key}`, symbol);
    };
    for (let s: Scope | undefined = scope; s; s = s.parent) {
        for (const list of s.symbols.values()) list.forEach(add);
        if ((s.kind === "node" || s.kind === "block") && s.owner) {
            for (const master of program.masters(s.owner)) {
                const masterScope = program.nodeScope(master);
                if (masterScope) for (const list of masterScope.symbols.values()) list.forEach(add);
            }
        }
    }
    for (const link of program.linksFrom(file)) {
        if (!link.target || link.namespace) continue;
        for (const list of program.exportsOf(link.target).values()) list.forEach(add);
    }
    return [...result.values()];
}

function symbolItem(workspace: Workspace, file: FileModel, symbol: AslSymbol): CompletionItem {
    const kind = {
        variable: CK.Variable,
        parameter: CK.Variable,
        constant: CK.Constant,
        type: CK.Struct,
        field: CK.Field,
        enumMember: CK.EnumMember,
        cursor: CK.Reference,
        subroutine: CK.Function,
        function: CK.Function,
        node: CK.Class,
        block: CK.Interface,
        event: CK.Event,
        exitPoint: CK.Reference,
        namespace: CK.Module,
        control: CK.Property,
        image: CK.File,
        dll: CK.File,
        businessRecord: CK.Struct
    }[symbol.kind];
    const owner = workspace.model(symbol.uri) ?? file;
    const signature = symbolSignature(symbol, (s) => owner.source.text.slice(s.start, s.end).replace(/\s+/g, " "));
    const item: CompletionItem = { label: symbol.name, kind, detail: signature, documentation: { kind: "markdown", value: symbolMarkdown(workspace, symbol, file) } };
    if (symbol.kind === "function" || symbol.kind === "subroutine") {
        const params = symbol.params ?? [];
        item.insertText = `${symbol.name}(${params.map((p, i) => `\${${i + 1}:${p.name.text}}`).join(", ")})`;
        item.insertTextFormat = SNIPPET;
    }
    item.sortText = `${symbol.isLocal || symbol.kind === "parameter" ? 1 : symbol.scope.kind === "file" ? 3 : 2}${symbol.name}`;
    return item;
}

function valueCompletions(workspace: Workspace, file: FileModel, program: Program, scope: Scope, offset: number, items: CompletionItem[], statementStart: boolean): void {
    for (const symbol of visibleSymbols(file, program, scope, offset)) {
        if (["node", "block", "image", "dll", "control", "exitPoint", "event", "field", "enumMember"].includes(symbol.kind)) continue;
        if (statementStart && symbol.kind === "function") continue;
        items.push(symbolItem(workspace, file, symbol));
    }
    if (!statementStart) {
        for (const fn of FUNCTIONS.values()) {
            if (fn.deprecated) continue;
            items.push({
                label: fn.name,
                kind: CK.Function,
                detail: fn.signature,
                documentation: { kind: "markdown", value: functionMarkdown(fn) },
                insertText: fn.params.length ? `${fn.name}($1)` : `${fn.name}()`,
                insertTextFormat: SNIPPET,
                command: fn.params.length ? { title: "Signature help", command: "editor.action.triggerParameterHints" } : undefined,
                sortText: `4${fn.name}`
            });
        }
        for (const def of ENUMS.values()) if (!def.name.endsWith("ErrorCode")) items.push({ label: def.name, kind: CK.Enum, documentation: { kind: "markdown", value: enumMarkdown(def) }, sortText: `8${def.name}` });
        for (const word of ["true", "false", "not", "and", "or", "xor"]) items.push({ ...keyword(word), sortText: `9${word}` });
    }
    for (const [name, def] of Object.entries(BUSINESS_VARIABLES)) items.push({ label: name, kind: CK.Struct, detail: def.type, documentation: { kind: "markdown", value: def.doc }, sortText: `6${name}` });
    for (const namespace of program.linksFrom(file).filter((l) => l.namespace)) items.push({ label: file.imports[namespace.importIndex].namespace ?? "", kind: CK.Module, detail: file.imports[namespace.importIndex].path.value, sortText: `6${namespace.namespace}` });
}

function qualifiedCompletions(workspace: Workspace, file: FileModel, program: Program, scope: Scope, parts: string[], items: CompletionItem[]): void {
    let current: FileModel | undefined = file;
    for (const part of parts) {
        const target: FileModel | undefined | null = current ? program.namespaceTarget(current, part) : undefined;
        if (target) {
            current = target;
            continue;
        }
        current = undefined;
        break;
    }
    if (current && current !== file) {
        for (const list of program.exportsOf(current).values()) for (const symbol of list) items.push(symbolItem(workspace, file, symbol));
        for (const link of program.linksFrom(current)) if (link.namespace && !link.isPrivate) items.push({ label: current.imports[link.importIndex].namespace ?? "", kind: CK.Module });
        return;
    }
    const enumName = parts[parts.length - 1];
    const enumNamespace = parts.slice(0, -1);
    const resolution = program.resolveType(file, scope, enumName, enumNamespace);
    if (resolution.kind === "symbol" && resolution.symbols[0].members) {
        for (const member of resolution.symbols[0].members.values()) items.push({ label: member.name, kind: CK.EnumMember });
    } else if (resolution.kind === "enum") {
        for (const member of resolution.def.members) items.push({ label: member.name, kind: CK.EnumMember, detail: member.value !== undefined ? `= ${member.value}` : undefined, documentation: member.doc ? { kind: "markdown", value: member.doc } : undefined });
    }
}

function stringNameCompletions(workspace: Workspace, file: FileModel, program: Program, token: Token, items: CompletionItem[]): void {
    const tokens = file.source.tokens;
    const index = tokens.indexOf(token);
    const words = tokens.slice(Math.max(0, index - 3), index).map((t) => t.lower).join(" ");
    const add = (name: string, kind: CompletionItemKind, detail?: string): void => {
        items.push({ label: name, kind, detail });
    };
    if (/(goto node|call node|\bmaster|open window|tab node|default master)$/.test(words)) {
        const seen = new Set<string>();
        for (const node of program.allNodes()) {
            const owner = program.fileOf(node);
            let label = node.name;
            if (owner && owner !== file) {
                const link = program.linksFrom(file).find((l) => l.target === owner && l.namespace);
                if (link) label = `${file.imports[link.importIndex].namespace}::${node.name}`;
            }
            if (!seen.has(label.toLowerCase())) {
                seen.add(label.toLowerCase());
                add(label, CK.Class, owner && owner !== file ? decodeURIComponent(owner.uri.split("/").pop() ?? "") : undefined);
            }
        }
    } else if (/\bimage$/.test(words)) {
        for (const f of program.files) for (const list of f.root.symbols.values()) for (const s of list) if (s.kind === "image") add(s.name, CK.File);
    } else if (/(graphical element|input|email editor|web browser|container|menu|table|chat control)$/.test(words)) {
        const seen = new Set<string>();
        for (const f of program.files) for (const scope of f.nodeScopes.values()) for (const list of scope.symbols.values()) for (const s of list) if (s.kind === "control" && !seen.has(s.key)) {
            seen.add(s.key);
            add(s.name, CK.Property, s.detail);
        }
    } else if (/(current block|initial block)$/.test(words)) {
        for (const f of program.files) for (const list of f.root.symbols.values()) for (const s of list) if (s.kind === "block") add(s.name, CK.Interface);
    } else if (/\bimport$/.test(words)) {
        moduleFileCompletions(workspace, file, items, true);
    }
}

function moduleFileCompletions(workspace: Workspace, file: FileModel, items: CompletionItem[], bare = false): void {
    const folder = file.uri.slice(0, file.uri.lastIndexOf("/") + 1).toLowerCase();
    const allowed = file.source.fileKind === "gem" ? /\.gem$/i : file.source.fileKind === "irs" || file.source.fileKind === "irm" ? /\.(irm|gem)$/i : /\.(agm|gem)$/i;
    for (const uri of workspace.knownUris()) {
        if (!uri.toLowerCase().startsWith(folder) || uri === file.uri) continue;
        const name = decodeURIComponent(uri.slice(folder.length));
        if (!allowed.test(name) || name.includes("/")) continue;
        const namespace = name.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_]/gu, "");
        items.push(
            bare
                ? { label: name, kind: CK.File }
                : { label: name, kind: CK.File, insertText: `import <"${name}"> into namespace \${1:${namespace}}`, insertTextFormat: SNIPPET, detail: "import" }
        );
    }
}

// ------------------------------------------------------------ signature help

export function signatureHelp(workspace: Workspace, file: FileModel, program: Program, offset: number): SignatureHelp | undefined {
    const tokens = file.source.tokens;
    let depth = 0;
    let commas = 0;
    let index = -1;
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
        if (tokens[i].start >= offset) continue;
        const token = tokens[i];
        if (token.kind !== TokenKind.Punct) {
            if (token.kind === TokenKind.Identifier && token.lineBreakBefore && depth === 0 && ["if", "set", "open", "call"].includes(token.lower) && i < tokens.length - 1) {
                // keep scanning: arguments may span lines
            }
            continue;
        }
        if (token.text === ")") depth += 1;
        else if (token.text === "(") {
            if (depth === 0) {
                index = i;
                break;
            }
            depth -= 1;
        } else if (token.text === "," && depth === 0) commas += 1;
        else if ((token.text === "{" || token.text === "}") && depth === 0) return undefined;
    }
    if (index <= 0) return undefined;
    const callee = tokens[index - 1];
    if (callee.kind !== TokenKind.Identifier) return undefined;
    const scope = scopeAt(file, offset);
    const qualifier: string[] = [];
    for (let i = index - 2; i >= 1 && tokens[i].text === "::" && tokens[i - 1].kind === TokenKind.Identifier; i -= 2) qualifier.unshift(tokens[i - 1].text);
    const resolution = program.resolve(file, { kind: "call", span: callee, name: callee.text, qualifier, qualifierSpans: [], scope });
    let signatures: SignatureInformation[] = [];
    if (resolution.kind === "function") {
        const fn = resolution.fn;
        const forms = [fn.signature, ...(fn.overloads ?? [])];
        signatures = forms.map((form) => {
            const inner = form.slice(form.indexOf("(") + 1, form.lastIndexOf(")"));
            const names = inner ? inner.split(",").map((p) => p.trim()) : [];
            const params: ParameterInformation[] = names.map((name) => {
                const doc = fn.params.find((p) => name.startsWith(p.name))?.doc;
                return { label: name, documentation: doc ? { kind: "markdown", value: doc } : undefined };
            });
            return { label: form, documentation: { kind: "markdown", value: `${fn.doc}\n\n${link(fn.url)}` }, parameters: params };
        });
    } else if (resolution.kind === "symbol") {
        const symbol = resolution.symbols.find((s) => s.params);
        if (!symbol?.params) return undefined;
        const owner = workspace.model(symbol.uri) ?? file;
        const text = (s: Span): string => owner.source.text.slice(s.start, s.end).replace(/\s+/g, " ");
        const params = symbol.params.map((p) => `${p.isRef ? "ref " : ""}${p.name.text}${p.type ? `: ${text(p.type)}` : ""}`);
        signatures = [{ label: `${symbol.name}(${params.join(", ")})${symbol.type ? `: ${text(symbol.type)}` : ""}`, documentation: symbol.doc ? { kind: "markdown", value: symbol.doc } : undefined, parameters: params.map((p) => ({ label: p })) }];
    }
    if (!signatures.length) return undefined;
    const activeSignature = Math.max(0, signatures.findIndex((s) => (s.parameters?.length ?? 0) > commas));
    return { signatures, activeSignature, activeParameter: commas };
}
