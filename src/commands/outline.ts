import { runCliCommand, runOutline, type FileRecord } from "@core";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface OutlineResult {
  files: FileRecord[];
}

export const outlineCommand = {
  name: "outline",
  positionalFileIndices: [0],
  options: {
    file: { type: "string" },
  },
  validate: (opts: any, positionals: any) => {
    return !!opts.file || !!positionals[0] || "Provide a file path to generate its outline.";
  },
  execute: (dbPath: any, opts: any, positionals: any) => {
    const filePath = opts.file || positionals[0];
    return runOutline(filePath, dbPath);
  },
  formatMarkdown: (res: any, opts: any, positionals: any) => {
    const filePath = opts.file || positionals[0];
    if (!res.files || res.files.length === 0) {
      return `### File not found or not indexed: \`${filePath}\``;
    }
    const record: FileRecord = res.files[0];
    const rootDir = opts?.rootDir || process.cwd();
    const fileUrl = pathToFileURL(path.resolve(rootDir, record.path)).toString();

    const lines = [
      `### Spelunk Outline for [${record.path}](${fileUrl})`,
      `- **Parsed**: ${record.parsed ? "Yes" : "No"}`,
    ];

    if (record.reason) {
      lines.push(`- **Skip Reason**: ${record.reason}`);
    }
    if (record.hash) {
      lines.push(`- **Content Hash**: \`${record.hash}\``);
    }

    const exportsStr =
      record.exports.length > 0
        ? record.exports.map((e: string) => `\`${e}\``).join(", ")
        : "_None_";
    lines.push(`- **Exports**: ${exportsStr}`);

    const importsStr =
      record.imports.length > 0
        ? record.imports.map((i: string) => `\`${i}\``).join(", ")
        : "_None_";
    lines.push(`- **Imports**: ${importsStr}`);

    if (record.summary) {
      lines.push(`- **Cached Summary**: ${record.summary}`);
    }

    return lines.join("\n");
  },
};

runCliCommand(outlineCommand);
