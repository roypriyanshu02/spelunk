import { expect, test, describe, vi, beforeEach, afterEach } from "vitest";
import { runCliCommand } from "@core";

describe("runCliCommand", () => {
  let originalArgv: string[];
  let exitMock: any;
  let logMock: any;
  let errorMock: any;

  beforeEach(() => {
    originalArgv = process.argv;
    exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);
    logMock = vi.spyOn(console, "log").mockImplementation(() => {});
    errorMock = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  test("should successfully execute command with valid args", async () => {
    process.argv = ["node", "spelunk", "valid-arg"];
    const validate = vi.fn().mockReturnValue(true);
    const execute = vi.fn().mockResolvedValue("success-output");
    const formatMarkdown = vi.fn().mockReturnValue("formatted-markdown");

    await runCliCommand({
      name: "test-cmd",
      validate,
      execute,
      formatMarkdown,
    });

    expect(validate).toHaveBeenCalledWith({ format: "markdown" }, ["valid-arg"]);
    expect(execute).toHaveBeenCalledWith(expect.any(String), { format: "markdown" }, ["valid-arg"]);
    expect(formatMarkdown).toHaveBeenCalledWith("success-output", { format: "markdown" }, [
      "valid-arg",
    ]);
    expect(logMock).toHaveBeenCalledWith("formatted-markdown");
    expect(exitMock).not.toHaveBeenCalled();
  });

  test("should support json output format", async () => {
    process.argv = ["node", "spelunk", "valid-arg", "--format", "json"];
    const validate = vi.fn().mockReturnValue(true);
    const execute = vi.fn().mockResolvedValue({ some: "data" });
    const formatMarkdown = vi.fn();

    await runCliCommand({
      name: "test-cmd",
      validate,
      execute,
      formatMarkdown,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(String), { format: "json" }, ["valid-arg"]);
    expect(logMock).toHaveBeenCalledWith(JSON.stringify({ some: "data" }, null, 2));
    expect(formatMarkdown).not.toHaveBeenCalled();
  });

  test("should fail validation and exit 1 in markdown format", async () => {
    process.argv = ["node", "spelunk"];
    const validate = vi.fn().mockReturnValue("validation error");
    const execute = vi.fn();
    const formatMarkdown = vi.fn();

    await expect(
      runCliCommand({
        name: "test-cmd",
        validate,
        execute,
        formatMarkdown,
      }),
    ).rejects.toThrow("process.exit called");

    expect(errorMock).toHaveBeenCalledWith("test-cmd failed: validation error");
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(execute).not.toHaveBeenCalled();
  });

  test("should fail validation and output JSON error with exit 0 in json format", async () => {
    process.argv = ["node", "spelunk", "--format", "json"];
    const validate = vi.fn().mockReturnValue("validation error");
    const execute = vi.fn();
    const formatMarkdown = vi.fn();

    await expect(
      runCliCommand({
        name: "test-cmd",
        validate,
        execute,
        formatMarkdown,
      }),
    ).rejects.toThrow("process.exit called");

    expect(logMock).toHaveBeenCalledWith(
      JSON.stringify({ isError: true, message: "validation error" }, null, 2),
    );
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(execute).not.toHaveBeenCalled();
  });

  test("should not trigger json format if 'json' is just part of a query", async () => {
    process.argv = ["node", "spelunk", "--query", "json"];
    const validate = vi.fn().mockReturnValue(true);
    const execute = vi.fn().mockResolvedValue("success-output");
    const formatMarkdown = vi.fn().mockReturnValue("formatted-markdown");

    await runCliCommand({
      name: "test-cmd",
      options: { query: { type: "string" } },
      validate,
      execute,
      formatMarkdown,
    });

    expect(execute).toHaveBeenCalledWith(
      expect.any(String),
      { format: "markdown", query: "json" },
      [],
    );
    expect(logMock).toHaveBeenCalledWith("formatted-markdown");
    expect(exitMock).not.toHaveBeenCalled();
  });
});
