# Spelunk

Give your coding agent a map of your codebase.

Spelunk is an AST-powered codebase indexer skill for coding agents. It parses your codebase with Tree-sitter and builds a local SQLite index to help your agent navigate files much faster.

## Install

Skip the setup. Your agent runs these scripts when needed.

## How to use it

Ask your agent questions in plain English. The agent handles the database queries:

- **Build the index:** "Scan the repository and build the index."
- **Locate definitions:** "Where is the `Router` class?" or "Find parseRoute."
- **Trace dependencies:** "Show what imports index.ts." or "Find files using database.ts."
- **Outline files:** "List imports and exports for database.ts."
- **Summarize structure:** "Summarize router.ts structural outline."
- **Compare versions:** "Compare parser.ts structural diff between version A and B."
- **Export map:** "Export the codebase map."

## Running scripts manually

Your agent runs these scripts. If you want to test them manually, run the commands from your workspace root:

| Task          | Command                                                                  |
| :------------ | :----------------------------------------------------------------------- |
| Build index   | `node <skill-path>/scripts/scan.mjs`                                     |
| Find symbol   | `node <skill-path>/scripts/find.mjs --query <symbol>`                    |
| Trace imports | `node <skill-path>/scripts/deps.mjs --file <path> --direction <in\|out>` |
| Outline file  | `node <skill-path>/scripts/outline.mjs --file <path>`                    |
| Get summary   | `node <skill-path>/scripts/explain.mjs --file <path>`                    |
| Compare files | `node <skill-path>/scripts/diff.mjs --file-a <fileA> --file-b <fileB>`   |
| Export map    | `node <skill-path>/scripts/export.mjs`                                   |

> [!NOTE]
> `<skill-path>` refers to the directory containing this skill, such as `skills/spelunk`.

## How it works under the hood

1. **First scan:** Spelunk parses files with Tree-sitter and creates a SQLite database at `.spelunk/data.db`. It indexes imports, exports, classes, and functions. It ignores raw source code, keeping the database tiny.
2. **Fast queries:** Next time your agent asks a question, it queries SQLite instead of reading files.
3. **Safety limits:** The scanner skips files over 1MB and binary files. It also stops at a depth of 100 folders to prevent symlink loops.
4. **Privacy:** The indexer runs on your machine. It uses no telemetry or tracking.

## Requirements

- **Node.js:** Spelunk requires Node.js version **>= 24.18.0** to use the native SQLite engine.
- **Setup:** The first scan requires internet access to download Tree-sitter grammars to `~/.cache/spelunk/wasm/`. Subsequent runs work offline.

## Read more

We keep extra details in these files if you want to dig deeper:

- [SKILL.md](SKILL.md): Agent schemas and parameters.
- [Database schema](schema/README.md) & [JSON contracts](schema/contracts.md): Table definitions and JSON response shapes.
- [Main repository](https://github.com/roypriyanshu02/spelunk): Performance benchmarks and documentation.
- [Security guidelines](https://github.com/roypriyanshu02/spelunk/blob/main/SECURITY.md): Local privacy details and offline configuration.

---

_If Spelunk helps you out, we would love a star on [GitHub](https://github.com/roypriyanshu02/spelunk)!_
