/**
 * @file scan.ts
 * @description CLI command definition to trigger recursive source directories scanning and AST indexing.
 */
import { runCliCommand, scanDirectory } from "@core";

runCliCommand({
  name: "scan",
  options: {
    dir: { type: "string" },
    concurrency: { type: "string" },
  },
  validate: (opts: any) => {
    if (opts.concurrency) {
      const parsed = parseInt(opts.concurrency, 10);
      if (isNaN(parsed) || parsed <= 0) {
        return "Provide a valid concurrency limit. Concurrency must be a positive integer.";
      }
    }
    return true;
  },
  execute: (dbPath, opts: any, positionals) => {
    const rootDir = opts.dir || positionals[0] || process.cwd();
    const concurrency = opts.concurrency ? parseInt(opts.concurrency, 10) : undefined;
    return scanDirectory({ rootDir, dbPath, concurrency });
  },
  formatMarkdown: (res) => {
    const duration = res.metrics ? `${(res.metrics.durationMs / 1000).toFixed(2)}s` : "N/A";
    const speed = res.metrics ? `${res.metrics.filesPerSecond.toFixed(1)} files/s` : "N/A";
    return [
      "### Spelunk Scan Completed",
      `- **Total files found**: ${res.fileCount}`,
      `- **Parsed (new or changed)**: ${res.parsedCount}`,
      `- **Unchanged (cached)**: ${res.unchangedCount}`,
      `- **Skipped / Parse errors**: ${res.skippedCount}`,
      `- **Scan duration**: ${duration} (${speed})`,
    ].join("\n");
  },
});
