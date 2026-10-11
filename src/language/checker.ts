/**
 * Diagnostics: parser errors, unresolved references, declaration problems, ASL Web Edition
 * restrictions and the asynchronous-UI rules learned from running 8.7 web scripts.
 */
import type { ActionStmt, Block, ControlDecl, Decl, Expr, HandlerDecl, NodeDecl, RoutineDecl, Span, Stmt } from "./ast";
import { childBlocks, forEachBody, forEachStatement, type AslSymbol, type FileModel, type Reference, type Scope } from "./binder";
import { ACTIONS, CONTROLS, EVENTS, functionArity } from "./catalog";
import { baseName, type Program } from "./program";

export type Severity = "error" | "warning" | "info" | "hint";

export interface AslDiagnostic extends Span {
    message: string;
    code: string;
    severity: Severity;
    tags?: ("unnecessary" | "deprecated")[];
    /** Extra data used by quick fixes. */
    data?: { fix?: string; [key: string]: unknown };
}

export interface RuleInfo {
    id: string;
    severity: Severity;
    description: string;
}

export const RULES: RuleInfo[] = [
    { id: "syntax", severity: "error", description: "Syntax errors." },
    { id: "unknown-action", severity: "error", description: "A statement that is not a known ASL action." },
    { id: "unknown-clause", severity: "warning", description: "A graphical element clause that the 8.7 reference does not document." },
    { id: "unresolved-name", severity: "error", description: "A variable, constant, cursor, routine or attribute that is not declared." },
    { id: "unresolved-type", severity: "error", description: "A type that is not declared." },
    { id: "unresolved-member", severity: "error", description: "A record field that does not exist." },
    { id: "unresolved-node", severity: "error", description: "A node name that is not declared in the script or its modules." },
    { id: "unresolved-event", severity: "warning", description: "A triggered event with no `on event` handler in the node or its masters." },
    { id: "unresolved-control", severity: "warning", description: "A graphical element name that no node declares." },
    { id: "unresolved-image", severity: "warning", description: "An image that is not declared in dependencies." },
    { id: "unresolved-block", severity: "error", description: "A block name that is not declared." },
    { id: "missing-import", severity: "error", description: "An imported module file that cannot be found." },
    { id: "argument-count", severity: "error", description: "Wrong number of arguments in a call." },
    { id: "invalid-call", severity: "error", description: "A subroutine used as a value." },
    { id: "duplicate-declaration", severity: "error", description: "Two declarations with the same name in one scope (ASL names are case-insensitive)." },
    { id: "duplicate-node-id", severity: "warning", description: "Two nodes with the same id." },
    { id: "shadowed-declaration", severity: "warning", description: "A node declaration hides a script or module declaration with the same name." },
    { id: "unused-declaration", severity: "hint", description: "A declaration that is never used." },
    { id: "unreachable-code", severity: "hint", description: "Actions after goto node, back node, return or end script never run." },
    { id: "unknown-event", severity: "warning", description: "An event handler that the reference does not document for this element or node." },
    { id: "misplaced-handler", severity: "warning", description: "A handler declared where it never runs (for example `on enter` outside a node)." },
    { id: "navigation-in-exit", severity: "error", description: "Node navigation inside on exit, on end or on unload, where it is ignored." },
    { id: "script-start", severity: "warning", description: "A script without `on start`, or an `on start` that never moves to a node." },
    { id: "module-kind", severity: "error", description: "Imports or declarations not allowed for this kind of module." },
    { id: "control-clause", severity: "warning", description: "A graphical element without a required clause or binding." },
    { id: "web-unsupported", severity: "warning", description: "Constructs that ASL Web Edition (Agent Portal) dropped or does not support." },
    { id: "deprecated", severity: "hint", description: "Deprecated or renamed constructs." },
    { id: "native-dll", severity: "info", description: "Native DLL dependencies and external routines; prefer managed DLLs or web services in 8.7." },
    { id: "overlay-position", severity: "info", description: "An overlay window with a fixed `at` position instead of the centred default." },
    { id: "overlay-in-enter", severity: "warning", description: "An overlay window opened directly in on enter / on first enter." },
    { id: "popup-then-goto", severity: "warning", description: "Node navigation after opening an overlay on the same path." },
    { id: "popup-then-popup", severity: "warning", description: "A second overlay opened while the first is still open." },
    { id: "overlay-result-read", severity: "warning", description: "Reading the overlay result variable right after opening it, instead of in the on close event." },
    { id: "async-function-result", severity: "warning", description: "Using the value of a function that opens an overlay window." },
    { id: "email-async", severity: "warning", description: "Asynchronous email editor actions combined in one block of actions." },
    { id: "button-shadows-master", severity: "warning", description: "A push button without actions placed over an inherited master button." },
    { id: "unreachable-module", severity: "hint", description: "A module that no file in the workspace imports." }
];

export const RULE_SEVERITY = new Map(RULES.map((r) => [r.id, r.severity]));

const TERMINATING = new Set(["back node", "return node", "end script", "abort script", "discard script", "restart script", "return", "break loop"]);

export interface CheckOptions {
    webEdition: boolean;
    /** Paths of known workspace files, to tell an unreadable import from a missing one. */
    isModuleImportedAnywhere?: (file: FileModel) => boolean | undefined;
}

export function check(file: FileModel, program: Program, options: CheckOptions): AslDiagnostic[] {
    return new Checker(file, program, options).run();
}

interface PathState {
    /** Offset of the overlay/popup opened earlier on this path. */
    popupAt?: number;
    /** The popup comes from a called routine that only may open it. */
    popupIndirect?: boolean;
    /** Variables (lower-case) that receive an overlay result on this path. */
    resultVars: Map<string, number>;
}

class Checker {
    private readonly out: AslDiagnostic[] = [];
    private readonly text: string;
    private readonly isModule: boolean;
    private opensCache?: Map<AslSymbol, { opens: boolean; navigates: boolean }>;

    constructor(
        readonly file: FileModel,
        readonly program: Program,
        readonly options: CheckOptions
    ) {
        this.text = file.source.text;
        this.isModule = ["agm", "irm", "gem"].includes(file.source.fileKind);
    }

    private report(span: Span, code: string, message: string, extra?: Partial<AslDiagnostic>): void {
        this.out.push({ start: span.start, end: Math.max(span.end, span.start + 1), code, message, severity: RULE_SEVERITY.get(code) ?? "warning", ...extra });
    }

    run(): AslDiagnostic[] {
        for (const d of this.file.source.diagnostics) {
            this.out.push({ start: d.start, end: d.end, message: d.message, code: d.code, severity: d.code === "syntax" || d.code === "unknown-action" ? "error" : (RULE_SEVERITY.get(d.code) ?? "warning") });
        }
        this.checkImports();
        this.checkReferences();
        this.checkDeclarations(this.file.root);
        this.checkStructure();
        this.checkBodies();
        this.checkControls();
        return this.out;
    }

    // ------------------------------------------------------------ imports and module kinds

    private checkImports(): void {
        const kind = this.file.source.fileKind;
        for (const link of this.program.linksFrom(this.file)) {
            const item = this.file.imports[link.importIndex];
            const target = item.path.value.split(/[\\/]/).pop() ?? "";
            const ext = target.slice(target.lastIndexOf(".") + 1).toLowerCase();
            if (!link.target) {
                this.report(item.path, "missing-import", `Cannot find module '${item.path.value}'.`);
            }
            const agent = kind === "ags" || kind === "agm";
            const ivr = kind === "irs" || kind === "irm";
            if ((agent && (ext === "irm" || ext === "irs")) || (ivr && (ext === "agm" || ext === "ags")) || (kind === "gem" && ext !== "gem") || ext === "ags" || ext === "irs") {
                const allowed = kind === "gem" ? "other generic modules (.gem)" : agent ? "agent modules (.agm) and generic modules (.gem)" : "IVR modules (.irm) and generic modules (.gem)";
                this.report(item.path, "module-kind", `A .${kind} file can only import ${allowed}.`);
            }
            if (link.target && this.options.webEdition && (kind === "ags" || kind === "irs")) {
                const native = link.target.source.decls.flatMap((d) => (d.kind === "dependencies" ? d.items : [])).find((dep) => dep.dependencyKind === "dll" && dep.dllKind !== "managed");
                if (native) {
                    this.report(item.path, "native-dll", `${target} wraps the native DLL "${native.name?.value ?? ""}". In ASL Web Edition native DLLs run on the web server and must be 32-bit; prefer a managed DLL or a web service dependency.`);
                }
            }
        }
        if (this.isModule && this.options.isModuleImportedAnywhere?.(this.file) === false) {
            const first = this.file.source.decls[0];
            this.report(first ? { start: first.start, end: Math.min(first.end, first.start + 20) } : { start: 0, end: 1 }, "unreachable-module", `No script or module in the workspace imports ${baseName(this.file.uri)}.${this.file.source.fileKind}.`, { tags: ["unnecessary"] });
        }
    }

    // ------------------------------------------------------------ references

    private checkReferences(): void {
        const hostDependent = new Set(["node", "event", "control", "image", "block"]);
        for (const ref of this.file.references) {
            const resolution = this.program.resolve(this.file, ref);
            if (resolution.kind === "missing") {
                if (this.isModule && (hostDependent.has(ref.kind) || this.program.importersOf(this.file).length === 0) && ref.kind !== "member" && ref.kind !== "type") {
                    // Modules can target nodes, events and controls of the scripts that import them.
                    if (hostDependent.has(ref.kind)) continue;
                }
                this.reportUnresolved(ref, resolution.reason);
                continue;
            }
            if (resolution.kind === "function") {
                const fn = resolution.fn;
                if (ref.argCount !== undefined) {
                    const { min, max } = functionArity(fn);
                    if (ref.argCount < min || ref.argCount > max) {
                        this.report(ref.span, "argument-count", `${fn.name} expects ${min === max ? min : max === Infinity ? `at least ${min}` : `${min} to ${max}`} argument${max === 1 && min === 1 ? "" : "s"}, got ${ref.argCount}.`);
                    }
                }
                if (fn.deprecated && fn.name === "rgbcolor") {
                    this.report(ref.span, "deprecated", "'rgbcolor' was renamed to 'rgb_color'.", { tags: ["deprecated"], data: { fix: "replace", replacement: "rgb_color" } });
                } else if (fn.webNotes && this.options.webEdition && /not supported|fake path/i.test(fn.webNotes)) {
                    this.report(ref.span, "web-unsupported", `${fn.name}: ${fn.webNotes}`);
                }
                continue;
            }
            if (resolution.kind === "symbol") {
                const symbol = resolution.symbols[0];
                if ((symbol.kind === "subroutine" || symbol.kind === "function") && ref.argCount !== undefined && (ref.kind === "routine" || ref.kind === "call")) {
                    const expected = symbol.params?.length ?? 0;
                    if (ref.argCount !== expected) {
                        this.report(ref.span, "argument-count", `${symbol.kind === "function" ? "Function" : "Subroutine"} '${symbol.name}' expects ${expected} argument${expected === 1 ? "" : "s"}, got ${ref.argCount}.`);
                    }
                    if (ref.kind === "call" && symbol.kind === "subroutine") {
                        this.report(ref.span, "invalid-call", `Subroutine '${symbol.name}' does not return a value. Use 'call ${symbol.name}(...)'.`);
                    }
                }
                if (ref.kind === "event" && symbol.params && ref.argCount === undefined) {
                    // Events triggered by name pass no arguments; nothing to check.
                }
            }
        }
    }

    private reportUnresolved(ref: Reference, reason?: string): void {
        const qualified = [...ref.qualifier, ref.name].join("::");
        switch (ref.kind) {
            case "type":
                this.report(ref.span, "unresolved-type", reason ? `${reason}.` : `Cannot find type '${qualified}'.`);
                break;
            case "member":
                this.report(ref.span, "unresolved-member", `${reason ?? `Unknown field '${ref.name}'`}.`);
                break;
            case "node":
                this.report(ref.span, "unresolved-node", `Node "${ref.name}" is not declared in this script or its modules.`);
                break;
            case "event":
                this.report(ref.span, "unresolved-event", reason ? `Event '${ref.name}': ${reason}.` : `No 'on event ${ref.name}' handler is declared.`);
                break;
            case "control":
                this.report(ref.span, "unresolved-control", `No graphical element is named "${ref.name}".`);
                break;
            case "image":
                this.report(ref.span, "unresolved-image", `Image "${ref.name}" is not declared in dependencies.`);
                break;
            case "block":
                this.report(ref.span, "unresolved-block", `Block "${ref.name}" is not declared.`);
                break;
            case "attribute":
                this.report(ref.span, "unresolved-name", `Unknown built-in attribute '${ref.name}'.`);
                break;
            case "exitPoint":
                this.report(ref.span, "unresolved-name", `Exit point '${ref.name}' is not declared in this node.`);
                break;
            case "cursor":
                this.report(ref.span, "unresolved-name", `Cannot find cursor '${qualified}'.`);
                break;
            case "routine":
                this.report(ref.span, "unresolved-name", reason ? `${reason}.` : `Cannot find subroutine '${qualified}'.`);
                break;
            default:
                this.report(ref.span, "unresolved-name", reason ? `${reason}.` : `Cannot find '${qualified}'.`);
        }
    }

    // ------------------------------------------------------------ declarations

    private checkDeclarations(scope: Scope): void {
        const visit = (s: Scope): void => {
            for (const [, symbols] of s.symbols) {
                const groups = new Map<string, AslSymbol[]>();
                for (const symbol of symbols) {
                    const group = declarationGroup(symbol);
                    if (!group) continue;
                    const list = groups.get(group) ?? [];
                    list.push(symbol);
                    groups.set(group, list);
                }
                for (const list of groups.values()) {
                    for (const duplicate of list.slice(1)) {
                        if (["image", "node", "block"].includes(duplicate.kind) && duplicate.name !== list[0].name) continue;
                        this.report(duplicate.nameSpan, "duplicate-declaration", `'${duplicate.name}' is already declared in this scope${list[0].name !== duplicate.name ? ` as '${list[0].name}' (names are case-insensitive)` : ""}.`);
                    }
                }
            }
        };
        visit(scope);
        const scopes = new Set<Scope>();
        for (const symbol of this.file.symbols) scopes.add(symbol.scope);
        for (const s of scopes) if (s !== scope) visit(s);

        // Node declarations that hide script or module declarations.
        for (const [node, nodeScope] of this.file.nodeScopes) {
            void node;
            for (const [key, symbols] of nodeScope.symbols) {
                const local = symbols.find((s) => s.kind === "variable" || s.kind === "subroutine" || s.kind === "function" || s.kind === "cursor" || s.kind === "parameter");
                if (!local) continue;
                const global = this.program.globalLookup(this.file, key).find((g) => ["variable", "subroutine", "function", "cursor", "constant"].includes(g.kind));
                if (global) {
                    const where = global.uri === this.file.uri ? "script" : baseName(global.uri);
                    this.report(local.nameSpan, "shadowed-declaration", `'${local.name}' hides the ${global.kind} declared in ${where}; inside node "${nodeScope.owner?.name}" the ${global.kind} is not reachable.`);
                }
            }
        }

        this.checkUnused();
    }

    private checkUnused(): void {
        const used = new Set<AslSymbol>();
        for (const ref of this.file.references) {
            const resolution = this.program.resolve(this.file, ref);
            if (resolution.kind === "symbol") resolution.symbols.forEach((s) => used.add(s));
        }
        const masterNodes = new Set<AslSymbol>();
        for (const node of this.program.allNodes()) for (const master of this.program.masters(node)) masterNodes.add(master);
        for (const symbol of this.file.symbols) {
            if (used.has(symbol)) continue;
            const scopeKind = symbol.scope.kind;
            let check = false;
            if (symbol.isLocal && (symbol.kind === "variable" || symbol.kind === "constant")) {
                check = true;
            } else if ((scopeKind === "node" || scopeKind === "block") && ["variable", "cursor", "subroutine", "function", "constant"].includes(symbol.kind)) {
                const owner = symbol.scope.owner;
                check = !owner || !masterNodes.has(owner);
            } else if (scopeKind === "file" && ["variable", "cursor", "subroutine", "function", "constant"].includes(symbol.kind)) {
                check = !this.isModule || symbol.isPrivate;
            }
            if (!check) continue;
            const what = symbol.kind === "subroutine" || symbol.kind === "function" ? `${symbol.kind[0].toUpperCase()}${symbol.kind.slice(1)}` : symbol.kind === "cursor" ? "Cursor" : symbol.kind === "constant" ? "Constant" : "Variable";
            this.report(symbol.nameSpan, "unused-declaration", `${what} '${symbol.name}' is never used.`, { tags: ["unnecessary"] });
        }
    }

    // ------------------------------------------------------------ file structure

    private checkStructure(): void {
        const kind = this.file.source.fileKind;
        const decls = this.file.source.decls;
        if (kind === "gem") {
            for (const decl of decls) {
                if (decl.kind === "node" || decl.kind === "block") this.report(decl.keyword, "module-kind", `Generic modules (.gem) cannot declare ${decl.kind}s.`);
            }
        }
        const nodeIds = new Map<string, NodeDecl>();
        for (const decl of decls) {
            if (decl.kind === "node" && decl.id && decl.id.kind === "number") {
                const previous = nodeIds.get(decl.id.text);
                if (previous) this.report(decl.id, "duplicate-node-id", `Node id ${decl.id.text} is also used by node "${previous.name.value}".`);
                else nodeIds.set(decl.id.text, decl);
            }
            if (decl.kind === "section" && decl.section === "parameters" && decl.items.length > 0 && (kind === "ags" || kind === "irs")) {
                this.report(decl.keyword, "deprecated", "Script parameters are deprecated.", { tags: ["deprecated"] });
            }
            if (decl.kind === "section" && decl.section === "audio") {
                this.report(decl.keyword, "deprecated", "Audio resources are deprecated.", { tags: ["deprecated"] });
            }
            if (decl.kind === "dependencies" && this.options.webEdition) {
                for (const dep of decl.items) {
                    if (dep.dependencyKind === "dll" && dep.dllKind !== "managed") {
                        this.report(dep, "native-dll", `Native DLL "${dep.name?.value ?? ""}": in ASL Web Edition native DLLs run on the web server and must be 32-bit. Prefer a managed DLL (dll managed) or a web service dependency.`);
                    }
                }
            }
            if (decl.kind === "handler") this.checkHandlerPlacement(decl, "file");
            if (decl.kind === "node" || decl.kind === "block") {
                for (const member of decl.members) {
                    if (member.kind === "handler") this.checkHandlerPlacement(member, decl.kind);
                    if (member.kind === "functionKey" && this.options.webEdition) {
                        this.report({ start: member.start, end: member.start + 12 }, "web-unsupported", "The Agent Portal does not support function keys.");
                    }
                }
            }
        }
        if (kind === "ags" || kind === "irs") {
            const start = decls.find((d): d is HandlerDecl => d.kind === "handler" && d.event === "start");
            if (!start) {
                const anchor = decls.find((d) => d.kind === "node") ?? decls[0];
                if (anchor) this.report({ start: anchor.start, end: anchor.start + 4 }, "script-start", "The script has no 'on start' handler; it must move to the first node.");
            } else {
                let moves = false;
                forEachStatement(start.body, (stmt) => {
                    if (stmt.kind === "goto" || (stmt.kind === "action" && (stmt.words === "restart script" || stmt.words === "end script" || stmt.words === "discard script" || stmt.words === "abort script"))) moves = true;
                    if (stmt.kind === "call") moves = true;
                });
                if (!moves) this.report(start.eventSpan, "script-start", "'on start' should end with 'goto node' to the first node.");
            }
        }
    }

    private checkHandlerPlacement(handler: HandlerDecl, where: "file" | "node" | "block"): void {
        const kind = this.file.source.fileKind;
        const event = handler.event;
        const nodeOnly = ["enter", "first enter", "exit"];
        const misplaced = (message: string): void => this.report(handler.eventSpan, "misplaced-handler", message);
        if (where === "file") {
            if (nodeOnly.includes(event) || handler.eventKind) misplaced(`'on ${event}' only runs inside a node.`);
            else if ((event === "start" || event === "end") && !(kind === "ags" || kind === "irs")) misplaced(`Modules do not run 'on ${event}'; use 'on load' / 'on unload'.`);
            else if ((event === "load" || event === "unload") && (kind === "ags" || kind === "irs")) misplaced(`Scripts do not run 'on ${event}'; use 'on start' / 'on end'.`);
            return;
        }
        if (where === "block") {
            if (event !== "load" && event !== "unload" && !handler.eventKind) misplaced(`Blocks only run 'on load' and 'on unload'.`);
            return;
        }
        if (["start", "end", "load", "unload"].includes(event)) {
            misplaced(`'on ${event}' does not run inside a node.`);
            return;
        }
        if (handler.eventKind && !handler.userEvent) {
            const def = EVENTS.get(event);
            if (!def) {
                this.report(handler.eventSpan, "unknown-event", `'on ${event}' is not a documented event. User-defined events take a single name: 'on event Name()'.`);
            } else if (def.deprecated) {
                this.report(handler.eventSpan, "deprecated", `'on ${event}': ${def.deprecated}`, { tags: ["deprecated"] });
            }
        } else if (!handler.eventKind && !nodeOnly.includes(event) && event !== "") {
            this.report(handler.eventSpan, "unknown-event", `'on ${event}' is not a node handler. Use 'on event', 'on error' or 'on progress' for events.`);
        }
    }

    // ------------------------------------------------------------ action bodies

    private checkBodies(): void {
        forEachBody(this.file.source.decls, (body, owner, node) => {
            const handler = owner.kind === "handler" ? owner : undefined;
            const event = handler?.event ?? "";
            if (handler && (event === "exit" || event === "end" || event === "unload")) {
                forEachStatement(body, (stmt) => {
                    if (stmt.kind === "goto" || (stmt.kind === "action" && (stmt.words === "back node" || stmt.words === "return node"))) {
                        this.report(stmt, "navigation-in-exit", `Node navigation is ignored inside 'on ${event}'.`);
                    }
                });
            }
            if (this.file.source.fileKind === "gem") {
                forEachStatement(body, (stmt) => {
                    if (stmt.kind === "goto" || (stmt.kind === "action" && (stmt.words === "back node" || stmt.words === "return node"))) {
                        this.report(stmt, "module-kind", "Generic modules (.gem) cannot navigate between nodes.");
                    }
                });
            }
            this.checkUnreachable(body);
            this.checkActions(body);
            this.checkAsyncFlow(body, owner, node);
        });
    }

    private checkUnreachable(block: Block): void {
        const visit = (b: Block): void => {
            let terminated: Stmt | undefined;
            for (const stmt of b.statements) {
                if (terminated) {
                    this.report({ start: stmt.start, end: b.statements[b.statements.length - 1].end }, "unreachable-code", `Unreachable: the rest of the block is ignored after '${describe(terminated)}'.`, { tags: ["unnecessary"] });
                    break;
                }
                if (isTerminating(stmt)) terminated = stmt;
                for (const child of childBlocks(stmt)) visit(child);
            }
        };
        visit(block);
    }

    private checkActions(block: Block): void {
        const visit = (b: Block): void => {
            let loadEmail: ActionStmt | undefined;
            const setFields = new Map<string, ActionStmt>();
            for (const stmt of b.statements) {
                if (stmt.kind === "action" && stmt.action >= 0) {
                    const action = ACTIONS[stmt.action];
                    if (action.web && this.options.webEdition) {
                        this.report(stmt.keywords.length ? { start: stmt.start, end: stmt.keywords[stmt.keywords.length - 1].end } : stmt, action.name === "open modal window" ? "web-unsupported" : "web-unsupported", action.web.message, action.name === "open modal window" ? { severity: "error", data: { fix: "modal-to-overlay" } } : undefined);
                    }
                    if (action.deprecated) {
                        this.report({ start: stmt.start, end: stmt.keywords[stmt.keywords.length - 1]?.end ?? stmt.end }, "deprecated", action.deprecated, { tags: ["deprecated"] });
                    }
                    if (stmt.words === "open window") this.checkOpenWindow(stmt);
                    if (stmt.words === "email editor") {
                        const name = action.name;
                        if (name === "load email id") {
                            loadEmail = stmt;
                        } else if (EMAIL_ASYNC.has(name)) {
                            if (loadEmail) {
                                this.report(stmt, "email-async", `'${name}' right after 'load email' does not work in the Agent Portal: email editor actions are asynchronous. Run it in the 'on email loaded' handler.`);
                            } else if (name === "set field") {
                                const field = fieldOf(this.text, stmt);
                                const previous = setFields.get(field);
                                if (previous) {
                                    this.report(stmt, "email-async", `This 'set ${field} field' replaces the one on line ${this.lineOf(previous.start)}${field.includes("body") ? "; to append use 'insert html into body'" : ""}.`);
                                }
                                setFields.set(field, stmt);
                            }
                        }
                    }
                }
                for (const child of childBlocks(stmt)) visit(child);
            }
        };
        visit(block);
    }

    private checkOpenWindow(stmt: ActionStmt): void {
        const overlay = stmt.keywords.some((k) => this.text.slice(k.start, k.end).toLowerCase() === "overlay");
        const at = stmt.keywords.find((k) => this.text.slice(k.start, k.end).toLowerCase() === "at");
        if (overlay && at) {
            const slots = stmt.slots.filter((s) => s.after === "at" || (s.after === undefined && s.expr.start > at.start && s.expr.start < at.start + 30));
            const atSlots = stmt.slots.filter((s) => s.expr.start > at.start).slice(0, 2);
            const end = atSlots.length ? atSlots[atSlots.length - 1].expr.end : at.end;
            void slots;
            this.report({ start: at.start, end }, "overlay-position", "Overlay windows are centred by the Agent Portal when 'at' is omitted; a fixed position can place them off-screen on small viewports.", { data: { fix: "remove-range", start: at.start, end } });
        }
    }

    // ------------------------------------------------------------ asynchronous overlays

    /** Whether a routine (transitively) opens an overlay or navigates between nodes. */
    private routineEffects(symbol: AslSymbol): { opens: boolean; navigates: boolean } {
        this.opensCache ??= new Map();
        const cached = this.opensCache.get(symbol);
        if (cached) return cached;
        const result = { opens: false, navigates: false };
        this.opensCache.set(symbol, result);
        const decl = symbol.decl as RoutineDecl | undefined;
        const file = this.program.fileOf(symbol);
        if (!decl?.body || !file) return result;
        forEachStatement(decl.body, (stmt) => {
            if (opensPopup(stmt, file.source.text)) result.opens = true;
            if (stmt.kind === "goto" || (stmt.kind === "action" && (stmt.words === "back node" || stmt.words === "return node"))) result.navigates = true;
            if (stmt.kind === "call") {
                const callee = this.calleeSymbol(file, stmt);
                if (callee) {
                    const effects = this.routineEffects(callee);
                    result.opens ||= effects.opens;
                    result.navigates ||= effects.navigates;
                }
            }
        });
        return result;
    }

    private calleeSymbol(file: FileModel, stmt: Extract<Stmt, { kind: "call" }>): AslSymbol | undefined {
        if (stmt.callee.kind !== "name") return undefined;
        const callee = stmt.callee;
        const ref = file.references.find((r) => r.expr === callee || (r.kind === "routine" && r.span.start === callee.name.start));
        if (!ref) return undefined;
        const resolution = this.program.resolve(file, ref);
        return resolution.kind === "symbol" ? resolution.symbols.find((s) => s.kind === "subroutine" || s.kind === "function") : undefined;
    }

    private checkAsyncFlow(body: Block, owner: RoutineDecl | HandlerDecl | Decl, node: NodeDecl | undefined): void {
        const handler = owner.kind === "handler" ? owner : undefined;
        const isEnter = handler !== undefined && (handler.event === "enter" || handler.event === "first enter") && node !== undefined;
        let hasTimer = false;
        if (isEnter) forEachStatement(body, (stmt) => (hasTimer ||= stmt.kind === "action" && stmt.words.startsWith("set timer")));

        const sourceAt = (stmt: Stmt): string | undefined => {
            if (opensPopup(stmt, this.text)) return stmt.kind === "action" && stmt.words === "open message box" ? "message box" : "overlay window";
            if (stmt.kind === "call") {
                const callee = this.calleeSymbol(this.file, stmt);
                if (callee && this.routineEffects(callee).opens) return `'${callee.name}', which can open one`;
            }
            return undefined;
        };
        const navigates = (stmt: Stmt): string | undefined => {
            if (stmt.kind === "goto") return `${stmt.mode} node`;
            if (stmt.kind === "action" && (stmt.words === "back node" || stmt.words === "return node")) return stmt.words;
            if (stmt.kind === "call") {
                const callee = this.calleeSymbol(this.file, stmt);
                if (callee && this.routineEffects(callee).navigates) return `call to '${callee.name}' (navigates)`;
            }
            return undefined;
        };

        const walk = (block: Block, state: PathState): PathState => {
            let current: PathState = { popupAt: state.popupAt, popupIndirect: state.popupIndirect, resultVars: new Map(state.resultVars) };
            for (const stmt of block.statements) {
                // Reads of overlay result variables before anything else on this statement.
                if (current.resultVars.size > 0 && stmt.kind !== "goto") this.checkResultReads(stmt, current);
                const source = sourceAt(stmt);
                const nav = navigates(stmt);
                const indirect = current.popupIndirect || (source !== undefined && stmt.kind === "call");
                const soft = indirect ? { severity: "info" as Severity } : undefined;
                if (nav && current.popupAt !== undefined) {
                    this.report(stmt, "popup-then-goto", `'${nav}' after an overlay was opened on the same path (line ${this.lineOf(current.popupAt)}). The overlay disables the window, so this fails at run time; move it to the overlay's 'on close' event handler.`, current.popupIndirect ? { severity: "info" } : undefined);
                }
                if (source) {
                    if (current.popupAt !== undefined && source !== undefined) {
                        this.report(stmt, "popup-then-popup", `Popup (${source}) while the popup opened on line ${this.lineOf(current.popupAt)} may still be open; popups do not stack. Open it from the first one's 'on close' event handler.`, soft);
                    }
                    if (isEnter && !hasTimer) {
                        this.report(stmt, "overlay-in-enter", `Opening a popup (${source}) directly in 'on ${handler!.event}' races with the node being displayed. Defer it: 'set timer to 1 trigger event Open()' and open it in 'on event Open()'.`, stmt.kind === "call" ? { severity: "info" } : undefined);
                    }
                    if (current.popupAt === undefined) {
                        current.popupAt = stmt.start;
                        current.popupIndirect = stmt.kind === "call";
                    }
                    if (stmt.kind === "action" && stmt.words === "open window") this.collectResultVars(stmt, current);
                }
                if (stmt.kind === "if") {
                    const thenState = walk(stmt.then, current);
                    const elseState = stmt.else ? walk("statements" in stmt.else ? stmt.else : { statements: [stmt.else], start: stmt.else.start, end: stmt.else.end }, current) : current;
                    current = mergeStates(thenState, elseState);
                } else if (stmt.kind === "case") {
                    const states = [...stmt.whens.map((w) => walk(w.body, current)), stmt.default ? walk(stmt.default, current) : current];
                    current = states.reduce(mergeStates);
                } else if (stmt.kind === "while" || stmt.kind === "for" || stmt.kind === "repeat") {
                    current = mergeStates(current, walk(stmt.body, current));
                } else if (stmt.kind === "action" && stmt.blocks.length) {
                    current = stmt.blocks.reduce((acc, b) => mergeStates(acc, walk(b, acc)), current);
                }
                if (isTerminating(stmt)) break;
            }
            return current;
        };
        walk(body, { resultVars: new Map() });
        this.checkAsyncFunctionValues(body);
    }

    /** Variables passed to `ref` parameters of the overlay node receive its result when it closes. */
    private collectResultVars(stmt: ActionStmt, state: PathState): void {
        if (!stmt.keywords.some((k) => this.text.slice(k.start, k.end).toLowerCase() === "overlay")) return;
        const target = stmt.slots[0]?.expr;
        if (!target || target.kind !== "string" || target.interpolations.length) return;
        const node = this.program.findNodes(target.value, this.file)[0];
        const decl = node?.decl as NodeDecl | undefined;
        if (!decl) return;
        const params = decl.members.find((m) => m.kind === "section" && m.section === "parameters");
        if (!params || params.kind !== "section") return;
        const argsIndex = stmt.keywords.findIndex((k) => this.text.slice(k.start, k.end).toLowerCase() === "arguments");
        if (argsIndex < 0) return;
        const argsStart = stmt.keywords[argsIndex].end;
        const args = stmt.slots.filter((s) => s.expr.start > argsStart).map((s) => s.expr);
        params.items.forEach((item, index) => {
            const arg = args[index];
            if (item.kind === "variable" && item.isRef && arg?.kind === "name" && arg.qualifier.length === 0) {
                state.resultVars.set(arg.name.text.toLowerCase(), stmt.start);
            }
        });
    }

    private checkResultReads(stmt: Stmt, state: PathState): void {
        const reads: Expr[] = [];
        collectReadNames(stmt, reads);
        for (const expr of reads) {
            if (expr.kind !== "name") continue;
            const openedAt = state.resultVars.get(expr.name.text.toLowerCase());
            if (openedAt !== undefined) {
                this.report(expr, "overlay-result-read", `'${expr.name.text}' is read right after the overlay on line ${this.lineOf(openedAt)} was opened, before the agent answers. Read it in the 'on close' event handler.`);
                state.resultVars.delete(expr.name.text.toLowerCase());
            }
        }
    }

    private checkAsyncFunctionValues(body: Block): void {
        for (const ref of this.file.references) {
            if (ref.kind !== "call" || ref.span.start < body.start || ref.span.end > body.end) continue;
            const resolution = this.program.resolve(this.file, ref);
            if (resolution.kind !== "symbol") continue;
            const symbol = resolution.symbols[0];
            const decl = symbol.decl as RoutineDecl | undefined;
            const file = this.program.fileOf(symbol);
            let opensDirectly = false;
            if (decl?.body && file) forEachStatement(decl.body, (stmt) => (opensDirectly ||= opensPopup(stmt, file.source.text)));
            if (symbol.kind === "function" && opensDirectly) {
                this.report(ref.span, "async-function-result", `Function '${symbol.name}' opens a popup, which is asynchronous in ASL Web Edition: its result cannot contain the agent's answer. Handle the answer in the popup's 'on close' event.`);
            }
        }
    }

    // ------------------------------------------------------------ graphical elements

    private checkControls(): void {
        for (const decl of this.file.source.decls) {
            if (decl.kind !== "node" && decl.kind !== "block") continue;
            for (const member of decl.members) {
                if (member.kind === "control") this.checkControl(member);
            }
            if (decl.kind === "node") this.checkButtonShadows(decl);
        }
    }

    private checkControl(control: ControlDecl): void {
        const def = CONTROLS.get(control.control);
        if (!def) return;
        if (def.deprecated) this.report(control.keyword, "deprecated", `${def.name}: ${def.deprecated}`, { tags: ["deprecated"] });
        if (def.target && !control.target) {
            this.report(control.keyword, "control-clause", `A ${def.name} needs 'for <${def.target}>' to bind its value.`);
        }
        for (const clause of def.clauses) {
            if (clause.required && clause.phrase === "size" && !control.clauses.some((c) => c.words === clause.phrase)) {
                this.report(control.keyword, "control-clause", `A ${def.name} needs a '${clause.syntax}' clause.`);
            }
        }
        for (const handler of control.handlers) {
            if (def.name === "web browser" && this.options.webEdition) {
                this.report(handler.eventSpan, "web-unsupported", "The Agent Portal web browser does not process events.");
                continue;
            }
            const event = handler.event;
            if (def.events.length === 0 || !def.events.some((e) => e.words.test(event))) {
                const known = def.events.map((e) => e.name).join(", ");
                this.report(handler.eventSpan, "unknown-event", `'on ${event}' is not an event of ${def.name}${known ? ` (events: ${known})` : ""}.`);
            }
        }
    }

    private checkButtonShadows(node: NodeDecl): void {
        const symbol = this.file.nodes.get(node.name.value.toLowerCase());
        if (!symbol) return;
        const masters = this.program.masters(symbol);
        if (!masters.length) return;
        const masterButtons = new Map<string, { control: ControlDecl; target?: string }>();
        for (const master of [...masters].reverse()) {
            const decl = master.decl as NodeDecl | undefined;
            for (const member of decl?.members ?? []) {
                if (member.kind !== "control" || member.control !== "push button" || member.size?.x === undefined) continue;
                const click = member.handlers.find((h) => h.event === "click");
                if (!click || click.body.statements.length === 0) continue;
                const goto = click.body.statements.find((s) => s.kind === "goto");
                const target = goto?.kind === "goto" && goto.target.kind === "string" ? goto.target.value : undefined;
                masterButtons.set(`${member.size.x},${member.size.y}`, { control: member, target });
            }
        }
        for (const member of node.members) {
            if (member.kind !== "control" || member.control !== "push button" || member.size?.x === undefined) continue;
            const click = member.handlers.find((h) => h.event === "click");
            if (click && click.body.statements.length > 0) continue;
            const shadowed = masterButtons.get(`${member.size.x},${member.size.y}`);
            if (!shadowed) continue;
            if (shadowed.target && shadowed.target.toLowerCase() === node.name.value.toLowerCase()) continue;
            this.report(member.keyword, "button-shadows-master", `This button has no click actions but sits on the master button ${shadowed.control.name ? `"${shadowed.control.name.value}" ` : ""}at ${member.size.x},${member.size.y}; it swallows the click and the master's action never runs.`);
        }
    }

    private lineOf(offset: number): number {
        let line = 1;
        for (let i = 0; i < offset && i < this.text.length; i += 1) if (this.text.charCodeAt(i) === 10) line += 1;
        return line;
    }
}

const EMAIL_ASYNC = new Set(["insert into body", "insert knowledge base document", "open attachment", "remove attachment", "save attachment", "reply", "forward", "set field"]);

function fieldOf(text: string, stmt: ActionStmt): string {
    const words = stmt.keywords.map((k) => text.slice(k.start, k.end).toLowerCase());
    const setIndex = words.indexOf("set");
    const fieldIndex = words.indexOf("field");
    return setIndex >= 0 && fieldIndex > setIndex ? words.slice(setIndex + 1, fieldIndex).join(" ") : "";
}

function declarationGroup(symbol: AslSymbol): string | undefined {
    switch (symbol.kind) {
        case "variable":
        case "parameter":
        case "constant":
            return symbol.detail === "contact profile extension" ? undefined : "value";
        case "subroutine":
        case "function":
            return "routine";
        case "cursor":
            return "cursor";
        case "type":
            return symbol.detail === "contact profile extension" ? undefined : "type";
        case "node":
            return "node";
        case "block":
            return "block";
        case "event":
            return "event";
        case "exitPoint":
            return "exitPoint";
        case "namespace":
            return "namespace";
        case "image":
            return "image";
        case "field":
        case "enumMember":
            return symbol.kind;
        default:
            return undefined;
    }
}

function opensPopup(stmt: Stmt, text: string): boolean {
    if (stmt.kind !== "action") return false;
    if (stmt.words === "open message box") return true;
    if (stmt.words !== "open window") return false;
    if (!stmt.keywords.some((k) => text.slice(k.start, k.end).toLowerCase() === "overlay")) return false;
    // 1x1 helper windows are invisible and do not block the agent.
    const sizeIndex = stmt.keywords.findIndex((k) => text.slice(k.start, k.end).toLowerCase() === "size");
    if (sizeIndex >= 0) {
        const after = stmt.slots.filter((s) => s.expr.start > stmt.keywords[sizeIndex].end).slice(0, 2);
        if (after.length === 2 && after.every((s) => s.expr.kind === "number" && s.expr.text === "1")) return false;
    }
    const target = stmt.slots[0]?.expr;
    return !(target?.kind === "string" && /invisible/i.test(target.value));
}

function isTerminating(stmt: Stmt): boolean {
    if (stmt.kind === "goto") return true;
    return stmt.kind === "action" && TERMINATING.has(stmt.words);
}

function describe(stmt: Stmt): string {
    if (stmt.kind === "goto") return `${stmt.mode} node`;
    return stmt.kind === "action" ? stmt.words : stmt.kind;
}

function mergeStates(a: PathState, b: PathState): PathState {
    const resultVars = new Map(a.resultVars);
    for (const [key, value] of b.resultVars) if (!resultVars.has(key)) resultVars.set(key, value);
    const first = a.popupAt === undefined ? b : b.popupAt === undefined ? a : a.popupAt <= b.popupAt ? a : b;
    return { popupAt: first.popupAt, popupIndirect: first.popupIndirect, resultVars };
}

/** Names read by a statement itself (not by nested blocks). */
function collectReadNames(stmt: Stmt, into: Expr[]): void {
    const visit = (expr: Expr | undefined): void => {
        if (!expr) return;
        switch (expr.kind) {
            case "name":
                into.push(expr);
                break;
            case "member":
                visit(expr.object);
                break;
            case "index":
                visit(expr.object);
                visit(expr.index);
                break;
            case "call":
                expr.args.forEach((a) => visit(a.expr));
                break;
            case "unary":
                visit(expr.operand);
                break;
            case "binary":
                visit(expr.left);
                visit(expr.right);
                break;
            case "paren":
            case "coerce":
                visit(expr.expr);
                break;
            case "string":
                expr.interpolations.forEach(visit);
                break;
            case "concat":
                expr.parts.forEach(visit);
                break;
            default:
                break;
        }
    };
    switch (stmt.kind) {
        case "if":
        case "while":
            visit(stmt.cond);
            break;
        case "case":
            visit(stmt.expr);
            break;
        case "assign":
            visit(stmt.value);
            if (stmt.target.kind !== "name") visit(stmt.target);
            break;
        case "call":
            stmt.args.forEach((a) => visit(a.expr));
            break;
        case "var":
            visit(stmt.decl.init);
            break;
        case "action":
            stmt.slots.filter((s) => s.cls !== "var").forEach((s) => visit(s.expr));
            break;
        default:
            break;
    }
}
