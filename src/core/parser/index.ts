/**
 * @file index.ts
 * @description Entry point for the parser. Chooses between AST and custom regex-based parsers.
 */

import path from "node:path";
import Parser from "web-tree-sitter";
import {
  initParser,
  getLanguage,
  resetWasmParser,
  fallbackMode,
  parserInstance,
  EXT_TO_WASM,
  incrementConsecutiveErrors,
  resetConsecutiveErrors,
} from "./wasm";
import { isCustomFile, parseCustomFile } from "./custom";
import { extractASTData } from "./ast";

/**
 * Parses a file to extract its imports and exports.
 * Chooses between AST parsing (tree-sitter) and custom regex-based parsing.
 *
 * @param filePath File path to parse
 * @param content File content
 * @returns Imports and exports lists
 */
export async function parseFile(
  filePath: string,
  content: string,
): Promise<{ imports: string[]; exports: string[] }> {
  if (isCustomFile(filePath)) {
    return parseCustomFile(filePath, content);
  }

  await initParser();

  let ext = path.extname(filePath).toLowerCase();
  const filename = path.basename(filePath).toLowerCase();
  if (filePath.toLowerCase().endsWith(".blade.php")) {
    ext = ".blade.php";
  } else if (["podfile", "gemfile", "fastfile", "appfile"].includes(filename)) {
    ext = ".rb";
  }

  if (fallbackMode || !parserInstance || !EXT_TO_WASM[ext]) {
    return { imports: [], exports: [] };
  }

  const lang = await getLanguage(ext);
  if (!lang) {
    return { imports: [], exports: [] };
  }

  let tree: Parser.Tree | null = null;
  try {
    parserInstance.setLanguage(lang);
    tree = parserInstance.parse(content);
    resetConsecutiveErrors();

    return extractASTData(ext, tree);
  } catch (err) {
    incrementConsecutiveErrors();
    console.error(`AST parsing failed for ${filePath}.`, err);
    return { imports: [], exports: [] };
  } finally {
    if (tree) {
      try {
        tree.delete();
      } catch (e) {
        console.error("Failed to release AST memory:", e);
      }
    }
  }
}

/**
 * Resets parser state and releases memory.
 */
export function resetParser() {
  resetWasmParser();
}
