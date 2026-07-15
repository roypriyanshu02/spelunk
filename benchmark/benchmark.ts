import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { getEncoding } from "js-tiktoken";

const enc = getEncoding("cl100k_base");

const tokensDir = path.join(import.meta.dirname, "tokens");
const reposFile = fs.readFileSync(path.join(tokensDir, "repos.txt"), "utf-8");
const repos = reposFile
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

const benchmarkReposDir = path.join(process.cwd(), ".benchmark_repos");
if (!fs.existsSync(benchmarkReposDir)) {
  fs.mkdirSync(benchmarkReposDir, { recursive: true });
}

function execInDir(cmd: string[], cwd: string) {
  return spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    encoding: "utf-8",
    env: process.env,
  });
}

const scriptsDir = path.join(process.cwd(), "skills/spelunk/scripts");

// Ensure the bundle is built first
console.log("Building Spelunk Skill bundle...");
execInDir(["npm", "run", "build"], process.cwd());

// 1. Setup repos and scan them
for (const repoLine of repos) {
  if (repoLine === "spelunk") {
    console.log("Scanning local spelunk repo...");
    execInDir(["node", path.join(scriptsDir, "scan.mjs"), "."], process.cwd());
    continue;
  }

  const [url, version] = repoLine.split("@");
  const repoName =
    url
      .split("/")
      .pop()
      ?.replace(/\.git$/, "") || "repo";
  const repoDir = path.join(benchmarkReposDir, repoName);

  if (!fs.existsSync(repoDir)) {
    console.log(`Cloning ${repoName}...`);
    const cloneRes = execInDir(["git", "clone", url, repoName], benchmarkReposDir);
    if (cloneRes.status !== 0) {
      console.error(`Failed to clone ${repoName}: ${cloneRes.stderr}`);
      process.exit(1);
    }
  }

  console.log(`Checking out ${version} in ${repoName}...`);
  execInDir(["git", "checkout", version], repoDir);

  console.log(`Scanning ${repoName}...`);
  const scanRes = execInDir(["node", path.join(scriptsDir, "scan.mjs"), "."], repoDir);
  if (scanRes.status !== 0) {
    console.error(`Failed to scan ${repoName}: ${scanRes.stderr}`);
    process.exit(1);
  }
}

// 2. Parse trials count
let trials = 1;
const trialsIdx = process.argv.indexOf("--trials");
if (trialsIdx !== -1 && process.argv[trialsIdx + 1]) {
  trials = parseInt(process.argv[trialsIdx + 1], 10);
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

function getValueAtPath(obj: any, pathStr?: string): any {
  if (!pathStr) return obj;
  const parts = pathStr.split(".");
  let curr = obj;
  for (const part of parts) {
    if (curr === null || curr === undefined) return undefined;
    curr = curr[part];
  }
  return curr;
}

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

function getMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[half];
  }
  return (sorted[half - 1] + sorted[half]) / 2;
}

function getStdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const avg = values.reduce((acc, v) => acc + v, 0) / values.length;
  const squareDiffs = values.map((v) => Math.pow(v - avg, 2));
  const avgSquareDiff = squareDiffs.reduce((acc, v) => acc + v, 0) / values.length;
  return Math.sqrt(avgSquareDiff);
}

const results = [];

for (const task of tasks) {
  const targetDir =
    task.repo === "spelunk" ? process.cwd() : path.join(benchmarkReposDir, task.repo);

  const command = path.basename(task.script, ".ts"); // e.g. "find", "deps", "outline"
  console.log(
    `Running task for [${task.repo}]: node skills/spelunk/scripts/${command}.mjs ${task.args.join(" ")}...`,
  );

  const durations: number[] = [];
  let firstStdout = "";
  let firstStderr = "";
  let firstStatus = 0;

  for (let t = 0; t < trials; t++) {
    const startTime = Date.now();
    const runRes = execInDir(
      ["node", path.join(scriptsDir, `${command}.mjs`), ...task.args, "--format", "json"],
      targetDir,
    );
    const durationMs = Date.now() - startTime;
    durations.push(durationMs);

    if (t === 0) {
      firstStdout = runRes.stdout || "";
      firstStderr = runRes.stderr || "";
      firstStatus = runRes.status ?? 0;
    }
  }

  const medianDuration = getMedian(durations);
  const stdDevDuration = getStdDev(durations);

  // Validate all assertions
  const passed =
    firstStatus === 0 &&
    task.assertions.every((assertion) => validateAssertion(firstStdout, assertion));

  // Precision Tokenization using BPE Encoder
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

  console.log(
    ` -> ${passed ? "PASS" : "FAIL"} (${medianDuration.toFixed(1)}ms (stdDev: ${stdDevDuration.toFixed(1)}ms), ${tokens} tokens)`,
  );
}

// Cleanup .spelunk directories inside benchmark repos
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

// 4. Aggregate metrics and save results
const totalTasks = results.length;
const passedTasks = results.filter((r) => r.passed).length;
const accuracy = totalTasks > 0 ? (passedTasks / totalTasks) * 100 : 0;
const totalTokens = results.reduce((acc, r) => acc + r.tokens, 0);
const avgDurationMs =
  totalTasks > 0 ? results.reduce((acc, r) => acc + r.durationMs, 0) / totalTasks : 0;

let commitHash = "unknown";
try {
  const gitLog = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" });
  commitHash = gitLog.stdout.trim();
} catch {}

const runSummary = {
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

const resultsPath = path.join(import.meta.dirname, "results.json");
let allResults = [];
if (fs.existsSync(resultsPath)) {
  try {
    allResults = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
  } catch {}
}
allResults.push(runSummary);
fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));

console.log("\n================ BENCHMARK RESULTS ================");
console.log(`Accuracy:       ${accuracy.toFixed(2)}% (${passedTasks}/${totalTasks} passed)`);
console.log(`Total Tokens:   ${totalTokens}`);
console.log(`Avg Duration:   ${avgDurationMs.toFixed(2)}ms`);
console.log(`Results saved to benchmark/results.json`);
console.log("===================================================\n");
