import { expect, test, describe, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { scanDirectory, SpelunkDB } from "@core";

const FIXTURE_DIR = path.resolve("./tests/fixture-adversarial");
const DB_PATH = path.join(FIXTURE_DIR, ".spelunk", "data.db");

beforeAll(() => {
  if (fs.existsSync(FIXTURE_DIR)) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
});

afterAll(() => {
  if (fs.existsSync(FIXTURE_DIR)) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
});

describe("Adversarial Scanner Guards", () => {
  test("should handle oversized files by marking reason", async () => {
    const largeFilePath = path.join(FIXTURE_DIR, "large.js");
    fs.writeFileSync(largeFilePath, "const a = 1;\n".repeat(150000));

    await scanDirectory({
      rootDir: FIXTURE_DIR,
      dbPath: DB_PATH,
      silent: true,
    });

    const db = new SpelunkDB(DB_PATH);
    try {
      const record = db.getFile("large.js");
      expect(record).not.toBeNull();
      expect(record!.parsed).toBe(false);
      expect(record!.reason).toBe("exceeds size limit");
    } finally {
      db.close();
    }
  });

  test("should avoid symlink recursion loops", async () => {
    const loopDir = path.join(FIXTURE_DIR, "loop");
    fs.mkdirSync(loopDir, { recursive: true });

    try {
      fs.symlinkSync(loopDir, path.join(loopDir, "backlink"), "dir");
    } catch {
      return;
    }

    await scanDirectory({
      rootDir: FIXTURE_DIR,
      dbPath: DB_PATH,
      silent: true,
    });
  });

  test("should gracefully stop recursion depth limit on extremely deep structures", async () => {
    const deepDir = path.join(FIXTURE_DIR, "deep");
    fs.mkdirSync(deepDir, { recursive: true });

    let current = deepDir;
    for (let i = 0; i < 105; i++) {
      current = path.join(current, `level_${i}`);
      fs.mkdirSync(current, { recursive: true });
    }
    fs.writeFileSync(path.join(current, "leaf.js"), "const x = 1;");

    await scanDirectory({
      rootDir: FIXTURE_DIR,
      dbPath: DB_PATH,
      silent: true,
    });

    const db = new SpelunkDB(DB_PATH);
    try {
      const relLeafPath = path.relative(FIXTURE_DIR, path.join(current, "leaf.js"));
      const record = db.getFile(relLeafPath);
      expect(record).toBeNull();
    } finally {
      db.close();
    }
  });

  test("should handle binary files and mark reason as binary file", async () => {
    const binFilePath = path.join(FIXTURE_DIR, "image.png");
    // Write binary contents with a null byte
    const binData = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    fs.writeFileSync(binFilePath, binData);

    await scanDirectory({
      rootDir: FIXTURE_DIR,
      dbPath: DB_PATH,
      silent: true,
    });

    const db = new SpelunkDB(DB_PATH);
    try {
      const record = db.getFile("image.png");
      expect(record).not.toBeNull();
      expect(record!.parsed).toBe(false);
      expect(record!.reason).toBe("binary file");
    } finally {
      db.close();
    }
  });

  test("should ignore symlinks that escape the rootDir", async () => {
    const externalDir = path.resolve(FIXTURE_DIR, "../external-dir");
    if (!fs.existsSync(externalDir)) {
      fs.mkdirSync(externalDir, { recursive: true });
    }
    fs.writeFileSync(path.join(externalDir, "escaped.js"), "export const escaped = 1;");

    const linkPath = path.join(FIXTURE_DIR, "escaped_link");
    try {
      fs.symlinkSync(externalDir, linkPath, "dir");
    } catch {
      return; // Skip if OS lacks symlink permission
    }

    await scanDirectory({
      rootDir: FIXTURE_DIR,
      dbPath: DB_PATH,
      silent: true,
    });

    const db = new SpelunkDB(DB_PATH);
    try {
      const record = db.getFile("escaped_link/escaped.js");
      expect(record).toBeNull(); // Should not be indexed
    } finally {
      db.close();
      try {
        fs.unlinkSync(linkPath);
        fs.rmSync(externalDir, { recursive: true, force: true });
      } catch {}
    }
  });
});
