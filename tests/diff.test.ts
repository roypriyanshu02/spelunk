import { expect, test, describe, beforeEach, afterEach } from "vitest";
import { SpelunkDB, runDiff } from "@core";
import { unlinkSync, existsSync } from "node:fs";
import path from "node:path";

const TEST_DB = ".spelunk.diff-test.db";

describe("runDiff", () => {
  let db: SpelunkDB;

  beforeEach(() => {
    for (const f of [TEST_DB, TEST_DB + "-shm", TEST_DB + "-wal"]) {
      if (existsSync(f)) unlinkSync(f);
    }
    db = new SpelunkDB(TEST_DB);
    db.upsertFiles([
      {
        path: "lib/old.ts",
        parsed: true,
        hash: "h1",
        exports: ["Alpha", "Beta"],
        imports: ["fs", "path"],
      },
      {
        path: "lib/new.ts",
        parsed: true,
        hash: "h2",
        exports: ["Beta", "Gamma"],
        imports: ["path", "crypto"],
      },
    ]);
    db.close();
  });

  afterEach(() => {
    for (const f of [TEST_DB, TEST_DB + "-shm", TEST_DB + "-wal"]) {
      if (existsSync(f)) unlinkSync(f);
    }
  });

  test("should detect added and removed exports and imports", async () => {
    const dbPath = path.resolve(TEST_DB);
    const result = await runDiff("lib/old.ts", "lib/new.ts", dbPath);

    expect(result.exports.added).toEqual(["Gamma"]);
    expect(result.exports.removed).toEqual(["Alpha"]);
    expect(result.imports.added).toEqual(["crypto"]);
    expect(result.imports.removed).toEqual(["fs"]);
  });

  test("should return empty diffs for identical files", async () => {
    const dbPath = path.resolve(TEST_DB);
    const result = await runDiff("lib/old.ts", "lib/old.ts", dbPath);

    expect(result.exports.added).toEqual([]);
    expect(result.exports.removed).toEqual([]);
    expect(result.imports.added).toEqual([]);
    expect(result.imports.removed).toEqual([]);
  });

  test("should throw if fileA is not in the database", async () => {
    const dbPath = path.resolve(TEST_DB);
    await expect(runDiff("lib/missing.ts", "lib/new.ts", dbPath)).rejects.toThrow(
      "File not indexed",
    );
  });
});
