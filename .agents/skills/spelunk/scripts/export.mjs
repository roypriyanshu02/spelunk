#!/usr/bin/env node
import { a as runExport, t as runCliCommand } from "./common.mjs";

//#region src/commands/export.ts
/**
* @file export.ts
* @description CLI command definition to dump the complete index structure in JSON or Markdown formats.
*/
runCliCommand({
	name: "export",
	options: { format: {
		type: "string",
		short: "f"
	} },
	validate: (opts, positionals) => {
		const f = opts.format || positionals[0];
		if (f !== "json" && f !== "md" && f !== "markdown") return "Format must be 'json', 'md', or 'markdown'.";
		return true;
	},
	execute: (dbPath, opts, positionals) => {
		const exportFormat = (opts.format || positionals[0]) === "json" ? "json" : "md";
		opts.format = exportFormat === "json" ? "json" : "markdown";
		return runExport(exportFormat, dbPath);
	},
	formatMarkdown: (res) => {
		return typeof res === "string" ? res : JSON.stringify(res, null, 2);
	},
	formatJson: (res) => res
});

//#endregion
export {  };