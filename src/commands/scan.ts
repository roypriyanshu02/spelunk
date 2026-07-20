import { runCliCommand, scanDirectory, watchDirectory } from "@core";

export interface ScanResult {
  fileCount: number;
  parsedCount: number;
  unchangedCount: number;
  skippedCount: number;
  metrics?: {
    durationMs: number;
    filesPerSecond: number;
    cacheHitRatio: number;
    memoryUsageMb: number;
  };
}

export const scanCommand = {
  name: "scan",
  skipUpToDateCheck: true,
  positionalDirIndex: 0,
  options: {
    concurrency: { type: "string" },
    watch: { type: "boolean", short: "w" },
  },
  validate: (opts: any) => {
    if (opts.concurrency) {
      const parsed = parseInt(opts.concurrency, 10);
      if (isNaN(parsed) || parsed <= 0) {
        return "Concurrency limit must be a positive integer.";
      }
    }
    return true;
  },
  execute: (dbPath: string, opts: any, positionals: string[]) => {
    const rootDir = opts.dir || positionals[0] || process.cwd();
    const concurrency = opts.concurrency ? parseInt(opts.concurrency, 10) : undefined;
    const offline = opts["no-download"];
    const forceFallback = opts["force-fallback"];
    if (opts.watch) {
      return watchDirectory({ rootDir, dbPath, concurrency, offline, forceFallback });
    }
    return scanDirectory({ rootDir, dbPath, concurrency, offline, forceFallback });
  },
  formatMarkdown: (res: any) => {
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
};

runCliCommand(scanCommand);
