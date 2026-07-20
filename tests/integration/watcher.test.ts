import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanDirectory, watchDirectory, SpelunkDB } from "@core";

describe("Watch Mode & Concurrency Lock", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spelunk-watch-test-"));
    dbPath = path.join(tempDir, ".spelunk", "data.db");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function waitForFile(dbPath: string, filePath: string, timeoutMs = 5000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(dbPath)) {
        const db = new SpelunkDB(dbPath);
        try {
          const record = db.getFile(filePath);
          if (record) return record;
        } catch {
          // DB lock or write in progress
        } finally {
          db.close();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timeout waiting for file ${filePath} in database`);
  }

  it("should prevent concurrent scans when scanStatus is running and PID is alive", async () => {
    await scanDirectory({ rootDir: tempDir, dbPath, silent: true });

    const db = new SpelunkDB(dbPath);
    db.setMetadata("scanStatus", "running");
    db.setMetadata("scanPid", String(process.ppid));
    db.close();

    await expect(scanDirectory({ rootDir: tempDir, dbPath, silent: true })).rejects.toThrow(
      /Concurrency on the same index is not allowed/,
    );
  });

  it("should allow scanning if previous scan reported running but PID is dead", async () => {
    await scanDirectory({ rootDir: tempDir, dbPath, silent: true });

    const db = new SpelunkDB(dbPath);
    db.setMetadata("scanStatus", "running");
    db.setMetadata("scanPid", "999999");
    db.close();

    const res = await scanDirectory({ rootDir: tempDir, dbPath, silent: true });
    expect(res).toBeDefined();
    expect(res.fileCount).toBe(0);
  });

  it("should run initial scan in watchDirectory without throwing", async () => {
    const testFile = path.join(tempDir, "sample.js");
    fs.writeFileSync(testFile, "export const foo = 42;");

    const controller = new AbortController();
    const watchPromise = watchDirectory({
      rootDir: tempDir,
      dbPath,
      silent: true,
      signal: controller.signal,
    });

    try {
      const fileRecord = await waitForFile(dbPath, "sample.js");
      expect(fileRecord).not.toBeNull();
      expect(fileRecord?.exports).toContain("foo");
    } finally {
      controller.abort();
      await watchPromise.catch(() => {});
    }
  });

  it("should reject immediately if aborted before starting", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      watchDirectory({
        rootDir: tempDir,
        dbPath,
        silent: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Aborted");
  });

  it("should handle SIGINT by closing watcher and exiting process", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sigintHandlers: (() => void)[] = [];
    const onSpy = vi.spyOn(process, "on").mockImplementation((event, handler) => {
      if (event === "SIGINT") {
        sigintHandlers.push(handler as () => void);
      }
      return process;
    });
    const offSpy = vi.spyOn(process, "off").mockImplementation((event, handler) => {
      if (event === "SIGINT") {
        const idx = sigintHandlers.indexOf(handler as () => void);
        if (idx !== -1) sigintHandlers.splice(idx, 1);
      }
      return process;
    });

    const testFile = path.join(tempDir, "sample.js");
    fs.writeFileSync(testFile, "export const foo = 42;");

    const controller = new AbortController();
    const watchPromise = watchDirectory({
      rootDir: tempDir,
      dbPath,
      silent: false,
      signal: controller.signal,
    });

    try {
      await waitForFile(dbPath, "sample.js");
      const activeHandler = sigintHandlers.at(-1);
      if (activeHandler) {
        activeHandler();
      }

      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Stopped watching directory"));
    } finally {
      onSpy.mockRestore();
      offSpy.mockRestore();
      exitSpy.mockRestore();
      logSpy.mockRestore();
      controller.abort();
      await watchPromise.catch(() => {});
    }
  });

  it("should trigger debounced scan on file change events", async () => {
    const initFile = path.join(tempDir, "init.js");
    fs.writeFileSync(initFile, "export const a = 1;");

    const controller = new AbortController();
    const watchPromise = watchDirectory({
      rootDir: tempDir,
      dbPath,
      silent: true,
      signal: controller.signal,
      debounceMs: 50,
    });

    try {
      await waitForFile(dbPath, "init.js");

      // Ensure fs.watch is active on Linux before writing file
      await new Promise((r) => setTimeout(r, 100));

      fs.writeFileSync(path.join(tempDir, "changed.js"), "export const b = 2;");

      const fileRecord = await waitForFile(dbPath, "changed.js", 10000);
      expect(fileRecord).not.toBeNull();
      expect(fileRecord?.exports).toContain("b");
    } finally {
      controller.abort();
      await watchPromise.catch(() => {});
    }
  });
});
