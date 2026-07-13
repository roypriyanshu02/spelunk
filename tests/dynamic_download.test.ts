import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock node:fs globally to hide tree-sitter-json.wasm from parser
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    default: {
      ...original.default,
      existsSync: (p: any) => {
        const pStr = String(p);
        if (pStr.includes("tree-sitter-wasms/out/tree-sitter-json.wasm")) {
          return false;
        }
        return original.existsSync(p);
      },
      promises: {
        ...original.default.promises,
        access: async (p: any) => {
          const pStr = String(p);
          if (pStr.includes("tree-sitter-wasms/out/tree-sitter-json.wasm")) {
            throw new Error("File not found (mocked)");
          }
          return original.default.promises.access(p);
        },
      },
    },
    existsSync: (p: any) => {
      const pStr = String(p);
      if (pStr.includes("tree-sitter-wasms/out/tree-sitter-json.wasm")) {
        return false;
      }
      return original.existsSync(p);
    },
    promises: {
      ...original.promises,
      access: async (p: any) => {
        const pStr = String(p);
        if (pStr.includes("tree-sitter-wasms/out/tree-sitter-json.wasm")) {
          throw new Error("File not found (mocked)");
        }
        return original.promises.access(p);
      },
    },
  };
});

import { parseFile, resetParser } from "@core";

const TEST_CACHE_DIR = path.join(os.tmpdir(), `spelunk-test-cache-${Date.now()}`);

describe("Dynamic WASM Download and Caching", () => {
  beforeEach(() => {
    resetParser();
    process.env.SPELUNK_CACHE_DIR = TEST_CACHE_DIR;
    if (fs.existsSync(TEST_CACHE_DIR)) {
      fs.rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    resetParser();
    if (fs.existsSync(TEST_CACHE_DIR)) {
      fs.rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  test("downloads, cryptographically verifies, caches, and loads WASM grammar", async () => {
    // 1. Read real local json wasm to use as mock response
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const jsonWasmPath = path.join(
      projectRoot,
      "node_modules/tree-sitter-wasms/out/tree-sitter-json.wasm",
    );
    // Use original fs reference to read the file
    const jsonWasmBuffer = fs.readFileSync(jsonWasmPath);

    // Mock fetch to return the real wasm buffer
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const ab = new Uint8Array(jsonWasmBuffer).buffer;
      return {
        ok: true,
        arrayBuffer: async () => ab,
      } as any;
    });

    // 2. Perform parse (which should trigger download and load)
    const result = await parseFile("test.json", `{"foo": "bar"}`);
    expect(result).toBeDefined();

    // 3. Verify fetch was invoked
    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("tree-sitter-json.wasm");

    // 4. Verify file was saved in the cache directory
    const cachedFilePath = path.join(TEST_CACHE_DIR, "tree-sitter-json.wasm");
    expect(fs.existsSync(cachedFilePath)).toBe(true);

    // Verify hash of saved file matches real file
    const savedBuffer = fs.readFileSync(cachedFilePath);
    expect(savedBuffer.equals(jsonWasmBuffer)).toBe(true);
  });
});
