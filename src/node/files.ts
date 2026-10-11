/**
 * File-system helpers shared by the command-line checker, the standalone language server and the corpus script.
 * Node only: `src/language` stays free of file-system access so it also runs in the browser.
 */
import { readdirSync } from "node:fs";
import * as path from "node:path";
import { isAslUri } from "../language/workspace";

/** ASL files under a folder (case-insensitive extensions), skipping `.git`, `node_modules` and `*_port_*` files. */
export function findAslFiles(root: string): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== ".git" && entry.name !== "node_modules") walk(full);
            } else if (isAslUri(entry.name) && !/_port_/i.test(entry.name)) {
                files.push(full);
            }
        }
    };
    walk(root);
    return files;
}

/** Decodes file bytes as the editor does: UTF-8 without the BOM. */
export function decodeText(bytes: Uint8Array): string {
    return new TextDecoder("utf-8").decode(bytes);
}
