import path from "node:path";
import { parseArgs } from "node:util";

export interface CommandConfig<Opts, Res> {
  name: string;
  options?: Record<string, { type: "string" | "boolean"; short?: string; default?: any }>;
  allowPositionals?: boolean;
  validate: (opts: Opts, positionals: string[]) => boolean | string;
  execute: (dbPath: string, opts: Opts, positionals: string[]) => Res | Promise<Res>;
  formatMarkdown: (res: Res, opts: Opts, positionals: string[]) => string;
  formatJson?: (res: Res) => any;
}

export async function runCliCommand<Opts extends Record<string, any>, Res>(
  config: CommandConfig<Opts, Res>,
) {
  const args = process.argv.slice(2);
  let formatVal = "markdown";

  // Check if JSON format is explicitly requested before parsing options
  // (helps format errors as JSON if options parsing itself throws)
  const formatIdx = args.indexOf("--format") !== -1 ? args.indexOf("--format") : args.indexOf("-f");
  if (
    args.includes("-f=json") ||
    args.includes("--format=json") ||
    (formatIdx !== -1 && args[formatIdx + 1] === "json")
  ) {
    formatVal = "json";
  }

  try {
    const parseOptions: Record<string, { type: "string" | "boolean"; short?: string }> = {
      format: { type: "string", short: "f" },
    };

    if (config.options) {
      for (const [key, val] of Object.entries(config.options)) {
        parseOptions[key] = { type: val.type };
        if (val.short !== undefined) {
          parseOptions[key].short = val.short;
        }
      }
    }

    const { values, positionals } = parseArgs({
      args,
      options: parseOptions,
      allowPositionals: config.allowPositionals ?? true,
      strict: true,
    });

    const opts = { ...values } as any;
    opts.format = opts.format || formatVal;
    formatVal = opts.format;

    if (config.options) {
      for (const [key, val] of Object.entries(config.options)) {
        if (opts[key] === undefined && val.default !== undefined) {
          opts[key] = val.default;
        }
      }
    }

    const validationResult = config.validate(opts, positionals);
    if (typeof validationResult === "string") {
      throw new Error(validationResult);
    } else if (!validationResult) {
      throw new Error("Invalid arguments");
    }

    const defaultDbPath = path.join(process.cwd(), ".spelunk", "data.db");
    const dbPath = process.env.SPELUNK_DB_PATH || defaultDbPath;
    const res = await config.execute(dbPath, opts, positionals);

    if (formatVal === "json") {
      const jsonRes = config.formatJson ? config.formatJson(res) : res;
      console.log(JSON.stringify(jsonRes, null, 2));
    } else {
      console.log(config.formatMarkdown(res, opts, positionals));
    }
  } catch (err: any) {
    if (formatVal === "json") {
      console.log(JSON.stringify({ isError: true, message: err.message }, null, 2));
      process.exit(1);
    } else {
      console.error(`${config.name} failed: ${err.message}`);
      process.exit(1);
    }
  }
}
