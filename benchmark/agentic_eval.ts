import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { getEncoding } from "js-tiktoken";

const enc = getEncoding("cl100k_base");
const benchmarkReposDir = path.join(process.cwd(), ".benchmark_repos");

// Absolute script paths
const findScript = path.join(process.cwd(), "skills/spelunk/scripts/find.mjs");
const outlineScript = path.join(process.cwd(), "skills/spelunk/scripts/outline.mjs");
const depsScript = path.join(process.cwd(), "skills/spelunk/scripts/deps.mjs");
const scanScript = path.join(process.cwd(), "skills/spelunk/scripts/scan.mjs");

function execCmd(cmd: string[], cwd: string) {
  const start = Date.now();
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    encoding: "utf-8",
    env: process.env,
  });
  const duration = Date.now() - start;
  return {
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    status: res.status ?? 0,
    duration,
  };
}

interface Action {
  name: string;
  run: () => { input: string; output: string; duration: number };
}

interface ArmResult {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
}

interface Scenario {
  name: string;
  description: string;
  before?: () => void;
  after?: () => void;
  baseline: Action[];
  spelunk: Action[];
}

const scenarios: Scenario[] = [
  {
    name: "Scenario 1: Find SpelunkDB definition and exports",
    description:
      "Locate SpelunkDB class definition, list its exports, and inspect its constructor.",
    before: () => {
      const dbPath = path.join(process.cwd(), ".spelunk/data.db");
      if (!fs.existsSync(dbPath)) {
        console.log("Preparing local spelunk repository: scanning code structure...");
        execCmd(["node", scanScript, "."], process.cwd());
      }
    },
    baseline: [
      {
        name: "Grep for class SpelunkDB",
        run: () => {
          const cmd = ["grep", "-rn", "class SpelunkDB", "src/"];
          const res = execCmd(cmd, process.cwd());
          return {
            input: cmd.join(" "),
            output: res.stdout,
            duration: res.duration,
          };
        },
      },
      {
        name: "View db.ts file",
        run: () => {
          const start = Date.now();
          const filePath = path.join(process.cwd(), "src/core/db.ts");
          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content.split("\n").slice(0, 200).join("\n");
          return {
            input: `view_file src/core/db.ts lines 1-200`,
            output: lines,
            duration: Date.now() - start,
          };
        },
      },
    ],
    spelunk: [
      {
        name: "Spelunk Find SpelunkDB",
        run: () => {
          const cmd = ["node", findScript, "SpelunkDB"];
          const res = execCmd(cmd, process.cwd());
          return {
            input: `spelunk find SpelunkDB`,
            output: res.stdout,
            duration: res.duration,
          };
        },
      },
      {
        name: "Spelunk Outline db.ts",
        run: () => {
          const cmd = ["node", outlineScript, "src/core/db.ts"];
          const res = execCmd(cmd, process.cwd());
          return {
            input: `spelunk outline src/core/db.ts`,
            output: res.stdout,
            duration: res.duration,
          };
        },
      },
    ],
  },
  {
    name: "Scenario 2: Find explain.ts dependencies",
    description: "Trace which modules import or depend on the explain command.",
    before: () => {
      const dbPath = path.join(process.cwd(), ".spelunk/data.db");
      if (!fs.existsSync(dbPath)) {
        console.log("Preparing local spelunk repository: scanning code structure...");
        execCmd(["node", scanScript, "."], process.cwd());
      }
    },
    baseline: [
      {
        name: "Grep for explain in src/",
        run: () => {
          const cmd = ["grep", "-rn", "explain", "src/"];
          const res = execCmd(cmd, process.cwd());
          return {
            input: cmd.join(" "),
            output: res.stdout,
            duration: res.duration,
          };
        },
      },
      {
        name: "View explain.ts file",
        run: () => {
          const start = Date.now();
          const filePath = path.join(process.cwd(), "src/commands/explain.ts");
          const content = fs.readFileSync(filePath, "utf-8");
          return {
            input: `view_file src/commands/explain.ts`,
            output: content,
            duration: Date.now() - start,
          };
        },
      },
    ],
    spelunk: [
      {
        name: "Spelunk Deps explain.ts out",
        run: () => {
          const cmd = ["node", depsScript, "src/commands/explain.ts", "out"];
          const res = execCmd(cmd, process.cwd());
          return {
            input: `spelunk deps src/commands/explain.ts out`,
            output: res.stdout,
            duration: res.duration,
          };
        },
      },
    ],
  },
  {
    name: "Scenario 3: Identify Express application exports",
    description: "Find exports and factory functions provided by the lib/express.js module.",
    before: () => {
      const expressDir = path.join(benchmarkReposDir, "express");
      if (!fs.existsSync(expressDir)) {
        console.log("Cloning express repository for evaluation...");
        const url = "https://github.com/expressjs/express.git";
        const cloneRes = execCmd(["git", "clone", url, "express"], benchmarkReposDir);
        if (cloneRes.status !== 0) {
          console.error(`Failed to clone express: ${cloneRes.stderr}`);
        }
        execCmd(["git", "checkout", "d36495d7e666f30c06fbb0e039771c5267d7d1d4"], expressDir);
      }
      console.log("Preparing express repository: scanning code structure...");
      execCmd(["node", scanScript, "."], expressDir);
    },
    after: () => {
      const expressSpelunk = path.join(benchmarkReposDir, "express/.spelunk");
      if (fs.existsSync(expressSpelunk)) {
        fs.rmSync(expressSpelunk, { recursive: true, force: true });
      }
    },
    baseline: [
      {
        name: "View lib/express.js",
        run: () => {
          const start = Date.now();
          const filePath = path.join(benchmarkReposDir, "express/lib/express.js");
          const content = fs.readFileSync(filePath, "utf-8");
          return {
            input: `view_file lib/express.js`,
            output: content,
            duration: Date.now() - start,
          };
        },
      },
    ],
    spelunk: [
      {
        name: "Spelunk Outline lib/express.js",
        run: () => {
          const cmd = ["node", outlineScript, "lib/express.js"];
          const res = execCmd(cmd, path.join(benchmarkReposDir, "express"));
          return {
            input: `spelunk outline lib/express.js`,
            output: res.stdout,
            duration: res.duration,
          };
        },
      },
    ],
  },
];

function runArm(actions: Action[]): ArmResult {
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let durationMs = 0;

  let cumulativeContextTokens = 0;
  for (const action of actions) {
    turns++;
    const res = action.run();
    const actionInputTokens = enc.encode(res.input).length;
    inputTokens += actionInputTokens + cumulativeContextTokens;

    const actionOutputTokens = enc.encode(res.output).length;
    outputTokens += actionOutputTokens;

    cumulativeContextTokens += actionInputTokens + actionOutputTokens;
    durationMs += res.duration;
  }

  return {
    turns,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    durationMs,
  };
}

function formatDiffPercent(base: number, comp: number): string {
  if (base === 0) return "0.0%";
  const diff = ((base - comp) / base) * 100;
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${diff.toFixed(1)}%`;
}

console.log(
  "\n==========================================================================================",
);
console.log("                           E2E AGENTIC EVALUATION HARNESS");
console.log(
  "==========================================================================================\n",
);

const evalResults: any[] = [];

for (const sc of scenarios) {
  console.log(`Running: ${sc.name}`);
  console.log(`Description: ${sc.description}`);
  if (sc.before) sc.before();
  console.log(
    "------------------------------------------------------------------------------------------",
  );

  const baselineRes = runArm(sc.baseline);
  const spelunkRes = runArm(sc.spelunk);

  if (sc.after) sc.after();

  evalResults.push({
    scenario: sc.name,
    baseline: baselineRes,
    spelunk: spelunkRes,
  });

  const headers = ["Metric", "Baseline (Shell/Cat)", "Spelunk (AST)", "Savings / Improvement"];
  const rows = [
    [
      "Turns",
      `${baselineRes.turns}`,
      `${spelunkRes.turns}`,
      formatDiffPercent(baselineRes.turns, spelunkRes.turns),
    ],
    [
      "Input Tokens",
      `${baselineRes.inputTokens}`,
      `${spelunkRes.inputTokens}`,
      formatDiffPercent(baselineRes.inputTokens, spelunkRes.inputTokens),
    ],
    [
      "Output Tokens",
      `${baselineRes.outputTokens}`,
      `${spelunkRes.outputTokens}`,
      formatDiffPercent(baselineRes.outputTokens, spelunkRes.outputTokens),
    ],
    [
      "Total Tokens",
      `${baselineRes.totalTokens}`,
      `${spelunkRes.totalTokens}`,
      formatDiffPercent(baselineRes.totalTokens, spelunkRes.totalTokens),
    ],
    [
      "Duration",
      `${baselineRes.durationMs.toFixed(1)}ms`,
      `${spelunkRes.durationMs.toFixed(1)}ms`,
      `${(baselineRes.durationMs - spelunkRes.durationMs).toFixed(1)}ms (${formatDiffPercent(baselineRes.durationMs, spelunkRes.durationMs)})`,
    ],
  ];

  // Print ASCII Table
  const colWidths = [18, 25, 20, 28];
  const printRow = (arr: string[]) => {
    console.log(arr.map((val, i) => val.padEnd(colWidths[i])).join(" | "));
  };

  printRow(headers);
  console.log(colWidths.map((w) => "-".repeat(w)).join("-|-"));
  rows.forEach((r) => printRow(r));
  console.log(
    "------------------------------------------------------------------------------------------\n",
  );
}

// Compute aggregate metrics
const avgBaselineTurns =
  evalResults.reduce((acc, r) => acc + r.baseline.turns, 0) / evalResults.length;
const avgSpelunkTurns =
  evalResults.reduce((acc, r) => acc + r.spelunk.turns, 0) / evalResults.length;
const avgBaselineTokens =
  evalResults.reduce((acc, r) => acc + r.baseline.totalTokens, 0) / evalResults.length;
const avgSpelunkTokens =
  evalResults.reduce((acc, r) => acc + r.spelunk.totalTokens, 0) / evalResults.length;
const totalTokensSaved = evalResults.reduce(
  (acc, r) => acc + (r.baseline.totalTokens - r.spelunk.totalTokens),
  0,
);

console.log(
  "================================= SUMMARY OF IMPACT ======================================",
);
console.log(
  `Average Turn Reduction:      ${formatDiffPercent(avgBaselineTurns, avgSpelunkTurns)} (${avgBaselineTurns.toFixed(1)} -> ${avgSpelunkTurns.toFixed(1)} turns)`,
);
console.log(
  `Average Token Reduction:     ${formatDiffPercent(avgBaselineTokens, avgSpelunkTokens)} (${avgBaselineTokens.toFixed(0)} -> ${avgSpelunkTokens.toFixed(0)} tokens)`,
);
console.log(`Total BPE Context Saved:     ${totalTokensSaved} tokens saved across all runs`);
console.log(
  "==========================================================================================\n",
);

// Write results to JSON
const resultsPath = path.join(import.meta.dirname, "agentic_eval_results.json");
fs.writeFileSync(
  resultsPath,
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      scenarios: evalResults,
      summary: {
        turnReductionPercent: parseFloat(
          (((avgBaselineTurns - avgSpelunkTurns) / avgBaselineTurns) * 100).toFixed(2),
        ),
        tokenReductionPercent: parseFloat(
          (((avgBaselineTokens - avgSpelunkTokens) / avgBaselineTokens) * 100).toFixed(2),
        ),
        totalTokensSaved,
      },
    },
    null,
    2,
  ),
);
console.log(`Results saved to ${resultsPath}\n`);
