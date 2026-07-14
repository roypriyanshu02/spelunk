/**
 * @file find.ts
 * @description CLI command definition to search for indexed files or symbols matching a query.
 */
import { runCliCommand, runFind } from "@core";
import path from "node:path";

runCliCommand({
  name: "find",
  options: {
    query: { type: "string", short: "q" },
    limit: { type: "string", short: "l", default: "50" },
    offset: { type: "string", short: "o", default: "0" },
  },
  validate: (opts, positionals) => {
    return (
      !!opts.query ||
      !!positionals[0] ||
      "Provide a search query. The indexer needs a search term to find files or exports."
    );
  },
  execute: (dbPath, opts, positionals) => {
    const q = opts.query || positionals[0];
    const limit = parseInt(opts.limit, 10);
    const offset = parseInt(opts.offset, 10);
    return runFind(q, dbPath, limit, offset);
  },
  formatMarkdown: (res, opts, positionals) => {
    const q = opts.query || positionals[0];
    const rangeStr = `Showing results ${res.offset + 1} to ${res.offset + res.files.length} of ${res.total_count}.`;
    const hasMoreStr = res.has_more ? " Use --limit or --offset to page through results." : "";
    const header = [
      `### Spelunk Find Results for \`${q}\``,
      `*${rangeStr}${hasMoreStr}*`,
      "",
      "| File Path | Exports | Summary |",
      "| :--- | :--- | :--- |",
    ];

    const rows = res.files.map((f: any) => {
      const fullPath = path.resolve(process.cwd(), f.path);
      const fileUrl = `file://${fullPath.replace(/\\/g, "/")}`;
      const exportsStr =
        f.exports.length > 0 ? f.exports.map((e: any) => `\`${e}\``).join(", ") : "_None_";
      const summaryStr = f.summary || "_No summary available_";
      return `| [${f.path}](${fileUrl}) | ${exportsStr} | ${summaryStr} |`;
    });

    return [...header, ...rows].join("\n");
  },
});
