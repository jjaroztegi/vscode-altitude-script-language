// Generates syntaxes/asl.tmLanguage.json from the language data, so highlighting stays in sync with the
// catalogue of actions, built-in functions, graphical elements and enumerations.
//   node scripts/generate-grammar.mjs
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const data = (name) => JSON.parse(fs.readFileSync(path.join(root, "src/language/data", name), "utf8"));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (list) => [...new Set(list)].sort((a, b) => b.length - a.length).map((w) => escape(w).replace(/ /g, "\\s+")).join("|");

const actions = data("actions.json");
const functions = data("functions.json").map((f) => f.name);
const controls = data("controls.json").map((c) => c.name);
const enums = data("enums.json").map((e) => e.name);

// Leading keywords of every action (the words before the first placeholder).
const actionPhrases = new Set(["dim", "add", "remove", "message", "write", "write log", "end script", "abort script", "discard script", "restart script", "clear error", "break loop", "back node", "return node", "exit through", "set timer", "trigger event", "kill timer", "handle pending events", "call master event handler", "open window", "close window"]);
for (const action of actions) {
    for (const syntax of action.syntax) {
        const lead = [];
        for (const word of syntax.split(/\s+/)) {
            if (!/^[a-z][a-z_]*$/.test(word)) break;
            lead.push(word);
        }
        if (lead.length) actionPhrases.add(lead.join(" "));
    }
}
for (const control of ["graphical element", "input", "container", "web browser", "email editor", "chat control", "menu", "table"]) actionPhrases.delete(control);

const grammar = {
    $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
    name: "Altitude ASL",
    scopeName: "source.altitude-asl",
    patterns: [{ include: "#trailer" }, { include: "#declarations" }, { include: "#statements" }],
    repository: {
        trailer: {
            comment: "Script Developer appends XML metadata after the last declaration.",
            begin: "^(?=<\\?xml)",
            end: "(?!\\G)\\z",
            name: "meta.embedded.block.xml",
            patterns: [{ include: "text.xml" }]
        },
        comments: {
            patterns: [
                {
                    name: "comment.block.altitude-asl",
                    begin: "\\b(comment)\\s*(\\{)",
                    beginCaptures: { 1: { name: "keyword.other.comment.altitude-asl" }, 2: { name: "punctuation.definition.comment.begin.altitude-asl" } },
                    end: "\\}",
                    endCaptures: { 0: { name: "punctuation.definition.comment.end.altitude-asl" } },
                    patterns: [{ include: "#comment-braces" }]
                },
                {
                    name: "comment.line.altitude-asl",
                    match: "\\b(comment)\\s+(\"[^\"]*\"|'(?:[^'\\\\]|\\\\.)*')",
                    captures: { 1: { name: "keyword.other.comment.altitude-asl" } }
                }
            ]
        },
        "comment-braces": { begin: "\\{", end: "\\}", patterns: [{ include: "#comment-braces" }] },
        declarations: {
            patterns: [
                { include: "#comments" },
                {
                    match: "\\b(private\\s+)?(node|block)\\s+(\"[^\"]*\"|'[^']*')",
                    captures: { 1: { name: "storage.modifier.altitude-asl" }, 2: { name: "storage.type.node.altitude-asl" }, 3: { name: "entity.name.type.node.altitude-asl" } }
                },
                {
                    match: "\\b(private\\s+)?(external\\s+(?:session\\s+)?(?:stdcall\\s+|cdecl\\s+)?)?(subroutine|function)\\s+([\\p{L}_][\\p{L}\\p{N}_]*)",
                    captures: { 1: { name: "storage.modifier.altitude-asl" }, 2: { name: "storage.modifier.altitude-asl" }, 3: { name: "storage.type.function.altitude-asl" }, 4: { name: "entity.name.function.altitude-asl" } }
                },
                {
                    match: "\\b(on)\\s+(event|error|progress)\\s+((?:[\\p{L}_][\\p{L}\\p{N}_]*)(?:[ \\t]+[\\p{L}_][\\p{L}\\p{N}_]*)*)",
                    captures: { 1: { name: "keyword.other.handler.altitude-asl" }, 2: { name: "keyword.other.handler.altitude-asl" }, 3: { name: "entity.name.function.event.altitude-asl" } }
                },
                {
                    match: "\\b(on)\\s+(start|end|load|unload|first\\s+enter|enter|exit)\\b",
                    captures: { 1: { name: "keyword.other.handler.altitude-asl" }, 2: { name: "keyword.other.handler.altitude-asl" } }
                },
                {
                    match: "\\b(on)\\s+((?:[a-z]+\\s+)*?[a-z]+)(?=\\s*(?:\\(|\\{|commit\\b|rollback\\b|ignore\\b|$))",
                    captures: { 1: { name: "keyword.other.handler.altitude-asl" }, 2: { name: "entity.name.function.event.altitude-asl" } }
                },
                {
                    match: "\\b(import)\\s+(<\"[^\"]*\">|\"[^\"]*\")(?:\\s+(into\\s+namespace)\\s+([\\p{L}_][\\p{L}\\p{N}_]*))?",
                    captures: { 1: { name: "keyword.control.import.altitude-asl" }, 2: { name: "string.quoted.other.path.altitude-asl" }, 3: { name: "keyword.control.import.altitude-asl" }, 4: { name: "entity.name.namespace.altitude-asl" } }
                },
                {
                    name: "storage.type.section.altitude-asl",
                    match: "\\b(?:modules|dependencies|constants|types|variables|parameters|cursors|using\\s+namespaces|campaign\\s+record|contact\\s+record|workflow\\s+record|transferred\\s+record|outcome\\s+record|contact\\s+profile\\s+extensions|audio)(?=\\s*\\{)"
                },
                {
                    name: "keyword.other.declaration.altitude-asl",
                    match: "\\b(?:version|file\\s+version|default\\s+font|default\\s+master|without\\s+master|master|exit\\s+point|node\\s+loop|function\\s+key|flow\\s+view|year\\s+completion|(?:date|time|datetime|number)\\s+format|exclude\\s+from\\s+zip|in\\s+file|in\\s+url|of\\s+type|dll\\s+(?:native|managed)|web\\s+service|private|ref|out|record|enumeration|defined\\s+in|array(?:\\s+\\[[^\\]]*\\])?\\s+of|sql\\s+for|file\\s+for|memory\\s+for|enumeration\\s+for|system\\s+for|delimiter|columns|filter|order\\s+by|input|required|check|on\\s+error\\s+show|named|compiler|export\\s+ordinal|as)\\b"
                },
                { name: "entity.name.tag.element.altitude-asl", match: `\\b(?:${words(controls)})\\b(?=\\s*(?:"|'|\\{|for\\b))` },
                { include: "#statements" }
            ]
        },
        statements: {
            patterns: [
                { include: "#comments" },
                { include: "#strings" },
                {
                    name: "keyword.control.altitude-asl",
                    match: "\\b(?:if|then|else|case|when|do|default|while|repeat|until|for|to|step|break\\s+loop|return\\s+node|return|goto\\s+node|call\\s+node|back\\s+node|exit\\s+through|call)\\b"
                },
                { name: "keyword.other.var.altitude-asl", match: "\\b(?:var|const)\\b" },
                { name: "keyword.operator.word.altitude-asl", match: "\\b(?:and|or|xor|not|new)\\b" },
                { name: "constant.language.altitude-asl", match: "\\b(?:true|false|null|NULL)\\b" },
                { name: "storage.type.primitive.altitude-asl", match: "\\b(?:boolean|number|text|date|time|datetime|bytestream)\\b(?!\\s*\\()" },
                { name: "keyword.other.action.altitude-asl", match: `\\b(?:${words([...actionPhrases])})\\b` },
                {
                    match: "\\b(graphical\\s+element|input|container|web\\s+browser|email\\s+editor|chat\\s+control|menu|table)\\s+(?=['\"]|[\\p{L}_])(?!for\\b|\\{)",
                    captures: { 1: { name: "entity.name.tag.element.altitude-asl" } }
                },
                { name: "keyword.other.modifier.altitude-asl", match: "\\b(?:commit|rollback|ignore|overlay|caption|arguments|into|variable|match\\s+by\\s+name|absolute|relative|at|size|with|trigger\\s+event|on\\s+close|values|attribute)\\b" },
                { include: "#expressions" }
            ]
        },
        expressions: {
            patterns: [
                { include: "#strings" },
                { name: "variable.language.attribute.altitude-asl", match: "@[\\p{L}_][\\p{L}\\p{N}_]*" },
                { name: "constant.numeric.altitude-asl", match: "(?<![\\p{L}\\p{N}_])(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?![\\p{L}\\p{N}_])" },
                { name: "support.class.enum.altitude-asl", match: `\\b(?:${words(enums)})(?=::)` },
                {
                    match: "\\b([\\p{L}_][\\p{L}\\p{N}_]*)(::)",
                    captures: { 1: { name: "entity.name.namespace.altitude-asl" }, 2: { name: "punctuation.separator.namespace.altitude-asl" } }
                },
                { name: "support.function.builtin.altitude-asl", match: `\\b(?:${words(functions)})(?=\\s*\\()` },
                { name: "variable.language.business.altitude-asl", match: "\\b(?:campaign|contact|workflow|transferred|outcomes|contact_profile)\\b(?=\\s*[.\\[])" },
                {
                    match: "\\b([\\p{L}_][\\p{L}\\p{N}_]*)(?=\\s*\\()",
                    captures: { 1: { name: "entity.name.function.call.altitude-asl" } }
                },
                { name: "keyword.operator.assignment.altitude-asl", match: ":=" },
                { name: "keyword.operator.comparison.altitude-asl", match: "<>|<=|>=|=|<|>" },
                { name: "keyword.operator.arithmetic.altitude-asl", match: "[+\\-*/]" },
                { name: "punctuation.separator.altitude-asl", match: "[,?]" },
                { name: "punctuation.accessor.altitude-asl", match: "\\." },
                { begin: "\\(", end: "\\)", beginCaptures: { 0: { name: "punctuation.parenthesis.begin.altitude-asl" } }, endCaptures: { 0: { name: "punctuation.parenthesis.end.altitude-asl" } }, patterns: [{ include: "#expressions" }] }
            ]
        },
        strings: {
            patterns: [
                {
                    name: "string.quoted.other.path.altitude-asl",
                    begin: "<\"",
                    end: "\">",
                    beginCaptures: { 0: { name: "punctuation.definition.string.begin.altitude-asl" } },
                    endCaptures: { 0: { name: "punctuation.definition.string.end.altitude-asl" } }
                },
                {
                    name: "string.quoted.double.altitude-asl",
                    begin: "\"",
                    end: "\"|$",
                    beginCaptures: { 0: { name: "punctuation.definition.string.begin.altitude-asl" } },
                    endCaptures: { 0: { name: "punctuation.definition.string.end.altitude-asl" } },
                    patterns: [{ name: "constant.character.escape.altitude-asl", match: "\\\\." }]
                },
                {
                    comment: "Text that starts with a SQL verb: highlight SQL keywords and interpolations.",
                    name: "string.quoted.single.sql.altitude-asl",
                    begin: "'(?=\\s*(?i:select|insert|update|delete|exec|execute|with|merge)\\b)",
                    end: "'|$",
                    beginCaptures: { 0: { name: "punctuation.definition.string.begin.altitude-asl" } },
                    endCaptures: { 0: { name: "punctuation.definition.string.end.altitude-asl" } },
                    patterns: [{ include: "#fib-content" }, { include: "#sql-keywords" }]
                },
                {
                    name: "string.quoted.single.altitude-asl",
                    begin: "'",
                    end: "'|$",
                    beginCaptures: { 0: { name: "punctuation.definition.string.begin.altitude-asl" } },
                    endCaptures: { 0: { name: "punctuation.definition.string.end.altitude-asl" } },
                    patterns: [{ include: "#fib-content" }]
                }
            ]
        },
        "fib-content": {
            patterns: [
                { name: "constant.character.escape.altitude-asl", match: "\\\\." },
                {
                    name: "meta.interpolation.altitude-asl",
                    begin: "([$%])(\\()",
                    end: "\\)",
                    beginCaptures: { 1: { name: "punctuation.section.interpolation.begin.altitude-asl" }, 2: { name: "punctuation.section.interpolation.begin.altitude-asl" } },
                    endCaptures: { 0: { name: "punctuation.section.interpolation.end.altitude-asl" } },
                    contentName: "source.altitude-asl.embedded",
                    patterns: [{ include: "#expressions" }]
                }
            ]
        },
        "sql-keywords": {
            patterns: [
                {
                    name: "keyword.other.sql.altitude-asl",
                    match: "(?i)\\b(?:select|from|where|insert|into|values|update|set|delete|join|inner|left|right|outer|on|and|or|not|in|is|null|like|between|group|by|order|having|distinct|top|as|case|when|then|else|end|exec|execute|union|all|exists|with|nolock|asc|desc|count|sum|avg|min|max|convert|cast|isnull|coalesce|getdate)\\b"
                }
            ]
        }
    }
};

fs.writeFileSync(path.join(root, "syntaxes/asl.tmLanguage.json"), JSON.stringify(grammar, null, 4) + "\n");
console.log(`grammar: ${actionPhrases.size} action phrases, ${functions.length} functions, ${controls.length} elements, ${enums.length} enumerations`);
