#!/usr/bin/env node
import { r as runDiff, t as runCliCommand } from "./common.mjs";
import path from "node:path";

//#region src/commands/diff.ts
/**
* @file diff.ts
* @description CLI command definition to calculate structural AST differences (imports and exports) between two files.
*/
runCliCommand({
	name: "diff",
	options: {
		"file-a": { type: "string" },
		"file-b": { type: "string" }
	},
	validate: (opts, positionals) => {
		const fa = opts["file-a"] || positionals[0];
		const fb = opts["file-b"] || positionals[1];
		return !!fa && !!fb || "Provide both file paths to compare. Specify file-a and file-b.";
	},
	execute: (dbPath, opts, positionals) => {
		return runDiff(opts["file-a"] || positionals[0], opts["file-b"] || positionals[1], dbPath);
	},
	formatMarkdown: (res) => {
		const urlA = `file://${path.resolve(process.cwd(), res.fileA).replace(/\\/g, "/")}`;
		const urlB = `file://${path.resolve(process.cwd(), res.fileB).replace(/\\/g, "/")}`;
		return [
			`### Spelunk Structural Diff`,
			`- **File A**: [${res.fileA}](${urlA})`,
			`- **File B**: [${res.fileB}](${urlB})`,
			"",
			"#### Exports Changes",
			res.exports.added.length > 0 ? `- **Added**: ${res.exports.added.map((x) => `\`${x}\``).join(", ")}` : "- **Added**: _None_",
			res.exports.removed.length > 0 ? `- **Removed**: ${res.exports.removed.map((x) => `\`${x}\``).join(", ")}` : "- **Removed**: _None_",
			"",
			"#### Imports Changes",
			res.imports.added.length > 0 ? `- **Added**: ${res.imports.added.map((x) => `\`${x}\``).join(", ")}` : "- **Added**: _None_",
			res.imports.removed.length > 0 ? `- **Removed**: ${res.imports.removed.map((x) => `\`${x}\``).join(", ")}` : "- **Removed**: _None_"
		].join("\n");
	}
});

//#endregion
export {  };