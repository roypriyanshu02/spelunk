import { runCliCommand, runExplain } from "@core";

export interface ExplainResult {
  path: string;
  summary: string;
  stale: boolean;
}

export const explainCommand = {
  name: "explain",
  positionalFileIndices: [0],
  options: {
    file: { type: "string" },
    "set-summary": { type: "string" },
  },
  validate: (opts: any, positionals: any) => {
    return !!opts.file || !!positionals[0] || "Provide a file path to get or set its summary.";
  },
  execute: (dbPath: any, opts: any, positionals: any) => {
    const filePath = opts.file || positionals[0];
    const agentSummary = opts["set-summary"];
    return runExplain(filePath, !!agentSummary, dbPath, agentSummary);
  },
  formatMarkdown: (res: any) => {
    return res.summary;
  },
  formatJson: (res: any) => res,
};

runCliCommand(explainCommand);
