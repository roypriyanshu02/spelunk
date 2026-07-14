import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/core/index.ts"],
    format: "esm",
    dts: true,
    clean: true,
    outDir: "dist",
    platform: "node",
    target: "node24",
  },
  {
    entry: ["src/commands/*.ts"],
    format: "esm",
    minify: false,
    platform: "node",
    target: "node24",
    outDir: "skills/spelunk/scripts",
    clean: true,
    deps: {
      neverBundle: ["node:sqlite"],
    },
    outputOptions: {
      banner: "#!/usr/bin/env node",
      manualChunks(id) {
        if (id.includes("/src/core/")) {
          return "common";
        }
      },
      chunkFileNames: "[name].mjs",
    },
  },
]);
