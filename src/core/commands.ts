import path from "node:path";
import { parseArgs } from "node:util";
import fs from "node:fs";
import { isUpToDate } from "./scanner";
import { clearWasmCache } from "./parser/index";
import { SpelunkDB } from "./db";

export interface CommandConfig<Opts, Res> {
  name: string;
  options?: Record<string, { type: string; short?: string; default?: any }>;
  allowPositionals?: boolean;
  skipUpToDateCheck?: boolean;
  positionalFileIndices?: number[];
  positionalDirIndex?: number;
  validate: (opts: Opts, positionals: string[]) => boolean | string;
  execute: (dbPath: string, opts: Opts, positionals: string[]) => Res | Promise<Res>;
  formatMarkdown: (res: Res, opts: Opts, positionals: string[]) => string;
  formatJson?: (res: Res) => any;
}

const commandRegistry = new Map<string, CommandConfig<any, any>>();

export function getCommand(name: string): CommandConfig<any, any> | undefined {
  return commandRegistry.get(name);
}

export function isPathContained(parent: string, child: string): boolean {
  let resolvedChild = child;
  try {
    resolvedChild = fs.realpathSync(child);
  } catch {
    resolvedChild = path.resolve(child);
  }
  let resolvedParent = parent;
  try {
    resolvedParent = fs.realpathSync(parent);
  } catch {
    resolvedParent = path.resolve(parent);
  }
  const relative = path.relative(resolvedParent, resolvedChild);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export interface CliContext {
  args: string[];
  env: Record<string, string | undefined>;
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
  exit: (code: number) => void;
}

export async function runCliCommandWithContext<Opts extends Record<string, any>, Res>(
  config: CommandConfig<Opts, Res>,
  ctx: CliContext,
) {
  const args = ctx.args;
  let formatVal = "markdown";

  try {
    const parseOptions: Record<string, { type: "string" | "boolean"; short?: string }> = {
      format: { type: "string", short: "f" },
      dir: { type: "string" },
      "no-download": { type: "boolean" },
      "force-fallback": { type: "boolean" },
      "clear-wasm-cache": { type: "boolean" },
    };

    if (config.options) {
      for (const [key, val] of Object.entries(config.options)) {
        parseOptions[key] = { type: val.type as "string" | "boolean" };
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

    if (opts["no-download"]) {
      if (ctx.env) {
        ctx.env.SPELUNK_OFFLINE = "1";
      }
    }

    if (opts["force-fallback"]) {
      if (ctx.env) {
        ctx.env.SPELUNK_FORCE_FALLBACK = "1";
      }
    }

    if (opts["clear-wasm-cache"]) {
      clearWasmCache();
      ctx.log("[spelunk] WASM cache cleared.");
      ctx.exit(0);
      return;
    }
    if (opts.format) {
      formatVal = opts.format;
    }

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
      const optionKeys = Object.keys(config.options || {});
      const providedOpt = optionKeys.find((k) => opts[k] !== undefined);
      const invalidParam =
        providedOpt || optionKeys[0] || (positionals.length > 0 ? positionals[0] : "arguments");
      throw new Error(
        `Invalid argument for parameter '${invalidParam}'. Check spelling or values.`,
      );
    }

    if (!opts.format && config.name === "export" && positionals[0]) {
      opts.format = positionals[0];
    }
    opts.format = opts.format || formatVal;
    formatVal = opts.format;

    const defaultDbPath = path.join(process.cwd(), ".spelunk", "data.db");
    const dbPath = ctx.env.SPELUNK_DB_PATH || defaultDbPath;

    let rootDir = process.cwd();
    if (fs.existsSync(dbPath)) {
      try {
        const db = new SpelunkDB(dbPath);
        rootDir = db.getMetadata("rootDir") || process.cwd();
        db.close();
      } catch {}
    }
    opts.rootDir = rootDir;

    if (!config.skipUpToDateCheck) {
      try {
        const rootDirPos =
          config.positionalDirIndex !== undefined
            ? positionals[config.positionalDirIndex]
            : undefined;
        const rootDir = opts.dir || rootDirPos || process.cwd();
        const resolvedRootDir = path.resolve(rootDir);

        const checkContained = (filePath: string) => {
          const resolvedPath = path.resolve(resolvedRootDir, filePath);
          return isPathContained(resolvedRootDir, resolvedPath);
        };

        const filesToCheck: string[] = [];
        if (opts.file && checkContained(opts.file)) filesToCheck.push(opts.file);
        const fileA = opts.fileA || opts["file-a"];
        const fileB = opts.fileB || opts["file-b"];
        if (fileA && checkContained(fileA)) filesToCheck.push(fileA);
        if (fileB && checkContained(fileB)) filesToCheck.push(fileB);

        if (config.positionalFileIndices) {
          for (const idx of config.positionalFileIndices) {
            const filePos = positionals[idx];
            if (filePos && typeof filePos === "string" && checkContained(filePos)) {
              filesToCheck.push(filePos);
            }
          }
        }

        // Dynamically detect any path-like arguments referencing files on disk
        for (const arg of positionals) {
          if (
            typeof arg === "string" &&
            arg.includes(".") &&
            checkContained(arg) &&
            fs.existsSync(path.resolve(resolvedRootDir, arg))
          ) {
            filesToCheck.push(arg);
          }
        }

        const check = await isUpToDate({
          rootDir: resolvedRootDir,
          dbPath,
          filesToCheck: filesToCheck.length > 0 ? filesToCheck : undefined,
        });
        if (!check.upToDate && formatVal !== "json") {
          ctx.error(
            `Warning: Cached index is out-of-date (${check.reason}). Run 'spelunk scan' to update.`,
          );
        }
      } catch {
        // ignore check failures
      }
    }

    const res = await config.execute(dbPath, opts, positionals);

    if (config.name === "explain" && res && (res as any).stale && formatVal !== "json") {
      ctx.error(`Warning: Cached summary for ${(res as any).path} is stale (file modified).`);
    }

    if (formatVal === "json") {
      const jsonRes = config.formatJson ? config.formatJson(res) : res;
      ctx.log(JSON.stringify(jsonRes, null, 2));
    } else {
      ctx.log(config.formatMarkdown(res, opts, positionals));
    }
  } catch (err: any) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (formatVal === "json") {
      ctx.log(JSON.stringify({ isError: true, message: errMsg }, null, 2));
      ctx.exit(1);
    } else {
      ctx.error(`${config.name} failed: ${errMsg}`);
      ctx.exit(1);
    }
  }
}

export async function runCliCommand<Opts extends Record<string, any>, Res>(
  config: CommandConfig<Opts, Res>,
) {
  commandRegistry.set(config.name, config);

  if (process.env.VITEST === "true") {
    return;
  }

  await runCliCommandWithContext(config, {
    args: process.argv.slice(2),
    env: process.env,
    log: console.log,
    error: console.error,
    exit: process.exit,
  });
}
