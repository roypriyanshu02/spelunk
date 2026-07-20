# Contributing to Spelunk

Thank you for helping out! Whether you want to fix a typo, squash a parser bug, or add support for a new language, this guide will walk you through the setup.

When you participate, please follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Table of contents

- [Codebase orientation](#codebase-orientation)
- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
- [Development workflow](#development-workflow)
- [Database schema and agent skills](#database-schema-and-agent-skills)
- [Git workflow and pull requests](#git-workflow-and-pull-requests)
- [Need help?](#need-help)

## Codebase orientation

Before making changes, check this layout to see where files live:

| Path                      | Description                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/core/`               | The indexing engine, including the Tree-sitter parser setup and SQLite database connection logic. |
| `src/commands/`           | TypeScript implementations of Spelunk commands like `find`, `outline`, and `deps`.                |
| `skills/spelunk/`         | The packaged coding agent skill.                                                                  |
| `skills/spelunk/SKILL.md` | The main agent prompt instructions.                                                               |
| `skills/spelunk/scripts/` | Compiled JavaScript output that the build script generates automatically.                         |

> [!WARNING]
> Do not edit files under `skills/spelunk/scripts/` directly. The bundler generates these files from the TypeScript source, and subsequent builds will overwrite your edits. Make your changes in `src/`, `tests/`, `benchmark/`, or `skills/`, then run the build command.

## Prerequisites

You will need:

- Node.js v24.18.0 or newer
- npm v11.16.0 or newer

## Getting started

1. Clone the repository and install dependencies:
   ```bash
   npm ci
   ```
2. Compile the project to verify your setup and generate the skill scripts:
   ```bash
   npm run build
   ```

## Development workflow

We format code with `oxfmt` and check it with `oxlint` and the TypeScript compiler.

Format files:

```bash
npm run format
```

Run the linter:

```bash
npm run lint
```

Check types:

```bash
npm run typecheck
```

Run Vitest unit tests:

```bash
npm run test
```

If you change parsing or query logic, run the benchmark and evaluation scripts:

```bash
npm run benchmark
npm run eval
```

Bump the package version (this updates `package.json` and `package-lock.json`):

```bash
npm version <major|minor|patch>
```

## Database schema and agent skills

If you modify the SQLite database schema in `src/core/db.ts`, or change any flags and arguments:

- Keep the change backward compatible, or write a clear migration guide.
- Update the prompt in [skills/spelunk/SKILL.md](skills/spelunk/SKILL.md) to keep the agent in sync. An outdated prompt will cause the agent to fail.

## Git workflow and pull requests

1. Fork the repository and clone it to your local machine.
2. Create a branch with a prefix matching your change type:
   - `feature/your-feature-name`
   - `bugfix/your-bug-name`
   - `docs/your-doc-changes`
3. Commit your changes using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add database schema migration support`
   - `fix: resolve crash on missing WASM cache directory`
   - `docs: update setup instructions in README`
4. Target the `main` branch when you open your pull request.
5. Verify your changes pass checks before pushing:
   ```bash
   npm run format && npm run lint && npm run typecheck && npm run test
   ```
6. Fill out the [pull request template](.github/PULL_REQUEST_TEMPLATE.md) when you submit your changes.

### Continuous integration

GitHub Actions runs our test suite on every pull request to `main`. You can view the configuration in [.github/workflows/test.yml](.github/workflows/test.yml). The workflow:

- Installs dependencies.
- Builds the project (`npm run build`) to test skill script compilation.
- Runs `npm run lint` and `npm run typecheck` for static analysis.
- Runs unit tests via `npm run test`.

You can track the job status in the pull request interface.

## Need help?

If you get stuck during setup, are unsure if a change is in scope, or want to discuss an idea before writing code, please open a [discussion or issue](https://github.com/roypriyanshu02/spelunk/issues). I would rather answer questions early than review a pull request that needs significant changes.
