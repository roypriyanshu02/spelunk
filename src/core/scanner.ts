import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ignore from "ignore";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFilePromise = promisify(execFile);
import { SpelunkDB, type FileRecord } from "./db";
import { isPathContained } from "./commands";
import { parseFile } from "./parser";
import { loadConfig, createMatchPath } from "tsconfig-paths";

const MAX_DEPTH = 100;
const MAX_FILES = 50000;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB

const DEFAULT_IGNORES = [
  ".git/**",
  "node_modules/**",
  ".bun/**",
  ".cache/**",
  "dist/**",
  ".spelunk/**",
  "**/.spelunk/**",
  "**/.git/**",
  "**/node_modules/**",
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/credentials.json",
  "**/gcloud.json",
  "**/*.pfx",
  "**/*.p12",
  "**/.venv/**",
  "**/venv/**",
  "**/.env/**",
  "**/env/**",
  "**/.direnv/**",
  "**/.vscode/**",
  "**/.idea/**",
  "**/.serverless/**",
  "**/.aws/credentials",
  "**/.npmrc",
  "**/.yarnrc",
  "**/yarn-error.log",
  "**/npm-debug.log",
];

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code !== "ESRCH";
  }
}

interface WalkContext {
  rootDir: string;
  resolvedRootDir: string;
  ig: ReturnType<typeof ignore>;
  seenRealPaths: Set<string>;
  disableGitignore?: boolean;
  maxDepth?: number;
  silent?: boolean;
  onFile: (filePath: string, relativePath: string) => boolean | Promise<boolean>;
}

async function loadIgnoreRules(
  dirPath: string,
  ig: ReturnType<typeof ignore>,
  disableGitignore = false,
): Promise<boolean> {
  let hasIgnore = false;
  const ignoreFileNames = disableGitignore ? [".spelunkignore"] : [".gitignore", ".spelunkignore"];
  for (const ignoreFileName of ignoreFileNames) {
    try {
      const content = await fs.promises.readFile(path.join(dirPath, ignoreFileName), "utf-8");
      if (content) {
        ig.add(content);
        hasIgnore = true;
      }
    } catch {}
  }
  return hasIgnore;
}

async function walkDirectory(
  currentDir: string,
  depth: number,
  parentIgContexts: { dirPath: string; ig: ReturnType<typeof ignore> }[],
  ctx: WalkContext,
): Promise<boolean> {
  const maxDepth = ctx.maxDepth ?? MAX_DEPTH;
  if (depth > maxDepth) {
    if (!ctx.silent) {
      console.error(
        "Recursion limit exceeded. Check for circular symlinks or deeply nested folders.",
      );
    }
    return true;
  }

  const myIgContexts = [...parentIgContexts];
  const localIg = ignore();
  const hasLocalIgnore = await loadIgnoreRules(currentDir, localIg, ctx.disableGitignore);
  if (hasLocalIgnore) {
    myIgContexts.push({
      dirPath: currentDir,
      ig: localIg,
    });
  }

  let entries;
  try {
    entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  } catch {
    return true;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(ctx.rootDir, fullPath).replace(/\\/g, "/");

    // Check root gitignore using relative path
    if (ctx.ig.ignores(relativePath)) {
      continue;
    }

    // Check nested gitignores
    let ignoredByNested = false;
    for (const pctx of myIgContexts) {
      const pathRelToGitignore = path.relative(pctx.dirPath, fullPath).replace(/\\/g, "/");
      if (pctx.ig.ignores(pathRelToGitignore)) {
        ignoredByNested = true;
        break;
      }
    }
    if (ignoredByNested) {
      continue;
    }

    if (entry.isDirectory()) {
      let realPath;
      try {
        realPath = await fs.promises.realpath(fullPath);
      } catch {
        continue;
      }

      if (ctx.seenRealPaths.has(realPath)) {
        continue;
      }

      // Prevent escaping rootDir
      if (!isPathContained(ctx.resolvedRootDir, realPath)) {
        continue;
      }

      ctx.seenRealPaths.add(realPath);

      const keepGoing = await walkDirectory(fullPath, depth + 1, myIgContexts, ctx);
      if (!keepGoing) {
        return false;
      }
    } else if (entry.isFile()) {
      const keepGoing = await ctx.onFile(fullPath, relativePath);
      if (!keepGoing) {
        return false;
      }
    }
  }
  return true;
}

export interface ScanOptions {
  rootDir: string;
  dbPath?: string;
  silent?: boolean;
  concurrency?: number;
  customIgnore?: string | string[];
  noGitignore?: boolean;
  wasmDir?: string;
  offline?: boolean;
  forceFallback?: boolean;
  filesToScan?: string[];
}

export async function scanDirectory(options: ScanOptions): Promise<{
  fileCount: number;
  parsedCount: number;
  skippedCount: number;
  unchangedCount: number;
  metrics?: {
    durationMs: number;
    filesPerSecond: number;
    cacheHitRatio: number;
    memoryUsageMb: number;
  };
}> {
  const startTime = performance.now();
  const rootDir = path.resolve(options.rootDir);
  const resolvedRootDir = await fs.promises.realpath(rootDir);
  const dbPath = options.dbPath || path.join(rootDir, ".spelunk", "data.db");
  const db = new SpelunkDB(dbPath);

  // Interrupted / concurrent scan check
  const lastScanStatus = db.getMetadata("scanStatus");
  const lastScanPidStr = db.getMetadata("scanPid");
  if (lastScanStatus === "running") {
    const lastScanPid = lastScanPidStr ? parseInt(lastScanPidStr, 10) : null;
    if (lastScanPid && isProcessAlive(lastScanPid) && lastScanPid !== process.pid) {
      db.close();
      throw new Error(
        `Another scan is currently running (PID: ${lastScanPid}). Concurrency on the same index is not allowed.`,
      );
    } else if (!options.silent) {
      console.warn("[spelunk] A previous scan was interrupted or crashed. Restarting the scan.");
    }
  }
  db.setMetadata("scanStatus", "running");
  db.setMetadata("scanPid", String(process.pid));

  const sigHandler = () => {
    try {
      const cleanupDb = new SpelunkDB(dbPath);
      cleanupDb.setMetadata("scanStatus", "interrupted");
      cleanupDb.close();
    } catch {}
    process.exit(1);
  };
  process.on("SIGINT", sigHandler);
  process.on("SIGTERM", sigHandler);

  const ig = ignore();

  let fileCount = 0;
  let parsedCount = 0;
  let skippedCount = 0;
  let unchangedCount = 0;

  let spelunkIgnoreContent = "";
  try {
    spelunkIgnoreContent = await fs.promises.readFile(
      path.join(rootDir, ".spelunkignore"),
      "utf-8",
    );
  } catch {}

  const disableGitignore =
    options.noGitignore ||
    spelunkIgnoreContent.split("\n").some((line) => line.trim() === ".gitignore");

  await loadIgnoreRules(rootDir, ig, disableGitignore);

  if (options.customIgnore) {
    ig.add(options.customIgnore);
  }

  // Always ignore .git, node_modules, secrets, and Spelunk's own db
  ig.add(DEFAULT_IGNORES);

  const seenRealPaths = new Set<string>();
  const seenPaths = new Set<string>();
  if (options.filesToScan) {
    const allDbPaths = db.getAllPaths();
    for (const p of allDbPaths) {
      seenPaths.add(p);
    }
  }
  const filesToProcess: { fullPath: string; relativePath: string }[] = [];

  const walkCtx: WalkContext = {
    rootDir,
    resolvedRootDir,
    ig,
    seenRealPaths,
    disableGitignore,
    silent: options.silent,
    onFile: (fullPath, relativePath) => {
      if (fileCount >= MAX_FILES) {
        if (!options.silent) {
          console.error("File limit exceeded. Spelunk supports a maximum of 50,000 files.");
        }
        return false;
      }
      fileCount++;
      seenPaths.add(relativePath);
      filesToProcess.push({ fullPath, relativePath });
      return true;
    },
  };

  const recordsToUpsert: FileRecord[] = [];
  const deletedPaths: string[] = [];

  async function processFile(file: {
    fullPath: string;
    relativePath: string;
  }): Promise<FileRecord | null> {
    const { fullPath, relativePath } = file;
    let stat;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch {
      return null;
    }

    const existingRecord = db.getFile(relativePath);
    const summary = existingRecord?.summary || null;

    if (
      existingRecord &&
      existingRecord.size === stat.size &&
      existingRecord.mtime === stat.mtime.getTime()
    ) {
      unchangedCount++;
      return null;
    }

    if (stat.size > MAX_FILE_SIZE) {
      const hash = `${stat.size}-${stat.mtime.getTime()}`;
      skippedCount++;
      return {
        path: relativePath,
        parsed: false,
        reason: "exceeds size limit",
        exports: [],
        imports: [],
        summary,
        summary_hash: existingRecord?.summary_hash || null,
        hash,
        mtime: stat.mtime.getTime(),
        size: stat.size,
      };
    }

    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(fullPath);
    } catch (err: any) {
      skippedCount++;
      return {
        path: relativePath,
        parsed: false,
        reason: `read error: ${err.message}`,
        exports: [],
        imports: [],
        summary,
        summary_hash: existingRecord?.summary_hash || null,
        mtime: stat.mtime.getTime(),
        size: stat.size,
      };
    }

    // Fast check for binary file using the buffer directly (single-pass read)
    const isBinary = buffer.subarray(0, 1024).includes(0);

    if (isBinary) {
      const hash = `${stat.size}-${stat.mtime.getTime()}`;
      skippedCount++;
      return {
        path: relativePath,
        parsed: false,
        reason: "binary file",
        exports: [],
        imports: [],
        summary,
        summary_hash: existingRecord?.summary_hash || null,
        hash,
        mtime: stat.mtime.getTime(),
        size: stat.size,
      };
    }

    const content = buffer.toString("utf-8");
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");

    if (existingRecord && existingRecord.hash === hash) {
      unchangedCount++;
      return null;
    }

    try {
      const { imports, exports } = await parseFile(fullPath, content, {
        wasmDir: options.wasmDir,
        offline: options.offline,
        forceFallback: options.forceFallback,
      });
      parsedCount++;
      return {
        path: relativePath,
        parsed: true,
        hash,
        imports,
        exports,
        summary,
        summary_hash: existingRecord?.summary_hash || null,
        mtime: stat.mtime.getTime(),
        size: stat.size,
      };
    } catch (err: any) {
      skippedCount++;
      return {
        path: relativePath,
        parsed: false,
        reason: `parse error: ${err.message}`,
        hash,
        exports: [],
        imports: [],
        summary,
        summary_hash: existingRecord?.summary_hash || null,
        mtime: stat.mtime.getTime(),
        size: stat.size,
      };
    }
  }

  try {
    if (options.filesToScan) {
      for (const p of options.filesToScan) {
        const rel = p.replace(/\\/g, "/");
        if (ig.ignores(rel)) continue;
        const full = path.resolve(rootDir, rel);
        if (!fs.existsSync(full)) {
          deletedPaths.push(rel);
        } else {
          filesToProcess.push({ fullPath: full, relativePath: rel });
          seenPaths.add(rel);
        }
      }
    } else {
      await walkDirectory(rootDir, 0, [], walkCtx);
    }

    const concurrencyLimit =
      options.concurrency && options.concurrency > 0 ? options.concurrency : 8;
    let processedCount = 0;
    const totalFiles = filesToProcess.length;

    let fileIdx = 0;
    // Worker function that processes items from filesToProcess queue
    const worker = async () => {
      while (fileIdx < totalFiles) {
        const file = filesToProcess[fileIdx++];
        if (!file) break;

        try {
          const record = await processFile(file);
          if (record) {
            recordsToUpsert.push(record);
          }
        } catch {
          // ignore individual file processing errors to ensure scan completes
        } finally {
          processedCount++;
          if (!options.silent && totalFiles > 0) {
            const step = Math.max(20, Math.floor(totalFiles / 10));
            if (processedCount % step === 0 || processedCount === totalFiles) {
              console.log(
                `Scan progress: ${processedCount} of ${totalFiles} files processed (${Math.round((processedCount / totalFiles) * 100)}%)...`,
              );
            }
          }
        }
      }
    };

    // Spin up parallel workers up to the concurrency limit
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(concurrencyLimit, totalFiles); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    if (recordsToUpsert.length > 0) {
      db.upsertFiles(recordsToUpsert);
    }

    // Prune stale records
    if (options.filesToScan) {
      if (deletedPaths.length > 0) {
        db.deleteFiles(deletedPaths);
      }
    } else {
      const allPaths = db.getAllPaths();
      const toDelete = allPaths.filter((filePath) => !seenPaths.has(filePath));
      if (toDelete.length > 0) {
        db.deleteFiles(toDelete);
      }
    }

    // Save rootDir in DB metadata
    db.setMetadata("rootDir", rootDir);

    db.setMetadata("lastScanTime", new Date().toISOString());

    // Save last git commit if in a git repository
    try {
      const { stdout: gitCommitOut } = await execFilePromise("git", ["rev-parse", "HEAD"], {
        cwd: rootDir,
      });
      db.setMetadata("lastGitCommit", gitCommitOut.trim());
    } catch {
      // Not a git repo or git not installed
    }

    // Incremental dependency graph update
    if (recordsToUpsert.length > 0) {
      const configLoaderResult = loadConfig(rootDir);
      const matchPath =
        configLoaderResult.resultType === "success"
          ? createMatchPath(configLoaderResult.absoluteBaseUrl, configLoaderResult.paths)
          : null;

      const resolvedImportCache = new Map<string, string>();

      const resolveImport = (sourcePath: string, importStr: string): string | null => {
        const cacheKey = `${sourcePath}:${importStr}`;
        const cached = resolvedImportCache.get(cacheKey);
        if (cached !== undefined) {
          return cached || null;
        }

        let resolved: string | undefined;

        if (importStr.startsWith(".")) {
          resolved = path.resolve(path.dirname(path.resolve(rootDir, sourcePath)), importStr);
        } else if (matchPath) {
          resolved = matchPath(importStr, undefined, undefined, [".ts", ".tsx", ".js", ".jsx"]);
        }

        if (!resolved) {
          resolved = path.resolve(rootDir, importStr.replace(/^@\//, "").replace(/^~\//, ""));
        }

        const candidates = [
          resolved,
          `${resolved}.ts`,
          `${resolved}.tsx`,
          `${resolved}.js`,
          `${resolved}.jsx`,
          path.join(resolved, "index.ts"),
          path.join(resolved, "index.tsx"),
          path.join(resolved, "index.js"),
        ];

        for (const c of candidates) {
          if (!isPathContained(rootDir, c)) continue;
          const normalized = path.relative(rootDir, c).replace(/\\/g, "/");
          if (seenPaths.has(normalized)) {
            resolvedImportCache.set(cacheKey, normalized);
            return normalized;
          }
        }
        resolvedImportCache.set(cacheKey, "");
        return null;
      };

      const importsMap = new Map<string, string[]>();
      for (const f of recordsToUpsert) {
        const resolved: string[] = [];
        for (const imp of f.imports) {
          const resPath = resolveImport(f.path, imp);
          if (resPath) {
            resolved.push(resPath);
          }
        }
        importsMap.set(f.path, resolved);
      }

      db.updateFilesImports(importsMap);
    }

    const durationMs = performance.now() - startTime;
    const filesPerSecond = durationMs > 0 ? fileCount / (durationMs / 1000) : 0;
    const cacheHitRatio = fileCount > 0 ? unchangedCount / fileCount : 0;
    const memoryUsageMb = process.memoryUsage().heapUsed / 1024 / 1024;

    db.pruneStaleImports();
    return {
      fileCount,
      parsedCount,
      skippedCount,
      unchangedCount,
      metrics: {
        durationMs,
        filesPerSecond,
        cacheHitRatio,
        memoryUsageMb,
      },
    };
  } finally {
    process.off("SIGINT", sigHandler);
    process.off("SIGTERM", sigHandler);
    try {
      db.setMetadata("scanStatus", "completed");
    } catch {
      // ignore
    }
    db.close();
  }
}

/**
 * Checks if the indexed database is up-to-date with the files in the directory.
 * If specific files are provided, it only checks those files.
 *
 * @param options Object containing rootDir, optional dbPath, and optional filesToCheck array
 * @returns Promise resolving to an object with upToDate boolean and a string reason
 */
export async function isUpToDate(options: {
  rootDir: string;
  dbPath?: string;
  filesToCheck?: string[];
}): Promise<{
  upToDate: boolean;
  reason: string;
}> {
  const rootDir = path.resolve(options.rootDir);
  const dbPath = options.dbPath || path.join(rootDir, ".spelunk", "data.db");

  if (!fs.existsSync(dbPath)) {
    return { upToDate: false, reason: "Database does not exist. Run scan first." };
  }

  const db = new SpelunkDB(dbPath);
  try {
    const lastScanStatus = db.getMetadata("scanStatus");
    if (lastScanStatus !== "completed") {
      return { upToDate: false, reason: `Last scan status is '${lastScanStatus || "unknown"}'.` };
    }

    const dbFiles = new Map<string, { size: number; mtime: number }>();
    for (const f of db.getAllFiles()) {
      if (typeof f.size === "number" && typeof f.mtime === "number") {
        dbFiles.set(f.path, { size: f.size, mtime: f.mtime });
      }
    }

    const filesSet = options.filesToCheck
      ? new Set(
          options.filesToCheck.map((f) =>
            path.relative(rootDir, path.resolve(rootDir, f)).replace(/\\/g, "/"),
          ),
        )
      : null;

    // Set up standard ignores
    const ig = ignore().add(DEFAULT_IGNORES);

    await loadIgnoreRules(rootDir, ig);

    // Try Git check first (instant)
    let isGit = false;
    try {
      await execFilePromise("git", ["rev-parse", "--is-inside-work-tree"], { cwd: rootDir });
      isGit = true;
    } catch {}

    if (isGit) {
      try {
        const { stdout: commitOut } = await execFilePromise("git", ["rev-parse", "HEAD"], {
          cwd: rootDir,
        });
        const currentCommit = commitOut.trim();
        const lastCommit = db.getMetadata("lastGitCommit");
        const safeLastCommit =
          typeof lastCommit === "string" && /^[a-f0-9]{40}$/i.test(lastCommit)
            ? lastCommit
            : "HEAD";
        if (currentCommit !== lastCommit) {
          if (filesSet) {
            const { stdout: diffOut } = await execFilePromise(
              "git",
              ["diff", "--name-only", safeLastCommit, "HEAD"],
              {
                cwd: rootDir,
              },
            );
            const diffFiles = diffOut
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);
            for (const df of diffFiles) {
              if (filesSet.has(df)) {
                return {
                  upToDate: false,
                  reason: `File changed in Git since last scan: ${df}`,
                };
              }
            }
          } else {
            return {
              upToDate: false,
              reason: `Git HEAD has changed (last scanned: ${lastCommit || "none"}, current: ${currentCommit}).`,
            };
          }
        }

        const { stdout: statusOut } = await execFilePromise("git", ["status", "--porcelain"], {
          cwd: rootDir,
        });
        const cleanStatusOut = statusOut.trim();
        if (cleanStatusOut.length > 0) {
          const { stdout: gitRootOut } = await execFilePromise(
            "git",
            ["rev-parse", "--show-toplevel"],
            { cwd: rootDir },
          );
          const gitRoot = gitRootOut.trim();
          const lines = cleanStatusOut
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          for (const line of lines) {
            const status = line.substring(0, 2);
            const gitRelPath = line.substring(3).trim().replace(/^"|"$/g, "");
            const absPath = path.resolve(gitRoot, gitRelPath);
            const relPath = path.relative(rootDir, absPath).replace(/\\/g, "/");

            if (!isPathContained(rootDir, absPath)) continue;
            if (ig.ignores(relPath)) continue;
            if (filesSet && !filesSet.has(relPath)) continue;

            // If the file is modified or deleted or renamed
            if (
              status.startsWith("M") ||
              status.endsWith("M") ||
              status.startsWith("D") ||
              status.endsWith("D") ||
              status.startsWith("R")
            ) {
              return {
                upToDate: false,
                reason: `Git status reports file change: ${relPath} (${status})`,
              };
            }

            // If the file is untracked
            if (status === "??") {
              const cached = dbFiles.get(relPath);
              if (!cached) {
                return { upToDate: false, reason: `New untracked file detected: ${relPath}` };
              }
              try {
                const stat = fs.statSync(absPath);
                if (stat.size !== cached.size || stat.mtime.getTime() !== cached.mtime) {
                  return { upToDate: false, reason: `Untracked file modified: ${relPath}` };
                }
              } catch {
                return { upToDate: false, reason: `Error reading untracked file: ${relPath}` };
              }
            }
          }
        }

        return {
          upToDate: true,
          reason: "Git HEAD matches last scan and working directory is clean.",
        };
      } catch {
        // Fall back if git command fails for some reason
      }
    }

    // Non-git filesystem check
    if (filesSet) {
      for (const relPath of filesSet) {
        if (ig.ignores(relPath)) continue;
        const cached = dbFiles.get(relPath);
        const fullPath = path.resolve(rootDir, relPath);
        const exists = fs.existsSync(fullPath);

        if (cached && !exists) {
          return { upToDate: false, reason: `File deleted: ${relPath}` };
        }
        if (!cached && exists) {
          return { upToDate: false, reason: `New file detected: ${relPath}` };
        }
        if (cached && exists) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size !== cached.size || stat.mtime.getTime() !== cached.mtime) {
              return { upToDate: false, reason: `File modified: ${relPath}` };
            }
          } catch {
            return { upToDate: false, reason: `Error reading file: ${relPath}` };
          }
        }
      }
      return { upToDate: true, reason: "All specified files match the indexed database." };
    }

    // Non-git full walk fallback
    const seenPaths = new Set<string>();
    let upToDate = true;
    let changeReason = "";

    const walkCheckCtx: WalkContext = {
      rootDir,
      resolvedRootDir: path.resolve(rootDir),
      ig,
      seenRealPaths: new Set<string>(),
      onFile: (fullPath, relativePath) => {
        seenPaths.add(relativePath);
        const cached = dbFiles.get(relativePath);
        if (!cached) {
          upToDate = false;
          changeReason = `New file detected: ${relativePath}`;
          return false;
        }
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size !== cached.size || stat.mtime.getTime() !== cached.mtime) {
            upToDate = false;
            changeReason = `File modified: ${relativePath}`;
            return false;
          }
        } catch {
          upToDate = false;
          changeReason = `Error reading file: ${relativePath}`;
          return false;
        }
        return true;
      },
    };

    await walkDirectory(rootDir, 0, [], walkCheckCtx);

    if (!upToDate) {
      return { upToDate: false, reason: changeReason };
    }

    // Check for deleted files
    for (const path of dbFiles.keys()) {
      if (!seenPaths.has(path)) {
        return { upToDate: false, reason: `File deleted: ${path}` };
      }
    }

    return { upToDate: true, reason: "All files match the indexed database." };
  } finally {
    db.close();
  }
}

/**
 * Watches the root directory for any file changes and triggers incremental scans.
 * Uses a debounced filesystem watcher to avoid multiple scans in quick succession.
 *
 * @param options Scan options including rootDir, dbPath, optional debounceMs, and optional AbortSignal
 * @returns Promise resolving when the watcher has been stopped or aborted
 */
export async function watchDirectory(
  options: ScanOptions & { debounceMs?: number; signal?: AbortSignal },
): Promise<void> {
  const rootDir = path.resolve(options.rootDir);

  if (!options.silent) {
    console.log(`[Watcher] Starting Spelunk watcher on ${rootDir}...`);
  }

  // Initial scan
  await scanDirectory(options);

  let timeout: NodeJS.Timeout | null = null;
  const changedFiles = new Set<string>();

  const processChanges = async () => {
    if (changedFiles.size === 0) return;
    const filesToScan = Array.from(changedFiles);
    changedFiles.clear();

    if (!options.silent) {
      console.log(`[Watcher] Detected changes (${filesToScan.length} files). Updating index...`);
    }

    try {
      const res = await scanDirectory({
        ...options,
        filesToScan,
        silent: true,
      });
      if (!options.silent) {
        console.log(
          `[Watcher] Index updated (${res.parsedCount} parsed, ${res.unchangedCount} unchanged, ${res.skippedCount} skipped in ${(res.metrics?.durationMs || 0).toFixed(0)}ms).`,
        );
      }
    } catch (err: any) {
      if (!options.silent) {
        console.error(`[Watcher] Incremental update error: ${err.message}`);
      }
    }
  };

  const watcher = fs.watch(rootDir, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    const normalized = filename.replace(/\\/g, "/");

    if (
      normalized.includes(".git/") ||
      normalized.includes("node_modules/") ||
      normalized.includes(".spelunk/") ||
      normalized.includes(".venv/") ||
      normalized.includes("venv/") ||
      normalized.includes(".env")
    ) {
      return;
    }

    changedFiles.add(normalized);

    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(processChanges, options.debounceMs || 300);
  });

  return new Promise<void>((resolve, reject) => {
    const sigHandler = () => {
      try {
        watcher.close();
      } catch {}
      if (timeout) clearTimeout(timeout);
      if (!options.silent) {
        console.log("[Watcher] Stopped watching directory.");
      }
      process.exit(0);
    };

    process.on("SIGINT", sigHandler);
    process.on("SIGTERM", sigHandler);

    if (options.signal) {
      if (options.signal.aborted) {
        try {
          watcher.close();
        } catch {}
        if (timeout) clearTimeout(timeout);
        process.off("SIGINT", sigHandler);
        process.off("SIGTERM", sigHandler);
        reject(new Error("Aborted"));
        return;
      }
      options.signal.addEventListener("abort", () => {
        try {
          watcher.close();
        } catch {}
        if (timeout) clearTimeout(timeout);
        process.off("SIGINT", sigHandler);
        process.off("SIGTERM", sigHandler);
        resolve();
      });
    }
  });
}
