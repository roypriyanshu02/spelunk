import { runCliCommand, runFind, type FileRecord } from "@core";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface FindResult {
  files: FileRecord[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

export const findCommand = {
  name: "find",
  options: {
    query: { type: "string", short: "q" },
    limit: { type: "string", short: "l", default: "50" },
    offset: { type: "string", short: "o", default: "0" },
  },
  validate: (opts: any, positionals: string[]) => {
    return !!opts.query || !!positionals[0] || "Provide a search query to find files or exports.";
  },
  execute: (dbPath: string, opts: any, positionals: string[]) => {
    const query = opts.query || positionals[0];

    const parsedLimit = parseInt(opts.limit, 10);
    const limit = Number.isNaN(parsedLimit) || parsedLimit <= 0 ? 50 : parsedLimit;

    const parsedOffset = parseInt(opts.offset, 10);
    const offset = Number.isNaN(parsedOffset) || parsedOffset < 0 ? 0 : parsedOffset;

    return runFind(query, dbPath, limit, offset);
  },
  formatMarkdown: (res: FindResult, opts: any, positionals: string[]) => {
    if (res.files.length === 0) {
      return "_No matching files or symbols found._";
    }
    const query = opts.query || positionals[0];
    const rootDir = opts?.rootDir || process.cwd();
    const rangeStr = `Showing results ${res.offset + 1} to ${res.offset + res.files.length} of ${res.total_count}.`;
    const hasMoreStr = res.has_more ? " Use --limit or --offset to page through results." : "";
    const header = [
      `### Spelunk Find Results for \`${query}\``,
      `*${rangeStr}${hasMoreStr}*`,
      "",
      "| File Path | Exports | Summary |",
      "| :--- | :--- | :--- |",
    ];

    const rows = res.files.map((f: FileRecord) => {
      const fileUrl = pathToFileURL(path.resolve(rootDir, f.path)).toString();
      const exportsStr =
        f.exports.length > 0 ? f.exports.map((e: string) => `\`${e}\``).join(", ") : "_None_";
      const summaryStr = f.summary || "_No summary available_";
      return `| [${f.path}](${fileUrl}) | ${exportsStr} | ${summaryStr} |`;
    });

    return [...header, ...rows].join("\n");
  },
};

runCliCommand(findCommand);
