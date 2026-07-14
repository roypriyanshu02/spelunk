/**
 * @file diff.ts
 * @description CLI command definition to calculate structural AST differences (imports and exports) between two files.
 */
import { runCliCommand, runDiff } from "@core";
import path from "node:path";

runCliCommand({
  name: "diff",
  options: {
    "file-a": { type: "string" },
    "file-b": { type: "string" },
  },
  validate: (opts, positionals) => {
    const fa = opts["file-a"] || positionals[0];
    const fb = opts["file-b"] || positionals[1];
    return (!!fa && !!fb) || "Provide both file paths to compare. Specify file-a and file-b.";
  },
  execute: (dbPath, opts, positionals) => {
    const fa = opts["file-a"] || positionals[0];
    const fb = opts["file-b"] || positionals[1];
    return runDiff(fa, fb, dbPath);
  },
  formatMarkdown: (res) => {
    const fullA = path.resolve(process.cwd(), res.fileA);
    const urlA = `file://${fullA.replace(/\\/g, "/")}`;
    const fullB = path.resolve(process.cwd(), res.fileB);
    const urlB = `file://${fullB.replace(/\\/g, "/")}`;

    const lines = [
      `### Spelunk Structural Diff`,
      `- **File A**: [${res.fileA}](${urlA})`,
      `- **File B**: [${res.fileB}](${urlB})`,
      "",
      "#### Exports Changes",
      res.exports.added.length > 0
        ? `- **Added**: ${res.exports.added.map((x: any) => `\`${x}\``).join(", ")}`
        : "- **Added**: _None_",
      res.exports.removed.length > 0
        ? `- **Removed**: ${res.exports.removed.map((x: any) => `\`${x}\``).join(", ")}`
        : "- **Removed**: _None_",
      "",
      "#### Imports Changes",
      res.imports.added.length > 0
        ? `- **Added**: ${res.imports.added.map((x: any) => `\`${x}\``).join(", ")}`
        : "- **Added**: _None_",
      res.imports.removed.length > 0
        ? `- **Removed**: ${res.imports.removed.map((x: any) => `\`${x}\``).join(", ")}`
        : "- **Removed**: _None_",
    ];

    return lines.join("\n");
  },
});
