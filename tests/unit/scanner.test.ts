import { expect, test, describe, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { scanDirectory, SpelunkDB, isUpToDate, runExplain } from "@core";

const FIXTURE_DIR = path.resolve("./tests/fixture-scanner-unit");
const DB_PATH = path.join(FIXTURE_DIR, ".spelunk", "data.db");

describe("Scanner, Status and Crawler Guards", () => {
  beforeAll(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
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
    vi.restoreAllMocks();
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
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

  test("should detect when database is up to date and when it is stale", async () => {
    const localFile = path.join(FIXTURE_DIR, "file-status.ts");
    fs.writeFileSync(localFile, "export const a = 1;");
    const localDbPath = path.join(FIXTURE_DIR, ".spelunk", "status.db");

    const initialCheck = await isUpToDate({ rootDir: FIXTURE_DIR, dbPath: localDbPath });
    expect(initialCheck.upToDate).toBe(false);

    await scanDirectory({ rootDir: FIXTURE_DIR, dbPath: localDbPath, silent: true });
    const postScanCheck = await isUpToDate({ rootDir: FIXTURE_DIR, dbPath: localDbPath });
    expect(postScanCheck.upToDate).toBe(true);

    fs.writeFileSync(localFile, "export const a = 2;");
    const postModifyCheck = await isUpToDate({ rootDir: FIXTURE_DIR, dbPath: localDbPath });
    expect(postModifyCheck.upToDate).toBe(false);

    await scanDirectory({ rootDir: FIXTURE_DIR, dbPath: localDbPath, silent: true });
    const postRescanCheck = await isUpToDate({ rootDir: FIXTURE_DIR, dbPath: localDbPath });
    expect(postRescanCheck.upToDate).toBe(true);

    const newLocalFile = path.join(FIXTURE_DIR, "new-file-status.ts");
    fs.writeFileSync(newLocalFile, "export const b = 2;");
    const postAddCheck = await isUpToDate({ rootDir: FIXTURE_DIR, dbPath: localDbPath });
    expect(postAddCheck.upToDate).toBe(false);

    fs.unlinkSync(localFile);
    fs.unlinkSync(newLocalFile);
  });

  test("should handle oversized and binary files properly", async () => {
    const largeFile = path.join(FIXTURE_DIR, "large.ts");
    const imageFile = path.join(FIXTURE_DIR, "image.png");
    fs.writeFileSync(largeFile, "const a = 1;\n".repeat(150000));
    const binData = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    fs.writeFileSync(imageFile, binData);

    const localDbPath = path.join(FIXTURE_DIR, ".spelunk", "adversarial.db");
    await scanDirectory({ rootDir: FIXTURE_DIR, dbPath: localDbPath, silent: true });

    const db = new SpelunkDB(localDbPath);
    try {
      const largeRecord = db.getFile("large.ts");
      expect(largeRecord).not.toBeNull();
      expect(largeRecord!.parsed).toBe(false);
      expect(largeRecord!.reason).toBe("exceeds size limit");

      const binRecord = db.getFile("image.png");
      expect(binRecord).not.toBeNull();
      expect(binRecord!.parsed).toBe(false);
      expect(binRecord!.reason).toBe("binary file");
    } finally {
      db.close();
      fs.unlinkSync(largeFile);
      fs.unlinkSync(imageFile);
    }
  });

  test("should avoid symlink loops, escaped paths, and recursion depth limit", async () => {
    const loopDir = path.join(FIXTURE_DIR, "loop");
    fs.mkdirSync(loopDir, { recursive: true });
    try {
      fs.symlinkSync(loopDir, path.join(loopDir, "backlink"), "dir");
    } catch {}

    const deepDir = path.join(FIXTURE_DIR, "deep");
    fs.mkdirSync(deepDir, { recursive: true });
    let current = deepDir;
    for (let i = 0; i < 105; i++) {
      current = path.join(current, `level_${i}`);
      fs.mkdirSync(current, { recursive: true });
    }
    fs.writeFileSync(path.join(current, "leaf.js"), "const x = 1;");

    const externalDir = path.resolve(FIXTURE_DIR, "..", "external-dir-crawler");
    if (!fs.existsSync(externalDir)) {
      fs.mkdirSync(externalDir, { recursive: true });
    }
    fs.writeFileSync(path.join(externalDir, "escaped.js"), "export const escaped = 1;");
    const linkPath = path.join(FIXTURE_DIR, "escaped_link");
    try {
      fs.symlinkSync(externalDir, linkPath, "dir");
    } catch {}

    const localDbPath = path.join(FIXTURE_DIR, ".spelunk", "loop.db");
    await scanDirectory({ rootDir: FIXTURE_DIR, dbPath: localDbPath, silent: true });

    const db = new SpelunkDB(localDbPath);
    try {
      const relLeafPath = path
        .relative(FIXTURE_DIR, path.join(current, "leaf.js"))
        .replace(/\\/g, "/");
      expect(db.getFile(relLeafPath)).toBeNull();

      expect(db.getFile("escaped_link/escaped.js")).toBeNull();
    } finally {
      db.close();
      try {
        fs.unlinkSync(linkPath);
      } catch {}
      try {
        fs.rmSync(externalDir, { recursive: true, force: true });
      } catch {}
      try {
        fs.rmSync(loopDir, { recursive: true, force: true });
      } catch {}
      try {
        fs.rmSync(deepDir, { recursive: true, force: true });
      } catch {}
    }
  });

  test("should preserve summaries on subsequent scans and flag stale summaries", async () => {
    const photoFile = path.join(FIXTURE_DIR, "photo.jpg");
    const configFile = path.join(FIXTURE_DIR, "bigconfig.json");
    const appFile = path.join(FIXTURE_DIR, "app.js");

    fs.writeFileSync(photoFile, Buffer.from([255, 216, 255, 0]));
    fs.writeFileSync(configFile, "{\n".repeat(100000) + "}");
    fs.writeFileSync(appFile, "console.log('hello');");

    const localDbPath = path.join(FIXTURE_DIR, ".spelunk", "summary.db");
    await scanDirectory({ rootDir: FIXTURE_DIR, dbPath: localDbPath, silent: true });

    await runExplain(photoFile, true, localDbPath, "Photo description");
    await runExplain(configFile, true, localDbPath, "Big config description");
    await runExplain(appFile, true, localDbPath, "Normal app description");

    await scanDirectory({ rootDir: FIXTURE_DIR, dbPath: localDbPath, silent: true });

    const db = new SpelunkDB(localDbPath);
    try {
      expect(db.getFile("photo.jpg")!.summary).toBe("Photo description");
      expect(db.getFile("bigconfig.json")!.summary).toBe("Big config description");
      expect(db.getFile("app.js")!.summary).toBe("Normal app description");
    } finally {
      db.close();
    }

    fs.writeFileSync(appFile, "console.log('hello, updated!');");
    await scanDirectory({ rootDir: FIXTURE_DIR, dbPath: localDbPath, silent: true });

    const staleRes = await runExplain(appFile, false, localDbPath);
    expect(staleRes.summary).toBe("Normal app description");
    expect(staleRes.stale).toBe(true);

    fs.unlinkSync(photoFile);
    fs.unlinkSync(configFile);
    fs.unlinkSync(appFile);
  });

  test("should obey .spelunkignore and customIgnore options", async () => {
    fs.writeFileSync(path.join(FIXTURE_DIR, ".spelunkignore"), "custom_ignored.ts");
    fs.writeFileSync(path.join(FIXTURE_DIR, "custom_ignored.ts"), "export const y = 2;");
    fs.writeFileSync(path.join(FIXTURE_DIR, "extra_ignored.ts"), "export const z = 3;");

    const customDbPath = path.join(FIXTURE_DIR, ".spelunk", "custom_ignore.db");
    await scanDirectory({
      rootDir: FIXTURE_DIR,
      dbPath: customDbPath,
      silent: true,
      customIgnore: ["extra_ignored.ts"],
    });

    const db = new SpelunkDB(customDbPath);
    try {
      expect(db.getFile("custom_ignored.ts")).toBeNull();
      expect(db.getFile("extra_ignored.ts")).toBeNull();
    } finally {
      db.close();
      fs.unlinkSync(path.join(FIXTURE_DIR, ".spelunkignore"));
      fs.unlinkSync(path.join(FIXTURE_DIR, "custom_ignored.ts"));
      fs.unlinkSync(path.join(FIXTURE_DIR, "extra_ignored.ts"));
    }
  });

  test("should bypass .gitignore when .gitignore is listed in .spelunkignore", async () => {
    fs.writeFileSync(
      path.join(FIXTURE_DIR, ".spelunkignore"),
      ".gitignore\ncustom_only_ignored.ts",
    );
    fs.writeFileSync(path.join(FIXTURE_DIR, "custom_only_ignored.ts"), "export const c = 1;");

    const bypassDbPath = path.join(FIXTURE_DIR, ".spelunk", "bypass_gitignore.db");
    await scanDirectory({
      rootDir: FIXTURE_DIR,
      dbPath: bypassDbPath,
      silent: true,
    });

    const db = new SpelunkDB(bypassDbPath);
    try {
      expect(db.getFile("ignored.ts")).not.toBeNull();
      expect(db.getFile("custom_only_ignored.ts")).toBeNull();
    } finally {
      db.close();
      fs.unlinkSync(path.join(FIXTURE_DIR, ".spelunkignore"));
      fs.unlinkSync(path.join(FIXTURE_DIR, "custom_only_ignored.ts"));
    }
  });

  test("should cache resolved import path targets during scan runs", async () => {
    fs.writeFileSync(
      path.join(FIXTURE_DIR, "src", "moduleA.ts"),
      `import { help } from "@utils/helper";\nexport const a = 1;`,
    );
    fs.writeFileSync(
      path.join(FIXTURE_DIR, "src", "moduleB.ts"),
      `import { help } from "@utils/helper";\nexport const b = 2;`,
    );

    const cacheDbPath = path.join(FIXTURE_DIR, ".spelunk", "import_cache.db");
    const result = await scanDirectory({
      rootDir: FIXTURE_DIR,
      dbPath: cacheDbPath,
      silent: true,
    });
    expect(result.fileCount).toBeGreaterThan(0);

    const db = new SpelunkDB(cacheDbPath);
    try {
      const { items: outA } = db.getDependencies("src/moduleA.ts", "out", 1, 50, 0);
      const { items: outB } = db.getDependencies("src/moduleB.ts", "out", 1, 50, 0);
      expect(outA[0]?.path).toBe("src/utils/helper.ts");
      expect(outB[0]?.path).toBe("src/utils/helper.ts");
    } finally {
      db.close();
      fs.unlinkSync(path.join(FIXTURE_DIR, "src", "moduleA.ts"));
      fs.unlinkSync(path.join(FIXTURE_DIR, "src", "moduleB.ts"));
    }
  });

  test("should preserve imports to unmodified files in incremental scan mode", async () => {
    const incDbPath = path.join(FIXTURE_DIR, ".spelunk", "inc_scan.db");

    fs.writeFileSync(
      path.join(FIXTURE_DIR, "src", "importer.ts"),
      `import { help } from "@utils/helper";\nexport const run = 1;`,
    );
    await scanDirectory({
      rootDir: FIXTURE_DIR,
      dbPath: incDbPath,
      silent: true,
    });

    const db1 = new SpelunkDB(incDbPath);
    const { items: initialDeps } = db1.getDependencies("src/importer.ts", "out", 1, 50, 0);
    expect(initialDeps[0]?.path).toBe("src/utils/helper.ts");
    db1.close();

    fs.writeFileSync(
      path.join(FIXTURE_DIR, "src", "importer.ts"),
      `import { help } from "@utils/helper";\nexport const run = 2;`,
    );
    await scanDirectory({
      rootDir: FIXTURE_DIR,
      dbPath: incDbPath,
      silent: true,
      filesToScan: ["src/importer.ts"],
    });

    const db2 = new SpelunkDB(incDbPath);
    try {
      const { items: postDeps } = db2.getDependencies("src/importer.ts", "out", 1, 50, 0);
      expect(postDeps[0]?.path).toBe("src/utils/helper.ts");
    } finally {
      db2.close();
      fs.unlinkSync(path.join(FIXTURE_DIR, "src", "importer.ts"));
    }
  });
});
