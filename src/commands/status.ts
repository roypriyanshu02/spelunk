import { runCliCommand, isUpToDate } from "@core";

export interface StatusResult {
  upToDate: boolean;
  reason: string;
}

export const statusCommand = {
  name: "status",
  skipUpToDateCheck: true,
  positionalDirIndex: 0,
  options: {},
  validate: () => true,
  execute: async (dbPath: string, opts: any, positionals: string[]) => {
    const rootDir = opts.dir || positionals[0] || process.cwd();
    const res = await isUpToDate({ rootDir, dbPath });
    if (!res.upToDate) {
      process.exitCode = 1;
    }
    return res;
  },
  formatMarkdown: (res: any) => {
    if (res.upToDate) {
      return `### Spelunk Index Status\n- **Status**: Up-to-date\n- **Details**: ${res.reason}`;
    } else {
      return `### Spelunk Index Status\n- **Status**: Stale (Out-of-date)\n- **Details**: ${res.reason}`;
    }
  },
  formatJson: (res: any) => res,
};

runCliCommand(statusCommand);
