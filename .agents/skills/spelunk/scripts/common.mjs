#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import Parser from "web-tree-sitter";
import crypto from "node:crypto";
import os from "node:os";
import ignore from "ignore";
import { createMatchPath, loadConfig } from "tsconfig-paths";
import { parseArgs } from "node:util";

//#region src/core/db.ts
var SpelunkDB = class {
	db;
	upsertStmt;
	getFileStmt;
	getAllFilesStmt;
	searchStmt;
	searchCountStmt;
	deleteStmt;
	depsOutStmt;
	depsOutCountStmt;
	depsInStmt;
	depsInCountStmt;
	deleteExportsStmt;
	insertExportStmt;
	deleteRawImportsStmt;
	insertRawImportStmt;
	getMetadataStmt;
	setMetadataStmt;
	getAllPathsStmt;
	constructor(dbPath = ".spelunk/data.db") {
		const dir = path.dirname(dbPath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		try {
			this.db = new DatabaseSync(dbPath);
		} catch (err) {
			console.warn(`Failed to open database at ${dbPath}: ${err.message}. Recreating...`);
			try {
				fs.unlinkSync(dbPath);
			} catch {}
			this.db = new DatabaseSync(dbPath);
		}
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA synchronous = NORMAL;");
		this.db.exec("PRAGMA temp_store = MEMORY;");
		this.db.exec("PRAGMA cache_size = -2000;");
		this.db.exec("PRAGMA foreign_keys = ON;");
		this.init();
		this.upsertStmt = this.db.prepare(`
      INSERT INTO files (path, parsed, reason, hash, exports, imports, summary, summary_hash, mtime, size)
      VALUES ($path, $parsed, $reason, $hash, $exports, $imports, $summary, $summary_hash, $mtime, $size)
      ON CONFLICT(path) DO UPDATE SET
        parsed = excluded.parsed,
        reason = excluded.reason,
        hash = excluded.hash,
        exports = excluded.exports,
        imports = excluded.imports,
        summary = excluded.summary,
        summary_hash = excluded.summary_hash,
        mtime = excluded.mtime,
        size = excluded.size;
    `);
		this.getFileStmt = this.db.prepare(`
      SELECT path, parsed, reason, hash, exports, imports, summary, summary_hash, mtime, size
      FROM files WHERE path = ?;
    `);
		this.getAllFilesStmt = this.db.prepare(`
      SELECT path, parsed, reason, hash, exports, imports, summary, summary_hash, mtime, size
      FROM files;
    `);
		this.searchStmt = this.db.prepare(`
      SELECT path, parsed, reason, hash, exports, imports, summary, summary_hash, mtime, size
      FROM files
      WHERE (length($rawQuery) >= 3 AND path IN (SELECT path FROM files_fts WHERE files_fts MATCH $ftsQuery))
         OR (length($rawQuery) < 3 AND (
              path LIKE $likeQuery 
              OR EXISTS (SELECT 1 FROM file_exports WHERE file_path = files.path AND name LIKE $likeQuery)
              OR EXISTS (SELECT 1 FROM file_raw_imports WHERE file_path = files.path AND name LIKE $likeQuery)
            ))
      LIMIT $limit OFFSET $offset;
    `);
		this.searchCountStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM files
      WHERE (length($rawQuery) >= 3 AND path IN (SELECT path FROM files_fts WHERE files_fts MATCH $ftsQuery))
         OR (length($rawQuery) < 3 AND (
              path LIKE $likeQuery 
              OR EXISTS (SELECT 1 FROM file_exports WHERE file_path = files.path AND name LIKE $likeQuery)
              OR EXISTS (SELECT 1 FROM file_raw_imports WHERE file_path = files.path AND name LIKE $likeQuery)
            ));
    `);
		this.deleteStmt = this.db.prepare(`
      DELETE FROM files WHERE path = ?;
    `);
		this.depsOutStmt = this.db.prepare(`
      WITH RECURSIVE dependency_chain(path, depth) AS (
        SELECT imported_path, 1
        FROM file_imports
        WHERE file_path = $target
        
        UNION
        
        SELECT i.imported_path, dc.depth + 1
        FROM file_imports i
        JOIN dependency_chain dc ON i.file_path = dc.path
        WHERE dc.depth < $maxDepth
      )
      SELECT f.path, f.parsed, f.reason, f.hash, f.exports, f.imports, f.summary, f.summary_hash, MIN(dc.depth) as rank
      FROM dependency_chain dc
      JOIN files f ON f.path = dc.path
      GROUP BY f.path
      ORDER BY rank ASC
      LIMIT $limit OFFSET $offset;
    `);
		this.depsOutCountStmt = this.db.prepare(`
      WITH RECURSIVE dependency_chain(path, depth) AS (
        SELECT imported_path, 1
        FROM file_imports
        WHERE file_path = $target
        
        UNION
        
        SELECT i.imported_path, dc.depth + 1
        FROM file_imports i
        JOIN dependency_chain dc ON i.file_path = dc.path
        WHERE dc.depth < $maxDepth
      )
      SELECT COUNT(DISTINCT path) as count FROM dependency_chain;
    `);
		this.depsInStmt = this.db.prepare(`
      WITH RECURSIVE dependency_chain(path, depth) AS (
        SELECT file_path, 1
        FROM file_imports
        WHERE imported_path = $target
        
        UNION
        
        SELECT i.file_path, dc.depth + 1
        FROM file_imports i
        JOIN dependency_chain dc ON i.imported_path = dc.path
        WHERE dc.depth < $maxDepth
      )
      SELECT f.path, f.parsed, f.reason, f.hash, f.exports, f.imports, f.summary, f.summary_hash, MIN(dc.depth) as rank
      FROM dependency_chain dc
      JOIN files f ON f.path = dc.path
      GROUP BY f.path
      ORDER BY rank ASC
      LIMIT $limit OFFSET $offset;
    `);
		this.depsInCountStmt = this.db.prepare(`
      WITH RECURSIVE dependency_chain(path, depth) AS (
        SELECT file_path, 1
        FROM file_imports
        WHERE imported_path = $target
        
        UNION
        
        SELECT i.file_path, dc.depth + 1
        FROM file_imports i
        JOIN dependency_chain dc ON i.imported_path = dc.path
        WHERE dc.depth < $maxDepth
      )
      SELECT COUNT(DISTINCT path) as count FROM dependency_chain;
    `);
		this.deleteExportsStmt = this.db.prepare("DELETE FROM file_exports WHERE file_path = ?;");
		this.insertExportStmt = this.db.prepare("INSERT INTO file_exports (file_path, name) VALUES (?, ?);");
		this.deleteRawImportsStmt = this.db.prepare("DELETE FROM file_raw_imports WHERE file_path = ?;");
		this.insertRawImportStmt = this.db.prepare("INSERT INTO file_raw_imports (file_path, name) VALUES (?, ?);");
		this.getMetadataStmt = this.db.prepare("SELECT value FROM metadata WHERE key = ?;");
		this.setMetadataStmt = this.db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;");
		this.getAllPathsStmt = this.db.prepare("SELECT path FROM files;");
	}
	init() {
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        parsed INTEGER NOT NULL,
        reason TEXT,
        hash TEXT,
        exports TEXT, -- JSON array of strings
        imports TEXT, -- JSON array of strings
        summary TEXT,
        summary_hash TEXT,
        mtime INTEGER,
        size INTEGER
      );

      CREATE TABLE IF NOT EXISTS file_imports (
        file_path TEXT,
        imported_path TEXT,
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_file_imports_file_path ON file_imports(file_path);
      CREATE INDEX IF NOT EXISTS idx_file_imports_imported_path ON file_imports(imported_path);

      CREATE TABLE IF NOT EXISTS file_exports (
        file_path TEXT,
        name TEXT,
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_file_exports_file_path ON file_exports(file_path);
      CREATE INDEX IF NOT EXISTS idx_file_exports_name ON file_exports(name);

      CREATE TABLE IF NOT EXISTS file_raw_imports (
        file_path TEXT,
        name TEXT,
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_file_raw_imports_file_path ON file_raw_imports(file_path);
      CREATE INDEX IF NOT EXISTS idx_file_raw_imports_name ON file_raw_imports(name);

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        path,
        exports,
        imports,
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
        INSERT INTO files_fts(path, exports, imports) VALUES (new.path, new.exports, new.imports);
      END;
      CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
        DELETE FROM files_fts WHERE path = old.path;
      END;
      CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
        DELETE FROM files_fts WHERE path = old.path;
        INSERT INTO files_fts(path, exports, imports) VALUES (new.path, new.exports, new.imports);
      END;
    `);
		try {
			this.db.exec(`
        INSERT INTO files_fts (path, exports, imports)
        SELECT path, exports, imports FROM files
        WHERE path NOT IN (SELECT path FROM files_fts);
      `);
		} catch (err) {
			console.warn(`Failed to backfill FTS table: ${err.message}`);
		}
		try {
			const countExports = this.db.prepare("SELECT COUNT(*) as count FROM file_exports;").get().count;
			const countFiles = this.db.prepare("SELECT COUNT(*) as count FROM files;").get().count;
			if (countExports === 0 && countFiles > 0) this.db.exec(`
          INSERT INTO file_exports (file_path, name)
          SELECT files.path, value FROM files, json_each(exports);

          INSERT INTO file_raw_imports (file_path, name)
          SELECT files.path, value FROM files, json_each(imports);
        `);
		} catch (err) {
			console.warn(`Failed to backfill relation helper tables: ${err.message}`);
		}
	}
	/**
	* Helper function to wrap operations in a SQLite TRANSACTION block.
	*
	* @template T The callback return type.
	* @param callback The database operations to execute.
	* @returns The callback function's return value.
	* @throws {Error} Rolls back transaction on failure and re-throws the error.
	*/
	withTransaction(callback) {
		this.db.exec("BEGIN");
		try {
			const res = callback();
			this.db.exec("COMMIT");
			return res;
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}
	/**
	* Sets a value in the metadata configuration table.
	*
	* @param key The setting identifier.
	* @param value The value to record.
	*/
	setMetadata(key, value) {
		this.setMetadataStmt.run(key, value);
	}
	/**
	* Retrieves a configuration setting from the metadata table.
	*
	* @param key The setting identifier.
	* @returns The value string, or null if key does not exist.
	*/
	getMetadata(key) {
		const row = this.getMetadataStmt.get(key);
		return row ? row.value : null;
	}
	/**
	* Inserts or updates a single file record and updates its import/export lookup relations.
	*
	* @param record The file record properties.
	*/
	upsertFile(record) {
		this.withTransaction(() => {
			this.upsertStmt.run({
				$path: record.path,
				$parsed: record.parsed ? 1 : 0,
				$reason: record.reason || null,
				$hash: record.hash || null,
				$exports: JSON.stringify(record.exports),
				$imports: JSON.stringify(record.imports),
				$summary: record.summary || null,
				$summary_hash: record.summary_hash || null,
				$mtime: record.mtime ?? null,
				$size: record.size ?? null
			});
			this.deleteExportsStmt.run(record.path);
			for (const exp of record.exports) this.insertExportStmt.run(record.path, exp);
			this.deleteRawImportsStmt.run(record.path);
			for (const imp of record.imports) this.insertRawImportStmt.run(record.path, imp);
		});
	}
	/**
	* Batch inserts or updates file records and updates import/export lookup relations.
	*
	* @param records The array of file records.
	*/
	upsertFiles(records) {
		this.withTransaction(() => {
			for (const record of records) {
				this.upsertStmt.run({
					$path: record.path,
					$parsed: record.parsed ? 1 : 0,
					$reason: record.reason || null,
					$hash: record.hash || null,
					$exports: JSON.stringify(record.exports),
					$imports: JSON.stringify(record.imports),
					$summary: record.summary || null,
					$summary_hash: record.summary_hash || null,
					$mtime: record.mtime ?? null,
					$size: record.size ?? null
				});
				this.deleteExportsStmt.run(record.path);
				for (const exp of record.exports) this.insertExportStmt.run(record.path, exp);
				this.deleteRawImportsStmt.run(record.path);
				for (const imp of record.imports) this.insertRawImportStmt.run(record.path, imp);
			}
		});
	}
	/**
	* Deletes a list of files from the database by path.
	*
	* @param paths The relative paths of files to delete.
	*/
	deleteFiles(paths) {
		if (paths.length === 0) return;
		this.withTransaction(() => {
			for (const p of paths) this.deleteStmt.run(p);
		});
	}
	/**
	* Normalises an internal SQLite row representation back into a FileRecord object.
	*
	* @param row The raw database row properties.
	* @returns Normalized FileRecord object.
	*/
	mapRow(row) {
		return {
			path: row.path,
			parsed: row.parsed === 1,
			reason: row.reason,
			hash: row.hash,
			exports: row.exports ? JSON.parse(row.exports) : [],
			imports: row.imports ? JSON.parse(row.imports) : [],
			summary: row.summary,
			summary_hash: row.summary_hash,
			mtime: row.mtime,
			size: row.size
		};
	}
	/**
	* Retrieves a file record from the database by normalized relative path.
	*
	* @param filePath The normalized relative path.
	* @returns FileRecord object or null if not found.
	*/
	getFile(filePath) {
		const row = this.getFileStmt.get(filePath);
		if (!row) return null;
		return this.mapRow(row);
	}
	/**
	* Retrieves all file records stored in the database.
	*
	* @returns Array of FileRecord objects.
	*/
	getAllFiles() {
		return this.getAllFilesStmt.all().map((row) => this.mapRow(row));
	}
	/**
	* Fast lookup of only file paths registered in the database, avoiding metadata deserialisation.
	*
	* @returns Array of relative file paths.
	*/
	getAllPaths() {
		return this.getAllPathsStmt.all().map((row) => row.path);
	}
	/**
	* Searches for files or symbol matches (exports/imports) inside the index.
	* Leverages SQLite FTS5 for query string >= 3 chars, falls back to LIKE comparisons.
	*
	* @param query The query search string.
	* @param limit The maximum number of results to fetch.
	* @param offset The pagination offset.
	* @returns Paginated search items, count, and has_more flag.
	*/
	search(query, limit = 50, offset = 0) {
		let sanitized = query.replace(/"/g, "\"\"");
		sanitized = sanitized.replace(/[*:+&|()-]/g, " ").trim();
		const commonParams = {
			$rawQuery: query,
			$ftsQuery: sanitized ? `"${sanitized}"` : `""`,
			$likeQuery: `%${query}%`
		};
		const items = this.searchStmt.all({
			...commonParams,
			$limit: limit,
			$offset: offset
		}).map((row) => this.mapRow(row));
		const countRow = this.searchCountStmt.get(commonParams);
		const total_count = countRow ? countRow.count : 0;
		return {
			items,
			total_count,
			has_more: offset + limit < total_count
		};
	}
	/**
	* Wipes existing resolved dependency edges and performs bulk inserts of normalized targets.
	*
	* @param importsList Flat array of import link objects.
	*/
	clearAndInsertImports(importsList) {
		this.withTransaction(() => {
			this.db.exec("DELETE FROM file_imports;");
			const stmt = this.db.prepare(`
        INSERT INTO file_imports (file_path, imported_path)
        VALUES (?, ?);
      `);
			for (const item of importsList) stmt.run(item.file_path, item.imported_path);
		});
	}
	/**
	* Updates resolved import links for specified files incrementally.
	*
	* @param importsMap Map of relative file paths to their resolved relative import paths.
	*/
	updateFilesImports(importsMap) {
		this.withTransaction(() => {
			const delStmt = this.db.prepare("DELETE FROM file_imports WHERE file_path = ?;");
			const insStmt = this.db.prepare("INSERT INTO file_imports (file_path, imported_path) VALUES (?, ?);");
			for (const [filePath, importedPaths] of importsMap.entries()) {
				delStmt.run(filePath);
				for (const imp of importedPaths) insStmt.run(filePath, imp);
			}
		});
	}
	/**
	* Prunes stale import relations targeting files that no longer exist in the directory index.
	*/
	pruneStaleImports() {
		this.db.exec("DELETE FROM file_imports WHERE imported_path NOT IN (SELECT path FROM files);");
	}
	/**
	* Resolves incoming or outgoing dependencies recursively using SQLite WITH RECURSIVE graph traversal.
	*
	* @param targetPath The root file path to trace.
	* @param direction Traverse path recursively outgoing ("out") or incoming ("in").
	* @param maxDepth The recursion limit depth to traversal.
	* @param limit The pagination limit.
	* @param offset The pagination offset.
	* @returns Paginated array of GraphNodes containing ranks (traverse depth), total count, and has_more.
	*/
	getDependencies(targetPath, direction, maxDepth, limit, offset) {
		const stmt = direction === "out" ? this.depsOutStmt : this.depsInStmt;
		const countStmt = direction === "out" ? this.depsOutCountStmt : this.depsInCountStmt;
		const commonParams = {
			$target: targetPath,
			$maxDepth: maxDepth
		};
		const countRow = countStmt.get(commonParams);
		const total_count = countRow ? countRow.count : 0;
		const rows = stmt.all({
			...commonParams,
			$limit: limit,
			$offset: offset
		});
		const has_more = offset + limit < total_count;
		return {
			items: rows.map((row) => ({
				...this.mapRow(row),
				rank: row.rank
			})),
			total_count,
			has_more
		};
	}
	/**
	* Closes the SQLite database sync handle.
	*/
	close() {
		this.db.close();
	}
};

//#endregion
//#region src/core/parser/wasm.ts
/**
* @file wasm.ts
* @description Initializes web-tree-sitter, loads WASM language grammars, and verifies their SHA-256 hashes.
*/
/** True if the tree-sitter WASM engine has initialized. */
let isInitialized = false;
/** True if the parser uses fallback mode due to initialization failure. */
let fallbackMode = false;
/** The active Parser instance. */
let parserInstance = null;
/** Number of consecutive parsing errors. */
let consecutiveErrors = 0;
const EXT_TO_WASM = {
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
	".dart": "tree-sitter-dart.wasm"
};
const loadedLanguages = /* @__PURE__ */ new Map();
function findWasmPath(relativePath) {
	const possiblePaths = [
		path.join(import.meta.dirname, "..", "..", "..", relativePath),
		path.join(import.meta.dirname, "../../../..", relativePath.replace("node_modules/", "")),
		path.join(import.meta.dirname, path.basename(relativePath)),
		path.resolve(relativePath)
	];
	for (const p of possiblePaths) if (fs.existsSync(p)) return p;
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
async function initParser() {
	if (isInitialized) return;
	try {
		const resolvedWasm = findWasmPath("node_modules/web-tree-sitter/tree-sitter.wasm");
		await Parser.init({ locateFile() {
			return resolvedWasm;
		} });
		parserInstance = new Parser();
		isInitialized = true;
	} catch (err) {
		console.error("Could not initialize web-tree-sitter WASM bindings. Falling back to empty parse.", err);
		fallbackMode = true;
		isInitialized = true;
	}
}
function getCacheDir() {
	return process.env.SPELUNK_CACHE_DIR || path.join(os.homedir(), ".cache", "spelunk", "wasm");
}
const KNOWN_HASHES = {
	"tree-sitter-bash.wasm": "807dcdb1380a59befb112ed8fbd3d3872c7fadaf5903a769282b50973b30696d",
	"tree-sitter-c.wasm": "056b25072382f72deee2c64ec238ffc4bb8cf42844ef21502c0e70f03a8a0d66",
	"tree-sitter-c_sharp.wasm": "6266a7e32d68a3459104d994dc848df15d5672b0ea8e86d327274b694f8e6991",
	"tree-sitter-cpp.wasm": "f6afdf53bfd6de76557bb7edb624a3a3869e14d9a83b78433f93617ecee42527",
	"tree-sitter-css.wasm": "5fc615467b1b98420ed7517e5bf9e1f88468132dd903d842dfb13714f6a1cb0c",
	"tree-sitter-dart.wasm": "7f5364e4256cf7e55efd01dd52421ef2663caa8061b82659b7e4bf61064545ec",
	"tree-sitter-elisp.wasm": "deedb03ccf150329ddfcc4ed92861c235bbae6f9692be6b93cac71617a4d42ab",
	"tree-sitter-elixir.wasm": "82e91b9759ddca30d8978ebbfa8e347b4451b64c931f9ae62112e6db9b8fac20",
	"tree-sitter-elm.wasm": "962b8668a0e16a6fb1fe232ba3e07ba4537a6b72c47293fddea0f6ea6ff9912e",
	"tree-sitter-embedded_template.wasm": "68584527f712dbf2cc39776c56980c08516991f184a4a17bb67c2f436f0fc373",
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
	"tree-sitter-zig.wasm": "59cc4531aa661e2de4c5bc04e4045b6bdd5d2bfa75045cbda5f673102d140eef"
};
async function fileExists$1(filePath) {
	try {
		await fs.promises.access(filePath);
		return true;
	} catch {
		return false;
	}
}
async function verifyFileHash(filePath, expectedHash) {
	if (!await fileExists$1(filePath)) return false;
	try {
		const content = await fs.promises.readFile(filePath);
		return crypto.createHash("sha256").update(content).digest("hex") === expectedHash;
	} catch {
		return false;
	}
}
async function downloadWasm(wasmFile, targetPath, expectedHash) {
	const version = "0.1.13";
	const urls = [`https://cdn.jsdelivr.net/npm/tree-sitter-wasms@${version}/out/${wasmFile}`, `https://unpkg.com/tree-sitter-wasms@${version}/out/${wasmFile}`];
	for (const url of urls) try {
		const response = await fetch(url);
		if (!response.ok) continue;
		const buffer = Buffer.from(await response.arrayBuffer());
		const hash = crypto.createHash("sha256").update(buffer).digest("hex");
		if (hash === expectedHash) {
			await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
			await fs.promises.writeFile(targetPath, buffer);
			return true;
		} else console.warn(`Hash mismatch for downloaded ${wasmFile} from ${url}. Expected ${expectedHash}, got ${hash}`);
	} catch (err) {
		console.warn(`Failed to download ${wasmFile} from ${url}:`, err);
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
async function getLanguage(ext) {
	const wasmFile = EXT_TO_WASM[ext];
	if (!wasmFile) return null;
	if (loadedLanguages.has(wasmFile)) return loadedLanguages.get(wasmFile);
	const expectedHash = KNOWN_HASHES[wasmFile];
	if (!expectedHash) {
		console.error(`No known hash for WASM grammar: ${wasmFile}`);
		return null;
	}
	const localWasmPath = findWasmPath(path.join("node_modules/tree-sitter-wasms/out", wasmFile));
	if (await fileExists$1(localWasmPath)) if (await verifyFileHash(localWasmPath, expectedHash)) try {
		const lang = await Parser.Language.load(localWasmPath);
		loadedLanguages.set(wasmFile, lang);
		return lang;
	} catch (err) {
		console.error(`Could not load local grammar ${wasmFile}:`, err);
	}
	else console.warn(`Local grammar ${wasmFile} hash mismatch. Trying cache.`);
	const cachedWasmPath = path.join(getCacheDir(), wasmFile);
	if (await fileExists$1(cachedWasmPath)) if (await verifyFileHash(cachedWasmPath, expectedHash)) try {
		const lang = await Parser.Language.load(cachedWasmPath);
		loadedLanguages.set(wasmFile, lang);
		return lang;
	} catch (err) {
		console.error(`Could not load cached grammar ${wasmFile}:`, err);
	}
	else {
		console.warn(`Cached grammar ${wasmFile} hash mismatch. Deleting corrupted file.`);
		try {
			await fs.promises.unlink(cachedWasmPath);
		} catch (err) {
			console.warn(`Failed to remove corrupted WASM file ${cachedWasmPath}: ${err.message}`);
		}
	}
	console.log(`Downloading Tree-sitter grammar: ${wasmFile}...`);
	if (await downloadWasm(wasmFile, cachedWasmPath, expectedHash)) try {
		const lang = await Parser.Language.load(cachedWasmPath);
		loadedLanguages.set(wasmFile, lang);
		return lang;
	} catch (err) {
		console.error(`Could not load downloaded grammar ${wasmFile}:`, err);
	}
	console.warn(`Grammar download/load failed for ${wasmFile}. Falling back to empty parse.`);
	return null;
}
function incrementConsecutiveErrors() {
	consecutiveErrors++;
	if (consecutiveErrors > 50) {
		console.error("Recycled parser instance after 50 consecutive syntax errors.");
		if (parserInstance) try {
			parserInstance.delete();
		} catch {}
		parserInstance = new Parser();
		consecutiveErrors = 0;
	}
}
function resetConsecutiveErrors() {
	consecutiveErrors = 0;
}

//#endregion
//#region src/core/parser/custom.ts
/**
* @file custom.ts
* @description Regex-based and schema-based parsers for non-AST file formats.
*/
/** Static Set of file extensions parsed using custom/regex methods. */
const customExtensions = /* @__PURE__ */ new Set([
	".sql",
	".psql",
	".mysql",
	".mssql",
	".ps1",
	".psm1",
	".psd1",
	".asm",
	".s",
	".hsm",
	".svelte",
	".astro",
	".tf",
	".tfvars",
	".terraform.lock.hcl",
	".mk",
	".sqlite",
	".sqlite3",
	".db",
	".db3",
	".s3db",
	".sl3",
	".mdb",
	".accdb",
	".duckdb",
	".ora",
	".csv"
]);
const customFilenames = /* @__PURE__ */ new Set([
	"deno.json",
	"deno.jsonc",
	"dockerfile",
	"docker-compose.yml",
	"docker-compose.yaml",
	".dockerignore",
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"yarn.lock",
	".npmrc",
	".yarnrc",
	"requirements.txt",
	"pipfile",
	"pipfile.lock",
	"pyproject.toml",
	"setup.py",
	"setup.cfg",
	"makefile",
	"webpack.config.js",
	"webpack.config.ts",
	"webpack.config.cjs",
	"webpack.config.mjs",
	"webpack.config.babel.js",
	"pom.xml",
	"cargo.toml",
	"cargo.lock",
	"build.gradle",
	"build.gradle.kts",
	"settings.gradle",
	"settings.gradle.kts",
	"ansible.cfg",
	"hosts",
	"playbook.yml",
	"playbook.yaml",
	"composer.json",
	"composer.lock",
	"bun.lockb",
	"bunfig.toml",
	"postgresql.conf",
	"pg_hba.conf",
	"my.cnf",
	"my.ini",
	"redis.conf",
	"mongod.conf",
	"mongo.conf",
	"mariadb.cnf",
	"elasticsearch.yml",
	"elasticsearch.yaml",
	"tnsnames.ora",
	"listener.ora",
	"sqlnet.ora",
	"dynamodb.json",
	"dynamodb-local.json",
	"bigquery.json",
	"config.toml",
	"supabase.toml",
	"firestore.indexes.json",
	"firestore.rules",
	"h2.properties",
	"database.rules.json",
	"cosmosdb.json",
	"snowflake.yml",
	"snowflake.yaml",
	"influxdb.conf",
	"influxdb.yaml",
	"databricks.json",
	"databricks-sql.json",
	"cassandra.yaml",
	"cassandra.conf",
	"neo4j.conf",
	"valkey.conf",
	"clickhouse-config.xml",
	"clickhouse-server.xml",
	"db2.conf",
	"redshift.json",
	"cockroach.json",
	"pb_schema.json",
	"datomic.json"
]);
/**
* Determines whether a file path corresponds to a custom non-AST format (e.g. SQL, Svelte, CSV, Dockerfile, pnpm configs).
*
* @param filePath The file path to check.
* @returns True if the file should be parsed using regex or custom parsers, false otherwise.
*/
function isCustomFile(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	const filename = path.basename(filePath).toLowerCase();
	if (filename.startsWith("dockerfile") || filename.endsWith(".dockerfile")) return true;
	return customExtensions.has(ext) || customFilenames.has(filename);
}
/**
* Parses the header line of a CSV file, accounting for potential quoted fields and escapes.
*
* @param line The first line (header) of the CSV file.
* @returns An array of trimmed header names.
*/
function parseCSVHeader(line) {
	const headers = [];
	let i = 0;
	while (i < line.length) {
		while (i < line.length && /\s/.test(line[i])) i++;
		if (i >= line.length) break;
		let field = "";
		if (line[i] === "\"" || line[i] === "'") {
			const quoteChar = line[i];
			i++;
			while (i < line.length) if (line[i] === quoteChar) if (i + 1 < line.length && line[i + 1] === quoteChar) {
				field += quoteChar;
				i += 2;
			} else {
				i++;
				break;
			}
			else {
				field += line[i];
				i++;
			}
			while (i < line.length && line[i] !== ",") i++;
			if (i < line.length && line[i] === ",") i++;
		} else {
			const commaIndex = line.indexOf(",", i);
			if (commaIndex === -1) {
				field = line.slice(i);
				i = line.length;
			} else {
				field = line.slice(i, commaIndex);
				i = commaIndex + 1;
			}
		}
		headers.push(field.trim());
	}
	return headers.filter(Boolean);
}
const SQL_IMPORT_REGEX = /(?:\\i|source)\s+['"]?([^\s'";]+)['"]?/gi;
const SQL_EXPORT_REGEX = /create\s+(?:or\s+replace\s+)?(?:table|view|procedure|function|trigger)\s+([a-zA-Z0-9_".]+)/gi;
const PS_IMPORT_REGEX = /(?:Import-Module|using\s+module)\s+['"]?([a-zA-Z0-9_\-./\\:]+)['"]?/gi;
const PS_DOT_REGEX = /^\s*\.\s+['"]?([^\r\n'"]+\.ps1)['"]?/gim;
const PS_EXPORT_REGEX = /function\s+([a-zA-Z0-9_-]+)/gi;
const ASM_IMPORT_REGEX = /^\s*[%]?include\s+['"<]?([a-zA-Z0-9_\-./\\]+)['">]?/gim;
const ASM_EXPORT_REGEX = /^\s*(?:global|public)\s+([a-zA-Z0-9_]+)/gim;
const SVELTE_SCRIPT_REGEX = /<script[^>]*>([\s\S]*?)<\/script>/gi;
const SVELTE_IMPORT_REGEX = /import\s+(?:[^"']*?\s+from\s+)?['"]([^'"]+)['"]/g;
const SVELTE_EXPORT_REGEX = /export\s+(?:let|const|var|function|class)\s+([a-zA-Z0-9_]+)/g;
const ASTRO_FM_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/d;
const ASTRO_IMPORT_REGEX = /import\s+(?:[^"']*?\s+from\s+)?['"]([^'"]+)['"]/g;
const ASTRO_EXPORT_REGEX = /export\s+(?:let|const|var|function|class)\s+([a-zA-Z0-9_]+)/g;
const DENO_COMMENT_REGEX = /\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm;
const DOCKER_FROM_REGEX = /^\s*FROM\s+([^\s#]+)/gim;
const DOCKER_IMAGE_REGEX = /image\s*:\s*([^\r\n#\s]+)/gi;
const DOCKER_BUILD_REGEX = /context\s*:\s*([^\r\n#\s]+)/gi;
const PNPM_PKG_REGEX = /-\s*['"]?([^\r\n'"]+)['"]?/gi;
const PIP_REQ_REGEX = /^([a-zA-Z0-9_\-[\]]+)/;
const PIP_FILE_REGEX = /^\s*([a-zA-Z0-9_-]+)\s*=\s*/gm;
const PIP_DEP_REGEX = /dependencies\s*=\s*\[([\s\S]*?)\]/gi;
const PIP_PKG_REGEX = /['"]([a-zA-Z0-9_-]+)/g;
const MAKE_INCLUDE_REGEX = /^\s*-?include\s+([^\r\n#]+)/gm;
const MAKE_TARGET_REGEX = /^([a-zA-Z0-9_\-./]+)\s*:(?!=)/gm;
const WEBPACK_REQ_REGEX = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const WEBPACK_IMPORT_REGEX = /import\s+(?:[^"']*?\s+from\s+)?['"]([^'"]+)['"]/g;
const TF_SOURCE_REGEX = /source\s*=\s*["']([^"']+)["']/gi;
const TF_MODULE_REGEX = /module\s+["']([^"']+)["']/gi;
const TF_RESOURCE_REGEX = /resource\s+["']([^"']+)["']\s+["']([^"']+)["']/gi;
const MAVEN_DEP_REGEX = /<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/gi;
const CARGO_NAME_REGEX = /name\s*=\s*["']([^"']+)["']/i;
const CARGO_PKG_REGEX = /^\s*([a-zA-Z0-9_-]+)\s*=\s*/gm;
const GRADLE_DEP_REGEX = /(?:implementation|testImplementation|api|classpath)\s*\(?['"]([^'"]+)['"]/gi;
/**
* Parses non-AST files (config files, scripts, lockfiles, CSVs) using regex or custom parsers.
*
* @param filePath File path
* @param content File content
* @returns Imports and exports lists
*/
function parseCustomFile(filePath, content) {
	const ext = path.extname(filePath).toLowerCase();
	const filename = path.basename(filePath).toLowerCase();
	const imports = [];
	const exports = [];
	if ([
		".sql",
		".psql",
		".mysql",
		".mssql"
	].includes(ext)) {
		SQL_IMPORT_REGEX.lastIndex = 0;
		SQL_EXPORT_REGEX.lastIndex = 0;
		let match;
		while ((match = SQL_IMPORT_REGEX.exec(content)) !== null) imports.push(match[1]);
		while ((match = SQL_EXPORT_REGEX.exec(content)) !== null) exports.push(match[1].replace(/"/g, ""));
	} else if ([
		".ps1",
		".psm1",
		".psd1"
	].includes(ext)) {
		PS_IMPORT_REGEX.lastIndex = 0;
		PS_DOT_REGEX.lastIndex = 0;
		PS_EXPORT_REGEX.lastIndex = 0;
		let match;
		while ((match = PS_IMPORT_REGEX.exec(content)) !== null) imports.push(match[1]);
		while ((match = PS_DOT_REGEX.exec(content)) !== null) imports.push(match[1]);
		while ((match = PS_EXPORT_REGEX.exec(content)) !== null) exports.push(match[1]);
	} else if ([
		".asm",
		".s",
		".hsm"
	].includes(ext)) {
		ASM_IMPORT_REGEX.lastIndex = 0;
		ASM_EXPORT_REGEX.lastIndex = 0;
		let match;
		while ((match = ASM_IMPORT_REGEX.exec(content)) !== null) imports.push(match[1]);
		while ((match = ASM_EXPORT_REGEX.exec(content)) !== null) exports.push(match[1]);
	} else if (ext === ".svelte") {
		SVELTE_SCRIPT_REGEX.lastIndex = 0;
		let scriptMatch;
		while ((scriptMatch = SVELTE_SCRIPT_REGEX.exec(content)) !== null) {
			const scriptContent = scriptMatch[1];
			SVELTE_IMPORT_REGEX.lastIndex = 0;
			SVELTE_EXPORT_REGEX.lastIndex = 0;
			let match;
			while ((match = SVELTE_IMPORT_REGEX.exec(scriptContent)) !== null) imports.push(match[1]);
			while ((match = SVELTE_EXPORT_REGEX.exec(scriptContent)) !== null) exports.push(match[1]);
		}
	} else if (ext === ".astro") {
		const fmMatch = content.match(ASTRO_FM_REGEX);
		if (fmMatch) {
			const fmContent = fmMatch[1];
			ASTRO_IMPORT_REGEX.lastIndex = 0;
			ASTRO_EXPORT_REGEX.lastIndex = 0;
			let match;
			while ((match = ASTRO_IMPORT_REGEX.exec(fmContent)) !== null) imports.push(match[1]);
			while ((match = ASTRO_EXPORT_REGEX.exec(fmContent)) !== null) exports.push(match[1]);
		}
	} else if (filename === "deno.json" || filename === "deno.jsonc") try {
		DENO_COMMENT_REGEX.lastIndex = 0;
		const cleanContent = content.replace(DENO_COMMENT_REGEX, "$1");
		const json = JSON.parse(cleanContent);
		if (json.imports) {
			for (const val of Object.values(json.imports)) if (typeof val === "string") imports.push(val);
		}
		if (json.scopes) {
			for (const scopeVal of Object.values(json.scopes)) if (typeof scopeVal === "object" && scopeVal !== null) {
				for (const val of Object.values(scopeVal)) if (typeof val === "string") imports.push(val);
			}
		}
	} catch {}
	else if (filename.startsWith("dockerfile") || filename.endsWith(".dockerfile")) {
		DOCKER_FROM_REGEX.lastIndex = 0;
		let match;
		while ((match = DOCKER_FROM_REGEX.exec(content)) !== null) imports.push(match[1]);
	} else if (filename === "docker-compose.yml" || filename === "docker-compose.yaml") {
		DOCKER_IMAGE_REGEX.lastIndex = 0;
		DOCKER_BUILD_REGEX.lastIndex = 0;
		let match;
		while ((match = DOCKER_IMAGE_REGEX.exec(content)) !== null) imports.push(match[1]);
		while ((match = DOCKER_BUILD_REGEX.exec(content)) !== null) imports.push(match[1]);
	} else if (filename === "package.json") try {
		const json = JSON.parse(content);
		if (json.name) exports.push(json.name);
		for (const key of [
			"dependencies",
			"devDependencies",
			"peerDependencies",
			"optionalDependencies"
		]) if (json[key]) imports.push(...Object.keys(json[key]));
	} catch {}
	else if (filename === "pnpm-workspace.yaml") {
		PNPM_PKG_REGEX.lastIndex = 0;
		let match;
		while ((match = PNPM_PKG_REGEX.exec(content)) !== null) imports.push(match[1]);
	} else if (filename === "requirements.txt") {
		const lines = content.split(/\r?\n/);
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("-")) {
				const pkgMatch = PIP_REQ_REGEX.exec(trimmed);
				if (pkgMatch) imports.push(pkgMatch[1]);
			}
		}
	} else if (filename === "pipfile") {
		PIP_FILE_REGEX.lastIndex = 0;
		let match;
		while ((match = PIP_FILE_REGEX.exec(content)) !== null) imports.push(match[1]);
	} else if (filename === "pyproject.toml") {
		PIP_DEP_REGEX.lastIndex = 0;
		let depMatch = PIP_DEP_REGEX.exec(content);
		if (depMatch) {
			PIP_PKG_REGEX.lastIndex = 0;
			let match;
			while ((match = PIP_PKG_REGEX.exec(depMatch[1])) !== null) imports.push(match[1]);
		}
	} else if (filename === "makefile" || ext === ".mk") {
		MAKE_INCLUDE_REGEX.lastIndex = 0;
		MAKE_TARGET_REGEX.lastIndex = 0;
		let match;
		while ((match = MAKE_INCLUDE_REGEX.exec(content)) !== null) {
			const files = match[1].trim().split(/\s+/);
			imports.push(...files);
		}
		while ((match = MAKE_TARGET_REGEX.exec(content)) !== null) if (!match[1].startsWith(".")) exports.push(match[1]);
	} else if (filename.startsWith("webpack.config.")) {
		WEBPACK_REQ_REGEX.lastIndex = 0;
		WEBPACK_IMPORT_REGEX.lastIndex = 0;
		let match;
		while ((match = WEBPACK_REQ_REGEX.exec(content)) !== null) imports.push(match[1]);
		while ((match = WEBPACK_IMPORT_REGEX.exec(content)) !== null) imports.push(match[1]);
	} else if ([".tf", ".tfvars"].includes(ext)) {
		TF_SOURCE_REGEX.lastIndex = 0;
		TF_MODULE_REGEX.lastIndex = 0;
		TF_RESOURCE_REGEX.lastIndex = 0;
		let match;
		while ((match = TF_SOURCE_REGEX.exec(content)) !== null) imports.push(match[1]);
		while ((match = TF_MODULE_REGEX.exec(content)) !== null) exports.push(match[1]);
		while ((match = TF_RESOURCE_REGEX.exec(content)) !== null) exports.push(`${match[1]}.${match[2]}`);
	} else if (filename === "pom.xml") {
		MAVEN_DEP_REGEX.lastIndex = 0;
		let match;
		while ((match = MAVEN_DEP_REGEX.exec(content)) !== null) imports.push(`${match[1]}:${match[2]}`);
	} else if (filename === "cargo.toml") {
		const nameMatch = CARGO_NAME_REGEX.exec(content);
		if (nameMatch) exports.push(nameMatch[1]);
		CARGO_PKG_REGEX.lastIndex = 0;
		let match;
		while ((match = CARGO_PKG_REGEX.exec(content)) !== null) if (match[1] !== "name" && match[1] !== "version" && match[1] !== "authors" && match[1] !== "edition") imports.push(match[1]);
	} else if (filename === "build.gradle" || filename === "build.gradle.kts") {
		GRADLE_DEP_REGEX.lastIndex = 0;
		let match;
		while ((match = GRADLE_DEP_REGEX.exec(content)) !== null) imports.push(match[1]);
	} else if (filename === "composer.json") try {
		const json = JSON.parse(content);
		if (json.name) exports.push(json.name);
		if (json.require) imports.push(...Object.keys(json.require));
		if (json["require-dev"]) imports.push(...Object.keys(json["require-dev"]));
	} catch {}
	else if (ext === ".csv") {
		const firstLine = content.split(/\r?\n/)[0];
		if (firstLine) {
			const headers = parseCSVHeader(firstLine);
			exports.push(...headers);
		}
	}
	return {
		imports: Array.from(new Set(imports)),
		exports: Array.from(new Set(exports))
	};
}

//#endregion
//#region src/core/parser/ast.ts
/**
* Traverses a syntax node in pre-order without using call stack recursion.
*
* @param rootNode Tree-sitter root node to walk
* @param callback Function called on each visited node
*/
function traverse(rootNode, callback) {
	const cursor = rootNode.walk();
	while (true) {
		callback(cursor.currentNode);
		if (cursor.gotoFirstChild()) continue;
		if (cursor.gotoNextSibling()) continue;
		let backtracking = true;
		while (backtracking) {
			if (!cursor.gotoParent()) {
				cursor.delete();
				return;
			}
			if (cursor.gotoNextSibling()) backtracking = false;
		}
	}
}
/**
* Extracts imports and exports from a tree-sitter Tree.
* Filters by Rust visibility ('pub') and Python module-level names.
*
* @param ext File extension
* @param tree Parsed syntax tree
* @returns Imports and exports lists
*/
function extractASTData(ext, tree) {
	const imports = [];
	const exports = [];
	if ([
		".js",
		".jsx",
		".ts",
		".tsx",
		".mjs",
		".cjs",
		".mts",
		".cts"
	].includes(ext)) traverse(tree.rootNode, (node) => {
		if (node.type === "import_statement") {
			const sourceNode = node.childForFieldName("source");
			if (sourceNode) {
				const rawText = sourceNode.text;
				imports.push(rawText.replace(/['"]/g, ""));
			}
		} else if (node.type === "call_expression") {
			const fn = node.childForFieldName("function");
			if (fn && fn.text === "require") {
				const args = node.childForFieldName("arguments");
				if (args && args.childCount >= 3) {
					const firstArg = args.child(1);
					if (firstArg && (firstArg.type === "string" || firstArg.type === "string_literal")) imports.push(firstArg.text.replace(/['"]/g, ""));
				}
			}
		} else if (node.type === "export_statement") {
			const sourceNode = node.childForFieldName("source");
			if (sourceNode) {
				const rawText = sourceNode.text;
				imports.push(rawText.replace(/['"]/g, ""));
			}
			const declarationNode = node.childForFieldName("declaration");
			if (declarationNode) if (declarationNode.type === "lexical_declaration" || declarationNode.type === "variable_declaration") for (let i = 0; i < declarationNode.childCount; i++) {
				const child = declarationNode.child(i);
				if (child && child.type === "variable_declarator") {
					const nameNode = child.childForFieldName("name");
					if (nameNode) exports.push(nameNode.text);
				}
			}
			else {
				const nameNode = declarationNode.childForFieldName("name") || declarationNode.child(1);
				if (nameNode) exports.push(nameNode.text);
			}
		} else if (node.type === "export_specifier") {
			const nameNode = node.childForFieldName("alias") || node.childForFieldName("name") || node.child(0);
			if (nameNode) exports.push(nameNode.text);
		} else if (node.type === "assignment_expression") {
			const left = node.childForFieldName("left");
			if (left) {
				if (left.text === "module.exports" || left.text === "exports") {
					const right = node.childForFieldName("right");
					if (right) {
						if (right.type === "identifier") exports.push(right.text);
						else if (right.type === "assignment_expression") {
							const deepRight = right.childForFieldName("right");
							if (deepRight && deepRight.type === "identifier") exports.push(deepRight.text);
						} else if (right.type === "function_expression" || right.type === "function_declaration") {
							const name = right.childForFieldName("name");
							if (name) exports.push(name.text);
						}
					}
				} else if (left.type === "member_expression") {
					const obj = left.childForFieldName("object");
					const prop = left.childForFieldName("property");
					if (obj && prop && (obj.text === "exports" || obj.text === "module.exports")) exports.push(prop.text);
				}
			}
		}
	});
	else if ([
		".py",
		".pyi",
		".pyw"
	].includes(ext)) traverse(tree.rootNode, (node) => {
		if (node.type === "import_statement") for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (child && child.type === "dotted_name") imports.push(child.text);
		}
		else if (node.type === "import_from_statement") {
			const moduleNode = node.childForFieldName("module") || node.child(1);
			if (moduleNode) imports.push(moduleNode.text);
		} else if (node.type === "class_definition" || node.type === "function_definition") {
			if (node.parent?.type === "module") {
				const nameNode = node.childForFieldName("name");
				if (nameNode) {
					const name = nameNode.text;
					if (!name.startsWith("_")) exports.push(name);
				}
			}
		}
	});
	else if (ext === ".go") traverse(tree.rootNode, (node) => {
		if (node.type === "import_spec") {
			const pathNode = node.childForFieldName("path");
			if (pathNode) imports.push(pathNode.text.replace(/['"]/g, ""));
		} else if (node.type === "function_declaration" || node.type === "type_spec" || node.type === "value_spec") {
			const nameNode = node.childForFieldName("name");
			if (nameNode && /^[A-Z]/.test(nameNode.text)) exports.push(nameNode.text);
		}
	});
	else if (ext === ".rs") traverse(tree.rootNode, (node) => {
		if (node.type === "use_declaration") {
			const pathNode = node.child(1);
			if (pathNode) imports.push(pathNode.text);
		} else if (node.type === "function_item" || node.type === "struct_item" || node.type === "enum_item" || node.type === "type_item" || node.type === "trait_item" || node.type === "mod_item") {
			let isPublic = false;
			for (let i = 0; i < node.childCount; i++) if (node.child(i)?.type === "visibility_modifier") {
				isPublic = true;
				break;
			}
			if (isPublic) {
				const nameNode = node.childForFieldName("name");
				if (nameNode) exports.push(nameNode.text);
			}
		}
	});
	else if ([
		".java",
		".kt",
		".kts"
	].includes(ext)) traverse(tree.rootNode, (node) => {
		if (node.type === "import_declaration") {
			const nameNode = node.childForFieldName("name") || node.child(1);
			if (nameNode) imports.push(nameNode.text);
		} else if (node.type === "class_declaration" || node.type === "class_definition" || node.type === "interface_declaration" || node.type === "interface_definition" || node.type === "enum_declaration" || node.type === "enum_definition" || node.type === "object_declaration" || node.type === "object_definition" || node.type === "trait_declaration" || node.type === "trait_definition") {
			const nameNode = node.childForFieldName("name");
			if (nameNode) exports.push(nameNode.text);
		}
	});
	else if ([
		".c",
		".cpp",
		".cc",
		".c++",
		".h",
		".hpp",
		".hh",
		".hxx",
		".h++",
		".inl",
		".ipp"
	].includes(ext)) traverse(tree.rootNode, (node) => {
		if (node.type === "preproc_include") {
			const pathNode = node.childForFieldName("path") || node.child(1);
			if (pathNode) imports.push(pathNode.text.replace(/['"<>]/g, ""));
		} else if (node.type === "class_specifier" || node.type === "struct_specifier" || node.type === "namespace_definition") {
			const nameNode = node.childForFieldName("name");
			if (nameNode) exports.push(nameNode.text);
		}
	});
	else if (ext === ".cs") traverse(tree.rootNode, (node) => {
		if (node.type === "using_directive") {
			const nameNode = node.child(1);
			if (nameNode) imports.push(nameNode.text.replace(/;/g, "").trim());
		} else if (node.type === "class_declaration" || node.type === "interface_declaration" || node.type === "struct_declaration" || node.type === "enum_declaration" || node.type === "record_declaration" || node.type === "namespace_declaration") {
			const nameNode = node.childForFieldName("name") || node.child(1);
			if (nameNode) exports.push(nameNode.text);
		}
	});
	else if (ext === ".swift") traverse(tree.rootNode, (node) => {
		if (node.type === "import_declaration") {
			const pathNode = node.child(1);
			if (pathNode) imports.push(pathNode.text);
		} else if (node.type === "class_declaration" || node.type === "struct_declaration" || node.type === "protocol_declaration" || node.type === "enum_declaration" || node.type === "actor_declaration" || node.type === "extension_declaration") {
			const nameNode = node.childForFieldName("name") || node.child(1);
			if (nameNode) exports.push(nameNode.text);
		}
	});
	else if ([".php", ".php5"].includes(ext)) traverse(tree.rootNode, (node) => {
		if (node.type === "namespace_use_clause") {
			const nameNode = node.child(0);
			if (nameNode) imports.push(nameNode.text);
		} else if (node.type === "class_declaration" || node.type === "interface_declaration" || node.type === "trait_declaration" || node.type === "enum_declaration" || node.type === "namespace_definition") {
			const nameNode = node.childForFieldName("name") || node.child(1);
			if (nameNode) exports.push(nameNode.text);
		}
	});
	else if ([
		".rb",
		".gemspec",
		".rake"
	].includes(ext)) traverse(tree.rootNode, (node) => {
		if (node.type === "call" && [
			"require",
			"require_relative",
			"load",
			"import"
		].includes(node.child(0)?.text ?? "")) {
			const argList = node.child(1);
			if (argList) {
				const firstArg = argList.child(0);
				if (firstArg) imports.push(firstArg.text.replace(/['"]/g, ""));
			}
		} else if (node.type === "class" || node.type === "module") {
			const nameNode = node.childForFieldName("name") || node.child(1);
			if (nameNode) exports.push(nameNode.text);
		}
	});
	return {
		imports: Array.from(new Set(imports)),
		exports: Array.from(new Set(exports))
	};
}

//#endregion
//#region src/core/parser/index.ts
/**
* @file index.ts
* @description Entry point for the parser. Chooses between AST and custom regex-based parsers.
*/
/**
* Parses a file to extract its imports and exports.
* Chooses between AST parsing (tree-sitter) and custom regex-based parsing.
*
* @param filePath File path to parse
* @param content File content
* @returns Imports and exports lists
*/
async function parseFile(filePath, content) {
	if (isCustomFile(filePath)) return parseCustomFile(filePath, content);
	await initParser();
	let ext = path.extname(filePath).toLowerCase();
	const filename = path.basename(filePath).toLowerCase();
	if (filePath.toLowerCase().endsWith(".blade.php")) ext = ".blade.php";
	else if ([
		"podfile",
		"gemfile",
		"fastfile",
		"appfile"
	].includes(filename)) ext = ".rb";
	if (fallbackMode || !parserInstance || !EXT_TO_WASM[ext]) return {
		imports: [],
		exports: []
	};
	const lang = await getLanguage(ext);
	if (!lang) return {
		imports: [],
		exports: []
	};
	let tree = null;
	try {
		parserInstance.setLanguage(lang);
		tree = parserInstance.parse(content);
		resetConsecutiveErrors();
		return extractASTData(ext, tree);
	} catch (err) {
		incrementConsecutiveErrors();
		console.error(`AST parsing failed for ${filePath}.`, err);
		return {
			imports: [],
			exports: []
		};
	} finally {
		if (tree) try {
			tree.delete();
		} catch (e) {
			console.error("Failed to release AST memory:", e);
		}
	}
}

//#endregion
//#region src/core/scanner.ts
const MAX_DEPTH = 100;
const MAX_FILES = 5e4;
const MAX_FILE_SIZE = 1024 * 1024;
async function fileExists(filePath) {
	try {
		await fs.promises.access(filePath);
		return true;
	} catch {
		return false;
	}
}
async function retryOnTransientError(fn, retries = 3, delay = 50) {
	let attempt = 0;
	while (true) try {
		return await fn();
	} catch (err) {
		attempt++;
		if (![
			"EMFILE",
			"ENFILE",
			"EBUSY",
			"EAGAIN",
			"ECONNRESET"
		].includes(err.code) || attempt >= retries) throw err;
		await new Promise((resolve) => setTimeout(resolve, delay * Math.pow(2, attempt)));
	}
}
async function scanDirectory(options) {
	const startTime = performance.now();
	const rootDir = path.resolve(options.rootDir);
	const resolvedRootDir = await fs.promises.realpath(rootDir);
	const dbPath = options.dbPath || path.join(rootDir, ".spelunk", "data.db");
	const db = new SpelunkDB(dbPath);
	if (db.getMetadata("scanStatus") === "running" && !options.silent) console.warn("A previous scan was interrupted or crashed. Restarting the scan.");
	db.setMetadata("scanStatus", "running");
	const sigHandler = () => {
		try {
			const cleanupDb = new SpelunkDB(dbPath);
			cleanupDb.setMetadata("scanStatus", "interrupted");
			cleanupDb.close();
		} catch {}
		process.exit(1);
	};
	process.on("SIGINT", sigHandler);
	process.on("SIGTERM", sigHandler);
	const ig = ignore();
	let fileCount = 0;
	let parsedCount = 0;
	let skippedCount = 0;
	let unchangedCount = 0;
	const gitignorePath = path.join(rootDir, ".gitignore");
	if (await fileExists(gitignorePath)) try {
		const gitignoreContent = await fs.promises.readFile(gitignorePath, "utf-8");
		ig.add(gitignoreContent);
	} catch {}
	ig.add([
		".git/**",
		"node_modules/**",
		".bun/**",
		".cache/**",
		"dist/**",
		".spelunk/**",
		"**/.spelunk/**",
		"**/.git/**",
		"**/node_modules/**"
	]);
	const seenRealPaths = /* @__PURE__ */ new Set();
	const seenPaths = /* @__PURE__ */ new Set();
	const filesToProcess = [];
	async function walk(currentDir, depth, parentIgContexts) {
		if (depth > MAX_DEPTH) {
			if (!options.silent) console.error("Recursion limit exceeded. Check for circular symlinks or deeply nested folders.");
			return;
		}
		const myIgContexts = [...parentIgContexts];
		const localGitignorePath = path.join(currentDir, ".gitignore");
		if (await fileExists(localGitignorePath)) try {
			const localContent = await fs.promises.readFile(localGitignorePath, "utf-8");
			myIgContexts.push({
				dirPath: currentDir,
				ig: ignore().add(localContent)
			});
		} catch {}
		let entries;
		try {
			entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
			if (ig.ignores(relativePath)) continue;
			let ignoredByNested = false;
			for (const ctx of myIgContexts) {
				const pathRelToGitignore = path.relative(ctx.dirPath, fullPath).replace(/\\/g, "/");
				if (ctx.ig.ignores(pathRelToGitignore)) {
					ignoredByNested = true;
					break;
				}
			}
			if (ignoredByNested) continue;
			if (entry.isDirectory()) {
				let realPath;
				try {
					realPath = await fs.promises.realpath(fullPath);
				} catch {
					continue;
				}
				if (seenRealPaths.has(realPath)) continue;
				const relativeFromRoot = path.relative(resolvedRootDir, realPath);
				if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) continue;
				seenRealPaths.add(realPath);
				await walk(fullPath, depth + 1, myIgContexts);
			} else if (entry.isFile()) {
				if (filesToProcess.length >= MAX_FILES) return;
				fileCount++;
				if (fileCount > MAX_FILES) {
					if (!options.silent) console.error("File limit exceeded. Spelunk supports a maximum of 50,000 files.");
					return;
				}
				seenPaths.add(relativePath);
				filesToProcess.push({
					fullPath,
					relativePath
				});
			}
		}
	}
	const recordsToUpsert = [];
	async function processFile(file) {
		const { fullPath, relativePath } = file;
		let stat;
		try {
			stat = await retryOnTransientError(() => fs.promises.stat(fullPath));
		} catch {
			return null;
		}
		const existingRecord = db.getFile(relativePath);
		const summary = existingRecord?.summary || null;
		if (existingRecord && existingRecord.size === stat.size && existingRecord.mtime === stat.mtime.getTime()) {
			unchangedCount++;
			return null;
		}
		if (stat.size > MAX_FILE_SIZE) {
			const hash = `${stat.size}-${stat.mtime.getTime()}`;
			skippedCount++;
			return {
				path: relativePath,
				parsed: false,
				reason: "exceeds size limit",
				exports: [],
				imports: [],
				summary,
				summary_hash: existingRecord?.summary_hash || null,
				hash,
				mtime: stat.mtime.getTime(),
				size: stat.size
			};
		}
		let isBinary = false;
		let fd;
		try {
			fd = await retryOnTransientError(() => fs.promises.open(fullPath, "r"));
			const buffer = Buffer.alloc(1024);
			const { bytesRead } = await fd.read(buffer, 0, 1024, 0);
			for (let i = 0; i < bytesRead; i++) if (buffer[i] === 0) {
				isBinary = true;
				break;
			}
		} catch {} finally {
			if (fd) await fd.close();
		}
		if (isBinary) {
			const hash = `${stat.size}-${stat.mtime.getTime()}`;
			skippedCount++;
			return {
				path: relativePath,
				parsed: false,
				reason: "binary file",
				exports: [],
				imports: [],
				summary,
				summary_hash: existingRecord?.summary_hash || null,
				hash,
				mtime: stat.mtime.getTime(),
				size: stat.size
			};
		}
		let content;
		try {
			content = await retryOnTransientError(() => fs.promises.readFile(fullPath, "utf-8"));
		} catch (err) {
			skippedCount++;
			return {
				path: relativePath,
				parsed: false,
				reason: `read error: ${err.message}`,
				exports: [],
				imports: [],
				summary,
				summary_hash: existingRecord?.summary_hash || null,
				mtime: stat.mtime.getTime(),
				size: stat.size
			};
		}
		const hash = crypto.createHash("sha256").update(content).digest("hex");
		if (existingRecord && existingRecord.hash === hash) {
			unchangedCount++;
			return null;
		}
		try {
			const { imports, exports } = await parseFile(fullPath, content);
			parsedCount++;
			return {
				path: relativePath,
				parsed: true,
				hash,
				imports,
				exports,
				summary,
				summary_hash: existingRecord?.summary_hash || null,
				mtime: stat.mtime.getTime(),
				size: stat.size
			};
		} catch (err) {
			skippedCount++;
			return {
				path: relativePath,
				parsed: false,
				reason: `parse error: ${err.message}`,
				hash,
				exports: [],
				imports: [],
				summary,
				summary_hash: existingRecord?.summary_hash || null,
				mtime: stat.mtime.getTime(),
				size: stat.size
			};
		}
	}
	try {
		await walk(rootDir, 0, []);
		const concurrencyLimit = options.concurrency && options.concurrency > 0 ? options.concurrency : 8;
		const activePromises = /* @__PURE__ */ new Set();
		let processedCount = 0;
		const totalFiles = filesToProcess.length;
		for (const file of filesToProcess) {
			const p = processFile(file);
			activePromises.add(p);
			p.then((record) => {
				activePromises.delete(p);
				if (record) recordsToUpsert.push(record);
				processedCount++;
				if (!options.silent && totalFiles > 0) {
					const step = Math.max(20, Math.floor(totalFiles / 10));
					if (processedCount % step === 0 || processedCount === totalFiles) console.log(`Scan progress: ${processedCount} of ${totalFiles} files processed (${Math.round(processedCount / totalFiles * 100)}%)...`);
				}
			});
			if (activePromises.size >= concurrencyLimit) await Promise.race(activePromises);
		}
		await Promise.all(activePromises);
		if (recordsToUpsert.length > 0) db.upsertFiles(recordsToUpsert);
		const toDelete = db.getAllFiles().filter((f) => !seenPaths.has(f.path)).map((f) => f.path);
		if (toDelete.length > 0) db.deleteFiles(toDelete);
		db.setMetadata("rootDir", rootDir);
		if (recordsToUpsert.length > 0) {
			const configLoaderResult = loadConfig(rootDir);
			const matchPath = configLoaderResult.resultType === "success" ? createMatchPath(configLoaderResult.absoluteBaseUrl, configLoaderResult.paths) : null;
			const resolveImport = (sourcePath, importStr) => {
				let resolved;
				if (importStr.startsWith(".")) resolved = path.resolve(path.dirname(path.resolve(rootDir, sourcePath)), importStr);
				else if (matchPath) resolved = matchPath(importStr, void 0, void 0, [
					".ts",
					".tsx",
					".js",
					".jsx"
				]);
				if (!resolved) resolved = path.resolve(rootDir, importStr.replace(/^@\//, "").replace(/^~\//, ""));
				const candidates = [
					resolved,
					`${resolved}.ts`,
					`${resolved}.tsx`,
					`${resolved}.js`,
					`${resolved}.jsx`,
					path.join(resolved, "index.ts"),
					path.join(resolved, "index.tsx"),
					path.join(resolved, "index.js")
				];
				for (const c of candidates) {
					const normalized = path.relative(rootDir, c).replace(/\\/g, "/");
					if (seenPaths.has(normalized)) return normalized;
				}
				return null;
			};
			const importsMap = /* @__PURE__ */ new Map();
			for (const f of recordsToUpsert) {
				const resolved = [];
				for (const imp of f.imports) {
					const resPath = resolveImport(f.path, imp);
					if (resPath) resolved.push(resPath);
				}
				importsMap.set(f.path, resolved);
			}
			db.updateFilesImports(importsMap);
		}
		const durationMs = performance.now() - startTime;
		const filesPerSecond = durationMs > 0 ? fileCount / (durationMs / 1e3) : 0;
		const cacheHitRatio = fileCount > 0 ? unchangedCount / fileCount : 0;
		const memoryUsageMb = process.memoryUsage().heapUsed / 1024 / 1024;
		db.pruneStaleImports();
		return {
			fileCount,
			parsedCount,
			skippedCount,
			unchangedCount,
			metrics: {
				durationMs,
				filesPerSecond,
				cacheHitRatio,
				memoryUsageMb
			}
		};
	} finally {
		process.off("SIGINT", sigHandler);
		process.off("SIGTERM", sigHandler);
		try {
			db.setMetadata("scanStatus", "completed");
		} catch {}
		db.close();
	}
}

//#endregion
//#region src/core/query.ts
async function withDB(dbPath, fn) {
	if (!fs.existsSync(dbPath)) throw new Error(`No database found at ${dbPath}. The index must be created before querying. Run 'spelunk scan' to index the codebase.`);
	const db = new SpelunkDB(dbPath);
	try {
		return await fn(db);
	} finally {
		db.close();
	}
}
function resolveRelativePath(db, targetPath) {
	const rootDir = db.getMetadata("rootDir") || process.cwd();
	return path.relative(rootDir, path.resolve(targetPath)).replace(/\\/g, "/");
}
function runFind(query, dbPath, limit = 50, offset = 0) {
	return withDB(dbPath, (db) => {
		const { items, total_count, has_more } = db.search(query, limit, offset);
		return {
			files: items,
			limit,
			offset,
			total_count,
			has_more
		};
	});
}
function runOutline(targetPath, dbPath) {
	return withDB(dbPath, (db) => {
		const relativePath = resolveRelativePath(db, targetPath);
		const fileRecord = db.getFile(relativePath);
		if (!fileRecord) return { files: [] };
		return { files: [fileRecord] };
	});
}
function runDeps(targetPath, direction, maxDepth, dbPath, limit = 50, offset = 0) {
	return withDB(dbPath, (db) => {
		const relativeTarget = resolveRelativePath(db, targetPath);
		if (!db.getFile(relativeTarget)) return {
			files: [],
			limit,
			offset,
			total_count: 0,
			has_more: false
		};
		const { items, total_count, has_more } = db.getDependencies(relativeTarget, direction, maxDepth, limit, offset);
		return {
			files: items,
			limit,
			offset,
			total_count,
			has_more
		};
	});
}
async function runExplain(targetPath, shouldSummarize, dbPath, agentSummary) {
	return withDB(dbPath, async (db) => {
		const relativeTarget = resolveRelativePath(db, targetPath);
		const record = db.getFile(relativeTarget);
		if (!record) throw new Error(`File not indexed: ${relativeTarget}. The file must be added to the index first. Run 'spelunk scan' to update the index.`);
		if (!shouldSummarize) if (record.summary) {
			const isStale = !!(record.summary_hash && record.summary_hash !== record.hash);
			if (isStale) console.error(`Warning: Cached summary for ${relativeTarget} is stale (file modified).`);
			return {
				path: relativeTarget,
				summary: record.summary,
				stale: isStale
			};
		} else throw new Error(`No summary cached for this file. Summarize the file first using --set-summary '<text>'.`);
		else {
			if (!record.parsed && record.reason !== "binary file" && record.reason !== "exceeds size limit") throw new Error(`Cannot summarize unparsed file. The file has not been parsed successfully (reason: ${record.reason || "unknown"}).`);
			if (!agentSummary) throw new Error(`Provide the summary text. Use '--set-summary <text>' to set the summary content.`);
			const rootDir = db.getMetadata("rootDir") || process.cwd();
			const fullPath = path.join(rootDir, relativeTarget);
			if (!fs.existsSync(fullPath)) throw new Error(`File not found on disk: ${relativeTarget}. Ensure the file exists and the path is correct.`);
			record.summary = agentSummary;
			record.summary_hash = record.hash;
			db.upsertFile(record);
			return {
				path: relativeTarget,
				summary: agentSummary,
				stale: false
			};
		}
	});
}
function runExport(format, dbPath) {
	return withDB(dbPath, (db) => {
		const allFiles = db.getAllFiles();
		if (format === "json") return { files: allFiles };
		else {
			let md = "# Spelunk Codemap Export\n\n";
			for (const f of allFiles) {
				md += `## ${f.path}\n`;
				md += `- **Parsed**: ${f.parsed}\n`;
				if (f.reason) md += `- **Reason**: ${f.reason}\n`;
				if (f.exports.length > 0) {
					md += `- **Exports**:\n`;
					for (const exp of f.exports) md += `  - \`${exp}\`\n`;
				}
				if (f.imports.length > 0) {
					md += `- **Imports**:\n`;
					for (const imp of f.imports) md += `  - \`${imp}\`\n`;
				}
				md += "\n";
			}
			return md.trim();
		}
	});
}
function runDiff(fileA, fileB, dbPath) {
	return withDB(dbPath, (db) => {
		const relA = resolveRelativePath(db, fileA);
		const relB = resolveRelativePath(db, fileB);
		const recA = db.getFile(relA);
		const recB = db.getFile(relB);
		if (!recA) throw new Error(`File not indexed: ${relA}. The file must be added to the index first. Run 'spelunk scan' to update the index.`);
		if (!recB) throw new Error(`File not indexed: ${relB}. The file must be added to the index first. Run 'spelunk scan' to update the index.`);
		const setExportsA = new Set(recA.exports);
		const setExportsB = new Set(recB.exports);
		const setImportsA = new Set(recA.imports);
		const setImportsB = new Set(recB.imports);
		const addedExports = recB.exports.filter((x) => !setExportsA.has(x));
		const removedExports = recA.exports.filter((x) => !setExportsB.has(x));
		const addedImports = recB.imports.filter((x) => !setImportsA.has(x));
		const removedImports = recA.imports.filter((x) => !setImportsB.has(x));
		return {
			fileA: relA,
			fileB: relB,
			exports: {
				added: addedExports,
				removed: removedExports
			},
			imports: {
				added: addedImports,
				removed: removedImports
			}
		};
	});
}

//#endregion
//#region src/core/commands.ts
async function runCliCommand(config) {
	const args = process.argv.slice(2);
	let formatVal = "markdown";
	const formatIdx = args.indexOf("--format") !== -1 ? args.indexOf("--format") : args.indexOf("-f");
	if (args.includes("-f=json") || args.includes("--format=json") || formatIdx !== -1 && args[formatIdx + 1] === "json") formatVal = "json";
	try {
		const parseOptions = { format: {
			type: "string",
			short: "f"
		} };
		if (config.options) for (const [key, val] of Object.entries(config.options)) {
			parseOptions[key] = { type: val.type };
			if (val.short !== void 0) parseOptions[key].short = val.short;
		}
		const { values, positionals } = parseArgs({
			args,
			options: parseOptions,
			allowPositionals: config.allowPositionals ?? true,
			strict: true
		});
		const opts = { ...values };
		opts.format = opts.format || formatVal;
		formatVal = opts.format;
		if (config.options) {
			for (const [key, val] of Object.entries(config.options)) if (opts[key] === void 0 && val.default !== void 0) opts[key] = val.default;
		}
		const validationResult = config.validate(opts, positionals);
		if (typeof validationResult === "string") throw new Error(validationResult);
		else if (!validationResult) throw new Error("Invalid arguments");
		const defaultDbPath = path.join(process.cwd(), ".spelunk", "data.db");
		const dbPath = process.env.SPELUNK_DB_PATH || defaultDbPath;
		const res = await config.execute(dbPath, opts, positionals);
		if (formatVal === "json") {
			const jsonRes = config.formatJson ? config.formatJson(res) : res;
			console.log(JSON.stringify(jsonRes, null, 2));
		} else console.log(config.formatMarkdown(res, opts, positionals));
	} catch (err) {
		if (formatVal === "json") {
			console.log(JSON.stringify({
				isError: true,
				message: err.message
			}, null, 2));
			process.exit(1);
		} else {
			console.error(`${config.name} failed: ${err.message}`);
			process.exit(1);
		}
	}
}

//#endregion
export { runExport as a, scanDirectory as c, runExplain as i, runDeps as n, runFind as o, runDiff as r, runOutline as s, runCliCommand as t };