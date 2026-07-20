import { expect, test, describe, beforeEach, afterEach } from "vitest";
import { SpelunkDB, runFind, runOutline, runDeps, runExport, runExplain, runDiff } from "@core";
import { rmSync } from "node:fs";
import path from "node:path";

const TEST_DB = ".spelunk.query-test.db";

describe("Query functions", () => {
  let db: SpelunkDB;
  const dbPath = path.resolve(TEST_DB);

  beforeEach(() => {
    for (const f of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`]) {
      rmSync(f, { force: true });
    }
    db = new SpelunkDB(TEST_DB);
    db.upsertFiles([
      {
        path: "src/main.ts",
        parsed: true,
        hash: "h1",
        exports: ["main", "start"],
        imports: ["src/utils.ts"],
      },
      {
        path: "src/utils.ts",
        parsed: true,
        hash: "h2",
        exports: ["helper"],
        imports: [],
      },
      {
        path: "src/failed.ts",
        parsed: false,
        reason: "parse error",
        exports: [],
        imports: [],
      },
      {
        path: "lib/old.ts",
        parsed: true,
        hash: "h3",
        exports: ["Alpha", "Beta"],
        imports: ["fs", "path"],
      },
      {
        path: "lib/new.ts",
        parsed: true,
        hash: "h4",
        exports: ["Beta", "Gamma"],
        imports: ["path", "crypto"],
      },
    ]);
    db.updateFilesImports(new Map([["src/main.ts", ["src/utils.ts"]]]));
    db.close();
  });

  afterEach(() => {
    for (const f of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`]) {
      rmSync(f, { force: true });
    }
  });

  test("runFind should search for symbols and return matching file records", async () => {
    const res = await runFind("helper", dbPath);
    expect(res.files).toHaveLength(1);
    expect(res.files[0].path).toBe("src/utils.ts");
    expect(res.total_count).toBe(1);
    expect(res.has_more).toBe(false);
  });

  test("runFind should throw if db does not exist", async () => {
    await expect(runFind("helper", "nonexistent.db")).rejects.toThrow("No database found");
  });

  test("runOutline should outline specific file details", async () => {
    const res = await runOutline("src/main.ts", dbPath);
    expect(res.files).toHaveLength(1);
    expect(res.files[0].path).toBe("src/main.ts");

    const missingRes = await runOutline("missing.ts", dbPath);
    expect(missingRes.files).toHaveLength(0);
  });

  test("runDeps should outline dependencies in both directions", async () => {
    const outDeps = await runDeps("src/main.ts", "out", 1, dbPath);
    expect(outDeps.files).toHaveLength(1);
    expect(outDeps.files[0].path).toBe("src/utils.ts");
    expect(outDeps.total_count).toBe(1);
    expect(outDeps.has_more).toBe(false);

    const inDeps = await runDeps("src/utils.ts", "in", 1, dbPath);
    expect(inDeps.files).toHaveLength(1);
    expect(inDeps.files[0].path).toBe("src/main.ts");
    expect(inDeps.total_count).toBe(1);
    expect(inDeps.has_more).toBe(false);

    const missingDeps = await runDeps("missing.ts", "out", 1, dbPath);
    expect(missingDeps.files).toHaveLength(0);
    expect(missingDeps.total_count).toBe(0);
    expect(missingDeps.has_more).toBe(false);
  });

  test("runExport should format files as JSON and Markdown", async () => {
    const jsonRes = (await runExport("json", dbPath)) as { files: any[] };
    expect(jsonRes.files).toHaveLength(5);

    const mdRes = await runExport("md", dbPath);
    expect(typeof mdRes).toBe("string");
    expect(mdRes).toContain("# Spelunk Codemap Export");
    expect(mdRes).toContain("## src/main.ts");
    expect(mdRes).toContain("## src/utils.ts");
    expect(mdRes).toContain("- **Reason**: parse error");
  });

  test("runExplain should throw on missing file in database", async () => {
    await expect(runExplain("missing.ts", false, dbPath)).rejects.toThrow("File not indexed");
  });

  test("runExplain should throw on missing summary cache when summarize is false", async () => {
    await expect(runExplain("src/main.ts", false, dbPath)).rejects.toThrow("No summary cached");
  });

  test("runExplain should throw on missing agentSummary when summarize is true", async () => {
    await expect(runExplain("src/main.ts", true, dbPath)).rejects.toThrow(
      "Provide the summary text",
    );
  });

  test("runExplain should throw when file does not exist on disk during summarize", async () => {
    await expect(runExplain("src/main.ts", true, dbPath, "summary text")).rejects.toThrow(
      "File not found on disk",
    );
  });

  test("runDiff should detect added and removed exports and imports", async () => {
    const result = await runDiff("lib/old.ts", "lib/new.ts", dbPath);

    expect(result.exports.added).toEqual(["Gamma"]);
    expect(result.exports.removed).toEqual(["Alpha"]);
    expect(result.imports.added).toEqual(["crypto"]);
    expect(result.imports.removed).toEqual(["fs"]);
  });

  test("runDiff should return empty diffs for identical files", async () => {
    const result = await runDiff("lib/old.ts", "lib/old.ts", dbPath);

    expect(result.exports.added).toEqual([]);
    expect(result.exports.removed).toEqual([]);
    expect(result.imports.added).toEqual([]);
    expect(result.imports.removed).toEqual([]);
  });

  test("runDiff should throw when second file is missing from database", async () => {
    await expect(runDiff("src/main.ts", "missing.ts", dbPath)).rejects.toThrow(
      "File not indexed: missing.ts",
    );
  });
});
