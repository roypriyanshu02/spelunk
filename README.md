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
  <a href="#benchmark-comparison">Benchmarks</a> ·
  <a href="#how-it-compares">Comparison</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#development">Development</a> ·
  <a href="#faq">FAQ</a>
</p>

---

Spelunk is an AST-powered codebase indexer skill for coding agents. It parses your codebase with Tree-sitter and builds a local SQLite index to help your agent navigate files much faster.

Ever watched your AI agent run `cat` and `grep` on dozens of files just to find where a single function is defined?

Spelunk uses Tree-sitter to parse your codebase and caches files, exports, imports, and dependencies in a local SQLite database. Instead of reading whole files over and over, your agent queries this index to find definitions in ~150ms, saving up to 90% on token costs.

## Benchmark comparison

| Sequential Search (Grep / Cat)                 | Indexed Query (Spelunk)                     |
| :--------------------------------------------- | :------------------------------------------ |
| Reads whole source files                       | Queries SQLite index                        |
| Consumes 3,000 to 18,000 tokens per task       | Consumes 75 to 1,200 tokens per task        |
| Query duration up to 18 seconds                | Query duration ~150 milliseconds            |
| Subject to false matches (comments, mock text) | Maps structural definitions via syntax tree |

```text
┌──────────────────────────────────────────────────────────────────────┐
│   tokens per query          ██                            75-1,200   │
│   vs raw file reads         ████████████████████████  3,000-18,000   │
│   resolution time           ██                               150ms   │
│   vs raw search time        ████████████████████████████  18,000ms   │
└──────────────────────────────────────────────────────────────────────┘
```

_Evaluated across 17 tasks in the Amar, Express, Requests, Gin, and Ripgrep codebases. For example, querying a class definition (`Router` in Express) takes 203ms and uses 1,099 tokens with Spelunk, compared to 18,000 tokens using sequential file reads. Full metrics are listed in [benchmark/results.json](benchmark/results.json) and agentic LLM evaluation scenarios (showing a 64.7% token reduction and 20% turn reduction) are in [benchmark/agentic_eval_results.json](benchmark/agentic_eval_results.json)._

## How it compares

|                       | Spelunk                                 | Plain Grep                                 | ctags                                | LSP (Language Server)           |
| :-------------------- | :-------------------------------------- | :----------------------------------------- | :----------------------------------- | :------------------------------ |
| **Speed**             | Instant SQLite cache lookups            | Slow on large repositories                 | Fast                                 | Slow startup, high memory use   |
| **Token Cost**        | Low (average ~900 tokens per query)     | High (3k to 18k tokens, reads whole files) | Medium (returns a flat tag list)     | High (heavy JSON-RPC overhead)  |
| **Accuracy**          | High (ignores comments and variables)   | Low (matches every text match)             | Medium (basic symbol matches only)   | High (full semantic resolution) |
| **Approach**          | Tree-sitter AST (parses code structure) | None (blind text search)                   | Regex & basic AST (editor tags only) | Full compiler-level analysis    |
| **Agent Integration** | Simple JSON or Markdown script output   | Needs complex parsing regex loops          | Raw editor-focused tag formats       | Complex client-server protocol  |

## Quick start

Spelunk is distributed as an agent skill on [skills.sh](https://skills.sh/roypriyanshu02/spelunk) and integrates with GitHub Copilot, Cursor, Claude Code, Cline, Codex, Devin, Opencode, and Antigravity.

### 1. Installation

Install Spelunk locally in the project directory:

```bash
npx skills add roypriyanshu02/spelunk
```

Or install globally:

```bash
npx skills add roypriyanshu02/spelunk -g -y
```

### 2. Usage

Once installed, you can just ask your coding agent questions in plain English:

- _"Show me the dependency chain of index.ts."_
- _"Where does the Router class define its methods?"_

The agent will automatically query the SQLite index instead of scanning files manually.

> [!NOTE]
> On the first scan, Spelunk builds a `.spelunk/data.db` database in your project root. Future queries reuse this cached index for instant lookups. Everything runs locally on your machine with zero telemetry. Read [SECURITY.md](SECURITY.md) for details.

## How it works

Instead of searching raw text, Spelunk parses the structure of your code.

1. **AST Parsing:** When files change, Spelunk uses Tree-sitter to extract imports, exports, classes, and function definitions into a syntax tree.
2. **Local Caching:** Spelunk writes these components to a local SQLite database (`.spelunk/data.db`) using Node's native `node:sqlite` module. You do not need to install `node-gyp` or compile any native addons.
3. **Safety Guards:** To keep things fast, the scanner ignores files larger than 1MB, skips binary files, and scans folders up to a maximum depth of 100 directories. It caps indexing at 50,000 files per run and respects `.gitignore` and `.spelunkignore` rules, skipping sensitive credential files automatically.
4. **Queries:** Your agent runs targeted SQL queries against the index to trace dependency paths or find symbols in milliseconds.

For complete script flags and agent configuration, see [skills/spelunk/README.md](skills/spelunk/README.md).

## Development

Spelunk is written entirely in TypeScript and compiled into JavaScript skill scripts using `tsdown`. You will need Node.js **>= 24.18.0** to build and run it locally.

To set up your local environment, run tests, or contribute to the project, check out the [Contributing Guide](CONTRIBUTING.md). Please read the [Code of Conduct](CODE_OF_CONDUCT.md) to help keep this project welcoming. Spelunk is licensed under the [MIT License](LICENSE).

## FAQ

### Why use Spelunk instead of grep?

`grep` matches plain text, so it cannot distinguish between a class, variable, comment, or string. A search for `Router` returns every single text occurrence. Spelunk understands the syntax tree, so querying `Router` returns the exact file where it is defined or exported, skipping comments and strings.

### Does it read file contents into the database?

No. Spelunk parses only structural elements like imports, exports, classes, and functions. Raw source code is never stored in the SQLite index, which keeps the database small and queries fast.

### Does it index sensitive files or API keys?

No. Spelunk automatically skips `.env` files, credential patterns, and binary blobs. It respects both `.gitignore` and `.spelunkignore` rules so secrets are never indexed into SQLite. Read [SECURITY.md](SECURITY.md) for details.

### What languages does it support?

Spelunk supports any language with a Tree-sitter grammar from `tree-sitter-wasms`. JavaScript, TypeScript, Python, Go, Rust, C/C++, Java, and Ruby work out of the box, with full AST symbol extraction for 40+ languages and major frameworks.

---

_If you find Spelunk useful, please support the project by starring it on [GitHub](https://github.com/roypriyanshu02/spelunk)!_
