import * as path from "path";
import { AslAnalysis } from "./aslParser";

export interface ModuleGraph {
    /** Lowercased namespace of a direct import → module analysis. */
    direct: Map<string, AslAnalysis>;
    /** Every reachable module analysis, transitively, deduplicated. */
    all: AslAnalysis[];
    /** False when any reachable module file could not be loaded. */
    fullyLoaded: boolean;
}

/**
 * Walks the import graph of a script (`modules { import <"X.agm"> into
 * namespace NS }`), loading each module at most once. Module loading is
 * injected so the extension can prefer open editors while tests read from disk.
 */
export function resolveModuleGraph(
    scriptFsPath: string,
    scriptAnalysis: AslAnalysis,
    loadModule: (fsPath: string) => AslAnalysis | undefined
): ModuleGraph {
    const direct = new Map<string, AslAnalysis>();
    const all: AslAnalysis[] = [];
    const loadedByKey = new Map<string, AslAnalysis | undefined>();
    let fullyLoaded = true;

    const queue: Array<{ dir: string; analysis: AslAnalysis; isDirect: boolean }> = [
        { dir: path.dirname(scriptFsPath), analysis: scriptAnalysis, isDirect: true }
    ];

    while (queue.length > 0) {
        const { dir, analysis, isDirect } = queue.shift()!;
        for (const moduleImport of analysis.moduleImports) {
            const fsPath = path.resolve(dir, moduleImport.path);
            const key = path.normalize(fsPath).toLowerCase();

            if (!loadedByKey.has(key)) {
                const moduleAnalysis = loadModule(fsPath);
                loadedByKey.set(key, moduleAnalysis);
                if (moduleAnalysis) {
                    all.push(moduleAnalysis);
                    queue.push({ dir: path.dirname(fsPath), analysis: moduleAnalysis, isDirect: false });
                } else {
                    fullyLoaded = false;
                }
            }

            const moduleAnalysis = loadedByKey.get(key);
            if (isDirect && moduleAnalysis) {
                direct.set(moduleImport.namespace.trim().toLowerCase(), moduleAnalysis);
            }
        }
    }

    return { direct, all, fullyLoaded };
}
