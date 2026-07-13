/**
 * @file wasm.ts
 * @description Initializes web-tree-sitter, loads WASM language grammars, and verifies their SHA-256 hashes.
 */

import Parser from "web-tree-sitter";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";

/** True if the tree-sitter WASM engine has initialized. */
export let isInitialized = false;
/** True if the parser uses fallback mode due to initialization failure. */
export let fallbackMode = false;
/** The active Parser instance. */
export let parserInstance: Parser | null = null;
/** Number of consecutive parsing errors. */
export let consecutiveErrors = 0;

// Mapping of file extensions to WASM language files in tree-sitter-wasms
export const EXT_TO_WASM: Record<string, string> = {
  ".js": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript.wasm",
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".mts": "tree-sitter-typescript.wasm",
  ".cts": "tree-sitter-typescript.wasm",
  ".py": "tree-sitter-python.wasm",
  ".pyi": "tree-sitter-python.wasm",
  ".pyw": "tree-sitter-python.wasm",
  ".go": "tree-sitter-go.wasm",
  ".rs": "tree-sitter-rust.wasm",
  ".c": "tree-sitter-c.wasm",
  ".cpp": "tree-sitter-cpp.wasm",
  ".cc": "tree-sitter-cpp.wasm",
  ".hh": "tree-sitter-cpp.wasm",
  ".hxx": "tree-sitter-cpp.wasm",
  ".h++": "tree-sitter-cpp.wasm",
  ".c++": "tree-sitter-cpp.wasm",
  ".h": "tree-sitter-cpp.wasm",
  ".hpp": "tree-sitter-cpp.wasm",
  ".inl": "tree-sitter-cpp.wasm",
  ".ipp": "tree-sitter-cpp.wasm",
  ".cs": "tree-sitter-c_sharp.wasm",
  ".java": "tree-sitter-java.wasm",
  ".kt": "tree-sitter-kotlin.wasm",
  ".kts": "tree-sitter-kotlin.wasm",
  ".swift": "tree-sitter-swift.wasm",
  ".rb": "tree-sitter-ruby.wasm",
  ".gemspec": "tree-sitter-ruby.wasm",
  ".rake": "tree-sitter-ruby.wasm",
  ".php": "tree-sitter-php.wasm",
  ".php5": "tree-sitter-php.wasm",
  ".lua": "tree-sitter-lua.wasm",
  ".sh": "tree-sitter-bash.wasm",
  ".bash": "tree-sitter-bash.wasm",
  ".zsh": "tree-sitter-bash.wasm",
  ".command": "tree-sitter-bash.wasm",
  ".ex": "tree-sitter-elixir.wasm",
  ".exs": "tree-sitter-elixir.wasm",
  ".json": "tree-sitter-json.wasm",
  ".toml": "tree-sitter-toml.wasm",
  ".yaml": "tree-sitter-yaml.wasm",
  ".yml": "tree-sitter-yaml.wasm",
  ".html": "tree-sitter-html.wasm",
  ".htm": "tree-sitter-html.wasm",
  ".css": "tree-sitter-css.wasm",
  ".vue": "tree-sitter-vue.wasm",
  ".dart": "tree-sitter-dart.wasm",
};

// Cache loaded languages
const loadedLanguages = new Map<string, any>();

// Resolves path to WASM files in dev, bun, node, or npx environments.
function findWasmPath(relativePath: string): string {
  const possiblePaths = [
    // 1. Local development path (from src/core/parser.ts to node_modules/...)
    path.join(import.meta.dirname, "..", "..", "..", relativePath),
    // 2. npm/npx hoisting path (from dist/index.js to ../../...)
    path.join(import.meta.dirname, "../../../..", relativePath.replace("node_modules/", "")),
    // 3. Bundled script path fallback (wasm files next to the script in scripts/)
    path.join(import.meta.dirname, path.basename(relativePath)),
    // 4. Fallback to CWD node_modules
    path.resolve(relativePath),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Last ditch effort: search node_modules up the folder tree
  let currentDir = import.meta.dirname || process.cwd();
  while (true) {
    const candidate = path.join(currentDir, relativePath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  console.warn(`WASM file not found at ${relativePath}. Trying fallback path.`);
  return path.resolve(relativePath);
}

/**
 * Initializes the tree-sitter WASM parser.
 * Locates tree-sitter.wasm and creates parserInstance.
 */
export async function initParser() {
  if (isInitialized) return;
  try {
    const resolvedWasm = findWasmPath("node_modules/web-tree-sitter/tree-sitter.wasm");
    await Parser.init({
      locateFile() {
        return resolvedWasm;
      },
    });
    parserInstance = new Parser();
    isInitialized = true;
  } catch (err) {
    console.error(
      "Could not initialize web-tree-sitter WASM bindings. Falling back to empty parse.",
      err,
    );
    fallbackMode = true;
    isInitialized = true;
  }
}

function getCacheDir(): string {
  return process.env.SPELUNK_CACHE_DIR || path.join(os.homedir(), ".cache", "spelunk", "wasm");
}

const KNOWN_HASHES: Record<string, string> = {
  "tree-sitter-bash.wasm": "807dcdb1380a59befb112ed8fbd3d3872c7fadaf5903a769282b50973b30696d",
  "tree-sitter-c.wasm": "056b25072382f72deee2c64ec238ffc4bb8cf42844ef21502c0e70f03a8a0d66",
  "tree-sitter-c_sharp.wasm": "6266a7e32d68a3459104d994dc848df15d5672b0ea8e86d327274b694f8e6991",
  "tree-sitter-cpp.wasm": "f6afdf53bfd6de76557bb7edb624a3a3869e14d9a83b78433f93617ecee42527",
  "tree-sitter-css.wasm": "5fc615467b1b98420ed7517e5bf9e1f88468132dd903d842dfb13714f6a1cb0c",
  "tree-sitter-dart.wasm": "7f5364e4256cf7e55efd01dd52421ef2663caa8061b82659b7e4bf61064545ec",
  "tree-sitter-elisp.wasm": "deedb03ccf150329ddfcc4ed92861c235bbae6f9692be6b93cac71617a4d42ab",
  "tree-sitter-elixir.wasm": "82e91b9759ddca30d8978ebbfa8e347b4451b64c931f9ae62112e6db9b8fac20",
  "tree-sitter-elm.wasm": "962b8668a0e16a6fb1fe232ba3e07ba4537a6b72c47293fddea0f6ea6ff9912e",
  "tree-sitter-embedded_template.wasm":
    "68584527f712dbf2cc39776c56980c08516991f184a4a17bb67c2f436f0fc373",
  "tree-sitter-go.wasm": "9963ca89b616eaf04b08a43bc1fb0f07b85395bec313330851f1f1ead2f755b6",
  "tree-sitter-html.wasm": "11b3405c1543fb012f5ed7f8ee73125076dce8b168301e1e787e4c717da6b456",
  "tree-sitter-java.wasm": "637aac4415fb39a211a4f4292d63c66b5ce9c32fa2cd35464af4f681d91b9a1f",
  "tree-sitter-javascript.wasm": "63812b9e275d26851264734868d27a1656bd44a2ef6eb3e85e6b03728c595ab5",
  "tree-sitter-json.wasm": "fdb5219abe058369e16897aaa11eecf47ef4f546752c3ddbac339cdd89e1e667",
  "tree-sitter-kotlin.wasm": "b5cb00c8d06ed0f10f1dbe497205b437809d7e87db1f638721a8cfb30e044449",
  "tree-sitter-lua.wasm": "75ef809136d610068c5b2135741d89f5df62690a3d55169203351cb7cc85727d",
  "tree-sitter-objc.wasm": "7c1b5bfdca7e64b6c63b6040bb7ba0afc347df116f9030ca32f8535d7377f6ff",
  "tree-sitter-ocaml.wasm": "60849b6320ee956233d77b017c65c45660e507d03ae70aa1bd5783458e2e9e18",
  "tree-sitter-php.wasm": "55bb617b6f01e14bab997861f0b20a2420cf6ba3199ffeb295b9ec398966d8a3",
  "tree-sitter-python.wasm": "9056d0fb0c337810d019fae350e8167786119da98f0f282aceae7ab89ee8253b",
  "tree-sitter-ql.wasm": "836b2a51f6b2b4605ef7bfa908b978fed0fe838afb4eabaa9451552f12e953c1",
  "tree-sitter-rescript.wasm": "ae18d46336768b6c0eea07eb0b003408848766b3b67df1d807b40cbd93017bda",
  "tree-sitter-ruby.wasm": "93a5022855314cdb45458c7bb026a24a0ebc3a5ff6439e542e881f14dfa13a39",
  "tree-sitter-rust.wasm": "4409921a70d0aa5bec7d1d7ce809a557a8ee1cf6ace901e3ac6a76e62cfea903",
  "tree-sitter-scala.wasm": "160cfbb8ff7220886e99ed9699abceb6d837b4cd28993b9282c7f445a0554abd",
  "tree-sitter-solidity.wasm": "160745e470f234cae903a9ba445d19e758d0b02e1197401fc765976c6254d2b6",
  "tree-sitter-swift.wasm": "41c4fdb2249a3aa6d87eed0d383081ff09725c2248b4977043a43825980ffcc7",
  "tree-sitter-systemrdl.wasm": "09129542bbea6d19aa33b54f93bae2b41128144970be13ce09af6697146c4527",
  "tree-sitter-tlaplus.wasm": "72a07f94b0bc88b9123a6e41058e37ab9ca70d84a03b79511b25af7f435129b5",
  "tree-sitter-toml.wasm": "7849ac8ce9d10a4684ca189ea8ad3654c20c38acb2d674a014a164398cbd37a2",
  "tree-sitter-tsx.wasm": "6aa3b2c70e76f5d48eafef1093e9c4de383e13f2fdde2f4e9b98a378f6a8f1b6",
  "tree-sitter-typescript.wasm": "8515404dceed38e1ed86aa34b09fcf3379fff1b4ff9dd3967bcd6d1eb5ac3d8f",
  "tree-sitter-vue.wasm": "6244521bb3fb60f34ce5f677f2af81facb2c38691193985ca5fa85e1b6f29250",
  "tree-sitter-yaml.wasm": "5dea7cfff83d41d8f87fb8e434e1a5b292c0d670bfcdc42cb2af420ef490dde5",
  "tree-sitter-zig.wasm": "59cc4531aa661e2de4c5bc04e4045b6bdd5d2bfa75045cbda5f673102d140eef",
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function verifyFileHash(filePath: string, expectedHash: string): Promise<boolean> {
  if (!(await fileExists(filePath))) return false;
  try {
    const content = await fs.promises.readFile(filePath);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    return hash === expectedHash;
  } catch {
    return false;
  }
}

async function downloadWasm(
  wasmFile: string,
  targetPath: string,
  expectedHash: string,
): Promise<boolean> {
  const version = "0.1.13";
  const urls = [
    `https://cdn.jsdelivr.net/npm/tree-sitter-wasms@${version}/out/${wasmFile}`,
    `https://unpkg.com/tree-sitter-wasms@${version}/out/${wasmFile}`,
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      const hash = crypto.createHash("sha256").update(buffer).digest("hex");
      if (hash === expectedHash) {
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.promises.writeFile(targetPath, buffer);
        return true;
      } else {
        console.warn(
          `Hash mismatch for downloaded ${wasmFile} from ${url}. Expected ${expectedHash}, got ${hash}`,
        );
      }
    } catch (err) {
      console.warn(`Failed to download ${wasmFile} from ${url}:`, err);
    }
  }
  return false;
}

/**
 * Returns a tree-sitter Language instance for the given file extension.
 * Loads from node_modules, local cache, or downloads from CDN.
 *
 * @param ext File extension
 * @returns Tree-sitter Language, or null if load fails
 */
export async function getLanguage(ext: string): Promise<any> {
  const wasmFile = EXT_TO_WASM[ext];
  if (!wasmFile) return null;

  if (loadedLanguages.has(wasmFile)) {
    return loadedLanguages.get(wasmFile);
  }

  const expectedHash = KNOWN_HASHES[wasmFile];
  if (!expectedHash) {
    console.error(`No known hash for WASM grammar: ${wasmFile}`);
    return null;
  }

  // 1. Try local node_modules / build path (development path)
  const localWasmPath = findWasmPath(path.join("node_modules/tree-sitter-wasms/out", wasmFile));
  if (await fileExists(localWasmPath)) {
    if (await verifyFileHash(localWasmPath, expectedHash)) {
      try {
        const lang = await Parser.Language.load(localWasmPath);
        loadedLanguages.set(wasmFile, lang);
        return lang;
      } catch (err) {
        console.error(`Could not load local grammar ${wasmFile}:`, err);
      }
    } else {
      console.warn(`Local grammar ${wasmFile} hash mismatch. Trying cache.`);
    }
  }

  // 2. Try cache directory
  const cachedWasmPath = path.join(getCacheDir(), wasmFile);
  if (await fileExists(cachedWasmPath)) {
    if (await verifyFileHash(cachedWasmPath, expectedHash)) {
      try {
        const lang = await Parser.Language.load(cachedWasmPath);
        loadedLanguages.set(wasmFile, lang);
        return lang;
      } catch (err) {
        console.error(`Could not load cached grammar ${wasmFile}:`, err);
      }
    } else {
      console.warn(`Cached grammar ${wasmFile} hash mismatch. Deleting corrupted file.`);
      try {
        await fs.promises.unlink(cachedWasmPath);
      } catch (err: any) {
        console.warn(`Failed to remove corrupted WASM file ${cachedWasmPath}: ${err.message}`);
      }
    }
  }

  // 3. Download to cache
  console.log(`Downloading Tree-sitter grammar: ${wasmFile}...`);
  const downloaded = await downloadWasm(wasmFile, cachedWasmPath, expectedHash);
  if (downloaded) {
    try {
      const lang = await Parser.Language.load(cachedWasmPath);
      loadedLanguages.set(wasmFile, lang);
      return lang;
    } catch (err) {
      console.error(`Could not load downloaded grammar ${wasmFile}:`, err);
    }
  }

  console.warn(`Grammar download/load failed for ${wasmFile}. Falling back to empty parse.`);
  return null;
}

/**
 * Resets the WASM parser, freeing memory and clearing the language cache.
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
}

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

export function resetConsecutiveErrors() {
  consecutiveErrors = 0;
}
