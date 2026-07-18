export type AslSymbolKindName =
    | "section"
    | "node"
    | "block"
    | "event"
    | "subroutine"
    | "function"
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
    { name: "flow view", description: "Declare flow-view metadata used by Script Developer.", insertText: "flow view {\n\t$0\n}" },
    { name: "node", description: "Create a script node.", insertText: "node \"${1:NAME}\" {\n\t$0\n}" },
    { name: "private node", description: "Create a node scoped for private use within the script.", insertText: "private node \"${1:NAME}\" {\n\t$0\n}" },
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

export const ACTION_KEYWORDS: AslHelpEntry[] = [
    {
        name: "open cursor",
        description: "Opens a cursor declared in the current scope.",
        insertText: "open cursor ${1:cursorName}"
    },
    {
        name: "close cursor",
        description: "Closes a cursor and releases its resources.",
        insertText: "close cursor ${1:cursorName}"
    },
    {
        name: "fetch cursor",
        description: "Retrieves a row from a cursor, optionally using absolute or relative positioning and into targets.",
        insertText: "fetch cursor ${1:cursorName} ${2|absolute,relative|} ${3:1} into variable ${4:targetVar}"
    },
    {
        name: "sql select",
        description: "Executes a select statement that returns a single row into variables or records.",
        insertText: "sql select ${1:'SELECT ...'} into\n\tvariable ${2:targetVar}"
    },
    {
        name: "sql execute",
        description: "Executes a non-select SQL statement, optionally storing lastserial into a variable.",
        insertText: "sql execute ${1:sqlText}"
    },
    {
        name: "system select",
        description: "Queries a system cursor into variables or records.",
        insertText: "system select from ${1:SystemCursor::name} into\n\tvariable ${2:targetVar}"
    },
    {
        name: "set timer",
        description: "Schedules a user-defined event after a timeout.",
        insertText: "set timer to ${1:1} trigger event ${2:EventName}() into ${3:timerId}"
    },
    {
        name: "set timer event",
        description: "Common event-oriented timer form used in nodes to trigger a user-defined event after a timeout.",
        insertText: "set timer event ${1:EventName}() to ${2:1} into ${3:timerId}"
    },
    {
        name: "kill timer event",
        description: "Cancels a timer event by id or event name.",
        insertText: "kill timer event ${1:timerId}"
    },
    {
        name: "handle pending events",
        description: "Processes queued asynchronous events.",
        insertText: "handle pending events"
    },
    {
        name: "get current",
        description: "Obtains the current business-data attributes of a schema into an array of attributes.",
        insertText: "get current ${1:contact} into array ${2:attributes}"
    },
    {
        name: "update current",
        description: "Updates business-data attributes of a schema using an attribute array.",
        insertText: "update current ${1:contact} data with array ${2:attributes}"
    },
    {
        name: "reschedule loaded contact",
        description: "Reschedules the loaded contact with a new date, time, and phone target.",
        insertText: "reschedule loaded contact at ${1:dateValue}, ${2:timeValue} reschedule phone ${3:phoneValue}"
    },
    {
        name: "dim",
        description: "Resizes an array or collection to a specific length.",
        insertText: "dim ${1:arrayName} to ${2:0}"
    },
    {
        name: "add",
        description: "Appends or inserts an item into a target collection.",
        insertText: "add ${1:value} to ${2:collection} at ${3:1}"
    },
    {
        name: "open window",
        description: "Opens a script window. In 8.7 web, popups are async overlays: use 'overlay' with 'on close trigger event' and handle the response in the event handler, never inline.",
        insertText: "open window '${1:MsgPopup::QUESTION}' at ${2:755}, ${3:330} size ${4:390}, ${5:200} caption ' ' overlay on close trigger event ${6:EventName} arguments ${7:args}"
    },
    {
        name: "close window",
        description: "Closes a previously opened window.",
        insertText: "close window"
    },
    {
        name: "open message box",
        description: "Shows a message box to the agent.",
        insertText: "open message box ${1:'Message'}"
    },
    {
        name: "trigger event",
        description: "Triggers a user-defined event.",
        insertText: "trigger event ${1:EventName}()"
    },
    {
        name: "insert html into body",
        description: "Appends HTML to the email body. Use this instead of a second 'set html body field', which overwrites or no-ops.",
        insertText: "email editor ${1:'name'} insert html ${2:htmlText} into body"
    },
    {
        name: "set html body field",
        description: "Sets the HTML body of the email editor. A second call overwrites the body; use 'insert html into body' to append.",
        insertText: "set html body field to ${1:htmlText}"
    },
    {
        name: "set to field",
        description: "Sets the To recipients of the email editor. Gate with 'if pEmail <> \\'\\'' when the editor may hold a received (read-only) email.",
        insertText: "set to field to ${1:recipients}"
    },
    {
        name: "set subject field",
        description: "Sets the subject of the email editor.",
        insertText: "set subject field to ${1:subject}"
    },
    {
        name: "send email",
        description: "Sends the email loaded in the email editor.",
        insertText: "send email"
    },
    {
        name: "goto node",
        description: "Transfers execution to another node. Never follow an overlay popup with a goto on the same path; move it into the popup's on close handler.",
        insertText: "goto node \"${1:TARGET}\""
    }
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

export const BUSINESS_DATA_VARIABLES: AslHelpEntry[] = [
    { name: "campaign", description: "Predefined script variable of type CampaignRecord, backed by the campaign record declaration." },
    { name: "contact", description: "Predefined script variable of type ContactRecord, backed by the contact record declaration." },
    { name: "workflow", description: "Predefined script variable of type WorkflowRecord, backed by the workflow record declaration." },
    { name: "transferred", description: "Predefined script variable of type TransferredRecord, backed by the transferred record declaration." },
    { name: "outcomes", description: "Predefined script variable containing an array of OutcomeRecord values, backed by the outcome record declaration." },
    { name: "contact_profile", description: "Predefined script variable of type ContactProfileRecord, backed by contact profile extensions declarations." }
];

// Built-in functions per the Altitude 8.7 ASL Reference (Values and operations).
export const BUILTIN_FUNCTIONS: AslHelpEntry[] = [
    { name: "text_to_upper", description: "Convert text to uppercase.", detail: "text_to_upper(value: text): text" },
    { name: "text_to_lower", description: "Convert text to lowercase.", detail: "text_to_lower(value: text): text" },
    { name: "text_length", description: "Get text length.", detail: "text_length(value: text): number" },
    { name: "text_append", description: "Append text values.", detail: "text_append(left: text, right: text): text" },
    { name: "text_find", description: "Find the position of a substring.", detail: "text_find(value: text, search: text): number" },
    { name: "text_find_regex", description: "Find the position of a regular expression match." },
    { name: "text_extract", description: "Extract a substring by position and length.", detail: "text_extract(value: text, start: number, length: number): text" },
    { name: "text_replace", description: "Replace occurrences of a substring." },
    { name: "text_replace_regex", description: "Replace occurrences of a regular expression match." },
    { name: "text_trim", description: "Remove leading and trailing whitespace." },
    { name: "text_split", description: "Split text into an array by a separator." },
    { name: "text_to_bytestream", description: "Convert text to a bytestream." },
    { name: "bytestream_to_text", description: "Convert a bytestream to text.", detail: "bytestream_to_text(value: bytestream): text" },
    { name: "number_ceiling", description: "Round a number up.", detail: "number_ceiling(value: number): number" },
    { name: "number_floor", description: "Round a number down.", detail: "number_floor(value: number): number" },
    { name: "number_round", description: "Round a number to the nearest value.", detail: "number_round(value: number): number" },
    { name: "number_hex", description: "Convert a number to hexadecimal text." },
    { name: "number_mod", description: "Remainder of an integer division." },
    { name: "today", description: "Get the current date.", detail: "today(): date" },
    { name: "now", description: "Get the current date and time.", detail: "now(): datetime" },
    { name: "date", description: "Build or convert a date value." },
    { name: "time", description: "Build or convert a time value." },
    { name: "datetime", description: "Build or convert a datetime value." },
    { name: "year", description: "Extract the year from a date/datetime." },
    { name: "month", description: "Extract the month from a date/datetime." },
    { name: "day", description: "Extract the day from a date/datetime." },
    { name: "hour", description: "Extract the hour from a time/datetime." },
    { name: "minute", description: "Extract the minutes from a time/datetime." },
    { name: "second", description: "Extract the seconds from a time/datetime." },
    { name: "week_day", description: "Day of the week of a date." },
    { name: "nyears", description: "Number of years between two dates." },
    { name: "nmonths", description: "Number of months between two dates." },
    { name: "local_to_time_zone", description: "Convert a local datetime to a time zone." },
    { name: "time_zone_to_local", description: "Convert a datetime from a time zone to local." },
    { name: "format", description: "Format a value as text with placeholders.", detail: "format(template: text, ...args): text" },
    { name: "if", description: "Inline conditional expression.", detail: "if(condition: boolean, then: T, else: T): T" },
    { name: "size", description: "Number of elements of an array." },
    { name: "full_node_name", description: "Full name of the current node." },
    { name: "linked_exit_point", description: "Node linked to an exit point." },
    { name: "number_array", description: "Build an array of numbers." },
    { name: "text_array", description: "Build an array of texts." },
    { name: "boolean_array", description: "Build an array of booleans." },
    { name: "date_array", description: "Build an array of dates." },
    { name: "time_array", description: "Build an array of times." },
    { name: "datetime_array", description: "Build an array of datetimes." },
    { name: "build_sql_contains", description: "Build a SQL CONTAINS clause from search text." },
    { name: "file_create", description: "Create a file and return its handle." },
    { name: "file_open", description: "Open an existing file." },
    { name: "file_close", description: "Close an open file." },
    { name: "file_delete", description: "Delete a file." },
    { name: "file_exists", description: "Check whether a file exists." },
    { name: "file_datetime", description: "Get the modification datetime of a file." },
    { name: "file_split_path", description: "Split a path into components." },
    { name: "file_make_path", description: "Build a path from components." },
    { name: "file_seek", description: "Move the read/write position of a file." },
    { name: "file_read", description: "Read bytes from a file." },
    { name: "file_read_line", description: "Read a line from a file." },
    { name: "file_write", description: "Write bytes to a file." },
    { name: "file_write_line", description: "Write a line to a file." },
    { name: "file_copy", description: "Copy a file." },
    { name: "folder_system_path", description: "Get a system folder path." },
    { name: "tmp_filename", description: "Generate a temporary file name." },
    { name: "lookup", description: "Look up a value in a lookup file." },
    { name: "current_email_id", description: "Id of the email loaded in the email editor." },
    { name: "selected_cursor_line", description: "Line selected on a table element.", detail: "selected_cursor_line(tableName: text): number" },
    { name: "rgb_color", description: "Create a UI color from RGB values.", detail: "rgb_color(red: number, green: number, blue: number): color" },
    { name: "soft_phone_volume", description: "Current soft phone volume." },
    { name: "file_browser", description: "Open the file browser dialog on the agent desktop." },
    { name: "agent_info", description: "Information about an agent." },
    { name: "campaign_info", description: "Information about a campaign." },
    { name: "agents", description: "Server cursor with the agents." },
    { name: "campaigns", description: "Server cursor with the campaigns." },
    { name: "medias", description: "Server cursor with the medias." },
    { name: "time_zones", description: "Server cursor with the time zones." },
    { name: "skill_profiles", description: "Server cursor with the skill profiles." },
    { name: "outbound_rules", description: "Server cursor with the outbound rules." },
    { name: "last_called_agent", description: "Last agent that handled the contact." }
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

// Control schemas follow the Altitude 8.7 ASL Reference (Declarations /
// Graphical element declarations).
export const CONTROL_DEFINITIONS: AslControlDefinition[] = [
    {
        name: "push button",
        description: "Displays a button that invokes an event when the agent clicks it.",
        documentation: "Supports labels, optional images (with pressed/focused/disabled variants), and on click actions.",
        requiresTarget: undefined,
        properties: [...commonControlProperties, "default button", "flat", "tooltip", "background", "background color", "label", "image"],
        events: ["on click"]
    },
    {
        name: "text button",
        description: "Displays text that invokes an event when the agent clicks it. Unlike push buttons, it cannot show an image but can align its text.",
        properties: [...commonControlProperties, "default button", "tooltip", "background", "background color", "label", "align"],
        events: ["on click"]
    },
    {
        name: "check box",
        description: "Edits a destination variable with two values associated to check and uncheck.",
        requiresTarget: "variable",
        properties: [...commonControlProperties, "background", "background color", "label", "position", "align", "checked if", "unchecked if"],
        events: ["on click"]
    },
    {
        name: "radio button",
        description: "Edits a variable with a specific value; one of a set of buttons bound to the same variable.",
        requiresTarget: "variable",
        properties: [...commonControlProperties, "background", "background color", "label", "position", "align", "checked if"],
        events: ["on click"]
    },
    {
        name: "input",
        description: "Free-form input field bound to a destination variable.",
        requiresTarget: "variable",
        properties: [...commonControlProperties, "password", "uppercase", "multiline", "wordwrap", "align", "year completion", "format", "read only if", "background color", "font"],
        events: ["on lose focus"]
    },
    {
        name: "combo box",
        description: "Input field with an associated list of label/value pairs, from explicit items or a cursor.",
        requiresTarget: "variable",
        properties: [...commonControlProperties, "input field height", "year completion", "format", "items", "label", "cursor", "with", "values column", "labels column", "automatically fill values", "drop on demand", "allow other values", "uppercase", "sort", "align", "background color", "font"],
        events: ["on list selection", "on lose focus"]
    },
    {
        name: "menu",
        description: "Tree-like menu element for hierarchical choices, filled from items or a MenuItem array.",
        properties: [...commonControlProperties, "items", "items list", "item", "tag", "level", "formattings", "background color"],
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
        description: "Visual grouping box with optional border, label, and image.",
        properties: ["size", "at", "hidden if", "anchor", "border", "enhanced style", "background color", "label", "image"],
        events: []
    },
    {
        name: "container",
        description: "Displays reusable graphical blocks inside a node.",
        properties: ["size", "at", "hidden if", "anchor", "border", "background color", "initial block"],
        events: []
    },
    {
        name: "group",
        description: "Groups other graphical elements for convenience.",
        properties: ["size", "at", "hidden if", "anchor", "background color", "label"],
        events: []
    },
    {
        name: "chat control",
        description: "Embeds the agent chat surface in the node UI.",
        properties: [...commonControlProperties, "background", "background color", "read only if"],
        events: ["on event", "on instant message sent", "on save transcript complete"]
    },
    {
        name: "email editor",
        description: "Displays and edits inbound or outbound email content.",
        properties: [
            ...commonControlProperties,
            "media name",
            "background",
            "background color",
            "initial email id",
            "email toolbar hidden if",
            "knowledge base toolbar hidden if",
            "standard toolbar hidden if",
            "formatting toolbar hidden if",
            "table toolbar hidden if",
            "print hidden if",
            "add image hidden if",
            "add link hidden if",
            "spell check hidden if",
            "unavailable if",
            "from unavailable if",
            "to unavailable if",
            "cc unavailable if",
            "bcc unavailable if",
            "subject unavailable if",
            "attachments unavailable if",
            "read only if",
            "from read only if",
            "to read only if",
            "cc read only if",
            "bcc read only if",
            "subject read only if",
            "body read only if",
            "attachments read only if",
            "labels font",
            "inputs font"
        ],
        events: [
            "on event",
            "on email loaded",
            "on email sent",
            "on email suspended",
            "on email resumed",
            "on before message send",
            "on before attachment",
            "on before open message attachment",
            "on toolbar send click",
            "on toolbar reply click",
            "on toolbar reply all click",
            "on toolbar forward click"
        ]
    },
    {
        name: "web browser",
        description: "Embeds a browser surface inside the node UI.",
        properties: [...commonControlProperties, "background", "background color", "initial url", "persistent"],
        events: ["on event"]
    },
    {
        name: "table",
        description: "Displays a cursor as a table; clicking a row moves the cursor position.",
        requiresTarget: "cursor",
        properties: [...commonControlProperties, "background color", "font", "header background color", "header font", "columns", "column", "size", "hidden", "align", "format", "sortable", "tag", "header align"],
        events: ["on double click", "on selection change", "on sort request"]
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
        ...ACTION_KEYWORDS,
        ...BUSINESS_DATA_VARIABLES,
        ...SYSTEM_VARIABLES,
        ...BUILTIN_FUNCTIONS,
        ...CONTROL_DEFINITIONS
    ].find((entry) => normalizeAslName(entry.name) === normalized);
}