import { runCliCommand, runDeps, type GraphNode } from "@core";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface DepsResult {
  files: GraphNode[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

export const depsCommand = {
  name: "deps",
  positionalFileIndices: [0],
  options: {
    file: { type: "string" },
    direction: { type: "string" },
    depth: { type: "string", short: "d" },
    limit: { type: "string", short: "l", default: "50" },
    offset: { type: "string", short: "o", default: "0" },
  },
  validate: (opts: any, positionals: any) => {
    const filePath = opts.file || positionals[0];
    const rawDir = opts.direction || positionals[1];
    const dir = typeof rawDir === "string" ? rawDir.toLowerCase() : "";
    if (!filePath) {
      return "Provide a file path to trace its dependencies.";
    }
    if (dir !== "in" && dir !== "out") {
      return "Direction must be 'in' (incoming dependencies) or 'out' (outgoing dependencies).";
    }
    return true;
  },
  execute: (dbPath: any, opts: any, positionals: any) => {
    const filePath = opts.file || positionals[0];
    const rawDir = opts.direction || positionals[1];
    const dir = (typeof rawDir === "string" ? rawDir.toLowerCase() : "") as "in" | "out";

    const parsedDepth = parseInt(opts.depth || positionals[2] || "3", 10);
    const maxDepth = Number.isNaN(parsedDepth) || parsedDepth < 0 ? 3 : parsedDepth;

    const parsedLimit = parseInt(opts.limit, 10);
    const limit = Number.isNaN(parsedLimit) || parsedLimit <= 0 ? 50 : parsedLimit;

    const parsedOffset = parseInt(opts.offset, 10);
    const offset = Number.isNaN(parsedOffset) || parsedOffset < 0 ? 0 : parsedOffset;

    return runDeps(filePath, dir, maxDepth, dbPath, limit, offset);
  },
  formatMarkdown: (res: any, opts: any, positionals: any) => {
    const filePath = opts.file || positionals[0];
    const dir = opts.direction || positionals[1];
    const rootDir = opts?.rootDir || process.cwd();
    const fileUrl = pathToFileURL(path.resolve(rootDir, filePath)).toString();

    const rangeStr = `Showing dependencies ${res.offset + 1} to ${res.offset + res.files.length} of ${res.total_count}.`;
    const hasMoreStr = res.has_more ? " Use --limit or --offset to page through results." : "";
    const header = [
      `### Spelunk Dependencies (\`${dir}\`) for [${filePath}](${fileUrl})`,
      `*${rangeStr}${hasMoreStr}*`,
      "",
    ];

    if (res.files.length === 0) {
      header.push("_No dependencies found_");
      return header.join("\n");
    }

    const items = res.files.map((dep: GraphNode) => {
      const depUrl = pathToFileURL(path.resolve(rootDir, dep.path)).toString();
      const summaryStr = dep.summary ? ` - ${dep.summary}` : "";
      return `- **Rank ${dep.rank}**: [${dep.path}](${depUrl})${summaryStr}`;
    });

    return [...header, ...items].join("\n");
  },
};

runCliCommand(depsCommand);
