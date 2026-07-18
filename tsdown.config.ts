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
    shims: true,
    platform: "node",
    target: "node24",
    outDir: "skills/spelunk/scripts",
    clean: true,
    deps: {
      neverBundle: ["node:sqlite"],
      alwaysBundle: ["web-tree-sitter", "tsconfig-paths", "ignore"],
    },
    plugins: [
      {
        name: "fix-code-scanning",
        transform(code, id) {
          if (id.includes("web-tree-sitter") || id.includes("tsconfig-paths")) {
            const updated = code.replace(
              /\.replace\((['"])\*\1\s*,\s*([^)]+)\)/g,
              ".replaceAll($1*$1, $2)",
            );
            return {
              code: updated.replace(/\beval\(/g, "(0, eval)("),
              map: null,
            };
          }
        },
      },
    ],
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
