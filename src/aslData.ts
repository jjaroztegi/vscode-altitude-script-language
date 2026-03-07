export type AslSymbolKindName =
    | "section"
    | "node"
    | "block"
    | "event"
    | "type"
    | "field"
    | "variable"
    | "parameter"
    | "constant"
    | "cursor"
    | "namespace"
    | "control";

export interface AslHelpEntry {
    name: string;
    description: string;
    detail?: string;
    insertText?: string;
    documentation?: string;
}

export interface AslControlDefinition extends AslHelpEntry {
    requiresTarget?: "variable" | "cursor";
    properties: string[];
    events: string[];
}

export const TOP_LEVEL_BLOCKS: AslHelpEntry[] = [
    { name: "modules", description: "Import modules and namespaces.", insertText: "modules {\n\t$0\n}" },
    { name: "dependencies", description: "Declare images, DLLs, and web services.", insertText: "dependencies {\n\t$0\n}" },
    { name: "constants", description: "Define script-level constants.", insertText: "constants {\n\t$0\n}" },
    { name: "types", description: "Define records and enumerations.", insertText: "types {\n\t$0\n}" },
    { name: "variables", description: "Define script variables.", insertText: "variables {\n\t$0\n}" },
    { name: "parameters", description: "Define script parameters.", insertText: "parameters {\n\t$0\n}" },
    { name: "cursors", description: "Define script cursors.", insertText: "cursors {\n\t$0\n}" },
    { name: "using namespaces", description: "Import .NET namespaces for managed DLL usage.", insertText: "using namespaces {\n\t$0\n}" },
    { name: "campaign record", description: "Declare the campaign record shape.", insertText: "campaign record {\n\t$0\n}" },
    { name: "contact record", description: "Declare the contact record shape.", insertText: "contact record {\n\t$0\n}" },
    { name: "workflow record", description: "Declare the workflow record shape.", insertText: "workflow record {\n\t$0\n}" },
    { name: "transferred record", description: "Declare the transferred record shape.", insertText: "transferred record {\n\t$0\n}" },
    { name: "contact profile extensions", description: "Declare contact profile extension fields.", insertText: "contact profile extensions {\n\t$0\n}" },
    { name: "outcome record", description: "Declare the outcome record shape.", insertText: "outcome record {\n\t$0\n}" },
    { name: "node", description: "Create a script node.", insertText: "node \"${1:NAME}\" {\n\t$0\n}" },
    { name: "block", description: "Create a reusable block.", insertText: "block \"${1:NAME}\" {\n\t$0\n}" }
];

export const SECTION_NAMES = new Set(TOP_LEVEL_BLOCKS.map((entry) => entry.name));

export const SCRIPT_EVENTS: AslHelpEntry[] = [
    { name: "on start", description: "Script entry event.", insertText: "on start {\n\t$0\n}" },
    { name: "on end", description: "Script termination event.", insertText: "on end {\n\t$0\n}" },
    { name: "on load", description: "Module or block load event.", insertText: "on load {\n\t$0\n}" },
    { name: "on unload", description: "Module or block unload event.", insertText: "on unload {\n\t$0\n}" },
    { name: "on first enter", description: "Node first-enter event.", insertText: "on first enter {\n\t$0\n}" },
    { name: "on enter", description: "Node enter event.", insertText: "on enter {\n\t$0\n}" },
    { name: "on exit", description: "Node exit event.", insertText: "on exit {\n\t$0\n}" },
    { name: "on event", description: "System event handler.", insertText: "on event ${1:name}() {\n\t$0\n}" },
    { name: "on error", description: "Error handler.", insertText: "on error ${1:name}(${2:err}: ${3:ErrorType}) {\n\t$0\n}" }
];

export const FLOW_KEYWORDS: AslHelpEntry[] = [
    { name: "goto node", description: "Transfer execution to another node.", insertText: "goto node \"${1:TARGET}\"" },
    { name: "call node", description: "Call another node as a subroutine.", insertText: "call node \"${1:TARGET}\"" },
    { name: "back node", description: "Return to the previous node in the call stack.", insertText: "back node" },
    { name: "return", description: "Return from the current node or event." },
    { name: "exit through", description: "Exit through a named branch.", insertText: "exit through ${1:branch}" },
    { name: "abort script", description: "Abort script execution immediately." },
    { name: "discard script", description: "Discard the current script." },
    { name: "end script", description: "Terminate script execution." },
    { name: "restart script", description: "Restart the script from the beginning." },
    { name: "clear error", description: "Reset @error before an operation." }
];

export const LANGUAGE_KEYWORDS: AslHelpEntry[] = [
    { name: "with", description: "Associates additional clauses such as cursor-backed combo-box columns or action modifiers." },
    { name: "to", description: "Targets a destination in statements such as loops, timer scheduling, array growth, and data movement." },
    { name: "from", description: "Indicates a source in imports and data movement statements." },
    { name: "into", description: "Introduces a destination binding, such as namespace imports or SQL/cursor fetch targets." },
    { name: "variable", description: "Marks a variable fetch/output target in cursor and SQL statements." },
    { name: "record", description: "Declares or targets a record value or record-typed fetch destination." },
    { name: "match by name", description: "Maps cursor columns into record fields by matching names." },
    { name: "absolute", description: "Uses an absolute cursor fetch position." },
    { name: "relative", description: "Uses a relative cursor fetch position." },
    { name: "dim", description: "Resizes an array or collection." },
    { name: "add", description: "Adds an item to a collection or UI structure." }
];

export const TYPE_NAMES = [
    "text",
    "number",
    "boolean",
    "date",
    "time",
    "datetime",
    "bytestream",
    "record",
    "array of",
    "enumeration",
    "sql cursor",
    "system cursor",
    "cursor",
    "void"
];

export const SYSTEM_VARIABLES: AslHelpEntry[] = [
    { name: "@script_start_reason", description: "Explains why the script started." },
    { name: "@script_info", description: "Script metadata such as node, windowId, fileName, and majorVersion." },
    { name: "@script_session_info", description: "Current session metadata including agent, campaign, contact, and sessionUrl." },
    { name: "@login_info", description: "Agent login information." },
    { name: "@phone_info", description: "Telephony metadata such as ANI and DNIS." },
    { name: "@email_info", description: "Current email interaction metadata." },
    { name: "@instant_messaging_info", description: "Current instant messaging session metadata." },
    { name: "@interaction_info", description: "Current interaction metadata." },
    { name: "@workflow_info", description: "Workflow metadata for the running script." },
    { name: "@schedule_info", description: "Schedule metadata available to the script." },
    { name: "@error", description: "Boolean error flag set by the previous operation." },
    { name: "@error_info", description: "Detailed error information, including SQL errors and no-row states." }
];

export const BUILTIN_FUNCTIONS: AslHelpEntry[] = [
    { name: "number_ceiling", description: "Round a number up.", detail: "number_ceiling(value: number): number" },
    { name: "number_floor", description: "Round a number down.", detail: "number_floor(value: number): number" },
    { name: "number_round", description: "Round a number to the nearest value.", detail: "number_round(value: number): number" },
    { name: "text_to_upper", description: "Convert text to uppercase.", detail: "text_to_upper(value: text): text" },
    { name: "text_to_lower", description: "Convert text to lowercase.", detail: "text_to_lower(value: text): text" },
    { name: "text_length", description: "Get text length.", detail: "text_length(value: text): number" },
    { name: "text_append", description: "Append text values.", detail: "text_append(left: text, right: text): text" },
    { name: "format", description: "Format text with placeholders.", detail: "format(template: text, ...args): text" },
    { name: "bytestream_to_text", description: "Convert a bytestream to text.", detail: "bytestream_to_text(value: bytestream): text" },
    { name: "now", description: "Get the current date and time.", detail: "now(): datetime" },
    { name: "today", description: "Get the current date.", detail: "today(): date" },
    { name: "file_create", description: "Create a file handle." },
    { name: "file_write_line", description: "Write a line to a file." },
    { name: "file_copy", description: "Copy a file." },
    { name: "file_browser", description: "Open the file browser." },
    { name: "rgb_color", description: "Create a UI color from RGB values.", detail: "rgb_color(red: number, green: number, blue: number): color" },
    { name: "message", description: "Write a message for debugging or tracing." },
    { name: "open message box", description: "Show a message box to the agent." },
    { name: "open cursor", description: "Open a cursor for iteration." },
    { name: "close cursor", description: "Close an opened cursor." },
    { name: "fetch cursor", description: "Fetch the next cursor row." },
    { name: "sql execute", description: "Execute SQL against the configured database." },
    { name: "system select", description: "Run a system-side select statement." },
    { name: "open window", description: "Open a window, optionally as overlay." },
    { name: "close window", description: "Close a previously opened window." },
    { name: "dial phone", description: "Dial a phone number." },
    { name: "answer phone", description: "Answer the active phone interaction." },
    { name: "hang up phone", description: "Hang up the active phone interaction." },
    { name: "hold phone", description: "Put the phone interaction on hold." },
    { name: "retrieve phone", description: "Retrieve a held phone interaction." },
    { name: "transfer call", description: "Transfer the active call." },
    { name: "conference phone", description: "Create a phone conference." },
    { name: "load contact", description: "Load contact data into the script." },
    { name: "update contact", description: "Persist contact changes." },
    { name: "set business status", description: "Change the agent business status." },
    { name: "add to outcomes", description: "Append a value to the outcomes collection." },
    { name: "set timer", description: "Schedule a timer event." },
    { name: "kill timer", description: "Cancel a timer event." },
    { name: "handle pending events", description: "Drain pending asynchronous events." }
];

const commonControlProperties = [
    "size",
    "at",
    "hidden if",
    "anchor",
    "tab order",
    "disabled if",
    "enhanced style"
];

export const CONTROL_DEFINITIONS: AslControlDefinition[] = [
    {
        name: "push button",
        description: "Displays a button that raises an on click event.",
        documentation: "Documented Altitude UI control. Supports labels, optional images, and click events.",
        requiresTarget: undefined,
        properties: [...commonControlProperties, "default button", "flat", "tooltip", "background", "background color", "label", "image"],
        events: ["on click"]
    },
    {
        name: "text button",
        description: "Displays a text-only button that raises an on click event.",
        properties: [...commonControlProperties, "default button", "tooltip", "background", "background color", "label"],
        events: ["on click"]
    },
    {
        name: "check box",
        description: "Binds a boolean-style UI toggle to a variable.",
        requiresTarget: "variable",
        properties: [...commonControlProperties, "background", "label", "checked if", "unchecked if"],
        events: ["on click"]
    },
    {
        name: "radio button",
        description: "Binds an exclusive choice to a variable.",
        requiresTarget: "variable",
        properties: [...commonControlProperties, "background", "label", "checked if"],
        events: ["on click"]
    },
    {
        name: "input",
        description: "Free-form input field bound to a variable.",
        requiresTarget: "variable",
        properties: [...commonControlProperties, "password", "uppercase", "multiline", "wordwrap", "align", "year completion", "format", "read only if", "background color", "font"],
        events: ["on lose focus"]
    },
    {
        name: "combo box",
        description: "Selection input with explicit items or cursor-backed values.",
        requiresTarget: "variable",
        properties: [...commonControlProperties, "input field height", "year completion", "format", "items", "label", "cursor", "values column", "labels column", "automatically fill values", "drop on demand", "allow other values", "uppercase", "sort", "align", "background color", "font"],
        events: ["on list selection", "on lose focus"]
    },
    {
        name: "list",
        description: "List-based selector bound to a variable.",
        requiresTarget: "variable",
        properties: [...commonControlProperties, "items", "cursor", "values column", "labels column", "automatically fill values", "drop on demand", "sort", "background color", "font"],
        events: ["on list selection", "on change"]
    },
    {
        name: "menu",
        description: "Tree-like menu element for hierarchical choices.",
        properties: [...commonControlProperties, "items", "item", "tag", "level", "formattings", "background color"],
        events: ["on expand", "on leaf selected"]
    },
    {
        name: "static text",
        description: "Displays labels or headings in a node.",
        properties: ["size", "at", "hidden if", "anchor", "enhanced style", "background", "background color", "label", "font"],
        events: []
    },
    {
        name: "static box",
        description: "Visual grouping box for related content.",
        properties: ["size", "at", "hidden if", "anchor", "border", "enhanced style", "background color", "label", "image"],
        events: []
    },
    {
        name: "container",
        description: "Layout container for nested graphical blocks.",
        properties: ["size", "at", "hidden if", "anchor", "border", "background color", "initial block"],
        events: []
    },
    {
        name: "group",
        description: "Logical grouping control for related content.",
        properties: ["size", "at", "hidden if", "anchor", "background color", "label"],
        events: []
    },
    {
        name: "chat control",
        description: "Embeds an agent chat surface in the node UI.",
        properties: [...commonControlProperties, "background", "read only if"],
        events: ["on event"]
    },
    {
        name: "email editor",
        description: "Displays and edits inbound or outbound email content.",
        properties: [
            ...commonControlProperties,
            "media name",
            "background",
            "initial email id",
            "unavailable if",
            "read only if",
            "from read only if",
            "knowledge base toolbar hidden if",
            "standard toolbar hidden if",
            "formatting toolbar hidden if",
            "table toolbar hidden if",
            "labels font",
            "inputs font"
        ],
        events: ["on event"]
    },
    {
        name: "web browser",
        description: "Embeds a browser surface inside the node UI.",
        properties: [...commonControlProperties, "background", "initial url", "persistent"],
        events: ["on event"]
    },
    {
        name: "table",
        description: "Displays a cursor as a table with documented header and column properties.",
        requiresTarget: "cursor",
        properties: [...commonControlProperties, "background color", "font", "header background color", "header font", "columns", "column", "size", "hidden", "align", "format", "sortable", "tag", "header align"],
        events: ["on click", "on change", "on double click"]
    },
    {
        name: "flow view",
        description: "Enables graphical flow rendering for uAgent screens.",
        properties: [],
        events: []
    }
];

export const CONTROL_MAP = new Map(CONTROL_DEFINITIONS.map((definition) => [definition.name, definition]));
export const CONTROL_NAMES = CONTROL_DEFINITIONS.map((definition) => definition.name);
export const CONTROL_NAMES_BY_LENGTH = [...CONTROL_NAMES].sort((left, right) => right.length - left.length);
export const ALL_PROPERTY_NAMES = Array.from(new Set(CONTROL_DEFINITIONS.flatMap((definition) => definition.properties))).sort((left, right) => right.length - left.length);
export const ALL_EVENT_NAMES = Array.from(new Set([...SCRIPT_EVENTS.map((entry) => entry.name), ...CONTROL_DEFINITIONS.flatMap((definition) => definition.events)])).sort((left, right) => right.length - left.length);

export function normalizeAslName(value: string): string {
    return value.trim().toLowerCase();
}

export function findControlDefinition(name: string): AslControlDefinition | undefined {
    return CONTROL_MAP.get(normalizeAslName(name));
}

export function findHelpEntry(name: string): AslHelpEntry | undefined {
    const normalized = normalizeAslName(name);
    return [
        ...TOP_LEVEL_BLOCKS,
        ...SCRIPT_EVENTS,
        ...FLOW_KEYWORDS,
        ...LANGUAGE_KEYWORDS,
        ...SYSTEM_VARIABLES,
        ...BUILTIN_FUNCTIONS,
        ...CONTROL_DEFINITIONS
    ].find((entry) => normalizeAslName(entry.name) === normalized);
}