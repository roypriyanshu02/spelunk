<h1 align="center">Spelunk</h1>
<p align="center">
  <em>Give your coding agent a map of the codebase.</em>
</p>
<p align="center">
  <a href="https://github.com/roypriyanshu02/spelunk"><img src="https://img.shields.io/github/stars/roypriyanshu02/spelunk?style=flat-square&color=dfb317" alt="Stars"></a>
  <a href="https://github.com/roypriyanshu02/spelunk/releases"><img src="https://img.shields.io/github/v/release/roypriyanshu02/spelunk?style=flat-square&color=33ab12" alt="Latest Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0284c7?style=flat-square" alt="License"></a>
  <a href="https://skills.sh/roypriyanshu02/spelunk"><img src="https://img.shields.io/badge/distributed_via-skills.sh-black?style=flat-square" alt="Distributed via skills.sh"></a>
</p>
<p align="center">
  <a href="#before-and-after">See it</a> ·
  <a href="#how-it-compares">Comparison</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#how-the-agent-uses-spelunk">Usage</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#development">Development</a> ·
  <a href="#faq">FAQ</a>
</p>

---

Spelunk is an AST-powered codebase indexer skill for coding agents. It parses your codebase with Tree-sitter and builds a local SQLite index to help your agent navigate files much faster.

Ever watched your AI agent run `cat` and `grep` on dozens of files just to find where a single function is defined?

Spelunk uses Tree-sitter to parse your codebase and caches files, exports, imports, and dependencies in a local SQLite database. Instead of reading whole files over and over, your agent queries this index to find definitions with ~150ms resolution, saving up to 90% on token costs.

## Before and after

| Without Spelunk (Plain Grep / Cat)              | With Spelunk (Tree-sitter + SQLite)                |
| :---------------------------------------------- | :------------------------------------------------- |
| Agent reads 10-15 source files via cat/grep     | Agent runs a single targeted graph query           |
| Consumes 3,000 to 18,000 input tokens           | Consumes 75-1,200 tokens (Average: **918 tokens**) |
| Resolves in up to 18 seconds (sequential scans) | Resolves in **150ms** average (fast SQLite read)   |
| Accuracy degrades on minified or generated code | Accurate symbol mapping using the syntax tree      |

```text
┌──────────────────────────────────────────────────────────────────────┐
│   tokens per query          ██                            75-1,200   │
│   vs raw file reads         ████████████████████████  3,000-18,000   │
│   resolution time           ██                               150ms   │
│   vs raw search time        ████████████████████████████  18,000ms   │
└──────────────────────────────────────────────────────────────────────┘
```

_Tested on 17 real codebase tasks across the Amar, Express, Requests, Gin, and Ripgrep repositories. For example, looking up a class like `Router` in express takes 203ms and uses 1,099 tokens with Spelunk, compared to 18,000 tokens for manual file reads. See [benchmark/results.json](benchmark/results.json) for the full data._

## How it compares

|                       | Spelunk                                 | Plain Grep                                 | ctags                                | LSP (Language Server)           |
| :-------------------- | :-------------------------------------- | :----------------------------------------- | :----------------------------------- | :------------------------------ |
| **Speed**             | Instant SQLite cache lookups            | Slow on large repositories                 | Fast                                 | Slow startup, high memory use   |
| **Token Cost**        | Low (average ~900 tokens per query)     | High (3k to 18k tokens, reads whole files) | Medium (returns a flat tag list)     | High (heavy JSON-RPC overhead)  |
| **Accuracy**          | High (ignores comments and variables)   | Low (matches every text match)             | Medium (basic symbol matches only)   | High (full semantic resolution) |
| **Approach**          | Tree-sitter AST (parses code structure) | None (blind text search)                   | Regex & basic AST (editor tags only) | Full compiler-level analysis    |
| **Agent Integration** | Simple JSON or Markdown CLI output      | Needs complex parsing regex loops          | Raw editor-focused tag formats       | Complex client-server protocol  |

## Quick start

You can install Spelunk with a single command. It works the same way across all supported coding agents.

### 1. Installation

Install Spelunk locally in your current project:

```bash
npx skills add roypriyanshu02/spelunk
```

Or install it globally so it is available to your agent across all your projects:

```bash
npx skills add roypriyanshu02/spelunk -g -y
```

Spelunk is distributed as a modular agent skill on [skills.sh](https://skills.sh/roypriyanshu02/spelunk) and works out of the box with GitHub Copilot, Cursor, Claude Code, Cline, Codex, Devin, Opencode, and Antigravity. You do not need to manually configure any tools.

### 2. Usage

Once installed, you can just ask your coding agent questions in plain English:

- _"Show me the dependency chain of index.ts."_
- _"Where does the Router class define its methods?"_

The agent will automatically query the SQLite index instead of scanning files manually.

> [!NOTE]
> On the first scan, Spelunk builds a `.spelunk/data.db` database in your project root. Future queries reuse this cached index for instant lookups. Everything runs locally on your machine with zero telemetry. Read [SECURITY.md](SECURITY.md) for details.

## How the agent uses Spelunk

You do not need to run these commands yourself. Just ask questions in plain English, and your agent will run the right script:

| You ask...                                        | The agent runs...                                                              |
| :------------------------------------------------ | :----------------------------------------------------------------------------- |
| "Scan the codebase and build an index"            | `node <skill-path>/scripts/scan.mjs`                                           |
| "Find where the class `Router` is defined"        | `node <skill-path>/scripts/find.mjs --query Router`                            |
| "Show me what this file exports"                  | `node <skill-path>/scripts/outline.mjs --file path/to/file`                    |
| "What files depend on database.ts?"               | `node <skill-path>/scripts/deps.mjs --file path/to/database.ts --direction in` |
| "Generate structural summaries for files"         | `node <skill-path>/scripts/explain.mjs --file path/to/file`                    |
| "Export the codebase map"                         | `node <skill-path>/scripts/export.mjs --format json`                           |
| "Show structural changes between version A and B" | `node <skill-path>/scripts/diff.mjs --file-a fileA --file-b fileB`             |

## How it works

Instead of searching raw text, Spelunk parses the structure of your code.

1. **AST Parsing:** When files change, Spelunk uses Tree-sitter to extract imports, exports, classes, and function definitions into a syntax tree.
2. **Local Caching:** Spelunk writes these components to a local SQLite database (`.spelunk/data.db`) using Node's native `node:sqlite` module. You do not need to install `node-gyp` or compile any native addons.
3. **Safety Guards:** To keep things fast, the scanner ignores files larger than 1MB, skips binary files, and scans folders up to a maximum depth of 100 directories.
4. **Queries:** Your agent runs targeted SQL queries against the index to trace dependency paths or find symbols in milliseconds.

To see the database schema and JSON format details, check out [schema/README.md](schema/README.md) and [schema/contracts.md](schema/contracts.md).

## Development

Spelunk is written in TypeScript and compiled into skill scripts using tsdown. You will need Node.js **>= 24.18.0** to build and run it locally.

> [!WARNING]
> Do not edit files inside the `skills/spelunk/scripts/` directory directly. The build process overwrites them. Make all your changes in the TypeScript files under the `src/` directory.

To set up your local environment, run tests, or contribute to the project, check out the [Contributing Guide](CONTRIBUTING.md). Please read the [Code of Conduct](CODE_OF_CONDUCT.md) to help keep this project welcoming. Spelunk is licensed under the [MIT License](LICENSE).

## FAQ

### Why use Spelunk instead of grep?

`grep` matches plain text, so it cannot distinguish between a class, variable, comment, or string. A search for `Router` returns every single text occurrence. Spelunk understands the syntax tree, so querying `Router` returns the exact file and line where it is defined or exported, skipping comments and strings.

### Does it read file contents into the database?

No. Spelunk parses only structural elements like imports, exports, classes, and functions. Raw source code is never stored in the SQLite index, which keeps the database small and queries fast.

### What languages does it support?

Spelunk supports any language with a Tree-sitter grammar from `tree-sitter-wasms`. TypeScript, JavaScript, Python, Rust, and Go work out of the box, and we are adding more.

---

_If you find Spelunk useful, please support the project by starring it on [GitHub](https://github.com/roypriyanshu02/spelunk)!_
