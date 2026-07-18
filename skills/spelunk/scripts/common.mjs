#!/usr/bin/env node
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import os from "node:os";
import { parseArgs } from "node:util";

//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esmMin = (fn, res, err) => () => {
	if (err) throw err[0];
	try {
		return fn && (res = fn(fn = 0)), res;
	} catch (e) {
		throw err = [e], e;
	}
};
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") {
		for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
			key = keys[i];
			if (!__hasOwnProp.call(to, key) && key !== except) {
				__defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
		}
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();

//#endregion
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
//#region node_modules/tsdown/esm-shims.js
var getFilename, getDirname, __dirname;
var init_esm_shims = __esmMin((() => {
	getFilename = () => fileURLToPath(import.meta.url);
	getDirname = () => path.dirname(getFilename());
	__dirname = /* @__PURE__ */ getDirname();
}));

//#endregion
//#region node_modules/web-tree-sitter/tree-sitter.js
var require_tree_sitter = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	init_esm_shims();
	var Module = typeof Module != "undefined" ? Module : {};
	var ENVIRONMENT_IS_WEB = typeof window == "object";
	var ENVIRONMENT_IS_WORKER = typeof importScripts == "function";
	var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string";
	var TreeSitter = function() {
		var initPromise;
		var document = typeof window == "object" ? { currentScript: window.document.currentScript } : null;
		class Parser {
			constructor() {
				this.initialize();
			}
			initialize() {
				throw new Error("cannot construct a Parser before calling `init()`");
			}
			static init(moduleOptions) {
				if (initPromise) return initPromise;
				Module = Object.assign({}, Module, moduleOptions);
				return initPromise = new Promise((resolveInitPromise) => {
					var moduleOverrides = Object.assign({}, Module);
					var arguments_ = [];
					var thisProgram = "./this.program";
					var quit_ = (status, toThrow) => {
						throw toThrow;
					};
					var scriptDirectory = "";
					function locateFile(path) {
						if (Module["locateFile"]) return Module["locateFile"](path, scriptDirectory);
						return scriptDirectory + path;
					}
					var readAsync, readBinary;
					if (ENVIRONMENT_IS_NODE) {
						var fs = __require("fs");
						var nodePath = __require("path");
						scriptDirectory = __dirname + "/";
						readBinary = (filename) => {
							filename = isFileURI(filename) ? new URL(filename) : nodePath.normalize(filename);
							return fs.readFileSync(filename);
						};
						readAsync = (filename, binary = true) => {
							filename = isFileURI(filename) ? new URL(filename) : nodePath.normalize(filename);
							return new Promise((resolve, reject) => {
								fs.readFile(filename, binary ? void 0 : "utf8", (err, data) => {
									if (err) reject(err);
									else resolve(binary ? data.buffer : data);
								});
							});
						};
						if (!Module["thisProgram"] && process.argv.length > 1) thisProgram = process.argv[1].replace(/\\/g, "/");
						arguments_ = process.argv.slice(2);
						if (typeof module != "undefined") module["exports"] = Module;
						quit_ = (status, toThrow) => {
							process.exitCode = status;
							throw toThrow;
						};
					} else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
						if (ENVIRONMENT_IS_WORKER) scriptDirectory = self.location.href;
						else if (typeof document != "undefined" && document.currentScript) scriptDirectory = document.currentScript.src;
						if (scriptDirectory.startsWith("blob:")) scriptDirectory = "";
						else scriptDirectory = scriptDirectory.substr(0, scriptDirectory.replace(/[?#].*/, "").lastIndexOf("/") + 1);
						if (ENVIRONMENT_IS_WORKER) readBinary = (url) => {
							var xhr = new XMLHttpRequest();
							xhr.open("GET", url, false);
							xhr.responseType = "arraybuffer";
							xhr.send(null);
							return new Uint8Array(xhr.response);
						};
						readAsync = (url) => {
							if (isFileURI(url)) return new Promise((reject, resolve) => {
								var xhr = new XMLHttpRequest();
								xhr.open("GET", url, true);
								xhr.responseType = "arraybuffer";
								xhr.onload = () => {
									if (xhr.status == 200 || xhr.status == 0 && xhr.response) resolve(xhr.response);
									reject(xhr.status);
								};
								xhr.onerror = reject;
								xhr.send(null);
							});
							return fetch(url, { credentials: "same-origin" }).then((response) => {
								if (response.ok) return response.arrayBuffer();
								return Promise.reject(/* @__PURE__ */ new Error(response.status + " : " + response.url));
							});
						};
					}
					var out = Module["print"] || console.log.bind(console);
					var err = Module["printErr"] || console.error.bind(console);
					Object.assign(Module, moduleOverrides);
					moduleOverrides = null;
					if (Module["arguments"]) arguments_ = Module["arguments"];
					if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
					if (Module["quit"]) quit_ = Module["quit"];
					var dynamicLibraries = Module["dynamicLibraries"] || [];
					var wasmBinary;
					if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
					var wasmMemory;
					var ABORT = false;
					var EXITSTATUS, HEAP8, HEAPU8;
					var HEAP_DATA_VIEW;
					function updateMemoryViews() {
						var b = wasmMemory.buffer;
						Module["HEAP_DATA_VIEW"] = HEAP_DATA_VIEW = new DataView(b);
						Module["HEAP8"] = HEAP8 = new Int8Array(b);
						Module["HEAP16"] = new Int16Array(b);
						Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
						Module["HEAPU16"] = new Uint16Array(b);
						Module["HEAP32"] = new Int32Array(b);
						Module["HEAPU32"] = new Uint32Array(b);
						Module["HEAPF32"] = new Float32Array(b);
						Module["HEAPF64"] = new Float64Array(b);
					}
					if (Module["wasmMemory"]) wasmMemory = Module["wasmMemory"];
					else {
						var INITIAL_MEMORY = Module["INITIAL_MEMORY"] || 33554432;
						wasmMemory = new WebAssembly.Memory({
							"initial": INITIAL_MEMORY / 65536,
							"maximum": 2147483648 / 65536
						});
					}
					updateMemoryViews();
					var __ATPRERUN__ = [];
					var __ATINIT__ = [];
					var __ATMAIN__ = [];
					var __ATPOSTRUN__ = [];
					var __RELOC_FUNCS__ = [];
					var runtimeInitialized = false;
					function preRun() {
						if (Module["preRun"]) {
							if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]];
							while (Module["preRun"].length) addOnPreRun(Module["preRun"].shift());
						}
						callRuntimeCallbacks(__ATPRERUN__);
					}
					function initRuntime() {
						runtimeInitialized = true;
						callRuntimeCallbacks(__RELOC_FUNCS__);
						callRuntimeCallbacks(__ATINIT__);
					}
					function preMain() {
						callRuntimeCallbacks(__ATMAIN__);
					}
					function postRun() {
						if (Module["postRun"]) {
							if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]];
							while (Module["postRun"].length) addOnPostRun(Module["postRun"].shift());
						}
						callRuntimeCallbacks(__ATPOSTRUN__);
					}
					function addOnPreRun(cb) {
						__ATPRERUN__.unshift(cb);
					}
					function addOnInit(cb) {
						__ATINIT__.unshift(cb);
					}
					function addOnPostRun(cb) {
						__ATPOSTRUN__.unshift(cb);
					}
					var runDependencies = 0;
					var runDependencyWatcher = null;
					var dependenciesFulfilled = null;
					function getUniqueRunDependency(id) {
						return id;
					}
					function addRunDependency(id) {
						runDependencies++;
						Module["monitorRunDependencies"]?.(runDependencies);
					}
					function removeRunDependency(id) {
						runDependencies--;
						Module["monitorRunDependencies"]?.(runDependencies);
						if (runDependencies == 0) {
							if (runDependencyWatcher !== null) {
								clearInterval(runDependencyWatcher);
								runDependencyWatcher = null;
							}
							if (dependenciesFulfilled) {
								var callback = dependenciesFulfilled;
								dependenciesFulfilled = null;
								callback();
							}
						}
					}
					/** @param {string|number=} what */ function abort(what) {
						Module["onAbort"]?.(what);
						what = "Aborted(" + what + ")";
						err(what);
						ABORT = true;
						EXITSTATUS = 1;
						what += ". Build with -sASSERTIONS for more info.";
						throw new WebAssembly.RuntimeError(what);
					}
					var dataURIPrefix = "data:application/octet-stream;base64,";
					/**
					* Indicates whether filename is a base64 data URI.
					* @noinline
					*/ var isDataURI = (filename) => filename.startsWith(dataURIPrefix);
					/**
					* Indicates whether filename is delivered via file protocol (as opposed to http/https)
					* @noinline
					*/ var isFileURI = (filename) => filename.startsWith("file://");
					function findWasmBinary() {
						var f = "tree-sitter.wasm";
						if (!isDataURI(f)) return locateFile(f);
						return f;
					}
					var wasmBinaryFile;
					function getBinarySync(file) {
						if (file == wasmBinaryFile && wasmBinary) return new Uint8Array(wasmBinary);
						if (readBinary) return readBinary(file);
						throw "both async and sync fetching of the wasm failed";
					}
					function getBinaryPromise(binaryFile) {
						if (!wasmBinary) return readAsync(binaryFile).then((response) => new Uint8Array(response), () => getBinarySync(binaryFile));
						return Promise.resolve().then(() => getBinarySync(binaryFile));
					}
					function instantiateArrayBuffer(binaryFile, imports, receiver) {
						return getBinaryPromise(binaryFile).then((binary) => WebAssembly.instantiate(binary, imports)).then(receiver, (reason) => {
							err(`failed to asynchronously prepare wasm: ${reason}`);
							abort(reason);
						});
					}
					function instantiateAsync(binary, binaryFile, imports, callback) {
						if (!binary && typeof WebAssembly.instantiateStreaming == "function" && !isDataURI(binaryFile) && !isFileURI(binaryFile) && !ENVIRONMENT_IS_NODE && typeof fetch == "function") return fetch(binaryFile, { credentials: "same-origin" }).then((response) => {
							return WebAssembly.instantiateStreaming(response, imports).then(callback, function(reason) {
								err(`wasm streaming compile failed: ${reason}`);
								err("falling back to ArrayBuffer instantiation");
								return instantiateArrayBuffer(binaryFile, imports, callback);
							});
						});
						return instantiateArrayBuffer(binaryFile, imports, callback);
					}
					function getWasmImports() {
						return {
							"env": wasmImports,
							"wasi_snapshot_preview1": wasmImports,
							"GOT.mem": new Proxy(wasmImports, GOTHandler),
							"GOT.func": new Proxy(wasmImports, GOTHandler)
						};
					}
					function createWasm() {
						var info = getWasmImports();
						/** @param {WebAssembly.Module=} module*/ function receiveInstance(instance, module$1) {
							wasmExports = instance.exports;
							wasmExports = relocateExports(wasmExports, 1024);
							var metadata = getDylinkMetadata(module$1);
							if (metadata.neededDynlibs) dynamicLibraries = metadata.neededDynlibs.concat(dynamicLibraries);
							mergeLibSymbols(wasmExports, "main");
							LDSO.init();
							loadDylibs();
							addOnInit(wasmExports["__wasm_call_ctors"]);
							__RELOC_FUNCS__.push(wasmExports["__wasm_apply_data_relocs"]);
							removeRunDependency("wasm-instantiate");
							return wasmExports;
						}
						addRunDependency("wasm-instantiate");
						function receiveInstantiationResult(result) {
							receiveInstance(result["instance"], result["module"]);
						}
						if (Module["instantiateWasm"]) try {
							return Module["instantiateWasm"](info, receiveInstance);
						} catch (e) {
							err(`Module.instantiateWasm callback failed with error: ${e}`);
							return false;
						}
						if (!wasmBinaryFile) wasmBinaryFile = findWasmBinary();
						instantiateAsync(wasmBinary, wasmBinaryFile, info, receiveInstantiationResult);
						return {};
					}
					var ASM_CONSTS = {};
					/** @constructor */ function ExitStatus(status) {
						this.name = "ExitStatus";
						this.message = `Program terminated with exit(${status})`;
						this.status = status;
					}
					var GOT = {};
					var currentModuleWeakSymbols = /* @__PURE__ */ new Set([]);
					var GOTHandler = { get(obj, symName) {
						var rtn = GOT[symName];
						if (!rtn) rtn = GOT[symName] = new WebAssembly.Global({
							"value": "i32",
							"mutable": true
						});
						if (!currentModuleWeakSymbols.has(symName)) rtn.required = true;
						return rtn;
					} };
					var LE_HEAP_LOAD_F32 = (byteOffset) => HEAP_DATA_VIEW.getFloat32(byteOffset, true);
					var LE_HEAP_LOAD_F64 = (byteOffset) => HEAP_DATA_VIEW.getFloat64(byteOffset, true);
					var LE_HEAP_LOAD_I16 = (byteOffset) => HEAP_DATA_VIEW.getInt16(byteOffset, true);
					var LE_HEAP_LOAD_I32 = (byteOffset) => HEAP_DATA_VIEW.getInt32(byteOffset, true);
					var LE_HEAP_LOAD_U32 = (byteOffset) => HEAP_DATA_VIEW.getUint32(byteOffset, true);
					var LE_HEAP_STORE_F32 = (byteOffset, value) => HEAP_DATA_VIEW.setFloat32(byteOffset, value, true);
					var LE_HEAP_STORE_F64 = (byteOffset, value) => HEAP_DATA_VIEW.setFloat64(byteOffset, value, true);
					var LE_HEAP_STORE_I16 = (byteOffset, value) => HEAP_DATA_VIEW.setInt16(byteOffset, value, true);
					var LE_HEAP_STORE_I32 = (byteOffset, value) => HEAP_DATA_VIEW.setInt32(byteOffset, value, true);
					var LE_HEAP_STORE_U32 = (byteOffset, value) => HEAP_DATA_VIEW.setUint32(byteOffset, value, true);
					var callRuntimeCallbacks = (callbacks) => {
						while (callbacks.length > 0) callbacks.shift()(Module);
					};
					var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder() : void 0;
					/**
					* Given a pointer 'idx' to a null-terminated UTF8-encoded string in the given
					* array that contains uint8 values, returns a copy of that string as a
					* Javascript String object.
					* heapOrArray is either a regular array, or a JavaScript typed array view.
					* @param {number} idx
					* @param {number=} maxBytesToRead
					* @return {string}
					*/ var UTF8ArrayToString = (heapOrArray, idx, maxBytesToRead) => {
						var endIdx = idx + maxBytesToRead;
						var endPtr = idx;
						while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
						if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
						var str = "";
						while (idx < endPtr) {
							var u0 = heapOrArray[idx++];
							if (!(u0 & 128)) {
								str += String.fromCharCode(u0);
								continue;
							}
							var u1 = heapOrArray[idx++] & 63;
							if ((u0 & 224) == 192) {
								str += String.fromCharCode((u0 & 31) << 6 | u1);
								continue;
							}
							var u2 = heapOrArray[idx++] & 63;
							if ((u0 & 240) == 224) u0 = (u0 & 15) << 12 | u1 << 6 | u2;
							else u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
							if (u0 < 65536) str += String.fromCharCode(u0);
							else {
								var ch = u0 - 65536;
								str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
							}
						}
						return str;
					};
					var getDylinkMetadata = (binary) => {
						var offset = 0;
						var end = 0;
						function getU8() {
							return binary[offset++];
						}
						function getLEB() {
							var ret = 0;
							var mul = 1;
							while (1) {
								var byte = binary[offset++];
								ret += (byte & 127) * mul;
								mul *= 128;
								if (!(byte & 128)) break;
							}
							return ret;
						}
						function getString() {
							var len = getLEB();
							offset += len;
							return UTF8ArrayToString(binary, offset - len, len);
						}
						/** @param {string=} message */ function failIf(condition, message) {
							if (condition) throw new Error(message);
						}
						var name = "dylink.0";
						if (binary instanceof WebAssembly.Module) {
							var dylinkSection = WebAssembly.Module.customSections(binary, name);
							if (dylinkSection.length === 0) {
								name = "dylink";
								dylinkSection = WebAssembly.Module.customSections(binary, name);
							}
							failIf(dylinkSection.length === 0, "need dylink section");
							binary = new Uint8Array(dylinkSection[0]);
							end = binary.length;
						} else {
							var int32View = new Uint32Array(new Uint8Array(binary.subarray(0, 24)).buffer);
							failIf(!(int32View[0] == 1836278016 || int32View[0] == 6386541), "need to see wasm magic number");
							failIf(binary[8] !== 0, "need the dylink section to be first");
							offset = 9;
							var section_size = getLEB();
							end = offset + section_size;
							name = getString();
						}
						var customSection = {
							neededDynlibs: [],
							tlsExports: /* @__PURE__ */ new Set(),
							weakImports: /* @__PURE__ */ new Set()
						};
						if (name == "dylink") {
							customSection.memorySize = getLEB();
							customSection.memoryAlign = getLEB();
							customSection.tableSize = getLEB();
							customSection.tableAlign = getLEB();
							var neededDynlibsCount = getLEB();
							for (var i = 0; i < neededDynlibsCount; ++i) {
								var libname = getString();
								customSection.neededDynlibs.push(libname);
							}
						} else {
							failIf(name !== "dylink.0");
							var WASM_DYLINK_MEM_INFO = 1;
							var WASM_DYLINK_NEEDED = 2;
							var WASM_DYLINK_EXPORT_INFO = 3;
							var WASM_DYLINK_IMPORT_INFO = 4;
							var WASM_SYMBOL_TLS = 256;
							var WASM_SYMBOL_BINDING_MASK = 3;
							var WASM_SYMBOL_BINDING_WEAK = 1;
							while (offset < end) {
								var subsectionType = getU8();
								var subsectionSize = getLEB();
								if (subsectionType === WASM_DYLINK_MEM_INFO) {
									customSection.memorySize = getLEB();
									customSection.memoryAlign = getLEB();
									customSection.tableSize = getLEB();
									customSection.tableAlign = getLEB();
								} else if (subsectionType === WASM_DYLINK_NEEDED) {
									var neededDynlibsCount = getLEB();
									for (var i = 0; i < neededDynlibsCount; ++i) {
										libname = getString();
										customSection.neededDynlibs.push(libname);
									}
								} else if (subsectionType === WASM_DYLINK_EXPORT_INFO) {
									var count = getLEB();
									while (count--) {
										var symname = getString();
										var flags = getLEB();
										if (flags & WASM_SYMBOL_TLS) customSection.tlsExports.add(symname);
									}
								} else if (subsectionType === WASM_DYLINK_IMPORT_INFO) {
									var count = getLEB();
									while (count--) {
										getString();
										var symname = getString();
										var flags = getLEB();
										if ((flags & WASM_SYMBOL_BINDING_MASK) == WASM_SYMBOL_BINDING_WEAK) customSection.weakImports.add(symname);
									}
								} else offset += subsectionSize;
							}
						}
						return customSection;
					};
					/**
					* @param {number} ptr
					* @param {string} type
					*/ function getValue(ptr, type = "i8") {
						if (type.endsWith("*")) type = "*";
						switch (type) {
							case "i1": return HEAP8[ptr];
							case "i8": return HEAP8[ptr];
							case "i16": return LE_HEAP_LOAD_I16((ptr >> 1) * 2);
							case "i32": return LE_HEAP_LOAD_I32((ptr >> 2) * 4);
							case "i64": abort("to do getValue(i64) use WASM_BIGINT");
							case "float": return LE_HEAP_LOAD_F32((ptr >> 2) * 4);
							case "double": return LE_HEAP_LOAD_F64((ptr >> 3) * 8);
							case "*": return LE_HEAP_LOAD_U32((ptr >> 2) * 4);
							default: abort(`invalid type for getValue: ${type}`);
						}
					}
					var newDSO = (name, handle, syms) => {
						var dso = {
							refcount: Infinity,
							name,
							exports: syms,
							global: true
						};
						LDSO.loadedLibsByName[name] = dso;
						if (handle != void 0) LDSO.loadedLibsByHandle[handle] = dso;
						return dso;
					};
					var LDSO = {
						loadedLibsByName: {},
						loadedLibsByHandle: {},
						init() {
							newDSO("__main__", 0, wasmImports);
						}
					};
					var ___heap_base = 78112;
					var zeroMemory = (address, size) => {
						HEAPU8.fill(0, address, address + size);
						return address;
					};
					var alignMemory = (size, alignment) => Math.ceil(size / alignment) * alignment;
					var getMemory = (size) => {
						if (runtimeInitialized) return zeroMemory(_malloc(size), size);
						var ret = ___heap_base;
						var end = ret + alignMemory(size, 16);
						___heap_base = end;
						GOT["__heap_base"].value = end;
						return ret;
					};
					var isInternalSym = (symName) => [
						"__cpp_exception",
						"__c_longjmp",
						"__wasm_apply_data_relocs",
						"__dso_handle",
						"__tls_size",
						"__tls_align",
						"__set_stack_limits",
						"_emscripten_tls_init",
						"__wasm_init_tls",
						"__wasm_call_ctors",
						"__start_em_asm",
						"__stop_em_asm",
						"__start_em_js",
						"__stop_em_js"
					].includes(symName) || symName.startsWith("__em_js__");
					var uleb128Encode = (n, target) => {
						if (n < 128) target.push(n);
						else target.push(n % 128 | 128, n >> 7);
					};
					var sigToWasmTypes = (sig) => {
						var typeNames = {
							"i": "i32",
							"j": "i64",
							"f": "f32",
							"d": "f64",
							"e": "externref",
							"p": "i32"
						};
						var type = {
							parameters: [],
							results: sig[0] == "v" ? [] : [typeNames[sig[0]]]
						};
						for (var i = 1; i < sig.length; ++i) type.parameters.push(typeNames[sig[i]]);
						return type;
					};
					var generateFuncType = (sig, target) => {
						var sigRet = sig.slice(0, 1);
						var sigParam = sig.slice(1);
						var typeCodes = {
							"i": 127,
							"p": 127,
							"j": 126,
							"f": 125,
							"d": 124,
							"e": 111
						};
						target.push(96);
						uleb128Encode(sigParam.length, target);
						for (var i = 0; i < sigParam.length; ++i) target.push(typeCodes[sigParam[i]]);
						if (sigRet == "v") target.push(0);
						else target.push(1, typeCodes[sigRet]);
					};
					var convertJsFunctionToWasm = (func, sig) => {
						if (typeof WebAssembly.Function == "function") return new WebAssembly.Function(sigToWasmTypes(sig), func);
						var typeSectionBody = [1];
						generateFuncType(sig, typeSectionBody);
						var bytes = [
							0,
							97,
							115,
							109,
							1,
							0,
							0,
							0,
							1
						];
						uleb128Encode(typeSectionBody.length, bytes);
						bytes.push(...typeSectionBody);
						bytes.push(2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0);
						var module$2 = new WebAssembly.Module(new Uint8Array(bytes));
						return new WebAssembly.Instance(module$2, { "e": { "f": func } }).exports["f"];
					};
					var wasmTableMirror = [];
					/** @type {WebAssembly.Table} */ var wasmTable = new WebAssembly.Table({
						"initial": 28,
						"element": "anyfunc"
					});
					var getWasmTableEntry = (funcPtr) => {
						var func = wasmTableMirror[funcPtr];
						if (!func) {
							if (funcPtr >= wasmTableMirror.length) wasmTableMirror.length = funcPtr + 1;
							wasmTableMirror[funcPtr] = func = wasmTable.get(funcPtr);
						}
						return func;
					};
					var updateTableMap = (offset, count) => {
						if (functionsInTableMap) for (var i = offset; i < offset + count; i++) {
							var item = getWasmTableEntry(i);
							if (item) functionsInTableMap.set(item, i);
						}
					};
					var functionsInTableMap;
					var getFunctionAddress = (func) => {
						if (!functionsInTableMap) {
							functionsInTableMap = /* @__PURE__ */ new WeakMap();
							updateTableMap(0, wasmTable.length);
						}
						return functionsInTableMap.get(func) || 0;
					};
					var freeTableIndexes = [];
					var getEmptyTableSlot = () => {
						if (freeTableIndexes.length) return freeTableIndexes.pop();
						try {
							wasmTable.grow(1);
						} catch (err) {
							if (!(err instanceof RangeError)) throw err;
							throw "Unable to grow wasm table. Set ALLOW_TABLE_GROWTH.";
						}
						return wasmTable.length - 1;
					};
					var setWasmTableEntry = (idx, func) => {
						wasmTable.set(idx, func);
						wasmTableMirror[idx] = wasmTable.get(idx);
					};
					/** @param {string=} sig */ var addFunction = (func, sig) => {
						var rtn = getFunctionAddress(func);
						if (rtn) return rtn;
						var ret = getEmptyTableSlot();
						try {
							setWasmTableEntry(ret, func);
						} catch (err) {
							if (!(err instanceof TypeError)) throw err;
							setWasmTableEntry(ret, convertJsFunctionToWasm(func, sig));
						}
						functionsInTableMap.set(func, ret);
						return ret;
					};
					var updateGOT = (exports$1, replace) => {
						for (var symName in exports$1) {
							if (isInternalSym(symName)) continue;
							var value = exports$1[symName];
							if (symName.startsWith("orig$")) {
								symName = symName.split("$")[1];
								replace = true;
							}
							GOT[symName] ||= new WebAssembly.Global({
								"value": "i32",
								"mutable": true
							});
							if (replace || GOT[symName].value == 0) if (typeof value == "function") GOT[symName].value = addFunction(value);
							else if (typeof value == "number") GOT[symName].value = value;
							else err(`unhandled export type for '${symName}': ${typeof value}`);
						}
					};
					/** @param {boolean=} replace */ var relocateExports = (exports$2, memoryBase, replace) => {
						var relocated = {};
						for (var e in exports$2) {
							var value = exports$2[e];
							if (typeof value == "object") value = value.value;
							if (typeof value == "number") value += memoryBase;
							relocated[e] = value;
						}
						updateGOT(relocated, replace);
						return relocated;
					};
					var isSymbolDefined = (symName) => {
						var existing = wasmImports[symName];
						if (!existing || existing.stub) return false;
						return true;
					};
					var dynCallLegacy = (sig, ptr, args) => {
						sig = sig.replace(/p/g, "i");
						var f = Module["dynCall_" + sig];
						return f(ptr, ...args);
					};
					var dynCall = (sig, ptr, args = []) => {
						if (sig.includes("j")) return dynCallLegacy(sig, ptr, args);
						return getWasmTableEntry(ptr)(...args);
					};
					var stackSave = () => _emscripten_stack_get_current();
					var stackRestore = (val) => __emscripten_stack_restore(val);
					var createInvokeFunction = (sig) => (ptr, ...args) => {
						var sp = stackSave();
						try {
							return dynCall(sig, ptr, args);
						} catch (e) {
							stackRestore(sp);
							if (e !== e + 0) throw e;
							_setThrew(1, 0);
						}
					};
					var resolveGlobalSymbol = (symName, direct = false) => {
						var sym;
						if (direct && "orig$" + symName in wasmImports) symName = "orig$" + symName;
						if (isSymbolDefined(symName)) sym = wasmImports[symName];
						else if (symName.startsWith("invoke_")) sym = wasmImports[symName] = createInvokeFunction(symName.split("_")[1]);
						return {
							sym,
							name: symName
						};
					};
					/**
					* Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the
					* emscripten HEAP, returns a copy of that string as a Javascript String object.
					*
					* @param {number} ptr
					* @param {number=} maxBytesToRead - An optional length that specifies the
					*   maximum number of bytes to read. You can omit this parameter to scan the
					*   string until the first 0 byte. If maxBytesToRead is passed, and the string
					*   at [ptr, ptr+maxBytesToReadr[ contains a null byte in the middle, then the
					*   string will cut short at that byte index (i.e. maxBytesToRead will not
					*   produce a string of exact length [ptr, ptr+maxBytesToRead[) N.B. mixing
					*   frequent uses of UTF8ToString() with and without maxBytesToRead may throw
					*   JS JIT optimizations off, so it is worth to consider consistently using one
					* @return {string}
					*/ var UTF8ToString = (ptr, maxBytesToRead) => ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : "";
					/**
					* @param {string=} libName
					* @param {Object=} localScope
					* @param {number=} handle
					*/ var loadWebAssemblyModule = (binary, flags, libName, localScope, handle) => {
						var metadata = getDylinkMetadata(binary);
						currentModuleWeakSymbols = metadata.weakImports;
						function loadModule() {
							if (!handle || !HEAP8[handle + 8]) {
								var memAlign = Math.pow(2, metadata.memoryAlign);
								var memoryBase = metadata.memorySize ? alignMemory(getMemory(metadata.memorySize + memAlign), memAlign) : 0;
								var tableBase = metadata.tableSize ? wasmTable.length : 0;
								if (handle) {
									HEAP8[handle + 8] = 1;
									LE_HEAP_STORE_U32((handle + 12 >> 2) * 4, memoryBase);
									LE_HEAP_STORE_I32((handle + 16 >> 2) * 4, metadata.memorySize);
									LE_HEAP_STORE_U32((handle + 20 >> 2) * 4, tableBase);
									LE_HEAP_STORE_I32((handle + 24 >> 2) * 4, metadata.tableSize);
								}
							} else {
								memoryBase = LE_HEAP_LOAD_U32((handle + 12 >> 2) * 4);
								tableBase = LE_HEAP_LOAD_U32((handle + 20 >> 2) * 4);
							}
							var tableGrowthNeeded = tableBase + metadata.tableSize - wasmTable.length;
							if (tableGrowthNeeded > 0) wasmTable.grow(tableGrowthNeeded);
							var moduleExports;
							function resolveSymbol(sym) {
								var resolved = resolveGlobalSymbol(sym).sym;
								if (!resolved && localScope) resolved = localScope[sym];
								if (!resolved) resolved = moduleExports[sym];
								return resolved;
							}
							var proxy = new Proxy({}, { get(stubs, prop) {
								switch (prop) {
									case "__memory_base": return memoryBase;
									case "__table_base": return tableBase;
								}
								if (prop in wasmImports && !wasmImports[prop].stub) return wasmImports[prop];
								if (!(prop in stubs)) {
									var resolved;
									stubs[prop] = (...args) => {
										resolved ||= resolveSymbol(prop);
										return resolved(...args);
									};
								}
								return stubs[prop];
							} });
							var info = {
								"GOT.mem": new Proxy({}, GOTHandler),
								"GOT.func": new Proxy({}, GOTHandler),
								"env": proxy,
								"wasi_snapshot_preview1": proxy
							};
							function postInstantiation(module$4, instance) {
								updateTableMap(tableBase, metadata.tableSize);
								moduleExports = relocateExports(instance.exports, memoryBase);
								if (!flags.allowUndefined) reportUndefinedSymbols();
								function addEmAsm(addr, body) {
									var args = [];
									var arity = 0;
									for (; arity < 16; arity++) if (body.indexOf("$" + arity) != -1) args.push("$" + arity);
									else break;
									args = args.join(",");
									var func = `(${args}) => { ${body} };`;
									ASM_CONSTS[start] = (0, eval)(func);
								}
								if ("__start_em_asm" in moduleExports) {
									var start = moduleExports["__start_em_asm"];
									var stop = moduleExports["__stop_em_asm"];
									while (start < stop) {
										var jsString = UTF8ToString(start);
										addEmAsm(start, jsString);
										start = HEAPU8.indexOf(0, start) + 1;
									}
								}
								function addEmJs(name, cSig, body) {
									var jsArgs = [];
									cSig = cSig.slice(1, -1);
									if (cSig != "void") {
										cSig = cSig.split(",");
										for (var i in cSig) {
											var jsArg = cSig[i].split(" ").pop();
											jsArgs.push(jsArg.replaceAll("*", ""));
										}
									}
									var func = `(${jsArgs}) => ${body};`;
									moduleExports[name] = (0, eval)(func);
								}
								for (var name in moduleExports) if (name.startsWith("__em_js__")) {
									var start = moduleExports[name];
									var jsString = UTF8ToString(start);
									var parts = jsString.split("<::>");
									addEmJs(name.replace("__em_js__", ""), parts[0], parts[1]);
									delete moduleExports[name];
								}
								var applyRelocs = moduleExports["__wasm_apply_data_relocs"];
								if (applyRelocs) if (runtimeInitialized) applyRelocs();
								else __RELOC_FUNCS__.push(applyRelocs);
								var init = moduleExports["__wasm_call_ctors"];
								if (init) if (runtimeInitialized) init();
								else __ATINIT__.push(init);
								return moduleExports;
							}
							if (flags.loadAsync) {
								if (binary instanceof WebAssembly.Module) {
									var instance = new WebAssembly.Instance(binary, info);
									return Promise.resolve(postInstantiation(binary, instance));
								}
								return WebAssembly.instantiate(binary, info).then((result) => postInstantiation(result.module, result.instance));
							}
							var module$3 = binary instanceof WebAssembly.Module ? binary : new WebAssembly.Module(binary);
							var instance = new WebAssembly.Instance(module$3, info);
							return postInstantiation(module$3, instance);
						}
						if (flags.loadAsync) return metadata.neededDynlibs.reduce((chain, dynNeeded) => chain.then(() => loadDynamicLibrary(dynNeeded, flags, localScope)), Promise.resolve()).then(loadModule);
						metadata.neededDynlibs.forEach((needed) => loadDynamicLibrary(needed, flags, localScope));
						return loadModule();
					};
					var mergeLibSymbols = (exports$3, libName) => {
						for (var [sym, exp] of Object.entries(exports$3)) {
							const setImport = (target) => {
								if (!isSymbolDefined(target)) wasmImports[target] = exp;
							};
							setImport(sym);
							const main_alias = "__main_argc_argv";
							if (sym == "main") setImport(main_alias);
							if (sym == main_alias) setImport("main");
							if (sym.startsWith("dynCall_") && !Module.hasOwnProperty(sym)) Module[sym] = exp;
						}
					};
					/** @param {boolean=} noRunDep */ var asyncLoad = (url, onload, onerror, noRunDep) => {
						var dep = !noRunDep ? getUniqueRunDependency(`al ${url}`) : "";
						readAsync(url).then((arrayBuffer) => {
							onload(new Uint8Array(arrayBuffer));
							if (dep) removeRunDependency(dep);
						}, (err) => {
							if (onerror) onerror();
							else throw `Loading data file "${url}" failed.`;
						});
						if (dep) addRunDependency(dep);
					};
					/**
					* @param {number=} handle
					* @param {Object=} localScope
					*/ function loadDynamicLibrary(libName, flags = {
						global: true,
						nodelete: true
					}, localScope, handle) {
						var dso = LDSO.loadedLibsByName[libName];
						if (dso) {
							if (!flags.global) {
								if (localScope) Object.assign(localScope, dso.exports);
							} else if (!dso.global) {
								dso.global = true;
								mergeLibSymbols(dso.exports, libName);
							}
							if (flags.nodelete && dso.refcount !== Infinity) dso.refcount = Infinity;
							dso.refcount++;
							if (handle) LDSO.loadedLibsByHandle[handle] = dso;
							return flags.loadAsync ? Promise.resolve(true) : true;
						}
						dso = newDSO(libName, handle, "loading");
						dso.refcount = flags.nodelete ? Infinity : 1;
						dso.global = flags.global;
						function loadLibData() {
							if (handle) {
								var data = LE_HEAP_LOAD_U32((handle + 28 >> 2) * 4);
								var dataSize = LE_HEAP_LOAD_U32((handle + 32 >> 2) * 4);
								if (data && dataSize) {
									var libData = HEAP8.slice(data, data + dataSize);
									return flags.loadAsync ? Promise.resolve(libData) : libData;
								}
							}
							var libFile = locateFile(libName);
							if (flags.loadAsync) return new Promise(function(resolve, reject) {
								asyncLoad(libFile, resolve, reject);
							});
							if (!readBinary) throw new Error(`${libFile}: file not found, and synchronous loading of external files is not available`);
							return readBinary(libFile);
						}
						function getExports() {
							if (flags.loadAsync) return loadLibData().then((libData) => loadWebAssemblyModule(libData, flags, libName, localScope, handle));
							return loadWebAssemblyModule(loadLibData(), flags, libName, localScope, handle);
						}
						function moduleLoaded(exports$4) {
							if (dso.global) mergeLibSymbols(exports$4, libName);
							else if (localScope) Object.assign(localScope, exports$4);
							dso.exports = exports$4;
						}
						if (flags.loadAsync) return getExports().then((exports$5) => {
							moduleLoaded(exports$5);
							return true;
						});
						moduleLoaded(getExports());
						return true;
					}
					var reportUndefinedSymbols = () => {
						for (var [symName, entry] of Object.entries(GOT)) if (entry.value == 0) {
							var value = resolveGlobalSymbol(symName, true).sym;
							if (!value && !entry.required) continue;
							if (typeof value == "function")
 /** @suppress {checkTypes} */ entry.value = addFunction(value, value.sig);
							else if (typeof value == "number") entry.value = value;
							else throw new Error(`bad export type for '${symName}': ${typeof value}`);
						}
					};
					var loadDylibs = () => {
						if (!dynamicLibraries.length) {
							reportUndefinedSymbols();
							return;
						}
						addRunDependency("loadDylibs");
						dynamicLibraries.reduce((chain, lib) => chain.then(() => loadDynamicLibrary(lib, {
							loadAsync: true,
							global: true,
							nodelete: true,
							allowUndefined: true
						})), Promise.resolve()).then(() => {
							reportUndefinedSymbols();
							removeRunDependency("loadDylibs");
						});
					};
					var noExitRuntime = Module["noExitRuntime"] || true;
					/**
					* @param {number} ptr
					* @param {number} value
					* @param {string} type
					*/ function setValue(ptr, value, type = "i8") {
						if (type.endsWith("*")) type = "*";
						switch (type) {
							case "i1":
								HEAP8[ptr] = value;
								break;
							case "i8":
								HEAP8[ptr] = value;
								break;
							case "i16":
								LE_HEAP_STORE_I16((ptr >> 1) * 2, value);
								break;
							case "i32":
								LE_HEAP_STORE_I32((ptr >> 2) * 4, value);
								break;
							case "i64": abort("to do setValue(i64) use WASM_BIGINT");
							case "float":
								LE_HEAP_STORE_F32((ptr >> 2) * 4, value);
								break;
							case "double":
								LE_HEAP_STORE_F64((ptr >> 3) * 8, value);
								break;
							case "*":
								LE_HEAP_STORE_U32((ptr >> 2) * 4, value);
								break;
							default: abort(`invalid type for setValue: ${type}`);
						}
					}
					var ___memory_base = new WebAssembly.Global({
						"value": "i32",
						"mutable": false
					}, 1024);
					var ___stack_pointer = new WebAssembly.Global({
						"value": "i32",
						"mutable": true
					}, 78112);
					var ___table_base = new WebAssembly.Global({
						"value": "i32",
						"mutable": false
					}, 1);
					var __abort_js = () => {
						abort("");
					};
					__abort_js.sig = "v";
					var nowIsMonotonic = 1;
					var __emscripten_get_now_is_monotonic = () => nowIsMonotonic;
					__emscripten_get_now_is_monotonic.sig = "i";
					var __emscripten_memcpy_js = (dest, src, num) => HEAPU8.copyWithin(dest, src, src + num);
					__emscripten_memcpy_js.sig = "vppp";
					var _emscripten_date_now = () => Date.now();
					_emscripten_date_now.sig = "d";
					var _emscripten_get_now = () => performance.now();
					_emscripten_get_now.sig = "d";
					var getHeapMax = () => 2147483648;
					var growMemory = (size) => {
						var pages = (size - wasmMemory.buffer.byteLength + 65535) / 65536;
						try {
							wasmMemory.grow(pages);
							updateMemoryViews();
							return 1;
						} catch (e) {}
					};
					var _emscripten_resize_heap = (requestedSize) => {
						var oldSize = HEAPU8.length;
						requestedSize >>>= 0;
						var maxHeapSize = getHeapMax();
						if (requestedSize > maxHeapSize) return false;
						var alignUp = (x, multiple) => x + (multiple - x % multiple) % multiple;
						for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
							var overGrownHeapSize = oldSize * (1 + .2 / cutDown);
							overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
							if (growMemory(Math.min(maxHeapSize, alignUp(Math.max(requestedSize, overGrownHeapSize), 65536)))) return true;
						}
						return false;
					};
					_emscripten_resize_heap.sig = "ip";
					var _fd_close = (fd) => 52;
					_fd_close.sig = "ii";
					var convertI32PairToI53Checked = (lo, hi) => hi + 2097152 >>> 0 < 4194305 - !!lo ? (lo >>> 0) + hi * 4294967296 : NaN;
					function _fd_seek(fd, offset_low, offset_high, whence, newOffset) {
						convertI32PairToI53Checked(offset_low, offset_high);
						return 70;
					}
					_fd_seek.sig = "iiiiip";
					var printCharBuffers = [
						null,
						[],
						[]
					];
					var printChar = (stream, curr) => {
						var buffer = printCharBuffers[stream];
						if (curr === 0 || curr === 10) {
							(stream === 1 ? out : err)(UTF8ArrayToString(buffer, 0));
							buffer.length = 0;
						} else buffer.push(curr);
					};
					var _fd_write = (fd, iov, iovcnt, pnum) => {
						var num = 0;
						for (var i = 0; i < iovcnt; i++) {
							var ptr = LE_HEAP_LOAD_U32((iov >> 2) * 4);
							var len = LE_HEAP_LOAD_U32((iov + 4 >> 2) * 4);
							iov += 8;
							for (var j = 0; j < len; j++) printChar(fd, HEAPU8[ptr + j]);
							num += len;
						}
						LE_HEAP_STORE_U32((pnum >> 2) * 4, num);
						return 0;
					};
					_fd_write.sig = "iippp";
					function _tree_sitter_log_callback(isLexMessage, messageAddress) {
						if (currentLogCallback) {
							const message = UTF8ToString(messageAddress);
							currentLogCallback(message, isLexMessage !== 0);
						}
					}
					function _tree_sitter_parse_callback(inputBufferAddress, index, row, column, lengthAddress) {
						const INPUT_BUFFER_SIZE = 10 * 1024;
						const string = currentParseCallback(index, {
							row,
							column
						});
						if (typeof string === "string") {
							setValue(lengthAddress, string.length, "i32");
							stringToUTF16(string, inputBufferAddress, INPUT_BUFFER_SIZE);
						} else setValue(lengthAddress, 0, "i32");
					}
					var runtimeKeepaliveCounter = 0;
					var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;
					var _proc_exit = (code) => {
						EXITSTATUS = code;
						if (!keepRuntimeAlive()) {
							Module["onExit"]?.(code);
							ABORT = true;
						}
						quit_(code, new ExitStatus(code));
					};
					_proc_exit.sig = "vi";
					/** @param {boolean|number=} implicit */ var exitJS = (status, implicit) => {
						EXITSTATUS = status;
						_proc_exit(status);
					};
					var handleException = (e) => {
						if (e instanceof ExitStatus || e == "unwind") return EXITSTATUS;
						quit_(1, e);
					};
					var lengthBytesUTF8 = (str) => {
						var len = 0;
						for (var i = 0; i < str.length; ++i) {
							var c = str.charCodeAt(i);
							if (c <= 127) len++;
							else if (c <= 2047) len += 2;
							else if (c >= 55296 && c <= 57343) {
								len += 4;
								++i;
							} else len += 3;
						}
						return len;
					};
					var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
						if (!(maxBytesToWrite > 0)) return 0;
						var startIdx = outIdx;
						var endIdx = outIdx + maxBytesToWrite - 1;
						for (var i = 0; i < str.length; ++i) {
							var u = str.charCodeAt(i);
							if (u >= 55296 && u <= 57343) {
								var u1 = str.charCodeAt(++i);
								u = 65536 + ((u & 1023) << 10) | u1 & 1023;
							}
							if (u <= 127) {
								if (outIdx >= endIdx) break;
								heap[outIdx++] = u;
							} else if (u <= 2047) {
								if (outIdx + 1 >= endIdx) break;
								heap[outIdx++] = 192 | u >> 6;
								heap[outIdx++] = 128 | u & 63;
							} else if (u <= 65535) {
								if (outIdx + 2 >= endIdx) break;
								heap[outIdx++] = 224 | u >> 12;
								heap[outIdx++] = 128 | u >> 6 & 63;
								heap[outIdx++] = 128 | u & 63;
							} else {
								if (outIdx + 3 >= endIdx) break;
								heap[outIdx++] = 240 | u >> 18;
								heap[outIdx++] = 128 | u >> 12 & 63;
								heap[outIdx++] = 128 | u >> 6 & 63;
								heap[outIdx++] = 128 | u & 63;
							}
						}
						heap[outIdx] = 0;
						return outIdx - startIdx;
					};
					var stringToUTF8 = (str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
					var stackAlloc = (sz) => __emscripten_stack_alloc(sz);
					var stringToUTF8OnStack = (str) => {
						var size = lengthBytesUTF8(str) + 1;
						var ret = stackAlloc(size);
						stringToUTF8(str, ret, size);
						return ret;
					};
					var stringToUTF16 = (str, outPtr, maxBytesToWrite) => {
						maxBytesToWrite ??= 2147483647;
						if (maxBytesToWrite < 2) return 0;
						maxBytesToWrite -= 2;
						var startPtr = outPtr;
						var numCharsToWrite = maxBytesToWrite < str.length * 2 ? maxBytesToWrite / 2 : str.length;
						for (var i = 0; i < numCharsToWrite; ++i) {
							var codeUnit = str.charCodeAt(i);
							LE_HEAP_STORE_I16((outPtr >> 1) * 2, codeUnit);
							outPtr += 2;
						}
						LE_HEAP_STORE_I16((outPtr >> 1) * 2, 0);
						return outPtr - startPtr;
					};
					var AsciiToString = (ptr) => {
						var str = "";
						while (1) {
							var ch = HEAPU8[ptr++];
							if (!ch) return str;
							str += String.fromCharCode(ch);
						}
					};
					var wasmImports = {
						/** @export */ __heap_base: ___heap_base,
						/** @export */ __indirect_function_table: wasmTable,
						/** @export */ __memory_base: ___memory_base,
						/** @export */ __stack_pointer: ___stack_pointer,
						/** @export */ __table_base: ___table_base,
						/** @export */ _abort_js: __abort_js,
						/** @export */ _emscripten_get_now_is_monotonic: __emscripten_get_now_is_monotonic,
						/** @export */ _emscripten_memcpy_js: __emscripten_memcpy_js,
						/** @export */ emscripten_get_now: _emscripten_get_now,
						/** @export */ emscripten_resize_heap: _emscripten_resize_heap,
						/** @export */ fd_close: _fd_close,
						/** @export */ fd_seek: _fd_seek,
						/** @export */ fd_write: _fd_write,
						/** @export */ memory: wasmMemory,
						/** @export */ tree_sitter_log_callback: _tree_sitter_log_callback,
						/** @export */ tree_sitter_parse_callback: _tree_sitter_parse_callback
					};
					var wasmExports = createWasm();
					var ___wasm_call_ctors = () => (___wasm_call_ctors = wasmExports["__wasm_call_ctors"])();
					var ___wasm_apply_data_relocs = () => (___wasm_apply_data_relocs = wasmExports["__wasm_apply_data_relocs"])();
					var _malloc = Module["_malloc"] = (a0) => (_malloc = Module["_malloc"] = wasmExports["malloc"])(a0);
					var _calloc = Module["_calloc"] = (a0, a1) => (_calloc = Module["_calloc"] = wasmExports["calloc"])(a0, a1);
					var _realloc = Module["_realloc"] = (a0, a1) => (_realloc = Module["_realloc"] = wasmExports["realloc"])(a0, a1);
					var _free = Module["_free"] = (a0) => (_free = Module["_free"] = wasmExports["free"])(a0);
					var _ts_language_symbol_count = Module["_ts_language_symbol_count"] = (a0) => (_ts_language_symbol_count = Module["_ts_language_symbol_count"] = wasmExports["ts_language_symbol_count"])(a0);
					var _ts_language_state_count = Module["_ts_language_state_count"] = (a0) => (_ts_language_state_count = Module["_ts_language_state_count"] = wasmExports["ts_language_state_count"])(a0);
					var _ts_language_version = Module["_ts_language_version"] = (a0) => (_ts_language_version = Module["_ts_language_version"] = wasmExports["ts_language_version"])(a0);
					var _ts_language_field_count = Module["_ts_language_field_count"] = (a0) => (_ts_language_field_count = Module["_ts_language_field_count"] = wasmExports["ts_language_field_count"])(a0);
					var _ts_language_next_state = Module["_ts_language_next_state"] = (a0, a1, a2) => (_ts_language_next_state = Module["_ts_language_next_state"] = wasmExports["ts_language_next_state"])(a0, a1, a2);
					var _ts_language_symbol_name = Module["_ts_language_symbol_name"] = (a0, a1) => (_ts_language_symbol_name = Module["_ts_language_symbol_name"] = wasmExports["ts_language_symbol_name"])(a0, a1);
					var _ts_language_symbol_for_name = Module["_ts_language_symbol_for_name"] = (a0, a1, a2, a3) => (_ts_language_symbol_for_name = Module["_ts_language_symbol_for_name"] = wasmExports["ts_language_symbol_for_name"])(a0, a1, a2, a3);
					var _strncmp = Module["_strncmp"] = (a0, a1, a2) => (_strncmp = Module["_strncmp"] = wasmExports["strncmp"])(a0, a1, a2);
					var _ts_language_symbol_type = Module["_ts_language_symbol_type"] = (a0, a1) => (_ts_language_symbol_type = Module["_ts_language_symbol_type"] = wasmExports["ts_language_symbol_type"])(a0, a1);
					var _ts_language_field_name_for_id = Module["_ts_language_field_name_for_id"] = (a0, a1) => (_ts_language_field_name_for_id = Module["_ts_language_field_name_for_id"] = wasmExports["ts_language_field_name_for_id"])(a0, a1);
					var _ts_lookahead_iterator_new = Module["_ts_lookahead_iterator_new"] = (a0, a1) => (_ts_lookahead_iterator_new = Module["_ts_lookahead_iterator_new"] = wasmExports["ts_lookahead_iterator_new"])(a0, a1);
					var _ts_lookahead_iterator_delete = Module["_ts_lookahead_iterator_delete"] = (a0) => (_ts_lookahead_iterator_delete = Module["_ts_lookahead_iterator_delete"] = wasmExports["ts_lookahead_iterator_delete"])(a0);
					var _ts_lookahead_iterator_reset_state = Module["_ts_lookahead_iterator_reset_state"] = (a0, a1) => (_ts_lookahead_iterator_reset_state = Module["_ts_lookahead_iterator_reset_state"] = wasmExports["ts_lookahead_iterator_reset_state"])(a0, a1);
					var _ts_lookahead_iterator_reset = Module["_ts_lookahead_iterator_reset"] = (a0, a1, a2) => (_ts_lookahead_iterator_reset = Module["_ts_lookahead_iterator_reset"] = wasmExports["ts_lookahead_iterator_reset"])(a0, a1, a2);
					var _ts_lookahead_iterator_next = Module["_ts_lookahead_iterator_next"] = (a0) => (_ts_lookahead_iterator_next = Module["_ts_lookahead_iterator_next"] = wasmExports["ts_lookahead_iterator_next"])(a0);
					var _ts_lookahead_iterator_current_symbol = Module["_ts_lookahead_iterator_current_symbol"] = (a0) => (_ts_lookahead_iterator_current_symbol = Module["_ts_lookahead_iterator_current_symbol"] = wasmExports["ts_lookahead_iterator_current_symbol"])(a0);
					var _memset = Module["_memset"] = (a0, a1, a2) => (_memset = Module["_memset"] = wasmExports["memset"])(a0, a1, a2);
					var _memcpy = Module["_memcpy"] = (a0, a1, a2) => (_memcpy = Module["_memcpy"] = wasmExports["memcpy"])(a0, a1, a2);
					var _ts_parser_delete = Module["_ts_parser_delete"] = (a0) => (_ts_parser_delete = Module["_ts_parser_delete"] = wasmExports["ts_parser_delete"])(a0);
					var _ts_parser_reset = Module["_ts_parser_reset"] = (a0) => (_ts_parser_reset = Module["_ts_parser_reset"] = wasmExports["ts_parser_reset"])(a0);
					var _ts_parser_set_language = Module["_ts_parser_set_language"] = (a0, a1) => (_ts_parser_set_language = Module["_ts_parser_set_language"] = wasmExports["ts_parser_set_language"])(a0, a1);
					var _ts_parser_timeout_micros = Module["_ts_parser_timeout_micros"] = (a0) => (_ts_parser_timeout_micros = Module["_ts_parser_timeout_micros"] = wasmExports["ts_parser_timeout_micros"])(a0);
					var _ts_parser_set_timeout_micros = Module["_ts_parser_set_timeout_micros"] = (a0, a1, a2) => (_ts_parser_set_timeout_micros = Module["_ts_parser_set_timeout_micros"] = wasmExports["ts_parser_set_timeout_micros"])(a0, a1, a2);
					var _ts_parser_set_included_ranges = Module["_ts_parser_set_included_ranges"] = (a0, a1, a2) => (_ts_parser_set_included_ranges = Module["_ts_parser_set_included_ranges"] = wasmExports["ts_parser_set_included_ranges"])(a0, a1, a2);
					var _memmove = Module["_memmove"] = (a0, a1, a2) => (_memmove = Module["_memmove"] = wasmExports["memmove"])(a0, a1, a2);
					var _memcmp = Module["_memcmp"] = (a0, a1, a2) => (_memcmp = Module["_memcmp"] = wasmExports["memcmp"])(a0, a1, a2);
					var _ts_query_new = Module["_ts_query_new"] = (a0, a1, a2, a3, a4) => (_ts_query_new = Module["_ts_query_new"] = wasmExports["ts_query_new"])(a0, a1, a2, a3, a4);
					var _ts_query_delete = Module["_ts_query_delete"] = (a0) => (_ts_query_delete = Module["_ts_query_delete"] = wasmExports["ts_query_delete"])(a0);
					var _iswspace = Module["_iswspace"] = (a0) => (_iswspace = Module["_iswspace"] = wasmExports["iswspace"])(a0);
					var _iswalnum = Module["_iswalnum"] = (a0) => (_iswalnum = Module["_iswalnum"] = wasmExports["iswalnum"])(a0);
					var _ts_query_pattern_count = Module["_ts_query_pattern_count"] = (a0) => (_ts_query_pattern_count = Module["_ts_query_pattern_count"] = wasmExports["ts_query_pattern_count"])(a0);
					var _ts_query_capture_count = Module["_ts_query_capture_count"] = (a0) => (_ts_query_capture_count = Module["_ts_query_capture_count"] = wasmExports["ts_query_capture_count"])(a0);
					var _ts_query_string_count = Module["_ts_query_string_count"] = (a0) => (_ts_query_string_count = Module["_ts_query_string_count"] = wasmExports["ts_query_string_count"])(a0);
					var _ts_query_capture_name_for_id = Module["_ts_query_capture_name_for_id"] = (a0, a1, a2) => (_ts_query_capture_name_for_id = Module["_ts_query_capture_name_for_id"] = wasmExports["ts_query_capture_name_for_id"])(a0, a1, a2);
					var _ts_query_string_value_for_id = Module["_ts_query_string_value_for_id"] = (a0, a1, a2) => (_ts_query_string_value_for_id = Module["_ts_query_string_value_for_id"] = wasmExports["ts_query_string_value_for_id"])(a0, a1, a2);
					var _ts_query_predicates_for_pattern = Module["_ts_query_predicates_for_pattern"] = (a0, a1, a2) => (_ts_query_predicates_for_pattern = Module["_ts_query_predicates_for_pattern"] = wasmExports["ts_query_predicates_for_pattern"])(a0, a1, a2);
					var _ts_query_disable_capture = Module["_ts_query_disable_capture"] = (a0, a1, a2) => (_ts_query_disable_capture = Module["_ts_query_disable_capture"] = wasmExports["ts_query_disable_capture"])(a0, a1, a2);
					var _ts_tree_copy = Module["_ts_tree_copy"] = (a0) => (_ts_tree_copy = Module["_ts_tree_copy"] = wasmExports["ts_tree_copy"])(a0);
					var _ts_tree_delete = Module["_ts_tree_delete"] = (a0) => (_ts_tree_delete = Module["_ts_tree_delete"] = wasmExports["ts_tree_delete"])(a0);
					var _ts_init = Module["_ts_init"] = () => (_ts_init = Module["_ts_init"] = wasmExports["ts_init"])();
					var _ts_parser_new_wasm = Module["_ts_parser_new_wasm"] = () => (_ts_parser_new_wasm = Module["_ts_parser_new_wasm"] = wasmExports["ts_parser_new_wasm"])();
					var _ts_parser_enable_logger_wasm = Module["_ts_parser_enable_logger_wasm"] = (a0, a1) => (_ts_parser_enable_logger_wasm = Module["_ts_parser_enable_logger_wasm"] = wasmExports["ts_parser_enable_logger_wasm"])(a0, a1);
					var _ts_parser_parse_wasm = Module["_ts_parser_parse_wasm"] = (a0, a1, a2, a3, a4) => (_ts_parser_parse_wasm = Module["_ts_parser_parse_wasm"] = wasmExports["ts_parser_parse_wasm"])(a0, a1, a2, a3, a4);
					var _ts_parser_included_ranges_wasm = Module["_ts_parser_included_ranges_wasm"] = (a0) => (_ts_parser_included_ranges_wasm = Module["_ts_parser_included_ranges_wasm"] = wasmExports["ts_parser_included_ranges_wasm"])(a0);
					var _ts_language_type_is_named_wasm = Module["_ts_language_type_is_named_wasm"] = (a0, a1) => (_ts_language_type_is_named_wasm = Module["_ts_language_type_is_named_wasm"] = wasmExports["ts_language_type_is_named_wasm"])(a0, a1);
					var _ts_language_type_is_visible_wasm = Module["_ts_language_type_is_visible_wasm"] = (a0, a1) => (_ts_language_type_is_visible_wasm = Module["_ts_language_type_is_visible_wasm"] = wasmExports["ts_language_type_is_visible_wasm"])(a0, a1);
					var _ts_tree_root_node_wasm = Module["_ts_tree_root_node_wasm"] = (a0) => (_ts_tree_root_node_wasm = Module["_ts_tree_root_node_wasm"] = wasmExports["ts_tree_root_node_wasm"])(a0);
					var _ts_tree_root_node_with_offset_wasm = Module["_ts_tree_root_node_with_offset_wasm"] = (a0) => (_ts_tree_root_node_with_offset_wasm = Module["_ts_tree_root_node_with_offset_wasm"] = wasmExports["ts_tree_root_node_with_offset_wasm"])(a0);
					var _ts_tree_edit_wasm = Module["_ts_tree_edit_wasm"] = (a0) => (_ts_tree_edit_wasm = Module["_ts_tree_edit_wasm"] = wasmExports["ts_tree_edit_wasm"])(a0);
					var _ts_tree_included_ranges_wasm = Module["_ts_tree_included_ranges_wasm"] = (a0) => (_ts_tree_included_ranges_wasm = Module["_ts_tree_included_ranges_wasm"] = wasmExports["ts_tree_included_ranges_wasm"])(a0);
					var _ts_tree_get_changed_ranges_wasm = Module["_ts_tree_get_changed_ranges_wasm"] = (a0, a1) => (_ts_tree_get_changed_ranges_wasm = Module["_ts_tree_get_changed_ranges_wasm"] = wasmExports["ts_tree_get_changed_ranges_wasm"])(a0, a1);
					var _ts_tree_cursor_new_wasm = Module["_ts_tree_cursor_new_wasm"] = (a0) => (_ts_tree_cursor_new_wasm = Module["_ts_tree_cursor_new_wasm"] = wasmExports["ts_tree_cursor_new_wasm"])(a0);
					var _ts_tree_cursor_delete_wasm = Module["_ts_tree_cursor_delete_wasm"] = (a0) => (_ts_tree_cursor_delete_wasm = Module["_ts_tree_cursor_delete_wasm"] = wasmExports["ts_tree_cursor_delete_wasm"])(a0);
					var _ts_tree_cursor_reset_wasm = Module["_ts_tree_cursor_reset_wasm"] = (a0) => (_ts_tree_cursor_reset_wasm = Module["_ts_tree_cursor_reset_wasm"] = wasmExports["ts_tree_cursor_reset_wasm"])(a0);
					var _ts_tree_cursor_reset_to_wasm = Module["_ts_tree_cursor_reset_to_wasm"] = (a0, a1) => (_ts_tree_cursor_reset_to_wasm = Module["_ts_tree_cursor_reset_to_wasm"] = wasmExports["ts_tree_cursor_reset_to_wasm"])(a0, a1);
					var _ts_tree_cursor_goto_first_child_wasm = Module["_ts_tree_cursor_goto_first_child_wasm"] = (a0) => (_ts_tree_cursor_goto_first_child_wasm = Module["_ts_tree_cursor_goto_first_child_wasm"] = wasmExports["ts_tree_cursor_goto_first_child_wasm"])(a0);
					var _ts_tree_cursor_goto_last_child_wasm = Module["_ts_tree_cursor_goto_last_child_wasm"] = (a0) => (_ts_tree_cursor_goto_last_child_wasm = Module["_ts_tree_cursor_goto_last_child_wasm"] = wasmExports["ts_tree_cursor_goto_last_child_wasm"])(a0);
					var _ts_tree_cursor_goto_first_child_for_index_wasm = Module["_ts_tree_cursor_goto_first_child_for_index_wasm"] = (a0) => (_ts_tree_cursor_goto_first_child_for_index_wasm = Module["_ts_tree_cursor_goto_first_child_for_index_wasm"] = wasmExports["ts_tree_cursor_goto_first_child_for_index_wasm"])(a0);
					var _ts_tree_cursor_goto_first_child_for_position_wasm = Module["_ts_tree_cursor_goto_first_child_for_position_wasm"] = (a0) => (_ts_tree_cursor_goto_first_child_for_position_wasm = Module["_ts_tree_cursor_goto_first_child_for_position_wasm"] = wasmExports["ts_tree_cursor_goto_first_child_for_position_wasm"])(a0);
					var _ts_tree_cursor_goto_next_sibling_wasm = Module["_ts_tree_cursor_goto_next_sibling_wasm"] = (a0) => (_ts_tree_cursor_goto_next_sibling_wasm = Module["_ts_tree_cursor_goto_next_sibling_wasm"] = wasmExports["ts_tree_cursor_goto_next_sibling_wasm"])(a0);
					var _ts_tree_cursor_goto_previous_sibling_wasm = Module["_ts_tree_cursor_goto_previous_sibling_wasm"] = (a0) => (_ts_tree_cursor_goto_previous_sibling_wasm = Module["_ts_tree_cursor_goto_previous_sibling_wasm"] = wasmExports["ts_tree_cursor_goto_previous_sibling_wasm"])(a0);
					var _ts_tree_cursor_goto_descendant_wasm = Module["_ts_tree_cursor_goto_descendant_wasm"] = (a0, a1) => (_ts_tree_cursor_goto_descendant_wasm = Module["_ts_tree_cursor_goto_descendant_wasm"] = wasmExports["ts_tree_cursor_goto_descendant_wasm"])(a0, a1);
					var _ts_tree_cursor_goto_parent_wasm = Module["_ts_tree_cursor_goto_parent_wasm"] = (a0) => (_ts_tree_cursor_goto_parent_wasm = Module["_ts_tree_cursor_goto_parent_wasm"] = wasmExports["ts_tree_cursor_goto_parent_wasm"])(a0);
					var _ts_tree_cursor_current_node_type_id_wasm = Module["_ts_tree_cursor_current_node_type_id_wasm"] = (a0) => (_ts_tree_cursor_current_node_type_id_wasm = Module["_ts_tree_cursor_current_node_type_id_wasm"] = wasmExports["ts_tree_cursor_current_node_type_id_wasm"])(a0);
					var _ts_tree_cursor_current_node_state_id_wasm = Module["_ts_tree_cursor_current_node_state_id_wasm"] = (a0) => (_ts_tree_cursor_current_node_state_id_wasm = Module["_ts_tree_cursor_current_node_state_id_wasm"] = wasmExports["ts_tree_cursor_current_node_state_id_wasm"])(a0);
					var _ts_tree_cursor_current_node_is_named_wasm = Module["_ts_tree_cursor_current_node_is_named_wasm"] = (a0) => (_ts_tree_cursor_current_node_is_named_wasm = Module["_ts_tree_cursor_current_node_is_named_wasm"] = wasmExports["ts_tree_cursor_current_node_is_named_wasm"])(a0);
					var _ts_tree_cursor_current_node_is_missing_wasm = Module["_ts_tree_cursor_current_node_is_missing_wasm"] = (a0) => (_ts_tree_cursor_current_node_is_missing_wasm = Module["_ts_tree_cursor_current_node_is_missing_wasm"] = wasmExports["ts_tree_cursor_current_node_is_missing_wasm"])(a0);
					var _ts_tree_cursor_current_node_id_wasm = Module["_ts_tree_cursor_current_node_id_wasm"] = (a0) => (_ts_tree_cursor_current_node_id_wasm = Module["_ts_tree_cursor_current_node_id_wasm"] = wasmExports["ts_tree_cursor_current_node_id_wasm"])(a0);
					var _ts_tree_cursor_start_position_wasm = Module["_ts_tree_cursor_start_position_wasm"] = (a0) => (_ts_tree_cursor_start_position_wasm = Module["_ts_tree_cursor_start_position_wasm"] = wasmExports["ts_tree_cursor_start_position_wasm"])(a0);
					var _ts_tree_cursor_end_position_wasm = Module["_ts_tree_cursor_end_position_wasm"] = (a0) => (_ts_tree_cursor_end_position_wasm = Module["_ts_tree_cursor_end_position_wasm"] = wasmExports["ts_tree_cursor_end_position_wasm"])(a0);
					var _ts_tree_cursor_start_index_wasm = Module["_ts_tree_cursor_start_index_wasm"] = (a0) => (_ts_tree_cursor_start_index_wasm = Module["_ts_tree_cursor_start_index_wasm"] = wasmExports["ts_tree_cursor_start_index_wasm"])(a0);
					var _ts_tree_cursor_end_index_wasm = Module["_ts_tree_cursor_end_index_wasm"] = (a0) => (_ts_tree_cursor_end_index_wasm = Module["_ts_tree_cursor_end_index_wasm"] = wasmExports["ts_tree_cursor_end_index_wasm"])(a0);
					var _ts_tree_cursor_current_field_id_wasm = Module["_ts_tree_cursor_current_field_id_wasm"] = (a0) => (_ts_tree_cursor_current_field_id_wasm = Module["_ts_tree_cursor_current_field_id_wasm"] = wasmExports["ts_tree_cursor_current_field_id_wasm"])(a0);
					var _ts_tree_cursor_current_depth_wasm = Module["_ts_tree_cursor_current_depth_wasm"] = (a0) => (_ts_tree_cursor_current_depth_wasm = Module["_ts_tree_cursor_current_depth_wasm"] = wasmExports["ts_tree_cursor_current_depth_wasm"])(a0);
					var _ts_tree_cursor_current_descendant_index_wasm = Module["_ts_tree_cursor_current_descendant_index_wasm"] = (a0) => (_ts_tree_cursor_current_descendant_index_wasm = Module["_ts_tree_cursor_current_descendant_index_wasm"] = wasmExports["ts_tree_cursor_current_descendant_index_wasm"])(a0);
					var _ts_tree_cursor_current_node_wasm = Module["_ts_tree_cursor_current_node_wasm"] = (a0) => (_ts_tree_cursor_current_node_wasm = Module["_ts_tree_cursor_current_node_wasm"] = wasmExports["ts_tree_cursor_current_node_wasm"])(a0);
					var _ts_node_symbol_wasm = Module["_ts_node_symbol_wasm"] = (a0) => (_ts_node_symbol_wasm = Module["_ts_node_symbol_wasm"] = wasmExports["ts_node_symbol_wasm"])(a0);
					var _ts_node_field_name_for_child_wasm = Module["_ts_node_field_name_for_child_wasm"] = (a0, a1) => (_ts_node_field_name_for_child_wasm = Module["_ts_node_field_name_for_child_wasm"] = wasmExports["ts_node_field_name_for_child_wasm"])(a0, a1);
					var _ts_node_children_by_field_id_wasm = Module["_ts_node_children_by_field_id_wasm"] = (a0, a1) => (_ts_node_children_by_field_id_wasm = Module["_ts_node_children_by_field_id_wasm"] = wasmExports["ts_node_children_by_field_id_wasm"])(a0, a1);
					var _ts_node_first_child_for_byte_wasm = Module["_ts_node_first_child_for_byte_wasm"] = (a0) => (_ts_node_first_child_for_byte_wasm = Module["_ts_node_first_child_for_byte_wasm"] = wasmExports["ts_node_first_child_for_byte_wasm"])(a0);
					var _ts_node_first_named_child_for_byte_wasm = Module["_ts_node_first_named_child_for_byte_wasm"] = (a0) => (_ts_node_first_named_child_for_byte_wasm = Module["_ts_node_first_named_child_for_byte_wasm"] = wasmExports["ts_node_first_named_child_for_byte_wasm"])(a0);
					var _ts_node_grammar_symbol_wasm = Module["_ts_node_grammar_symbol_wasm"] = (a0) => (_ts_node_grammar_symbol_wasm = Module["_ts_node_grammar_symbol_wasm"] = wasmExports["ts_node_grammar_symbol_wasm"])(a0);
					var _ts_node_child_count_wasm = Module["_ts_node_child_count_wasm"] = (a0) => (_ts_node_child_count_wasm = Module["_ts_node_child_count_wasm"] = wasmExports["ts_node_child_count_wasm"])(a0);
					var _ts_node_named_child_count_wasm = Module["_ts_node_named_child_count_wasm"] = (a0) => (_ts_node_named_child_count_wasm = Module["_ts_node_named_child_count_wasm"] = wasmExports["ts_node_named_child_count_wasm"])(a0);
					var _ts_node_child_wasm = Module["_ts_node_child_wasm"] = (a0, a1) => (_ts_node_child_wasm = Module["_ts_node_child_wasm"] = wasmExports["ts_node_child_wasm"])(a0, a1);
					var _ts_node_named_child_wasm = Module["_ts_node_named_child_wasm"] = (a0, a1) => (_ts_node_named_child_wasm = Module["_ts_node_named_child_wasm"] = wasmExports["ts_node_named_child_wasm"])(a0, a1);
					var _ts_node_child_by_field_id_wasm = Module["_ts_node_child_by_field_id_wasm"] = (a0, a1) => (_ts_node_child_by_field_id_wasm = Module["_ts_node_child_by_field_id_wasm"] = wasmExports["ts_node_child_by_field_id_wasm"])(a0, a1);
					var _ts_node_next_sibling_wasm = Module["_ts_node_next_sibling_wasm"] = (a0) => (_ts_node_next_sibling_wasm = Module["_ts_node_next_sibling_wasm"] = wasmExports["ts_node_next_sibling_wasm"])(a0);
					var _ts_node_prev_sibling_wasm = Module["_ts_node_prev_sibling_wasm"] = (a0) => (_ts_node_prev_sibling_wasm = Module["_ts_node_prev_sibling_wasm"] = wasmExports["ts_node_prev_sibling_wasm"])(a0);
					var _ts_node_next_named_sibling_wasm = Module["_ts_node_next_named_sibling_wasm"] = (a0) => (_ts_node_next_named_sibling_wasm = Module["_ts_node_next_named_sibling_wasm"] = wasmExports["ts_node_next_named_sibling_wasm"])(a0);
					var _ts_node_prev_named_sibling_wasm = Module["_ts_node_prev_named_sibling_wasm"] = (a0) => (_ts_node_prev_named_sibling_wasm = Module["_ts_node_prev_named_sibling_wasm"] = wasmExports["ts_node_prev_named_sibling_wasm"])(a0);
					var _ts_node_descendant_count_wasm = Module["_ts_node_descendant_count_wasm"] = (a0) => (_ts_node_descendant_count_wasm = Module["_ts_node_descendant_count_wasm"] = wasmExports["ts_node_descendant_count_wasm"])(a0);
					var _ts_node_parent_wasm = Module["_ts_node_parent_wasm"] = (a0) => (_ts_node_parent_wasm = Module["_ts_node_parent_wasm"] = wasmExports["ts_node_parent_wasm"])(a0);
					var _ts_node_descendant_for_index_wasm = Module["_ts_node_descendant_for_index_wasm"] = (a0) => (_ts_node_descendant_for_index_wasm = Module["_ts_node_descendant_for_index_wasm"] = wasmExports["ts_node_descendant_for_index_wasm"])(a0);
					var _ts_node_named_descendant_for_index_wasm = Module["_ts_node_named_descendant_for_index_wasm"] = (a0) => (_ts_node_named_descendant_for_index_wasm = Module["_ts_node_named_descendant_for_index_wasm"] = wasmExports["ts_node_named_descendant_for_index_wasm"])(a0);
					var _ts_node_descendant_for_position_wasm = Module["_ts_node_descendant_for_position_wasm"] = (a0) => (_ts_node_descendant_for_position_wasm = Module["_ts_node_descendant_for_position_wasm"] = wasmExports["ts_node_descendant_for_position_wasm"])(a0);
					var _ts_node_named_descendant_for_position_wasm = Module["_ts_node_named_descendant_for_position_wasm"] = (a0) => (_ts_node_named_descendant_for_position_wasm = Module["_ts_node_named_descendant_for_position_wasm"] = wasmExports["ts_node_named_descendant_for_position_wasm"])(a0);
					var _ts_node_start_point_wasm = Module["_ts_node_start_point_wasm"] = (a0) => (_ts_node_start_point_wasm = Module["_ts_node_start_point_wasm"] = wasmExports["ts_node_start_point_wasm"])(a0);
					var _ts_node_end_point_wasm = Module["_ts_node_end_point_wasm"] = (a0) => (_ts_node_end_point_wasm = Module["_ts_node_end_point_wasm"] = wasmExports["ts_node_end_point_wasm"])(a0);
					var _ts_node_start_index_wasm = Module["_ts_node_start_index_wasm"] = (a0) => (_ts_node_start_index_wasm = Module["_ts_node_start_index_wasm"] = wasmExports["ts_node_start_index_wasm"])(a0);
					var _ts_node_end_index_wasm = Module["_ts_node_end_index_wasm"] = (a0) => (_ts_node_end_index_wasm = Module["_ts_node_end_index_wasm"] = wasmExports["ts_node_end_index_wasm"])(a0);
					var _ts_node_to_string_wasm = Module["_ts_node_to_string_wasm"] = (a0) => (_ts_node_to_string_wasm = Module["_ts_node_to_string_wasm"] = wasmExports["ts_node_to_string_wasm"])(a0);
					var _ts_node_children_wasm = Module["_ts_node_children_wasm"] = (a0) => (_ts_node_children_wasm = Module["_ts_node_children_wasm"] = wasmExports["ts_node_children_wasm"])(a0);
					var _ts_node_named_children_wasm = Module["_ts_node_named_children_wasm"] = (a0) => (_ts_node_named_children_wasm = Module["_ts_node_named_children_wasm"] = wasmExports["ts_node_named_children_wasm"])(a0);
					var _ts_node_descendants_of_type_wasm = Module["_ts_node_descendants_of_type_wasm"] = (a0, a1, a2, a3, a4, a5, a6) => (_ts_node_descendants_of_type_wasm = Module["_ts_node_descendants_of_type_wasm"] = wasmExports["ts_node_descendants_of_type_wasm"])(a0, a1, a2, a3, a4, a5, a6);
					var _ts_node_is_named_wasm = Module["_ts_node_is_named_wasm"] = (a0) => (_ts_node_is_named_wasm = Module["_ts_node_is_named_wasm"] = wasmExports["ts_node_is_named_wasm"])(a0);
					var _ts_node_has_changes_wasm = Module["_ts_node_has_changes_wasm"] = (a0) => (_ts_node_has_changes_wasm = Module["_ts_node_has_changes_wasm"] = wasmExports["ts_node_has_changes_wasm"])(a0);
					var _ts_node_has_error_wasm = Module["_ts_node_has_error_wasm"] = (a0) => (_ts_node_has_error_wasm = Module["_ts_node_has_error_wasm"] = wasmExports["ts_node_has_error_wasm"])(a0);
					var _ts_node_is_error_wasm = Module["_ts_node_is_error_wasm"] = (a0) => (_ts_node_is_error_wasm = Module["_ts_node_is_error_wasm"] = wasmExports["ts_node_is_error_wasm"])(a0);
					var _ts_node_is_missing_wasm = Module["_ts_node_is_missing_wasm"] = (a0) => (_ts_node_is_missing_wasm = Module["_ts_node_is_missing_wasm"] = wasmExports["ts_node_is_missing_wasm"])(a0);
					var _ts_node_is_extra_wasm = Module["_ts_node_is_extra_wasm"] = (a0) => (_ts_node_is_extra_wasm = Module["_ts_node_is_extra_wasm"] = wasmExports["ts_node_is_extra_wasm"])(a0);
					var _ts_node_parse_state_wasm = Module["_ts_node_parse_state_wasm"] = (a0) => (_ts_node_parse_state_wasm = Module["_ts_node_parse_state_wasm"] = wasmExports["ts_node_parse_state_wasm"])(a0);
					var _ts_node_next_parse_state_wasm = Module["_ts_node_next_parse_state_wasm"] = (a0) => (_ts_node_next_parse_state_wasm = Module["_ts_node_next_parse_state_wasm"] = wasmExports["ts_node_next_parse_state_wasm"])(a0);
					var _ts_query_matches_wasm = Module["_ts_query_matches_wasm"] = (a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) => (_ts_query_matches_wasm = Module["_ts_query_matches_wasm"] = wasmExports["ts_query_matches_wasm"])(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9);
					var _ts_query_captures_wasm = Module["_ts_query_captures_wasm"] = (a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) => (_ts_query_captures_wasm = Module["_ts_query_captures_wasm"] = wasmExports["ts_query_captures_wasm"])(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9);
					var _iswalpha = Module["_iswalpha"] = (a0) => (_iswalpha = Module["_iswalpha"] = wasmExports["iswalpha"])(a0);
					var _iswblank = Module["_iswblank"] = (a0) => (_iswblank = Module["_iswblank"] = wasmExports["iswblank"])(a0);
					var _iswdigit = Module["_iswdigit"] = (a0) => (_iswdigit = Module["_iswdigit"] = wasmExports["iswdigit"])(a0);
					var _iswlower = Module["_iswlower"] = (a0) => (_iswlower = Module["_iswlower"] = wasmExports["iswlower"])(a0);
					var _iswupper = Module["_iswupper"] = (a0) => (_iswupper = Module["_iswupper"] = wasmExports["iswupper"])(a0);
					var _iswxdigit = Module["_iswxdigit"] = (a0) => (_iswxdigit = Module["_iswxdigit"] = wasmExports["iswxdigit"])(a0);
					var _memchr = Module["_memchr"] = (a0, a1, a2) => (_memchr = Module["_memchr"] = wasmExports["memchr"])(a0, a1, a2);
					var _strlen = Module["_strlen"] = (a0) => (_strlen = Module["_strlen"] = wasmExports["strlen"])(a0);
					var _strcmp = Module["_strcmp"] = (a0, a1) => (_strcmp = Module["_strcmp"] = wasmExports["strcmp"])(a0, a1);
					var _strncat = Module["_strncat"] = (a0, a1, a2) => (_strncat = Module["_strncat"] = wasmExports["strncat"])(a0, a1, a2);
					var _strncpy = Module["_strncpy"] = (a0, a1, a2) => (_strncpy = Module["_strncpy"] = wasmExports["strncpy"])(a0, a1, a2);
					var _towlower = Module["_towlower"] = (a0) => (_towlower = Module["_towlower"] = wasmExports["towlower"])(a0);
					var _towupper = Module["_towupper"] = (a0) => (_towupper = Module["_towupper"] = wasmExports["towupper"])(a0);
					var _setThrew = (a0, a1) => (_setThrew = wasmExports["setThrew"])(a0, a1);
					var __emscripten_stack_restore = (a0) => (__emscripten_stack_restore = wasmExports["_emscripten_stack_restore"])(a0);
					var __emscripten_stack_alloc = (a0) => (__emscripten_stack_alloc = wasmExports["_emscripten_stack_alloc"])(a0);
					var _emscripten_stack_get_current = () => (_emscripten_stack_get_current = wasmExports["emscripten_stack_get_current"])();
					var dynCall_jiji = Module["dynCall_jiji"] = (a0, a1, a2, a3, a4) => (dynCall_jiji = Module["dynCall_jiji"] = wasmExports["dynCall_jiji"])(a0, a1, a2, a3, a4);
					var _orig$ts_parser_timeout_micros = Module["_orig$ts_parser_timeout_micros"] = (a0) => (_orig$ts_parser_timeout_micros = Module["_orig$ts_parser_timeout_micros"] = wasmExports["orig$ts_parser_timeout_micros"])(a0);
					var _orig$ts_parser_set_timeout_micros = Module["_orig$ts_parser_set_timeout_micros"] = (a0, a1) => (_orig$ts_parser_set_timeout_micros = Module["_orig$ts_parser_set_timeout_micros"] = wasmExports["orig$ts_parser_set_timeout_micros"])(a0, a1);
					Module["AsciiToString"] = AsciiToString;
					Module["stringToUTF16"] = stringToUTF16;
					var calledRun;
					dependenciesFulfilled = function runCaller() {
						if (!calledRun) run();
						if (!calledRun) dependenciesFulfilled = runCaller;
					};
					function callMain(args = []) {
						var entryFunction = resolveGlobalSymbol("main").sym;
						if (!entryFunction) return;
						args.unshift(thisProgram);
						var argc = args.length;
						var argv = stackAlloc((argc + 1) * 4);
						var argv_ptr = argv;
						args.forEach((arg) => {
							LE_HEAP_STORE_U32((argv_ptr >> 2) * 4, stringToUTF8OnStack(arg));
							argv_ptr += 4;
						});
						LE_HEAP_STORE_U32((argv_ptr >> 2) * 4, 0);
						try {
							var ret = entryFunction(argc, argv);
							exitJS(ret, true);
							return ret;
						} catch (e) {
							return handleException(e);
						}
					}
					function run(args = arguments_) {
						if (runDependencies > 0) return;
						preRun();
						if (runDependencies > 0) return;
						function doRun() {
							if (calledRun) return;
							calledRun = true;
							Module["calledRun"] = true;
							if (ABORT) return;
							initRuntime();
							preMain();
							Module["onRuntimeInitialized"]?.();
							if (shouldRunNow) callMain(args);
							postRun();
						}
						if (Module["setStatus"]) {
							Module["setStatus"]("Running...");
							setTimeout(function() {
								setTimeout(function() {
									Module["setStatus"]("");
								}, 1);
								doRun();
							}, 1);
						} else doRun();
					}
					if (Module["preInit"]) {
						if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
						while (Module["preInit"].length > 0) Module["preInit"].pop()();
					}
					var shouldRunNow = true;
					if (Module["noInitialRun"]) shouldRunNow = false;
					run();
					const C = Module;
					const INTERNAL = {};
					const SIZE_OF_INT = 4;
					const SIZE_OF_CURSOR = 4 * SIZE_OF_INT;
					const SIZE_OF_NODE = 5 * SIZE_OF_INT;
					const SIZE_OF_POINT = 2 * SIZE_OF_INT;
					const SIZE_OF_RANGE = 24;
					const ZERO_POINT = {
						row: 0,
						column: 0
					};
					const QUERY_WORD_REGEX = /[\w-.]*/g;
					const PREDICATE_STEP_TYPE_CAPTURE = 1;
					const PREDICATE_STEP_TYPE_STRING = 2;
					const LANGUAGE_FUNCTION_REGEX = /^_?tree_sitter_\w+/;
					let VERSION;
					let MIN_COMPATIBLE_VERSION;
					let TRANSFER_BUFFER;
					let currentParseCallback;
					let currentLogCallback;
					class ParserImpl {
						static init() {
							TRANSFER_BUFFER = C._ts_init();
							VERSION = getValue(TRANSFER_BUFFER, "i32");
							MIN_COMPATIBLE_VERSION = getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
						}
						initialize() {
							C._ts_parser_new_wasm();
							this[0] = getValue(TRANSFER_BUFFER, "i32");
							this[1] = getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
						}
						delete() {
							C._ts_parser_delete(this[0]);
							C._free(this[1]);
							this[0] = 0;
							this[1] = 0;
						}
						setLanguage(language) {
							let address;
							if (!language) {
								address = 0;
								language = null;
							} else if (language.constructor === Language) {
								address = language[0];
								const version = C._ts_language_version(address);
								if (version < MIN_COMPATIBLE_VERSION || VERSION < version) throw new Error(`Incompatible language version ${version}. Compatibility range ${MIN_COMPATIBLE_VERSION} through ${VERSION}.`);
							} else throw new Error("Argument must be a Language");
							this.language = language;
							C._ts_parser_set_language(this[0], address);
							return this;
						}
						getLanguage() {
							return this.language;
						}
						parse(callback, oldTree, options) {
							if (typeof callback === "string") currentParseCallback = (index, _) => callback.slice(index);
							else if (typeof callback === "function") currentParseCallback = callback;
							else throw new Error("Argument must be a string or a function");
							if (this.logCallback) {
								currentLogCallback = this.logCallback;
								C._ts_parser_enable_logger_wasm(this[0], 1);
							} else {
								currentLogCallback = null;
								C._ts_parser_enable_logger_wasm(this[0], 0);
							}
							let rangeCount = 0;
							let rangeAddress = 0;
							if (options?.includedRanges) {
								rangeCount = options.includedRanges.length;
								rangeAddress = C._calloc(rangeCount, SIZE_OF_RANGE);
								let address = rangeAddress;
								for (let i = 0; i < rangeCount; i++) {
									marshalRange(address, options.includedRanges[i]);
									address += SIZE_OF_RANGE;
								}
							}
							const treeAddress = C._ts_parser_parse_wasm(this[0], this[1], oldTree ? oldTree[0] : 0, rangeAddress, rangeCount);
							if (!treeAddress) {
								currentParseCallback = null;
								currentLogCallback = null;
								throw new Error("Parsing failed");
							}
							const result = new Tree(INTERNAL, treeAddress, this.language, currentParseCallback);
							currentParseCallback = null;
							currentLogCallback = null;
							return result;
						}
						reset() {
							C._ts_parser_reset(this[0]);
						}
						getIncludedRanges() {
							C._ts_parser_included_ranges_wasm(this[0]);
							const count = getValue(TRANSFER_BUFFER, "i32");
							const buffer = getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
							const result = new Array(count);
							if (count > 0) {
								let address = buffer;
								for (let i = 0; i < count; i++) {
									result[i] = unmarshalRange(address);
									address += SIZE_OF_RANGE;
								}
								C._free(buffer);
							}
							return result;
						}
						getTimeoutMicros() {
							return C._ts_parser_timeout_micros(this[0]);
						}
						setTimeoutMicros(timeout) {
							C._ts_parser_set_timeout_micros(this[0], timeout);
						}
						setLogger(callback) {
							if (!callback) callback = null;
							else if (typeof callback !== "function") throw new Error("Logger callback must be a function");
							this.logCallback = callback;
							return this;
						}
						getLogger() {
							return this.logCallback;
						}
					}
					class Tree {
						constructor(internal, address, language, textCallback) {
							assertInternal(internal);
							this[0] = address;
							this.language = language;
							this.textCallback = textCallback;
						}
						copy() {
							const address = C._ts_tree_copy(this[0]);
							return new Tree(INTERNAL, address, this.language, this.textCallback);
						}
						delete() {
							C._ts_tree_delete(this[0]);
							this[0] = 0;
						}
						edit(edit) {
							marshalEdit(edit);
							C._ts_tree_edit_wasm(this[0]);
						}
						get rootNode() {
							C._ts_tree_root_node_wasm(this[0]);
							return unmarshalNode(this);
						}
						rootNodeWithOffset(offsetBytes, offsetExtent) {
							const address = TRANSFER_BUFFER + SIZE_OF_NODE;
							setValue(address, offsetBytes, "i32");
							marshalPoint(address + SIZE_OF_INT, offsetExtent);
							C._ts_tree_root_node_with_offset_wasm(this[0]);
							return unmarshalNode(this);
						}
						getLanguage() {
							return this.language;
						}
						walk() {
							return this.rootNode.walk();
						}
						getChangedRanges(other) {
							if (other.constructor !== Tree) throw new TypeError("Argument must be a Tree");
							C._ts_tree_get_changed_ranges_wasm(this[0], other[0]);
							const count = getValue(TRANSFER_BUFFER, "i32");
							const buffer = getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
							const result = new Array(count);
							if (count > 0) {
								let address = buffer;
								for (let i = 0; i < count; i++) {
									result[i] = unmarshalRange(address);
									address += SIZE_OF_RANGE;
								}
								C._free(buffer);
							}
							return result;
						}
						getIncludedRanges() {
							C._ts_tree_included_ranges_wasm(this[0]);
							const count = getValue(TRANSFER_BUFFER, "i32");
							const buffer = getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
							const result = new Array(count);
							if (count > 0) {
								let address = buffer;
								for (let i = 0; i < count; i++) {
									result[i] = unmarshalRange(address);
									address += SIZE_OF_RANGE;
								}
								C._free(buffer);
							}
							return result;
						}
					}
					class Node {
						constructor(internal, tree) {
							assertInternal(internal);
							this.tree = tree;
						}
						get typeId() {
							marshalNode(this);
							return C._ts_node_symbol_wasm(this.tree[0]);
						}
						get grammarId() {
							marshalNode(this);
							return C._ts_node_grammar_symbol_wasm(this.tree[0]);
						}
						get type() {
							return this.tree.language.types[this.typeId] || "ERROR";
						}
						get grammarType() {
							return this.tree.language.types[this.grammarId] || "ERROR";
						}
						get endPosition() {
							marshalNode(this);
							C._ts_node_end_point_wasm(this.tree[0]);
							return unmarshalPoint(TRANSFER_BUFFER);
						}
						get endIndex() {
							marshalNode(this);
							return C._ts_node_end_index_wasm(this.tree[0]);
						}
						get text() {
							return getText(this.tree, this.startIndex, this.endIndex);
						}
						get parseState() {
							marshalNode(this);
							return C._ts_node_parse_state_wasm(this.tree[0]);
						}
						get nextParseState() {
							marshalNode(this);
							return C._ts_node_next_parse_state_wasm(this.tree[0]);
						}
						get isNamed() {
							marshalNode(this);
							return C._ts_node_is_named_wasm(this.tree[0]) === 1;
						}
						get hasError() {
							marshalNode(this);
							return C._ts_node_has_error_wasm(this.tree[0]) === 1;
						}
						get hasChanges() {
							marshalNode(this);
							return C._ts_node_has_changes_wasm(this.tree[0]) === 1;
						}
						get isError() {
							marshalNode(this);
							return C._ts_node_is_error_wasm(this.tree[0]) === 1;
						}
						get isMissing() {
							marshalNode(this);
							return C._ts_node_is_missing_wasm(this.tree[0]) === 1;
						}
						get isExtra() {
							marshalNode(this);
							return C._ts_node_is_extra_wasm(this.tree[0]) === 1;
						}
						equals(other) {
							return this.id === other.id;
						}
						child(index) {
							marshalNode(this);
							C._ts_node_child_wasm(this.tree[0], index);
							return unmarshalNode(this.tree);
						}
						namedChild(index) {
							marshalNode(this);
							C._ts_node_named_child_wasm(this.tree[0], index);
							return unmarshalNode(this.tree);
						}
						childForFieldId(fieldId) {
							marshalNode(this);
							C._ts_node_child_by_field_id_wasm(this.tree[0], fieldId);
							return unmarshalNode(this.tree);
						}
						childForFieldName(fieldName) {
							const fieldId = this.tree.language.fields.indexOf(fieldName);
							if (fieldId !== -1) return this.childForFieldId(fieldId);
							return null;
						}
						fieldNameForChild(index) {
							marshalNode(this);
							const address = C._ts_node_field_name_for_child_wasm(this.tree[0], index);
							if (!address) return null;
							return AsciiToString(address);
						}
						childrenForFieldName(fieldName) {
							const fieldId = this.tree.language.fields.indexOf(fieldName);
							if (fieldId !== -1 && fieldId !== 0) return this.childrenForFieldId(fieldId);
							return [];
						}
						childrenForFieldId(fieldId) {
							marshalNode(this);
							C._ts_node_children_by_field_id_wasm(this.tree[0], fieldId);
							const count = getValue(TRANSFER_BUFFER, "i32");
							const buffer = getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
							const result = new Array(count);
							if (count > 0) {
								let address = buffer;
								for (let i = 0; i < count; i++) {
									result[i] = unmarshalNode(this.tree, address);
									address += SIZE_OF_NODE;
								}
								C._free(buffer);
							}
							return result;
						}
						firstChildForIndex(index) {
							marshalNode(this);
							setValue(TRANSFER_BUFFER + SIZE_OF_NODE, index, "i32");
							C._ts_node_first_child_for_byte_wasm(this.tree[0]);
							return unmarshalNode(this.tree);
						}
						firstNamedChildForIndex(index) {
							marshalNode(this);
							setValue(TRANSFER_BUFFER + SIZE_OF_NODE, index, "i32");
							C._ts_node_first_named_child_for_byte_wasm(this.tree[0]);
							return unmarshalNode(this.tree);
						}
						get childCount() {
							marshalNode(this);
							return C._ts_node_child_count_wasm(this.tree[0]);
						}
						get namedChildCount() {
							marshalNode(this);
							return C._ts_node_named_child_count_wasm(this.tree[0]);
						}
						get firstChild() {
							return this.child(0);
						}
						get firstNamedChild() {
							return this.namedChild(0);
						}
						get lastChild() {
							return this.child(this.childCount - 1);
						}
						get lastNamedChild() {
							return this.namedChild(this.namedChildCount - 1);
						}
						get children() {
							if (!this._children) {
								marshalNode(this);
								C._ts_node_children_wasm(this.tree[0]);
								const count = getValue(TRANSFER_BUFFER, "i32");
								const buffer = getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
								this._children = new Array(count);
								if (count > 0) {
									let address = buffer;
									for (let i = 0; i < count; i++) {
										this._children[i] = unmarshalNode(this.tree, address);
										address += SIZE_OF_NODE;
									}
									C._free(buffer);
								}
							}
							return this._children;
						}
						get namedChildren() {
							if (!this._namedChildren) {
								marshalNode(this);
								C._ts_node_named_children_wasm(this.tree[0]);
								const count = getValue(TRANSFER_BUFFER, "i32");
								const buffer = getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
								this._namedChildren = new Array(count);
								if (count > 0) {
									let address = buffer;
									for (let i = 0; i < count; i++) {
										this._namedChildren[i] = unmarshalNode(this.tree, address);
										address += SIZE_OF_NODE;
									}
									C._free(buffer);
								}
							}
							return this._namedChildren;
						}
						descendantsOfType(types, startPosition, endPosition) {
							if (!Array.isArray(types)) types = [types];
							if (!startPosition) startPosition = ZERO_POINT;
							if (!endPosition) endPosition = ZERO_POINT;
							const symbols = [];
							const typesBySymbol = this.tree.language.types;
							for (let i = 0, n = typesBySymbol.length; i < n; i++) if (types.includes(typesBySymbol[i])) symbols.push(i);
							const symbolsAddress = C._malloc(SIZE_OF_INT * symbols.length);
							for (let i = 0, n = symbols.length; i < n; i++) setValue(symbolsAddress + i * SIZE_OF_INT, symbols[i], "i32");
							marshalNode(this);
							C._ts_node_descendants_of_type_wasm(this.tree[0], symbolsAddress, symbols.length, startPosition.row, startPosition.column, endPosition.row, endPosition.column);
							const descendantCount = getValue(TRANSFER_BUFFER, "i32");
							const descendantAddress = getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
							const result = new Array(descendantCount);
							if (descendantCount > 0) {
								let address = descendantAddress;
								for (let i = 0; i < descendantCount; i++) {
									result[i] = unmarshalNode(this.tree, address);
									address += SIZE_OF_NODE;
								}
							}
							C._free(descendantAddress);
							C._free(symbolsAddress);
							return result;
						}
						get nextSibling() {
							marshalNode(this);
							C._ts_node_next_sibling_wasm(this.tree[0]);
							return unmarshalNode(this.tree);
						}
						get previousSibling() {
							marshalNode(this);
							C._ts_node_prev_sibling_wasm(this.tree[0]);
							return unmarshalNode(this.tree);
						}
						get nextNamedSibling() {
							marshalNode(this);
							C._ts_node_next_named_sibling_wasm(this.tree[0]);
							return unmarshalNode(this.tree);
						}
						get previousNamedSibling() {
							marshalNode(this);
							C._ts_node_prev_named_sibling_wasm(this.tree[0]);
							return unmarshalNode(this.tree);
						}
						get descendantCount() {
							marshalNode(this);
							return C._ts_node_descendant_count_wasm(this.tree[0]);
						}
						get parent() {
							marshalNode(this);
							C._ts_node_parent_wasm(this.tree[0]);
							return unmarshalNode(this.tree);
						}
						descendantForIndex(start, end = start) {
							if (typeof start !== "number" || typeof end !== "number") throw new Error("Arguments must be numbers");
							marshalNode(this);
							const address = TRANSFER_BUFFER + SIZE_OF_NODE;
							setValue(address, start, "i32");
							setValue(address + SIZE_OF_INT, end, "i32");
							C._ts_node_descendant_for_index_wasm(this.tree[0]);
							return unmarshalNode(this.tree);
						}
						namedDescendantForIndex(start, end = start) {
							if (typeof start !== "number" || typeof end !== "number") throw new Error("Arguments must be numbers");
							marshalNode(this);
							const address = TRANSFER_BUFFER + SIZE_OF_NODE;
							setValue(address, start, "i32");
							setValue(address + SIZE_OF_INT, end, "i32");
							C._ts_node_named_descendant_for_index_wasm(this.tree[0]);
							return unmarshalNode(this.tree);
						}
						descendantForPosition(start, end = start) {
							if (!isPoint(start) || !isPoint(end)) throw new Error("Arguments must be {row, column} objects");
							marshalNode(this);
							const address = TRANSFER_BUFFER + SIZE_OF_NODE;
							marshalPoint(address, start);
							marshalPoint(address + SIZE_OF_POINT, end);
							C._ts_node_descendant_for_position_wasm(this.tree[0]);
							return unmarshalNode(this.tree);
						}
						namedDescendantForPosition(start, end = start) {
							if (!isPoint(start) || !isPoint(end)) throw new Error("Arguments must be {row, column} objects");
							marshalNode(this);
							const address = TRANSFER_BUFFER + SIZE_OF_NODE;
							marshalPoint(address, start);
							marshalPoint(address + SIZE_OF_POINT, end);
							C._ts_node_named_descendant_for_position_wasm(this.tree[0]);
							return unmarshalNode(this.tree);
						}
						walk() {
							marshalNode(this);
							C._ts_tree_cursor_new_wasm(this.tree[0]);
							return new TreeCursor(INTERNAL, this.tree);
						}
						toString() {
							marshalNode(this);
							const address = C._ts_node_to_string_wasm(this.tree[0]);
							const result = AsciiToString(address);
							C._free(address);
							return result;
						}
					}
					class TreeCursor {
						constructor(internal, tree) {
							assertInternal(internal);
							this.tree = tree;
							unmarshalTreeCursor(this);
						}
						delete() {
							marshalTreeCursor(this);
							C._ts_tree_cursor_delete_wasm(this.tree[0]);
							this[0] = this[1] = this[2] = 0;
						}
						reset(node) {
							marshalNode(node);
							marshalTreeCursor(this, TRANSFER_BUFFER + SIZE_OF_NODE);
							C._ts_tree_cursor_reset_wasm(this.tree[0]);
							unmarshalTreeCursor(this);
						}
						resetTo(cursor) {
							marshalTreeCursor(this, TRANSFER_BUFFER);
							marshalTreeCursor(cursor, TRANSFER_BUFFER + SIZE_OF_CURSOR);
							C._ts_tree_cursor_reset_to_wasm(this.tree[0], cursor.tree[0]);
							unmarshalTreeCursor(this);
						}
						get nodeType() {
							return this.tree.language.types[this.nodeTypeId] || "ERROR";
						}
						get nodeTypeId() {
							marshalTreeCursor(this);
							return C._ts_tree_cursor_current_node_type_id_wasm(this.tree[0]);
						}
						get nodeStateId() {
							marshalTreeCursor(this);
							return C._ts_tree_cursor_current_node_state_id_wasm(this.tree[0]);
						}
						get nodeId() {
							marshalTreeCursor(this);
							return C._ts_tree_cursor_current_node_id_wasm(this.tree[0]);
						}
						get nodeIsNamed() {
							marshalTreeCursor(this);
							return C._ts_tree_cursor_current_node_is_named_wasm(this.tree[0]) === 1;
						}
						get nodeIsMissing() {
							marshalTreeCursor(this);
							return C._ts_tree_cursor_current_node_is_missing_wasm(this.tree[0]) === 1;
						}
						get nodeText() {
							marshalTreeCursor(this);
							const startIndex = C._ts_tree_cursor_start_index_wasm(this.tree[0]);
							const endIndex = C._ts_tree_cursor_end_index_wasm(this.tree[0]);
							return getText(this.tree, startIndex, endIndex);
						}
						get startPosition() {
							marshalTreeCursor(this);
							C._ts_tree_cursor_start_position_wasm(this.tree[0]);
							return unmarshalPoint(TRANSFER_BUFFER);
						}
						get endPosition() {
							marshalTreeCursor(this);
							C._ts_tree_cursor_end_position_wasm(this.tree[0]);
							return unmarshalPoint(TRANSFER_BUFFER);
						}
						get startIndex() {
							marshalTreeCursor(this);
							return C._ts_tree_cursor_start_index_wasm(this.tree[0]);
						}
						get endIndex() {
							marshalTreeCursor(this);
							return C._ts_tree_cursor_end_index_wasm(this.tree[0]);
						}
						get currentNode() {
							marshalTreeCursor(this);
							C._ts_tree_cursor_current_node_wasm(this.tree[0]);
							return unmarshalNode(this.tree);
						}
						get currentFieldId() {
							marshalTreeCursor(this);
							return C._ts_tree_cursor_current_field_id_wasm(this.tree[0]);
						}
						get currentFieldName() {
							return this.tree.language.fields[this.currentFieldId];
						}
						get currentDepth() {
							marshalTreeCursor(this);
							return C._ts_tree_cursor_current_depth_wasm(this.tree[0]);
						}
						get currentDescendantIndex() {
							marshalTreeCursor(this);
							return C._ts_tree_cursor_current_descendant_index_wasm(this.tree[0]);
						}
						gotoFirstChild() {
							marshalTreeCursor(this);
							const result = C._ts_tree_cursor_goto_first_child_wasm(this.tree[0]);
							unmarshalTreeCursor(this);
							return result === 1;
						}
						gotoLastChild() {
							marshalTreeCursor(this);
							const result = C._ts_tree_cursor_goto_last_child_wasm(this.tree[0]);
							unmarshalTreeCursor(this);
							return result === 1;
						}
						gotoFirstChildForIndex(goalIndex) {
							marshalTreeCursor(this);
							setValue(TRANSFER_BUFFER + SIZE_OF_CURSOR, goalIndex, "i32");
							const result = C._ts_tree_cursor_goto_first_child_for_index_wasm(this.tree[0]);
							unmarshalTreeCursor(this);
							return result === 1;
						}
						gotoFirstChildForPosition(goalPosition) {
							marshalTreeCursor(this);
							marshalPoint(TRANSFER_BUFFER + SIZE_OF_CURSOR, goalPosition);
							const result = C._ts_tree_cursor_goto_first_child_for_position_wasm(this.tree[0]);
							unmarshalTreeCursor(this);
							return result === 1;
						}
						gotoNextSibling() {
							marshalTreeCursor(this);
							const result = C._ts_tree_cursor_goto_next_sibling_wasm(this.tree[0]);
							unmarshalTreeCursor(this);
							return result === 1;
						}
						gotoPreviousSibling() {
							marshalTreeCursor(this);
							const result = C._ts_tree_cursor_goto_previous_sibling_wasm(this.tree[0]);
							unmarshalTreeCursor(this);
							return result === 1;
						}
						gotoDescendant(goalDescendantindex) {
							marshalTreeCursor(this);
							C._ts_tree_cursor_goto_descendant_wasm(this.tree[0], goalDescendantindex);
							unmarshalTreeCursor(this);
						}
						gotoParent() {
							marshalTreeCursor(this);
							const result = C._ts_tree_cursor_goto_parent_wasm(this.tree[0]);
							unmarshalTreeCursor(this);
							return result === 1;
						}
					}
					class Language {
						constructor(internal, address) {
							assertInternal(internal);
							this[0] = address;
							this.types = new Array(C._ts_language_symbol_count(this[0]));
							for (let i = 0, n = this.types.length; i < n; i++) if (C._ts_language_symbol_type(this[0], i) < 2) this.types[i] = UTF8ToString(C._ts_language_symbol_name(this[0], i));
							this.fields = new Array(C._ts_language_field_count(this[0]) + 1);
							for (let i = 0, n = this.fields.length; i < n; i++) {
								const fieldName = C._ts_language_field_name_for_id(this[0], i);
								if (fieldName !== 0) this.fields[i] = UTF8ToString(fieldName);
								else this.fields[i] = null;
							}
						}
						get version() {
							return C._ts_language_version(this[0]);
						}
						get fieldCount() {
							return this.fields.length - 1;
						}
						get stateCount() {
							return C._ts_language_state_count(this[0]);
						}
						fieldIdForName(fieldName) {
							const result = this.fields.indexOf(fieldName);
							if (result !== -1) return result;
							else return null;
						}
						fieldNameForId(fieldId) {
							return this.fields[fieldId] || null;
						}
						idForNodeType(type, named) {
							const typeLength = lengthBytesUTF8(type);
							const typeAddress = C._malloc(typeLength + 1);
							stringToUTF8(type, typeAddress, typeLength + 1);
							const result = C._ts_language_symbol_for_name(this[0], typeAddress, typeLength, named);
							C._free(typeAddress);
							return result || null;
						}
						get nodeTypeCount() {
							return C._ts_language_symbol_count(this[0]);
						}
						nodeTypeForId(typeId) {
							const name = C._ts_language_symbol_name(this[0], typeId);
							return name ? UTF8ToString(name) : null;
						}
						nodeTypeIsNamed(typeId) {
							return C._ts_language_type_is_named_wasm(this[0], typeId) ? true : false;
						}
						nodeTypeIsVisible(typeId) {
							return C._ts_language_type_is_visible_wasm(this[0], typeId) ? true : false;
						}
						nextState(stateId, typeId) {
							return C._ts_language_next_state(this[0], stateId, typeId);
						}
						lookaheadIterator(stateId) {
							const address = C._ts_lookahead_iterator_new(this[0], stateId);
							if (address) return new LookaheadIterable(INTERNAL, address, this);
							return null;
						}
						query(source) {
							const sourceLength = lengthBytesUTF8(source);
							const sourceAddress = C._malloc(sourceLength + 1);
							stringToUTF8(source, sourceAddress, sourceLength + 1);
							const address = C._ts_query_new(this[0], sourceAddress, sourceLength, TRANSFER_BUFFER, TRANSFER_BUFFER + SIZE_OF_INT);
							if (!address) {
								const errorId = getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
								const errorIndex = UTF8ToString(sourceAddress, getValue(TRANSFER_BUFFER, "i32")).length;
								const suffix = source.substr(errorIndex, 100).split("\n")[0];
								let word = suffix.match(QUERY_WORD_REGEX)[0];
								let error;
								switch (errorId) {
									case 2:
										error = /* @__PURE__ */ new RangeError(`Bad node name '${word}'`);
										break;
									case 3:
										error = /* @__PURE__ */ new RangeError(`Bad field name '${word}'`);
										break;
									case 4:
										error = /* @__PURE__ */ new RangeError(`Bad capture name @${word}`);
										break;
									case 5:
										error = /* @__PURE__ */ new TypeError(`Bad pattern structure at offset ${errorIndex}: '${suffix}'...`);
										word = "";
										break;
									default:
										error = /* @__PURE__ */ new SyntaxError(`Bad syntax at offset ${errorIndex}: '${suffix}'...`);
										word = "";
										break;
								}
								error.index = errorIndex;
								error.length = word.length;
								C._free(sourceAddress);
								throw error;
							}
							const stringCount = C._ts_query_string_count(address);
							const captureCount = C._ts_query_capture_count(address);
							const patternCount = C._ts_query_pattern_count(address);
							const captureNames = new Array(captureCount);
							const stringValues = new Array(stringCount);
							for (let i = 0; i < captureCount; i++) captureNames[i] = UTF8ToString(C._ts_query_capture_name_for_id(address, i, TRANSFER_BUFFER), getValue(TRANSFER_BUFFER, "i32"));
							for (let i = 0; i < stringCount; i++) stringValues[i] = UTF8ToString(C._ts_query_string_value_for_id(address, i, TRANSFER_BUFFER), getValue(TRANSFER_BUFFER, "i32"));
							const setProperties = new Array(patternCount);
							const assertedProperties = new Array(patternCount);
							const refutedProperties = new Array(patternCount);
							const predicates = new Array(patternCount);
							const textPredicates = new Array(patternCount);
							for (let i = 0; i < patternCount; i++) {
								const predicatesAddress = C._ts_query_predicates_for_pattern(address, i, TRANSFER_BUFFER);
								const stepCount = getValue(TRANSFER_BUFFER, "i32");
								predicates[i] = [];
								textPredicates[i] = [];
								const steps = [];
								let stepAddress = predicatesAddress;
								for (let j = 0; j < stepCount; j++) {
									const stepType = getValue(stepAddress, "i32");
									stepAddress += SIZE_OF_INT;
									const stepValueId = getValue(stepAddress, "i32");
									stepAddress += SIZE_OF_INT;
									if (stepType === PREDICATE_STEP_TYPE_CAPTURE) steps.push({
										type: "capture",
										name: captureNames[stepValueId]
									});
									else if (stepType === PREDICATE_STEP_TYPE_STRING) steps.push({
										type: "string",
										value: stringValues[stepValueId]
									});
									else if (steps.length > 0) {
										if (steps[0].type !== "string") throw new Error("Predicates must begin with a literal value");
										const operator = steps[0].value;
										let isPositive = true;
										let matchAll = true;
										let captureName;
										switch (operator) {
											case "any-not-eq?":
											case "not-eq?": isPositive = false;
											case "any-eq?":
											case "eq?":
												if (steps.length !== 3) throw new Error(`Wrong number of arguments to \`#${operator}\` predicate. Expected 2, got ${steps.length - 1}`);
												if (steps[1].type !== "capture") throw new Error(`First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}"`);
												matchAll = !operator.startsWith("any-");
												if (steps[2].type === "capture") {
													const captureName1 = steps[1].name;
													const captureName2 = steps[2].name;
													textPredicates[i].push((captures) => {
														const nodes1 = [];
														const nodes2 = [];
														for (const c of captures) {
															if (c.name === captureName1) nodes1.push(c.node);
															if (c.name === captureName2) nodes2.push(c.node);
														}
														const compare = (n1, n2, positive) => positive ? n1.text === n2.text : n1.text !== n2.text;
														return matchAll ? nodes1.every((n1) => nodes2.some((n2) => compare(n1, n2, isPositive))) : nodes1.some((n1) => nodes2.some((n2) => compare(n1, n2, isPositive)));
													});
												} else {
													captureName = steps[1].name;
													const stringValue = steps[2].value;
													const matches = (n) => n.text === stringValue;
													const doesNotMatch = (n) => n.text !== stringValue;
													textPredicates[i].push((captures) => {
														const nodes = [];
														for (const c of captures) if (c.name === captureName) nodes.push(c.node);
														const test = isPositive ? matches : doesNotMatch;
														return matchAll ? nodes.every(test) : nodes.some(test);
													});
												}
												break;
											case "any-not-match?":
											case "not-match?": isPositive = false;
											case "any-match?":
											case "match?":
												if (steps.length !== 3) throw new Error(`Wrong number of arguments to \`#${operator}\` predicate. Expected 2, got ${steps.length - 1}.`);
												if (steps[1].type !== "capture") throw new Error(`First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}".`);
												if (steps[2].type !== "string") throw new Error(`Second argument of \`#${operator}\` predicate must be a string. Got @${steps[2].value}.`);
												captureName = steps[1].name;
												const regex = new RegExp(steps[2].value);
												matchAll = !operator.startsWith("any-");
												textPredicates[i].push((captures) => {
													const nodes = [];
													for (const c of captures) if (c.name === captureName) nodes.push(c.node.text);
													const test = (text, positive) => positive ? regex.test(text) : !regex.test(text);
													if (nodes.length === 0) return !isPositive;
													return matchAll ? nodes.every((text) => test(text, isPositive)) : nodes.some((text) => test(text, isPositive));
												});
												break;
											case "set!":
												if (steps.length < 2 || steps.length > 3) throw new Error(`Wrong number of arguments to \`#set!\` predicate. Expected 1 or 2. Got ${steps.length - 1}.`);
												if (steps.some((s) => s.type !== "string")) throw new Error(`Arguments to \`#set!\` predicate must be a strings.".`);
												if (!setProperties[i]) setProperties[i] = {};
												setProperties[i][steps[1].value] = steps[2] ? steps[2].value : null;
												break;
											case "is?":
											case "is-not?":
												if (steps.length < 2 || steps.length > 3) throw new Error(`Wrong number of arguments to \`#${operator}\` predicate. Expected 1 or 2. Got ${steps.length - 1}.`);
												if (steps.some((s) => s.type !== "string")) throw new Error(`Arguments to \`#${operator}\` predicate must be a strings.".`);
												const properties = operator === "is?" ? assertedProperties : refutedProperties;
												if (!properties[i]) properties[i] = {};
												properties[i][steps[1].value] = steps[2] ? steps[2].value : null;
												break;
											case "not-any-of?": isPositive = false;
											case "any-of?":
												if (steps.length < 2) throw new Error(`Wrong number of arguments to \`#${operator}\` predicate. Expected at least 1. Got ${steps.length - 1}.`);
												if (steps[1].type !== "capture") throw new Error(`First argument of \`#${operator}\` predicate must be a capture. Got "${steps[1].value}".`);
												for (let i = 2; i < steps.length; i++) if (steps[i].type !== "string") throw new Error(`Arguments to \`#${operator}\` predicate must be a strings.".`);
												captureName = steps[1].name;
												const values = steps.slice(2).map((s) => s.value);
												textPredicates[i].push((captures) => {
													const nodes = [];
													for (const c of captures) if (c.name === captureName) nodes.push(c.node.text);
													if (nodes.length === 0) return !isPositive;
													return nodes.every((text) => values.includes(text)) === isPositive;
												});
												break;
											default: predicates[i].push({
												operator,
												operands: steps.slice(1)
											});
										}
										steps.length = 0;
									}
								}
								Object.freeze(setProperties[i]);
								Object.freeze(assertedProperties[i]);
								Object.freeze(refutedProperties[i]);
							}
							C._free(sourceAddress);
							return new Query(INTERNAL, address, captureNames, textPredicates, predicates, Object.freeze(setProperties), Object.freeze(assertedProperties), Object.freeze(refutedProperties));
						}
						static load(input) {
							let bytes;
							if (input instanceof Uint8Array) bytes = Promise.resolve(input);
							else {
								const url = input;
								if (typeof process !== "undefined" && process.versions && process.versions.node) {
									const fs = __require("fs");
									bytes = Promise.resolve(fs.readFileSync(url));
								} else bytes = fetch(url).then((response) => response.arrayBuffer().then((buffer) => {
									if (response.ok) return new Uint8Array(buffer);
									else {
										const body = new TextDecoder("utf-8").decode(buffer);
										throw new Error(`Language.load failed with status ${response.status}.\n\n${body}`);
									}
								}));
							}
							return bytes.then((bytes) => loadWebAssemblyModule(bytes, { loadAsync: true })).then((mod) => {
								const symbolNames = Object.keys(mod);
								const functionName = symbolNames.find((key) => LANGUAGE_FUNCTION_REGEX.test(key) && !key.includes("external_scanner_"));
								if (!functionName) console.log(`Couldn't find language function in WASM file. Symbols:\n${JSON.stringify(symbolNames, null, 2)}`);
								const languageAddress = mod[functionName]();
								return new Language(INTERNAL, languageAddress);
							});
						}
					}
					class LookaheadIterable {
						constructor(internal, address, language) {
							assertInternal(internal);
							this[0] = address;
							this.language = language;
						}
						get currentTypeId() {
							return C._ts_lookahead_iterator_current_symbol(this[0]);
						}
						get currentType() {
							return this.language.types[this.currentTypeId] || "ERROR";
						}
						delete() {
							C._ts_lookahead_iterator_delete(this[0]);
							this[0] = 0;
						}
						resetState(stateId) {
							return C._ts_lookahead_iterator_reset_state(this[0], stateId);
						}
						reset(language, stateId) {
							if (C._ts_lookahead_iterator_reset(this[0], language[0], stateId)) {
								this.language = language;
								return true;
							}
							return false;
						}
						[Symbol.iterator]() {
							const self = this;
							return { next() {
								if (C._ts_lookahead_iterator_next(self[0])) return {
									done: false,
									value: self.currentType
								};
								return {
									done: true,
									value: ""
								};
							} };
						}
					}
					class Query {
						constructor(internal, address, captureNames, textPredicates, predicates, setProperties, assertedProperties, refutedProperties) {
							assertInternal(internal);
							this[0] = address;
							this.captureNames = captureNames;
							this.textPredicates = textPredicates;
							this.predicates = predicates;
							this.setProperties = setProperties;
							this.assertedProperties = assertedProperties;
							this.refutedProperties = refutedProperties;
							this.exceededMatchLimit = false;
						}
						delete() {
							C._ts_query_delete(this[0]);
							this[0] = 0;
						}
						matches(node, { startPosition = ZERO_POINT, endPosition = ZERO_POINT, startIndex = 0, endIndex = 0, matchLimit = 4294967295, maxStartDepth = 4294967295 } = {}) {
							if (typeof matchLimit !== "number") throw new Error("Arguments must be numbers");
							marshalNode(node);
							C._ts_query_matches_wasm(this[0], node.tree[0], startPosition.row, startPosition.column, endPosition.row, endPosition.column, startIndex, endIndex, matchLimit, maxStartDepth);
							const rawCount = getValue(TRANSFER_BUFFER, "i32");
							const startAddress = getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
							const didExceedMatchLimit = getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
							const result = new Array(rawCount);
							this.exceededMatchLimit = Boolean(didExceedMatchLimit);
							let filteredCount = 0;
							let address = startAddress;
							for (let i = 0; i < rawCount; i++) {
								const pattern = getValue(address, "i32");
								address += SIZE_OF_INT;
								const captureCount = getValue(address, "i32");
								address += SIZE_OF_INT;
								const captures = new Array(captureCount);
								address = unmarshalCaptures(this, node.tree, address, captures);
								if (this.textPredicates[pattern].every((p) => p(captures))) {
									result[filteredCount] = {
										pattern,
										captures
									};
									const setProperties = this.setProperties[pattern];
									if (setProperties) result[filteredCount].setProperties = setProperties;
									const assertedProperties = this.assertedProperties[pattern];
									if (assertedProperties) result[filteredCount].assertedProperties = assertedProperties;
									const refutedProperties = this.refutedProperties[pattern];
									if (refutedProperties) result[filteredCount].refutedProperties = refutedProperties;
									filteredCount++;
								}
							}
							result.length = filteredCount;
							C._free(startAddress);
							return result;
						}
						captures(node, { startPosition = ZERO_POINT, endPosition = ZERO_POINT, startIndex = 0, endIndex = 0, matchLimit = 4294967295, maxStartDepth = 4294967295 } = {}) {
							if (typeof matchLimit !== "number") throw new Error("Arguments must be numbers");
							marshalNode(node);
							C._ts_query_captures_wasm(this[0], node.tree[0], startPosition.row, startPosition.column, endPosition.row, endPosition.column, startIndex, endIndex, matchLimit, maxStartDepth);
							const count = getValue(TRANSFER_BUFFER, "i32");
							const startAddress = getValue(TRANSFER_BUFFER + SIZE_OF_INT, "i32");
							const didExceedMatchLimit = getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
							const result = [];
							this.exceededMatchLimit = Boolean(didExceedMatchLimit);
							const captures = [];
							let address = startAddress;
							for (let i = 0; i < count; i++) {
								const pattern = getValue(address, "i32");
								address += SIZE_OF_INT;
								const captureCount = getValue(address, "i32");
								address += SIZE_OF_INT;
								const captureIndex = getValue(address, "i32");
								address += SIZE_OF_INT;
								captures.length = captureCount;
								address = unmarshalCaptures(this, node.tree, address, captures);
								if (this.textPredicates[pattern].every((p) => p(captures))) {
									const capture = captures[captureIndex];
									const setProperties = this.setProperties[pattern];
									if (setProperties) capture.setProperties = setProperties;
									const assertedProperties = this.assertedProperties[pattern];
									if (assertedProperties) capture.assertedProperties = assertedProperties;
									const refutedProperties = this.refutedProperties[pattern];
									if (refutedProperties) capture.refutedProperties = refutedProperties;
									result.push(capture);
								}
							}
							C._free(startAddress);
							return result;
						}
						predicatesForPattern(patternIndex) {
							return this.predicates[patternIndex];
						}
						disableCapture(captureName) {
							const captureNameLength = lengthBytesUTF8(captureName);
							const captureNameAddress = C._malloc(captureNameLength + 1);
							stringToUTF8(captureName, captureNameAddress, captureNameLength + 1);
							C._ts_query_disable_capture(this[0], captureNameAddress, captureNameLength);
							C._free(captureNameAddress);
						}
						didExceedMatchLimit() {
							return this.exceededMatchLimit;
						}
					}
					function getText(tree, startIndex, endIndex) {
						const length = endIndex - startIndex;
						let result = tree.textCallback(startIndex, null, endIndex);
						startIndex += result.length;
						while (startIndex < endIndex) {
							const string = tree.textCallback(startIndex, null, endIndex);
							if (string && string.length > 0) {
								startIndex += string.length;
								result += string;
							} else break;
						}
						if (startIndex > endIndex) result = result.slice(0, length);
						return result;
					}
					function unmarshalCaptures(query, tree, address, result) {
						for (let i = 0, n = result.length; i < n; i++) {
							const captureIndex = getValue(address, "i32");
							address += SIZE_OF_INT;
							const node = unmarshalNode(tree, address);
							address += SIZE_OF_NODE;
							result[i] = {
								name: query.captureNames[captureIndex],
								node
							};
						}
						return address;
					}
					function assertInternal(x) {
						if (x !== INTERNAL) throw new Error("Illegal constructor");
					}
					function isPoint(point) {
						return point && typeof point.row === "number" && typeof point.column === "number";
					}
					function marshalNode(node) {
						let address = TRANSFER_BUFFER;
						setValue(address, node.id, "i32");
						address += SIZE_OF_INT;
						setValue(address, node.startIndex, "i32");
						address += SIZE_OF_INT;
						setValue(address, node.startPosition.row, "i32");
						address += SIZE_OF_INT;
						setValue(address, node.startPosition.column, "i32");
						address += SIZE_OF_INT;
						setValue(address, node[0], "i32");
					}
					function unmarshalNode(tree, address = TRANSFER_BUFFER) {
						const id = getValue(address, "i32");
						address += SIZE_OF_INT;
						if (id === 0) return null;
						const index = getValue(address, "i32");
						address += SIZE_OF_INT;
						const row = getValue(address, "i32");
						address += SIZE_OF_INT;
						const column = getValue(address, "i32");
						address += SIZE_OF_INT;
						const other = getValue(address, "i32");
						const result = new Node(INTERNAL, tree);
						result.id = id;
						result.startIndex = index;
						result.startPosition = {
							row,
							column
						};
						result[0] = other;
						return result;
					}
					function marshalTreeCursor(cursor, address = TRANSFER_BUFFER) {
						setValue(address + 0 * SIZE_OF_INT, cursor[0], "i32");
						setValue(address + 1 * SIZE_OF_INT, cursor[1], "i32");
						setValue(address + 2 * SIZE_OF_INT, cursor[2], "i32");
						setValue(address + 3 * SIZE_OF_INT, cursor[3], "i32");
					}
					function unmarshalTreeCursor(cursor) {
						cursor[0] = getValue(TRANSFER_BUFFER + 0 * SIZE_OF_INT, "i32");
						cursor[1] = getValue(TRANSFER_BUFFER + 1 * SIZE_OF_INT, "i32");
						cursor[2] = getValue(TRANSFER_BUFFER + 2 * SIZE_OF_INT, "i32");
						cursor[3] = getValue(TRANSFER_BUFFER + 3 * SIZE_OF_INT, "i32");
					}
					function marshalPoint(address, point) {
						setValue(address, point.row, "i32");
						setValue(address + SIZE_OF_INT, point.column, "i32");
					}
					function unmarshalPoint(address) {
						return {
							row: getValue(address, "i32") >>> 0,
							column: getValue(address + SIZE_OF_INT, "i32") >>> 0
						};
					}
					function marshalRange(address, range) {
						marshalPoint(address, range.startPosition);
						address += SIZE_OF_POINT;
						marshalPoint(address, range.endPosition);
						address += SIZE_OF_POINT;
						setValue(address, range.startIndex, "i32");
						address += SIZE_OF_INT;
						setValue(address, range.endIndex, "i32");
						address += SIZE_OF_INT;
					}
					function unmarshalRange(address) {
						const result = {};
						result.startPosition = unmarshalPoint(address);
						address += SIZE_OF_POINT;
						result.endPosition = unmarshalPoint(address);
						address += SIZE_OF_POINT;
						result.startIndex = getValue(address, "i32") >>> 0;
						address += SIZE_OF_INT;
						result.endIndex = getValue(address, "i32") >>> 0;
						return result;
					}
					function marshalEdit(edit) {
						let address = TRANSFER_BUFFER;
						marshalPoint(address, edit.startPosition);
						address += SIZE_OF_POINT;
						marshalPoint(address, edit.oldEndPosition);
						address += SIZE_OF_POINT;
						marshalPoint(address, edit.newEndPosition);
						address += SIZE_OF_POINT;
						setValue(address, edit.startIndex, "i32");
						address += SIZE_OF_INT;
						setValue(address, edit.oldEndIndex, "i32");
						address += SIZE_OF_INT;
						setValue(address, edit.newEndIndex, "i32");
						address += SIZE_OF_INT;
					}
					for (const name of Object.getOwnPropertyNames(ParserImpl.prototype)) Object.defineProperty(Parser.prototype, name, {
						value: ParserImpl.prototype[name],
						enumerable: false,
						writable: false
					});
					Parser.Language = Language;
					Module.onRuntimeInitialized = () => {
						ParserImpl.init();
						resolveInitPromise();
					};
				});
			}
		}
		return Parser;
	}();
	if (typeof exports === "object") module.exports = TreeSitter;
}));

//#endregion
//#region src/core/parser/wasm.ts
var import_tree_sitter = /* @__PURE__ */ __toESM(require_tree_sitter(), 1);
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
		await import_tree_sitter.default.init({ locateFile() {
			return resolvedWasm;
		} });
		parserInstance = new import_tree_sitter.default();
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
		const lang = await import_tree_sitter.default.Language.load(localWasmPath);
		loadedLanguages.set(wasmFile, lang);
		return lang;
	} catch (err) {
		console.error(`Could not load local grammar ${wasmFile}:`, err);
	}
	else console.warn(`Local grammar ${wasmFile} hash mismatch. Trying cache.`);
	const cachedWasmPath = path.join(getCacheDir(), wasmFile);
	if (await fileExists$1(cachedWasmPath)) if (await verifyFileHash(cachedWasmPath, expectedHash)) try {
		const lang = await import_tree_sitter.default.Language.load(cachedWasmPath);
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
		const lang = await import_tree_sitter.default.Language.load(cachedWasmPath);
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
		parserInstance = new import_tree_sitter.default();
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
const SVELTE_SCRIPT_REGEX = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi;
const SVELTE_IMPORT_REGEX = /import\s+(?:[^"']*?\s+from\s+)?['"]([^'"]+)['"]/g;
const SVELTE_EXPORT_REGEX = /export\s+(?:let|const|var|function|class)\s+([a-zA-Z0-9_]+)/g;
const ASTRO_FM_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;
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
		let cleanContent = content;
		let prev;
		do {
			prev = cleanContent;
			cleanContent = cleanContent.replace(/<!--[\s\S]*?-->/g, "");
		} while (cleanContent !== prev);
		SVELTE_SCRIPT_REGEX.lastIndex = 0;
		let scriptMatch;
		while ((scriptMatch = SVELTE_SCRIPT_REGEX.exec(cleanContent)) !== null) {
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
//#region node_modules/ignore/index.js
var require_ignore = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	function makeArray(subject) {
		return Array.isArray(subject) ? subject : [subject];
	}
	const UNDEFINED = void 0;
	const EMPTY = "";
	const SPACE = " ";
	const ESCAPE = "\\";
	const REGEX_TEST_BLANK_LINE = /^\s+$/;
	const REGEX_INVALID_TRAILING_BACKSLASH = /(?:[^\\]|^)\\$/;
	const REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/;
	const REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/;
	const REGEX_SPLITALL_CRLF = /\r?\n/g;
	const REGEX_TEST_INVALID_PATH = /^\.{0,2}\/|^\.{1,2}$/;
	const REGEX_TEST_TRAILING_SLASH = /\/$/;
	const SLASH = "/";
	let TMP_KEY_IGNORE = "node-ignore";
	/* istanbul ignore else */
	if (typeof Symbol !== "undefined") TMP_KEY_IGNORE = Symbol.for("node-ignore");
	const KEY_IGNORE = TMP_KEY_IGNORE;
	const define = (object, key, value) => {
		Object.defineProperty(object, key, { value });
		return value;
	};
	const REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g;
	const RETURN_FALSE = () => false;
	const sanitizeRange = (range) => range.replace(REGEX_REGEXP_RANGE, (match, from, to) => from.charCodeAt(0) <= to.charCodeAt(0) ? match : EMPTY);
	const negateRange = (range) => range.startsWith("!") || range.startsWith("\\^") ? `^${range.slice(range[0] === "!" ? 1 : 2)}` : range;
	const cleanRangeBackSlash = (slashes) => {
		const { length } = slashes;
		return slashes.slice(0, length - length % 2);
	};
	const REPLACERS = [
		[/^\uFEFF/, () => EMPTY],
		[/((?:\\\\)*?)(\\?\s+)$/, (_, m1, m2) => m1 + (m2.indexOf("\\") === 0 ? SPACE : EMPTY)],
		[/(\\+?)\s/g, (_, m1) => {
			const { length } = m1;
			return m1.slice(0, length - length % 2) + SPACE;
		}],
		[/[\\$.|*+(){^]/g, (match) => `\\${match}`],
		[/(?!\\)\?/g, () => "[^/]"],
		[/^\//, () => "^"],
		[/\//g, () => "\\/"],
		[/^\^*(?:\\\*\\\*\\\/)+/, () => "^(?:.*\\/)?"],
		[/^(?=[^^])/, function startingReplacer() {
			return !/\/(?!$)/.test(this) ? "(?:^|\\/)" : "^";
		}],
		[/\\\/\\\*\\\*(?=\\\/|$)/g, (_, index, str) => index + 6 < str.length ? "(?:\\/[^\\/]+)*" : "\\/.+"],
		[/(^|[^\\]+)(\\\*)+(?=.+)/g, (_, p1, p2) => {
			return p1 + p2.replace(/\\\*/g, "[^\\/]*");
		}],
		[/\\\\\\(?=[$.|*+(){^])/g, () => ESCAPE],
		[/\\\\/g, () => ESCAPE],
		[/(\\)?\[([^\]/]*?)(\\*)($|\])/g, (match, leadEscape, range, endEscape, close) => leadEscape === ESCAPE ? `\\[${range}${cleanRangeBackSlash(endEscape)}${close}` : close === "]" ? endEscape.length % 2 === 0 ? `[${negateRange(sanitizeRange(range))}${endEscape}]` : "[]" : "[]"],
		[/(?:[^*])$/, (match) => /\/$/.test(match) ? `${match}$` : `${match}(?=$|\\/$)`]
	];
	const REGEX_REPLACE_TRAILING_WILDCARD = /(^|\\\/)?\\\*$/;
	const MODE_IGNORE = "regex";
	const MODE_CHECK_IGNORE = "checkRegex";
	const TRAILING_WILD_CARD_REPLACERS = {
		[MODE_IGNORE](_, p1) {
			return `${p1 ? `${p1}[^/]+` : "[^/]*"}(?=$|\\/$)`;
		},
		[MODE_CHECK_IGNORE](_, p1) {
			return `${p1 ? `${p1}[^/]*` : "[^/]*"}(?=$|\\/$)`;
		}
	};
	const makeRegexPrefix = (pattern) => REPLACERS.reduce((prev, [matcher, replacer]) => prev.replace(matcher, replacer.bind(pattern)), pattern);
	const isString = (subject) => typeof subject === "string";
	const checkPattern = (pattern) => pattern && isString(pattern) && !REGEX_TEST_BLANK_LINE.test(pattern) && !REGEX_INVALID_TRAILING_BACKSLASH.test(pattern) && pattern.indexOf("#") !== 0;
	const splitPattern = (pattern) => pattern.split(REGEX_SPLITALL_CRLF).filter(Boolean);
	var IgnoreRule = class {
		constructor(pattern, mark, body, ignoreCase, negative, prefix) {
			this.pattern = pattern;
			this.mark = mark;
			this.negative = negative;
			define(this, "body", body);
			define(this, "ignoreCase", ignoreCase);
			define(this, "regexPrefix", prefix);
		}
		get regex() {
			const key = "_regex";
			if (this[key]) return this[key];
			return this._make(MODE_IGNORE, key);
		}
		get checkRegex() {
			const key = "_checkRegex";
			if (this[key]) return this[key];
			return this._make(MODE_CHECK_IGNORE, key);
		}
		_make(mode, key) {
			const str = this.regexPrefix.replace(REGEX_REPLACE_TRAILING_WILDCARD, TRAILING_WILD_CARD_REPLACERS[mode]);
			const regex = this.ignoreCase ? new RegExp(str, "i") : new RegExp(str);
			return define(this, key, regex);
		}
	};
	const createRule = ({ pattern, mark }, ignoreCase) => {
		let negative = false;
		let body = pattern;
		if (body.indexOf("!") === 0) {
			negative = true;
			body = body.substr(1);
		}
		body = body.replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, "!").replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, "#");
		const regexPrefix = makeRegexPrefix(body);
		return new IgnoreRule(pattern, mark, body, ignoreCase, negative, regexPrefix);
	};
	var RuleManager = class {
		constructor(ignoreCase) {
			this._ignoreCase = ignoreCase;
			this._rules = [];
		}
		_add(pattern) {
			if (pattern && pattern[KEY_IGNORE]) {
				this._rules = this._rules.concat(pattern._rules._rules);
				this._added = true;
				return;
			}
			if (isString(pattern)) pattern = { pattern };
			if (checkPattern(pattern.pattern)) {
				const rule = createRule(pattern, this._ignoreCase);
				this._added = true;
				this._rules.push(rule);
			}
		}
		add(pattern) {
			this._added = false;
			makeArray(isString(pattern) ? splitPattern(pattern) : pattern).forEach(this._add, this);
			return this._added;
		}
		test(path, checkUnignored, mode) {
			let ignored = false;
			let unignored = false;
			let matchedRule;
			this._rules.forEach((rule) => {
				const { negative } = rule;
				if (unignored === negative && ignored !== unignored || negative && !ignored && !unignored && !checkUnignored) return;
				if (!rule[mode].test(path)) return;
				ignored = !negative;
				unignored = negative;
				matchedRule = negative ? UNDEFINED : rule;
			});
			const ret = {
				ignored,
				unignored
			};
			if (matchedRule) ret.rule = matchedRule;
			return ret;
		}
	};
	const throwError = (message, Ctor) => {
		throw new Ctor(message);
	};
	const checkPath = (path, originalPath, doThrow) => {
		if (!isString(path)) return doThrow(`path must be a string, but got \`${originalPath}\``, TypeError);
		if (!path) return doThrow(`path must not be empty`, TypeError);
		if (checkPath.isNotRelative(path)) return doThrow(`path should be a \`path.relative()\`d string, but got "${originalPath}"`, RangeError);
		return true;
	};
	const isNotRelative = (path) => REGEX_TEST_INVALID_PATH.test(path);
	checkPath.isNotRelative = isNotRelative;
	/* istanbul ignore next */
	checkPath.convert = (p) => p;
	var Ignore = class {
		constructor({ ignorecase = true, ignoreCase = ignorecase, allowRelativePaths = false } = {}) {
			define(this, KEY_IGNORE, true);
			this._rules = new RuleManager(ignoreCase);
			this._strictPathCheck = !allowRelativePaths;
			this._initCache();
		}
		_initCache() {
			this._ignoreCache = Object.create(null);
			this._testCache = Object.create(null);
		}
		add(pattern) {
			if (this._rules.add(pattern)) this._initCache();
			return this;
		}
		addPattern(pattern) {
			return this.add(pattern);
		}
		_test(originalPath, cache, checkUnignored, slices) {
			const path = originalPath && checkPath.convert(originalPath);
			checkPath(path, originalPath, this._strictPathCheck ? throwError : RETURN_FALSE);
			return this._t(path, cache, checkUnignored, slices);
		}
		checkIgnore(path) {
			if (!REGEX_TEST_TRAILING_SLASH.test(path)) return this.test(path);
			const slices = path.split(SLASH).filter(Boolean);
			slices.pop();
			if (slices.length) {
				const parent = this._t(slices.join(SLASH) + SLASH, this._testCache, true, slices);
				if (parent.ignored) return parent;
			}
			return this._rules.test(path, false, MODE_CHECK_IGNORE);
		}
		_t(path, cache, checkUnignored, slices) {
			if (path in cache) return cache[path];
			if (!slices) slices = path.split(SLASH).filter(Boolean);
			slices.pop();
			if (!slices.length) return cache[path] = this._rules.test(path, checkUnignored, MODE_IGNORE);
			const parent = this._t(slices.join(SLASH) + SLASH, cache, checkUnignored, slices);
			return cache[path] = parent.ignored ? parent : this._rules.test(path, checkUnignored, MODE_IGNORE);
		}
		ignores(path) {
			return this._test(path, this._ignoreCache, false).ignored;
		}
		createFilter() {
			return (path) => !this.ignores(path);
		}
		filter(paths) {
			return makeArray(paths).filter(this.createFilter());
		}
		test(path) {
			return this._test(path, this._testCache, true);
		}
	};
	const factory = (options) => new Ignore(options);
	const isPathValid = (path) => checkPath(path && checkPath.convert(path), path, RETURN_FALSE);
	/* istanbul ignore next */
	const setupWindows = () => {
		const makePosix = (str) => /^\\\\\?\\/.test(str) || /["<>|\u0000-\u001F]+/u.test(str) ? str : str.replace(/\\/g, "/");
		checkPath.convert = makePosix;
		const REGEX_TEST_WINDOWS_PATH_ABSOLUTE = /^[a-z]:\//i;
		checkPath.isNotRelative = (path) => REGEX_TEST_WINDOWS_PATH_ABSOLUTE.test(path) || isNotRelative(path);
	};
	/* istanbul ignore next */
	if (typeof process !== "undefined" && process.platform === "win32") setupWindows();
	module.exports = factory;
	factory.default = factory;
	module.exports.isPathValid = isPathValid;
	define(module.exports, Symbol.for("setupWindows"), setupWindows);
}));

//#endregion
//#region node_modules/tsconfig-paths/lib/filesystem.js
var require_filesystem = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.removeExtension = exports.fileExistsAsync = exports.readJsonFromDiskAsync = exports.readJsonFromDiskSync = exports.fileExistsSync = void 0;
	var fs$2 = __require("fs");
	function fileExistsSync(path) {
		if (!fs$2.existsSync(path)) return false;
		try {
			return fs$2.statSync(path).isFile();
		} catch (err) {
			return false;
		}
	}
	exports.fileExistsSync = fileExistsSync;
	/**
	* Reads package.json from disk
	*
	* @param file Path to package.json
	*/
	function readJsonFromDiskSync(packageJsonPath) {
		if (!fs$2.existsSync(packageJsonPath)) return;
		return __require(packageJsonPath);
	}
	exports.readJsonFromDiskSync = readJsonFromDiskSync;
	function readJsonFromDiskAsync(path, callback) {
		fs$2.readFile(path, "utf8", function(err, result) {
			if (err || !result) return callback();
			return callback(void 0, JSON.parse(result));
		});
	}
	exports.readJsonFromDiskAsync = readJsonFromDiskAsync;
	function fileExistsAsync(path2, callback2) {
		fs$2.stat(path2, function(err, stats) {
			if (err) return callback2(void 0, false);
			callback2(void 0, stats ? stats.isFile() : false);
		});
	}
	exports.fileExistsAsync = fileExistsAsync;
	function removeExtension(path) {
		return path.substring(0, path.lastIndexOf(".")) || path;
	}
	exports.removeExtension = removeExtension;
}));

//#endregion
//#region node_modules/tsconfig-paths/lib/mapping-entry.js
var require_mapping_entry = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getAbsoluteMappingEntries = void 0;
	var path$6 = __require("path");
	/**
	* Converts an absolute baseUrl and paths to an array of absolute mapping entries.
	* The array is sorted by longest prefix.
	* Having an array with entries allows us to keep a sorting order rather than
	* sort by keys each time we use the mappings.
	*
	* @param absoluteBaseUrl
	* @param paths
	* @param addMatchAll
	*/
	function getAbsoluteMappingEntries(absoluteBaseUrl, paths, addMatchAll) {
		var sortedKeys = sortByLongestPrefix(Object.keys(paths));
		var absolutePaths = [];
		for (var _i = 0, sortedKeys_1 = sortedKeys; _i < sortedKeys_1.length; _i++) {
			var key = sortedKeys_1[_i];
			absolutePaths.push({
				pattern: key,
				paths: paths[key].map(function(pathToResolve) {
					return path$6.resolve(absoluteBaseUrl, pathToResolve);
				})
			});
		}
		if (!paths["*"] && addMatchAll) absolutePaths.push({
			pattern: "*",
			paths: ["".concat(absoluteBaseUrl.replace(/\/$/, ""), "/*")]
		});
		return absolutePaths;
	}
	exports.getAbsoluteMappingEntries = getAbsoluteMappingEntries;
	/**
	* Sort path patterns.
	* If a module name can be matched with multiple patterns then pattern with the longest prefix will be picked.
	*/
	function sortByLongestPrefix(arr) {
		return arr.concat().sort(function(a, b) {
			return getPrefixLength(b) - getPrefixLength(a);
		});
	}
	function getPrefixLength(pattern) {
		var prefixLength = pattern.indexOf("*");
		return pattern.substr(0, prefixLength).length;
	}
}));

//#endregion
//#region node_modules/tsconfig-paths/lib/try-path.js
var require_try_path = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.exhaustiveTypeException = exports.getStrippedPath = exports.getPathsToTry = void 0;
	var path$5 = __require("path");
	var path_1 = __require("path");
	var filesystem_1 = require_filesystem();
	/**
	* Builds a list of all physical paths to try by:
	* 1. Check for file named exactly as request.
	* 2. Check for files named as request ending in any of the extensions.
	* 3. Check for file specified in package.json's main property.
	* 4. Check for files named as request ending in "index" with any of the extensions.
	*/
	function getPathsToTry(extensions, absolutePathMappings, requestedModule) {
		if (!absolutePathMappings || !requestedModule || requestedModule[0] === ".") return;
		var pathsToTry = [];
		for (var _i = 0, absolutePathMappings_1 = absolutePathMappings; _i < absolutePathMappings_1.length; _i++) {
			var entry = absolutePathMappings_1[_i];
			var starMatch = entry.pattern === requestedModule ? "" : matchStar(entry.pattern, requestedModule);
			if (starMatch !== void 0) {
				var _loop_1 = function(physicalPathPattern) {
					var physicalPath = physicalPathPattern.replaceAll("*", starMatch);
					pathsToTry.push({
						type: "file",
						path: physicalPath
					});
					pathsToTry.push.apply(pathsToTry, extensions.map(function(e) {
						return {
							type: "extension",
							path: physicalPath + e
						};
					}));
					pathsToTry.push({
						type: "package",
						path: path$5.join(physicalPath, "/package.json")
					});
					var indexPath = path$5.join(physicalPath, "/index");
					pathsToTry.push.apply(pathsToTry, extensions.map(function(e) {
						return {
							type: "index",
							path: indexPath + e
						};
					}));
				};
				for (var _a = 0, _b = entry.paths; _a < _b.length; _a++) {
					var physicalPathPattern = _b[_a];
					_loop_1(physicalPathPattern);
				}
			}
		}
		return pathsToTry.length === 0 ? void 0 : pathsToTry;
	}
	exports.getPathsToTry = getPathsToTry;
	function getStrippedPath(tryPath) {
		return tryPath.type === "index" ? (0, path_1.dirname)(tryPath.path) : tryPath.type === "file" ? tryPath.path : tryPath.type === "extension" ? (0, filesystem_1.removeExtension)(tryPath.path) : tryPath.type === "package" ? tryPath.path : exhaustiveTypeException(tryPath.type);
	}
	exports.getStrippedPath = getStrippedPath;
	function exhaustiveTypeException(check) {
		throw new Error("Unknown type ".concat(check));
	}
	exports.exhaustiveTypeException = exhaustiveTypeException;
	/**
	* Matches pattern with a single star against search.
	* Star must match at least one character to be considered a match.
	*
	* @param patttern for example "foo*"
	* @param search for example "fooawesomebar"
	* @returns the part of search that * matches, or undefined if no match.
	*/
	function matchStar(pattern, search) {
		if (search.length < pattern.length) return;
		if (pattern === "*") return search;
		var star = pattern.indexOf("*");
		if (star === -1) return;
		var part1 = pattern.substring(0, star);
		var part2 = pattern.substring(star + 1);
		if (search.substr(0, star) !== part1) return;
		if (search.substr(search.length - part2.length) !== part2) return;
		return search.substr(star, search.length - part2.length);
	}
}));

//#endregion
//#region node_modules/tsconfig-paths/lib/match-path-sync.js
var require_match_path_sync = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.matchFromAbsolutePaths = exports.createMatchPath = void 0;
	var path$4 = __require("path");
	var Filesystem = require_filesystem();
	var MappingEntry = require_mapping_entry();
	var TryPath = require_try_path();
	/**
	* Creates a function that can resolve paths according to tsconfig paths property.
	*
	* @param absoluteBaseUrl Absolute version of baseUrl as specified in tsconfig.
	* @param paths The paths as specified in tsconfig.
	* @param mainFields A list of package.json field names to try when resolving module files. Select a nested field using an array of field names.
	* @param addMatchAll Add a match-all "*" rule if none is present
	* @returns a function that can resolve paths.
	*/
	function createMatchPath(absoluteBaseUrl, paths, mainFields, addMatchAll) {
		if (mainFields === void 0) mainFields = ["main"];
		if (addMatchAll === void 0) addMatchAll = true;
		var absolutePaths = MappingEntry.getAbsoluteMappingEntries(absoluteBaseUrl, paths, addMatchAll);
		return function(requestedModule, readJson, fileExists, extensions) {
			return matchFromAbsolutePaths(absolutePaths, requestedModule, readJson, fileExists, extensions, mainFields);
		};
	}
	exports.createMatchPath = createMatchPath;
	/**
	* Finds a path from tsconfig that matches a module load request.
	*
	* @param absolutePathMappings The paths to try as specified in tsconfig but resolved to absolute form.
	* @param requestedModule The required module name.
	* @param readJson Function that can read json from a path (useful for testing).
	* @param fileExists Function that checks for existence of a file at a path (useful for testing).
	* @param extensions File extensions to probe for (useful for testing).
	* @param mainFields A list of package.json field names to try when resolving module files. Select a nested field using an array of field names.
	* @returns the found path, or undefined if no path was found.
	*/
	function matchFromAbsolutePaths(absolutePathMappings, requestedModule, readJson, fileExists, extensions, mainFields) {
		if (readJson === void 0) readJson = Filesystem.readJsonFromDiskSync;
		if (fileExists === void 0) fileExists = Filesystem.fileExistsSync;
		if (extensions === void 0) extensions = Object.keys(__require.extensions);
		if (mainFields === void 0) mainFields = ["main"];
		var tryPaths = TryPath.getPathsToTry(extensions, absolutePathMappings, requestedModule);
		if (!tryPaths) return;
		return findFirstExistingPath(tryPaths, readJson, fileExists, mainFields);
	}
	exports.matchFromAbsolutePaths = matchFromAbsolutePaths;
	function findFirstExistingMainFieldMappedFile(packageJson, mainFields, packageJsonPath, fileExists) {
		for (var index = 0; index < mainFields.length; index++) {
			var mainFieldSelector = mainFields[index];
			var candidateMapping = typeof mainFieldSelector === "string" ? packageJson[mainFieldSelector] : mainFieldSelector.reduce(function(obj, key) {
				return obj[key];
			}, packageJson);
			if (candidateMapping && typeof candidateMapping === "string") {
				var candidateFilePath = path$4.join(path$4.dirname(packageJsonPath), candidateMapping);
				if (fileExists(candidateFilePath)) return candidateFilePath;
			}
		}
	}
	function findFirstExistingPath(tryPaths, readJson, fileExists, mainFields) {
		if (readJson === void 0) readJson = Filesystem.readJsonFromDiskSync;
		if (mainFields === void 0) mainFields = ["main"];
		for (var _i = 0, tryPaths_1 = tryPaths; _i < tryPaths_1.length; _i++) {
			var tryPath = tryPaths_1[_i];
			if (tryPath.type === "file" || tryPath.type === "extension" || tryPath.type === "index") {
				if (fileExists(tryPath.path)) return TryPath.getStrippedPath(tryPath);
			} else if (tryPath.type === "package") {
				var packageJson = readJson(tryPath.path);
				if (packageJson) {
					var mainFieldMappedFile = findFirstExistingMainFieldMappedFile(packageJson, mainFields, tryPath.path, fileExists);
					if (mainFieldMappedFile) return mainFieldMappedFile;
				}
			} else TryPath.exhaustiveTypeException(tryPath.type);
		}
	}
}));

//#endregion
//#region node_modules/tsconfig-paths/lib/match-path-async.js
var require_match_path_async = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.matchFromAbsolutePathsAsync = exports.createMatchPathAsync = void 0;
	var path$3 = __require("path");
	var TryPath = require_try_path();
	var MappingEntry = require_mapping_entry();
	var Filesystem = require_filesystem();
	/**
	* See the sync version for docs.
	*/
	function createMatchPathAsync(absoluteBaseUrl, paths, mainFields, addMatchAll) {
		if (mainFields === void 0) mainFields = ["main"];
		if (addMatchAll === void 0) addMatchAll = true;
		var absolutePaths = MappingEntry.getAbsoluteMappingEntries(absoluteBaseUrl, paths, addMatchAll);
		return function(requestedModule, readJson, fileExists, extensions, callback) {
			return matchFromAbsolutePathsAsync(absolutePaths, requestedModule, readJson, fileExists, extensions, callback, mainFields);
		};
	}
	exports.createMatchPathAsync = createMatchPathAsync;
	/**
	* See the sync version for docs.
	*/
	function matchFromAbsolutePathsAsync(absolutePathMappings, requestedModule, readJson, fileExists, extensions, callback, mainFields) {
		if (readJson === void 0) readJson = Filesystem.readJsonFromDiskAsync;
		if (fileExists === void 0) fileExists = Filesystem.fileExistsAsync;
		if (extensions === void 0) extensions = Object.keys(__require.extensions);
		if (mainFields === void 0) mainFields = ["main"];
		var tryPaths = TryPath.getPathsToTry(extensions, absolutePathMappings, requestedModule);
		if (!tryPaths) return callback();
		findFirstExistingPath(tryPaths, readJson, fileExists, callback, 0, mainFields);
	}
	exports.matchFromAbsolutePathsAsync = matchFromAbsolutePathsAsync;
	function findFirstExistingMainFieldMappedFile(packageJson, mainFields, packageJsonPath, fileExistsAsync, doneCallback, index) {
		if (index === void 0) index = 0;
		if (index >= mainFields.length) return doneCallback(void 0, void 0);
		var tryNext = function() {
			return findFirstExistingMainFieldMappedFile(packageJson, mainFields, packageJsonPath, fileExistsAsync, doneCallback, index + 1);
		};
		var mainFieldSelector = mainFields[index];
		var mainFieldMapping = typeof mainFieldSelector === "string" ? packageJson[mainFieldSelector] : mainFieldSelector.reduce(function(obj, key) {
			return obj[key];
		}, packageJson);
		if (typeof mainFieldMapping !== "string") return tryNext();
		var mappedFilePath = path$3.join(path$3.dirname(packageJsonPath), mainFieldMapping);
		fileExistsAsync(mappedFilePath, function(err, exists) {
			if (err) return doneCallback(err);
			if (exists) return doneCallback(void 0, mappedFilePath);
			return tryNext();
		});
	}
	function findFirstExistingPath(tryPaths, readJson, fileExists, doneCallback, index, mainFields) {
		if (index === void 0) index = 0;
		if (mainFields === void 0) mainFields = ["main"];
		var tryPath = tryPaths[index];
		if (tryPath.type === "file" || tryPath.type === "extension" || tryPath.type === "index") fileExists(tryPath.path, function(err, exists) {
			if (err) return doneCallback(err);
			if (exists) return doneCallback(void 0, TryPath.getStrippedPath(tryPath));
			if (index === tryPaths.length - 1) return doneCallback();
			return findFirstExistingPath(tryPaths, readJson, fileExists, doneCallback, index + 1, mainFields);
		});
		else if (tryPath.type === "package") readJson(tryPath.path, function(err, packageJson) {
			if (err) return doneCallback(err);
			if (packageJson) return findFirstExistingMainFieldMappedFile(packageJson, mainFields, tryPath.path, fileExists, function(mainFieldErr, mainFieldMappedFile) {
				if (mainFieldErr) return doneCallback(mainFieldErr);
				if (mainFieldMappedFile) return doneCallback(void 0, mainFieldMappedFile);
				return findFirstExistingPath(tryPaths, readJson, fileExists, doneCallback, index + 1, mainFields);
			});
			return findFirstExistingPath(tryPaths, readJson, fileExists, doneCallback, index + 1, mainFields);
		});
		else TryPath.exhaustiveTypeException(tryPath.type);
	}
}));

//#endregion
//#region node_modules/json5/lib/unicode.js
var require_unicode = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports.Space_Separator = /[\u1680\u2000-\u200A\u202F\u205F\u3000]/;
	module.exports.ID_Start = /[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u1884\u1887-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C88\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC03-\uDC37\uDC83-\uDCAF\uDCD0-\uDCE8\uDD03-\uDD26\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC00-\uDC34\uDC47-\uDC4A\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE80-\uDEAA\uDF00-\uDF19]|\uD806[\uDCA0-\uDCDF\uDCFF\uDE00\uDE0B-\uDE32\uDE3A\uDE50\uDE5C-\uDE83\uDE86-\uDE89\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2E\uDC40\uDC72-\uDC8F\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDC00-\uDCC4\uDD00-\uDD43]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]/;
	module.exports.ID_Continue = /[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05F0-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u0800-\u082D\u0840-\u085B\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u08D4-\u08E1\u08E3-\u0963\u0966-\u096F\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u09FC\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0AF9-\u0AFF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58-\u0C5A\u0C60-\u0C63\u0C66-\u0C6F\u0C80-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D00-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D54-\u0D57\u0D5F-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1877\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19D9\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1AB0-\u1ABD\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1C80-\u1C88\u1CD0-\u1CD2\u1CD4-\u1CF9\u1D00-\u1DF9\u1DFB-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u2E2F\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099\u309A\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312E\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEA\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA827\uA840-\uA873\uA880-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA8FD\uA900-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uA9E0-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDDFD\uDE80-\uDE9C\uDEA0-\uDED0\uDEE0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF7A\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE38-\uDE3A\uDE3F\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE6\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD804[\uDC00-\uDC46\uDC66-\uDC6F\uDC7F-\uDCBA\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD00-\uDD34\uDD36-\uDD3F\uDD50-\uDD73\uDD76\uDD80-\uDDC4\uDDCA-\uDDCC\uDDD0-\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE37\uDE3E\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEEA\uDEF0-\uDEF9\uDF00-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3C-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF57\uDF5D-\uDF63\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC00-\uDC4A\uDC50-\uDC59\uDC80-\uDCC5\uDCC7\uDCD0-\uDCD9\uDD80-\uDDB5\uDDB8-\uDDC0\uDDD8-\uDDDD\uDE00-\uDE40\uDE44\uDE50-\uDE59\uDE80-\uDEB7\uDEC0-\uDEC9\uDF00-\uDF19\uDF1D-\uDF2B\uDF30-\uDF39]|\uD806[\uDCA0-\uDCE9\uDCFF\uDE00-\uDE3E\uDE47\uDE50-\uDE83\uDE86-\uDE99\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC36\uDC38-\uDC40\uDC50-\uDC59\uDC72-\uDC8F\uDC92-\uDCA7\uDCA9-\uDCB6\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD47\uDD50-\uDD59]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDED0-\uDEED\uDEF0-\uDEF4\uDF00-\uDF36\uDF40-\uDF43\uDF50-\uDF59\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50-\uDF7E\uDF8F-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9D\uDC9E]|\uD834[\uDD65-\uDD69\uDD6D-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDC00-\uDCC4\uDCD0-\uDCD6\uDD00-\uDD4A\uDD50-\uDD59]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]|\uDB40[\uDD00-\uDDEF]/;
}));

//#endregion
//#region node_modules/json5/lib/util.js
var require_util = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const unicode = require_unicode();
	module.exports = {
		isSpaceSeparator(c) {
			return typeof c === "string" && unicode.Space_Separator.test(c);
		},
		isIdStartChar(c) {
			return typeof c === "string" && (c >= "a" && c <= "z" || c >= "A" && c <= "Z" || c === "$" || c === "_" || unicode.ID_Start.test(c));
		},
		isIdContinueChar(c) {
			return typeof c === "string" && (c >= "a" && c <= "z" || c >= "A" && c <= "Z" || c >= "0" && c <= "9" || c === "$" || c === "_" || c === "‌" || c === "‍" || unicode.ID_Continue.test(c));
		},
		isDigit(c) {
			return typeof c === "string" && /[0-9]/.test(c);
		},
		isHexDigit(c) {
			return typeof c === "string" && /[0-9A-Fa-f]/.test(c);
		}
	};
}));

//#endregion
//#region node_modules/json5/lib/parse.js
var require_parse = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const util = require_util();
	let source;
	let parseState;
	let stack;
	let pos;
	let line;
	let column;
	let token;
	let key;
	let root;
	module.exports = function parse(text, reviver) {
		source = String(text);
		parseState = "start";
		stack = [];
		pos = 0;
		line = 1;
		column = 0;
		token = void 0;
		key = void 0;
		root = void 0;
		do {
			token = lex();
			parseStates[parseState]();
		} while (token.type !== "eof");
		if (typeof reviver === "function") return internalize({ "": root }, "", reviver);
		return root;
	};
	function internalize(holder, name, reviver) {
		const value = holder[name];
		if (value != null && typeof value === "object") if (Array.isArray(value)) for (let i = 0; i < value.length; i++) {
			const key = String(i);
			const replacement = internalize(value, key, reviver);
			if (replacement === void 0) delete value[key];
			else Object.defineProperty(value, key, {
				value: replacement,
				writable: true,
				enumerable: true,
				configurable: true
			});
		}
		else for (const key in value) {
			const replacement = internalize(value, key, reviver);
			if (replacement === void 0) delete value[key];
			else Object.defineProperty(value, key, {
				value: replacement,
				writable: true,
				enumerable: true,
				configurable: true
			});
		}
		return reviver.call(holder, name, value);
	}
	let lexState;
	let buffer;
	let doubleQuote;
	let sign;
	let c;
	function lex() {
		lexState = "default";
		buffer = "";
		doubleQuote = false;
		sign = 1;
		for (;;) {
			c = peek();
			const token = lexStates[lexState]();
			if (token) return token;
		}
	}
	function peek() {
		if (source[pos]) return String.fromCodePoint(source.codePointAt(pos));
	}
	function read() {
		const c = peek();
		if (c === "\n") {
			line++;
			column = 0;
		} else if (c) column += c.length;
		else column++;
		if (c) pos += c.length;
		return c;
	}
	const lexStates = {
		default() {
			switch (c) {
				case "	":
				case "\v":
				case "\f":
				case " ":
				case "\xA0":
				case "﻿":
				case "\n":
				case "\r":
				case "\u2028":
				case "\u2029":
					read();
					return;
				case "/":
					read();
					lexState = "comment";
					return;
				case void 0:
					read();
					return newToken("eof");
			}
			if (util.isSpaceSeparator(c)) {
				read();
				return;
			}
			return lexStates[parseState]();
		},
		comment() {
			switch (c) {
				case "*":
					read();
					lexState = "multiLineComment";
					return;
				case "/":
					read();
					lexState = "singleLineComment";
					return;
			}
			throw invalidChar(read());
		},
		multiLineComment() {
			switch (c) {
				case "*":
					read();
					lexState = "multiLineCommentAsterisk";
					return;
				case void 0: throw invalidChar(read());
			}
			read();
		},
		multiLineCommentAsterisk() {
			switch (c) {
				case "*":
					read();
					return;
				case "/":
					read();
					lexState = "default";
					return;
				case void 0: throw invalidChar(read());
			}
			read();
			lexState = "multiLineComment";
		},
		singleLineComment() {
			switch (c) {
				case "\n":
				case "\r":
				case "\u2028":
				case "\u2029":
					read();
					lexState = "default";
					return;
				case void 0:
					read();
					return newToken("eof");
			}
			read();
		},
		value() {
			switch (c) {
				case "{":
				case "[": return newToken("punctuator", read());
				case "n":
					read();
					literal("ull");
					return newToken("null", null);
				case "t":
					read();
					literal("rue");
					return newToken("boolean", true);
				case "f":
					read();
					literal("alse");
					return newToken("boolean", false);
				case "-":
				case "+":
					if (read() === "-") sign = -1;
					lexState = "sign";
					return;
				case ".":
					buffer = read();
					lexState = "decimalPointLeading";
					return;
				case "0":
					buffer = read();
					lexState = "zero";
					return;
				case "1":
				case "2":
				case "3":
				case "4":
				case "5":
				case "6":
				case "7":
				case "8":
				case "9":
					buffer = read();
					lexState = "decimalInteger";
					return;
				case "I":
					read();
					literal("nfinity");
					return newToken("numeric", Infinity);
				case "N":
					read();
					literal("aN");
					return newToken("numeric", NaN);
				case "\"":
				case "'":
					doubleQuote = read() === "\"";
					buffer = "";
					lexState = "string";
					return;
			}
			throw invalidChar(read());
		},
		identifierNameStartEscape() {
			if (c !== "u") throw invalidChar(read());
			read();
			const u = unicodeEscape();
			switch (u) {
				case "$":
				case "_": break;
				default:
					if (!util.isIdStartChar(u)) throw invalidIdentifier();
					break;
			}
			buffer += u;
			lexState = "identifierName";
		},
		identifierName() {
			switch (c) {
				case "$":
				case "_":
				case "‌":
				case "‍":
					buffer += read();
					return;
				case "\\":
					read();
					lexState = "identifierNameEscape";
					return;
			}
			if (util.isIdContinueChar(c)) {
				buffer += read();
				return;
			}
			return newToken("identifier", buffer);
		},
		identifierNameEscape() {
			if (c !== "u") throw invalidChar(read());
			read();
			const u = unicodeEscape();
			switch (u) {
				case "$":
				case "_":
				case "‌":
				case "‍": break;
				default:
					if (!util.isIdContinueChar(u)) throw invalidIdentifier();
					break;
			}
			buffer += u;
			lexState = "identifierName";
		},
		sign() {
			switch (c) {
				case ".":
					buffer = read();
					lexState = "decimalPointLeading";
					return;
				case "0":
					buffer = read();
					lexState = "zero";
					return;
				case "1":
				case "2":
				case "3":
				case "4":
				case "5":
				case "6":
				case "7":
				case "8":
				case "9":
					buffer = read();
					lexState = "decimalInteger";
					return;
				case "I":
					read();
					literal("nfinity");
					return newToken("numeric", sign * Infinity);
				case "N":
					read();
					literal("aN");
					return newToken("numeric", NaN);
			}
			throw invalidChar(read());
		},
		zero() {
			switch (c) {
				case ".":
					buffer += read();
					lexState = "decimalPoint";
					return;
				case "e":
				case "E":
					buffer += read();
					lexState = "decimalExponent";
					return;
				case "x":
				case "X":
					buffer += read();
					lexState = "hexadecimal";
					return;
			}
			return newToken("numeric", sign * 0);
		},
		decimalInteger() {
			switch (c) {
				case ".":
					buffer += read();
					lexState = "decimalPoint";
					return;
				case "e":
				case "E":
					buffer += read();
					lexState = "decimalExponent";
					return;
			}
			if (util.isDigit(c)) {
				buffer += read();
				return;
			}
			return newToken("numeric", sign * Number(buffer));
		},
		decimalPointLeading() {
			if (util.isDigit(c)) {
				buffer += read();
				lexState = "decimalFraction";
				return;
			}
			throw invalidChar(read());
		},
		decimalPoint() {
			switch (c) {
				case "e":
				case "E":
					buffer += read();
					lexState = "decimalExponent";
					return;
			}
			if (util.isDigit(c)) {
				buffer += read();
				lexState = "decimalFraction";
				return;
			}
			return newToken("numeric", sign * Number(buffer));
		},
		decimalFraction() {
			switch (c) {
				case "e":
				case "E":
					buffer += read();
					lexState = "decimalExponent";
					return;
			}
			if (util.isDigit(c)) {
				buffer += read();
				return;
			}
			return newToken("numeric", sign * Number(buffer));
		},
		decimalExponent() {
			switch (c) {
				case "+":
				case "-":
					buffer += read();
					lexState = "decimalExponentSign";
					return;
			}
			if (util.isDigit(c)) {
				buffer += read();
				lexState = "decimalExponentInteger";
				return;
			}
			throw invalidChar(read());
		},
		decimalExponentSign() {
			if (util.isDigit(c)) {
				buffer += read();
				lexState = "decimalExponentInteger";
				return;
			}
			throw invalidChar(read());
		},
		decimalExponentInteger() {
			if (util.isDigit(c)) {
				buffer += read();
				return;
			}
			return newToken("numeric", sign * Number(buffer));
		},
		hexadecimal() {
			if (util.isHexDigit(c)) {
				buffer += read();
				lexState = "hexadecimalInteger";
				return;
			}
			throw invalidChar(read());
		},
		hexadecimalInteger() {
			if (util.isHexDigit(c)) {
				buffer += read();
				return;
			}
			return newToken("numeric", sign * Number(buffer));
		},
		string() {
			switch (c) {
				case "\\":
					read();
					buffer += escape();
					return;
				case "\"":
					if (doubleQuote) {
						read();
						return newToken("string", buffer);
					}
					buffer += read();
					return;
				case "'":
					if (!doubleQuote) {
						read();
						return newToken("string", buffer);
					}
					buffer += read();
					return;
				case "\n":
				case "\r": throw invalidChar(read());
				case "\u2028":
				case "\u2029":
					separatorChar(c);
					break;
				case void 0: throw invalidChar(read());
			}
			buffer += read();
		},
		start() {
			switch (c) {
				case "{":
				case "[": return newToken("punctuator", read());
			}
			lexState = "value";
		},
		beforePropertyName() {
			switch (c) {
				case "$":
				case "_":
					buffer = read();
					lexState = "identifierName";
					return;
				case "\\":
					read();
					lexState = "identifierNameStartEscape";
					return;
				case "}": return newToken("punctuator", read());
				case "\"":
				case "'":
					doubleQuote = read() === "\"";
					lexState = "string";
					return;
			}
			if (util.isIdStartChar(c)) {
				buffer += read();
				lexState = "identifierName";
				return;
			}
			throw invalidChar(read());
		},
		afterPropertyName() {
			if (c === ":") return newToken("punctuator", read());
			throw invalidChar(read());
		},
		beforePropertyValue() {
			lexState = "value";
		},
		afterPropertyValue() {
			switch (c) {
				case ",":
				case "}": return newToken("punctuator", read());
			}
			throw invalidChar(read());
		},
		beforeArrayValue() {
			if (c === "]") return newToken("punctuator", read());
			lexState = "value";
		},
		afterArrayValue() {
			switch (c) {
				case ",":
				case "]": return newToken("punctuator", read());
			}
			throw invalidChar(read());
		},
		end() {
			throw invalidChar(read());
		}
	};
	function newToken(type, value) {
		return {
			type,
			value,
			line,
			column
		};
	}
	function literal(s) {
		for (const c of s) {
			if (peek() !== c) throw invalidChar(read());
			read();
		}
	}
	function escape() {
		switch (peek()) {
			case "b":
				read();
				return "\b";
			case "f":
				read();
				return "\f";
			case "n":
				read();
				return "\n";
			case "r":
				read();
				return "\r";
			case "t":
				read();
				return "	";
			case "v":
				read();
				return "\v";
			case "0":
				read();
				if (util.isDigit(peek())) throw invalidChar(read());
				return "\0";
			case "x":
				read();
				return hexEscape();
			case "u":
				read();
				return unicodeEscape();
			case "\n":
			case "\u2028":
			case "\u2029":
				read();
				return "";
			case "\r":
				read();
				if (peek() === "\n") read();
				return "";
			case "1":
			case "2":
			case "3":
			case "4":
			case "5":
			case "6":
			case "7":
			case "8":
			case "9": throw invalidChar(read());
			case void 0: throw invalidChar(read());
		}
		return read();
	}
	function hexEscape() {
		let buffer = "";
		let c = peek();
		if (!util.isHexDigit(c)) throw invalidChar(read());
		buffer += read();
		c = peek();
		if (!util.isHexDigit(c)) throw invalidChar(read());
		buffer += read();
		return String.fromCodePoint(parseInt(buffer, 16));
	}
	function unicodeEscape() {
		let buffer = "";
		let count = 4;
		while (count-- > 0) {
			const c = peek();
			if (!util.isHexDigit(c)) throw invalidChar(read());
			buffer += read();
		}
		return String.fromCodePoint(parseInt(buffer, 16));
	}
	const parseStates = {
		start() {
			if (token.type === "eof") throw invalidEOF();
			push();
		},
		beforePropertyName() {
			switch (token.type) {
				case "identifier":
				case "string":
					key = token.value;
					parseState = "afterPropertyName";
					return;
				case "punctuator":
					pop();
					return;
				case "eof": throw invalidEOF();
			}
		},
		afterPropertyName() {
			if (token.type === "eof") throw invalidEOF();
			parseState = "beforePropertyValue";
		},
		beforePropertyValue() {
			if (token.type === "eof") throw invalidEOF();
			push();
		},
		beforeArrayValue() {
			if (token.type === "eof") throw invalidEOF();
			if (token.type === "punctuator" && token.value === "]") {
				pop();
				return;
			}
			push();
		},
		afterPropertyValue() {
			if (token.type === "eof") throw invalidEOF();
			switch (token.value) {
				case ",":
					parseState = "beforePropertyName";
					return;
				case "}": pop();
			}
		},
		afterArrayValue() {
			if (token.type === "eof") throw invalidEOF();
			switch (token.value) {
				case ",":
					parseState = "beforeArrayValue";
					return;
				case "]": pop();
			}
		},
		end() {}
	};
	function push() {
		let value;
		switch (token.type) {
			case "punctuator":
				switch (token.value) {
					case "{":
						value = {};
						break;
					case "[":
						value = [];
						break;
				}
				break;
			case "null":
			case "boolean":
			case "numeric":
			case "string":
				value = token.value;
				break;
		}
		if (root === void 0) root = value;
		else {
			const parent = stack[stack.length - 1];
			if (Array.isArray(parent)) parent.push(value);
			else Object.defineProperty(parent, key, {
				value,
				writable: true,
				enumerable: true,
				configurable: true
			});
		}
		if (value !== null && typeof value === "object") {
			stack.push(value);
			if (Array.isArray(value)) parseState = "beforeArrayValue";
			else parseState = "beforePropertyName";
		} else {
			const current = stack[stack.length - 1];
			if (current == null) parseState = "end";
			else if (Array.isArray(current)) parseState = "afterArrayValue";
			else parseState = "afterPropertyValue";
		}
	}
	function pop() {
		stack.pop();
		const current = stack[stack.length - 1];
		if (current == null) parseState = "end";
		else if (Array.isArray(current)) parseState = "afterArrayValue";
		else parseState = "afterPropertyValue";
	}
	function invalidChar(c) {
		if (c === void 0) return syntaxError(`JSON5: invalid end of input at ${line}:${column}`);
		return syntaxError(`JSON5: invalid character '${formatChar(c)}' at ${line}:${column}`);
	}
	function invalidEOF() {
		return syntaxError(`JSON5: invalid end of input at ${line}:${column}`);
	}
	function invalidIdentifier() {
		column -= 5;
		return syntaxError(`JSON5: invalid identifier character at ${line}:${column}`);
	}
	function separatorChar(c) {
		console.warn(`JSON5: '${formatChar(c)}' in strings is not valid ECMAScript; consider escaping`);
	}
	function formatChar(c) {
		const replacements = {
			"'": "\\'",
			"\"": "\\\"",
			"\\": "\\\\",
			"\b": "\\b",
			"\f": "\\f",
			"\n": "\\n",
			"\r": "\\r",
			"	": "\\t",
			"\v": "\\v",
			"\0": "\\0",
			"\u2028": "\\u2028",
			"\u2029": "\\u2029"
		};
		if (replacements[c]) return replacements[c];
		if (c < " ") {
			const hexString = c.charCodeAt(0).toString(16);
			return "\\x" + ("00" + hexString).substring(hexString.length);
		}
		return c;
	}
	function syntaxError(message) {
		const err = new SyntaxError(message);
		err.lineNumber = line;
		err.columnNumber = column;
		return err;
	}
}));

//#endregion
//#region node_modules/json5/lib/stringify.js
var require_stringify = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const util = require_util();
	module.exports = function stringify(value, replacer, space) {
		const stack = [];
		let indent = "";
		let propertyList;
		let replacerFunc;
		let gap = "";
		let quote;
		if (replacer != null && typeof replacer === "object" && !Array.isArray(replacer)) {
			space = replacer.space;
			quote = replacer.quote;
			replacer = replacer.replacer;
		}
		if (typeof replacer === "function") replacerFunc = replacer;
		else if (Array.isArray(replacer)) {
			propertyList = [];
			for (const v of replacer) {
				let item;
				if (typeof v === "string") item = v;
				else if (typeof v === "number" || v instanceof String || v instanceof Number) item = String(v);
				if (item !== void 0 && propertyList.indexOf(item) < 0) propertyList.push(item);
			}
		}
		if (space instanceof Number) space = Number(space);
		else if (space instanceof String) space = String(space);
		if (typeof space === "number") {
			if (space > 0) {
				space = Math.min(10, Math.floor(space));
				gap = "          ".substr(0, space);
			}
		} else if (typeof space === "string") gap = space.substr(0, 10);
		return serializeProperty("", { "": value });
		function serializeProperty(key, holder) {
			let value = holder[key];
			if (value != null) {
				if (typeof value.toJSON5 === "function") value = value.toJSON5(key);
				else if (typeof value.toJSON === "function") value = value.toJSON(key);
			}
			if (replacerFunc) value = replacerFunc.call(holder, key, value);
			if (value instanceof Number) value = Number(value);
			else if (value instanceof String) value = String(value);
			else if (value instanceof Boolean) value = value.valueOf();
			switch (value) {
				case null: return "null";
				case true: return "true";
				case false: return "false";
			}
			if (typeof value === "string") return quoteString(value, false);
			if (typeof value === "number") return String(value);
			if (typeof value === "object") return Array.isArray(value) ? serializeArray(value) : serializeObject(value);
		}
		function quoteString(value) {
			const quotes = {
				"'": .1,
				"\"": .2
			};
			const replacements = {
				"'": "\\'",
				"\"": "\\\"",
				"\\": "\\\\",
				"\b": "\\b",
				"\f": "\\f",
				"\n": "\\n",
				"\r": "\\r",
				"	": "\\t",
				"\v": "\\v",
				"\0": "\\0",
				"\u2028": "\\u2028",
				"\u2029": "\\u2029"
			};
			let product = "";
			for (let i = 0; i < value.length; i++) {
				const c = value[i];
				switch (c) {
					case "'":
					case "\"":
						quotes[c]++;
						product += c;
						continue;
					case "\0": if (util.isDigit(value[i + 1])) {
						product += "\\x00";
						continue;
					}
				}
				if (replacements[c]) {
					product += replacements[c];
					continue;
				}
				if (c < " ") {
					let hexString = c.charCodeAt(0).toString(16);
					product += "\\x" + ("00" + hexString).substring(hexString.length);
					continue;
				}
				product += c;
			}
			const quoteChar = quote || Object.keys(quotes).reduce((a, b) => quotes[a] < quotes[b] ? a : b);
			product = product.replace(new RegExp(quoteChar, "g"), replacements[quoteChar]);
			return quoteChar + product + quoteChar;
		}
		function serializeObject(value) {
			if (stack.indexOf(value) >= 0) throw TypeError("Converting circular structure to JSON5");
			stack.push(value);
			let stepback = indent;
			indent = indent + gap;
			let keys = propertyList || Object.keys(value);
			let partial = [];
			for (const key of keys) {
				const propertyString = serializeProperty(key, value);
				if (propertyString !== void 0) {
					let member = serializeKey(key) + ":";
					if (gap !== "") member += " ";
					member += propertyString;
					partial.push(member);
				}
			}
			let final;
			if (partial.length === 0) final = "{}";
			else {
				let properties;
				if (gap === "") {
					properties = partial.join(",");
					final = "{" + properties + "}";
				} else {
					let separator = ",\n" + indent;
					properties = partial.join(separator);
					final = "{\n" + indent + properties + ",\n" + stepback + "}";
				}
			}
			stack.pop();
			indent = stepback;
			return final;
		}
		function serializeKey(key) {
			if (key.length === 0) return quoteString(key, true);
			const firstChar = String.fromCodePoint(key.codePointAt(0));
			if (!util.isIdStartChar(firstChar)) return quoteString(key, true);
			for (let i = firstChar.length; i < key.length; i++) if (!util.isIdContinueChar(String.fromCodePoint(key.codePointAt(i)))) return quoteString(key, true);
			return key;
		}
		function serializeArray(value) {
			if (stack.indexOf(value) >= 0) throw TypeError("Converting circular structure to JSON5");
			stack.push(value);
			let stepback = indent;
			indent = indent + gap;
			let partial = [];
			for (let i = 0; i < value.length; i++) {
				const propertyString = serializeProperty(String(i), value);
				partial.push(propertyString !== void 0 ? propertyString : "null");
			}
			let final;
			if (partial.length === 0) final = "[]";
			else if (gap === "") final = "[" + partial.join(",") + "]";
			else {
				let separator = ",\n" + indent;
				let properties = partial.join(separator);
				final = "[\n" + indent + properties + ",\n" + stepback + "]";
			}
			stack.pop();
			indent = stepback;
			return final;
		}
	};
}));

//#endregion
//#region node_modules/json5/lib/index.js
var require_lib$1 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const JSON5 = {
		parse: require_parse(),
		stringify: require_stringify()
	};
	module.exports = JSON5;
}));

//#endregion
//#region node_modules/strip-bom/index.js
var require_strip_bom = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = (x) => {
		if (typeof x !== "string") throw new TypeError("Expected a string, got " + typeof x);
		if (x.charCodeAt(0) === 65279) return x.slice(1);
		return x;
	};
}));

//#endregion
//#region node_modules/tsconfig-paths/lib/tsconfig-loader.js
var require_tsconfig_loader = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __assign = exports && exports.__assign || function() {
		__assign = Object.assign || function(t) {
			for (var s, i = 1, n = arguments.length; i < n; i++) {
				s = arguments[i];
				for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
			}
			return t;
		};
		return __assign.apply(this, arguments);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.loadTsconfig = exports.walkForTsConfig = exports.tsConfigLoader = void 0;
	var path$2 = __require("path");
	var fs$1 = __require("fs");
	var JSON5 = require_lib$1();
	var StripBom = require_strip_bom();
	function tsConfigLoader(_a) {
		var getEnv = _a.getEnv, cwd = _a.cwd, _b = _a.loadSync;
		return (_b === void 0 ? loadSyncDefault : _b)(cwd, getEnv("TS_NODE_PROJECT"), getEnv("TS_NODE_BASEURL"));
	}
	exports.tsConfigLoader = tsConfigLoader;
	function loadSyncDefault(cwd, filename, baseUrl) {
		var configPath = resolveConfigPath(cwd, filename);
		if (!configPath) return {
			tsConfigPath: void 0,
			baseUrl: void 0,
			paths: void 0
		};
		var config = loadTsconfig(configPath);
		return {
			tsConfigPath: configPath,
			baseUrl: baseUrl || config && config.compilerOptions && config.compilerOptions.baseUrl,
			paths: config && config.compilerOptions && config.compilerOptions.paths
		};
	}
	function resolveConfigPath(cwd, filename) {
		if (filename) return fs$1.lstatSync(filename).isDirectory() ? path$2.resolve(filename, "./tsconfig.json") : path$2.resolve(cwd, filename);
		if (fs$1.statSync(cwd).isFile()) return path$2.resolve(cwd);
		var configAbsolutePath = walkForTsConfig(cwd);
		return configAbsolutePath ? path$2.resolve(configAbsolutePath) : void 0;
	}
	function walkForTsConfig(directory, readdirSync) {
		if (readdirSync === void 0) readdirSync = fs$1.readdirSync;
		var files = readdirSync(directory);
		var filesToCheck = ["tsconfig.json", "jsconfig.json"];
		for (var _i = 0, filesToCheck_1 = filesToCheck; _i < filesToCheck_1.length; _i++) {
			var fileToCheck = filesToCheck_1[_i];
			if (files.indexOf(fileToCheck) !== -1) return path$2.join(directory, fileToCheck);
		}
		var parentDirectory = path$2.dirname(directory);
		if (directory === parentDirectory) return;
		return walkForTsConfig(parentDirectory, readdirSync);
	}
	exports.walkForTsConfig = walkForTsConfig;
	function loadTsconfig(configFilePath, existsSync, readFileSync) {
		if (existsSync === void 0) existsSync = fs$1.existsSync;
		if (readFileSync === void 0) readFileSync = function(filename) {
			return fs$1.readFileSync(filename, "utf8");
		};
		if (!existsSync(configFilePath)) return;
		var cleanedJson = StripBom(readFileSync(configFilePath));
		var config;
		try {
			config = JSON5.parse(cleanedJson);
		} catch (e) {
			throw new Error("".concat(configFilePath, " is malformed ").concat(e.message));
		}
		var extendedConfig = config.extends;
		if (extendedConfig) {
			var base = void 0;
			if (Array.isArray(extendedConfig)) base = extendedConfig.reduce(function(currBase, extendedConfigElement) {
				return mergeTsconfigs(currBase, loadTsconfigFromExtends(configFilePath, extendedConfigElement, existsSync, readFileSync));
			}, {});
			else base = loadTsconfigFromExtends(configFilePath, extendedConfig, existsSync, readFileSync);
			return mergeTsconfigs(base, config);
		}
		return config;
	}
	exports.loadTsconfig = loadTsconfig;
	/**
	* Intended to be called only from loadTsconfig.
	* Parameters don't have defaults because they should use the same as loadTsconfig.
	*/
	function loadTsconfigFromExtends(configFilePath, extendedConfigValue, existsSync, readFileSync) {
		var _a;
		if (typeof extendedConfigValue === "string" && extendedConfigValue.indexOf(".json") === -1) extendedConfigValue += ".json";
		var currentDir = path$2.dirname(configFilePath);
		var extendedConfigPath = path$2.join(currentDir, extendedConfigValue);
		if (extendedConfigValue.indexOf("/") !== -1 && extendedConfigValue.indexOf(".") !== -1 && !existsSync(extendedConfigPath)) extendedConfigPath = path$2.join(currentDir, "node_modules", extendedConfigValue);
		var config = loadTsconfig(extendedConfigPath, existsSync, readFileSync) || {};
		if ((_a = config.compilerOptions) === null || _a === void 0 ? void 0 : _a.baseUrl) {
			var extendsDir = path$2.dirname(extendedConfigValue);
			config.compilerOptions.baseUrl = path$2.join(extendsDir, config.compilerOptions.baseUrl);
		}
		return config;
	}
	function mergeTsconfigs(base, config) {
		base = base || {};
		config = config || {};
		return __assign(__assign(__assign({}, base), config), { compilerOptions: __assign(__assign({}, base.compilerOptions), config.compilerOptions) });
	}
}));

//#endregion
//#region node_modules/tsconfig-paths/lib/config-loader.js
var require_config_loader = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.configLoader = exports.loadConfig = void 0;
	var TsConfigLoader2 = require_tsconfig_loader();
	var path$1 = __require("path");
	function loadConfig(cwd) {
		if (cwd === void 0) cwd = process.cwd();
		return configLoader({ cwd });
	}
	exports.loadConfig = loadConfig;
	function configLoader(_a) {
		var cwd = _a.cwd, explicitParams = _a.explicitParams, _b = _a.tsConfigLoader, tsConfigLoader = _b === void 0 ? TsConfigLoader2.tsConfigLoader : _b;
		if (explicitParams) {
			var absoluteBaseUrl = path$1.isAbsolute(explicitParams.baseUrl) ? explicitParams.baseUrl : path$1.join(cwd, explicitParams.baseUrl);
			return {
				resultType: "success",
				configFileAbsolutePath: "",
				baseUrl: explicitParams.baseUrl,
				absoluteBaseUrl,
				paths: explicitParams.paths,
				mainFields: explicitParams.mainFields,
				addMatchAll: explicitParams.addMatchAll
			};
		}
		var loadResult = tsConfigLoader({
			cwd,
			getEnv: function(key) {
				return process.env[key];
			}
		});
		if (!loadResult.tsConfigPath) return {
			resultType: "failed",
			message: "Couldn't find tsconfig.json"
		};
		return {
			resultType: "success",
			configFileAbsolutePath: loadResult.tsConfigPath,
			baseUrl: loadResult.baseUrl,
			absoluteBaseUrl: path$1.resolve(path$1.dirname(loadResult.tsConfigPath), loadResult.baseUrl || ""),
			paths: loadResult.paths || {},
			addMatchAll: loadResult.baseUrl !== void 0
		};
	}
	exports.configLoader = configLoader;
}));

//#endregion
//#region node_modules/minimist/index.js
var require_minimist = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	function hasKey(obj, keys) {
		var o = obj;
		keys.slice(0, -1).forEach(function(key) {
			o = o[key] || {};
		});
		return keys[keys.length - 1] in o;
	}
	function isNumber(x) {
		if (typeof x === "number") return true;
		if (/^0x[0-9a-f]+$/i.test(x)) return true;
		return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(e[-+]?\d+)?$/.test(x);
	}
	function isConstructorOrProto(obj, key) {
		return key === "constructor" && typeof obj[key] === "function" || key === "__proto__";
	}
	module.exports = function(args, opts) {
		if (!opts) opts = {};
		var flags = {
			bools: {},
			strings: {},
			unknownFn: null
		};
		if (typeof opts.unknown === "function") flags.unknownFn = opts.unknown;
		if (typeof opts.boolean === "boolean" && opts.boolean) flags.allBools = true;
		else [].concat(opts.boolean).filter(Boolean).forEach(function(key) {
			flags.bools[key] = true;
		});
		var aliases = {};
		function aliasIsBoolean(key) {
			return aliases[key].some(function(x) {
				return flags.bools[x];
			});
		}
		Object.keys(opts.alias || {}).forEach(function(key) {
			aliases[key] = [].concat(opts.alias[key]);
			aliases[key].forEach(function(x) {
				aliases[x] = [key].concat(aliases[key].filter(function(y) {
					return x !== y;
				}));
			});
		});
		[].concat(opts.string).filter(Boolean).forEach(function(key) {
			flags.strings[key] = true;
			if (aliases[key]) [].concat(aliases[key]).forEach(function(k) {
				flags.strings[k] = true;
			});
		});
		var defaults = opts.default || {};
		var argv = { _: [] };
		function argDefined(key, arg) {
			return flags.allBools && /^--[^=]+$/.test(arg) || flags.strings[key] || flags.bools[key] || aliases[key];
		}
		function setKey(obj, keys, value) {
			var o = obj;
			for (var i = 0; i < keys.length - 1; i++) {
				var key = keys[i];
				if (isConstructorOrProto(o, key)) return;
				if (o[key] === void 0) o[key] = {};
				if (o[key] === Object.prototype || o[key] === Number.prototype || o[key] === String.prototype) o[key] = {};
				if (o[key] === Array.prototype) o[key] = [];
				o = o[key];
			}
			var lastKey = keys[keys.length - 1];
			if (isConstructorOrProto(o, lastKey)) return;
			if (o === Object.prototype || o === Number.prototype || o === String.prototype) o = {};
			if (o === Array.prototype) o = [];
			if (o[lastKey] === void 0 || flags.bools[lastKey] || typeof o[lastKey] === "boolean") o[lastKey] = value;
			else if (Array.isArray(o[lastKey])) o[lastKey].push(value);
			else o[lastKey] = [o[lastKey], value];
		}
		function setArg(key, val, arg) {
			if (arg && flags.unknownFn && !argDefined(key, arg)) {
				if (flags.unknownFn(arg) === false) return;
			}
			var value = !flags.strings[key] && isNumber(val) ? Number(val) : val;
			setKey(argv, key.split("."), value);
			(aliases[key] || []).forEach(function(x) {
				setKey(argv, x.split("."), value);
			});
		}
		Object.keys(flags.bools).forEach(function(key) {
			setArg(key, defaults[key] === void 0 ? false : defaults[key]);
		});
		var notFlags = [];
		if (args.indexOf("--") !== -1) {
			notFlags = args.slice(args.indexOf("--") + 1);
			args = args.slice(0, args.indexOf("--"));
		}
		for (var i = 0; i < args.length; i++) {
			var arg = args[i];
			var key;
			var next;
			if (/^--.+=/.test(arg)) {
				var m = arg.match(/^--([^=]+)=([\s\S]*)$/);
				key = m[1];
				var value = m[2];
				if (flags.bools[key]) value = value !== "false";
				setArg(key, value, arg);
			} else if (/^--no-.+/.test(arg)) {
				key = arg.match(/^--no-(.+)/)[1];
				setArg(key, false, arg);
			} else if (/^--.+/.test(arg)) {
				key = arg.match(/^--(.+)/)[1];
				next = args[i + 1];
				if (next !== void 0 && !/^(-|--)[^-]/.test(next) && !flags.bools[key] && !flags.allBools && (aliases[key] ? !aliasIsBoolean(key) : true)) {
					setArg(key, next, arg);
					i += 1;
				} else if (/^(true|false)$/.test(next)) {
					setArg(key, next === "true", arg);
					i += 1;
				} else setArg(key, flags.strings[key] ? "" : true, arg);
			} else if (/^-[^-]+/.test(arg)) {
				var letters = arg.slice(1, -1).split("");
				var broken = false;
				for (var j = 0; j < letters.length; j++) {
					next = arg.slice(j + 2);
					if (next === "-") {
						setArg(letters[j], next, arg);
						continue;
					}
					if (/[A-Za-z]/.test(letters[j]) && next[0] === "=") {
						setArg(letters[j], next.slice(1), arg);
						broken = true;
						break;
					}
					if (/[A-Za-z]/.test(letters[j]) && /-?\d+(\.\d*)?(e-?\d+)?$/.test(next)) {
						setArg(letters[j], next, arg);
						broken = true;
						break;
					}
					if (letters[j + 1] && letters[j + 1].match(/\W/)) {
						setArg(letters[j], arg.slice(j + 2), arg);
						broken = true;
						break;
					} else setArg(letters[j], flags.strings[letters[j]] ? "" : true, arg);
				}
				key = arg.slice(-1)[0];
				if (!broken && key !== "-") if (args[i + 1] && !/^(-|--)[^-]/.test(args[i + 1]) && !flags.bools[key] && (aliases[key] ? !aliasIsBoolean(key) : true)) {
					setArg(key, args[i + 1], arg);
					i += 1;
				} else if (args[i + 1] && /^(true|false)$/.test(args[i + 1])) {
					setArg(key, args[i + 1] === "true", arg);
					i += 1;
				} else setArg(key, flags.strings[key] ? "" : true, arg);
			} else {
				if (!flags.unknownFn || flags.unknownFn(arg) !== false) argv._.push(flags.strings._ || !isNumber(arg) ? arg : Number(arg));
				if (opts.stopEarly) {
					argv._.push.apply(argv._, args.slice(i + 1));
					break;
				}
			}
		}
		Object.keys(defaults).forEach(function(k) {
			if (!hasKey(argv, k.split("."))) {
				setKey(argv, k.split("."), defaults[k]);
				(aliases[k] || []).forEach(function(x) {
					setKey(argv, x.split("."), defaults[k]);
				});
			}
		});
		if (opts["--"]) argv["--"] = notFlags.slice();
		else notFlags.forEach(function(k) {
			argv._.push(k);
		});
		return argv;
	};
}));

//#endregion
//#region node_modules/tsconfig-paths/lib/register.js
var require_register = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __spreadArray = exports && exports.__spreadArray || function(to, from, pack) {
		if (pack || arguments.length === 2) {
			for (var i = 0, l = from.length, ar; i < l; i++) if (ar || !(i in from)) {
				if (!ar) ar = Array.prototype.slice.call(from, 0, i);
				ar[i] = from[i];
			}
		}
		return to.concat(ar || Array.prototype.slice.call(from));
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.register = void 0;
	var match_path_sync_1 = require_match_path_sync();
	var config_loader_1 = require_config_loader();
	var noOp = function() {};
	function getCoreModules(builtinModules) {
		builtinModules = builtinModules || [
			"assert",
			"buffer",
			"child_process",
			"cluster",
			"crypto",
			"dgram",
			"dns",
			"domain",
			"events",
			"fs",
			"http",
			"https",
			"net",
			"os",
			"path",
			"punycode",
			"querystring",
			"readline",
			"stream",
			"string_decoder",
			"tls",
			"tty",
			"url",
			"util",
			"v8",
			"vm",
			"zlib"
		];
		var coreModules = {};
		for (var _i = 0, builtinModules_1 = builtinModules; _i < builtinModules_1.length; _i++) {
			var module_1 = builtinModules_1[_i];
			coreModules[module_1] = true;
		}
		return coreModules;
	}
	/**
	* Installs a custom module load function that can adhere to paths in tsconfig.
	* Returns a function to undo paths registration.
	*/
	function register(params) {
		var cwd;
		var explicitParams;
		if (params) {
			cwd = params.cwd;
			if (params.baseUrl || params.paths) explicitParams = params;
		} else cwd = require_minimist()(process.argv.slice(2), {
			string: ["project"],
			alias: { project: ["P"] }
		}).project;
		var configLoaderResult = (0, config_loader_1.configLoader)({
			cwd: cwd !== null && cwd !== void 0 ? cwd : process.cwd(),
			explicitParams
		});
		if (configLoaderResult.resultType === "failed") {
			console.warn("".concat(configLoaderResult.message, ". tsconfig-paths will be skipped"));
			return noOp;
		}
		var matchPath = (0, match_path_sync_1.createMatchPath)(configLoaderResult.absoluteBaseUrl, configLoaderResult.paths, configLoaderResult.mainFields, configLoaderResult.addMatchAll);
		var Module = __require("module");
		var originalResolveFilename = Module._resolveFilename;
		var coreModules = getCoreModules(Module.builtinModules);
		Module._resolveFilename = function(request, _parent) {
			if (!coreModules.hasOwnProperty(request)) {
				var found = matchPath(request);
				if (found) {
					var modifiedArguments = __spreadArray([found], [].slice.call(arguments, 1), true);
					return originalResolveFilename.apply(this, modifiedArguments);
				}
			}
			return originalResolveFilename.apply(this, arguments);
		};
		return function() {
			Module._resolveFilename = originalResolveFilename;
		};
	}
	exports.register = register;
}));

//#endregion
//#region node_modules/tsconfig-paths/lib/index.js
var require_lib = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.loadConfig = exports.register = exports.matchFromAbsolutePathsAsync = exports.createMatchPathAsync = exports.matchFromAbsolutePaths = exports.createMatchPath = void 0;
	var match_path_sync_1 = require_match_path_sync();
	Object.defineProperty(exports, "createMatchPath", {
		enumerable: true,
		get: function() {
			return match_path_sync_1.createMatchPath;
		}
	});
	Object.defineProperty(exports, "matchFromAbsolutePaths", {
		enumerable: true,
		get: function() {
			return match_path_sync_1.matchFromAbsolutePaths;
		}
	});
	var match_path_async_1 = require_match_path_async();
	Object.defineProperty(exports, "createMatchPathAsync", {
		enumerable: true,
		get: function() {
			return match_path_async_1.createMatchPathAsync;
		}
	});
	Object.defineProperty(exports, "matchFromAbsolutePathsAsync", {
		enumerable: true,
		get: function() {
			return match_path_async_1.matchFromAbsolutePathsAsync;
		}
	});
	var register_1 = require_register();
	Object.defineProperty(exports, "register", {
		enumerable: true,
		get: function() {
			return register_1.register;
		}
	});
	var config_loader_1 = require_config_loader();
	Object.defineProperty(exports, "loadConfig", {
		enumerable: true,
		get: function() {
			return config_loader_1.loadConfig;
		}
	});
}));

//#endregion
//#region src/core/scanner.ts
var import_ignore = /* @__PURE__ */ __toESM(require_ignore(), 1);
var import_lib = require_lib();
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
	const ig = (0, import_ignore.default)();
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
				ig: (0, import_ignore.default)().add(localContent)
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
			const configLoaderResult = (0, import_lib.loadConfig)(rootDir);
			const matchPath = configLoaderResult.resultType === "success" ? (0, import_lib.createMatchPath)(configLoaderResult.absoluteBaseUrl, configLoaderResult.paths) : null;
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