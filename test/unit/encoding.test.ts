import { describe, expect, it } from "vitest";
import { normalizeBytes } from "../../src/language/encoding";

const bytes = (text: string, bom = false): Uint8Array => {
    const body = new TextEncoder().encode(text);
    return bom ? new Uint8Array([0xef, 0xbb, 0xbf, ...body]) : body;
};

describe("normalizeBytes", () => {
    it("adds the BOM and converts LF and lone CR to CRLF", () => {
        expect(normalizeBytes(bytes("a\nb\rc\r\nñ"))).toEqual(bytes("a\r\nb\r\nc\r\nñ", true));
    });

    it("leaves files that are already UTF-8 with BOM and CRLF alone", () => {
        expect(normalizeBytes(bytes("a\r\nb", true))).toBeUndefined();
    });

    it("does not touch files that are not valid UTF-8", () => {
        expect(normalizeBytes(new Uint8Array([0x61, 0xf1, 0x0a]))).toBeUndefined();
    });
});
