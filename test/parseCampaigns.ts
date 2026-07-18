// Runs the ASL analyzer over every script it can find and reports issues.
// Usage: node dist-test/parseCampaigns.js [rootDir ...]
// Default roots: ./samples plus C:\Users\juanjo_aroztegi\dev\asl-scripts\campaigns when present.

import * as fs from "fs";
import * as path from "path";
import { AslAnalysis, analyzeDocument, augmentAnalysisWithModules } from "../src/aslParser";
import { resolveModuleGraph } from "../src/aslModules";
import { createTextDocument } from "./vscodeStub";

const moduleAnalysisCache = new Map<string, AslAnalysis | undefined>();

function loadModuleAnalysis(fsPath: string): AslAnalysis | undefined {
    const key = path.normalize(fsPath).toLowerCase();
    if (moduleAnalysisCache.has(key)) {
        return moduleAnalysisCache.get(key);
    }

    let analysis: AslAnalysis | undefined;
    try {
        const content = fs.readFileSync(fsPath, "utf8");
        analysis = analyzeDocument(createTextDocument(fsPath, content) as never);
        for (const symbol of analysis.symbols) {
            symbol.sourceUri = `file:///${fsPath.replace(/\\/g, "/")}`;
        }
    } catch {
        analysis = undefined;
    }

    moduleAnalysisCache.set(key, analysis);
    return analysis;
}

const EXTENSIONS = new Set([".ags", ".irs", ".gem", ".agm", ".irm"]);

function collectScripts(root: string, results: string[]): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === ".git" || entry.name === "node_modules") {
                continue;
            }
            collectScripts(fullPath, results);
        } else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !/_port_/.test(entry.name)) {
            results.push(fullPath);
        }
    }
}

function main(): void {
    const roots = process.argv.slice(2);
    if (roots.length === 0) {
        roots.push(path.join(__dirname, "..", "samples"));
        const campaigns = "C:\\Users\\juanjo_aroztegi\\dev\\asl-scripts\\campaigns";
        if (fs.existsSync(campaigns)) {
            roots.push(campaigns);
        }
    }

    const files: string[] = [];
    for (const root of roots) {
        collectScripts(root, files);
    }

    if (files.length === 0) {
        console.error("No ASL scripts found under: " + roots.join(", "));
        process.exit(1);
    }

    let crashed = 0;
    let totalIssues = 0;
    const issueCounts = new Map<string, number>();

    for (const file of files) {
        const content = fs.readFileSync(file, "utf8");
        const document = createTextDocument(file, content);
        try {
            // The analyzer accepts the stub document (same runtime shape).
            let analysis = analyzeDocument(document as never);
            if (analysis.moduleImports.length > 0) {
                const graph = resolveModuleGraph(file, analysis, loadModuleAnalysis);
                analysis = augmentAnalysisWithModules(analysis, graph.direct, graph.all, graph.fullyLoaded);
            }
            totalIssues += analysis.issues.length;
            if (analysis.issues.length > 0) {
                console.log(`${path.basename(path.dirname(file))}/${path.basename(file)}: ${analysis.issues.length} issue(s)`);
                const limit = process.env.ASL_TEST_ALL ? analysis.issues.length : 5;
                for (const issue of analysis.issues.slice(0, limit)) {
                    console.log(`    L${issue.range.start.line + 1}: ${issue.message}`);
                }
                if (analysis.issues.length > limit) {
                    console.log(`    ... ${analysis.issues.length - limit} more`);
                }
            }
            for (const issue of analysis.issues) {
                const key = issue.message.replace(/'[^']*'/g, "'…'").replace(/"[^"]*"/g, '"…"');
                issueCounts.set(key, (issueCounts.get(key) ?? 0) + 1);
            }
        } catch (error) {
            crashed += 1;
            console.error(`CRASH ${file}: ${(error as Error).stack}`);
        }
    }

    console.log(`\n${files.length} files, ${totalIssues} issues, ${crashed} crashes`);
    const topIssues = [...issueCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    if (topIssues.length > 0) {
        console.log("\nTop issue messages:");
        for (const [message, count] of topIssues) {
            console.log(`  ${String(count).padStart(5)}  ${message}`);
        }
    }

    process.exit(crashed > 0 ? 1 : 0);
}

main();
