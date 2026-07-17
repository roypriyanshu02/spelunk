# Security policy

## Reporting a vulnerability

If you spot a security bug (like parser escapes, SQLite injections, or arbitrary execution paths), please do not open a public issue. Instead, please report it privately by opening a [draft security advisory](https://github.com/roypriyanshu02/spelunk/security/advisories/new) on GitHub under the Security tab.

I will reply within 72 hours. Please give me some time to patch the issue before you share it publicly. I will credit you in the release notes unless you want to stay anonymous.

## Threat model and scope

### In-scope vulnerabilities

I track these security vulnerabilities:

- Path traversal: exploits that force Spelunk to scan, read, or write files outside the workspace root.
- SQL injection: queries that run arbitrary commands in the local SQLite database.
- Remote code execution (RCE): repo configurations or codebase structures that run arbitrary code on your machine during a scan.
- Parser crash: valid source files that trigger parser crashes, infinite loops, or memory leaks.

### Out-of-scope issues

I do not track these issues as security vulnerabilities:

- Vulnerabilities in Node.js or `web-tree-sitter` themselves, unless Spelunk calls them insecurely.
- Standard functional bugs, lint errors, or test failures that do not expose your system or data to exploits.

## Supported versions

I only patch the current major version (v1.x). I push security patches to the `main` branch and release them as patch updates. I do not maintain older versions, so please keep Spelunk up to date.

## Privacy and telemetry

Spelunk does not collect telemetry, usage metrics, or crash logs. Everything stays on your local machine.

Spelunk handles data locally:

- Tree-sitter runs locally on your CPU.
- Spelunk stores index files (imports, exports, symbols, metadata) in a local SQLite file (`.spelunk/data.db`) in your project root.
- Spelunk never uploads or transmits your source code or index to external servers.

### WASM grammar downloads

Spelunk downloads a language grammar as a WASM file the first time you run `scan.mjs` for that language. It fetches the grammar from the `tree-sitter-wasms` registry and caches it at `~/.cache/spelunk/wasm/`.

This request only downloads the file. It does not send details about your path, repository name, or source code. Once cached, Spelunk works offline.

### How to run air-gapped

1. Download the required Tree-sitter WASM files on an internet-connected machine.
2. Copy them to `~/.cache/spelunk/wasm/` on your offline machine.
3. Spelunk will load them from the cache and skip network requests.
