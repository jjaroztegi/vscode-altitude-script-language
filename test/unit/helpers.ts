import * as fs from "node:fs";
import * as path from "node:path";
import { Workspace, type Settings } from "../../src/language/workspace";

export const ROOT = "file:///c%3A/project/";

/** In-memory workspace: file names map to contents. */
export async function workspaceOf(files: Record<string, string>, settings: Settings = {}): Promise<Workspace> {
    const workspace = new Workspace({
        readFile: async (uri) => {
            const name = decodeURIComponent(uri.slice(uri.lastIndexOf("/") + 1));
            const match = Object.keys(files).find((f) => f.toLowerCase() === name.toLowerCase());
            return match !== undefined ? files[match] : undefined;
        },
        settings: () => settings
    });
    for (const [name, text] of Object.entries(files)) workspace.setDiskFile(ROOT + name, text);
    await workspace.prepareAll();
    return workspace;
}

export const uri = (name: string): string => ROOT + name;

export async function diagnose(files: Record<string, string>, name: string, settings?: Settings) {
    const workspace = await workspaceOf(files, settings);
    await workspace.prepare(uri(name));
    return workspace.diagnose(uri(name));
}

/** Codes of the diagnostics, for compact assertions. */
export async function codes(files: Record<string, string>, name: string, settings?: Settings): Promise<string[]> {
    return (await diagnose(files, name, settings)).map((d) => d.code).sort();
}

export function fixture(name: string): string {
    return fs.readFileSync(path.join(__dirname, "..", "fixtures", "project", name), "utf8");
}

export function fixtureProject(): Record<string, string> {
    return { "Orders.ags": fixture("Orders.ags"), "Popups.agm": fixture("Popups.agm"), "Utils.gem": fixture("Utils.gem") };
}

/** Wraps action statements in a minimal script with a node. */
export function script(body: string, declarations = ""): string {
    return `version "8.7"\n${declarations}\non start {\n\tgoto node 'MAIN'\n}\nnode "MAIN" {\n\tid 1\n${body}\n}\n`;
}

/** Offset of the n-th occurrence of `marker` (n starts at 0). */
export function offsetOf(text: string, marker: string, n = 0): number {
    let index = -1;
    for (let i = 0; i <= n; i += 1) {
        index = text.indexOf(marker, index + 1);
        if (index < 0) throw new Error(`marker not found: ${marker}`);
    }
    return index;
}
