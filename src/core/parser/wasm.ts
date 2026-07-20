import Parser from "web-tree-sitter";
import path from "node:path";
import fs from "node:fs";
import { getWasmCacheDir, downloadWasmBinary, clearWasmCache } from "./downloader";

export { getWasmCacheDir, clearWasmCache, downloadWasmBinary };

/** Module live-bindings exported states */
export let isInitialized = false;
export let fallbackMode = false;
export let parserInstance: Parser | null = null;
export let consecutiveErrors = 0;

export const loadedLanguages = new Map<string, Parser.Language>();
const warnedLanguages = new Set<string>();

import wasmGrammarsData from "./wasm-grammars.json" with { type: "json" };

const wasmGrammars = wasmGrammarsData as Record<string, { sha256: string; extensions: string[] }>;

// Mapping of file extensions to WASM language files in tree-sitter-wasms
export const EXT_TO_WASM: Record<string, string> = {};

for (const [wasmFile, config] of Object.entries(wasmGrammars)) {
  if (config.extensions) {
    for (const ext of config.extensions) {
      EXT_TO_WASM[ext] = wasmFile;
    }
  }
}

// Resolves path to WASM files in dev, bun, node, or npx environments.
export function findWasmPath(relativePath: string, customDir?: string): string {
  const filename = path.basename(relativePath);
  const possiblePaths: string[] = [];

  if (customDir) {
    possiblePaths.push(path.join(customDir, filename));
  }
  const envWasmDir = process.env.SPELUNK_WASM_DIR;
  if (envWasmDir) {
    possiblePaths.push(path.join(envWasmDir, filename));
  }

  possiblePaths.push(path.join(getWasmCacheDir(customDir), filename));
  possiblePaths.push(path.join(import.meta.dirname, filename));
  possiblePaths.push(path.join(import.meta.dirname, "..", "..", "..", relativePath));
  possiblePaths.push(
    path.join(import.meta.dirname, "../../../..", relativePath.replace(/^node_modules\//, "")),
  );
  possiblePaths.push(path.resolve(relativePath));

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return path.join(getWasmCacheDir(customDir), filename);
}

/**
 * Initializes the tree-sitter WASM parser.
 * Locates tree-sitter.wasm and creates parserInstance.
 */
export async function initParser(
  customDir?: string,
  options?: { forceFallback?: boolean; offline?: boolean; wasmDir?: string },
) {
  if (isInitialized) return;

  const isForceFallback =
    options?.forceFallback ??
    (process.env.SPELUNK_FORCE_FALLBACK === "1" || process.env.SPELUNK_FORCE_FALLBACK === "true");
  if (isForceFallback) {
    fallbackMode = true;
    isInitialized = true;
    return;
  }

  try {
    let resolvedWasm = findWasmPath("node_modules/web-tree-sitter/tree-sitter.wasm", customDir);
    if (!fs.existsSync(resolvedWasm)) {
      const downloaded = await downloadWasmBinary("tree-sitter.wasm", customDir, options);
      if (downloaded) {
        resolvedWasm = downloaded;
      }
    }

    await Parser.init({
      locateFile() {
        return resolvedWasm;
      },
    });
    parserInstance = new Parser();
    isInitialized = true;
  } catch (err) {
    console.error(
      "[spelunk] Could not initialize web-tree-sitter WASM bindings. Falling back to empty parse.",
      err,
    );
    fallbackMode = true;
    isInitialized = true;
  }
}

/**
 * Returns a tree-sitter Language instance for the given file extension.
 * Loads from node_modules or local cache.
 *
 * @param ext File extension
 * @returns Tree-sitter Language, or null if load fails
 */
export async function getLanguage(
  ext: string,
  customDir?: string,
  options?: { forceFallback?: boolean; offline?: boolean; wasmDir?: string },
): Promise<Parser.Language | null> {
  const isForceFallback =
    options?.forceFallback ??
    (process.env.SPELUNK_FORCE_FALLBACK === "1" || process.env.SPELUNK_FORCE_FALLBACK === "true");
  if (isForceFallback) {
    return null;
  }

  const wasmFile = EXT_TO_WASM[ext];
  if (!wasmFile) return null;

  if (loadedLanguages.has(wasmFile)) {
    return loadedLanguages.get(wasmFile)!;
  }

  let localWasmPath = findWasmPath(
    path.join("node_modules/tree-sitter-wasms/out", wasmFile),
    customDir,
  );

  if (fs.existsSync(localWasmPath)) {
    try {
      const lang = await Parser.Language.load(localWasmPath);
      loadedLanguages.set(wasmFile, lang);
      return lang;
    } catch (err) {
      console.warn(`[spelunk] Warning: Local grammar load failed for ${wasmFile}. Unlinking.`, err);
      try {
        fs.unlinkSync(localWasmPath);
      } catch {}
    }
  }

  // If local file missing or corrupt (unlinked), attempt download
  const downloadedPath = await downloadWasmBinary(wasmFile, customDir, options);
  if (downloadedPath && fs.existsSync(downloadedPath)) {
    try {
      const lang = await Parser.Language.load(downloadedPath);
      loadedLanguages.set(wasmFile, lang);
      return lang;
    } catch {
      try {
        fs.unlinkSync(downloadedPath);
      } catch {}
    }
  }

  // Deduplicated warning when falling back to regex
  if (!warnedLanguages.has(ext) && !warnedLanguages.has(wasmFile)) {
    warnedLanguages.add(ext);
    warnedLanguages.add(wasmFile);
    console.warn(
      "[spelunk] Warning: Failed to load AST grammar for " +
        ext +
        " (" +
        wasmFile +
        "). Falling back to regex parsing.",
    );
  }

  return null;
}

/**
 * Resets the WASM parser, clearing cached language modules, closing the active parser instance,
 * and resetting error tracking and fallback flags.
 */
export function resetWasmParser() {
  isInitialized = false;
  fallbackMode = false;
  if (parserInstance) {
    try {
      parserInstance.delete();
    } catch {}
  }
  parserInstance = null;
  consecutiveErrors = 0;
  loadedLanguages.clear();
  warnedLanguages.clear();
}

/**
 * Increments the consecutive error count. If the error threshold is exceeded,
 * the active parser instance is recycled to prevent memory leaks and recover state.
 */
export function incrementConsecutiveErrors() {
  consecutiveErrors++;
  if (consecutiveErrors > 50) {
    console.error("Recycled parser instance after 50 consecutive syntax errors.");
    if (parserInstance) {
      try {
        parserInstance.delete();
      } catch {}
    }
    parserInstance = new Parser();
    consecutiveErrors = 0;
  }
}

/**
 * Resets the consecutive error count back to zero upon a successful parse action.
 */
export function resetConsecutiveErrors() {
  consecutiveErrors = 0;
}
