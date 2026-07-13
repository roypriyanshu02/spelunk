import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ignore from "ignore";
import { SpelunkDB, type FileRecord } from "./db";
import { parseFile } from "./parser";
import { loadConfig, createMatchPath } from "tsconfig-paths";

const MAX_DEPTH = 100;
const MAX_FILES = 50000;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function retryOnTransientError<T>(fn: () => Promise<T>, retries = 3, delay = 50): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const isTransient = ["EMFILE", "ENFILE", "EBUSY", "EAGAIN", "ECONNRESET"].includes(err.code);
      if (!isTransient || attempt >= retries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delay * Math.pow(2, attempt)));
    }
  }
}

export interface ScanOptions {
  rootDir: string;
  dbPath?: string;
  silent?: boolean;
  concurrency?: number;
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

  // Interrupted scan check
  const lastScanStatus = db.getMetadata("scanStatus");
  if (lastScanStatus === "running" && !options.silent) {
    console.warn("A previous scan was interrupted or crashed. Restarting the scan.");
  }
  db.setMetadata("scanStatus", "running");

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

  // Load .gitignore if present
  const gitignorePath = path.join(rootDir, ".gitignore");
  if (await fileExists(gitignorePath)) {
    try {
      const gitignoreContent = await fs.promises.readFile(gitignorePath, "utf-8");
      ig.add(gitignoreContent);
    } catch {
      // Ignore read errors
    }
  }

  // Always ignore .git, node_modules, and Spelunk's own db
  ig.add([
    ".git/**",
    "node_modules/**",
    ".bun/**",
    ".cache/**",
    "dist/**",
    ".spelunk/**",
    "**/.spelunk/**",
    "**/.git/**",
    "**/node_modules/**",
  ]);

  const seenRealPaths = new Set<string>();
  const seenPaths = new Set<string>();
  const filesToProcess: { fullPath: string; relativePath: string }[] = [];

  async function walk(
    currentDir: string,
    depth: number,
    parentIgContexts: { dirPath: string; ig: ReturnType<typeof ignore> }[],
  ) {
    if (depth > MAX_DEPTH) {
      if (!options.silent)
        console.error(
          "Recursion limit exceeded. Check for circular symlinks or deeply nested folders.",
        );
      return;
    }

    const myIgContexts = [...parentIgContexts];
    const localGitignorePath = path.join(currentDir, ".gitignore");
    if (await fileExists(localGitignorePath)) {
      try {
        const localContent = await fs.promises.readFile(localGitignorePath, "utf-8");
        myIgContexts.push({
          dirPath: currentDir,
          ig: ignore().add(localContent),
        });
      } catch {
        // Ignore read errors
      }
    }

    let entries;
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");

      // Check root gitignore using relative path
      if (ig.ignores(relativePath)) {
        continue;
      }

      // Check nested gitignores
      let ignoredByNested = false;
      for (const ctx of myIgContexts) {
        const pathRelToGitignore = path.relative(ctx.dirPath, fullPath).replace(/\\/g, "/");
        if (ctx.ig.ignores(pathRelToGitignore)) {
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

        if (seenRealPaths.has(realPath)) {
          continue;
        }

        // Prevent escaping rootDir
        const relativeFromRoot = path.relative(resolvedRootDir, realPath);
        if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
          continue;
        }

        seenRealPaths.add(realPath);

        await walk(fullPath, depth + 1, myIgContexts);
      } else if (entry.isFile()) {
        if (filesToProcess.length >= MAX_FILES) {
          return;
        }
        fileCount++;
        if (fileCount > MAX_FILES) {
          if (!options.silent)
            console.error("File limit exceeded. Spelunk supports a maximum of 50,000 files.");
          return;
        }

        seenPaths.add(relativePath);
        filesToProcess.push({ fullPath, relativePath });
      }
    }
  }

  const recordsToUpsert: FileRecord[] = [];

  async function processFile(file: {
    fullPath: string;
    relativePath: string;
  }): Promise<FileRecord | null> {
    const { fullPath, relativePath } = file;
    let stat;
    try {
      stat = await retryOnTransientError(() => fs.promises.stat(fullPath));
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

    // Fast check for binary file by reading the first 1024 bytes
    let isBinary = false;
    let fd;
    try {
      fd = await retryOnTransientError(() => fs.promises.open(fullPath, "r"));
      const buffer = Buffer.alloc(1024);
      const { bytesRead } = await fd.read(buffer, 0, 1024, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) {
          isBinary = true;
          break;
        }
      }
    } catch {
      // ignore
    } finally {
      if (fd) await fd.close();
    }

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

    let content: string;
    try {
      content = await retryOnTransientError(() => fs.promises.readFile(fullPath, "utf-8"));
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

    const hash = crypto.createHash("sha256").update(content).digest("hex");

    if (existingRecord && existingRecord.hash === hash) {
      unchangedCount++;
      return null;
    }

    try {
      const { imports, exports } = await parseFile(fullPath, content);
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
    await walk(rootDir, 0, []);

    const concurrencyLimit =
      options.concurrency && options.concurrency > 0 ? options.concurrency : 8;
    const activePromises = new Set<Promise<FileRecord | null>>();
    let processedCount = 0;
    const totalFiles = filesToProcess.length;

    for (const file of filesToProcess) {
      const p = processFile(file);
      activePromises.add(p);
      p.then((record) => {
        activePromises.delete(p);
        if (record) {
          recordsToUpsert.push(record);
        }
        processedCount++;
        if (!options.silent && totalFiles > 0) {
          const step = Math.max(20, Math.floor(totalFiles / 10));
          if (processedCount % step === 0 || processedCount === totalFiles) {
            console.log(
              `Scan progress: ${processedCount} of ${totalFiles} files processed (${Math.round((processedCount / totalFiles) * 100)}%)...`,
            );
          }
        }
      });
      if (activePromises.size >= concurrencyLimit) {
        await Promise.race(activePromises);
      }
    }
    await Promise.all(activePromises);

    if (recordsToUpsert.length > 0) {
      db.upsertFiles(recordsToUpsert);
    }

    // Prune stale records
    const allFiles = db.getAllFiles();
    const toDelete = allFiles.filter((f) => !seenPaths.has(f.path)).map((f) => f.path);
    if (toDelete.length > 0) {
      db.deleteFiles(toDelete);
    }

    // Save rootDir in DB metadata
    db.setMetadata("rootDir", rootDir);

    // Incremental dependency graph update
    if (recordsToUpsert.length > 0) {
      const configLoaderResult = loadConfig(rootDir);
      const matchPath =
        configLoaderResult.resultType === "success"
          ? createMatchPath(configLoaderResult.absoluteBaseUrl, configLoaderResult.paths)
          : null;

      const resolveImport = (sourcePath: string, importStr: string): string | null => {
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
          const normalized = path.relative(rootDir, c).replace(/\\/g, "/");
          if (seenPaths.has(normalized)) return normalized;
        }
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
