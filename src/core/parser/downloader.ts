import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import wasmGrammarsData from "./wasm-grammars.json" with { type: "json" };

const wasmGrammars = wasmGrammarsData as Record<string, { sha256: string; extensions: string[] }>;
const wasmChecksums: Record<string, string> = {};
for (const [file, config] of Object.entries(wasmGrammars)) {
  if (config.sha256) {
    wasmChecksums[file] = config.sha256;
  }
}
const inFlightDownloads = new Map<string, Promise<string | null>>();

export function getWasmCacheDir(customDir?: string, options?: { wasmDir?: string }): string {
  let resolved: string;
  if (customDir) {
    resolved = path.resolve(customDir);
  } else if (options?.wasmDir) {
    resolved = path.resolve(options.wasmDir);
  } else if (process.env.SPELUNK_WASM_DIR) {
    resolved = path.resolve(process.env.SPELUNK_WASM_DIR);
  } else if (process.env.XDG_CACHE_HOME) {
    resolved = path.join(path.resolve(process.env.XDG_CACHE_HOME), "spelunk", "wasm");
  } else if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    resolved = path.join(localAppData, "spelunk", "wasm");
  } else {
    resolved = path.join(os.homedir(), ".cache", "spelunk", "wasm");
  }

  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

export function clearWasmCache(customDir?: string): void {
  const cacheDir = getWasmCacheDir(customDir);
  if (fs.existsSync(cacheDir)) {
    const files = fs.readdirSync(cacheDir);
    for (const file of files) {
      const filePath = path.join(cacheDir, file);
      try {
        fs.rmSync(filePath, { recursive: true, force: true });
      } catch {}
    }
  }
}

async function computeFileHash(filePath: string): Promise<string> {
  const content = await fs.promises.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function downloadWasmBinary(
  wasmFilename: string,
  customDir?: string,
  options?: { forceFallback?: boolean; offline?: boolean; wasmDir?: string },
): Promise<string | null> {
  const cacheDir = getWasmCacheDir(customDir, options);
  const targetPath = path.join(cacheDir, wasmFilename);
  const expectedHash = wasmChecksums[wasmFilename];

  if (inFlightDownloads.has(wasmFilename)) {
    return inFlightDownloads.get(wasmFilename)!;
  }

  const downloadPromise = (async (): Promise<string | null> => {
    let exists = false;
    try {
      await fs.promises.access(targetPath);
      exists = true;
    } catch {}

    if (exists) {
      const actualHash = await computeFileHash(targetPath);
      if (!expectedHash || actualHash === expectedHash) {
        return targetPath;
      }
      console.warn(
        `[spelunk] Warning: Cached file ${wasmFilename} hash verification failed. Unlinking.`,
      );
      try {
        await fs.promises.unlink(targetPath);
      } catch {}
    }

    const isOffline =
      options?.offline ??
      (process.env.SPELUNK_OFFLINE === "1" || process.env.SPELUNK_OFFLINE === "true");
    if (isOffline) {
      return null;
    }

    let tempPath: string | null = null;
    try {
      const url =
        wasmFilename === "tree-sitter.wasm"
          ? "https://cdn.jsdelivr.net/npm/web-tree-sitter@0.23.2/tree-sitter.wasm"
          : `https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out/${wasmFilename}`;

      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const randomHex = crypto.randomBytes(8).toString("hex");
      tempPath = path.join(cacheDir, `.tmp-${randomHex}`);

      await fs.promises.writeFile(tempPath, Buffer.from(buffer));

      const actualHash = await computeFileHash(tempPath);
      if (!expectedHash || actualHash === expectedHash) {
        await fs.promises.rename(tempPath, targetPath);
        tempPath = null;
        return targetPath;
      } else {
        throw new Error(`Cryptographic hash verification failed for ${wasmFilename}.`);
      }
    } catch (err: any) {
      console.warn(
        `[spelunk] Warning: Failed to download or verify ${wasmFilename}: ${err.message}`,
      );
      if (tempPath) {
        let tempExists = false;
        try {
          await fs.promises.access(tempPath);
          tempExists = true;
        } catch {}
        if (tempExists) {
          try {
            await fs.promises.unlink(tempPath);
          } catch {}
        }
      }
      return null;
    }
  })();

  inFlightDownloads.set(wasmFilename, downloadPromise);

  downloadPromise.finally(() => {
    inFlightDownloads.delete(wasmFilename);
  });

  return downloadPromise;
}
