import { runCliCommand, runExport, type FileRecord } from "@core";

export type ExportResult = string | { files: FileRecord[] };

export const exportCommand = {
  name: "export",
  options: {
    format: { type: "string", short: "f" },
  },
  validate: (opts: any, positionals: any) => {
    const rawFormat = opts.format || positionals[0];
    if (!rawFormat) return true;
    const format = typeof rawFormat === "string" ? rawFormat.toLowerCase() : "";
    if (format !== "json" && format !== "md" && format !== "markdown") {
      return "Format must be 'json', 'md', or 'markdown'.";
    }
    return true;
  },
  execute: (dbPath: any, opts: any, positionals: any) => {
    const rawFormat = opts.format || positionals[0];
    const format = typeof rawFormat === "string" ? rawFormat.toLowerCase() : "";
    const exportFormat = format === "json" ? "json" : "md";
    return runExport(exportFormat, dbPath);
  },
  formatMarkdown: (res: any) => {
    return typeof res === "string" ? res : JSON.stringify(res, null, 2);
  },
  formatJson: (res: any) => res,
};

runCliCommand(exportCommand);
