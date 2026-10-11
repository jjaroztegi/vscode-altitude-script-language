import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
    files: "dist-test/**/*.test.js",
    workspaceFolder: "test/fixtures/project",
    version: "stable",
    mocha: { timeout: 60000 },
    launchArgs: ["--disable-extensions"]
});
