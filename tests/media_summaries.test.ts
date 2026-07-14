import { expect, test, describe, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { scanDirectory, SpelunkDB, runExplain } from "@core";

const FIXTURE_DIR = path.resolve("./tests/fixture-media");
const DB_PATH = path.join(FIXTURE_DIR, ".spelunk", "data.db");
let originalCwd: string;

beforeAll(() => {
  if (fs.existsSync(FIXTURE_DIR)) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  originalCwd = process.cwd();
  process.chdir(FIXTURE_DIR);
});

afterAll(() => {
  process.chdir(originalCwd);
  if (fs.existsSync(FIXTURE_DIR)) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
});

beforeEach(() => {
  const files = fs.readdirSync(".");
  for (const f of files) {
    if (f !== ".spelunk") {
      fs.rmSync(f, { recursive: true, force: true });
    }
  }
});

describe("Media Summaries and Query Guard", () => {
  test("should allow summarizing and retrieving binary & oversized files, but block others", async () => {
    const binFilePath = "image.png";
    const binData = Buffer.from([137, 80, 78, 71, 0]);
    fs.writeFileSync(binFilePath, binData);

    const largeFilePath = "large.js";
    fs.writeFileSync(largeFilePath, "const a = 1;\n".repeat(150000));

    const errFilePath = "error.js";
    fs.writeFileSync(errFilePath, "const a = ");

    await scanDirectory({
      rootDir: ".",
      dbPath: DB_PATH,
      silent: true,
    });

    // Manually set a non-media parse error in the DB for error.js to test blocking
    const db = new SpelunkDB(DB_PATH);
    try {
      expect(db.getFile("image.png")!.reason).toBe("binary file");
      expect(db.getFile("large.js")!.reason).toBe("exceeds size limit");

      db.upsertFile({
        path: "error.js",
        parsed: false,
        reason: "parse error: unexpected token",
        exports: [],
        imports: [],
      });
    } finally {
      db.close();
    }

    const binSummaryRes = await runExplain(
      binFilePath,
      true,
      DB_PATH,
      "This is a binary image description",
    );
    expect(binSummaryRes.summary).toBe("This is a binary image description");

    const binRetrieveRes = await runExplain(binFilePath, false, DB_PATH);
    expect(binRetrieveRes.summary).toBe("This is a binary image description");

    const largeSummaryRes = await runExplain(
      largeFilePath,
      true,
      DB_PATH,
      "This is an oversized JavaScript configuration file",
    );
    expect(largeSummaryRes.summary).toBe("This is an oversized JavaScript configuration file");

    await expect(
      runExplain(errFilePath, true, DB_PATH, "Description of error file"),
    ).rejects.toThrow("Cannot summarize unparsed file");
  });

  test("should preserve summaries on subsequent scans", async () => {
    const binFilePath = "photo.jpg";
    fs.writeFileSync(binFilePath, Buffer.from([255, 216, 255, 0]));

    const largeFilePath = "bigconfig.json";
    fs.writeFileSync(largeFilePath, "{\n".repeat(100000) + "}");

    const normalFilePath = "app.js";
    fs.writeFileSync(normalFilePath, "console.log('hello');");

    await scanDirectory({
      rootDir: ".",
      dbPath: DB_PATH,
      silent: true,
    });

    await runExplain(binFilePath, true, DB_PATH, "Photo description");
    await runExplain(largeFilePath, true, DB_PATH, "Big config description");
    await runExplain(normalFilePath, true, DB_PATH, "Normal app description");

    await scanDirectory({
      rootDir: ".",
      dbPath: DB_PATH,
      silent: true,
    });

    const db = new SpelunkDB(DB_PATH);
    try {
      expect(db.getFile("photo.jpg")!.summary).toBe("Photo description");
      expect(db.getFile("bigconfig.json")!.summary).toBe("Big config description");
      expect(db.getFile("app.js")!.summary).toBe("Normal app description");
    } finally {
      db.close();
    }
  });

  test("should detect stale summaries when file changes on disk and is re-scanned", async () => {
    const normalFilePath = "app.js";
    fs.writeFileSync(normalFilePath, "console.log('hello');");

    await scanDirectory({
      rootDir: ".",
      dbPath: DB_PATH,
      silent: true,
    });

    await runExplain(normalFilePath, true, DB_PATH, "Initial description");

    // Retrieve and verify fresh summary
    const initialRes = await runExplain(normalFilePath, false, DB_PATH);
    expect(initialRes.summary).toBe("Initial description");
    expect(initialRes.stale).toBe(false);

    // Modify file on disk
    fs.writeFileSync(normalFilePath, "console.log('hello, updated!');");

    // Re-scan
    await scanDirectory({
      rootDir: ".",
      dbPath: DB_PATH,
      silent: true,
    });

    // Retrieve and verify stale summary
    const staleRes = await runExplain(normalFilePath, false, DB_PATH);
    expect(staleRes.summary).toBe("Initial description");
    expect(staleRes.stale).toBe(true);

    // Re-set summary to update summary_hash and verify fresh again
    await runExplain(normalFilePath, true, DB_PATH, "Updated description");
    const freshRes = await runExplain(normalFilePath, false, DB_PATH);
    expect(freshRes.summary).toBe("Updated description");
    expect(freshRes.stale).toBe(false);
  });
});
