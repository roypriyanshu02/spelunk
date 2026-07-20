import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const dummyBuffer = Buffer.from("dummy-wasm-binary");
const expectedHash = crypto.createHash("sha256").update(dummyBuffer).digest("hex");

vi.mock("../../src/core/parser/wasm-grammars.json", () => {
  const dummyBuf = Buffer.from("dummy-wasm-binary");
  const hash = crypto.createHash("sha256").update(dummyBuf).digest("hex");
  return {
    default: {
      "tree-sitter-bash.wasm": {
        sha256: hash,
        extensions: [".sh", ".bash"],
      },
      "tree-sitter-c.wasm": {
        sha256: hash,
        extensions: [".c"],
      },
    },
  };
});

import { getWasmCacheDir, clearWasmCache, downloadWasmBinary } from "../../src/core/parser/wasm";

describe("downloader", () => {
  const ORIGINAL_ENV = process.env;
  let testTmpDir: string;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spelunk-downloader-test-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  });

  describe("getWasmCacheDir resolution", () => {
    test("resolves customDir when provided and ensures directory exists", () => {
      const customPath = path.join(testTmpDir, "custom-cache");
      expect(fs.existsSync(customPath)).toBe(false);

      const resolved = getWasmCacheDir(customPath);

      expect(resolved).toBe(customPath);
      expect(fs.existsSync(customPath)).toBe(true);
    });

    test("resolves SPELUNK_WASM_DIR env var when no customDir provided", () => {
      const envPath = path.join(testTmpDir, "env-cache");
      process.env.SPELUNK_WASM_DIR = envPath;
      delete process.env.XDG_CACHE_HOME;

      const resolved = getWasmCacheDir();

      expect(resolved).toBe(envPath);
      expect(fs.existsSync(envPath)).toBe(true);
    });

    test("resolves default cache path when customDir and SPELUNK_WASM_DIR are not set", () => {
      delete process.env.SPELUNK_WASM_DIR;
      delete process.env.XDG_CACHE_HOME;

      const mockHome = path.join(testTmpDir, "mock-home");
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(mockHome);

      if (process.platform === "win32") {
        const localAppData = path.join(mockHome, "AppData", "Local");
        vi.stubEnv("LOCALAPPDATA", localAppData);
        const resolvedWin = getWasmCacheDir();
        expect(resolvedWin).toBe(path.join(localAppData, "spelunk", "wasm"));
        expect(fs.existsSync(resolvedWin)).toBe(true);
      } else {
        const resolved = getWasmCacheDir();
        expect(resolved).toBe(path.join(mockHome, ".cache", "spelunk", "wasm"));
        expect(fs.existsSync(resolved)).toBe(true);
      }

      homedirSpy.mockRestore();
      vi.unstubAllEnvs();
    });

    test("resolves XDG_CACHE_HOME when process.env.XDG_CACHE_HOME is set", () => {
      delete process.env.SPELUNK_WASM_DIR;
      const xdgPath = path.join(testTmpDir, "xdg-cache");
      process.env.XDG_CACHE_HOME = xdgPath;

      const resolved = getWasmCacheDir();

      expect(resolved).toBe(path.join(xdgPath, "spelunk", "wasm"));
      expect(fs.existsSync(resolved)).toBe(true);
    });
  });

  describe("SHA-256 checksum verification", () => {
    const wasmFilename = "tree-sitter-bash.wasm";

    test("valid hash in pre-existing cached file passes and returns target path", async () => {
      const customDir = path.join(testTmpDir, "valid-cached");
      getWasmCacheDir(customDir);
      const targetPath = path.join(customDir, wasmFilename);

      fs.writeFileSync(targetPath, dummyBuffer);

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await downloadWasmBinary(wasmFilename, customDir);

      expect(result).toBe(targetPath);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fs.existsSync(targetPath)).toBe(true);
    });

    test("valid hash in downloaded file passes verification and saves file", async () => {
      const customDir = path.join(testTmpDir, "valid-download");
      const targetPath = path.join(customDir, wasmFilename);

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          dummyBuffer.buffer.slice(
            dummyBuffer.byteOffset,
            dummyBuffer.byteOffset + dummyBuffer.byteLength,
          ),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await downloadWasmBinary(wasmFilename, customDir);

      expect(result).toBe(targetPath);
      expect(fs.existsSync(targetPath)).toBe(true);
      const fileContent = fs.readFileSync(targetPath);
      const actualHash = crypto.createHash("sha256").update(fileContent).digest("hex");
      expect(actualHash).toBe(expectedHash);
    });

    test("tampered pre-existing cached file is unlinked", async () => {
      const customDir = path.join(testTmpDir, "tampered-cache");
      getWasmCacheDir(customDir);
      const targetPath = path.join(customDir, wasmFilename);

      // Write corrupt data to cache
      fs.writeFileSync(targetPath, Buffer.from("corrupted wasm binary payload"));

      // Enable offline mode so it doesn't attempt to re-download after unlinking
      process.env.SPELUNK_OFFLINE = "1";

      const result = await downloadWasmBinary(wasmFilename, customDir);

      expect(result).toBeNull();
      expect(fs.existsSync(targetPath)).toBe(false);
    });

    test("tampered downloaded file fails verification and temp file is unlinked", async () => {
      const customDir = path.join(testTmpDir, "tampered-download");
      const corruptBuffer = Buffer.from("tampered payload content");

      let writtenTempPath: string | null = null;
      const originalWriteFile = fs.promises.writeFile;

      vi.spyOn(fs.promises, "writeFile").mockImplementation((p, data, options) => {
        if (typeof p === "string" && p.includes(".tmp-")) {
          writtenTempPath = p;
        }
        return originalWriteFile(p, data, options);
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          corruptBuffer.buffer.slice(
            corruptBuffer.byteOffset,
            corruptBuffer.byteOffset + corruptBuffer.byteLength,
          ),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await downloadWasmBinary(wasmFilename, customDir);

      expect(result).toBeNull();
      expect(fs.existsSync(path.join(customDir, wasmFilename))).toBe(false);
      expect(writtenTempPath).not.toBeNull();
      // Verify temp file was unlinked and no longer exists
      expect(fs.existsSync(writtenTempPath!)).toBe(false);
    });
  });

  describe("clearWasmCache functionality", () => {
    test("deletes all files in the WASM cache directory", () => {
      const customDir = path.join(testTmpDir, "clear-cache-test");
      getWasmCacheDir(customDir);

      const file1 = path.join(customDir, "file1.wasm");
      const file2 = path.join(customDir, "file2.wasm");
      fs.writeFileSync(file1, "content1");
      fs.writeFileSync(file2, "content2");

      expect(fs.readdirSync(customDir).length).toBe(2);

      clearWasmCache(customDir);

      expect(fs.existsSync(customDir)).toBe(true);
      expect(fs.readdirSync(customDir).length).toBe(0);
    });
  });

  describe("in-flight request deduplication", () => {
    test("simultaneous calls deduplicate requests and return same resolution", async () => {
      const customDir = path.join(testTmpDir, "dedup-test");
      const wasmFilename = "tree-sitter-c.wasm";

      let resolveFetch: (val: any) => void;
      const fetchPromise = new Promise((resolve) => {
        resolveFetch = resolve;
      });

      const fetchMock = vi.fn().mockImplementation(() => fetchPromise);
      vi.stubGlobal("fetch", fetchMock);

      const promise1 = downloadWasmBinary(wasmFilename, customDir);
      const promise2 = downloadWasmBinary(wasmFilename, customDir);

      // Resolve the fetch call
      resolveFetch!({
        ok: true,
        arrayBuffer: async () =>
          dummyBuffer.buffer.slice(
            dummyBuffer.byteOffset,
            dummyBuffer.byteOffset + dummyBuffer.byteLength,
          ),
      });

      const [res1, res2] = await Promise.all([promise1, promise2]);

      expect(res1).toBe(res2);
      expect(res1).toBe(path.join(customDir, wasmFilename));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("SPELUNK_OFFLINE mode", () => {
    test("prevents network requests when SPELUNK_OFFLINE is set", async () => {
      const customDir = path.join(testTmpDir, "offline-test");
      process.env.SPELUNK_OFFLINE = "1";

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await downloadWasmBinary("tree-sitter-go.wasm", customDir);

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("prevents network requests when SPELUNK_OFFLINE is set to 'true'", async () => {
      const customDir = path.join(testTmpDir, "offline-true-test");
      process.env.SPELUNK_OFFLINE = "true";

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await downloadWasmBinary("tree-sitter-rust.wasm", customDir);

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
