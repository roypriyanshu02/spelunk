import { runCliCommand } from "@core";
import { DatabaseSync } from "node:sqlite";

export const queryCommand = {
  name: "query",
  options: {},
  validate: (opts: any, positionals: any) => {
    if (positionals.length === 0) return "Provide a SQL query statement to run.";
    const sql = positionals[0];
    if (!/^\s*(select|with|pragma|explain)\b/i.test(sql)) {
      return "Only read-only queries (SELECT, WITH, PRAGMA, EXPLAIN) are allowed.";
    }
    return true;
  },
  execute: (dbPath: string, opts: any, positionals: string[]) => {
    const sql = positionals[0];
    const params = positionals.slice(1);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const stmt = db.prepare(sql);
      const rows = stmt.all(...params);
      return rows as Record<string, any>[];
    } finally {
      db.close();
    }
  },
  formatMarkdown: (res: any) => {
    if (!Array.isArray(res) || res.length === 0) {
      return "No results found.";
    }
    const headers = Object.keys(res[0]);
    const markdownHeaders = `| ${headers.join(" | ")} |`;
    const markdownDivider = `| ${headers.map(() => "---").join(" | ")} |`;
    const markdownRows = res.map((row: Record<string, any>) => {
      const values = headers.map((h) => {
        const val = row[h];
        if (val === null || val === undefined) return "";
        if (typeof val === "object") return JSON.stringify(val);
        return String(val);
      });
      return `| ${values.join(" | ")} |`;
    });
    return [markdownHeaders, markdownDivider, ...markdownRows].join("\n");
  },
  formatJson: (res: any) => res,
};

runCliCommand(queryCommand);
