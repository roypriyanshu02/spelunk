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

We format code with `oxfmt` and run static checks using `oxlint` and the TypeScript compiler.

To format your files, run:

```bash
npm run format
```

To lint your code, run:

```bash
npm run lint
```

To run our unit tests (we use Vitest), run:

```bash
npm run test
```

If you modify any parsing or query logic, make sure you also run our benchmark and behavior checks:

```bash
npm run benchmark
npm run eval
```

To bump the version when needed:

```bash
npm version <major|minor|patch>
```

This command updates both `package.json` and `package-lock.json`.

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
5. Run the linters, formatters, and tests locally to verify everything passes before you push:
   ```bash
   npm run lint && npm run format && npm run test
   ```
6. Fill out the [pull request template](.github/PULL_REQUEST_TEMPLATE.md) when you submit your changes.

### Continuous integration

GitHub Actions automatically runs our test suite on every pull request targeting `main` (defined in [.github/workflows/test.yml](.github/workflows/test.yml)). The workflow:

- Installs all dependencies.
- Builds the project using `npm run build` to verify skill script compilation.
- Runs static checks and linters using `npm run lint`.
- Runs all unit tests using `npm run test`.

You can watch the logs and run status directly in the pull request interface on GitHub.

## Need help?

If you get stuck during setup, are unsure if a change is in scope, or want to discuss an idea before writing code, please open a [discussion or issue](https://github.com/roypriyanshu02/spelunk/issues). I would rather answer questions early than review a pull request that needs significant changes.
