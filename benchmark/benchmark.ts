import fs from "fs";
import path from "path";
import {
  colors,
  enc,
  execCmdAsync,
  verifyEnvironment,
  isSafeArgument,
  getLatestMtime,
  isCacheValid,
  projectRoot,
  benchmarkDir,
  benchmarkReposDir,
  scriptsDir,
  srcDir,
} from "./shared.ts";

// Verify runtime environment before execution
if (!(await verifyEnvironment())) {
  process.exit(1);
}

// Input validation check to prevent arguments manipulation
if (!process.argv.every(isSafeArgument)) {
  console.error(
    `${colors.red}Error: Suspicious character detected in command line arguments.${colors.reset}`,
  );
  process.exit(1);
}

const tokensDir = path.join(benchmarkDir, "tokens");
const reposFile = fs.readFileSync(path.join(tokensDir, "repos.txt"), "utf-8");
const repos = reposFile
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

if (!fs.existsSync(benchmarkReposDir)) {
  fs.mkdirSync(benchmarkReposDir, { recursive: true });
}

// Ensure the bundle is built first
console.log(`${colors.cyan}Building Spelunk Skill bundle...${colors.reset}`);
const buildRes = await execCmdAsync(["npm", "run", "build"], projectRoot);
if (buildRes.status !== 0) {
  console.error(`${colors.red}Build failed: ${buildRes.stderr}${colors.reset}`);
  process.exit(1);
}

const forceClean = process.argv.includes("--clean") || process.argv.includes("-c");
const latestSrcMtime = getLatestMtime(srcDir);

// 1. Setup repos and scan them in parallel to save I/O wait times
console.log(`${colors.cyan}Provisioning benchmark repositories...${colors.reset}`);
await Promise.all(
  repos.map(async (repoLine) => {
    if (repoLine === "spelunk") {
      const localSpelunkDir = projectRoot;
      const valid = !forceClean && (await isCacheValid(localSpelunkDir, "HEAD", latestSrcMtime));
      if (valid) {
        console.log(`${colors.green}Using cached index for local spelunk.${colors.reset}`);
        return;
      }
      console.log(`${colors.cyan}Scanning local spelunk repo...${colors.reset}`);
      const scanRes = await execCmdAsync(
        ["node", path.join(scriptsDir, "scan.mjs"), "."],
        localSpelunkDir,
      );
      if (scanRes.status !== 0) {
        console.error(
          `${colors.red}Failed to scan local spelunk: ${scanRes.stderr}${colors.reset}`,
        );
        process.exit(1);
      }
      return;
    }

    const [url, version] = repoLine.split("@");
    const repoName =
      url
        .split("/")
        .pop()
        ?.replace(/\.git$/, "") || "repo";
    const repoDir = path.join(benchmarkReposDir, repoName);

    if (!fs.existsSync(repoDir)) {
      console.log(`${colors.cyan}Cloning ${repoName}...${colors.reset}`);
      const cloneRes = await execCmdAsync(["git", "clone", url, repoName], benchmarkReposDir);
      if (cloneRes.status !== 0) {
        console.error(
          `${colors.red}Failed to clone ${repoName}: ${cloneRes.stderr}${colors.reset}`,
        );
        process.exit(1);
      }
    }

    const valid = !forceClean && (await isCacheValid(repoDir, version, latestSrcMtime));
    if (valid) {
      console.log(`${colors.green}Using cached index for ${repoName}.${colors.reset}`);
      return;
    }

    console.log(`${colors.cyan}Checking out ${version} in ${repoName}...${colors.reset}`);
    const checkoutRes = await execCmdAsync(["git", "checkout", version], repoDir);
    if (checkoutRes.status !== 0) {
      console.error(
        `${colors.red}Failed to checkout ${version} in ${repoName}: ${checkoutRes.stderr}${colors.reset}`,
      );
      process.exit(1);
    }

    const dbPath = path.join(repoDir, ".spelunk");
    if (forceClean && fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { recursive: true, force: true });
    }

    console.log(`${colors.cyan}Scanning ${repoName}...${colors.reset}`);
    const scanRes = await execCmdAsync(["node", path.join(scriptsDir, "scan.mjs"), "."], repoDir);
    if (scanRes.status !== 0) {
      console.error(`${colors.red}Failed to scan ${repoName}: ${scanRes.stderr}${colors.reset}`);
      process.exit(1);
    }
  }),
);

// 2. Parse trials count
let trials = 1;
const trialsIndex = process.argv.indexOf("--trials");
if (trialsIndex !== -1 && process.argv[trialsIndex + 1]) {
  trials = parseInt(process.argv[trialsIndex + 1], 10);
  if (isNaN(trials) || trials < 1) {
    trials = 1;
  }
}

console.log(`Running benchmarks with ${trials} trial(s) per task...`);

// 3. Load and run tasks
const tasksFile = fs.readFileSync(path.join(tokensDir, "tasks.json"), "utf-8");

interface Assertion {
  path?: string;
  operator: "any-equals" | "any-includes" | "exists" | "is-array";
  property?: string;
  value?: any;
}

interface Task {
  repo: string;
  script: string;
  args: string[];
  assertions: Assertion[];
}

const tasks = JSON.parse(tasksFile) as Task[];

/**
 * Resolves a dotted-path string to locate a nested property inside an object.
 */
function getValueAtPath(obj: any, pathStr?: string): any {
  if (!pathStr) return obj;
  const parts = pathStr.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Validates a single JSON-based task assertion against command stdout output.
 */
function validateAssertion(stdout: string, assertion: Assertion): boolean {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return false;
  }

  const target = getValueAtPath(parsed, assertion.path);

  switch (assertion.operator) {
    case "exists":
      return target !== undefined && target !== null;
    case "is-array":
      return Array.isArray(target);
    case "any-equals":
      if (!Array.isArray(target)) return false;
      return target.some((item: any) => {
        const val = assertion.property ? item[assertion.property] : item;
        return val === assertion.value;
      });
    case "any-includes":
      if (!Array.isArray(target)) return false;
      return target.some((item: any) => {
        const val = assertion.property ? item[assertion.property] : item;
        if (Array.isArray(val)) {
          return val.some(
            (element) => typeof element === "string" && element.includes(assertion.value),
          );
        }
        if (typeof val === "string") {
          return val.includes(assertion.value);
        }
        return false;
      });
    default:
      return false;
  }
}

/**
 * Returns the median value of a numerical list.
 */
function getMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[half];
  }
  return (sorted[half - 1] + sorted[half]) / 2;
}

/**
 * Returns the standard deviation value of a numerical list.
 */
function getStdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const average = values.reduce((accumulator, val) => accumulator + val, 0) / values.length;
  const squareDiffs = values.map((val) => Math.pow(val - average, 2));
  const averageSquareDiff =
    squareDiffs.reduce((accumulator, val) => accumulator + val, 0) / values.length;
  return Math.sqrt(averageSquareDiff);
}

interface TaskResult {
  repo: string;
  query: string;
  assertions: Assertion[];
  passed: boolean;
  tokens: number;
  durationMs: number;
  stdDevMs: number;
  error?: string;
}

const results: TaskResult[] = [];

// Benchmark tasks run sequentially to ensure exact timing metrics are free of parallel load interference
for (const task of tasks) {
  const targetDir = task.repo === "spelunk" ? projectRoot : path.join(benchmarkReposDir, task.repo);

  const command = path.basename(task.script, ".ts"); // e.g. "find", "deps", "outline"
  console.log(
    `Running task for [${task.repo}]: node skills/spelunk/scripts/${command}.mjs ${task.args.join(" ")}...`,
  );

  const durations: number[] = [];
  let firstStdout = "";
  let firstStderr = "";
  let firstStatus = 0;

  for (let trialIndex = 0; trialIndex < trials; trialIndex++) {
    const startTime = Date.now();
    const runRes = await execCmdAsync(
      ["node", path.join(scriptsDir, `${command}.mjs`), ...task.args, "--format", "json"],
      targetDir,
    );
    const durationMs = Date.now() - startTime;
    durations.push(durationMs);

    if (trialIndex === 0) {
      firstStdout = runRes.stdout || "";
      firstStderr = runRes.stderr || "";
      firstStatus = runRes.status ?? 0;
    }
  }

  const medianDuration = getMedian(durations);
  const stdDevDuration = getStdDev(durations);

  const passed =
    firstStatus === 0 &&
    task.assertions.every((assertion) => validateAssertion(firstStdout, assertion));

  const tokens = enc.encode(firstStdout).length;

  results.push({
    repo: task.repo,
    query: `${command} ${task.args.join(" ")}`,
    assertions: task.assertions,
    passed,
    tokens,
    durationMs: parseFloat(medianDuration.toFixed(2)),
    stdDevMs: parseFloat(stdDevDuration.toFixed(2)),
    error: firstStatus !== 0 ? firstStderr.trim() || `Exit code ${firstStatus}` : undefined,
  });

  const passStr = passed
    ? `${colors.green}PASS${colors.reset}`
    : `${colors.red}FAIL${colors.reset}`;
  console.log(
    ` -> ${passStr} (${medianDuration.toFixed(1)}ms (stdDev: ${stdDevDuration.toFixed(1)}ms), ${tokens} tokens)`,
  );
}

// Cleanup only if explicitly requested via --clean
if (forceClean) {
  console.log(`${colors.yellow}Cleaning up .spelunk caches as requested...${colors.reset}`);
  for (const repoLine of repos) {
    if (repoLine === "spelunk") continue;
    const [url] = repoLine.split("@");
    const repoName =
      url
        .split("/")
        .pop()
        ?.replace(/\.git$/, "") || "repo";
    const repoDir = path.join(benchmarkReposDir, repoName);
    const repoSpelunkDir = path.join(repoDir, ".spelunk");
    if (fs.existsSync(repoSpelunkDir)) {
      fs.rmSync(repoSpelunkDir, { recursive: true, force: true });
    }
  }
}

// 4. Aggregate metrics and save results
const totalTasks = results.length;
const passedTasks = results.filter((result) => result.passed).length;
const accuracy = totalTasks > 0 ? (passedTasks / totalTasks) * 100 : 0;
const totalTokens = results.reduce((accumulator, result) => accumulator + result.tokens, 0);
const avgDurationMs =
  totalTasks > 0
    ? results.reduce((accumulator, result) => accumulator + result.durationMs, 0) / totalTasks
    : 0;

let commitHash = "unknown";
try {
  const gitLog = await execCmdAsync(["git", "rev-parse", "HEAD"], projectRoot);
  if (gitLog.status === 0) {
    commitHash = gitLog.stdout.trim();
  }
} catch {}

interface RunSummary {
  timestamp: string;
  commit: string;
  metrics: {
    totalTasks: number;
    passedTasks: number;
    accuracy: number;
    totalTokens: number;
    avgDurationMs: number;
  };
  tasks: TaskResult[];
}

const runSummary: RunSummary = {
  timestamp: new Date().toISOString(),
  commit: commitHash,
  metrics: {
    totalTasks,
    passedTasks,
    accuracy: parseFloat(accuracy.toFixed(2)),
    totalTokens,
    avgDurationMs: parseFloat(avgDurationMs.toFixed(2)),
  },
  tasks: results,
};

const resultsPath = path.join(benchmarkDir, "results.json");
let allResults: RunSummary[] = [];
if (fs.existsSync(resultsPath)) {
  try {
    allResults = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
  } catch {}
}
allResults.push(runSummary);
fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));

console.log(`\n${colors.bold}================ BENCHMARK RESULTS ================${colors.reset}`);
console.log(`Accuracy:       ${accuracy.toFixed(2)}% (${passedTasks}/${totalTasks} passed)`);
console.log(`Total Tokens:   ${totalTokens}`);
console.log(`Avg Duration:   ${avgDurationMs.toFixed(2)}ms`);
console.log(`Results saved to benchmark/results.json`);
console.log(`${colors.bold}===================================================${colors.reset}\n`);
