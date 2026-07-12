import { DatabaseSync, StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface FileRecord {
  path: string;
  parsed: boolean;
  reason?: string | null;
  hash?: string | null;
  exports: string[];
  imports: string[];
  summary?: string | null;
  summary_hash?: string | null;
  mtime?: number | null;
  size?: number | null;
}

export interface GraphNode extends FileRecord {
  rank: number;
}

export class SpelunkDB {
  private db: DatabaseSync;
  private upsertStmt: StatementSync;
  private getFileStmt: StatementSync;
  private getAllFilesStmt: StatementSync;
  private searchStmt: StatementSync;
  private searchCountStmt: StatementSync;
  private deleteStmt: StatementSync;
  private depsOutStmt: StatementSync;
  private depsOutCountStmt: StatementSync;
  private depsInStmt: StatementSync;
  private depsInCountStmt: StatementSync;
  private deleteExportsStmt: StatementSync;
  private insertExportStmt: StatementSync;
  private deleteRawImportsStmt: StatementSync;
  private insertRawImportStmt: StatementSync;
  private getMetadataStmt: StatementSync;
  private setMetadataStmt: StatementSync;
  private getAllPathsStmt: StatementSync;

  constructor(dbPath: string = ".spelunk/data.db") {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      this.db = new DatabaseSync(dbPath);
    } catch (err: any) {
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
    this.insertExportStmt = this.db.prepare(
      "INSERT INTO file_exports (file_path, name) VALUES (?, ?);",
    );
    this.deleteRawImportsStmt = this.db.prepare(
      "DELETE FROM file_raw_imports WHERE file_path = ?;",
    );
    this.insertRawImportStmt = this.db.prepare(
      "INSERT INTO file_raw_imports (file_path, name) VALUES (?, ?);",
    );
    this.getMetadataStmt = this.db.prepare("SELECT value FROM metadata WHERE key = ?;");
    this.setMetadataStmt = this.db.prepare(
      "INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
    );
    this.getAllPathsStmt = this.db.prepare("SELECT path FROM files;");
  }

  private init() {
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
    } catch (err: any) {
      console.warn(`Failed to backfill FTS table: ${err.message}`);
    }

    try {
      const countExports = (
        this.db.prepare("SELECT COUNT(*) as count FROM file_exports;").get() as any
      ).count;
      const countFiles = (this.db.prepare("SELECT COUNT(*) as count FROM files;").get() as any)
        .count;
      if (countExports === 0 && countFiles > 0) {
        this.db.exec(`
          INSERT INTO file_exports (file_path, name)
          SELECT files.path, value FROM files, json_each(exports);

          INSERT INTO file_raw_imports (file_path, name)
          SELECT files.path, value FROM files, json_each(imports);
        `);
      }
    } catch (err: any) {
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
  private withTransaction<T>(callback: () => T): T {
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
  setMetadata(key: string, value: string) {
    this.setMetadataStmt.run(key, value);
  }

  /**
   * Retrieves a configuration setting from the metadata table.
   *
   * @param key The setting identifier.
   * @returns The value string, or null if key does not exist.
   */
  getMetadata(key: string): string | null {
    const row = this.getMetadataStmt.get(key) as any;
    return row ? row.value : null;
  }

  /**
   * Inserts or updates a single file record and updates its import/export lookup relations.
   *
   * @param record The file record properties.
   */
  upsertFile(record: FileRecord) {
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
        $size: record.size ?? null,
      });
      this.deleteExportsStmt.run(record.path);
      for (const exp of record.exports) {
        this.insertExportStmt.run(record.path, exp);
      }
      this.deleteRawImportsStmt.run(record.path);
      for (const imp of record.imports) {
        this.insertRawImportStmt.run(record.path, imp);
      }
    });
  }

  /**
   * Batch inserts or updates file records and updates import/export lookup relations.
   *
   * @param records The array of file records.
   */
  upsertFiles(records: FileRecord[]) {
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
          $size: record.size ?? null,
        });
        this.deleteExportsStmt.run(record.path);
        for (const exp of record.exports) {
          this.insertExportStmt.run(record.path, exp);
        }
        this.deleteRawImportsStmt.run(record.path);
        for (const imp of record.imports) {
          this.insertRawImportStmt.run(record.path, imp);
        }
      }
    });
  }

  /**
   * Deletes a list of files from the database by path.
   *
   * @param paths The relative paths of files to delete.
   */
  deleteFiles(paths: string[]) {
    if (paths.length === 0) return;
    this.withTransaction(() => {
      for (const p of paths) {
        this.deleteStmt.run(p);
      }
    });
  }

  /**
   * Normalises an internal SQLite row representation back into a FileRecord object.
   *
   * @param row The raw database row properties.
   * @returns Normalized FileRecord object.
   */
  private mapRow(row: any): FileRecord {
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
      size: row.size,
    };
  }

  /**
   * Retrieves a file record from the database by normalized relative path.
   *
   * @param filePath The normalized relative path.
   * @returns FileRecord object or null if not found.
   */
  getFile(filePath: string): FileRecord | null {
    const row = this.getFileStmt.get(filePath) as any;
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Retrieves all file records stored in the database.
   *
   * @returns Array of FileRecord objects.
   */
  getAllFiles(): FileRecord[] {
    const rows = this.getAllFilesStmt.all() as any[];
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Fast lookup of only file paths registered in the database, avoiding metadata deserialisation.
   *
   * @returns Array of relative file paths.
   */
  getAllPaths(): string[] {
    const rows = this.getAllPathsStmt.all() as any[];
    return rows.map((row) => row.path);
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
  search(
    query: string,
    limit: number = 50,
    offset: number = 0,
  ): { items: FileRecord[]; total_count: number; has_more: boolean } {
    let sanitized = query.replace(/"/g, '""');
    sanitized = sanitized.replace(/[*:+&|()-]/g, " ").trim();
    const ftsQuery = sanitized ? `"${sanitized}"` : `""`;
    const likeQuery = `%${query}%`;

    const commonParams = {
      $rawQuery: query,
      $ftsQuery: ftsQuery,
      $likeQuery: likeQuery,
    };

    const rows = this.searchStmt.all({
      ...commonParams,
      $limit: limit,
      $offset: offset,
    }) as any[];
    const items = rows.map((row) => this.mapRow(row));

    const countRow = this.searchCountStmt.get(commonParams) as any;
    const total_count = countRow ? countRow.count : 0;
    const has_more = offset + limit < total_count;

    return { items, total_count, has_more };
  }

  /**
   * Wipes existing resolved dependency edges and performs bulk inserts of normalized targets.
   *
   * @param importsList Flat array of import link objects.
   */
  clearAndInsertImports(importsList: { file_path: string; imported_path: string }[]) {
    this.withTransaction(() => {
      this.db.exec("DELETE FROM file_imports;");
      const stmt = this.db.prepare(`
        INSERT INTO file_imports (file_path, imported_path)
        VALUES (?, ?);
      `);
      for (const item of importsList) {
        stmt.run(item.file_path, item.imported_path);
      }
    });
  }

  /**
   * Updates resolved import links for specified files incrementally.
   *
   * @param importsMap Map of relative file paths to their resolved relative import paths.
   */
  updateFilesImports(importsMap: Map<string, string[]>) {
    this.withTransaction(() => {
      const delStmt = this.db.prepare("DELETE FROM file_imports WHERE file_path = ?;");
      const insStmt = this.db.prepare(
        "INSERT INTO file_imports (file_path, imported_path) VALUES (?, ?);",
      );
      for (const [filePath, importedPaths] of importsMap.entries()) {
        delStmt.run(filePath);
        for (const imp of importedPaths) {
          insStmt.run(filePath, imp);
        }
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
  getDependencies(
    targetPath: string,
    direction: "in" | "out",
    maxDepth: number,
    limit: number,
    offset: number,
  ): { items: GraphNode[]; total_count: number; has_more: boolean } {
    const stmt = direction === "out" ? this.depsOutStmt : this.depsInStmt;
    const countStmt = direction === "out" ? this.depsOutCountStmt : this.depsInCountStmt;

    const commonParams = {
      $target: targetPath,
      $maxDepth: maxDepth,
    };

    const countRow = countStmt.get(commonParams) as any;
    const total_count = countRow ? countRow.count : 0;

    const rows = stmt.all({
      ...commonParams,
      $limit: limit,
      $offset: offset,
    }) as any[];

    const has_more = offset + limit < total_count;

    const items = rows.map((row) => ({
      ...this.mapRow(row),
      rank: row.rank,
    }));

    return { items, total_count, has_more };
  }

  /**
   * Closes the SQLite database sync handle.
   */
  close() {
    this.db.close();
  }
}
