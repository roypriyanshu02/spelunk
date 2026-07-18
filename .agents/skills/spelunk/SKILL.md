---
name: spelunk
description: AST-powered codebase indexer. Caches imports, exports, symbols, and dependencies in SQLite. Use this skill to trace dependency trees, locate symbol definitions, outline files, and map codebase architecture. Trigger it whenever the user asks about codebase structure, file dependencies, import/export outlines, or where classes, functions, or symbols are defined, even if they do not mention Spelunk. Exclude small repositories (<15 files) or simple text grep searches.
---

# Spelunk

Spelunk parses repositories into a local SQLite database using Tree-sitter. Querying the index replaces slow file scans and minimizes token usage.

## Guidelines for AI Agents

1. **Initialize the Index:** Check for `.spelunk/data.db` before querying. Run `node <skill-path>/scripts/scan.mjs` if the database is missing or empty. Querying a missing index returns empty arrays. Scan the workspace first.
2. **Keep the Index Fresh:** Scan the codebase after modifying files. The scanner parses only changed files, keeping indexing fast.
3. **Trace Dependency Trees:** Use `node <skill-path>/scripts/deps.mjs` to trace import chains. Do not read files line-by-line. The script resolves imports down the tree.
4. **Locate Symbols:** Run `node <skill-path>/scripts/find.mjs` with a symbol name to locate its definition. This avoids slow text searches.
5. **Fuzzy & Trigram Search:** If exact symbol resolution fails, query the `files_fts` virtual table using custom SQL to execute trigram searches across paths, exports, and imports.
6. **Cache Structural Summaries:** Write file summaries to the index using `explain.mjs` with `--set-summary`. This caches architecture context, avoiding the need to read large files in subsequent prompts.
7. **Verify Refactors:** Run `diff.mjs` to compare two versions of a file. Use this after modifying imports or exports to prevent breaking downstream dependencies.
8. **Query SQLite Directly:** Execute custom SQL queries on `.spelunk/data.db` if built-in scripts do not fit the task. Direct access gives full flexibility over the schema.
9. **Handle Errors:** If a query fails, verify the file exists on disk. Rebuild the index with `scan.mjs`. Fall back to standard grep searches if needed.
10. **Resolve Skill Path:** Identify the directory containing this `SKILL.md` file. In instructions below, `<skill-path>` refers to the absolute path of this directory.
11. **Batch Queries for Efficiency:** When performing multiple sequential symbol or dependency lookups, query the SQLite database directly using `sqlite3` rather than spawning multiple Node scripts. This bypasses V8 process startup overhead.

## Setup & Running the Scripts

Run scripts from the workspace root using Node.js (>= 24.18.0). Replace `<skill-path>` with the resolved path to the skill directory (e.g. `skills/spelunk`). Every command accepts standard flags or their positional equivalents in order. When `--dir` is omitted, it defaults to the current working directory.

- **Scan Codebase:** `node <skill-path>/scripts/scan.mjs [--dir <dir>] [--concurrency <number>]`
- **Find Symbol/File:** `node <skill-path>/scripts/find.mjs --query <query> [--limit <limit>] [--offset <offset>] [--format json|markdown]`
- **Outline File:** `node <skill-path>/scripts/outline.mjs --file <filepath> [--format json|markdown]`
- **Trace Dependencies:** `node <skill-path>/scripts/deps.mjs --file <filepath> --direction <in|out> [--depth <depth>] [--limit <limit>] [--offset <offset>] [--format json|markdown]`
- **Explain File:** `node <skill-path>/scripts/explain.mjs --file <filepath> [--set-summary "<text>"]`
- **Export Codemap:** `node <skill-path>/scripts/export.mjs [--format json|md|markdown]`
- **Structural Diff:** `node <skill-path>/scripts/diff.mjs --file-a <fileA> --file-b <fileB> [--format json|markdown]`

> [!IMPORTANT]
> **Network Requirement**: The indexer requires internet access on the first run to download WASM grammars to `~/.cache/spelunk/wasm/`. If offline, parsing falls back to regex extraction.

> [!NOTE]
> **Bundled Helper**: The compiler bundles helper functions into [common.mjs](scripts/common.mjs) for faster loading. In the source repository, you can inspect details in `src/`.

> [!NOTE]
> **Summarizing Files**: To store or update a file summary, run `explain.mjs` with `--file <filepath>` and `--set-summary "<text>"`. To read a cached summary, run `explain.mjs --file <filepath>` without `--set-summary`.

## Database Schema & Custom SQL

The SQLite database contains these tables:

### 1. `files` Table

Stores primary index records for each file in the workspace.

- `path` (TEXT, Primary Key): Workspace-relative path with forward slashes.
- `parsed` (INTEGER): `1` if parsed, `0` if skipped.
- `reason` (TEXT): Skip reason if not parsed.
- `hash` (TEXT): Content verification hash (SHA-256).
- `exports` (TEXT): JSON array of exported symbols.
- `imports` (TEXT): JSON array of dependency strings.
- `summary` (TEXT): Optional AI summary.
- `summary_hash` (TEXT): Content hash for stale checks.
- `mtime` (INTEGER): Modification time in milliseconds.
- `size` (INTEGER): File size in bytes.

### 2. `file_imports` Table

Stores resolved dependency links for fast recursive import graph traversals.

- `file_path` (TEXT): The source file path.
- `imported_path` (TEXT): The resolved dependency file path.

### 3. `file_exports` & `file_raw_imports` Tables

Helper tables storing flat name indexes for fast LIKE/FTS queries.

- `file_path` (TEXT): The file declaring the export/import.
- `name` (TEXT): The raw symbol or dependency string name.

### 4. `metadata` Table

Stores key-value configurations for execution environment independence.

- `key` (TEXT, Primary Key): Configuration key (e.g., `rootDir`, `scanStatus`).
- `value` (TEXT): The configuration value.

### 5. `files_fts` Virtual Table

SQLite triggers (`files_ai`, `files_au`, `files_ad`) keep this FTS5 trigram-based virtual search index in sync with the `files` table.

### SQL Examples

- **Unparsed files:**
  `sqlite3 .spelunk/data.db "SELECT path, reason FROM files WHERE parsed = 0;"`
- **Symbol exporter (direct):**
  `sqlite3 .spelunk/data.db "SELECT file_path FROM file_exports WHERE name = 'SpelunkDB';"`
- **Symbol exporter (JSON):**
  `sqlite3 .spelunk/data.db "SELECT path FROM files, json_each(files.exports) WHERE json_each.value = 'SpelunkDB';"`
- **Trigram fuzzy search on exports:**
  `sqlite3 .spelunk/data.db "SELECT path FROM files_fts WHERE exports MATCH 'Router';"`

## Command Output Examples

### Outline Command (`node <skill-path>/scripts/outline.mjs --file src/services/db.ts`)

```json
{
  "files": [
    {
      "path": "src/services/db.ts",
      "parsed": true,
      "exports": ["SpelunkDB", "FileRecord"],
      "imports": ["node:sqlite", "fs", "path"],
      "summary": "Manages SQLite initialization and CRUD operations."
    }
  ]
}
```

### Dependency Command (`node <skill-path>/scripts/deps.mjs --file src/services/db.ts --direction in`)

```json
{
  "files": [
    {
      "path": "src/index.ts",
      "parsed": true,
      "exports": [],
      "imports": ["./services/db"],
      "summary": "Application entry point.",
      "rank": 1
    }
  ],
  "limit": 50,
  "offset": 0,
  "total_count": 1,
  "has_more": false
}
```
