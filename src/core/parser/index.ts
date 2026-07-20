import path from "node:path";
import Parser from "web-tree-sitter";
import {
  initParser,
  getLanguage,
  resetWasmParser,
  fallbackMode,
  EXT_TO_WASM,
  incrementConsecutiveErrors,
  resetConsecutiveErrors,
  parserInstance,
} from "./wasm";
export { getWasmCacheDir, downloadWasmBinary, clearWasmCache } from "./wasm";
import { isCustomFile, parseCustomFile, parseFallback } from "./custom";
import { extractASTData, astExtensions } from "./ast";

/**
 * Normalizes file extensions for routing to the correct parser.
 *
 * @param filePath File path
 * @returns Normalized extension
 */
export function resolveFileExtension(filePath: string): string {
  let ext = path.extname(filePath).toLowerCase();
  const filename = path.basename(filePath).toLowerCase();
  if (filePath.toLowerCase().endsWith(".blade.php")) {
    ext = ".blade.php";
  } else if (["podfile", "gemfile", "fastfile", "appfile"].includes(filename)) {
    ext = ".rb";
  }
  return ext;
}

/**
 * Parses a file to extract its imports and exports.
 * Chooses between AST parsing (tree-sitter) and custom regex-based parsing.
 *
 * @param filePath File path to parse
 * @param content File content
 * @param options Parser options
 * @returns Imports and exports lists
 */
export async function parseFile(
  filePath: string,
  content: string,
  options?: { wasmDir?: string; offline?: boolean; forceFallback?: boolean },
): Promise<{ imports: string[]; exports: string[] }> {
  if (isCustomFile(filePath)) {
    return parseCustomFile(filePath, content);
  }

  const ext = resolveFileExtension(filePath);

  if (fallbackMode || !EXT_TO_WASM[ext] || !astExtensions.has(ext)) {
    return parseFallback(ext, content);
  }

  try {
    await initParser(options?.wasmDir, options);
  } catch {
    return parseFallback(ext, content);
  }

  if (fallbackMode || !parserInstance) {
    return parseFallback(ext, content);
  }

  const parser = parserInstance;

  try {
    const lang = await getLanguage(ext, options?.wasmDir, options);
    if (!lang) {
      return parseFallback(ext, content);
    }

    let tree: Parser.Tree | null = null;
    try {
      parser.setLanguage(lang);
      tree = parser.parse(content);
      resetConsecutiveErrors();

      return extractASTData(ext, tree);
    } catch (err) {
      incrementConsecutiveErrors();
      console.error(`AST parsing failed for ${filePath}.`, err);
      return parseFallback(ext, content);
    } finally {
      if (tree) {
        try {
          tree.delete();
        } catch (e) {
          console.error("Failed to release AST memory:", e);
        }
      }
    }
  } catch {
    return parseFallback(ext, content);
  }
}

/**
 * Resets parser state and releases memory.
 */
export function resetParser() {
  resetWasmParser();
}
