/**
 * @file deps.ts
 * @description CLI command definition to trace incoming and outgoing dependency trees of files.
 */
import { runCliCommand, runDeps } from "@core";
import path from "node:path";

runCliCommand({
  name: "deps",
  options: {
    file: { type: "string" },
    direction: { type: "string" },
    depth: { type: "string", short: "d", default: "3" },
    limit: { type: "string", short: "l", default: "50" },
    offset: { type: "string", short: "o", default: "0" },
  },
  validate: (opts, positionals) => {
    const f = opts.file || positionals[0];
    const dir = opts.direction || positionals[1];
    if (!f) {
      return "Provide a file path. Specify a file to trace its dependencies.";
    }
    if (dir !== "in" && dir !== "out") {
      return "Direction must be 'in' (incoming dependencies) or 'out' (outgoing dependencies).";
    }
    return true;
  },
  execute: (dbPath, opts, positionals) => {
    const f = opts.file || positionals[0];
    const dir = (opts.direction || positionals[1]) as "in" | "out";

    const parsedDepth = parseInt(opts.depth || positionals[2] || "3", 10);
    const maxDepth = Number.isNaN(parsedDepth) ? 3 : parsedDepth;

    const limit = parseInt(opts.limit, 10);
    const offset = parseInt(opts.offset, 10);
    return runDeps(f, dir, maxDepth, dbPath, limit, offset);
  },
  formatMarkdown: (res, opts, positionals) => {
    const f = opts.file || positionals[0];
    const dir = opts.direction || positionals[1];
    const fullPath = path.resolve(process.cwd(), f);
    const fileUrl = `file://${fullPath.replace(/\\/g, "/")}`;

    const rangeStr = `Showing dependencies ${res.offset + 1} to ${res.offset + res.files.length} of ${res.total_count}.`;
    const hasMoreStr = res.has_more ? " Use --limit or --offset to page through results." : "";
    const header = [
      `### Spelunk Dependencies (\`${dir}\`) for [${f}](${fileUrl})`,
      `*${rangeStr}${hasMoreStr}*`,
      "",
    ];

    if (res.files.length === 0) {
      header.push("_No dependencies found_");
      return header.join("\n");
    }

    const items = res.files.map((dep: any) => {
      const depFullPath = path.resolve(process.cwd(), dep.path);
      const depUrl = `file://${depFullPath.replace(/\\/g, "/")}`;
      const summaryStr = dep.summary ? ` - ${dep.summary}` : "";
      return `- **Rank ${dep.rank}**: [${dep.path}](${depUrl})${summaryStr}`;
    });

    return [...header, ...items].join("\n");
  },
});
