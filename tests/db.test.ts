import { expect, test, describe, beforeEach, afterEach } from "vitest";
import { SpelunkDB, type FileRecord } from "@core";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = ".spelunk.test.db";

describe("SpelunkDB", () => {
  let db: SpelunkDB;

  beforeEach(() => {
    for (const f of [TEST_DB, TEST_DB + "-shm", TEST_DB + "-wal"]) {
      if (existsSync(f)) {
        unlinkSync(f);
      }
    }
    db = new SpelunkDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    for (const f of [TEST_DB, TEST_DB + "-shm", TEST_DB + "-wal"]) {
      if (existsSync(f)) {
        unlinkSync(f);
      }
    }
  });

  test("should insert and retrieve a file record", () => {
    const record: FileRecord = {
      path: "src/main.ts",
      parsed: true,
      hash: "hash123",
      exports: ["main", "helper"],
      imports: ["fs", "path"],
      summary: "This is a test summary",
    };

    db.upsertFile(record);

    const fetched = db.getFile("src/main.ts");
    expect(fetched).not.toBeNull();
    expect(fetched!.path).toBe("src/main.ts");
    expect(fetched!.parsed).toBe(true);
    expect(fetched!.reason).toBeNull();
    expect(fetched!.hash).toBe("hash123");
    expect(fetched!.exports).toEqual(["main", "helper"]);
    expect(fetched!.imports).toEqual(["fs", "path"]);
    expect(fetched!.summary).toBe("This is a test summary");
  });

  test("should update existing records on conflict (upsert)", () => {
    const record1: FileRecord = {
      path: "src/main.ts",
      parsed: true,
      hash: "hash123",
      exports: ["main"],
      imports: [],
    };

    const record2: FileRecord = {
      path: "src/main.ts",
      parsed: false,
      reason: "syntax error",
      hash: "hash456",
      exports: [],
      imports: [],
    };

    db.upsertFile(record1);
    db.upsertFile(record2);

    const fetched = db.getFile("src/main.ts");
    expect(fetched).not.toBeNull();
    expect(fetched!.parsed).toBe(false);
    expect(fetched!.reason).toBe("syntax error");
    expect(fetched!.hash).toBe("hash456");
    expect(fetched!.exports).toEqual([]);
  });

  test("should perform atomic batch inserts inside a transaction", () => {
    const records: FileRecord[] = [
      {
        path: "a.ts",
        parsed: true,
        hash: "hashA",
        exports: ["A"],
        imports: [],
      },
      {
        path: "b.ts",
        parsed: true,
        hash: "hashB",
        exports: ["B"],
        imports: ["a.ts"],
      },
    ];

    db.upsertFiles(records);

    const all = db.getAllFiles();
    expect(all.length).toBe(2);
    expect(db.getFile("a.ts")!.exports).toEqual(["A"]);
    expect(db.getFile("b.ts")!.imports).toEqual(["a.ts"]);
  });

  test("should search by path, exports, and imports", () => {
    db.upsertFiles([
      {
        path: "src/main.ts",
        parsed: true,
        hash: "h1",
        exports: ["initialize", "startApp"],
        imports: ["react"],
      },
      {
        path: "src/utils.ts",
        parsed: true,
        hash: "h2",
        exports: ["formatDate"],
        imports: ["lodash"],
      },
    ]);

    const { items: pathResults } = db.search("utils");
    expect(pathResults.length).toBe(1);
    expect(pathResults[0].path).toBe("src/utils.ts");

    const { items: exportResults } = db.search("initialize");
    expect(exportResults.length).toBe(1);
    expect(exportResults[0].path).toBe("src/main.ts");

    const { items: importResults } = db.search("lodash");
    expect(importResults.length).toBe(1);
    expect(importResults[0].path).toBe("src/utils.ts");

    const { items: noResults } = db.search("nonexistent");
    expect(noResults.length).toBe(0);
  });

  test("should track dependency graph, query via recursive CTE, cascade deletes, and handle upserts without deleting imports", () => {
    // 1. Insert files
    db.upsertFiles([
      { path: "src/a.ts", parsed: true, hash: "hA", exports: ["A"], imports: ["./b"] },
      { path: "src/b.ts", parsed: true, hash: "hB", exports: ["B"], imports: ["./c"] },
      { path: "src/c.ts", parsed: true, hash: "hC", exports: ["C"], imports: [] },
      { path: "src/d.ts", parsed: true, hash: "hD", exports: ["D"], imports: ["./b"] },
    ]);

    // 2. Set up resolved imports in the relational table
    db.clearAndInsertImports([
      { file_path: "src/a.ts", imported_path: "src/b.ts" },
      { file_path: "src/b.ts", imported_path: "src/c.ts" },
      { file_path: "src/d.ts", imported_path: "src/b.ts" },
    ]);

    // 3. Query dependencies (direction = out) starting from src/a.ts
    // a.ts -> b.ts (rank 1) -> c.ts (rank 2)
    const { items: depsOut } = db.getDependencies("src/a.ts", "out", 10, 50, 0);
    expect(depsOut.length).toBe(2);
    expect(depsOut[0].path).toBe("src/b.ts");
    expect(depsOut[0].rank).toBe(1);
    expect(depsOut[1].path).toBe("src/c.ts");
    expect(depsOut[1].rank).toBe(2);

    // 4. Query dependents (direction = in) starting from src/c.ts
    // c.ts <- b.ts (rank 1) <- a.ts, d.ts (rank 2)
    const { items: depsIn } = db.getDependencies("src/c.ts", "in", 10, 50, 0);
    expect(depsIn.length).toBe(3);
    expect(depsIn[0].path).toBe("src/b.ts");
    expect(depsIn[0].rank).toBe(1);
    const rank2Paths = depsIn
      .slice(1)
      .map((d) => d.path)
      .sort();
    expect(rank2Paths).toEqual(["src/a.ts", "src/d.ts"]);
    expect(depsIn[1].rank).toBe(2);
    expect(depsIn[2].rank).toBe(2);

    // 5. Check limit and offset
    const { items: paginated } = db.getDependencies("src/c.ts", "in", 10, 1, 1);
    expect(paginated.length).toBe(1);

    // 6. Test upsertFile without deleting imports (ON CONFLICT DO UPDATE)
    const record = db.getFile("src/a.ts")!;
    record.summary = "updated summary";
    db.upsertFile(record);

    // Dependency should still be present
    const { items: depsAfterUpsert } = db.getDependencies("src/a.ts", "out", 10, 50, 0);
    expect(depsAfterUpsert.map((d) => d.path)).toContain("src/b.ts");

    // 7. Test deleteFiles cascade delete
    db.deleteFiles(["src/a.ts"]);
    const { items: depsAfterDelete } = db.getDependencies("src/b.ts", "in", 10, 50, 0);
    expect(depsAfterDelete.map((d) => d.path)).not.toContain("src/a.ts");
    expect(depsAfterDelete.map((d) => d.path)).toContain("src/d.ts");
    // a.ts is deleted, so only d.ts is a dependent of b.ts (which is a dependent of c.ts)
    // Actually, c.ts <- b.ts (rank 1) <- d.ts (rank 2) (a.ts should be gone)
    const { items: cDependents } = db.getDependencies("src/c.ts", "in", 10, 50, 0);
    expect(cDependents.map((d) => d.path)).not.toContain("src/a.ts");
    expect(cDependents.map((d) => d.path)).toContain("src/d.ts");
  });

  test("should handle metadata storage, retrieval, and hybrid search edge cases", () => {
    db.setMetadata("rootDir", "/some/root");
    expect(db.getMetadata("rootDir")).toBe("/some/root");
    expect(db.getMetadata("nonexistent")).toBeNull();

    db.upsertFiles([
      {
        path: "foo.ts",
        parsed: true,
        hash: "h3",
        exports: ["someCoolExport"],
        imports: ["react"],
      },
    ]);

    // Query >= 3 uses FTS5 Match
    const { items: ftsMatch } = db.search("someCoolExport");
    expect(ftsMatch.length).toBe(1);
    expect(ftsMatch[0].path).toBe("foo.ts");

    // Query < 3 uses LIKE fallback
    const { items: shortMatch } = db.search("fo");
    expect(shortMatch.length).toBe(1);
    expect(shortMatch[0].path).toBe("foo.ts");
  });
});
