import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const shared = {
    bundle: true,
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    external: ["vscode"],
    logLevel: "info",
    target: "es2022"
};

const builds = [
    // Desktop: client and server run in Node.
    { ...shared, entryPoints: ["src/client/node.ts"], outfile: "dist/client/node.js", platform: "node", format: "cjs" },
    { ...shared, entryPoints: ["src/server/node.ts"], outfile: "dist/server/node.js", platform: "node", format: "cjs" },
    // vscode.dev / github.dev: client in the extension host worker, server in a web worker.
    { ...shared, entryPoints: ["src/client/browser.ts"], outfile: "dist/client/browser.js", platform: "browser", format: "cjs" },
    { ...shared, entryPoints: ["src/server/browser.ts"], outfile: "dist/server/browser.js", platform: "browser", format: "iife" }
];

if (process.argv.includes("--tests")) {
    builds.push({ ...shared, entryPoints: ["test/integration/*.test.ts"], outdir: "dist-test", platform: "node", format: "cjs", external: ["vscode", "mocha"] });
}

const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
if (watch) {
    await Promise.all(contexts.map((context) => context.watch()));
} else {
    await Promise.all(contexts.map((context) => context.rebuild()));
    await Promise.all(contexts.map((context) => context.dispose()));
}
