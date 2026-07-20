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
  private searchFtsStmt: StatementSync;
  private searchFtsCountStmt: StatementSync;
  private searchLikeStmt: StatementSync;
  private searchLikeCountStmt: StatementSync;
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
  private deleteFileImportsStmt: StatementSync;
  private insertFileImportStmt: StatementSync;
  private getAllFilesWithoutSummaryStmt: StatementSync;

  constructor(dbPath: string = ".spelunk/data.db") {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });

    try {
      this.db = new DatabaseSync(dbPath);
    } catch (err: any) {
      console.warn(`[spelunk] Failed to open database at ${dbPath}: ${err.message}. Recreating...`);
      try {
        fs.unlinkSync(dbPath);
      } catch {}
      this.db = new DatabaseSync(dbPath);
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
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
    this.searchFtsStmt = this.db.prepare(`
      SELECT path, parsed, reason, hash, exports, imports, summary, summary_hash, mtime, size
      FROM files
      WHERE path IN (SELECT path FROM files_fts WHERE files_fts MATCH $ftsQuery)
      LIMIT $limit OFFSET $offset;
    `);
    this.searchFtsCountStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM files
      WHERE path IN (SELECT path FROM files_fts WHERE files_fts MATCH $ftsQuery);
    `);
    this.searchLikeStmt = this.db.prepare(`
      SELECT path, parsed, reason, hash, exports, imports, summary, summary_hash, mtime, size
      FROM files
      WHERE path LIKE $likeQuery 
         OR EXISTS (SELECT 1 FROM file_exports WHERE file_path = files.path AND name LIKE $likeQuery)
         OR EXISTS (SELECT 1 FROM file_raw_imports WHERE file_path = files.path AND name LIKE $likeQuery)
      LIMIT $limit OFFSET $offset;
    `);
    this.searchLikeCountStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM files
      WHERE path LIKE $likeQuery 
         OR EXISTS (SELECT 1 FROM file_exports WHERE file_path = files.path AND name LIKE $likeQuery)
         OR EXISTS (SELECT 1 FROM file_raw_imports WHERE file_path = files.path AND name LIKE $likeQuery);
    `);
    this.deleteStmt = this.db.prepare(`
      DELETE FROM files WHERE path = ?;
    `);
    this.depsOutStmt = this.db.prepare(`
      WITH RECURSIVE dependency_chain(path, depth, path_str) AS (
        SELECT imported_path, 1, ',' || imported_path || ','
        FROM file_imports
        WHERE file_path = $target
        
        UNION
        
        SELECT i.imported_path, dc.depth + 1, dc.path_str || i.imported_path || ','
        FROM file_imports i
        JOIN dependency_chain dc ON i.file_path = dc.path
        WHERE dc.depth < $maxDepth AND instr(dc.path_str, ',' || i.imported_path || ',') = 0
      )
      SELECT f.path, f.parsed, f.reason, f.hash, f.exports, f.imports, f.summary, f.summary_hash, f.mtime, f.size, MIN(dc.depth) as rank
      FROM dependency_chain dc
      JOIN files f ON f.path = dc.path
      GROUP BY f.path
      ORDER BY rank ASC
      LIMIT $limit OFFSET $offset;
    `);
    this.depsOutCountStmt = this.db.prepare(`
      WITH RECURSIVE dependency_chain(path, depth, path_str) AS (
        SELECT imported_path, 1, ',' || imported_path || ','
        FROM file_imports
        WHERE file_path = $target
        
        UNION
        
        SELECT i.imported_path, dc.depth + 1, dc.path_str || i.imported_path || ','
        FROM file_imports i
        JOIN dependency_chain dc ON i.file_path = dc.path
        WHERE dc.depth < $maxDepth AND instr(dc.path_str, ',' || i.imported_path || ',') = 0
      )
      SELECT COUNT(DISTINCT path) as count FROM dependency_chain;
    `);
    this.depsInStmt = this.db.prepare(`
      WITH RECURSIVE dependency_chain(path, depth, path_str) AS (
        SELECT file_path, 1, ',' || file_path || ','
        FROM file_imports
        WHERE imported_path = $target
        
        UNION
        
        SELECT i.file_path, dc.depth + 1, dc.path_str || i.file_path || ','
        FROM file_imports i
        JOIN dependency_chain dc ON i.imported_path = dc.path
        WHERE dc.depth < $maxDepth AND instr(dc.path_str, ',' || i.file_path || ',') = 0
      )
      SELECT f.path, f.parsed, f.reason, f.hash, f.exports, f.imports, f.summary, f.summary_hash, f.mtime, f.size, MIN(dc.depth) as rank
      FROM dependency_chain dc
      JOIN files f ON f.path = dc.path
      GROUP BY f.path
      ORDER BY rank ASC
      LIMIT $limit OFFSET $offset;
    `);
    this.depsInCountStmt = this.db.prepare(`
      WITH RECURSIVE dependency_chain(path, depth, path_str) AS (
        SELECT file_path, 1, ',' || file_path || ','
        FROM file_imports
        WHERE imported_path = $target
        
        UNION
        
        SELECT i.file_path, dc.depth + 1, dc.path_str || i.file_path || ','
        FROM file_imports i
        JOIN dependency_chain dc ON i.imported_path = dc.path
        WHERE dc.depth < $maxDepth AND instr(dc.path_str, ',' || i.file_path || ',') = 0
      )
      SELECT COUNT(DISTINCT path) as count FROM dependency_chain;
    `);
    this.deleteExportsStmt = this.db.prepare("DELETE FROM file_exports WHERE file_path = ?;");
    this.insertExportStmt = this.db.prepare(
      "INSERT OR IGNORE INTO file_exports (file_path, name) VALUES (?, ?);",
    );
    this.deleteRawImportsStmt = this.db.prepare(
      "DELETE FROM file_raw_imports WHERE file_path = ?;",
    );
    this.insertRawImportStmt = this.db.prepare(
      "INSERT OR IGNORE INTO file_raw_imports (file_path, name) VALUES (?, ?);",
    );
    this.getMetadataStmt = this.db.prepare("SELECT value FROM metadata WHERE key = ?;");
    this.setMetadataStmt = this.db.prepare(
      "INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
    );
    this.getAllPathsStmt = this.db.prepare("SELECT path FROM files;");
    this.deleteFileImportsStmt = this.db.prepare("DELETE FROM file_imports WHERE file_path = ?;");
    this.insertFileImportStmt = this.db.prepare(
      "INSERT OR IGNORE INTO file_imports (file_path, imported_path) VALUES (?, ?);",
    );
    this.getAllFilesWithoutSummaryStmt = this.db.prepare(
      "SELECT path, parsed, reason, hash, exports, imports, mtime, size FROM files;",
    );
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
        PRIMARY KEY(file_path, imported_path),
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_file_imports_imported_path ON file_imports(imported_path);

      CREATE TABLE IF NOT EXISTS file_exports (
        file_path TEXT,
        name TEXT,
        PRIMARY KEY(file_path, name),
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_file_exports_name ON file_exports(name);

      CREATE TABLE IF NOT EXISTS file_raw_imports (
        file_path TEXT,
        name TEXT,
        PRIMARY KEY(file_path, name),
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
      ) WITHOUT ROWID;
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
  }

  /** Runs callback inside a SQLite transaction block. */
  private withTransaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const res = callback();
      this.db.exec("COMMIT");
      return res;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }

  /** Sets a key-value setting in the metadata table. */
  setMetadata(key: string, value: string) {
    this.setMetadataStmt.run(key, value);
  }

  /** Gets a metadata setting value by key. */
  getMetadata(key: string): string | null {
    const row = this.getMetadataStmt.get(key) as any;
    return row ? row.value : null;
  }

  /** Inserts or updates multiple file records and their import/export links. */
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

  /** Deletes files from the database by path. */
  deleteFiles(paths: string[]) {
    if (paths.length === 0) return;
    this.withTransaction(() => {
      for (const p of paths) {
        this.deleteStmt.run(p);
      }
    });
  }

  /** Converts a database row to a FileRecord object. */
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

  /** Gets a file record by relative path. */
  getFile(filePath: string): FileRecord | null {
    const row = this.getFileStmt.get(filePath) as any;
    if (!row) return null;
    return this.mapRow(row);
  }

  /** Returns all file records in the database. */
  getAllFiles(includeSummary = true): FileRecord[] {
    const stmt = includeSummary ? this.getAllFilesStmt : this.getAllFilesWithoutSummaryStmt;
    const rows = stmt.all() as any[];
    return rows.map((row) => this.mapRow(row));
  }

  /** Returns all stored file paths. */
  getAllPaths(): string[] {
    const rows = this.getAllPathsStmt.all() as any[];
    return rows.map((row) => row.path);
  }

  /** Searches indexed files and symbols using FTS or LIKE matching. */
  search(
    query: string,
    limit: number = 50,
    offset: number = 0,
  ): { items: FileRecord[]; total_count: number; has_more: boolean } {
    const isFts = query.length >= 3;
    let sanitized = query.replace(/"/g, '""');
    sanitized = sanitized.replace(/[*:+&|()-]/g, " ").trim();
    const tokens = sanitized.split(/\s+/).filter(Boolean);
    const escapedTokens = tokens.map((t) => {
      const upper = t.toUpperCase();
      if (
        upper === "AND" ||
        upper === "OR" ||
        upper === "NOT" ||
        upper === "NEAR" ||
        t.includes("{") ||
        t.includes("}")
      ) {
        return `"${t}"`;
      }
      return t;
    });
    const ftsQuery = escapedTokens.length > 0 ? escapedTokens.join(" ") : `""`;
    const likeQuery = `%${query}%`;

    let rows: any[];
    let total_count = 0;

    if (isFts) {
      rows = this.searchFtsStmt.all({
        $ftsQuery: ftsQuery,
        $limit: limit,
        $offset: offset,
      }) as any[];
      const countRow = this.searchFtsCountStmt.get({ $ftsQuery: ftsQuery }) as any;
      total_count = countRow ? countRow.count : 0;
    } else {
      rows = this.searchLikeStmt.all({
        $likeQuery: likeQuery,
        $limit: limit,
        $offset: offset,
      }) as any[];
      const countRow = this.searchLikeCountStmt.get({ $likeQuery: likeQuery }) as any;
      total_count = countRow ? countRow.count : 0;
    }

    const items = rows.map((row) => this.mapRow(row));
    const has_more = offset + limit < total_count;

    return { items, total_count, has_more };
  }

  /** Updates import links for specific files. */
  updateFilesImports(importsMap: Map<string, string[]>) {
    this.withTransaction(() => {
      for (const [filePath, importedPaths] of importsMap.entries()) {
        this.deleteFileImportsStmt.run(filePath);
        for (const imp of importedPaths) {
          this.insertFileImportStmt.run(filePath, imp);
        }
      }
    });
  }

  /** Removes import links that point to files no longer in the database. */
  pruneStaleImports() {
    this.db.exec("DELETE FROM file_imports WHERE imported_path NOT IN (SELECT path FROM files);");
  }

  /** Traces recursive incoming or outgoing dependencies for a file. */
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

  /** Closes the database connection. */
  close() {
    this.db.close();
  }
}
