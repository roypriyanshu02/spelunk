#!/usr/bin/env node
import { s as runOutline, t as runCliCommand } from "./common.mjs";
import path from "node:path";

//#region src/commands/outline.ts
/**
* @file outline.ts
* @description CLI command definition to output imports and exports mapping for a specific file.
*/
runCliCommand({
	name: "outline",
	options: { file: { type: "string" } },
	validate: (opts, positionals) => {
		return !!opts.file || !!positionals[0] || "Provide a file path. Specify a file to generate its outline.";
	},
	execute: (dbPath, opts, positionals) => {
		return runOutline(opts.file || positionals[0], dbPath);
	},
	formatMarkdown: (res, opts, positionals) => {
		const f = opts.file || positionals[0];
		if (!res.files || res.files.length === 0) return `### File not found or not indexed: \`${f}\``;
		const record = res.files[0];
		const fileUrl = `file://${path.resolve(process.cwd(), record.path).replace(/\\/g, "/")}`;
		const lines = [`### Spelunk Outline for [${record.path}](${fileUrl})`, `- **Parsed**: ${record.parsed ? "Yes" : "No"}`];
		if (record.reason) lines.push(`- **Skip Reason**: ${record.reason}`);
		if (record.hash) lines.push(`- **Content Hash**: \`${record.hash}\``);
		const exportsStr = record.exports.length > 0 ? record.exports.map((e) => `\`${e}\``).join(", ") : "_None_";
		lines.push(`- **Exports**: ${exportsStr}`);
		const importsStr = record.imports.length > 0 ? record.imports.map((i) => `\`${i}\``).join(", ") : "_None_";
		lines.push(`- **Imports**: ${importsStr}`);
		if (record.summary) lines.push(`- **Cached Summary**: ${record.summary}`);
		return lines.join("\n");
	}
});

//#endregion
export {  };