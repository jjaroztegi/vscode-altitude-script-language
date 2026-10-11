/**
 * A program is a script (or module) plus every module it imports, transitively. It resolves
 * references across files: namespaces, unqualified imports, master-node inheritance and
 * member access on records.
 */
import type { Expr, NodeDecl, TypeRef } from "./ast";
import type { AslSymbol, FileModel, Reference, Scope } from "./binder";
import { ATTRIBUTES, BUILTIN_TYPES, BUSINESS_VARIABLES, CONSTANTS, ENUMS, FUNCTIONS, RECORDS, type AttributeDef, type EnumDef, type FieldDef, type FunctionDef, type RecordDef } from "./catalog";

export interface ImportLink {
    from: FileModel;
    target?: FileModel;
    namespace?: string;
    isPrivate: boolean;
    importIndex: number;
}

export type Resolution =
    | { kind: "symbol"; symbols: AslSymbol[] }
    | { kind: "function"; fn: FunctionDef }
    | { kind: "attribute"; attribute: AttributeDef }
    | { kind: "enum"; def: EnumDef }
    | { kind: "enumMember"; def: EnumDef; member: EnumDef["members"][number] }
    | { kind: "record"; def: RecordDef }
    | { kind: "field"; field: FieldDef; owner: string }
    | { kind: "business"; name: string; doc: string; type: string }
    | { kind: "constant"; name: string; value?: number; doc?: string }
    | { kind: "builtinType"; name: string }
    /** Cannot be checked (managed code, dynamic names, incomplete module graph). */
    | { kind: "unknown" }
    | { kind: "missing"; reason?: string };

export type TypeInfo =
    | { kind: "record"; name?: string; fields: Map<string, FieldInfo>; complete: boolean }
    | { kind: "array"; element?: TypeInfo }
    | { kind: "enum"; name: string; members: string[] }
    | { kind: "simple"; name: string }
    | { kind: "unknown" };

export interface FieldInfo {
    name: string;
    symbol?: AslSymbol;
    def?: FieldDef;
    owner?: string;
}

export class Program {
    readonly files: FileModel[] = [];
    readonly links: ImportLink[] = [];
    /** False when some import could not be loaded: unqualified names may live there. */
    complete = true;
    readonly managed: boolean;
    private readonly exportsCache = new Map<FileModel, Map<string, AslSymbol[]>>();
    private readonly resolutionCache = new Map<Reference, Resolution>();
    private readonly nodeIndex = new Map<string, AslSymbol[]>();
    private readonly defaultMasters = new Map<FileModel, string>();

    constructor(
        readonly root: FileModel,
        loadImport: (from: FileModel, path: string) => FileModel | undefined
    ) {
        const seen = new Set<FileModel>();
        const queue: FileModel[] = [root];
        seen.add(root);
        while (queue.length > 0) {
            const file = queue.shift()!;
            this.files.push(file);
            file.imports.forEach((item, importIndex) => {
                const target = loadImport(file, item.path.value);
                this.links.push({ from: file, target, namespace: item.namespace?.toLowerCase(), isPrivate: item.isPrivate, importIndex });
                if (!target) {
                    this.complete = false;
                    return;
                }
                if (!seen.has(target)) {
                    seen.add(target);
                    queue.push(target);
                }
            });
        }
        this.managed = this.files.some((f) => f.managed);
        for (const file of this.files) {
            for (const node of file.nodes.values()) {
                const list = this.nodeIndex.get(node.key) ?? [];
                list.push(node);
                this.nodeIndex.set(node.key, list);
            }
            const defaultMaster = file.source.decls.find((d) => d.kind === "clause" && d.words === "default master");
            if (defaultMaster && defaultMaster.kind === "clause" && defaultMaster.args[0]?.kind === "string") {
                this.defaultMasters.set(file, defaultMaster.args[0].value);
            }
        }
    }

    fileOf(symbol: AslSymbol): FileModel | undefined {
        return this.files.find((f) => f.uri === symbol.uri);
    }

    linksFrom(file: FileModel): ImportLink[] {
        return this.links.filter((link) => link.from === file);
    }

    /** Files that import `file` within this program. */
    importersOf(file: FileModel): FileModel[] {
        return this.links.filter((link) => link.target === file).map((link) => link.from);
    }

    // ------------------------------------------------------------ module exports

    /** Declarations a module makes visible to importers, including what its own plain imports bring in. */
    exportsOf(file: FileModel, seen = new Set<FileModel>()): Map<string, AslSymbol[]> {
        const cached = this.exportsCache.get(file);
        if (cached) return cached;
        const result = new Map<string, AslSymbol[]>();
        if (seen.has(file)) return result;
        seen.add(file);
        const add = (symbol: AslSymbol): void => {
            const list = result.get(symbol.key);
            if (list) list.push(symbol);
            else result.set(symbol.key, [symbol]);
        };
        for (const list of file.root.symbols.values()) {
            for (const symbol of list) {
                if (!symbol.isPrivate) add(symbol);
            }
        }
        for (const link of this.linksFrom(file)) {
            if (link.isPrivate || !link.target || link.namespace) continue;
            for (const list of this.exportsOf(link.target, seen).values()) list.forEach(add);
        }
        this.exportsCache.set(file, result);
        return result;
    }

    /** Symbols visible unqualified at the top of `file`: its own globals plus plain imports. */
    globalLookup(file: FileModel, key: string): AslSymbol[] {
        const own = file.root.symbols.get(key) ?? [];
        const imported: AslSymbol[] = [];
        for (const link of this.linksFrom(file)) {
            if (!link.target || link.namespace) continue;
            imported.push(...(this.exportsOf(link.target).get(key) ?? []));
        }
        return own.length ? [...own, ...imported] : imported;
    }

    namespaceTarget(file: FileModel, namespace: string): FileModel | undefined | null {
        const link = this.linksFrom(file).find((l) => l.namespace === namespace.toLowerCase());
        if (!link) return null;
        return link.target;
    }

    // ------------------------------------------------------------ nodes

    findNodes(name: string, from?: FileModel): AslSymbol[] {
        let key = name.trim().toLowerCase();
        if (key.startsWith("::")) key = key.slice(2);
        const parts = key.split("::");
        if (parts.length > 1 && from) {
            // "ns::node" (namespace of the importing file) or "::module::node".
            const target = this.namespaceTarget(from, parts[0]);
            if (target) {
                const nodes = [...target.nodes.values()].filter((n) => n.key === parts[parts.length - 1]);
                if (nodes.length) return nodes;
            }
            const byModule = this.files.find((f) => baseName(f.uri) === parts[0]);
            if (byModule) {
                const nodes = [...byModule.nodes.values()].filter((n) => n.key === parts[parts.length - 1]);
                if (nodes.length) return nodes;
            }
            return this.nodeIndex.get(parts[parts.length - 1]) ?? [];
        }
        return this.nodeIndex.get(key) ?? [];
    }

    allNodes(): AslSymbol[] {
        return [...this.nodeIndex.values()].flat();
    }

    nodeScope(node: AslSymbol): Scope | undefined {
        return this.fileOf(node)?.nodeScopes.get(node);
    }

    /** The master chain of a node (nearest first), following default masters. */
    masters(node: AslSymbol): AslSymbol[] {
        const chain: AslSymbol[] = [];
        let current: AslSymbol | undefined = node;
        const seen = new Set<AslSymbol>([node]);
        while (current) {
            const decl = current.decl as NodeDecl | undefined;
            const file = this.fileOf(current);
            let masterName: string | undefined;
            if (decl?.master && decl.master.name.kind === "string") {
                masterName = decl.master.name.value;
            } else if (decl && !decl.master && !decl.withoutMaster && decl.kind === "node" && file) {
                masterName = this.defaultMasterFor(file);
                if (masterName && masterName.toLowerCase() === current.key) masterName = undefined;
            }
            if (!masterName || !file) break;
            const next: AslSymbol | undefined = this.findNodes(masterName, file).find((n) => !seen.has(n));
            if (!next) break;
            chain.push(next);
            seen.add(next);
            current = next;
        }
        return chain;
    }

    private defaultMasterFor(file: FileModel): string | undefined {
        const own = this.defaultMasters.get(file);
        if (own) return own;
        for (const link of this.links) {
            if (link.target !== file) continue;
            const item = link.from.source.decls.flatMap((d) => (d.kind === "modules" ? d.imports : []))[link.importIndex];
            if (item?.defaultMaster) return item.defaultMaster.value;
            const inherited = this.defaultMasters.get(link.from);
            if (inherited) return inherited;
        }
        return undefined;
    }

    /** Node symbol for a scope inside a node or block. */
    nodeOfScope(scope: Scope): AslSymbol | undefined {
        for (let s: Scope | undefined = scope; s; s = s.parent) {
            if ((s.kind === "node" || s.kind === "block") && s.owner) return s.owner;
        }
        return undefined;
    }

    // ------------------------------------------------------------ resolution

    resolve(file: FileModel, ref: Reference): Resolution {
        let result = this.resolutionCache.get(ref);
        if (!result) {
            result = this.resolveUncached(file, ref);
            this.resolutionCache.set(ref, result);
        }
        return result;
    }

    private resolveUncached(file: FileModel, ref: Reference): Resolution {
        switch (ref.kind) {
            case "attribute": {
                const attribute = ATTRIBUTES.get(`@${ref.name.toLowerCase()}`) ?? ATTRIBUTES.get(ref.name.toLowerCase());
                return attribute ? { kind: "attribute", attribute } : { kind: "missing" };
            }
            case "member":
                return this.resolveMember(file, ref);
            case "node": {
                const nodes = this.findNodes(ref.name, file);
                if (nodes.length) return { kind: "symbol", symbols: nodes };
                return this.complete ? { kind: "missing" } : { kind: "unknown" };
            }
            case "event":
                return this.resolveEvent(ref);
            case "exitPoint":
                return this.lookupInNodeChain(ref, (s) => s.kind === "exitPoint");
            case "control":
                return this.resolveControl(ref);
            case "block": {
                const blocks = this.files.flatMap((f) => f.root.symbols.get(ref.name.toLowerCase()) ?? []).filter((s) => s.kind === "block");
                return blocks.length ? { kind: "symbol", symbols: blocks } : this.complete ? { kind: "missing" } : { kind: "unknown" };
            }
            case "image": {
                const images = this.files.flatMap((f) => f.root.symbols.get(ref.name.toLowerCase()) ?? []).filter((s) => s.kind === "image");
                return images.length ? { kind: "symbol", symbols: images } : this.complete ? { kind: "missing" } : { kind: "unknown" };
            }
            case "type":
                return this.resolveType(file, ref.scope, ref.name, ref.qualifier);
            default:
                return this.resolveValue(file, ref);
        }
    }

    private resolveValue(file: FileModel, ref: Reference): Resolution {
        if (ref.qualifier.length > 0) {
            return this.resolveQualified(file, ref.qualifier, ref.name, ref.kind);
        }
        const key = ref.name.toLowerCase();
        const wantRoutine = ref.kind === "routine";
        const accept = (symbol: AslSymbol): boolean => {
            if (wantRoutine) return symbol.kind === "subroutine" || symbol.kind === "function";
            if (ref.kind === "cursor") return symbol.kind === "cursor" || symbol.kind === "variable" || symbol.kind === "parameter";
            if (ref.kind === "call") return symbol.kind === "function" || symbol.kind === "subroutine" || symbol.kind === "variable" || symbol.kind === "parameter";
            return !["node", "block", "event", "image", "exitPoint", "control", "field", "enumMember"].includes(symbol.kind);
        };
        const found = this.lookupScopes(file, ref.scope, key, ref.span.start, accept);
        if (found.length) return { kind: "symbol", symbols: found };
        if (ref.kind === "call" || ref.kind === "value" || ref.kind === "routine") {
            const fn = FUNCTIONS.get(key);
            if (fn) return { kind: "function", fn };
        }
        if (ref.kind === "value" || ref.kind === "cursor") {
            const business = BUSINESS_VARIABLES[key];
            if (business) return { kind: "business", name: key, doc: business.doc, type: business.type };
        }
        if (ref.kind === "value" && ENUMS.has(key)) return { kind: "enum", def: ENUMS.get(key)! };
        if (ref.kind === "value") {
            const constant = CONSTANTS.get(key);
            if (constant) return { kind: "constant", ...constant };
            // Error-code constants (ERR_xxx) are predefined; the reference only lists some of them.
            if (/^err_[a-z0-9_]+$/.test(key)) return { kind: "unknown" };
        }
        if (!this.complete) return { kind: "unknown" };
        if (this.managed && (ref.kind === "routine" || ref.kind === "call")) return { kind: "unknown" };
        return { kind: "missing" };
    }

    /** Walks local, routine, node (and master), file and imported scopes. */
    lookupScopes(file: FileModel, scope: Scope, key: string, position: number, accept: (symbol: AslSymbol) => boolean): AslSymbol[] {
        for (let s: Scope | undefined = scope; s; s = s.parent) {
            const here = (s.symbols.get(key) ?? []).filter((symbol) => accept(symbol) && (!symbol.isLocal || symbol.span.start <= position));
            if (here.length) return here;
            if ((s.kind === "node" || s.kind === "block") && s.owner) {
                for (const master of this.masters(s.owner)) {
                    const masterScope = this.nodeScope(master);
                    const inherited = (masterScope?.symbols.get(key) ?? []).filter(accept);
                    if (inherited.length) return inherited;
                }
            }
            if (s.kind === "file") {
                const globals = this.globalLookup(file, key).filter(accept);
                if (globals.length) return globals;
            }
        }
        return [];
    }

    private resolveQualified(file: FileModel, qualifier: string[], name: string, kind: Reference["kind"]): Resolution {
        let current: FileModel = file;
        for (let i = 0; i < qualifier.length; i += 1) {
            const part = qualifier[i];
            const target = this.namespaceTarget(current, part);
            if (target === undefined) return { kind: "unknown" };
            if (target === null) {
                // Not a namespace: an enumeration (`PhoneState::connected`, `ns::MyEnum::x`).
                if (i === qualifier.length - 1) {
                    const enumResult = this.resolveEnumMember(current, part, name);
                    if (enumResult) return enumResult;
                }
                if (this.managed || /^system$/i.test(qualifier[0])) return { kind: "unknown" };
                if (i === 0 && ENUMS.has(part.toLowerCase())) return { kind: "missing", reason: `'${name}' is not a member of ${ENUMS.get(part.toLowerCase())!.name}` };
                return i === 0 ? { kind: "missing", reason: `Unknown namespace or enumeration '${part}'` } : { kind: "unknown" };
            }
            current = target;
        }
        const exported = (this.exportsOf(current).get(name.toLowerCase()) ?? []).filter((s) => (kind === "routine" ? s.kind === "subroutine" || s.kind === "function" : true));
        if (exported.length) return { kind: "symbol", symbols: exported };
        const privateMatch = [...(current.root.symbols.get(name.toLowerCase()) ?? [])].some((s) => s.isPrivate);
        if (privateMatch) return { kind: "missing", reason: `'${name}' is private to ${baseName(current.uri)}` };
        // A module whose own imports failed to load may still export the name.
        const incomplete = this.linksFrom(current).some((l) => !l.target);
        return incomplete ? { kind: "unknown" } : { kind: "missing", reason: `'${name}' is not declared in ${baseName(current.uri)}` };
    }

    private resolveEnumMember(file: FileModel, enumName: string, member: string): Resolution | undefined {
        const userEnum = this.globalLookup(file, enumName.toLowerCase()).find((s) => s.kind === "type" && s.type?.kind === "enumeration");
        if (userEnum) {
            const symbol = userEnum.members?.get(member.toLowerCase());
            // Enumerations defined on the server are filled at run time.
            if (symbol) return { kind: "symbol", symbols: [symbol] };
            if (userEnum.type?.kind === "enumeration" && userEnum.type.definedIn) return { kind: "unknown" };
            return { kind: "missing", reason: `'${member}' is not a member of ${userEnum.name}` };
        }
        const def = ENUMS.get(enumName.toLowerCase());
        if (def) {
            const found = def.members.find((m) => m.name.toLowerCase() === member.toLowerCase());
            if (found) return { kind: "enumMember", def, member: found };
            return { kind: "missing", reason: `'${member}' is not a member of ${def.name}` };
        }
        return undefined;
    }

    resolveType(file: FileModel, scope: Scope, name: string, qualifier: string[]): Resolution {
        const key = name.toLowerCase();
        if (qualifier.length === 0) {
            if (BUILTIN_TYPES.has(key)) return { kind: "builtinType", name: key };
            const found = this.lookupScopes(file, scope, key, Number.MAX_SAFE_INTEGER, (s) => s.kind === "type");
            if (found.length) return { kind: "symbol", symbols: found };
            const record = RECORDS.get(key);
            if (record) return { kind: "record", def: record };
            const enumDef = ENUMS.get(key);
            if (enumDef) return { kind: "enum", def: enumDef };
            if (/^(campaign|contact|workflow|transferred|outcome|contactprofile)record$/.test(key)) return { kind: "unknown" };
            if (this.managed || !this.complete) return { kind: "unknown" };
            return { kind: "missing" };
        }
        const resolved = this.resolveQualified(file, qualifier, name, "type");
        return resolved;
    }

    private resolveEvent(ref: Reference): Resolution {
        const node = this.nodeOfScope(ref.scope);
        if (node) {
            const inChain = this.lookupInNodeChain(ref, (s) => s.kind === "event");
            if (inChain.kind === "symbol") return inChain;
        }
        // Events also reach the node of a window opened just before (`open window 'X' ... set timer ...`),
        // and routines run in whichever node is current: any node's handler is acceptable.
        const anywhere = this.files.flatMap((f) => [...f.nodeScopes.values()].flatMap((scope) => scope.symbols.get(ref.name.toLowerCase()) ?? [])).filter((s) => s.kind === "event");
        if (anywhere.length) return { kind: "symbol", symbols: anywhere };
        return this.complete ? { kind: "missing" } : { kind: "unknown" };
    }

    private lookupInNodeChain(ref: Reference, accept: (symbol: AslSymbol) => boolean): Resolution {
        const node = this.nodeOfScope(ref.scope);
        if (!node) return { kind: "unknown" };
        const key = ref.name.toLowerCase();
        for (const candidate of [node, ...this.masters(node)]) {
            const found = (this.nodeScope(candidate)?.symbols.get(key) ?? []).filter(accept);
            if (found.length) return { kind: "symbol", symbols: found };
        }
        return this.complete ? { kind: "missing" } : { kind: "unknown" };
    }

    private resolveControl(ref: Reference): Resolution {
        const key = ref.name.toLowerCase();
        const node = this.nodeOfScope(ref.scope);
        if (node) {
            for (const candidate of [node, ...this.masters(node)]) {
                const found = (this.nodeScope(candidate)?.symbols.get(key) ?? []).filter((s) => s.kind === "control");
                if (found.length) return { kind: "symbol", symbols: found };
            }
        }
        // Controls of other nodes are reachable through `in window`, blocks and containers.
        const anywhere = this.files.flatMap((f) => [...f.nodeScopes.values()].flatMap((scope) => scope.symbols.get(key) ?? [])).filter((s) => s.kind === "control");
        if (anywhere.length) return { kind: "symbol", symbols: anywhere };
        return this.complete ? { kind: "missing" } : { kind: "unknown" };
    }

    private resolveMember(file: FileModel, ref: Reference): Resolution {
        if (!ref.object) return { kind: "unknown" };
        const type = this.typeOf(file, ref.object, ref.scope);
        if (type.kind !== "record") return { kind: "unknown" };
        const field = type.fields.get(ref.name.toLowerCase());
        if (field?.symbol) return { kind: "symbol", symbols: [field.symbol] };
        if (field?.def) return { kind: "field", field: field.def, owner: field.owner ?? type.name ?? "" };
        if (!type.complete || ref.argCount !== undefined) return { kind: "unknown" };
        return { kind: "missing", reason: `'${ref.name}' is not a field of ${type.name ?? "this record"}` };
    }

    // ------------------------------------------------------------ types

    typeOf(file: FileModel, expr: Expr, scope: Scope, depth = 0): TypeInfo {
        if (depth > 12) return { kind: "unknown" };
        switch (expr.kind) {
            case "name": {
                const ref = file.references.find((r) => r.expr === expr);
                const resolution = ref ? this.resolve(file, ref) : this.resolveValue(file, { kind: "value", span: expr.name, name: expr.name.text, qualifier: expr.qualifier.map((q) => q.text), qualifierSpans: expr.qualifier, scope });
                return this.typeOfResolution(file, resolution, depth);
            }
            case "attr": {
                const attribute = ATTRIBUTES.get(`@${expr.name.text.slice(1).toLowerCase()}`) ?? ATTRIBUTES.get(expr.name.text.toLowerCase());
                if (!attribute) return { kind: "unknown" };
                return this.typeOfCatalogFields(attribute.type ?? attribute.name, attribute.fields, attribute.name);
            }
            case "member": {
                const objectType = this.typeOf(file, expr.object, scope, depth + 1);
                if (objectType.kind !== "record") return { kind: "unknown" };
                const field = objectType.fields.get(expr.name.text.toLowerCase());
                if (!field) return { kind: "unknown" };
                if (field.symbol) return this.typeOfSymbol(file, field.symbol, depth + 1);
                if (field.def?.type) return this.typeOfName(file, field.def.type, depth + 1);
                return { kind: "unknown" };
            }
            case "index": {
                const objectType = this.typeOf(file, expr.object, scope, depth + 1);
                return objectType.kind === "array" ? (objectType.element ?? { kind: "unknown" }) : { kind: "unknown" };
            }
            case "call": {
                const ref = file.references.find((r) => r.expr === expr.callee || (r.span.start === (expr.callee.kind === "name" ? expr.callee.name.start : -1) && (r.kind === "call" || r.kind === "routine")));
                if (!ref) return { kind: "unknown" };
                const resolution = this.resolve(file, ref);
                if (resolution.kind === "function") {
                    if (resolution.fn.returnsRecord?.length) return this.typeOfCatalogFields(resolution.fn.returns ?? resolution.fn.name, resolution.fn.returnsRecord, resolution.fn.returns ?? resolution.fn.name);
                    return resolution.fn.returns ? this.typeOfName(file, resolution.fn.returns, depth + 1) : { kind: "unknown" };
                }
                if (resolution.kind === "symbol" && resolution.symbols[0]?.kind === "function") {
                    return this.typeOfTypeRef(file, resolution.symbols[0].type, depth + 1);
                }
                return { kind: "unknown" };
            }
            case "paren":
                return this.typeOf(file, expr.expr, scope, depth + 1);
            case "string":
            case "concat":
                return { kind: "simple", name: "text" };
            case "number":
                return { kind: "simple", name: "number" };
            default:
                return { kind: "unknown" };
        }
    }

    typeOfResolution(file: FileModel, resolution: Resolution, depth: number): TypeInfo {
        switch (resolution.kind) {
            case "symbol":
                return this.typeOfSymbol(file, resolution.symbols[0], depth + 1);
            case "business":
                return this.businessType(resolution.name);
            case "field":
                return resolution.field.type ? this.typeOfName(file, resolution.field.type, depth + 1) : { kind: "unknown" };
            default:
                return { kind: "unknown" };
        }
    }

    typeOfSymbol(file: FileModel, symbol: AslSymbol, depth = 0): TypeInfo {
        if (symbol.kind === "businessRecord") return this.businessType(symbol.name.toLowerCase());
        if (symbol.members && (symbol.kind === "variable" || symbol.kind === "field" || symbol.kind === "parameter")) {
            return recordFromSymbols(symbol.members, symbol.detail === "contact profile extension" ? `${symbol.name}Record` : undefined);
        }
        if (symbol.kind === "type" && symbol.members && symbol.type?.kind !== "enumeration") return recordFromSymbols(symbol.members, symbol.name);
        if (symbol.kind === "cursor") return { kind: "unknown" };
        const owner = this.files.find((f) => f.uri === symbol.uri) ?? file;
        return this.typeOfTypeRef(owner, symbol.type, depth + 1, symbol.scope);
    }

    typeOfTypeRef(file: FileModel, type: TypeRef | undefined, depth = 0, scope: Scope = file.root): TypeInfo {
        if (!type || depth > 12) return { kind: "unknown" };
        switch (type.kind) {
            case "array":
                return { kind: "array", element: this.typeOfTypeRef(file, type.element, depth + 1, scope) };
            case "record":
                return { kind: "unknown" };
            case "enumeration":
                return { kind: "enum", name: "", members: type.members.map((m) => m.name.text) };
            case "named": {
                const resolution = this.resolveType(file, scope, type.name.text, type.qualifier.map((q) => q.text));
                switch (resolution.kind) {
                    case "builtinType":
                        return { kind: "simple", name: resolution.name };
                    case "symbol": {
                        const symbol = resolution.symbols[0];
                        if (symbol.type?.kind === "enumeration") return { kind: "enum", name: symbol.name, members: symbol.type.members.map((m) => m.name.text) };
                        if (symbol.members) return recordFromSymbols(symbol.members, symbol.name);
                        return this.typeOfTypeRef(this.files.find((f) => f.uri === symbol.uri) ?? file, symbol.type, depth + 1, symbol.scope);
                    }
                    case "record":
                        return this.typeOfCatalogFields(resolution.def.name, resolution.def.fields, resolution.def.name);
                    case "enum":
                        return { kind: "enum", name: resolution.def.name, members: resolution.def.members.map((m) => m.name) };
                    default:
                        return { kind: "unknown" };
                }
            }
            default:
                return { kind: "unknown" };
        }
    }

    /** Types written as text in the catalogue: `text`, `PhoneState`, `array of InteractionParty`... */
    typeOfName(file: FileModel, name: string, depth = 0): TypeInfo {
        const text = name.trim();
        const array = text.match(/^array\s+(?:\[[^\]]*\]\s*)?of\s+(.+)$/i);
        if (array) return { kind: "array", element: this.typeOfName(file, array[1], depth + 1) };
        const simple = text.match(/^([A-Za-z_]\w*)/)?.[1]?.toLowerCase();
        if (!simple) return { kind: "unknown" };
        if (BUILTIN_TYPES.has(simple)) return { kind: "simple", name: simple };
        const record = RECORDS.get(simple);
        if (record) return this.typeOfCatalogFields(record.name, record.fields, record.name);
        const enumDef = ENUMS.get(simple);
        if (enumDef) return { kind: "enum", name: enumDef.name, members: enumDef.members.map((m) => m.name) };
        const inline = text.match(/^\w+\s*\{(.*)\}$/s);
        if (inline) {
            const fields: FieldDef[] = inline[1].split(",").map((part) => part.split(":")).filter((p) => p.length >= 2).map(([n, t]) => ({ name: n.trim(), type: t.trim() }));
            return this.typeOfCatalogFields(simple, fields, simple);
        }
        void file;
        return { kind: "unknown" };
    }

    private typeOfCatalogFields(name: string, fields: FieldDef[], owner: string): TypeInfo {
        const map = new Map<string, FieldInfo>();
        for (const field of fields) map.set(field.name.toLowerCase(), { name: field.name, def: field, owner });
        // Catalogue records come from the documentation, which can miss fields: never report them missing.
        return { kind: "record", name, fields: map, complete: false };
    }

    /** Business record fields, merged from every file of the program. */
    businessType(name: string): TypeInfo {
        if (name === "contact_profile") {
            const record = RECORDS.get("contactprofilerecord");
            return record ? this.typeOfCatalogFields(record.name, record.fields, record.name) : { kind: "unknown" };
        }
        const fields = new Map<string, FieldInfo>();
        for (const file of this.files) {
            for (const symbol of file.root.symbols.get(name) ?? []) {
                if (symbol.kind !== "businessRecord" || !symbol.members) continue;
                for (const [key, field] of symbol.members) if (!fields.has(key)) fields.set(key, { name: field.name, symbol: field });
            }
        }
        const record: TypeInfo = { kind: "record", name: BUSINESS_VARIABLES[name]?.type, fields, complete: this.complete };
        return name === "outcomes" ? { kind: "array", element: record } : record;
    }
}

function recordFromSymbols(members: Map<string, AslSymbol>, name?: string): TypeInfo {
    const fields = new Map<string, FieldInfo>();
    for (const [key, symbol] of members) fields.set(key, { name: symbol.name, symbol });
    return { kind: "record", name, fields, complete: true };
}

export function baseName(uri: string): string {
    const last = decodeURIComponent(uri).split(/[\\/]/).pop() ?? uri;
    return last.replace(/\.[^.]+$/, "").toLowerCase();
}
