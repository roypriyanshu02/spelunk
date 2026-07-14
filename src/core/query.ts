import { SpelunkDB } from "./db";
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
  return path.relative(rootDir, path.resolve(targetPath)).replace(/\\/g, "/");
}

export function runFind(query: string, dbPath: string, limit: number = 50, offset: number = 0) {
  return withDB(dbPath, (db) => {
    const { items, total_count, has_more } = db.search(query, limit, offset);
    return { files: items, limit, offset, total_count, has_more };
  });
}

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
        if (isStale) {
          console.error(`Warning: Cached summary for ${relativeTarget} is stale (file modified).`);
        }
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
      db.upsertFile(record);

      return { path: relativeTarget, summary: agentSummary, stale: false };
    }
  });
}

export function runExport(format: "json" | "md", dbPath: string) {
  return withDB(dbPath, (db) => {
    const allFiles = db.getAllFiles();

    if (format === "json") {
      return { files: allFiles };
    } else {
      let md = "# Spelunk Codemap Export\n\n";
      for (const f of allFiles) {
        md += `## ${f.path}\n`;
        md += `- **Parsed**: ${f.parsed}\n`;
        if (f.reason) {
          md += `- **Reason**: ${f.reason}\n`;
        }
        if (f.exports.length > 0) {
          md += `- **Exports**:\n`;
          for (const exp of f.exports) {
            md += `  - \`${exp}\`\n`;
          }
        }
        if (f.imports.length > 0) {
          md += `- **Imports**:\n`;
          for (const imp of f.imports) {
            md += `  - \`${imp}\`\n`;
          }
        }
        md += "\n";
      }
      return md.trim();
    }
  });
}

export function runDiff(fileA: string, fileB: string, dbPath: string) {
  return withDB(dbPath, (db) => {
    const relA = resolveRelativePath(db, fileA);
    const relB = resolveRelativePath(db, fileB);

    const recA = db.getFile(relA);
    const recB = db.getFile(relB);

    if (!recA) {
      throw new Error(
        `File not indexed: ${relA}. The file must be added to the index first. Run 'spelunk scan' to update the index.`,
      );
    }
    if (!recB) {
      throw new Error(
        `File not indexed: ${relB}. The file must be added to the index first. Run 'spelunk scan' to update the index.`,
      );
    }

    const setExportsA = new Set(recA.exports);
    const setExportsB = new Set(recB.exports);
    const setImportsA = new Set(recA.imports);
    const setImportsB = new Set(recB.imports);

    const addedExports = recB.exports.filter((x) => !setExportsA.has(x));
    const removedExports = recA.exports.filter((x) => !setExportsB.has(x));

    const addedImports = recB.imports.filter((x) => !setImportsA.has(x));
    const removedImports = recA.imports.filter((x) => !setImportsB.has(x));

    return {
      fileA: relA,
      fileB: relB,
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
