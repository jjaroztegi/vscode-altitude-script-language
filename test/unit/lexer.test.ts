import { describe, expect, it } from "vitest";
import { lex, LineMap, TokenKind } from "../../src/language/lexer";

const kinds = (text: string) => lex(text).tokens.slice(0, -1).map((t) => [t.kind, t.text]);

describe("lexer", () => {
    it("reads identifiers, numbers, attributes and punctuation", () => {
        expect(kinds("vTotal := @phone_info.state + 1.5")).toEqual([
            [TokenKind.Identifier, "vTotal"],
            [TokenKind.Punct, ":="],
            [TokenKind.AtIdentifier, "@phone_info"],
            [TokenKind.Punct, "."],
            [TokenKind.Identifier, "state"],
            [TokenKind.Punct, "+"],
            [TokenKind.Number, "1.5"]
        ]);
    });

    it("accepts accented identifiers", () => {
        expect(kinds("año_niño")).toEqual([[TokenKind.Identifier, "año_niño"]]);
    });

    it("decodes double-quoted strings and keeps path literals raw", () => {
        const { tokens } = lex('"a\\tb\\"c" <"img\\logo.png">');
        expect(tokens[0].value).toBe('a\tb"c');
        expect(tokens[1].value).toBe("img\\logo.png");
        expect(tokens[1].path).toBe(true);
    });

    it("finds interpolations in fill-in-the-blanks text, with escaped quotes and nested strings", () => {
        const text = `'WHERE name = \\'$(vName)\\' AND $(if(x < y, "a", 'b'))'`;
        const { tokens, errors } = lex(text);
        expect(errors).toEqual([]);
        expect(tokens[0].kind).toBe(TokenKind.Fib);
        expect(tokens[0].parts?.map((p) => text.slice(p.start, p.end))).toEqual(["vName", `if(x < y, "a", 'b')`]);
    });

    it("treats comment blocks with nested braces as trivia", () => {
        const { tokens, comments } = lex("x := 1 comment { a {nested} b } y := 2");
        expect(comments).toHaveLength(1);
        expect(comments[0].text).toBe(" a {nested} b ");
        expect(tokens.map((t) => t.text)).toEqual(["x", ":=", "1", "y", ":=", "2", ""]);
    });

    it("stops at the Script Developer XML trailer", () => {
        const { tokens, trailerStart } = lex('node "A" {}\n<?xml version="1.0"?>\n<asl_meta_data />');
        expect(trailerStart).toBeGreaterThan(0);
        expect(tokens.map((t) => t.text)).toEqual(["node", '"A"', "{", "}", ""]);
    });

    it("reports unterminated strings", () => {
        expect(lex("x := 'open\ny := 1").errors[0].message).toMatch(/Unterminated/);
    });

    it("skips the byte order mark", () => {
        expect(lex("﻿version").tokens[0].start).toBe(1);
    });

    it("maps offsets to positions", () => {
        const map = new LineMap("a\r\nbc\nd");
        expect(map.positionAt(4)).toEqual({ line: 1, character: 1 });
        expect(map.offsetAt({ line: 2, character: 0 })).toBe(6);
        expect(map.lineText(0)).toBe("a");
    });
});
