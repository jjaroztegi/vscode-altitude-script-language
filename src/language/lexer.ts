/**
 * ASL lexer.
 *
 * Lexical rules (Altitude 8.7, "Values and operations"):
 * - "..." strings recognise \t \n \r \\ and ignore a backslash before any other character.
 * - '...' is a fill-in-the-blanks (FIB) literal; $(expr) and %(expr) interpolate expressions.
 * - <"..."> is a string literal, used mostly for file paths.
 * - Adjacent literals concatenate ('a' '$(b)' == 'a$(b)'), so a statement can continue on the next line.
 * - The only comment forms are `comment { ... }` and the action `comment STRING`.
 * - Script Developer appends an `<?xml ...` metadata trailer after the last declaration.
 */

export const TokenKind = {
    Identifier: 0,
    AtIdentifier: 1,
    Number: 2,
    String: 3,
    Fib: 4,
    Punct: 5,
    Unknown: 6,
    EOF: 7
} as const;
export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

export interface FibPart {
    /** Offsets of the expression between the parentheses of $(...) or %(...). */
    start: number;
    end: number;
}

export interface Token {
    kind: TokenKind;
    /** Raw source text. */
    text: string;
    start: number;
    end: number;
    /** A line break separates this token from the previous one. */
    lineBreakBefore: boolean;
    /** Lowercased text of identifiers and punctuation, for keyword matching. */
    lower: string;
    /** Decoded value of String tokens and the raw body of Fib tokens. */
    value?: string;
    /** Interpolated expressions of a Fib token. */
    parts?: FibPart[];
    /** Token was written as <"..."> (a path literal). */
    path?: boolean;
}

export interface CommentTrivia {
    start: number;
    end: number;
    /** Comment body without the `comment {` / `}` delimiters. */
    text: string;
}

export interface LexError {
    start: number;
    end: number;
    message: string;
}

export interface LexResult {
    tokens: Token[];
    comments: CommentTrivia[];
    errors: LexError[];
    /** Offset of the Script Developer XML trailer, if present. */
    trailerStart?: number;
}

const PUNCTUATION = [":=", "::", "<>", "<=", ">=", "{", "}", "(", ")", "[", "]", ",", ".", ":", "=", "<", ">", "+", "-", "*", "/", "?", "!", ";", "&", "|"];

const isIdentifierStart = (ch: string): boolean => /[\p{L}_]/u.test(ch);
const isIdentifierPart = (ch: string): boolean => /[\p{L}\p{N}_]/u.test(ch);
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";

export function lex(text: string): LexResult {
    const tokens: Token[] = [];
    const comments: CommentTrivia[] = [];
    const errors: LexError[] = [];
    let trailerStart: number | undefined;
    let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    let lineBreak = true;
    let lineStart = true;

    const push = (kind: TokenKind, start: number, end: number, extra?: Partial<Token>): void => {
        const raw = text.slice(start, end);
        tokens.push({ kind, text: raw, start, end, lineBreakBefore: lineBreak, lower: raw.toLowerCase(), ...extra });
        lineBreak = false;
        lineStart = false;
    };

    while (pos < text.length) {
        const ch = text[pos];

        if (ch === "\n") {
            pos += 1;
            lineBreak = true;
            lineStart = true;
            continue;
        }
        if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v" || ch === " ") {
            pos += 1;
            continue;
        }

        if (lineStart && text.startsWith("<?xml", pos)) {
            trailerStart = pos;
            break;
        }

        if (isIdentifierStart(ch)) {
            let end = pos + 1;
            while (end < text.length && isIdentifierPart(text[end])) {
                end += 1;
            }
            if (end - pos === 7 && text.slice(pos, end).toLowerCase() === "comment") {
                const comment = scanComment(text, end);
                if (comment) {
                    comments.push({ start: pos, end: comment.end, text: comment.body });
                    if (comment.unterminated) {
                        errors.push({ start: pos, end: end, message: "Unterminated comment block." });
                    }
                    pos = comment.end;
                    lineStart = false;
                    continue;
                }
            }
            push(TokenKind.Identifier, pos, end);
            pos = end;
            continue;
        }

        if (ch === "@" && pos + 1 < text.length && isIdentifierStart(text[pos + 1])) {
            let end = pos + 2;
            while (end < text.length && isIdentifierPart(text[end])) {
                end += 1;
            }
            push(TokenKind.AtIdentifier, pos, end);
            pos = end;
            continue;
        }

        if (isDigit(ch) || (ch === "." && isDigit(text[pos + 1]) && !isAfterValue(tokens, lineBreak))) {
            let end = pos;
            while (isDigit(text[end])) {
                end += 1;
            }
            if (text[end] === "." && isDigit(text[end + 1])) {
                end += 1;
                while (isDigit(text[end])) {
                    end += 1;
                }
            }
            push(TokenKind.Number, pos, end);
            pos = end;
            continue;
        }

        if (ch === '"' || (ch === "<" && text[pos + 1] === '"')) {
            const scanned = scanString(text, pos);
            if (scanned.error) {
                errors.push({ start: pos, end: scanned.end, message: scanned.error });
            }
            push(TokenKind.String, pos, scanned.end, { value: scanned.value, path: ch === "<" });
            pos = scanned.end;
            continue;
        }

        if (ch === "'") {
            const scanned = scanFib(text, pos);
            if (scanned.error) {
                errors.push({ start: pos, end: scanned.end, message: scanned.error });
            }
            push(TokenKind.Fib, pos, scanned.end, { value: text.slice(pos + 1, scanned.closed ? scanned.end - 1 : scanned.end), parts: scanned.parts });
            pos = scanned.end;
            continue;
        }

        const punct = PUNCTUATION.find((candidate) => text.startsWith(candidate, pos));
        if (punct) {
            push(TokenKind.Punct, pos, pos + punct.length);
            pos += punct.length;
            continue;
        }

        errors.push({ start: pos, end: pos + 1, message: `Unexpected character '${ch}'.` });
        push(TokenKind.Unknown, pos, pos + 1);
        pos += 1;
    }

    const eofAt = trailerStart ?? text.length;
    tokens.push({ kind: TokenKind.EOF, text: "", start: eofAt, end: eofAt, lineBreakBefore: true, lower: "" });
    return { tokens, comments, errors, trailerStart };
}

/** `.5` is a number only where a value can start, not after an identifier (`a.b`). */
function isAfterValue(tokens: Token[], lineBreak: boolean): boolean {
    const previous = tokens[tokens.length - 1];
    if (!previous || lineBreak) {
        return false;
    }
    return previous.kind === TokenKind.Identifier || previous.kind === TokenKind.AtIdentifier || previous.text === ")" || previous.text === "]";
}

/** Recognises `comment {...}` (balanced braces) and `comment "..."` / `comment '...'` after the keyword. */
function scanComment(text: string, afterKeyword: number): { end: number; body: string; unterminated?: boolean } | undefined {
    let pos = afterKeyword;
    while (pos < text.length && /[ \t\r\n]/.test(text[pos])) {
        pos += 1;
    }
    const ch = text[pos];
    if (ch === "{") {
        let depth = 0;
        for (let index = pos; index < text.length; index += 1) {
            if (text[index] === "{") {
                depth += 1;
            } else if (text[index] === "}") {
                depth -= 1;
                if (depth === 0) {
                    return { end: index + 1, body: text.slice(pos + 1, index) };
                }
            }
        }
        return { end: text.length, body: text.slice(pos + 1), unterminated: true };
    }
    if (ch === '"') {
        const scanned = scanString(text, pos);
        return { end: scanned.end, body: scanned.value };
    }
    if (ch === "'") {
        const scanned = scanFib(text, pos);
        return { end: scanned.end, body: text.slice(pos + 1, scanned.closed ? scanned.end - 1 : scanned.end) };
    }
    return undefined;
}

function scanString(text: string, start: number): { end: number; value: string; error?: string } {
    const isPath = text[start] === "<";
    let pos = start + (isPath ? 2 : 1);
    let value = "";
    while (pos < text.length) {
        const ch = text[pos];
        if (ch === "\n") {
            return { end: pos, value, error: "Unterminated string literal." };
        }
        if (ch === '"' && (!isPath || text[pos + 1] === ">")) {
            return { end: pos + (isPath ? 2 : 1), value };
        }
        if (ch === "\\" && !isPath && pos + 1 < text.length && text[pos + 1] !== "\n") {
            const next = text[pos + 1];
            value += next === "t" ? "\t" : next === "n" ? "\n" : next === "r" ? "\r" : next;
            pos += 2;
            continue;
        }
        value += ch;
        pos += 1;
    }
    return { end: pos, value, error: "Unterminated string literal." };
}

function scanFib(text: string, start: number): { end: number; parts: FibPart[]; closed: boolean; error?: string } {
    const parts: FibPart[] = [];
    let pos = start + 1;
    while (pos < text.length) {
        const ch = text[pos];
        if (ch === "\n") {
            return { end: pos, parts, closed: false, error: "Unterminated text literal." };
        }
        if (ch === "\\" && pos + 1 < text.length && text[pos + 1] !== "\n") {
            pos += 2;
            continue;
        }
        if (ch === "'") {
            return { end: pos + 1, parts, closed: true };
        }
        if ((ch === "$" || ch === "%") && text[pos + 1] === "(") {
            const exprStart = pos + 2;
            const exprEnd = scanInterpolation(text, exprStart);
            parts.push({ start: exprStart, end: exprEnd });
            pos = exprEnd < text.length && text[exprEnd] === ")" ? exprEnd + 1 : exprEnd;
            continue;
        }
        pos += 1;
    }
    return { end: pos, parts, closed: false, error: "Unterminated text literal." };
}

/** Returns the offset of the `)` closing an interpolation, skipping nested parentheses and literals. */
function scanInterpolation(text: string, start: number): number {
    let depth = 0;
    let pos = start;
    while (pos < text.length) {
        const ch = text[pos];
        if (ch === "\n") {
            return pos;
        }
        if (ch === '"') {
            pos = scanString(text, pos).end;
            continue;
        }
        if (ch === "'") {
            const nested = scanFib(text, pos);
            pos = nested.end;
            continue;
        }
        if (ch === "(") {
            depth += 1;
        } else if (ch === ")") {
            if (depth === 0) {
                return pos;
            }
            depth -= 1;
        }
        pos += 1;
    }
    return pos;
}

/** Maps offsets to zero-based line/character positions. */
export class LineMap {
    private readonly lineStarts: number[] = [0];

    constructor(readonly text: string) {
        for (let index = 0; index < text.length; index += 1) {
            if (text.charCodeAt(index) === 10) {
                this.lineStarts.push(index + 1);
            }
        }
    }

    get lineCount(): number {
        return this.lineStarts.length;
    }

    positionAt(offset: number): { line: number; character: number } {
        let low = 0;
        let high = this.lineStarts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (this.lineStarts[mid] <= offset) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return { line: low, character: offset - this.lineStarts[low] };
    }

    offsetAt(position: { line: number; character: number }): number {
        if (position.line >= this.lineStarts.length) {
            return this.text.length;
        }
        const lineStart = this.lineStarts[Math.max(position.line, 0)];
        const nextLineStart = position.line + 1 < this.lineStarts.length ? this.lineStarts[position.line + 1] : this.text.length;
        return Math.min(lineStart + Math.max(position.character, 0), nextLineStart);
    }

    lineStart(line: number): number {
        return this.lineStarts[Math.min(Math.max(line, 0), this.lineStarts.length - 1)];
    }

    lineText(line: number): string {
        const start = this.lineStart(line);
        const end = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] : this.text.length;
        return this.text.slice(start, end).replace(/\r?\n$/, "");
    }
}
