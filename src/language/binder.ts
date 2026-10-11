/**
 * Per-file binding: declarations become symbols in nested scopes, and every name occurrence
 * becomes a reference. References are resolved later, with the module graph (program.ts).
 */
import type {
    ActionStmt,
    Block,
    ControlDecl,
    CursorDecl,
    Decl,
    Expr,
    HandlerDecl,
    NodeDecl,
    Param,
    RoutineDecl,
    Section,
    SlotValue,
    SourceFile,
    Span,
    Stmt,
    StringName,
    TypeRef,
    VariableDecl
} from "./ast";
import { ACTIONS, BUSINESS_VARIABLES } from "./catalog";
import type { CommentTrivia } from "./lexer";

export type SymbolKind =
    | "variable"
    | "parameter"
    | "constant"
    | "type"
    | "field"
    | "enumMember"
    | "cursor"
    | "subroutine"
    | "function"
    | "node"
    | "block"
    | "event"
    | "exitPoint"
    | "namespace"
    | "control"
    | "image"
    | "dll"
    | "businessRecord";

export interface AslSymbol {
    name: string;
    key: string;
    kind: SymbolKind;
    uri: string;
    span: Span;
    nameSpan: Span;
    scope: Scope;
    isPrivate: boolean;
    /** Declared type of variables, parameters, fields, constants (inferred) and function results. */
    type?: TypeRef;
    /** Fields of record types and record variables, members of enumerations. */
    members?: Map<string, AslSymbol>;
    params?: Param[];
    /** Text of the attached `comment { }`. */
    doc?: string;
    /** Local variables are only visible after their declaration. */
    isLocal?: boolean;
    /** Owning node or routine (for detail strings). */
    container?: AslSymbol;
    /** Extra information: business record section, control type, cursor kind, dll kind... */
    detail?: string;
    decl?: Decl | VariableDecl | CursorDecl | Param | ControlDecl;
}

export type ScopeKind = "file" | "node" | "block" | "routine" | "handler" | "local";

export interface Scope {
    kind: ScopeKind;
    parent?: Scope;
    owner?: AslSymbol;
    span: Span;
    symbols: Map<string, AslSymbol[]>;
    /** Enclosing node or block declaration, if any. */
    node?: NodeDecl;
    /** Handler of this scope (for event-specific rules). */
    handler?: HandlerDecl;
}

export type RefKind =
    | "value"
    | "call"
    | "routine"
    | "type"
    | "node"
    | "cursor"
    | "event"
    | "exitPoint"
    | "image"
    | "member"
    | "control"
    | "block"
    | "attribute"
    | "namespace";

export interface Reference {
    kind: RefKind;
    /** Span of the referenced name (for qualified names, the last segment). */
    span: Span;
    name: string;
    qualifier: string[];
    qualifierSpans: Span[];
    scope: Scope;
    write?: boolean;
    /** Arguments given at a call site, for arity checks. */
    argCount?: number;
    /** For member references, the expression whose type owns the member. */
    object?: Expr;
    /** Expression the reference came from (calls, names), used for type inference. */
    expr?: Expr;
    /** The name is written inside a string literal (node names, images, controls). */
    inString?: boolean;
    /** Control type prefix of a control-name reference (`input 'x' ...`). */
    controlType?: string;
}

export interface FileModel {
    uri: string;
    source: SourceFile;
    root: Scope;
    symbols: AslSymbol[];
    references: Reference[];
    imports: { path: StringName; namespace?: string; namespaceSpan?: Span; isPrivate: boolean; span: Span }[];
    nodes: Map<string, AslSymbol>;
    /** Scope of every node and block, keyed by symbol. */
    nodeScopes: Map<AslSymbol, Scope>;
    /** Every scope, outermost first, for position lookups. */
    scopes: Scope[];
    /** The file declares managed DLLs, web services or using namespaces. */
    managed: boolean;
}

const CONTROL_PREFIXES = new Set(["graphical element", "input", "container", "web browser", "email editor", "chat control", "menu", "table"]);

export function bind(uri: string, source: SourceFile): FileModel {
    const binder = new Binder(uri, source);
    binder.bindFile();
    return binder.model;
}

class Binder {
    readonly model: FileModel;
    private readonly commentsByEnd: CommentTrivia[];

    constructor(
        readonly uri: string,
        readonly source: SourceFile
    ) {
        const root: Scope = { kind: "file", span: { start: 0, end: source.text.length }, symbols: new Map() };
        this.model = { uri, source, root, symbols: [], references: [], imports: [], nodes: new Map(), nodeScopes: new Map(), scopes: [root], managed: false };
        this.commentsByEnd = source.comments;
    }

    /** Comment that immediately follows a declaration on the same or next line (`x: text comment { ... }`). */
    private docAfter(span: Span): string | undefined {
        const text = this.source.text;
        for (const comment of this.commentsByEnd) {
            if (comment.start < span.end) continue;
            const between = text.slice(span.end, comment.start);
            if (/^[ \t]*(\r?\n[ \t]*)?$/.test(between)) {
                return comment.text.trim();
            }
            break;
        }
        return undefined;
    }

    private declare(scope: Scope, symbol: Omit<AslSymbol, "key" | "uri" | "scope">): AslSymbol {
        const full: AslSymbol = { ...symbol, key: symbol.name.toLowerCase(), uri: this.uri, scope };
        const list = scope.symbols.get(full.key);
        if (list) list.push(full);
        else scope.symbols.set(full.key, [full]);
        this.model.symbols.push(full);
        return full;
    }

    private ref(reference: Reference): void {
        if (reference.name) this.model.references.push(reference);
    }

    bindFile(): void {
        const root = this.model.root;
        // Nodes and routines are global regardless of position, so declare them first.
        for (const decl of this.source.decls) this.declareTopLevel(decl, root);
        for (const decl of this.source.decls) this.bindDecl(decl, root);
    }

    private declareTopLevel(decl: Decl, scope: Scope): void {
        switch (decl.kind) {
            case "modules":
                for (const item of decl.imports) {
                    this.model.imports.push({ path: item.path, namespace: item.namespace?.text, namespaceSpan: item.namespace, isPrivate: item.isPrivate, span: item });
                    if (item.namespace) {
                        this.declare(scope, { name: item.namespace.text, kind: "namespace", span: item, nameSpan: item.namespace, isPrivate: item.isPrivate, detail: item.path.value });
                    }
                }
                break;
            case "dependencies":
                for (const item of decl.items) {
                    if (item.dependencyKind === "dll" && item.dllKind === "managed") this.model.managed = true;
                    if (item.dependencyKind === "web service") this.model.managed = true;
                    if (item.name && (item.dependencyKind === "image" || item.dependencyKind === "dll" || item.dependencyKind === "web service")) {
                        this.declare(scope, {
                            name: item.name.value,
                            kind: item.dependencyKind === "image" ? "image" : "dll",
                            span: item,
                            nameSpan: item.name,
                            isPrivate: item.isPrivate,
                            detail: item.dependencyKind === "dll" ? `dll ${item.dllKind ?? ""}`.trim() : item.dependencyKind,
                            decl
                        });
                    }
                }
                break;
            case "using":
                this.model.managed = true;
                break;
            case "routine":
                this.declareRoutine(decl, scope);
                break;
            case "node": {
                const symbol = this.declare(scope, { name: decl.name.value, kind: decl.kind, span: decl, nameSpan: decl.name, isPrivate: decl.isPrivate, decl, doc: this.docAfter(decl.name) });
                this.model.nodes.set(symbol.key, symbol);
                break;
            }
            case "block":
                this.declare(scope, { name: decl.name.value, kind: "block", span: decl, nameSpan: decl.name, isPrivate: decl.isPrivate, decl, doc: this.docAfter(decl.name) });
                break;
            default:
                break;
        }
    }

    private declareRoutine(decl: RoutineDecl, scope: Scope, container?: AslSymbol): AslSymbol {
        return this.declare(scope, {
            name: decl.name.text,
            kind: decl.routine,
            span: decl,
            nameSpan: decl.name,
            isPrivate: decl.isPrivate,
            type: decl.returnType,
            params: decl.params,
            decl,
            container,
            doc: this.docAfter(decl.params.length ? decl.params[decl.params.length - 1] : decl.name) ?? this.docAfter(decl.name),
            detail: decl.external ? "external" : undefined
        });
    }

    private bindDecl(decl: Decl, scope: Scope, container?: AslSymbol): void {
        switch (decl.kind) {
            case "section":
                this.bindSection(decl, scope, container);
                break;
            case "routine":
                this.bindRoutine(decl, scope, container);
                break;
            case "handler":
                this.bindHandler(decl, scope);
                break;
            case "node":
            case "block":
                this.bindNode(decl, scope);
                break;
            case "control":
                this.bindControl(decl, scope, container);
                break;
            case "exitPoint":
                this.bindBlock(decl.body, this.childScope(scope, "handler", decl.body));
                break;
            case "functionKey":
            case "nodeLoop":
                this.bindBlock(decl.body, this.childScope(scope, "handler", decl.body));
                break;
            case "clause":
                for (const arg of decl.args) this.bindExpr(arg, scope);
                if (decl.words === "background image" && decl.args[0]?.kind === "string") this.stringRef("image", decl.args[0], scope);
                if (decl.words === "default master" && decl.args[0]?.kind === "string") this.stringRef("node", decl.args[0], scope);
                break;
            case "modules":
                for (const item of decl.imports) {
                    if (item.defaultMaster) this.ref({ kind: "node", span: inner(item.defaultMaster), name: item.defaultMaster.value, qualifier: [], qualifierSpans: [], scope, inString: true });
                }
                break;
            case "dependencies":
            case "using":
                break;
        }
    }

    private childScope(parent: Scope, kind: ScopeKind, span: Span, owner?: AslSymbol): Scope {
        const scope: Scope = { kind, parent, owner, span, symbols: new Map(), node: parent.node, handler: parent.handler };
        this.model.scopes.push(scope);
        return scope;
    }

    private bindSection(section: Section, scope: Scope, container?: AslSymbol): void {
        const business = Object.entries(BUSINESS_VARIABLES).find(([, value]) => value.section === section.section);
        if (business) {
            const members = new Map<string, AslSymbol>();
            const record = this.declare(scope, { name: business[0], kind: "businessRecord", span: section, nameSpan: section.keyword, isPrivate: false, members, detail: section.section });
            const fieldScope: Scope = { kind: "local", parent: scope, span: section, symbols: new Map() };
            for (const item of section.items) {
                if (item.kind !== "variable") continue;
                const field = this.declare(fieldScope, { name: item.name.text, kind: "field", span: item, nameSpan: item.name, isPrivate: false, type: item.type, decl: item, container: record, doc: this.docAfter(item) });
                members.set(field.key, field);
                this.bindTypeRef(item.type, scope);
            }
            return;
        }
        for (const item of section.items) {
            switch (item.kind) {
                case "variable": {
                    const symbol = this.declare(scope, {
                        name: item.name.text,
                        kind: section.section === "parameters" ? "parameter" : "variable",
                        span: item,
                        nameSpan: item.name,
                        isPrivate: item.isPrivate,
                        type: item.type,
                        decl: item,
                        container,
                        doc: this.docAfter(item)
                    });
                    symbol.members = this.recordMembers(item.type, scope, symbol);
                    this.bindTypeRef(item.type, scope);
                    if (item.init) this.bindExpr(item.init, scope);
                    if (item.check) this.bindExpr(item.check, scope);
                    break;
                }
                case "constant": {
                    this.declare(scope, { name: item.name.text, kind: "constant", span: item, nameSpan: item.name, isPrivate: item.isPrivate, decl: section, container, doc: this.docAfter(item), detail: item.value ? this.source.text.slice(item.value.start, item.value.end) : undefined });
                    if (item.value) this.bindExpr(item.value, scope);
                    break;
                }
                case "type": {
                    const symbol = this.declare(scope, { name: item.name.text, kind: "type", span: item, nameSpan: item.name, isPrivate: item.isPrivate, type: item.type, decl: section, doc: this.docAfter(item) });
                    if (item.type.kind === "enumeration") {
                        symbol.members = new Map();
                        const memberScope: Scope = { kind: "local", parent: scope, span: item, symbols: new Map() };
                        for (const member of item.type.members) {
                            const memberSymbol = this.declare(memberScope, { name: member.name.text, kind: "enumMember", span: member, nameSpan: member.name, isPrivate: false, container: symbol });
                            symbol.members.set(memberSymbol.key, memberSymbol);
                            if (member.label) this.bindExpr(member.label, scope);
                        }
                        if (item.type.definedIn) this.bindExpr(item.type.definedIn, scope);
                    } else {
                        symbol.members = this.recordMembers(item.type, scope, symbol);
                        this.bindTypeRef(item.type, scope);
                    }
                    break;
                }
                case "cursor": {
                    this.declare(scope, { name: item.name.text, kind: "cursor", span: item, nameSpan: item.name, isPrivate: item.isPrivate, decl: item, container, detail: item.cursorKind, doc: this.docAfter(item) });
                    for (const slot of item.slots) this.bindExpr(slot.expr, scope);
                    break;
                }
                case "extensionRecord": {
                    const members = new Map<string, AslSymbol>();
                    const recordType = this.declare(scope, { name: `${item.name.text}Record`, kind: "type", span: item, nameSpan: item.name, isPrivate: false, members, detail: "contact profile extension" });
                    this.declare(scope, { name: item.name.text, kind: "variable", span: item, nameSpan: item.name, isPrivate: false, members, detail: "contact profile extension" });
                    const fieldScope: Scope = { kind: "local", parent: scope, span: item, symbols: new Map() };
                    for (const field of item.fields) {
                        const fieldSymbol = this.declare(fieldScope, { name: field.name.text, kind: "field", span: field, nameSpan: field.name, isPrivate: false, type: field.type, decl: field, container: recordType });
                        members.set(fieldSymbol.key, fieldSymbol);
                    }
                    if (item.directory) this.bindExpr(item.directory, scope);
                    break;
                }
            }
        }
    }

    /** Fields of an inline record type (`x: record { a: text }`). */
    private recordMembers(type: TypeRef | undefined, scope: Scope, owner: AslSymbol): Map<string, AslSymbol> | undefined {
        if (!type || type.kind !== "record") return undefined;
        const members = new Map<string, AslSymbol>();
        const fieldScope: Scope = { kind: "local", parent: scope, span: type, symbols: new Map() };
        for (const field of type.fields) {
            const symbol = this.declare(fieldScope, { name: field.name.text, kind: "field", span: field, nameSpan: field.name, isPrivate: false, type: field.type, decl: field, container: owner, doc: this.docAfter(field) });
            symbol.members = this.recordMembers(field.type, scope, symbol);
            members.set(symbol.key, symbol);
            this.bindTypeRef(field.type, scope);
        }
        return members;
    }

    private bindTypeRef(type: TypeRef | undefined, scope: Scope): void {
        if (!type) return;
        switch (type.kind) {
            case "named":
                this.ref({ kind: "type", span: type.name, name: type.name.text, qualifier: type.qualifier.map((q) => q.text), qualifierSpans: type.qualifier, scope });
                type.typeArgs?.forEach((arg) => this.bindTypeRef(arg, scope));
                break;
            case "array":
                if (type.size) this.bindExpr(type.size, scope);
                this.bindTypeRef(type.element, scope);
                break;
            default:
                break;
        }
    }

    private bindRoutine(decl: RoutineDecl, scope: Scope, container?: AslSymbol): void {
        let symbol = [...(scope.symbols.get(decl.name.text.toLowerCase()) ?? [])].find((s) => s.decl === decl);
        if (!symbol) symbol = this.declareRoutine(decl, scope, container);
        const routineScope = this.childScope(scope, "routine", decl, symbol);
        for (const param of decl.params) {
            this.declare(routineScope, { name: param.name.text, kind: "parameter", span: param, nameSpan: param.name, isPrivate: false, type: param.type, decl: param, container: symbol, detail: param.isRef ? "ref" : undefined });
            this.bindTypeRef(param.type, scope);
        }
        this.bindTypeRef(decl.returnType, scope);
        if (decl.body) this.bindBlock(decl.body, routineScope, true);
    }

    private bindHandler(decl: HandlerDecl, scope: Scope): void {
        const handlerScope = this.childScope(scope, "handler", decl);
        handlerScope.handler = decl;
        if (decl.userEvent && scope.kind === "node") {
            this.declare(scope, { name: decl.userEvent.text, kind: "event", span: decl, nameSpan: decl.userEvent, isPrivate: false, params: decl.params, decl, container: scope.owner });
        }
        for (const param of decl.params) {
            this.declare(handlerScope, { name: param.name.text, kind: "parameter", span: param, nameSpan: param.name, isPrivate: false, type: param.type, decl: param, detail: param.isRef ? "ref" : undefined });
            this.bindTypeRef(param.type, scope);
        }
        this.bindBlock(decl.body, handlerScope, true);
    }

    private bindNode(decl: NodeDecl, scope: Scope): void {
        const symbol = [...(scope.symbols.get(decl.name.value.toLowerCase()) ?? [])].find((s) => s.decl === decl);
        const nodeScope: Scope = { kind: decl.kind === "block" ? "block" : "node", parent: scope, owner: symbol, span: decl, symbols: new Map(), node: decl };
        this.model.scopes.push(nodeScope);
        if (symbol) this.model.nodeScopes.set(symbol, nodeScope);
        if (decl.master) {
            const name = decl.master.name;
            if (name.kind === "string" && name.interpolations.length === 0) {
                this.ref({ kind: "node", span: inner(name), name: name.value, qualifier: [], qualifierSpans: [], scope: nodeScope, inString: true });
            } else {
                this.bindExpr(name, nodeScope);
            }
            for (const arg of decl.master.args) this.bindExpr(arg, nodeScope);
        }
        if (decl.id) this.bindExpr(decl.id, nodeScope);
        // Declarations are visible throughout the node, so declare routines, controls and exit points first.
        for (const member of decl.members) {
            if (member.kind === "routine") this.declareRoutine(member, nodeScope, symbol);
            if (member.kind === "exitPoint") this.declare(nodeScope, { name: member.name.text, kind: "exitPoint", span: member, nameSpan: member.name, isPrivate: false, container: symbol });
            if (member.kind === "control" && member.name) {
                this.declare(nodeScope, { name: member.name.value, kind: "control", span: member, nameSpan: member.name, isPrivate: false, decl: member, container: symbol, detail: member.control });
            }
        }
        for (const member of decl.members) this.bindDecl(member, nodeScope, symbol);
    }

    private bindControl(decl: ControlDecl, scope: Scope, container?: AslSymbol): void {
        void container;
        if (decl.target) {
            if (decl.control === "table") this.cursorRef(decl.target, scope);
            else this.bindExpr(decl.target, scope, true);
        }
        for (const clause of decl.clauses) {
            for (const slot of clause.slots) {
                if (clause.words === "image" && slot.after === "image" && slot.expr.kind === "string") {
                    this.stringRef("image", slot.expr, scope);
                } else if (clause.words === "cursor" && slot.after === "cursor") {
                    this.cursorRef(slot.expr, scope);
                } else if (clause.words === "initial block" && slot.expr.kind === "string") {
                    this.stringRef("block", slot.expr, scope);
                } else {
                    this.bindExpr(slot.expr, scope);
                }
            }
        }
        for (const handler of decl.handlers) this.bindHandler(handler, scope);
    }

    // ------------------------------------------------------------ statements

    private bindBlock(block: Block, scope: Scope, reuse = false): void {
        const blockScope = reuse ? scope : this.childScope(scope, "local", block);
        for (const stmt of block.statements) this.bindStmt(stmt, blockScope);
    }

    private bindStmt(stmt: Stmt, scope: Scope): void {
        switch (stmt.kind) {
            case "if":
                this.bindExpr(stmt.cond, scope);
                this.bindBlock(stmt.then, scope);
                if (stmt.else) {
                    if ("statements" in stmt.else) this.bindBlock(stmt.else, scope);
                    else this.bindStmt(stmt.else, scope);
                }
                break;
            case "case":
                this.bindExpr(stmt.expr, scope);
                for (const when of stmt.whens) {
                    this.bindExpr(when.value, scope);
                    this.bindBlock(when.body, scope);
                }
                if (stmt.default) this.bindBlock(stmt.default, scope);
                break;
            case "while":
                this.bindExpr(stmt.cond, scope);
                this.bindBlock(stmt.body, scope);
                break;
            case "repeat":
                this.bindBlock(stmt.body, scope);
                this.bindExpr(stmt.cond, scope);
                break;
            case "for":
                this.bindExpr(stmt.variable, scope, true);
                this.bindExpr(stmt.from, scope);
                this.bindExpr(stmt.to, scope);
                if (stmt.step) this.bindExpr(stmt.step, scope);
                this.bindBlock(stmt.body, scope);
                break;
            case "var": {
                const decl = stmt.decl;
                if (decl.init) this.bindExpr(decl.init, scope);
                this.bindTypeRef(decl.type, scope);
                const symbol = this.declare(scope, { name: decl.name.text, kind: "variable", span: decl, nameSpan: decl.name, isPrivate: false, type: decl.type, decl, isLocal: true, container: scope.owner });
                symbol.members = this.recordMembers(decl.type, scope, symbol);
                break;
            }
            case "const":
                if (stmt.decl.value) this.bindExpr(stmt.decl.value, scope);
                this.declare(scope, { name: stmt.decl.name.text, kind: "constant", span: stmt.decl, nameSpan: stmt.decl.name, isPrivate: false, isLocal: true, detail: stmt.decl.value ? this.source.text.slice(stmt.decl.value.start, stmt.decl.value.end) : undefined });
                break;
            case "assign":
                this.bindExpr(stmt.target, scope, true);
                this.bindExpr(stmt.value, scope);
                break;
            case "call":
                this.bindCallee(stmt.callee, stmt.args.length, scope, "routine");
                for (const arg of stmt.args) this.bindExpr(arg.expr, scope, arg.mode !== undefined);
                break;
            case "goto":
                this.nodeNameRef(stmt.target, scope);
                for (const arg of stmt.args) this.bindExpr(arg, scope);
                break;
            case "action":
                this.bindAction(stmt, scope);
                break;
            case "error":
                break;
        }
    }

    private bindAction(stmt: ActionStmt, scope: Scope): void {
        const action = stmt.action >= 0 ? ACTIONS[stmt.action] : undefined;
        const prefix = action && CONTROL_PREFIXES.has(action.phrase) ? action.phrase : undefined;
        stmt.slots.forEach((slot, index) => this.bindSlot(slot, index, stmt, prefix, scope));
        for (const block of stmt.blocks) this.bindBlock(block, scope);
    }

    private bindSlot(slot: SlotValue, index: number, stmt: ActionStmt, controlPrefix: string | undefined, scope: Scope): void {
        const after = slot.after;
        if (slot.cls === "id") {
            const kind: RefKind | undefined = after === "cursor" ? "cursor" : after === "event" || after === "handler" ? "event" : after === "through" ? "exitPoint" : undefined;
            if (kind && slot.expr.kind === "name") {
                this.ref({ kind, span: slot.expr.name, name: slot.expr.name.text, qualifier: slot.expr.qualifier.map((q) => q.text), qualifierSpans: slot.expr.qualifier, scope });
                return;
            }
            if (after === "attribute" && slot.expr.kind === "name") {
                // `attribute ID := value` names the attribute; a bare `attribute ID` also reads variable ID.
                if (!/^\s*:=/.test(this.source.text.slice(slot.expr.end, slot.expr.end + 8))) this.bindExpr(slot.expr, scope);
                return;
            }
            if (after === "element" && stmt.words === "flow view element") return;
            this.bindExpr(slot.expr, scope);
            return;
        }
        if (index === 0 && controlPrefix && slot.expr.kind === "string") {
            this.stringRef("control", slot.expr, scope, controlPrefix === "graphical element" ? undefined : controlPrefix);
            return;
        }
        if ((stmt.words === "open window" && index === 0) || (stmt.words === "open tab" && after === "node")) {
            this.nodeNameRef(slot.expr, scope);
            return;
        }
        if (after === "block" && stmt.words === "container") {
            if (slot.expr.kind === "string") this.stringRef("block", slot.expr, scope);
            else this.bindExpr(slot.expr, scope);
            return;
        }
        this.bindExpr(slot.expr, scope, slot.cls === "var");
    }

    private nodeNameRef(expr: Expr, scope: Scope): void {
        if (expr.kind === "string" && expr.interpolations.length === 0) {
            this.stringRef("node", expr, scope);
        } else {
            this.bindExpr(expr, scope);
        }
    }

    private stringRef(kind: RefKind, expr: Expr, scope: Scope, controlType?: string): void {
        if (expr.kind !== "string") {
            this.bindExpr(expr, scope);
            return;
        }
        if (expr.interpolations.length > 0) {
            for (const part of expr.interpolations) this.bindExpr(part, scope);
            return;
        }
        this.ref({ kind, span: inner(expr), name: expr.value, qualifier: [], qualifierSpans: [], scope, inString: true, controlType });
    }

    private cursorRef(expr: Expr, scope: Scope): void {
        if (expr.kind === "name") {
            this.ref({ kind: "cursor", span: expr.name, name: expr.name.text, qualifier: expr.qualifier.map((q) => q.text), qualifierSpans: expr.qualifier, scope });
        } else {
            this.bindExpr(expr, scope);
        }
    }

    private bindCallee(callee: Expr, argCount: number, scope: Scope, kind: "routine" | "call"): void {
        if (callee.kind === "name") {
            this.ref({ kind, span: callee.name, name: callee.name.text, qualifier: callee.qualifier.map((q) => q.text), qualifierSpans: callee.qualifier, scope, argCount, expr: callee });
        } else if (callee.kind === "member") {
            this.bindExpr(callee.object, scope);
            this.ref({ kind: "member", span: callee.name, name: callee.name.text, qualifier: [], qualifierSpans: [], scope, object: callee.object, argCount });
        } else {
            this.bindExpr(callee, scope);
        }
    }

    // ------------------------------------------------------------ expressions

    bindExpr(expr: Expr, scope: Scope, write = false): void {
        switch (expr.kind) {
            case "name":
                this.ref({ kind: "value", span: expr.name, name: expr.name.text, qualifier: expr.qualifier.map((q) => q.text), qualifierSpans: expr.qualifier, scope, write, expr });
                expr.typeArgs?.forEach((t) => this.bindTypeRef(t, scope));
                break;
            case "attr":
                this.ref({ kind: "attribute", span: expr.name, name: expr.name.text, qualifier: [], qualifierSpans: [], scope, expr });
                break;
            case "member":
                this.bindExpr(expr.object, scope);
                this.ref({ kind: "member", span: expr.name, name: expr.name.text, qualifier: [], qualifierSpans: [], scope, object: expr.object, write, expr });
                break;
            case "index":
                this.bindExpr(expr.object, scope, write);
                this.bindExpr(expr.index, scope);
                break;
            case "call":
                this.bindCallee(expr.callee, expr.args.length, scope, "call");
                for (const arg of expr.args) this.bindExpr(arg.expr, scope, arg.mode !== undefined);
                break;
            case "unary":
                this.bindExpr(expr.operand, scope);
                break;
            case "binary":
                this.bindExpr(expr.left, scope);
                this.bindExpr(expr.right, scope);
                break;
            case "paren":
                this.bindExpr(expr.expr, scope);
                break;
            case "coerce":
                this.bindExpr(expr.expr, scope);
                break;
            case "new":
                this.bindTypeRef(expr.type, scope);
                for (const arg of expr.args) this.bindExpr(arg.expr, scope);
                break;
            case "string":
                for (const part of expr.interpolations) this.bindExpr(part, scope);
                break;
            case "concat":
                for (const part of expr.parts) this.bindExpr(part, scope);
                break;
            default:
                break;
        }
    }
}

/** Span of a string literal without its quotes. */
export function inner(span: Span & { value?: string }): Span {
    return { start: span.start + 1, end: Math.max(span.start + 1, span.end - 1) };
}

/** Walks every statement of a block tree. */
export function forEachStatement(block: Block, visit: (stmt: Stmt, depth: number) => void, depth = 0): void {
    for (const stmt of block.statements) {
        visit(stmt, depth);
        for (const child of childBlocks(stmt)) forEachStatement(child, visit, depth + 1);
    }
}

export function childBlocks(stmt: Stmt): Block[] {
    switch (stmt.kind) {
        case "if": {
            const blocks = [stmt.then];
            if (stmt.else) {
                if ("statements" in stmt.else) blocks.push(stmt.else);
                else blocks.push({ statements: [stmt.else], start: stmt.else.start, end: stmt.else.end });
            }
            return blocks;
        }
        case "case":
            return [...stmt.whens.map((w) => w.body), ...(stmt.default ? [stmt.default] : [])];
        case "while":
        case "repeat":
        case "for":
            return [stmt.body];
        case "action":
            return stmt.blocks;
        default:
            return [];
    }
}

/** Every routine, handler and node-level block of a file, with the node that encloses it. */
export function forEachBody(decls: Decl[], visit: (body: Block, owner: RoutineDecl | HandlerDecl | Decl, node: NodeDecl | undefined) => void, node?: NodeDecl): void {
    for (const decl of decls) {
        switch (decl.kind) {
            case "routine":
                if (decl.body) visit(decl.body, decl, node);
                break;
            case "handler":
                visit(decl.body, decl, node);
                break;
            case "node":
            case "block":
                forEachBody(decl.members, visit, decl);
                break;
            case "control":
                for (const handler of decl.handlers) visit(handler.body, handler, node);
                break;
            case "exitPoint":
            case "functionKey":
            case "nodeLoop":
                visit(decl.body, decl, node);
                break;
            default:
                break;
        }
    }
}
