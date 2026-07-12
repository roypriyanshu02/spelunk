# Expected output contracts

Spelunk commands output structured JSON payloads inside the `structuredContent` field of their responses. Use these schemas to build custom agents or integrate output.

## `spelunk_find`

Defined in [find.ts](../src/commands/find.ts). Returns files matching a symbol query.

```json
{
  "files": [
    {
      "path": "src/services/db.ts",
      "parsed": true,
      "reason": null,
      "hash": "4a7b...",
      "exports": ["SpelunkDB", "FileRecord"],
      "imports": ["node:sqlite", "fs", "path"],
      "summary": "Manages SQLite initialization and CRUD operations.",
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

## `spelunk_outline`

Defined in [outline.ts](../src/commands/outline.ts). Outlines imports and exports for a specific file.

```json
{
  "files": [
    {
      "path": "src/services/db.ts",
      "parsed": true,
      "reason": null,
      "hash": "4a7b...",
      "exports": ["SpelunkDB", "FileRecord"],
      "imports": ["node:sqlite", "fs", "path"],
      "summary": "Manages SQLite initialization and CRUD operations.",
      "summary_hash": "4a7b...",
      "mtime": 1721160000000,
      "size": 19719
    }
  ]
}
```

## `spelunk_deps`

Defined in [deps.ts](../src/commands/deps.ts). Traces dependency chains forward or backward.

```json
{
  "files": [
    {
      "path": "src/services/db.ts",
      "parsed": true,
      "reason": null,
      "hash": "4a7b...",
      "exports": ["SpelunkDB", "FileRecord"],
      "imports": ["node:sqlite", "fs", "path"],
      "summary": "Manages SQLite initialization and CRUD operations.",
      "summary_hash": "4a7b...",
      "mtime": 1721160000000,
      "size": 19719,
      "rank": 1
    }
  ],
  "limit": 50,
  "offset": 0,
  "total_count": 1,
  "has_more": false
}
```

## `spelunk_explain`

Defined in [explain.ts](../src/commands/explain.ts). Sets or returns structural file summaries.

```json
{
  "path": "src/services/db.ts",
  "summary": "Terse structural summary of the file.",
  "stale": false
}
```

## `spelunk_diff`

Defined in [diff.ts](../src/commands/diff.ts). Compares two versions of a file to detect changes in imports and exports.

```json
{
  "fileA": "src/old.ts",
  "fileB": "src/new.ts",
  "exports": {
    "added": ["NewExport"],
    "removed": ["OldExport"]
  },
  "imports": {
    "added": [],
    "removed": ["fs"]
  }
}
```

## `spelunk_export`

Defined in [export.ts](../src/commands/export.ts). Exports the full codebase index in JSON or Markdown.

### JSON Format

```json
{
  "files": [
    {
      "path": "src/services/db.ts",
      "parsed": true,
      "reason": null,
      "hash": "4a7b...",
      "exports": ["SpelunkDB", "FileRecord"],
      "imports": ["node:sqlite", "fs", "path"],
      "summary": "Manages SQLite initialization and CRUD operations.",
      "summary_hash": "4a7b...",
      "mtime": 1721160000000,
      "size": 19719
    }
  ]
}
```

### Markdown Format

```markdown
# Spelunk Codemap Export

## src/services/db.ts

- **Parsed**: true
- **Exports**:
  - `SpelunkDB`
  - `FileRecord`
- **Imports**:
  - `node:sqlite`
  - `fs`
  - `path`
```

## `spelunk_scan`

Defined in [scan.ts](../src/commands/scan.ts). Triggers a codebase scan and returns file statistics.

```json
{
  "fileCount": 10,
  "parsedCount": 2,
  "skippedCount": 1,
  "unchangedCount": 7,
  "metrics": {
    "durationMs": 120.5,
    "filesPerSecond": 83.0,
    "cacheHitRatio": 0.7,
    "memoryUsageMb": 45.2
  }
}
```
