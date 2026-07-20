import { runCliCommand, runDiff } from "@core";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface DiffResult {
  fileA: string;
  fileB: string;
  exports: {
    added: string[];
    removed: string[];
  };
  imports: {
    added: string[];
    removed: string[];
  };
}

export const diffCommand = {
  name: "diff",
  positionalFileIndices: [0, 1],
  options: {
    "file-a": { type: "string" },
    "file-b": { type: "string" },
  },
  validate: (opts: any, positionals: any) => {
    const fileA = opts["file-a"] || positionals[0];
    const fileB = opts["file-b"] || positionals[1];
    return (!!fileA && !!fileB) || "Provide both file-a and file-b paths to compare.";
  },
  execute: (dbPath: any, opts: any, positionals: any) => {
    const fileA = opts["file-a"] || positionals[0];
    const fileB = opts["file-b"] || positionals[1];
    return runDiff(fileA, fileB, dbPath);
  },
  formatMarkdown: (res: any, opts?: any) => {
    const rootDir = opts?.rootDir || process.cwd();
    const urlA = pathToFileURL(path.resolve(rootDir, res.fileA)).toString();
    const urlB = pathToFileURL(path.resolve(rootDir, res.fileB)).toString();

    const lines = [
      `### Spelunk Structural Diff`,
      `- **File A**: [${res.fileA}](${urlA})`,
      `- **File B**: [${res.fileB}](${urlB})`,
      "",
      "#### Exports Changes",
      res.exports.added.length > 0
        ? `- **Added**: ${res.exports.added.map((x: string) => `\`${x}\``).join(", ")}`
        : "- **Added**: _None_",
      res.exports.removed.length > 0
        ? `- **Removed**: ${res.exports.removed.map((x: string) => `\`${x}\``).join(", ")}`
        : "- **Removed**: _None_",
      "",
      "#### Imports Changes",
      res.imports.added.length > 0
        ? `- **Added**: ${res.imports.added.map((x: string) => `\`${x}\``).join(", ")}`
        : "- **Added**: _None_",
      res.imports.removed.length > 0
        ? `- **Removed**: ${res.imports.removed.map((x: string) => `\`${x}\``).join(", ")}`
        : "- **Removed**: _None_",
    ];

    return lines.join("\n");
  },
};

runCliCommand(diffCommand);
