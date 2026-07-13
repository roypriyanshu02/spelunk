import { expect, test, describe, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { scanDirectory, SpelunkDB } from "@core";

const FIXTURE_DIR = path.resolve("./tests/fixture-scanner");
const DB_PATH = path.join(FIXTURE_DIR, ".spelunk", "data.db");

describe("Scanner tsconfig-paths and ignore testing", () => {
  beforeAll(() => {
    if (fs.existsSync(FIXTURE_DIR)) {
      fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });

    // Write tsconfig.json with path mapping
    fs.writeFileSync(
      path.join(FIXTURE_DIR, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@utils/*": ["src/utils/*"],
          },
        },
      }),
    );

    // Write folders & files
    fs.mkdirSync(path.join(FIXTURE_DIR, "src", "utils"), { recursive: true });
    fs.writeFileSync(
      path.join(FIXTURE_DIR, "src", "main.ts"),
      `import { help } from "@utils/helper";\nexport function main() {}`,
    );
    fs.writeFileSync(
      path.join(FIXTURE_DIR, "src", "utils", "helper.ts"),
      `export function help() {}`,
    );

    // Write a file to ignore via .gitignore
    fs.writeFileSync(path.join(FIXTURE_DIR, ".gitignore"), "ignored.ts");
    fs.writeFileSync(path.join(FIXTURE_DIR, "ignored.ts"), "export const x = 1;");
  });

  afterAll(() => {
    if (fs.existsSync(FIXTURE_DIR)) {
      fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    }
  });

  test("should map tsconfig paths and obey .gitignore rules", async () => {
    await scanDirectory({
      rootDir: FIXTURE_DIR,
      dbPath: DB_PATH,
      silent: true,
    });

    const db = new SpelunkDB(DB_PATH);
    try {
      // Ignored file shouldn't be indexed
      expect(db.getFile("ignored.ts")).toBeNull();

      // Main file should be indexed
      const mainFile = db.getFile("src/main.ts");
      expect(mainFile).not.toBeNull();
      expect(mainFile!.imports).toContain("@utils/helper");

      // Dependency graph should map path alias correctly to relative path
      const { items: outDeps } = db.getDependencies("src/main.ts", "out", 1, 50, 0);
      expect(outDeps).toHaveLength(1);
      expect(outDeps[0].path).toBe("src/utils/helper.ts");
    } finally {
      db.close();
    }
  });

  test("should respect concurrency option", async () => {
    const customDbPath = path.join(FIXTURE_DIR, ".spelunk", "concurrency.db");
    const result = await scanDirectory({
      rootDir: FIXTURE_DIR,
      dbPath: customDbPath,
      silent: true,
      concurrency: 2,
    });
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.metrics).toBeDefined();
    expect(result.metrics!.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics!.filesPerSecond).toBeGreaterThanOrEqual(0);
    expect(result.metrics!.cacheHitRatio).toBeGreaterThanOrEqual(0);
    expect(result.metrics!.memoryUsageMb).toBeGreaterThan(0);
    const db = new SpelunkDB(customDbPath);
    try {
      expect(db.getFile("src/main.ts")).not.toBeNull();
    } finally {
      db.close();
    }
  });
});
