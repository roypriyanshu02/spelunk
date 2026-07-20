import { SpelunkDB } from "./db";
import { isPathContained } from "./commands";
import path from "node:path";
import fs from "node:fs";

async function withDB<T>(dbPath: string, fn: (db: SpelunkDB) => Promise<T> | T): Promise<T> {
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `No database found at ${dbPath}. The index must be created before querying. Run 'spelunk scan' to index the codebase.`,
    );
  }
  const db = new SpelunkDB(dbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function resolveRelativePath(db: SpelunkDB, targetPath: string): string {
  const rootDir = db.getMetadata("rootDir") || process.cwd();
  const absoluteTarget = path.resolve(targetPath);
  const relative = path.relative(rootDir, absoluteTarget).replace(/\\/g, "/");
  if (!isPathContained(rootDir, absoluteTarget)) {
    throw new Error(`Access denied: Target path '${targetPath}' escapes the workspace root.`);
  }
  return relative;
}

/**
 * Searches the indexed database for files matching a query string.
 */
export function runFind(query: string, dbPath: string, limit: number = 50, offset: number = 0) {
  return withDB(dbPath, (db) => {
    const { items, total_count, has_more } = db.search(query, limit, offset);
    return { files: items, limit, offset, total_count, has_more };
  });
}

/**
 * Retrieves the imports and exports outline for a specific file.
 */
export function runOutline(targetPath: string, dbPath: string) {
  return withDB(dbPath, (db) => {
    const relativePath = resolveRelativePath(db, targetPath);
    const fileRecord = db.getFile(relativePath);
    if (!fileRecord) {
      return { files: [] };
    }
    return { files: [fileRecord] };
  });
}

/**
 * Traces the dependency tree (incoming or outgoing) of a target file.
 */
export function runDeps(
  targetPath: string,
  direction: "in" | "out",
  maxDepth: number,
  dbPath: string,
  limit: number = 50,
  offset: number = 0,
) {
  return withDB(dbPath, (db) => {
    const relativeTarget = resolveRelativePath(db, targetPath);
    const fileRecord = db.getFile(relativeTarget);
    if (!fileRecord) {
      return { files: [], limit, offset, total_count: 0, has_more: false };
    }
    const { items, total_count, has_more } = db.getDependencies(
      relativeTarget,
      direction,
      maxDepth,
      limit,
      offset,
    );
    return { files: items, limit, offset, total_count, has_more };
  });
}

/**
 * Explains or sets the summary of a targeted file in the index.
 */
export async function runExplain(
  targetPath: string,
  shouldSummarize: boolean,
  dbPath: string,
  agentSummary?: string,
) {
  return withDB(dbPath, async (db) => {
    const relativeTarget = resolveRelativePath(db, targetPath);
    const record = db.getFile(relativeTarget);

    if (!record) {
      throw new Error(
        `File not indexed: ${relativeTarget}. The file must be added to the index first. Run 'spelunk scan' to update the index.`,
      );
    }

    if (!shouldSummarize) {
      if (record.summary) {
        const isStale = !!(record.summary_hash && record.summary_hash !== record.hash);
        return { path: relativeTarget, summary: record.summary, stale: isStale };
      } else {
        throw new Error(
          `No summary cached for this file. Summarize the file first using --set-summary '<text>'.`,
        );
      }
    } else {
      if (
        !record.parsed &&
        record.reason !== "binary file" &&
        record.reason !== "exceeds size limit"
      ) {
        throw new Error(
          `Cannot summarize unparsed file. The file has not been parsed successfully (reason: ${record.reason || "unknown"}).`,
        );
      }

      if (!agentSummary) {
        throw new Error(
          `Provide the summary text. Use '--set-summary <text>' to set the summary content.`,
        );
      }

      const rootDir = db.getMetadata("rootDir") || process.cwd();
      const fullPath = path.join(rootDir, relativeTarget);
      if (!fs.existsSync(fullPath)) {
        throw new Error(
          `File not found on disk: ${relativeTarget}. Ensure the file exists and the path is correct.`,
        );
      }

      record.summary = agentSummary;
      record.summary_hash = record.hash;
      db.upsertFiles([record]);

      return { path: relativeTarget, summary: agentSummary, stale: false };
    }
  });
}

/**
 * Exports all indexed files metadata in either JSON format or Markdown format.
 */
export function runExport(format: "json" | "md", dbPath: string) {
  return withDB(dbPath, (db) => {
    if (format === "json") {
      const allFiles = db.getAllFiles(true);
      return { files: allFiles };
    } else {
      const allFiles = db.getAllFiles(false);
      const lines: string[] = ["# Spelunk Codemap Export", ""];
      for (const f of allFiles) {
        lines.push(`## ${f.path}`);
        lines.push(`- **Parsed**: ${f.parsed}`);
        if (f.reason) {
          lines.push(`- **Reason**: ${f.reason}`);
        }
        if (f.exports.length > 0) {
          lines.push("- **Exports**:");
          for (const exp of f.exports) {
            lines.push(`  - \`${exp}\``);
          }
        }
        if (f.imports.length > 0) {
          lines.push("- **Imports**:");
          for (const imp of f.imports) {
            lines.push(`  - \`${imp}\``);
          }
        }
        lines.push("");
      }
      return lines.join("\n").trim();
    }
  });
}

/**
 * Computes the additions and deletions of imports and exports between two files.
 */
export function runDiff(fileA: string, fileB: string, dbPath: string) {
  return withDB(dbPath, (db) => {
    const relativeFileA = resolveRelativePath(db, fileA);
    const relativeFileB = resolveRelativePath(db, fileB);

    const recordA = db.getFile(relativeFileA);
    const recordB = db.getFile(relativeFileB);

    if (!recordA) {
      throw new Error(
        `File not indexed: ${relativeFileA}. The file must be added to the index first. Run 'spelunk scan' to update the index.`,
      );
    }
    if (!recordB) {
      throw new Error(
        `File not indexed: ${relativeFileB}. The file must be added to the index first. Run 'spelunk scan' to update the index.`,
      );
    }

    const setExportsA = new Set(recordA.exports);
    const setExportsB = new Set(recordB.exports);
    const setImportsA = new Set(recordA.imports);
    const setImportsB = new Set(recordB.imports);

    const addedExports = recordB.exports.filter((x) => !setExportsA.has(x));
    const removedExports = recordA.exports.filter((x) => !setExportsB.has(x));

    const addedImports = recordB.imports.filter((x) => !setImportsA.has(x));
    const removedImports = recordA.imports.filter((x) => !setImportsB.has(x));

    return {
      fileA: relativeFileA,
      fileB: relativeFileB,
      exports: {
        added: addedExports,
        removed: removedExports,
      },
      imports: {
        added: addedImports,
        removed: removedImports,
      },
    };
  });
}
