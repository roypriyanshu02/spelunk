import { expect, test, describe, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { scanDirectory, runCliCommandWithContext } from "@core";

import { findCommand } from "../../src/commands/find";
import { outlineCommand } from "../../src/commands/outline";
import { depsCommand } from "../../src/commands/deps";
import { explainCommand } from "../../src/commands/explain";
import { exportCommand } from "../../src/commands/export";
import { statusCommand } from "../../src/commands/status";
import { scanCommand } from "../../src/commands/scan";
import { diffCommand } from "../../src/commands/diff";
import { queryCommand } from "../../src/commands/query";

const commandsMap: Record<string, any> = {
  find: findCommand,
  outline: outlineCommand,
  deps: depsCommand,
  explain: explainCommand,
  export: exportCommand,
  status: statusCommand,
  scan: scanCommand,
  diff: diffCommand,
  query: queryCommand,
};

const FIXTURE_DIR = path.resolve("./tests/fixture-cli-integration");
const DB_PATH = path.join(FIXTURE_DIR, ".spelunk", "data.db");
const SCHEMA_PATH = path.resolve("./references/codemap.v1.json");

function validateSchema(data: any) {
  expect(typeof data).toBe("object");
  expect(Array.isArray(data.files)).toBe(true);

  if (data.limit !== undefined) {
    expect(typeof data.limit).toBe("number");
  }
  if (data.offset !== undefined) {
    expect(typeof data.offset).toBe("number");
  }

  for (const file of data.files) {
    expect(typeof file.path).toBe("string");
    expect(typeof file.parsed).toBe("boolean");

    if (file.reason !== undefined && file.reason !== null) {
      expect(typeof file.reason).toBe("string");
    }
    if (file.hash !== undefined && file.hash !== null) {
      expect(typeof file.hash).toBe("string");
    }
    if (file.exports !== undefined) {
      expect(Array.isArray(file.exports)).toBe(true);
      for (const exp of file.exports) expect(typeof exp).toBe("string");
    }
    if (file.imports !== undefined) {
      expect(Array.isArray(file.imports)).toBe(true);
      for (const imp of file.imports) expect(typeof imp).toBe("string");
    }
  }
}

describe("CLI Wrapper Scripts and Engine Integration", () => {
  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_DIR, "file.ts"), "export const hello = 1;\nimport 'fs';");
    await scanDirectory({ rootDir: FIXTURE_DIR, dbPath: DB_PATH, silent: true });
  });

  afterAll(() => {
    vi.restoreAllMocks();
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  async function runMockCli(
    command: any,
    args: string[],
    env: Record<string, string> = { SPELUNK_DB_PATH: DB_PATH },
  ) {
    const logs: string[] = [];
    const errors: string[] = [];
    let exitCode: number | null = null;

    await runCliCommandWithContext(command, {
      args,
      env,
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
      exit: (code) => {
        exitCode = code;
      },
    });

    return { logs, errors, exitCode, env };
  }

  async function runTestCommand(name: string, args: string[], env: Record<string, string> = {}) {
    const config = commandsMap[name];
    if (!config) {
      throw new Error(`Command not registered: ${name}`);
    }
    return runMockCli(config, args, { SPELUNK_DB_PATH: DB_PATH, ...env });
  }

  test("runCliCommand: should successfully execute command with valid args", async () => {
    const validate = vi.fn().mockReturnValue(true);
    const execute = vi.fn().mockResolvedValue("success-output");
    const formatMarkdown = vi.fn().mockReturnValue("formatted-markdown");

    const { logs, exitCode } = await runMockCli(
      {
        name: "test-cmd",
        validate,
        execute,
        formatMarkdown,
      },
      ["valid-arg"],
    );

    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ format: "markdown" }), [
      "valid-arg",
    ]);
    expect(execute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ format: "markdown" }),
      ["valid-arg"],
    );
    expect(formatMarkdown).toHaveBeenCalledWith(
      "success-output",
      expect.objectContaining({ format: "markdown" }),
      ["valid-arg"],
    );
    expect(logs).toContain("formatted-markdown");
    expect(exitCode).toBeNull();
  });

  test("runCliCommand: should support json output format", async () => {
    const validate = vi.fn().mockReturnValue(true);
    const execute = vi.fn().mockResolvedValue({ some: "data" });
    const formatMarkdown = vi.fn();

    const { logs, exitCode } = await runMockCli(
      {
        name: "test-cmd",
        validate,
        execute,
        formatMarkdown,
      },
      ["valid-arg", "--format", "json"],
    );

    expect(execute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ format: "json" }),
      ["valid-arg"],
    );
    expect(logs).toContain(JSON.stringify({ some: "data" }, null, 2));
    expect(exitCode).toBeNull();
  });

  test("runCliCommand: should fail validation and exit 1 in markdown format", async () => {
    const validate = vi.fn().mockReturnValue("validation error");
    const execute = vi.fn();
    const formatMarkdown = vi.fn();

    const { errors, exitCode } = await runMockCli(
      {
        name: "test-cmd",
        validate,
        execute,
        formatMarkdown,
      },
      [],
    );

    expect(errors).toContain("test-cmd failed: validation error");
    expect(exitCode).toBe(1);
  });

  test("runCliCommand: should handle validation return false, options default values, short names, and file path extraction", async () => {
    const validate = vi.fn().mockReturnValue(false);
    const execute = vi.fn();
    const formatMarkdown = vi.fn();

    const { errors, exitCode } = await runMockCli(
      {
        name: "outline",
        options: {
          query: { type: "string", short: "q", default: "default-query" },
        },
        validate,
        execute,
        formatMarkdown,
      },
      ["-q", "search", "pos-file.ts"],
    );

    expect(errors[0]).toContain("outline failed: Invalid argument for parameter 'query'");
    expect(exitCode).toBe(1);
  });

  test("runCliCommand: should extract files for out-of-date check for diff and outline commands", async () => {
    const validate = vi.fn().mockReturnValue(true);
    const execute = vi.fn().mockResolvedValue("output");
    const formatMarkdown = vi.fn().mockReturnValue("md");

    const { exitCode } = await runMockCli(
      {
        name: "diff",
        validate,
        execute,
        formatMarkdown,
      },
      ["fileA.ts", "fileB.ts"],
    );

    expect(execute).toHaveBeenCalled();
    expect(exitCode).toBeNull();
  });

  test("run find command wrapper", async () => {
    const { logs } = await runTestCommand("find", ["--dir", FIXTURE_DIR, "hello"]);
    expect(logs.join("\n")).toContain("Spelunk Find Results");
  });

  test("run outline command wrapper", async () => {
    const { logs } = await runTestCommand("outline", [
      "--dir",
      FIXTURE_DIR,
      path.join(FIXTURE_DIR, "file.ts"),
    ]);
    expect(logs.join("\n")).toContain("Spelunk Outline for");
  });

  test("run deps command wrapper", async () => {
    const { logs } = await runTestCommand("deps", [
      "--dir",
      FIXTURE_DIR,
      path.join(FIXTURE_DIR, "file.ts"),
      "out",
    ]);
    expect(logs.join("\n")).toContain("Spelunk Dependencies");
  });

  test("run explain command wrapper", async () => {
    const { logs } = await runTestCommand("explain", [
      "--dir",
      FIXTURE_DIR,
      "--set-summary",
      "Custom explanation summary",
      path.join(FIXTURE_DIR, "file.ts"),
    ]);
    expect(logs.join("\n")).toContain("Custom explanation summary");
  });

  test("run export command wrapper", async () => {
    const { logs } = await runTestCommand("export", ["--dir", FIXTURE_DIR, "markdown"]);
    expect(logs.join("\n")).toContain("Spelunk Codemap Export");

    const jsonRun = await runTestCommand("export", ["--dir", FIXTURE_DIR, "json"]);
    expect(() => JSON.parse(jsonRun.logs.join("\n"))).not.toThrow();
  });

  test("run status command wrapper", async () => {
    const { logs } = await runTestCommand("status", ["--dir", FIXTURE_DIR]);
    expect(logs.join("\n")).toContain("Spelunk Index Status");
  });

  test("run scan command wrapper", async () => {
    const { SpelunkDB } = await import("@core");
    const db = new SpelunkDB(DB_PATH);
    db.setMetadata("scanStatus", "completed");
    db.close();

    const { logs, errors } = await runTestCommand("scan", ["--dir", FIXTURE_DIR]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(errors).toHaveLength(0);
    expect(logs.join("\n")).toContain("Spelunk Scan Completed");
  });

  test("run diff command wrapper", async () => {
    fs.writeFileSync(path.join(FIXTURE_DIR, "file2.ts"), "export const hello = 2;\nimport 'path';");
    await scanDirectory({ rootDir: FIXTURE_DIR, dbPath: DB_PATH, silent: true });

    const { logs } = await runTestCommand("diff", [
      "--dir",
      FIXTURE_DIR,
      path.join(FIXTURE_DIR, "file.ts"),
      path.join(FIXTURE_DIR, "file2.ts"),
    ]);
    expect(logs.join("\n")).toContain("Spelunk Structural Diff");
  });

  test("run query command wrapper", async () => {
    const { logs } = await runTestCommand("query", [
      "--dir",
      FIXTURE_DIR,
      "SELECT path FROM files WHERE path = ?",
      "file.ts",
    ]);
    expect(logs.join("\n")).toContain("| file.ts |");
  });

  test("Output schema matches codemap.v1.json", () => {
    const schemaContent = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    expect(schemaContent.required).toContain("files");

    const mockOutput = {
      files: [
        {
          path: "src/main.ts",
          parsed: true,
          hash: "abc123hash",
          exports: ["run"],
          imports: ["fs", "path"],
        },
      ],
      limit: 50,
      offset: 0,
    };
    validateSchema(mockOutput);
  });

  test("should output warning when calling a query command on a stale database", async () => {
    fs.writeFileSync(path.join(FIXTURE_DIR, "stale.ts"), "export const x = 1;");

    const validate = () => true;
    const execute = () => "success";
    const formatMarkdown = () => "markdown";

    const { errors, exitCode } = await runMockCli(
      {
        name: "find",
        options: {
          dir: { type: "string" },
        },
        validate,
        execute,
        formatMarkdown,
      },
      ["--dir", FIXTURE_DIR],
    );

    expect(errors.join("\n")).toContain("Warning: Cached index is out-of-date");
    expect(exitCode).toBeNull();
    fs.unlinkSync(path.join(FIXTURE_DIR, "stale.ts"));
  });

  test("should handle global CLI flags: --no-download, --force-fallback, --clear-wasm-cache", async () => {
    delete process.env.SPELUNK_WASM_DIR;
    delete process.env.SPELUNK_OFFLINE;
    delete process.env.SPELUNK_FORCE_FALLBACK;

    const validate = () => true;
    const execute = () => "success";
    const formatMarkdown = () => "markdown";

    const testCmd = {
      name: "status",
      validate,
      execute,
      formatMarkdown,
    };

    // Test --no-download
    const resNoDownload = await runMockCli(testCmd, ["--no-download"], {});
    expect(resNoDownload.env.SPELUNK_OFFLINE).toBe("1");

    // Test --force-fallback
    const resForceFallback = await runMockCli(testCmd, ["--force-fallback"], {});
    expect(resForceFallback.env.SPELUNK_FORCE_FALLBACK).toBe("1");

    // Test --clear-wasm-cache
    const { logs, exitCode } = await runMockCli(testCmd, ["--clear-wasm-cache"], {});
    expect(logs).toContain("[spelunk] WASM cache cleared.");
    expect(exitCode).toBe(0);
  });
});
