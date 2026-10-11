import actionsData from "./data/actions.json";
import attributesData from "./data/attributes.json";
import constantsData from "./data/constants.json";
import controlsData from "./data/controls.json";
import enumsData from "./data/enums.json";
import eventsData from "./data/events.json";
import functionsData from "./data/functions.json";
import recordsData from "./data/records.json";
import { collectKeywords, compileTemplate, leadingWords, type Pattern } from "./template";

export const DOCS_BASE = "https://docs.enghouseinteractive.com/altitude/8.7/en-US/Development/Altitude_Scripting_Language_Reference/";

export function docsUrl(url: string | undefined): string | undefined {
    if (!url) {
        return undefined;
    }
    return /^https?:/.test(url) ? url : DOCS_BASE + url;
}

// ---------------------------------------------------------------- shared nonterminals

const GLOBAL_DEFS: Record<string, string> = {
    TARGET: "variable VAR [match by name] | record VAR [match by name] | ?",
    ATTRIBUTE: "attribute ID [:= Expression] | array Expression | record Expression",
    ATTACHMENT: "[file] Expression | email id Expression | document Expression",
    FONT: "font { [name to Text] [size to Integer] [[not] bold] [[not] italic] [[not] underline] [[not] strikeout] [color to RGBColor] }",
    "FONT-UAGENT": "font { [name STRING] [size INT] [bold] [italic] [underline] [strikeout] [color COLOR-UAGENT] }",
    "COLOR-UAGENT": "rgb INT , INT , INT | STRING",
    "SYSTEM-CURSOR":
        "Expression [with] [directory Text] [and] [contact profile unique id Text] [agent Text] [service Text] [campaign Text] [contact Text] [only pickable by agent if Boolean] [include closed campaigns if Boolean] [only activities with agent if Boolean]",
    "ANNOUNCEMENT-TYPE": "Expression"
};

const globalPatterns = new Map<string, Pattern>(Object.entries(GLOBAL_DEFS).map(([name, source]) => [name, compileTemplate(source)]));

export function globalDef(name: string): Pattern | undefined {
    return globalPatterns.get(name);
}

// ---------------------------------------------------------------- actions

export interface ActionDef {
    name: string;
    syntax: string[];
    doc: string;
    url?: string;
    section?: string;
    patterns: Pattern[];
    defs: Map<string, Pattern>;
    keywords: Set<string>;
    /** Keywords that open an optional clause. */
    starters: Set<string>;
    lead: string;
    /** Leading keyword phrase, e.g. "open window". */
    phrase: string;
    /** Diagnostic id when the action is dropped or unsupported in Web Edition. */
    web?: { message: string; severity: "error" | "warning" };
    deprecated?: string;
}

interface RawAction {
    name: string;
    section?: string;
    syntax: string[];
    defs: Record<string, string>;
    doc: string;
    url?: string;
}

/** Actions documented outside the generated catalogue (control flow and node actions are parsed by hand). */
const EXTRA_ACTIONS: RawAction[] = [
    { name: "return", syntax: ["return"], defs: {}, doc: "Ends the current subroutine or function.", url: "ref/action/control-flow.html", section: "Control flow actions" },
    { name: "break loop", syntax: ["break loop"], defs: {}, doc: "Terminates the enclosing while, repeat or for loop.", url: "ref/action/control-flow.html", section: "Control flow actions" },
    { name: "clear error", syntax: ["clear error"], defs: {}, doc: "Empties the built-in attribute @error.", url: "ref/action/control-flow.html", section: "Control flow actions" },
    { name: "back node", syntax: ["back node"], defs: {}, doc: "Transfers control to the previous node, ignoring the remaining actions of the block.", url: "ref/action/node-control.html", section: "Node actions" },
    { name: "return node", syntax: ["return node"], defs: {}, doc: "Transfers control to the last node that executed an action call node.", url: "ref/action/node-control.html", section: "Node actions" },
    { name: "exit through", syntax: ["exit through ID"], defs: {}, doc: "For node templates. Executes the sequence of actions associated with the exit point ID, declared on the node.", url: "ref/action/node-control.html", section: "Node actions" },
    { name: "dim", syntax: ["dim ArrayVAR to Integer"], defs: {}, doc: "Resizes an array.", url: "ref/action/assign-array.html", section: "Assignment and array actions" },
    { name: "add", syntax: ["add Expression to ArrayVAR [at Integer]"], defs: {}, doc: "Adds a new element to an array. The size grows by one.", url: "ref/action/assign-array.html", section: "Assignment and array actions" },
    { name: "remove", syntax: ["remove [into VAR] from ArrayVAR [at Integer]"], defs: {}, doc: "Removes an element from an array, which shrinks by one position.", url: "ref/action/assign-array.html", section: "Assignment and array actions" },
    { name: "add event handler", syntax: ["add event handler ID to Expression"], defs: {}, doc: "Maps a managed (.NET) event to a user-defined ASL event.", url: "ref/dll/managed-dlls.html", section: "Managed DLLs" },
    { name: "remove event handler", syntax: ["remove event handler ID from Expression"], defs: {}, doc: "Removes a managed (.NET) event handler.", url: "ref/dll/managed-dlls.html", section: "Managed DLLs" },
    { name: "flow view element", syntax: ["flow view element Expression { ACTION* }"], defs: {}, doc: "For node templates. Creates a visual element in the canvas of the visual flow editor.", url: "ref/action/assign-array.html", section: "Assignment and array actions" },
    { name: "open modal window", syntax: ["open modal window Text [at Integer , Integer] [size Integer , Integer] [caption Text] [id into IntegerVAR] [arguments Expression,...]"], defs: {}, doc: "Legacy action from ASL for Windows. Modal windows are not supported in ASL Web Edition.", url: "concept/modal-windows.html", section: "Multiple windows and tabs actions" },
    { name: "run application", syntax: ["run application Text [Expression,...]"], defs: {}, doc: "Legacy action. The Agent Portal does not allow running external applications.", url: "concept/uagent-win-vs-web.html", section: "Legacy" },
    { name: "set call type", syntax: ["set call type [to] Expression"], defs: {}, doc: "Legacy action replaced by activity outcomes (add to outcomes).", url: "concept/migrate-asl-scripts.html", section: "Legacy" },
    { name: "check names", syntax: ["email editor Text [in window Integer] check names"], defs: {}, doc: "Dropped since 8.6.2000.", url: "concept/email-editor-actions-events.html", section: "Email editor element actions" },
    { name: "spell check", syntax: ["email editor Text [in window Integer] spell check"], defs: {}, doc: "Dropped since 8.6.2000.", url: "concept/email-editor-actions-events.html", section: "Email editor element actions" },
    {
        name: "web browser legacy action",
        syntax: ["web browser Text [in window Integer] [go back | go forward | stop | refresh | print]"],
        defs: {},
        doc: "Web browser action from ASL for Windows, not supported by the Agent Portal.",
        url: "concept/uagent-win-vs-web.html",
        section: "Web browser element actions"
    }
];

const WEB_UNSUPPORTED: Record<string, string> = {
    "open modal window": "Modal windows are not supported in ASL Web Edition. Use `open window ... overlay on close trigger event` and handle the result in that event.",
    "run application": "The Agent Portal does not allow running external applications.",
    "check names": "The email editor action `check names` was dropped in 8.6.2000.",
    "spell check": "The email editor action `spell check` was dropped in 8.6.2000.",
    "web browser legacy action": "The Agent Portal web browser does not support go back, go forward, stop, refresh or print.",
    "set call type": "`set call type` was replaced by activity outcomes (`add to outcomes`)."
};

const DEPRECATED_ACTIONS: Record<string, string> = {
    "Retrieve instant messaging": "Deprecated. Use the media panel actions and events.",
    "Transfer instant messaging": "Deprecated. Use the media panel actions and events.",
    "Conference instant messaging": "Deprecated. Use the media panel actions and events.",
    "Extend instant messaging": "Deprecated. Use the media panel actions and events.",
    "Start instant messaging": "Deprecated. Use the media panel actions and events.",
    "Send instant message": "Deprecated. Use `media panel chat send message`.",
    "Download instant messaging transcript": "Not available with update 8.6.3100 or later."
};

function buildAction(raw: RawAction): ActionDef {
    const defs = new Map<string, Pattern>(Object.entries(raw.defs ?? {}).map(([name, source]) => [name, compileTemplate(source)]));
    const lookup = (name: string): Pattern | undefined => defs.get(name) ?? globalPatterns.get(name);
    const patterns = raw.syntax.map((source) => compileTemplate(source));
    const keywords = new Set<string>();
    for (const pattern of patterns) {
        collectKeywords(pattern, lookup, keywords);
    }
    const lead = leadingWords(patterns[0]);
    const starters = new Set<string>();
    for (const pattern of patterns) collectStarters(pattern, lookup, starters);
    const chatControl = raw.section === "Chat control element actions";
    return {
        name: raw.name,
        syntax: raw.syntax,
        doc: raw.doc,
        url: raw.url,
        section: raw.section,
        patterns,
        defs,
        keywords,
        starters,
        lead: lead[0] ?? "",
        phrase: lead.join(" "),
        web: WEB_UNSUPPORTED[raw.name] ? { message: WEB_UNSUPPORTED[raw.name], severity: raw.name === "open modal window" ? "error" : "warning" } : undefined,
        deprecated: DEPRECATED_ACTIONS[raw.name] ?? (chatControl ? "The chat control is deprecated. Use the media panel actions." : undefined)
    };
}

/** First keywords of optional clauses (and of alternatives inside them). */
function collectStarters(pattern: Pattern, lookup: (name: string) => Pattern | undefined, into: Set<string>, seen = new Set<string>()): void {
    const firstWords = (p: Pattern): void => {
        switch (p.t) {
            case "lit":
                if (/^[a-z]/.test(p.word)) into.add(p.word);
                break;
            case "seq":
                if (p.items.length) firstWords(p.items[0]);
                if (p.items[0]?.t === "opt" && p.items[1]) firstWords(p.items[1]);
                break;
            case "alt":
                p.items.forEach(firstWords);
                break;
            case "opt":
            case "rep":
                firstWords(p.item);
                break;
            case "ref":
                if (!seen.has(p.name)) {
                    seen.add(p.name);
                    const def = lookup(p.name);
                    if (def) firstWords(def);
                }
                break;
            default:
                break;
        }
    };
    const walk = (p: Pattern): void => {
        switch (p.t) {
            case "opt":
                firstWords(p.item);
                walk(p.item);
                break;
            case "seq":
            case "alt":
                p.items.forEach(walk);
                break;
            case "rep":
            case "brace":
                walk(p.item);
                break;
            default:
                break;
        }
    };
    walk(pattern);
}

export const ACTIONS: ActionDef[] = [...(actionsData as RawAction[]), ...EXTRA_ACTIONS].map(buildAction);

/** Action indexes grouped by their first keyword. */
export const ACTIONS_BY_LEAD = new Map<string, number[]>();
ACTIONS.forEach((action, index) => {
    const list = ACTIONS_BY_LEAD.get(action.lead) ?? [];
    list.push(index);
    ACTIONS_BY_LEAD.set(action.lead, list);
});

export function actionDefs(action: ActionDef): (name: string) => Pattern | undefined {
    return (name) => action.defs.get(name) ?? globalPatterns.get(name);
}

/** Words that start a statement handled by the parser itself. */
export const STATEMENT_WORDS = new Set(["if", "case", "while", "repeat", "for", "var", "const", "call", "goto"]);

// ---------------------------------------------------------------- functions

export interface FunctionDef {
    name: string;
    signature: string;
    params: { name: string; type?: string; doc?: string; optional?: boolean }[];
    returns?: string;
    overloads?: string[];
    variadic?: boolean;
    doc: string;
    url?: string;
    category?: string;
    webNotes?: string;
    deprecated?: boolean;
    returnsRecord?: FieldDef[];
}

export interface FieldDef {
    name: string;
    type?: string;
    doc?: string;
}

const LEGACY_FUNCTIONS: FunctionDef[] = [
    { name: "rgbcolor", signature: "rgbcolor(red: number, green: number, blue: number): RGBColor", params: [{ name: "red" }, { name: "green" }, { name: "blue" }], returns: "RGBColor", doc: "Legacy name of `rgb_color`.", url: "ref/expr/function-graphic-webasl.html", deprecated: true },
    { name: "folder_browser", signature: "folder_browser(...): text", params: [], returns: "text", variadic: true, doc: "Legacy built-in. The Agent Portal does not support it.", url: "concept/uagent-win-vs-web.html", webNotes: "Not supported by the Agent Portal." },
    { name: "current_url", signature: "current_url(...): text", params: [], returns: "text", variadic: true, doc: "Legacy built-in. The Agent Portal cannot return the browser URL due to cross-domain restrictions.", url: "concept/uagent-win-vs-web.html", webNotes: "Not supported by the Agent Portal." },
    { name: "current_html", signature: "current_html(...): text", params: [], returns: "text", variadic: true, doc: "Legacy built-in. The Agent Portal cannot return HTML content due to cross-domain restrictions.", url: "concept/uagent-win-vs-web.html", webNotes: "Not supported by the Agent Portal." },
    { name: "whatsapp_session_active", signature: "whatsapp_session_active(servicePhone: text, contactProfilePhone: text): boolean", params: [{ name: "servicePhone", type: "text" }, { name: "contactProfilePhone", type: "text" }], returns: "boolean", doc: "Returns true when a WhatsApp session is active between the service phone and the contact profile phone.", url: "concept/digital-outbound.html" }
];

export const FUNCTIONS = new Map<string, FunctionDef>();
for (const fn of [...(functionsData as FunctionDef[]), ...LEGACY_FUNCTIONS]) {
    if (!FUNCTIONS.has(fn.name.toLowerCase())) {
        FUNCTIONS.set(fn.name.toLowerCase(), fn);
    }
}

/** Minimum and maximum argument counts of a built-in, across overloads. */
export function functionArity(fn: FunctionDef): { min: number; max: number } {
    const counts = [fn.signature, ...(fn.overloads ?? [])].map((signature) => {
        const inner = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")")).trim();
        if (!inner) {
            return { min: 0, max: 0 };
        }
        if (inner.includes("...")) {
            return { min: 0, max: Infinity };
        }
        const parts = splitTopLevel(inner);
        return { min: parts.length, max: parts.length };
    });
    let min = Math.min(...counts.map((c) => c.min));
    const max = Math.max(...counts.map((c) => c.max));
    const optional = fn.params.filter((p) => p.optional).length;
    min = Math.max(0, Math.min(min, fn.params.length - optional));
    return { min: fn.variadic ? 0 : min, max: fn.variadic ? Infinity : max };
}

function splitTopLevel(value: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of value) {
        if (ch === "(" || ch === "[" || ch === "<") depth += 1;
        if (ch === ")" || ch === "]" || ch === ">") depth -= 1;
        if (ch === "," && depth === 0) {
            parts.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current);
    return parts;
}

// ---------------------------------------------------------------- attributes, records, enums

export interface AttributeDef {
    name: string;
    type?: string;
    doc: string;
    url?: string;
    fields: FieldDef[];
}

export interface RecordDef {
    name: string;
    doc?: string;
    url?: string;
    fields: FieldDef[];
}

export interface EnumDef {
    name: string;
    url?: string;
    members: { name: string; value?: number; doc?: string }[];
}

export const ATTRIBUTES = new Map<string, AttributeDef>((attributesData as AttributeDef[]).map((a) => [a.name.toLowerCase(), a]));

const EXTRA_RECORDS: RecordDef[] = [
    { name: "Attribute", doc: "Name/value pair used by attribute lists.", url: "ref/action/attribute.html", fields: [{ name: "name", type: "text" }, { name: "value", type: "text" }] },
    { name: "RGBColor", doc: "Colour returned by `rgb_color`.", url: "ref/expr/function-graphic-webasl.html", fields: [{ name: "red", type: "number" }, { name: "green", type: "number" }, { name: "blue", type: "number" }] },
    { name: "MenuItem", doc: "Menu element item.", url: "ref/decl/elem-menu.html", fields: [{ name: "tag", type: "text" }, { name: "label", type: "text" }, { name: "items", type: "array of MenuItem" }] },
    { name: "AttachmentInfo", doc: "Email attachment information.", url: "ref/action/elem-email-editor.html", fields: [{ name: "name", type: "text" }, { name: "size", type: "number" }, { name: "contentType", type: "text" }] },
    { name: "EnumerationConstantInfo", doc: "Row returned by enumeration cursors.", url: "ref/decl/cursor.html", fields: [{ name: "name", type: "text" }, { name: "label", type: "text" }, { name: "value", type: "number" }] }
];

export const RECORDS = new Map<string, RecordDef>([...(recordsData as RecordDef[]), ...EXTRA_RECORDS].map((r) => [r.name.toLowerCase(), r]));
for (const fn of FUNCTIONS.values()) {
    if (fn.returnsRecord && fn.returns && !RECORDS.has(fn.returns.toLowerCase()) && /^[A-Z]\w+$/.test(fn.returns)) {
        RECORDS.set(fn.returns.toLowerCase(), { name: fn.returns, doc: `Returned by \`${fn.name}\`.`, url: fn.url, fields: fn.returnsRecord });
    }
}
for (const attribute of ATTRIBUTES.values()) {
    if (attribute.type && attribute.fields.length > 0 && !RECORDS.has(attribute.type.toLowerCase())) {
        RECORDS.set(attribute.type.toLowerCase(), { name: attribute.type, doc: `Type of \`${attribute.name}\`.`, url: attribute.url, fields: attribute.fields });
    }
}

export const ENUMS = new Map<string, EnumDef>((enumsData as EnumDef[]).map((e) => [e.name.toLowerCase(), e]));

/** Predefined script variables (business data). */
export const BUSINESS_VARIABLES: Record<string, { type: string; doc: string; section?: string }> = {
    campaign: { type: "CampaignRecord", doc: "Campaign business data, as declared by `campaign record`. Read-only.", section: "campaign record" },
    contact: { type: "ContactRecord", doc: "Contact business data, as declared by `contact record`.", section: "contact record" },
    workflow: { type: "WorkflowRecord", doc: "Workflow business data, as declared by `workflow record`.", section: "workflow record" },
    transferred: { type: "TransferredRecord", doc: "Data transferred with the interaction, as declared by `transferred record`.", section: "transferred record" },
    outcomes: { type: "array of OutcomeRecord", doc: "Activity outcomes, as declared by `outcome record`.", section: "outcome record" },
    contact_profile: { type: "ContactProfileRecord", doc: "Contact profile of the session." }
};

/** Predefined constants (error codes and window ids) used by older scripts and the reference examples. */
export const CONSTANTS = new Map<string, { name: string; value?: number; doc?: string }>((constantsData as { name: string; value?: number; doc?: string }[]).map((c) => [c.name.toLowerCase(), c]));

export const BUILTIN_TYPES = new Set(["boolean", "number", "text", "date", "time", "datetime", "bytestream"]);

// ---------------------------------------------------------------- events

export interface EventDef {
    /** Normalised words after `on`, e.g. "event phone connected". */
    words: string;
    params: string;
    doc: string;
    url?: string;
    deprecated?: string;
    /** Applies to IVR / routing scripts only. */
    ivr?: boolean;
}

export const EVENTS = new Map<string, EventDef>((eventsData as EventDef[]).map((e) => [e.words, e]));

// ---------------------------------------------------------------- controls

export interface ControlClauseDef {
    /** Leading keyword phrase, e.g. "hidden if". */
    phrase: string;
    syntax: string;
    doc?: string;
    pattern: Pattern;
    required: boolean;
}

export interface ControlDef {
    name: string;
    doc: string;
    url?: string;
    syntax: string;
    target?: "variable" | "cursor";
    clauses: ControlClauseDef[];
    defs: Map<string, Pattern>;
    events: { name: string; syntax: string; doc?: string; words: RegExp }[];
    deprecated?: string;
    webNotes?: string;
    /** Clauses of ASL for Windows that the Agent Portal ignores. */
    legacyClauses: string[];
}

const LEGACY_CONTROL_CLAUSES: Record<string, string[]> = {
    "email editor": ["open new emails in same editor", "standard toolbar hidden if", "labels font", "inputs font"],
    "web browser": ["toolbar hidden if", "toolbar position", "toolbar at"],
    "chat control": ["enhanced style", "read only if"]
};

interface RawControl {
    name: string;
    syntax: string;
    doc: string;
    url?: string;
    deprecated?: boolean | string;
    webNotes?: string;
    properties: { name: string; syntax: string; doc?: string; parent?: string }[];
    events: { name: string; syntax: string; doc?: string }[];
}

function buildControl(raw: RawControl): ControlDef {
    // Script Developer writes `align center` everywhere, although some synopses only list left/right.
    raw = { ...raw, syntax: raw.syntax.replace(/\[?\[?align (?:left|right|center)\|align (?:left|right|center)\]?\]?/g, "[align left|align right|align center]") };
    const open = raw.syntax.indexOf("{");
    const header = raw.syntax.slice(0, open);
    let depth = 0;
    let close = open;
    for (let i = open; i < raw.syntax.length; i += 1) {
        if (raw.syntax[i] === "{") depth += 1;
        if (raw.syntax[i] === "}") {
            depth -= 1;
            if (depth === 0) {
                close = i;
                break;
            }
        }
    }
    const body = raw.syntax.slice(open + 1, close);
    const trailer = raw.syntax.slice(close + 1);
    const defs = new Map<string, Pattern>();
    for (const match of trailer.matchAll(/^([A-Z][A-Z-]+):\s*\n((?:[ \t]+.*\n?)*)/gm)) {
        defs.set(match[1], compileTemplate(match[2].replace(/\s+/g, " ").replace(/^\s*\|\s*/, "")));
    }
    const docs = new Map(raw.properties.map((p) => [p.name.toLowerCase(), p.doc]));
    const clauses: ControlClauseDef[] = [];
    const bodyPattern = compileTemplate(body);
    const items = bodyPattern.t === "seq" ? bodyPattern.items : [bodyPattern];
    const sources = splitClauseSources(body);
    let pending: Pattern[] = [];
    const flush = (): void => {
        if (pending.length > 0) {
            const pattern: Pattern = pending.length === 1 ? pending[0] : { t: "seq", items: pending };
            addClause(pattern, true);
            pending = [];
        }
    };
    const addClause = (pattern: Pattern, required: boolean): void => {
        const phrase = leadingWords(pattern).join(" ");
        if (phrase === "on" || phrase.startsWith("on ")) {
            return;
        }
        const syntax = sources.find((s) => s.replace(/^\[|\]$/g, "").trim().toLowerCase().startsWith(phrase || "\u0000")) ?? phrase;
        clauses.push({ phrase, syntax: syntax.replace(/^\[(.*)\]$/s, "$1").replace(/\s+/g, " ").trim(), doc: docs.get(phrase) ?? docs.get(phrase.split(" ")[0]), pattern, required });
    };
    for (const item of items) {
        if (item.t === "opt") {
            flush();
            addClause(item.item, false);
        } else {
            pending.push(item);
        }
    }
    flush();
    const targetMatch = header.match(/\bfor\s+(VAR|ID)\b/);
    return {
        name: raw.name,
        doc: raw.doc,
        url: raw.url,
        syntax: raw.syntax,
        target: targetMatch ? (targetMatch[1] === "ID" ? "cursor" : "variable") : undefined,
        clauses,
        defs,
        events: raw.events.map((e) => ({ name: e.name, syntax: e.syntax, doc: e.doc, words: eventRegex(e.syntax) })),
        deprecated: typeof raw.deprecated === "string" ? raw.deprecated : raw.deprecated ? "Deprecated." : raw.name === "chat control" ? "The chat control is deprecated and replaced by the media panel." : undefined,
        webNotes: raw.webNotes,
        legacyClauses: LEGACY_CONTROL_CLAUSES[raw.name] ?? []
    };
}

function splitClauseSources(body: string): string[] {
    const result: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of body.replace(/\s+/g, " ")) {
        if (ch === "[") {
            if (depth === 0 && current.trim()) {
                result.push(current.trim());
                current = "";
            }
            depth += 1;
        }
        current += ch;
        if (ch === "]") {
            depth -= 1;
            if (depth === 0) {
                result.push(current.trim());
                current = "";
            }
        }
    }
    if (current.trim()) result.push(current.trim());
    return result;
}

/** Turns `on toolbar [print|send] click (ref cancel: boolean) { ACTION* }` into a matcher for event words. */
function eventRegex(syntax: string): RegExp {
    let words = syntax.replace(/\(.*$/s, "").replace(/\{.*$/s, "").replace(/^on\s+/, "").trim();
    words = words.replace(/\[\[?commit\|rollback\]?\]|\[commit\]/g, "").trim();
    const source = (words.match(/\[[^\]]*\]|\S+/g) ?? [])
        .map((word) => {
            const alt = word.match(/^\[(.+)\]$/);
            if (alt) {
                return `(?:${alt[1].split("|").map((w) => w.trim().replace(/\s+/g, " ")).join("|")})`;
            }
            return word.toLowerCase();
        })
        .join(" ");
    return new RegExp(`^${source}$`);
}

export const CONTROLS = new Map<string, ControlDef>((controlsData as RawControl[]).map((raw) => [raw.name, buildControl(raw)]));

/** Control keywords, longest first so that `push button` wins over shorter prefixes. */
export const CONTROL_NAMES = [...CONTROLS.keys()].sort((a, b) => b.split(" ").length - a.split(" ").length);

export function controlDefs(control: ControlDef): (name: string) => Pattern | undefined {
    return (name) => control.defs.get(name) ?? globalPatterns.get(name);
}
