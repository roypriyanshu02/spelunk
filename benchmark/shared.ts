import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getEncoding } from "js-tiktoken";

/**
 * Text color escape codes for terminal console output styling.
 */
export const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

/**
 * Result structure returned by command execution helper.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  status: number | null;
  duration: number;
}

/**
 * BPE Token encoder instance for cl100k_base tokenizer.
 */
export const enc = getEncoding("cl100k_base");

// Path resolution setup using ESM meta utilities
export const benchmarkDir = import.meta.dirname!;
export const projectRoot = path.dirname(benchmarkDir);
export const benchmarkReposDir = path.join(projectRoot, ".benchmark_repos");
export const scriptsDir = path.join(projectRoot, "skills/spelunk/scripts");
export const srcDir = path.join(projectRoot, "src");

/**
 * Asynchronously execute a shell command in a child process.
 *
 * @param cmd The command and arguments array (e.g., ["git", "status"])
 * @param cwd The working directory in which to execute the command
 * @returns ExecResult containing stdout, stderr, exit status code, and execution duration in ms
 */
export function execCmdAsync(cmd: string[], cwd: string): Promise<ExecResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data.toString()));
    child.stderr.on("data", (data) => (stderr += data.toString()));
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        status: code,
        duration: Date.now() - start,
      });
    });
    child.on("error", (err) => {
      resolve({
        stdout,
        stderr: err.message,
        status: -1,
        duration: Date.now() - start,
      });
    });
  });
}

/**
 * Verifies that essential CLI dependencies (git, node) are available in the system PATH.
 */
export async function verifyEnvironment(): Promise<boolean> {
  const gitCheck = await execCmdAsync(["git", "--version"], process.cwd());
  const nodeCheck = await execCmdAsync(["node", "--version"], process.cwd());
  if (gitCheck.status !== 0) {
    console.error(`${colors.red}Error: 'git' is not installed or not in PATH.${colors.reset}`);
    return false;
  }
  if (nodeCheck.status !== 0) {
    console.error(`${colors.red}Error: 'node' is not installed or not in PATH.${colors.reset}`);
    return false;
  }
  return true;
}

/**
 * Validates that command line arguments do not contain shell injection characters.
 */
export function isSafeArgument(arg: string): boolean {
  return !/[|;&$`*?~<>^()'"\\{}]/.test(arg);
}

/**
 * Recursively retrieves the latest modification timestamp among files in a directory.
 */
export function getLatestMtime(dir: string): number {
  let latest = 0;
  try {
    const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
    for (const file of files) {
      if (file.isFile()) {
        const fullPath = path.join(dir, file.name);
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > latest) {
          latest = stat.mtimeMs;
        }
      }
    }
  } catch {}
  return latest;
}

/**
 * Checks if the existing cached SQLite database for a repository is valid.
 * Validates that:
 * 1. The database file exists.
 * 2. The database file's modified time is newer than or equal to the latest source modification time.
 * 3. The current git HEAD commit hash matches the requested version/commit hash.
 */
export async function isCacheValid(
  repoDir: string,
  version: string,
  latestSrcMtime: number,
): Promise<boolean> {
  const dbPath = path.join(repoDir, ".spelunk/data.db");
  if (!fs.existsSync(dbPath)) return false;

  const dbStat = fs.statSync(dbPath);
  if (latestSrcMtime > dbStat.mtimeMs) return false;

  const headRes = await execCmdAsync(["git", "rev-parse", "HEAD"], repoDir);
  let targetRes = await execCmdAsync(["git", "rev-parse", `${version}^{commit}`], repoDir);
  if (targetRes.status !== 0) {
    targetRes = await execCmdAsync(["git", "rev-parse", version], repoDir);
  }

  if (headRes.status !== 0 || targetRes.status !== 0) return false;
  return headRes.stdout.trim() === targetRes.stdout.trim();
}
