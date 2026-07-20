import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/commands/*.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "skills/spelunk/scripts",
  clean: true,
  sourcemap: true,
  treeshake: true,
  define: {
    __dirname: "import.meta.dirname",
    ENVIRONMENT_IS_WEB: "false",
    ENVIRONMENT_IS_WORKER: "false",
    "typeof window": '"undefined"',
    "typeof document": '"undefined"',
    "typeof importScripts": '"undefined"',
  },
  deps: {
    alwaysBundle: ["web-tree-sitter", "tsconfig-paths", "ignore"],
    onlyBundle: false,
  },
  suppressWarnings: [/Use of direct `eval` function/],
  outputOptions: {
    banner(chunk) {
      const warning = "/**\n * AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.\n */\n";
      if (chunk.isEntry) {
        return "#!/usr/bin/env node\n" + warning;
      }
      return warning;
    },
    manualChunks(id) {
      if (/[/\\]src[/\\]core[/\\]/.test(id)) {
        return "common";
      }
    },
    chunkFileNames: "[name].mjs",
  },
});
