import type {
    ActionStmt,
    Arg,
    Block,
    ConstantDecl,
    ControlClause,
    ControlDecl,
    CursorDecl,
    Decl,
    Dependency,
    EnumMember,
    Expr,
    ExtensionRecordDecl,
    FileKind,
    HandlerDecl,
    ImportDecl,
    Name,
    NodeDecl,
    Param,
    ParseDiagnostic,
    RoutineDecl,
    Section,
    SectionKind,
    SlotValue,
    SourceFile,
    Span,
    Stmt,
    StringName,
    TypeDecl,
    TypeRef,
    UsingNamespace,
    VariableDecl
} from "./ast";
import { ACTIONS, ACTIONS_BY_LEAD, actionDefs, CONTROL_NAMES, CONTROLS, controlDefs, globalDef, type ControlDef } from "./catalog";
import { lex, TokenKind, type Token } from "./lexer";
import { collectKeywords, compileTemplate, type Pattern, type SlotClass } from "./template";

export function fileKindOf(path: string): FileKind {
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    return ext === "agm" || ext === "irm" || ext === "gem" || ext === "irs" ? ext : "ags";
}

export function parse(text: string, fileKind: FileKind = "ags"): SourceFile {
    const lexed = lex(text);
    const parser = new Parser(text, lexed.tokens);
    for (const error of lexed.errors) {
        parser.diagnostics.push({ start: error.start, end: error.end, message: error.message, severity: "error", code: "syntax" });
    }
    const decls = parser.parseFile();
    return { fileKind, text, decls, tokens: lexed.tokens, comments: lexed.comments, diagnostics: parser.diagnostics, trailerStart: lexed.trailerStart };
}

/** Parses the expression inside a FIB `$(...)` interpolation. */
function parseInterpolation(text: string, start: number, end: number, diagnostics: ParseDiagnostic[]): Expr {
    const lexed = lex(text.slice(start, end));
    const tokens = lexed.tokens.map((token) => ({
        ...token,
        start: token.start + start,
        end: token.end + start,
        parts: token.parts?.map((part) => ({ start: part.start + start, end: part.end + start }))
    }));
    const parser = new Parser(text, tokens);
    const expr = parser.parseExpression();
    if (expr.kind === "error" || parser.peek().kind !== TokenKind.EOF) {
        diagnostics.push({ start, end: Math.max(end, start + 1), message: "Invalid expression in $(...) interpolation.", severity: "error", code: "syntax" });
    } else {
        diagnostics.push(...parser.diagnostics);
    }
    return expr;
}

const SECTION_WORDS: [string, SectionKind][] = [
    ["contact profile extensions", "contact profile extensions"],
    ["campaign record", "campaign record"],
    ["contact record", "contact record"],
    ["workflow record", "workflow record"],
    ["transferred record", "transferred record"],
    ["outcome record", "outcome record"],
    ["constants", "constants"],
    ["variables", "variables"],
    ["parameters", "parameters"],
    ["types", "types"],
    ["cursors", "cursors"],
    ["audio", "audio"]
];

const HEADER_CLAUSES: [string, string][] = [
    ["version", "version STRING"],
    ["file version", "file version INT , INT"],
    ["default font", "default FONT-UAGENT"],
    ["default master", "default master STRING"],
    ["size", "size INT , INT"],
    ["position", "position INT , INT"],
    ["flow view", "flow view { [icon Expression] [script background editable] [hidden] [required] [wizard { [order INT] [hidden if Boolean] [values only] [check Boolean] [on error show Text] }] }"],
    ["year completion", "year completion [disabled | closest | current | past | future]"],
    ["time format", "time format STRING"],
    ["date format", "date format STRING"],
    ["datetime format", "datetime format STRING"],
    ["number format", "number format STRING"]
];

const NODE_CLAUSES: [string, string][] = [
    ["flow view", "flow view { [hidden] [icon Expression] [wizard { [order INT] }] }"],
    ["background color", "background color [COLOR-UAGENT | { COLOR-UAGENT }]"],
    ["background image", "background image STRING [{ [tile] [keep aspect ratio] [keep size] [at [top | bottom | center] [left | right]] [transparent color COLOR-UAGENT] }]"]
];

const CURSOR_KINDS: Record<string, string> = {
    sql: "sql for Text",
    file: "file for Text [delimiter STRING]",
    memory: "memory for Expression",
    enumeration: "enumeration for Expression [columns STRING,...] [filter Sql] [order by Text]",
    system: "system for SYSTEM-CURSOR [columns STRING,...] [filter Sql] [order by Text]"
};

const compiledCache = new Map<string, Pattern>();
function compiled(source: string): Pattern {
    let pattern = compiledCache.get(source);
    if (!pattern) {
        pattern = compileTemplate(source);
        compiledCache.set(source, pattern);
    }
    return pattern;
}

const BINARY_PRECEDENCE: Record<string, number> = {
    or: 1,
    xor: 2,
    and: 3,
    "=": 4,
    "<>": 4,
    "<": 4,
    "<=": 4,
    ">": 4,
    ">=": 4,
    "+": 5,
    "-": 5,
    "*": 6,
    "/": 6
};

const COERCION_TYPES = new Set(["boolean", "number", "text", "date", "time", "datetime"]);

interface MatchOutput {
    keywords: Span[];
    slots: SlotValue[];
    blocks: Block[];
    children: ControlClause[];
}

interface MatchContext {
    defs: (name: string) => Pattern | undefined;
    keywords: Set<string>;
    /** Keywords that start an optional clause; never read as values. */
    starters?: Set<string>;
    out: MatchOutput;
    /** Keyword immediately before the next slot, used to give slots a role. */
    lastWord?: string;
}

type SaveState = [number, number, number, number, number, string | undefined];

function startsWithSlot(pattern: Pattern): boolean {
    if (pattern.t === "slot") return true;
    if (pattern.t === "seq") return pattern.items.length > 0 && startsWithSlot(pattern.items[0]);
    if (pattern.t === "rep") return startsWithSlot(pattern.item);
    return false;
}

function emptyOutput(): MatchOutput {
    return { keywords: [], slots: [], blocks: [], children: [] };
}

class Parser {
    pos = 0;
    readonly diagnostics: ParseDiagnostic[] = [];

    constructor(
        readonly text: string,
        readonly tokens: Token[]
    ) {}

    // ------------------------------------------------------------ token helpers

    peek(offset = 0): Token {
        return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
    }

    next(): Token {
        const token = this.tokens[this.pos];
        if (this.pos < this.tokens.length - 1) {
            this.pos += 1;
        }
        return token;
    }

    previous(): Token {
        return this.tokens[Math.max(this.pos - 1, 0)];
    }

    atEnd(): boolean {
        return this.peek().kind === TokenKind.EOF;
    }

    isWord(word: string, offset = 0): boolean {
        const token = this.peek(offset);
        return token.kind === TokenKind.Identifier && token.lower === word;
    }

    isWords(words: string, offset = 0): boolean {
        return words.split(" ").every((part, index) => this.isWord(part, offset + index));
    }

    isPunct(text: string, offset = 0): boolean {
        const token = this.peek(offset);
        return token.kind === TokenKind.Punct && token.text === text;
    }

    isIdentifier(offset = 0): boolean {
        return this.peek(offset).kind === TokenKind.Identifier;
    }

    eatWord(word: string): Token | undefined {
        return this.isWord(word) ? this.next() : undefined;
    }

    eatWords(words: string): boolean {
        if (!this.isWords(words)) {
            return false;
        }
        for (let i = 0; i < words.split(" ").length; i += 1) {
            this.next();
        }
        return true;
    }

    eatPunct(text: string): Token | undefined {
        return this.isPunct(text) ? this.next() : undefined;
    }

    expectPunct(text: string, context: string): Token | undefined {
        const token = this.eatPunct(text);
        if (!token) {
            this.error(this.peek(), `Expected '${text}' ${context}.`);
        }
        return token;
    }

    expectWord(word: string, context: string): boolean {
        if (this.eatWord(word)) return true;
        this.error(this.peek(), `Expected '${word}' ${context}.`);
        return false;
    }

    error(at: Span, message: string, code = "syntax"): void {
        const start = at.start;
        if (this.diagnostics.some((d) => d.start === start && d.message === message)) {
            return;
        }
        this.diagnostics.push({ start, end: Math.max(at.end, start + 1), message, severity: "error", code });
    }

    warn(at: Span, message: string, code: string): void {
        this.diagnostics.push({ start: at.start, end: Math.max(at.end, at.start + 1), message, severity: "warning", code });
    }

    /** Skips to the end of the current line, jumping over balanced braces. */
    skipLine(): void {
        const startPos = this.pos;
        while (!this.atEnd()) {
            if (this.pos > startPos && this.peek().lineBreakBefore) return;
            if (this.isPunct("}")) return;
            if (this.isPunct("{")) {
                this.skipBraces();
                continue;
            }
            this.next();
        }
    }

    skipBraces(): void {
        let depth = 0;
        while (!this.atEnd()) {
            const token = this.next();
            if (token.kind === TokenKind.Punct && token.text === "{") {
                depth += 1;
            } else if (token.kind === TokenKind.Punct && token.text === "}") {
                depth -= 1;
                if (depth <= 0) return;
            }
        }
    }

    skipUntil(punct: string[]): void {
        while (!this.atEnd() && !punct.some((p) => this.isPunct(p)) && !this.isPunct("{") && !this.isPunct("}")) {
            this.next();
        }
    }

    nameToken(token: Token): Name {
        return { start: token.start, end: token.end, text: token.text };
    }

    expectName(context: string): Name | undefined {
        if (this.isIdentifier()) {
            return this.nameToken(this.next());
        }
        this.error(this.peek(), `Expected a name ${context}.`);
        return undefined;
    }

    stringName(): StringName | undefined {
        const token = this.peek();
        if (token.kind === TokenKind.String || token.kind === TokenKind.Fib) {
            this.next();
            return { start: token.start, end: token.end, value: token.value ?? "" };
        }
        return undefined;
    }

    // ------------------------------------------------------------ file

    parseFile(): Decl[] {
        const decls: Decl[] = [];
        while (!this.atEnd()) {
            const before = this.pos;
            const decl = this.parseTopLevel();
            if (decl) decls.push(decl);
            if (this.pos === before) {
                const token = this.next();
                this.error(token, token.text === "}" ? "Unmatched closing brace." : `Unexpected '${token.text}' at top level.`);
            }
        }
        return decls;
    }

    parseTopLevel(): Decl | undefined {
        const token = this.peek();
        if (token.kind !== TokenKind.Identifier) return undefined;
        const privateToken = this.isWord("private") && this.isIdentifier(1) ? this.next() : undefined;
        const isPrivate = privateToken !== undefined;

        if (this.isWord("modules") && this.isPunct("{", 1)) return this.parseModules();
        if (this.isWord("dependencies") && this.isPunct("{", 1)) return this.parseDependencies();
        if (this.isWords("using namespaces")) return this.parseUsing();
        const section = this.parseSectionIfAny();
        if (section) return section;
        if (this.isWord("node") || this.isWord("block")) return this.parseNode(isPrivate, privateToken?.start);
        const routine = this.parseRoutineIfAny(isPrivate, privateToken?.start);
        if (routine) return routine;
        if (this.isWord("on")) return this.parseHandler();
        for (const [words, syntax] of HEADER_CLAUSES) {
            if (this.isWords(words)) return this.parseClause(words, syntax);
        }
        if (privateToken) {
            this.error(privateToken, "Expected a declaration after 'private'.");
            return undefined;
        }
        this.error(token, `Unknown declaration '${token.text}'.`);
        this.skipLine();
        return undefined;
    }

    parseClause(words: string, syntax: string): Decl {
        const start = this.peek().start;
        const out = emptyOutput();
        const pattern = compiled(syntax);
        const ctx: MatchContext = { defs: globalDef, keywords: collectKeywords(pattern, globalDef), out };
        if (!this.match(pattern, ctx)) {
            this.error(this.peek(), `Invalid '${words}' clause.`);
            this.skipLine();
        }
        return {
            kind: "clause",
            words,
            keyword: { start, end: out.keywords[words.split(" ").length - 1]?.end ?? start + words.length },
            args: out.slots.map((slot) => slot.expr),
            children: out.children,
            start,
            end: this.previous().end
        };
    }

    // ------------------------------------------------------------ modules, dependencies, using

    parseModules(): Decl {
        const start = this.next().start;
        const imports: ImportDecl[] = [];
        this.next();
        while (!this.atEnd() && !this.isPunct("}")) {
            const itemStart = this.peek().start;
            const isPrivate = this.eatWord("private") !== undefined;
            if (!this.eatWord("import")) {
                this.error(this.peek(), "Expected 'import' in the modules block.");
                this.skipLine();
                continue;
            }
            const path = this.stringName();
            if (!path) {
                this.error(this.peek(), 'Expected a module path, for example <"Module.agm">.');
                this.skipLine();
                continue;
            }
            const decl: ImportDecl = { kind: "import", path, isPrivate, start: itemStart, end: path.end };
            for (;;) {
                if (this.eatWords("into namespace")) {
                    decl.namespace = this.expectName("after 'into namespace'");
                } else if (this.eatWords("default master")) {
                    decl.defaultMaster = this.stringName();
                } else if (this.eatWords("node id offset")) {
                    this.parseExpression();
                } else if (this.eatWords("graphical element offset")) {
                    this.parseExpression();
                    this.eatPunct(",");
                    this.parseExpression();
                } else {
                    break;
                }
            }
            decl.end = this.previous().end;
            imports.push(decl);
        }
        this.expectPunct("}", "to close 'modules'");
        return { kind: "modules", imports, start, end: this.previous().end };
    }

    parseDependencies(): Decl {
        const start = this.next().start;
        const items: Dependency[] = [];
        this.next();
        while (!this.atEnd() && !this.isPunct("}")) {
            const itemStart = this.peek().start;
            const isPrivate = this.eatWord("private") !== undefined;
            let dependency: Dependency | undefined;
            if (this.eatWord("image")) {
                dependency = { kind: "dependency", dependencyKind: "image", name: this.stringName(), isPrivate, start: itemStart, end: itemStart };
                if (this.eatWords("in file")) dependency.file = this.parseExpression();
            } else if (this.eatWord("dll")) {
                const dllKind = this.eatWord("native") ? "native" : this.eatWord("managed") ? "managed" : undefined;
                dependency = { kind: "dependency", dependencyKind: "dll", dllKind, name: this.stringName(), isPrivate, start: itemStart, end: itemStart };
                if (this.eatWords("in file")) dependency.file = this.parseExpression();
            } else if (this.eatWords("web service")) {
                dependency = { kind: "dependency", dependencyKind: "web service", name: this.stringName(), isPrivate, start: itemStart, end: itemStart };
                if (this.eatWord("in") && (this.eatWord("url") || this.eatWord("file"))) dependency.file = this.parseExpression();
                if (this.eatWords("of type") && !this.eatWord("wsdl")) this.eatWord("openapi");
            } else if (this.eatWord("file")) {
                dependency = { kind: "dependency", dependencyKind: "file", file: this.parseExpression(), isPrivate, start: itemStart, end: itemStart };
            }
            if (!dependency) {
                this.error(this.peek(), "Expected an image, dll, file or web service dependency.");
                this.skipLine();
                continue;
            }
            this.eatWords("exclude from zip");
            dependency.end = this.previous().end;
            items.push(dependency);
        }
        this.expectPunct("}", "to close 'dependencies'");
        return { kind: "dependencies", items, start, end: this.previous().end };
    }

    parseUsing(): Decl {
        const start = this.next().start;
        this.next();
        const items: UsingNamespace[] = [];
        if (this.expectPunct("{", "after 'using namespaces'")) {
            while (!this.atEnd() && !this.isPunct("}")) {
                if (!this.isIdentifier()) {
                    this.error(this.peek(), "Expected a namespace.");
                    this.skipLine();
                    continue;
                }
                const path: Name[] = [this.nameToken(this.next())];
                while (this.eatPunct("::")) {
                    const part = this.expectName("after '::'");
                    if (part) path.push(part);
                }
                const item: UsingNamespace = { path, start: path[0].start, end: this.previous().end };
                if (this.eatWord("as")) item.alias = this.expectName("after 'as'");
                item.end = this.previous().end;
                items.push(item);
                this.eatPunct(",");
            }
            this.expectPunct("}", "to close 'using namespaces'");
        }
        return { kind: "using", items, start, end: this.previous().end };
    }

    // ------------------------------------------------------------ sections

    parseSectionIfAny(): Section | undefined {
        for (const [words, section] of SECTION_WORDS) {
            const count = words.split(" ").length;
            if (this.isWords(words) && this.isPunct("{", count)) {
                const keywordStart = this.peek().start;
                for (let i = 0; i < count; i += 1) this.next();
                return this.parseSectionBody(section, { start: keywordStart, end: this.previous().end });
            }
        }
        return undefined;
    }

    parseSectionBody(section: SectionKind, keyword: Span): Section {
        const items: Section["items"] = [];
        this.next();
        while (!this.atEnd() && !this.isPunct("}")) {
            const before = this.pos;
            const item = this.parseSectionItem(section);
            if (item) items.push(item);
            if (this.pos === before) {
                this.error(this.peek(), `Unexpected '${this.peek().text}' in ${section}.`);
                this.skipLine();
            }
        }
        this.expectPunct("}", `to close '${section}'`);
        return { kind: "section", section, keyword, items, start: keyword.start, end: this.previous().end };
    }

    parseSectionItem(section: SectionKind): Section["items"][number] | undefined {
        const start = this.peek().start;
        if (section === "contact profile extensions") {
            const name = this.expectName("for the contact profile extension record");
            if (!name) return undefined;
            this.eatWord("record");
            const decl: ExtensionRecordDecl = { kind: "extensionRecord", name, fields: [], start, end: name.end };
            if (this.eatWords("for directory")) decl.directory = this.parseExpression();
            if (this.expectPunct("{", "to open the extension record")) {
                while (!this.atEnd() && !this.isPunct("}")) {
                    const before = this.pos;
                    const field = this.parseVariableDecl(false);
                    if (field) decl.fields.push(field);
                    if (this.pos === before) this.skipLine();
                }
                this.expectPunct("}", "to close the extension record");
            }
            decl.end = this.previous().end;
            return decl;
        }
        if (section === "audio") {
            const name = this.expectName("for the audio resource");
            if (!name) return undefined;
            this.expectPunct(":", "after the audio resource name");
            const value = this.parseExpression();
            return { kind: "constant", name, value, isPrivate: false, start, end: this.previous().end };
        }
        const isPrivate = section !== "parameters" && this.isWord("private") && this.isIdentifier(1) ? this.next() !== undefined : false;
        if (section === "constants") {
            const name = this.expectName("for the constant");
            if (!name) return undefined;
            const decl: ConstantDecl = { kind: "constant", name, isPrivate, start, end: name.end };
            if (this.expectPunct(":=", "after the constant name")) decl.value = this.parseExpression();
            decl.end = this.previous().end;
            return decl;
        }
        if (section === "types") {
            const name = this.expectName("for the type");
            if (!name) return undefined;
            this.expectPunct(":", "after the type name");
            const type = this.parseType();
            const decl: TypeDecl = { kind: "type", name, type, isPrivate, start, end: this.previous().end };
            return decl;
        }
        if (section === "cursors") {
            return this.parseCursorDecl(isPrivate, start);
        }
        const decl = this.parseVariableDecl(section === "parameters");
        if (decl) {
            decl.isPrivate = isPrivate;
            decl.start = start;
        }
        return decl;
    }

    parseVariableDecl(allowRef: boolean): VariableDecl | undefined {
        const start = this.peek().start;
        const isRef = allowRef && this.isWord("ref") && this.isIdentifier(1) ? this.next() !== undefined : false;
        const name = this.expectName("for the declaration");
        if (!name) return undefined;
        const decl: VariableDecl = { kind: "variable", name, isPrivate: false, isRef, start, end: name.end };
        if (this.expectPunct(":", `after '${name.text}'`)) {
            decl.type = this.parseType();
        }
        if (this.eatPunct(":=")) {
            decl.init = this.parseExpression();
        }
        for (;;) {
            if (this.isWords("flow view") && this.isPunct("{", 2)) {
                this.next();
                this.next();
                this.skipBraces();
            } else if (this.isWord("input") && this.isPunct("{", 1)) {
                this.next();
                this.next();
                while (!this.atEnd() && !this.isPunct("}")) {
                    if (this.eatWord("required")) {
                        decl.required = true;
                    } else if (this.eatWord("check")) {
                        decl.check = this.parseExpression(0, new Set(["on"]));
                    } else if (this.eatWords("on error show")) {
                        this.parseExpression();
                    } else {
                        this.error(this.peek(), `Unexpected '${this.peek().text}' in input clause.`);
                        this.skipLine();
                    }
                }
                this.expectPunct("}", "to close the input clause");
            } else {
                break;
            }
        }
        decl.end = this.previous().end;
        return decl;
    }

    parseCursorDecl(isPrivate: boolean, start: number): CursorDecl | undefined {
        const name = this.expectName("for the cursor");
        if (!name) return undefined;
        this.expectPunct(":", "after the cursor name");
        const kindToken = this.peek();
        const syntax = CURSOR_KINDS[kindToken.lower];
        const decl: CursorDecl = { kind: "cursor", name, cursorKind: kindToken.lower, slots: [], isPrivate, start, end: name.end };
        if (!syntax) {
            this.error(kindToken, "Expected a cursor kind: sql, file, memory, enumeration or system.");
            this.skipLine();
            return decl;
        }
        const out = emptyOutput();
        const pattern = compiled(syntax);
        const ctx: MatchContext = { defs: globalDef, keywords: collectKeywords(pattern, globalDef), out };
        if (!this.match(pattern, ctx)) {
            this.error(kindToken, `Invalid ${kindToken.lower} cursor declaration.`);
            this.skipLine();
        }
        decl.slots = out.slots;
        decl.source = out.slots[0]?.expr;
        decl.end = this.previous().end;
        return decl;
    }

    // ------------------------------------------------------------ types

    parseType(): TypeRef {
        const token = this.peek();
        const start = token.start;
        if (this.eatWord("array")) {
            let size: Expr | undefined;
            if (this.eatPunct("[")) {
                size = this.parseExpression();
                this.expectPunct("]", "after the array size");
            } else if (!this.isWord("of")) {
                size = this.parseExpression(0, new Set(["of"]));
            }
            if (!this.eatWord("of")) this.error(this.peek(), "Expected 'of' in the array type.");
            const element = this.parseType();
            return { kind: "array", size, element, start, end: this.previous().end };
        }
        if (this.isWord("record") && this.isPunct("{", 1)) {
            this.next();
            this.next();
            const fields: VariableDecl[] = [];
            while (!this.atEnd() && !this.isPunct("}")) {
                const before = this.pos;
                const field = this.parseVariableDecl(false);
                if (field) fields.push(field);
                if (this.pos === before) this.skipLine();
                this.eatPunct(",");
            }
            this.expectPunct("}", "to close the record type");
            return { kind: "record", fields, start, end: this.previous().end };
        }
        if (this.isWord("enumeration")) {
            this.next();
            let definedIn: Expr | undefined;
            if (this.eatWords("defined in")) {
                if (this.eatWords("contact profile extension")) {
                    if (this.peek().kind === TokenKind.String) definedIn = this.parseExpression();
                } else {
                    definedIn = this.parsePostfix(this.parsePrimaryName());
                }
            }
            const members: EnumMember[] = [];
            if (this.expectPunct("{", "to open the enumeration")) {
                while (!this.atEnd() && !this.isPunct("}")) {
                    const name = this.expectName("for the enumerator");
                    if (!name) {
                        this.skipLine();
                        continue;
                    }
                    const member: EnumMember = { name, start: name.start, end: name.end };
                    if (this.eatPunct("{")) {
                        while (!this.atEnd() && !this.isPunct("}")) {
                            if (this.eatWord("label")) member.label = this.parseExpression();
                            else if (this.eatWord("value")) member.value = this.parseExpression();
                            else {
                                this.error(this.peek(), `Unexpected '${this.peek().text}' in enumerator.`);
                                this.skipLine();
                            }
                        }
                        this.expectPunct("}", "to close the enumerator");
                    }
                    member.end = this.previous().end;
                    members.push(member);
                    this.eatPunct(",");
                }
                this.expectPunct("}", "to close the enumeration");
            }
            return { kind: "enumeration", members, definedIn, start, end: this.previous().end };
        }
        if (token.kind !== TokenKind.Identifier) {
            this.error(token, "Expected a type.");
            return { kind: "error", start, end: start };
        }
        this.next();
        const qualifier: Name[] = [];
        let name = this.nameToken(token);
        while (this.isPunct("::") && this.isIdentifier(1)) {
            this.next();
            qualifier.push(name);
            name = this.nameToken(this.next());
        }
        const typeRef: Extract<TypeRef, { kind: "named" }> = { kind: "named", qualifier, name, start, end: name.end };
        if (this.isPunct("(") && !this.peek().lineBreakBefore) {
            this.next();
            const args: number[] = [];
            while (!this.atEnd() && !this.isPunct(")")) {
                const arg = this.next();
                if (arg.kind === TokenKind.Number) args.push(Number(arg.text));
                else if (!(arg.kind === TokenKind.Punct && arg.text === ",")) this.error(arg, "Expected a number in the type size.");
            }
            this.expectPunct(")", "to close the type size");
            typeRef.args = args;
        } else if (this.isPunct("<") && !this.peek().lineBreakBefore) {
            this.next();
            typeRef.typeArgs = [];
            while (!this.atEnd() && !this.isPunct(">")) {
                typeRef.typeArgs.push(this.parseType());
                if (!this.eatPunct(",")) break;
            }
            this.expectPunct(">", "to close the type arguments");
        }
        typeRef.end = this.previous().end;
        return typeRef;
    }

    // ------------------------------------------------------------ routines and handlers

    parseRoutineIfAny(isPrivate: boolean, privateStart?: number): RoutineDecl | undefined {
        const start = privateStart ?? this.peek().start;
        const save = this.pos;
        let external: RoutineDecl["external"];
        if (this.eatWord("external")) {
            external = { session: this.eatWord("session") !== undefined };
            const convention = this.eatWord("stdcall") ?? this.eatWord("cdecl") ?? this.eatWord("pascal");
            if (convention) external.convention = convention.lower;
        }
        const kindToken = this.eatWord("subroutine") ?? this.eatWord("function");
        if (!kindToken) {
            this.pos = save;
            return undefined;
        }
        const name = this.expectName(`for the ${kindToken.lower}`) ?? { start: kindToken.end, end: kindToken.end, text: "" };
        const routine: RoutineDecl = { kind: "routine", routine: kindToken.lower as RoutineDecl["routine"], name, params: [], hasParens: false, isPrivate, external, start, end: name.end };
        if (this.isPunct("(")) {
            routine.hasParens = true;
            routine.params = this.parseParams(external !== undefined);
        }
        if (this.eatPunct(":")) {
            routine.returnType = this.parseType();
            if (external && this.eatWord("as")) this.parseCType();
        } else if (routine.routine === "function") {
            this.error(this.peek(), `Expected ':' and the return type of function '${name.text}'.`);
        }
        if (external) {
            if (this.eatWord("in")) external.library = this.parseExpression();
            if (this.eatWord("named")) this.parseExpression();
            else if (this.eatWords("export ordinal")) this.parseExpression();
            if (this.eatWord("compiler")) this.parseExpression();
        } else if (this.isPunct("{")) {
            routine.body = this.parseBlock();
        } else {
            this.error(this.peek(), `Expected '{' to open the body of ${kindToken.lower} '${name.text}'.`);
            this.skipLine();
        }
        routine.end = this.previous().end;
        return routine;
    }

    parseCType(): string {
        const words: string[] = [];
        while (this.isIdentifier() && ["unsigned", "char", "short", "int", "long", "float", "double", "wchar_t", "easy", "type"].includes(this.peek().lower)) {
            words.push(this.next().text);
        }
        while (this.eatPunct("*")) words.push("*");
        return words.join(" ");
    }

    parseParams(external: boolean): Param[] {
        const params: Param[] = [];
        this.next();
        while (!this.atEnd() && !this.isPunct(")")) {
            const start = this.peek().start;
            const isRef = this.isWord("ref") && this.isIdentifier(1) ? this.next() !== undefined : false;
            if (this.isWord("out") && this.isIdentifier(1)) this.next();
            const name = this.expectName("for the parameter");
            if (!name) {
                this.skipUntil([",", ")"]);
                if (!this.eatPunct(",")) break;
                continue;
            }
            const param: Param = { name, isRef, start, end: name.end };
            if (this.expectPunct(":", `after parameter '${name.text}'`)) {
                param.type = this.parseType();
            }
            if (external && this.eatWord("as")) param.cType = this.parseCType();
            param.end = this.previous().end;
            params.push(param);
            if (!this.eatPunct(",")) break;
        }
        this.expectPunct(")", "to close the parameter list");
        return params;
    }

    parseHandler(): HandlerDecl {
        const onToken = this.next();
        const words: Token[] = [];
        while (this.isIdentifier() && !this.peek().lineBreakBefore) {
            const lower = this.peek().lower;
            if ((lower === "commit" || lower === "rollback" || lower === "ignore") && words.length > 0 && (this.isPunct("{", 1) || this.peek(1).lineBreakBefore)) break;
            words.push(this.next());
        }
        const handler: HandlerDecl = {
            kind: "handler",
            event: words.map((w) => w.lower).join(" "),
            eventSpan: words.length ? { start: words[0].start, end: words[words.length - 1].end } : { start: onToken.start, end: onToken.end },
            params: [],
            body: { statements: [], start: onToken.end, end: onToken.end },
            start: onToken.start,
            end: onToken.end
        };
        const first = words[0]?.lower;
        if (first === "event" || first === "error" || first === "progress") {
            handler.eventKind = first;
            if (words.length === 2 && first === "event") handler.userEvent = this.nameToken(words[1]);
        }
        if (words.length === 0) this.error(onToken, "Expected an event name after 'on'.");
        if (this.isPunct("(")) handler.params = this.parseParams(false);
        const modifier = this.eatWord("commit") ?? this.eatWord("rollback") ?? this.eatWord("ignore");
        if (modifier) handler.modifier = modifier.lower as HandlerDecl["modifier"];
        if (this.isPunct("{")) {
            handler.body = this.parseBlock();
        } else {
            this.error(this.peek(), `Expected '{' to open the 'on ${handler.event}' handler.`);
            this.skipLine();
        }
        handler.end = this.previous().end;
        return handler;
    }

    // ------------------------------------------------------------ nodes, blocks and controls

    parseNode(isPrivate: boolean, privateStart?: number): NodeDecl {
        const keywordToken = this.next();
        const start = privateStart ?? keywordToken.start;
        const parsedName = this.stringName();
        if (!parsedName) this.error(this.peek(), `Expected the ${keywordToken.lower} name as a string.`);
        const name = parsedName ?? { start: keywordToken.end, end: keywordToken.end, value: "" };
        const node: NodeDecl = {
            kind: keywordToken.lower === "block" ? "block" : "node",
            name,
            keyword: { start: keywordToken.start, end: keywordToken.end },
            isPrivate,
            withoutMaster: false,
            members: [],
            start,
            end: name.end
        };
        if (!this.expectPunct("{", `to open ${node.kind} "${name.value}"`)) {
            this.skipLine();
            return node;
        }
        while (!this.atEnd() && !this.isPunct("}")) {
            const before = this.pos;
            const member = this.parseNodeMember(node);
            if (member) node.members.push(member);
            if (this.pos === before) {
                const token = this.peek();
                this.error(token, `Unexpected '${token.text}' in ${node.kind} "${name.value}".`);
                this.skipLine();
            }
        }
        this.expectPunct("}", `to close ${node.kind} "${name.value}"`);
        node.end = this.previous().end;
        return node;
    }

    parseNodeMember(node: NodeDecl): Decl | undefined {
        if (!this.isIdentifier()) return undefined;
        const isPrivate = this.isWord("private") && this.isIdentifier(1) ? this.next() !== undefined : false;
        if (this.isWord("on")) return this.parseHandler();
        const section = this.parseSectionIfAny();
        if (section) return section;
        if (this.isWords("function key")) {
            const start = this.next().start;
            this.next();
            const key = this.parseExpression();
            if (!this.eatWord("commit") && !this.eatWord("rollback")) this.eatWord("ignore");
            const body = this.parseBodyBlock("function key");
            return { kind: "functionKey", key, body, start, end: this.previous().end };
        }
        const routine = this.parseRoutineIfAny(isPrivate);
        if (routine) return routine;
        if (this.isWord("master") && !this.isPunct("{", 1)) {
            const start = this.next().start;
            const name = this.parseExpression(0, new Set(["arguments", "parameters"]));
            const args: Expr[] = [];
            if (this.eatWord("arguments") || (this.isWord("parameters") && !this.isPunct("{", 1) && this.next())) args.push(...this.parseExpressionList());
            node.master = { name, args, span: { start, end: this.previous().end } };
            return undefined;
        }
        if (this.isWords("without master")) {
            this.next();
            this.next();
            node.withoutMaster = true;
            return undefined;
        }
        if (this.isWord("id") && this.peek(1).kind === TokenKind.Number) {
            this.next();
            node.id = this.parseExpression();
            return undefined;
        }
        if (this.isWords("exit point")) {
            const start = this.next().start;
            this.next();
            const name = this.expectName("for the exit point") ?? { start, end: start, text: "" };
            const body = this.parseBodyBlock("exit point");
            return { kind: "exitPoint", name, body, start, end: this.previous().end };
        }
        if (this.isWords("node loop") && this.isPunct("{", 2)) {
            const start = this.next().start;
            this.next();
            const body = this.parseBlock();
            return { kind: "nodeLoop", body, start, end: this.previous().end };
        }
        for (const [words, syntax] of NODE_CLAUSES) {
            if (this.isWords(words)) return this.parseClause(words, syntax);
        }
        const control = this.matchControlKeyword();
        if (control) return this.parseControl(control);
        if (this.isWord("group") && this.isPunct("{", 1)) {
            // A group only arranges graphical elements: its contents belong to the node.
            const start = this.next().start;
            this.next();
            while (!this.atEnd() && !this.isPunct("}")) {
                const before = this.pos;
                const member = this.parseNodeMember(node);
                if (member) node.members.push(member);
                if (this.pos === before) {
                    this.error(this.peek(), `Unexpected '${this.peek().text}' in group.`);
                    this.skipLine();
                }
            }
            this.expectPunct("}", "to close the group");
            return { kind: "clause", words: "group", keyword: { start, end: start + 5 }, args: [], start, end: this.previous().end };
        }
        return undefined;
    }

    matchControlKeyword(): ControlDef | undefined {
        for (const name of CONTROL_NAMES) {
            if (name === "group" || !this.isWords(name)) continue;
            const after = this.peek(name.split(" ").length);
            // `input 'x' insert text ...` is an action; declarations continue with `{`, a name string or `for`.
            const isDecl =
                (after.kind === TokenKind.Punct && after.text === "{") ||
                after.kind === TokenKind.String ||
                after.kind === TokenKind.Fib ||
                (after.kind === TokenKind.Identifier && after.lower === "for");
            if (isDecl) return CONTROLS.get(name);
        }
        return undefined;
    }

    parseControl(def: ControlDef): ControlDecl {
        const start = this.peek().start;
        for (let i = 0; i < def.name.split(" ").length; i += 1) this.next();
        const control: ControlDecl = { kind: "control", control: def.name, keyword: { start, end: this.previous().end }, clauses: [], handlers: [], start, end: this.previous().end };
        control.name = this.stringName();
        if (this.eatWord("for")) control.target = this.parsePostfix(this.parsePrimaryName());
        if (!this.expectPunct("{", `to open the ${def.name}`)) {
            this.skipLine();
            return control;
        }
        const defs = controlDefs(def);
        const keywords = new Set<string>();
        for (const clause of def.clauses) collectKeywords(clause.pattern, defs, keywords);
        while (!this.atEnd() && !this.isPunct("}")) {
            const before = this.pos;
            if (this.isWord("on")) {
                control.handlers.push(this.parseHandler());
                continue;
            }
            const clause = this.parseControlClause(def, defs, keywords);
            if (clause) {
                control.clauses.push(clause);
            } else if (this.pos === before) {
                const token = this.peek();
                const legacy = def.legacyClauses.find((phrase) => this.isWords(phrase));
                if (legacy) {
                    const end = this.peek(legacy.split(" ").length - 1).end;
                    this.warn({ start: token.start, end }, `'${legacy}' is a clause from ASL for Windows; the Agent Portal ignores it.`, "web-unsupported");
                } else {
                    this.warn(token, `Unknown clause '${token.text}' for ${def.name}.`, "unknown-clause");
                }
                this.skipLine();
            }
        }
        this.expectPunct("}", `to close the ${def.name}`);
        control.end = this.previous().end;
        const size = control.clauses.find((c) => c.words === "size");
        if (size) {
            const numbers = size.slots.map((s) => (s.expr.kind === "number" ? Number(s.expr.text) : NaN));
            control.size = { width: numbers[0], height: numbers[1], x: numbers[2], y: numbers[3] };
        }
        return control;
    }

    parseControlClause(def: ControlDef, defs: (name: string) => Pattern | undefined, keywords: Set<string>): ControlClause | undefined {
        const start = this.pos;
        let bestIndex = -1;
        let bestEnd = start;
        def.clauses.forEach((clauseDef, index) => {
            this.pos = start;
            const diagnosticsBefore = this.diagnostics.length;
            if (this.match(clauseDef.pattern, { defs, keywords, out: emptyOutput() }) && this.pos > bestEnd) {
                bestEnd = this.pos;
                bestIndex = index;
            }
            this.diagnostics.length = diagnosticsBefore;
        });
        this.pos = start;
        if (bestIndex < 0) return undefined;
        const clauseDef = def.clauses[bestIndex];
        const out = emptyOutput();
        this.match(clauseDef.pattern, { defs, keywords, out });
        return { words: clauseDef.phrase, keywords: out.keywords, slots: out.slots, children: out.children, start: this.tokens[start].start, end: this.previous().end };
    }

    // ------------------------------------------------------------ template matching

    match(pattern: Pattern, ctx: MatchContext): boolean {
        switch (pattern.t) {
            case "lit":
                return this.matchLiteral(pattern.word, ctx);
            case "slot":
                return this.matchSlot(pattern.placeholder, pattern.cls, ctx);
            case "seq":
                return this.matchSequence(pattern.items, ctx);
            case "opt": {
                const save = this.save(ctx);
                if (!this.match(pattern.item, ctx)) this.restore(save, ctx);
                return true;
            }
            case "alt":
                return this.matchAlternatives(pattern.items, ctx);
            case "rep": {
                let count = 0;
                for (;;) {
                    const save = this.save(ctx);
                    if (count > 0 && pattern.sep && !this.eatPunct(pattern.sep)) break;
                    const before = this.pos;
                    if (!this.match(pattern.item, ctx) || this.pos === before) {
                        this.restore(save, ctx);
                        break;
                    }
                    count += 1;
                }
                return count > 0;
            }
            case "ref": {
                const def = ctx.defs(pattern.name);
                return def ? this.match(def, ctx) : false;
            }
            case "brace":
                return this.matchBrace(pattern.item, ctx);
        }
    }

    matchLiteral(word: string, ctx: MatchContext): boolean {
        const token = this.peek();
        if (word.startsWith("'")) {
            if (token.kind === TokenKind.Fib && token.text.toLowerCase() === word) {
                this.next();
                return true;
            }
            return false;
        }
        if (/^[a-z_]/.test(word)) {
            if (word.includes("::")) {
                const parts = word.split("::");
                let offset = 0;
                for (let i = 0; i < parts.length; i += 1) {
                    if (i > 0) {
                        if (!this.isPunct("::", offset)) return false;
                        offset += 1;
                    }
                    if (this.peek(offset).lower !== parts[i]) return false;
                    offset += 1;
                }
                for (let i = 0; i < offset; i += 1) this.next();
                return true;
            }
            if (token.kind === TokenKind.Identifier && token.lower === word) {
                ctx.out.keywords.push({ start: token.start, end: token.end });
                ctx.lastWord = word;
                this.next();
                return true;
            }
            return false;
        }
        if (token.kind === TokenKind.Punct && token.text === word) {
            this.next();
            return true;
        }
        if (word === "?" && token.kind === TokenKind.Punct && token.text === "?") {
            this.next();
            return true;
        }
        return false;
    }

    matchSlot(placeholder: string, cls: SlotClass, ctx: MatchContext): boolean {
        const token = this.peek();
        if (cls === "actions") {
            if (!this.isPunct("{")) return false;
            ctx.out.blocks.push(this.parseBlock());
            return true;
        }
        if (cls === "id") {
            if (token.kind !== TokenKind.Identifier) return false;
            const expr = this.parsePrimaryName();
            ctx.out.slots.push({ placeholder, cls, after: ctx.lastWord, expr });
            return true;
        }
        if (!this.canStartExpression(token)) return false;
        // A keyword of the action is not a value (`fetch cursor c into ...` must not read `into` as a number),
        // unless it is clearly used as an operand: a call, member access or index.
        if (cls === "expr" && token.kind === TokenKind.Identifier && (ctx.starters ?? ctx.keywords).has(token.lower) && !this.isPunct("(", 1) && !this.isPunct(".", 1) && !this.isPunct("[", 1) && !this.isPunct("::", 1)) {
            return false;
        }
        const diagnosticsBefore = this.diagnostics.length;
        const expr = this.parseExpression(0, ctx.keywords);
        if (expr.kind === "error") {
            this.diagnostics.length = diagnosticsBefore;
            return false;
        }
        ctx.out.slots.push({ placeholder, cls, after: ctx.lastWord, expr });
        return true;
    }

    matchSequence(items: Pattern[], ctx: MatchContext): boolean {
        let index = 0;
        while (index < items.length) {
            const item = items[index];
            if (item.t === "opt") {
                // Consecutive optional clauses are accepted in any order.
                let groupEnd = index;
                while (groupEnd < items.length && items[groupEnd].t === "opt") groupEnd += 1;
                // Keyword-led clauses go first so that a keyword is never swallowed by an optional expression.
                const group = (items.slice(index, groupEnd) as Extract<Pattern, { t: "opt" }>[]).sort((a, b) => Number(startsWithSlot(a.item)) - Number(startsWithSlot(b.item)));
                const used = new Set<number>();
                let progressed = true;
                while (progressed) {
                    progressed = false;
                    for (let g = 0; g < group.length; g += 1) {
                        if (used.has(g)) continue;
                        const save = this.save(ctx);
                        const before = this.pos;
                        const keywordsBefore = ctx.out.keywords.length;
                        if (this.match(group[g].item, ctx) && this.pos > before) {
                            // An optional clause on a new line must start with one of its keywords;
                            // otherwise it is the next statement (`fetch cursor c into x` + `if ...`).
                            const first = this.tokens[before];
                            const startsWithKeyword = ctx.out.keywords.length > keywordsBefore && ctx.out.keywords[keywordsBefore].start === first.start;
                            if (!first.lineBreakBefore || startsWithKeyword || first.kind === TokenKind.Punct) {
                                used.add(g);
                                progressed = true;
                                break;
                            }
                        }
                        this.restore(save, ctx);
                    }
                }
                index = groupEnd;
                continue;
            }
            if (!this.match(item, ctx)) return false;
            index += 1;
        }
        return true;
    }

    matchAlternatives(items: Pattern[], ctx: MatchContext): boolean {
        const save = this.save(ctx);
        let bestIndex = -1;
        let bestEnd = -1;
        for (let i = 0; i < items.length; i += 1) {
            this.restore(save, ctx);
            const diagnosticsBefore = this.diagnostics.length;
            if (this.match(items[i], ctx) && this.pos > bestEnd) {
                bestEnd = this.pos;
                bestIndex = i;
            }
            this.diagnostics.length = diagnosticsBefore;
        }
        this.restore(save, ctx);
        return bestIndex >= 0 && this.match(items[bestIndex], ctx);
    }

    matchBrace(inner: Pattern, ctx: MatchContext): boolean {
        if (!this.isPunct("{")) return false;
        const open = this.next();
        const items = (inner.t === "seq" ? inner.items : [inner]).map((item) => (item.t === "opt" ? item.item : item));
        while (!this.atEnd() && !this.isPunct("}")) {
            const before = this.pos;
            let matched = false;
            for (const item of items) {
                const save = this.save(ctx);
                const keywordsBefore = ctx.out.keywords.length;
                if (this.match(item, ctx) && this.pos > before) {
                    matched = true;
                    const keywords = ctx.out.keywords.slice(keywordsBefore);
                    ctx.out.children.push({
                        words: keywords.slice(0, 2).map((k) => this.text.slice(k.start, k.end).toLowerCase()).join(" "),
                        keywords,
                        slots: [],
                        children: [],
                        start: this.tokens[before].start,
                        end: this.previous().end
                    });
                    break;
                }
                this.restore(save, ctx);
            }
            if (!matched && this.pos === before) {
                const token = this.peek();
                this.warn(token, `Unexpected '${token.text}' in this block.`, "unknown-clause");
                this.skipLine();
            }
        }
        if (!this.eatPunct("}")) this.error(open, "Unclosed '{'.");
        return true;
    }

    save(ctx: MatchContext): SaveState {
        return [this.pos, ctx.out.keywords.length, ctx.out.slots.length, ctx.out.blocks.length, ctx.out.children.length, ctx.lastWord];
    }

    restore(state: SaveState, ctx: MatchContext): void {
        this.pos = state[0];
        ctx.out.keywords.length = state[1];
        ctx.out.slots.length = state[2];
        ctx.out.blocks.length = state[3];
        ctx.out.children.length = state[4];
        ctx.lastWord = state[5];
    }

    // ------------------------------------------------------------ statements

    parseBlock(): Block {
        const open = this.next();
        const block: Block = { statements: [], start: open.start, end: open.end };
        while (!this.atEnd() && !this.isPunct("}")) {
            const before = this.pos;
            const stmt = this.parseStatement();
            if (stmt) block.statements.push(stmt);
            if (this.pos === before) {
                const token = this.next();
                this.error(token, `Unexpected '${token.text}'.`);
            }
        }
        if (!this.eatPunct("}")) this.error(open, "Unclosed '{'.");
        block.end = this.previous().end;
        return block;
    }

    parseBodyBlock(context: string): Block {
        if (this.isPunct("{")) return this.parseBlock();
        this.error(this.peek(), `Expected '{' to open the ${context} block.`);
        const at = this.peek().start;
        return { statements: [], start: at, end: at };
    }

    parseStatement(): Stmt | undefined {
        const token = this.peek();
        const start = token.start;
        if (token.kind === TokenKind.Punct && token.text === "{") {
            const block = this.parseBlock();
            return { kind: "action", action: -1, words: "{", keywords: [], slots: [], blocks: [block], start, end: block.end };
        }
        if (token.kind !== TokenKind.Identifier) {
            this.error(token, `Unexpected '${token.text}'.`);
            this.skipLine();
            return { kind: "error", start, end: this.previous().end };
        }
        switch (token.lower) {
            case "if":
                if (!this.isPunct("(", 1) || !this.peek(1).lineBreakBefore) return this.parseIf();
                break;
            case "case":
                return this.parseCase();
            case "while": {
                this.next();
                const cond = this.parseExpression();
                this.expectWord("do", "after the while condition");
                const body = this.parseBodyBlock("while");
                return { kind: "while", cond, body, start, end: this.previous().end };
            }
            case "repeat":
                if (this.isPunct("{", 1)) {
                    this.next();
                    const body = this.parseBlock();
                    this.expectWord("until", "after the repeat block");
                    const cond = this.parseExpression();
                    return { kind: "repeat", body, cond, start, end: this.previous().end };
                }
                break;
            case "for":
                if (this.isIdentifier(1) && !this.isWord("each", 1)) return this.parseFor();
                break;
            case "var": {
                if (!this.isIdentifier(1) || !this.isPunct(":", 2)) break;
                this.next();
                const decl = this.parseVariableDecl(false)!;
                decl.start = start;
                return { kind: "var", decl, start, end: this.previous().end };
            }
            case "const": {
                if (!this.isIdentifier(1) || !this.isPunct(":=", 2)) break;
                this.next();
                const name = this.nameToken(this.next());
                this.next();
                const decl: ConstantDecl = { kind: "constant", name, value: this.parseExpression(), isPrivate: false, start, end: name.end };
                decl.end = this.previous().end;
                return { kind: "const", decl, start, end: this.previous().end };
            }
            case "goto":
                if (this.isWord("node", 1)) return this.parseGoto("goto");
                break;
            case "call":
                if (this.isWord("node", 1)) return this.parseGoto("call");
                if (!this.isWords("call master event handler") && !this.isWords("call supervisor phone")) return this.parseCall();
                break;
        }

        // Assignment: VAR := Expression, where VAR may be a field, an element or a module variable.
        const save = this.pos;
        const diagnosticsBefore = this.diagnostics.length;
        const target = this.parsePostfix(this.parsePrimaryName());
        if (this.isPunct(":=")) {
            this.next();
            const value = this.parseExpression();
            return { kind: "assign", target, value, start, end: this.previous().end };
        }
        this.pos = save;
        this.diagnostics.length = diagnosticsBefore;

        const action = this.parseAction();
        if (action) return action;

        this.error(token, `Unknown action '${token.text}'.`, "unknown-action");
        this.skipLine();
        return { kind: "error", start, end: this.previous().end };
    }

    parseIf(): Stmt {
        const start = this.next().start;
        const cond = this.parseExpression();
        this.expectWord("then", "after the if condition");
        const then = this.parseBodyBlock("then");
        let elseBranch: Block | Stmt | undefined;
        if (this.eatWord("else")) {
            elseBranch = this.isWord("if") ? this.parseIf() : this.parseBodyBlock("else");
        }
        return { kind: "if", cond, then, else: elseBranch, start, end: this.previous().end };
    }

    parseCase(): Stmt {
        const start = this.next().start;
        const expr = this.parseExpression();
        const whens: { value: Expr; body: Block }[] = [];
        let defaultBlock: Block | undefined;
        if (this.expectPunct("{", "after the case expression")) {
            while (!this.atEnd() && !this.isPunct("}")) {
                if (this.eatWord("when")) {
                    const value = this.parseExpression();
                    this.expectWord("do", "after the when value");
                    whens.push({ value, body: this.parseBodyBlock("when") });
                } else if (this.eatWord("default")) {
                    defaultBlock = this.parseBodyBlock("default");
                } else {
                    this.error(this.peek(), "Expected 'when' or 'default' inside case.");
                    this.skipLine();
                }
            }
            this.expectPunct("}", "to close the case");
        }
        return { kind: "case", expr, whens, default: defaultBlock, start, end: this.previous().end };
    }

    parseFor(): Stmt {
        const start = this.next().start;
        const variable = this.parsePostfix(this.parsePrimaryName());
        this.expectPunct(":=", "after the for variable");
        const from = this.parseExpression();
        this.expectWord("to", "in the for loop");
        const to = this.parseExpression();
        const step = this.eatWord("step") ? this.parseExpression() : undefined;
        this.expectWord("do", "after the for range");
        const body = this.parseBodyBlock("for");
        return { kind: "for", variable, from, to, step, body, start, end: this.previous().end };
    }

    parseGoto(mode: "goto" | "call"): Stmt {
        const start = this.next().start;
        this.next();
        const target = this.parseExpression(0, new Set(["arguments"]));
        const args = this.eatWord("arguments") ? this.parseExpressionList() : [];
        return { kind: "goto", mode, target, args, start, end: this.previous().end };
    }

    parseCall(): Stmt {
        const start = this.next().start;
        let callee = this.parsePostfix(this.parsePrimaryName());
        let args: Arg[] = [];
        if (callee.kind === "call") {
            args = callee.args;
            callee = callee.callee;
        }
        return { kind: "call", callee, args, start, end: this.previous().end };
    }

    parseAction(): ActionStmt | undefined {
        const token = this.peek();
        const candidates = ACTIONS_BY_LEAD.get(token.lower);
        if (!candidates) return undefined;
        const start = this.pos;
        let best: { index: number; pattern: number; end: number } | undefined;
        for (const index of candidates) {
            const action = ACTIONS[index];
            action.patterns.forEach((pattern, patternIndex) => {
                this.pos = start;
                const diagnosticsBefore = this.diagnostics.length;
                const ctx: MatchContext = { defs: actionDefs(action), keywords: action.keywords, starters: action.starters, out: emptyOutput() };
                if (this.match(pattern, ctx) && this.pos > start && (!best || this.pos > best.end)) {
                    best = { index, pattern: patternIndex, end: this.pos };
                }
                this.diagnostics.length = diagnosticsBefore;
            });
        }
        this.pos = start;
        if (!best) return undefined;
        const action = ACTIONS[best.index];
        const ctx: MatchContext = { defs: actionDefs(action), keywords: action.keywords, starters: action.starters, out: emptyOutput() };
        this.match(action.patterns[best.pattern], ctx);
        return { kind: "action", action: best.index, words: action.phrase, keywords: ctx.out.keywords, slots: ctx.out.slots, blocks: ctx.out.blocks, children: ctx.out.children, start: token.start, end: this.previous().end };
    }

    // ------------------------------------------------------------ expressions

    canStartExpression(token: Token): boolean {
        switch (token.kind) {
            case TokenKind.Identifier:
            case TokenKind.AtIdentifier:
            case TokenKind.Number:
            case TokenKind.String:
            case TokenKind.Fib:
                return true;
            case TokenKind.Punct:
                return token.text === "(" || token.text === "-" || token.text === "+";
            default:
                return false;
        }
    }

    parseExpressionList(): Expr[] {
        const list: Expr[] = [];
        do {
            if (!this.canStartExpression(this.peek())) break;
            list.push(this.parseExpression());
        } while (this.eatPunct(","));
        return list;
    }

    parseExpression(minPrecedence = 0, keywords?: Set<string>): Expr {
        let left = this.parseUnary(keywords);
        for (;;) {
            const token = this.peek();
            const op = token.kind === TokenKind.Punct ? token.text : token.kind === TokenKind.Identifier ? token.lower : "";
            const precedence = BINARY_PRECEDENCE[op];
            if (precedence === undefined || precedence <= minPrecedence) break;
            if (token.kind === TokenKind.Identifier && keywords?.has(op)) {
                // `with directory X and contact profile ...`: `and` is a keyword of the action here.
                const following = this.peek(1);
                if (following.kind === TokenKind.Identifier && keywords.has(following.lower)) break;
            }
            this.next();
            const right = this.parseExpression(precedence, keywords);
            left = { kind: "binary", op, left, right, start: left.start, end: right.end };
        }
        return left;
    }

    parseUnary(keywords?: Set<string>): Expr {
        const token = this.peek();
        if (token.kind === TokenKind.Identifier && token.lower === "not" && this.canStartExpression(this.peek(1))) {
            this.next();
            const operand = this.parseExpression(3, keywords);
            return { kind: "unary", op: "not", operand, start: token.start, end: operand.end };
        }
        if (token.kind === TokenKind.Punct && (token.text === "-" || token.text === "+")) {
            this.next();
            const operand = this.parseExpression(6, keywords);
            return { kind: "unary", op: token.text, operand, start: token.start, end: operand.end };
        }
        return this.parsePostfix(this.parsePrimary());
    }

    parsePrimary(): Expr {
        const token = this.peek();
        switch (token.kind) {
            case TokenKind.Number:
                this.next();
                return { kind: "number", text: token.text, start: token.start, end: token.end };
            case TokenKind.String:
            case TokenKind.Fib:
                return this.parseStringLiterals();
            case TokenKind.AtIdentifier:
                this.next();
                return { kind: "attr", name: this.nameToken(token), start: token.start, end: token.end };
            case TokenKind.Identifier:
                if (token.lower === "true" || token.lower === "false" || token.lower === "null") {
                    this.next();
                    return { kind: "literal", value: token.lower as "true" | "false" | "null", start: token.start, end: token.end };
                }
                if (token.lower === "new" && this.isIdentifier(1)) {
                    this.next();
                    const type = this.parseType();
                    const args = this.isPunct("(") ? this.parseArguments() : [];
                    return { kind: "new", type, args, start: token.start, end: this.previous().end };
                }
                return this.parsePrimaryName();
            case TokenKind.Punct:
                if (token.text === "(") {
                    this.next();
                    const expr = this.parseExpression();
                    this.expectPunct(")", "to close the parenthesis");
                    return { kind: "paren", expr, start: token.start, end: this.previous().end };
                }
                break;
        }
        this.error(token, token.kind === TokenKind.EOF ? "Unexpected end of file, expected an expression." : `Expected an expression, found '${token.text}'.`);
        return { kind: "error", start: token.start, end: token.start };
    }

    parseStringLiterals(): Expr {
        const parts: Expr[] = [];
        while (this.peek().kind === TokenKind.String || this.peek().kind === TokenKind.Fib) {
            const token = this.next();
            const interpolations = (token.parts ?? []).map((part) => parseInterpolation(this.text, part.start, part.end, this.diagnostics));
            parts.push({ kind: "string", value: token.value ?? "", fib: token.kind === TokenKind.Fib, interpolations, start: token.start, end: token.end });
        }
        return parts.length === 1 ? parts[0] : { kind: "concat", parts, start: parts[0].start, end: parts[parts.length - 1].end };
    }

    /** `name [:: name]*`, with optional managed type arguments. Falls back to a primary expression. */
    parsePrimaryName(): Expr {
        const token = this.peek();
        if (token.kind === TokenKind.AtIdentifier) {
            this.next();
            return { kind: "attr", name: this.nameToken(token), start: token.start, end: token.end };
        }
        if (token.kind !== TokenKind.Identifier) return this.parsePrimary();
        this.next();
        const qualifier: Name[] = [];
        let name = this.nameToken(token);
        while (this.isPunct("::") && this.isIdentifier(1)) {
            this.next();
            qualifier.push(name);
            name = this.nameToken(this.next());
        }
        const expr: Extract<Expr, { kind: "name" }> = { kind: "name", qualifier, name, start: token.start, end: name.end };
        if (this.isPunct("<") && !this.peek().lineBreakBefore && this.looksLikeTypeArguments()) {
            this.next();
            expr.typeArgs = [];
            while (!this.atEnd() && !this.isPunct(">")) {
                expr.typeArgs.push(this.parseType());
                if (!this.eatPunct(",")) break;
            }
            this.expectPunct(">", "to close the type arguments");
            expr.end = this.previous().end;
        }
        return expr;
    }

    looksLikeTypeArguments(): boolean {
        let offset = 1;
        for (;;) {
            if (!this.isIdentifier(offset)) return false;
            offset += 1;
            while (this.isPunct("::", offset) && this.isIdentifier(offset + 1)) offset += 2;
            if (this.isPunct(",", offset)) {
                offset += 1;
                continue;
            }
            return this.isPunct(">", offset) && this.isPunct("(", offset + 1);
        }
    }

    parsePostfix(expr: Expr): Expr {
        for (;;) {
            const token = this.peek();
            if (token.kind !== TokenKind.Punct || token.lineBreakBefore) break;
            if (token.text === "." && (this.isIdentifier(1) || this.peek(1).kind === TokenKind.AtIdentifier)) {
                this.next();
                const nameToken = this.next();
                expr = { kind: "member", object: expr, name: this.nameToken(nameToken), start: expr.start, end: nameToken.end };
            } else if (token.text === "[") {
                this.next();
                const index = this.parseExpression();
                this.expectPunct("]", "to close the index");
                expr = { kind: "index", object: expr, index, start: expr.start, end: this.previous().end };
            } else if (token.text === "(" && (expr.kind === "name" || expr.kind === "member")) {
                const open = token.start;
                const args = this.parseArguments();
                expr = { kind: "call", callee: expr, args, open, close: this.previous().start, start: expr.start, end: this.previous().end };
            } else if (token.text === ":" && this.isIdentifier(1) && COERCION_TYPES.has(this.peek(1).lower)) {
                this.next();
                const type = this.nameToken(this.next());
                expr = { kind: "coerce", expr, type, start: expr.start, end: type.end };
            } else {
                break;
            }
        }
        return expr;
    }

    parseArguments(): Arg[] {
        const args: Arg[] = [];
        this.next();
        while (!this.atEnd() && !this.isPunct(")")) {
            const start = this.peek().start;
            let mode: Arg["mode"];
            if ((this.isWord("ref") || this.isWord("out")) && this.isIdentifier(1)) mode = this.next().lower as "ref" | "out";
            const expr = this.parseExpression();
            args.push({ expr, mode, start, end: expr.end });
            if (expr.kind === "error") this.skipUntil([",", ")"]);
            if (!this.eatPunct(",")) break;
        }
        this.expectPunct(")", "to close the argument list");
        return args;
    }
}

/** Parses a standalone expression whose text starts at `base` in the document (for completion). */
export function parseExpressionAt(text: string, start: number, end: number): Expr | undefined {
    const lexed = lex(text.slice(start, end));
    const tokens = lexed.tokens.map((token) => ({ ...token, start: token.start + start, end: token.end + start }));
    const parser = new Parser(text, tokens);
    const expr = parser.parseExpression();
    return expr.kind === "error" ? undefined : expr;
}
