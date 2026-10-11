/**
 * Compiles the syntax notation used by the ASL reference into match patterns.
 *
 * Notation (as in the docs): lowercase words are keywords, capitalised words are placeholders
 * (`Text`, `Integer`, `TextVAR`, `ID`, `STRING`...), UPPER-CASE words are nonterminals defined
 * elsewhere (`TARGET`, `FONT`...), `[x]` is optional, `a | b` alternatives, `x,...` a comma
 * separated list, `x...` / `[x]*` repetition and `{ ACTION* }` a block of actions.
 */

export type SlotClass = "expr" | "var" | "id" | "actions";

export type Pattern =
    | { t: "lit"; word: string }
    | { t: "slot"; placeholder: string; cls: SlotClass }
    | { t: "seq"; items: Pattern[] }
    | { t: "opt"; item: Pattern }
    | { t: "alt"; items: Pattern[] }
    | { t: "rep"; item: Pattern; sep?: string }
    | { t: "ref"; name: string }
    | { t: "brace"; item: Pattern };

const TOKEN = /ACTION\*|[A-Z][A-Z]+\*|,\.\.\.|\.\.\.|\[|\]|\||\{|\}|\(|\)|,|:=|\*|'[^']*'|[A-Za-z_][\w-]*(?:::[A-Za-z_]\w*)*|\S/g;

export function compileTemplate(source: string): Pattern {
    const tokens = source.match(TOKEN) ?? [];
    let pos = 0;

    const parseAlt = (closers: string[]): Pattern => {
        const alternatives: Pattern[] = [];
        let current: Pattern[] = [];
        while (pos < tokens.length && !closers.includes(tokens[pos])) {
            if (tokens[pos] === "|") {
                pos += 1;
                if (current.length > 0) {
                    alternatives.push(seq(current));
                }
                current = [];
                continue;
            }
            current.push(parsePostfix(closers));
        }
        if (current.length > 0) {
            alternatives.push(seq(current));
        }
        return alternatives.length === 1 ? alternatives[0] : { t: "alt", items: alternatives };
    };

    const parsePostfix = (closers: string[]): Pattern => {
        let atom = parseAtom(closers);
        while (pos < tokens.length) {
            const token = tokens[pos];
            if (token === "...") {
                pos += 1;
                atom = { t: "rep", item: atom };
            } else if (token === ",...") {
                pos += 1;
                atom = { t: "rep", item: atom, sep: "," };
            } else if (token === "*" && atom.t === "opt") {
                pos += 1;
                atom = { t: "opt", item: { t: "rep", item: atom.item } };
            } else {
                break;
            }
        }
        return atom;
    };

    const parseAtom = (closers: string[]): Pattern => {
        const token = tokens[pos++];
        if (token === "[") {
            const inner = parseAlt(["]"]);
            pos += 1;
            return { t: "opt", item: inner };
        }
        if (token === "{") {
            if (tokens[pos] === "ACTION*") {
                pos += 1;
                if (tokens[pos] === "}") {
                    pos += 1;
                }
                return { t: "slot", placeholder: "ACTION*", cls: "actions" };
            }
            const inner = pos < tokens.length && tokens[pos] !== "}" ? parseAlt(["}"]) : seq([]);
            pos += 1;
            return { t: "brace", item: inner };
        }
        if (/^[A-Z][A-Z]+\*$/.test(token)) {
            return { t: "rep", item: { t: "ref", name: token.slice(0, -1) } };
        }
        if (token.startsWith("'")) {
            return { t: "lit", word: token.toLowerCase() };
        }
        if (/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(token) && token.length > 1 && !["ID", "VAR", "STRING", "INT"].includes(token)) {
            return { t: "ref", name: token };
        }
        if (/^[A-Z]/.test(token) && !token.includes("::")) {
            return { t: "slot", placeholder: token, cls: classify(token) };
        }
        void closers;
        return { t: "lit", word: token.toLowerCase() };
    };

    const result = parseAlt([]);
    return result;
}

function seq(items: Pattern[]): Pattern {
    return items.length === 1 ? items[0] : { t: "seq", items };
}

function classify(placeholder: string): SlotClass {
    if (placeholder === "ID") {
        return "id";
    }
    if (placeholder.endsWith("VAR")) {
        return "var";
    }
    return "expr";
}

/** Keywords a pattern can consume, used to stop expressions and to offer completions. */
export function collectKeywords(pattern: Pattern, defs: (name: string) => Pattern | undefined, into = new Set<string>(), seen = new Set<string>()): Set<string> {
    switch (pattern.t) {
        case "lit":
            if (/^[a-z]/.test(pattern.word)) {
                into.add(pattern.word);
            }
            break;
        case "seq":
        case "alt":
            pattern.items.forEach((item) => collectKeywords(item, defs, into, seen));
            break;
        case "opt":
        case "rep":
        case "brace":
            collectKeywords(pattern.item, defs, into, seen);
            break;
        case "ref":
            if (!seen.has(pattern.name)) {
                seen.add(pattern.name);
                const def = defs(pattern.name);
                if (def) {
                    collectKeywords(def, defs, into, seen);
                }
            }
            break;
        case "slot":
            break;
    }
    return into;
}

/** Leading keyword words of a pattern (the words that must appear first). */
export function leadingWords(pattern: Pattern): string[] {
    const words: string[] = [];
    const items = pattern.t === "seq" ? pattern.items : [pattern];
    for (const item of items) {
        if (item.t !== "lit") {
            break;
        }
        words.push(item.word);
    }
    return words;
}

/** Renders a pattern back to readable syntax for hovers and completion details. */
export function renderTemplate(source: string): string {
    return source.replace(/\s+/g, " ").trim();
}
