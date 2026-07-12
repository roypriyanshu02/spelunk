# Database schema

Spelunk indexes codebase metadata into a single SQLite database (`.spelunk/data.db`). Here is the schema layout, parser limits, and direct query examples.

## SQLite database layout

Spelunk configures SQLite to support concurrent operations and atomic batches:

- **Write-Ahead Logging (`journal_mode = WAL`):** Enables simultaneous reads and writes. This creates temporary `.spelunk/data.db-wal` and `.spelunk/data.db-shm` files next to the database.
- **Synchronous Writes (`synchronous = NORMAL`):** Optimizes disk write speed while maintaining safety.
- **Foreign Keys Enabled (`foreign_keys = ON`):** Enforces relational constraints.

---

### Tables and columns

The database contains five tables:

#### 1. The `files` Table

Holds primary index records for each file in the workspace.

| Column Name    | SQLite Type          | Description                                                                    |
| :------------- | :------------------- | :----------------------------------------------------------------------------- |
| `path`         | `TEXT` (Primary Key) | Repository-relative file path. Always uses forward slashes (`/`).              |
| `parsed`       | `INTEGER` (Boolean)  | `1` if successfully parsed, `0` if skipped.                                    |
| `reason`       | `TEXT` (Nullable)    | Skip reason (e.g., `"exceeds size limit"`, `"symlink loop"`, `"binary file"`). |
| `hash`         | `TEXT` (Nullable)    | SHA-256 hash of the file contents. Used for incremental updates.               |
| `exports`      | `TEXT` (JSON array)  | JSON array of exported symbols like classes, functions, and interfaces.        |
| `imports`      | `TEXT` (JSON array)  | JSON array of imported paths, symbols, or dependencies.                        |
| `summary`      | `TEXT` (Nullable)    | Brief explanation of the file structure.                                       |
| `summary_hash` | `TEXT` (Nullable)    | Content hash used for cached summary checks.                                   |
| `mtime`        | `INTEGER`            | File modification time in milliseconds.                                        |
| `size`         | `INTEGER`            | File size in bytes.                                                            |

#### 2. The `file_imports` Table

Maps dependency links for tracing import trees.

- `file_path` (`TEXT`): Source file path. References `files.path` with cascade delete.
- `imported_path` (`TEXT`): Resolved dependency file path.
- _Indices:_ `idx_file_imports_file_path`, `idx_file_imports_imported_path`

#### 3. The `file_exports` Table

Indexes exported symbol names for fast LIKE searches.

- `file_path` (`TEXT`): File declaring the export. References `files.path` with cascade delete.
- `name` (`TEXT`): Exported symbol name.
- _Indices:_ `idx_file_exports_file_path`, `idx_file_exports_name`

#### 4. The `file_raw_imports` Table

Indexes raw import names for quick lookup.

- `file_path` (`TEXT`): File declaring the import. References `files.path` with cascade delete.
- `name` (`TEXT`): Raw dependency string.
- _Indices:_ `idx_file_raw_imports_file_path`, `idx_file_raw_imports_name`

#### 5. The `metadata` Table

Stores run environment settings.

- `key` (`TEXT` Primary Key): Configuration key (e.g., `rootDir`, `scanStatus`).
- `value` (`TEXT`): Key value.

---

### Virtual tables and triggers

#### `files_fts` Table

An FTS5 trigram virtual table mapped to the `files` table for fast fuzzy searches.

- **Fields:** `path`, `exports`, `imports`

Three triggers keep the virtual table in sync automatically:

- **`files_ai`** (After Insert): Adds new files to the index.
- **`files_ad`** (After Delete): Removes deleted files.
- **`files_au`** (After Update): Updates matching entries.

---

### Parser limits

- **File size:** Spelunk skips files larger than **1MB** (`1024 * 1024` bytes) and sets `reason = "exceeds size limit"`.
- **File count:** Indexes up to **50,000** files per run.
- **Depth:** Directory scanning stops at a depth of **100** folders to prevent symlink loops.
- **Binary check:** Files with null bytes (`\0`) are marked as `"binary file"`.

## JSON output schema

Spelunk query commands return JSON payloads matching the schema in [codemap.v1.json](codemap.v1.json). Tool outputs like `find` and `deps` include pagination metadata:

```json
{
  "files": [
    {
      "path": "lib/db.ts",
      "parsed": true,
      "hash": "4a7b...",
      "exports": ["FileRecord", "SpelunkDB"],
      "imports": ["node:sqlite"],
      "summary": "Manages SQLite initialization and database queries.",
      "summary_hash": "4a7b...",
      "mtime": 1721160000000,
      "size": 19719
    }
  ],
  "limit": 50,
  "offset": 0,
  "total_count": 1,
  "has_more": false
}
```

Detailed output formats for tools are in [contracts.md](contracts.md).

## Direct database queries

Query the database file directly if built-in tools do not fit your workflow.

### Examples

#### Find unparsed files and skip reasons:

```bash
sqlite3 .spelunk/data.db "SELECT path, reason FROM files WHERE parsed = 0;"
```

#### Find files importing a specific module:

```bash
sqlite3 .spelunk/data.db "SELECT file_path FROM file_imports WHERE imported_path = 'src/services/db.ts';"
```

#### Find files exporting a specific symbol:

```bash
sqlite3 .spelunk/data.db "SELECT path FROM files, json_each(exports) WHERE json_each.value = 'SpelunkDB';"
```

#### Fuzzy search using trigram index (FTS5):

```bash
sqlite3 .spelunk/data.db "SELECT path FROM files_fts WHERE exports MATCH 'Spelunk';"
```

#### Find files missing an AI summary:

```bash
sqlite3 .spelunk/data.db "SELECT path FROM files WHERE parsed = 1 AND (summary IS NULL OR summary = '');"
```
