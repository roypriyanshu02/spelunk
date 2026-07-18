#!/usr/bin/env node
import { i as runExplain, t as runCliCommand } from "./common.mjs";

//#region src/commands/explain.ts
/**
* @file explain.ts
* @description CLI command definition to display or set architectural files summaries.
*/
runCliCommand({
	name: "explain",
	options: {
		file: { type: "string" },
		"set-summary": { type: "string" }
	},
	validate: (opts, positionals) => {
		return !!opts.file || !!positionals[0] || "Provide a file path. Specify a file to get or set its summary.";
	},
	execute: (dbPath, opts, positionals) => {
		const f = opts.file || positionals[0];
		const agentSummary = opts["set-summary"];
		return runExplain(f, !!agentSummary, dbPath, agentSummary);
	},
	formatMarkdown: (res) => {
		return res.summary;
	},
	formatJson: (res) => res
});

//#endregion
export {  };