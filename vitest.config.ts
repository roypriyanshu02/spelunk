import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "@core": path.resolve(import.meta.dirname, "./src/core/index.ts"),
    },
  },
});
