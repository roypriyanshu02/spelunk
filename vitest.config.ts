import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    testTimeout: 30000,
    exclude: ["**/node_modules/**", "**/dist/**", "temp/**"],
    alias: {
      "@core": path.resolve(import.meta.dirname, "./src/core/index.ts"),
      sqlite: "node:sqlite",
    },
    server: {
      deps: {
        inline: ["node:sqlite"],
      },
    },
  },
});
