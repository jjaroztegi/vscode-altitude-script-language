/**
 * Returns the file as UTF-8 with BOM and CRLF, or undefined when it already is.
 * Files that are not valid UTF-8 (for example ANSI/Windows-1252 exports) are left alone.
 */
export function normalizeBytes(bytes: Uint8Array): Uint8Array | undefined {
    const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(hasBom ? bytes.subarray(3) : bytes);
    } catch {
        return undefined;
    }
    const crlf = text.replace(/\r\n|\r|\n/g, "\r\n");
    if (hasBom && crlf === text) return undefined;
    const body = new TextEncoder().encode(crlf);
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
}
