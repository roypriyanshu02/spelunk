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

// Absolute script paths
const findScript = path.join(scriptsDir, "find.mjs");
const outlineScript = path.join(scriptsDir, "outline.mjs");
const depsScript = path.join(scriptsDir, "deps.mjs");
const scanScript = path.join(scriptsDir, "scan.mjs");

// Verify runtime environment before executing harness
if (!(await verifyEnvironment())) {
  process.exit(1);
}

// Input validation check
if (!process.argv.every(isSafeArgument)) {
  console.error(
    `${colors.red}Error: Suspicious character detected in command line arguments.${colors.reset}`,
  );
  process.exit(1);
}

const forceClean = process.argv.includes("--clean") || process.argv.includes("-c");
const latestSrcMtime = getLatestMtime(srcDir);

interface Action {
  name: string;
  run: () => Promise<{ input: string; output: string; duration: number }>;
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
  before?: () => Promise<void> | void;
  after?: () => Promise<void> | void;
  baseline: Action[];
  spelunk: Action[];
}

/**
 * Prepares the local Spelunk database index by scanning the codebase.
 */
const prepareLocalSpelunk = async () => {
  const localSpelunkDir = projectRoot;
  const valid = !forceClean && (await isCacheValid(localSpelunkDir, "HEAD", latestSrcMtime));
  if (valid) {
    console.log(`${colors.green}Using cached index for local spelunk.${colors.reset}`);
    return;
  }
  console.log(
    `${colors.cyan}Preparing local spelunk repository: scanning code structure...${colors.reset}`,
  );
  const scanRes = await execCmdAsync(["node", scanScript, "."], localSpelunkDir);
  if (scanRes.status !== 0) {
    console.error(`${colors.red}Failed to prepare local spelunk: ${scanRes.stderr}${colors.reset}`);
    process.exit(1);
  }
};

const scenarios: Scenario[] = [
  {
    name: "Scenario 1: Find SpelunkDB definition and exports",
    description:
      "Locate SpelunkDB class definition, list its exports, and inspect its constructor.",
    before: prepareLocalSpelunk,
    baseline: [
      {
        name: "Grep for class SpelunkDB",
        run: async () => {
          const cmd = ["grep", "-rn", "class SpelunkDB", "src/"];
          const res = await execCmdAsync(cmd, projectRoot);
          return {
            input: cmd.join(" "),
            output: res.stdout,
            duration: res.duration,
          };
        },
      },
      {
        name: "View db.ts file",
        run: async () => {
          const start = Date.now();
          const filePath = path.join(projectRoot, "src/core/db.ts");
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
        run: async () => {
          const cmd = ["node", findScript, "SpelunkDB"];
          const res = await execCmdAsync(cmd, projectRoot);
          return {
            input: `spelunk find SpelunkDB`,
            output: res.stdout,
            duration: res.duration,
          };
        },
      },
      {
        name: "Spelunk Outline db.ts",
        run: async () => {
          const cmd = ["node", outlineScript, "src/core/db.ts"];
          const res = await execCmdAsync(cmd, projectRoot);
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
    before: prepareLocalSpelunk,
    baseline: [
      {
        name: "Grep for explain in src/",
        run: async () => {
          const cmd = ["grep", "-rn", "explain", "src/"];
          const res = await execCmdAsync(cmd, projectRoot);
          return {
            input: cmd.join(" "),
            output: res.stdout,
            duration: res.duration,
          };
        },
      },
      {
        name: "View explain.ts file",
        run: async () => {
          const start = Date.now();
          const filePath = path.join(projectRoot, "src/commands/explain.ts");
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
        run: async () => {
          const cmd = ["node", depsScript, "src/commands/explain.ts", "out"];
          const res = await execCmdAsync(cmd, projectRoot);
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
    before: async () => {
      const expressDir = path.join(benchmarkReposDir, "express");
      const targetVersion = "d36495d7e666f30c06fbb0e039771c5267d7d1d4";

      if (!fs.existsSync(benchmarkReposDir)) {
        fs.mkdirSync(benchmarkReposDir, { recursive: true });
      }

      if (!fs.existsSync(expressDir)) {
        console.log(`${colors.cyan}Cloning express repository for evaluation...${colors.reset}`);
        const url = "https://github.com/expressjs/express.git";
        const cloneRes = await execCmdAsync(["git", "clone", url, "express"], benchmarkReposDir);
        if (cloneRes.status !== 0) {
          console.error(`${colors.red}Failed to clone express: ${cloneRes.stderr}${colors.reset}`);
          process.exit(1);
        }
      }

      const valid = !forceClean && (await isCacheValid(expressDir, targetVersion, latestSrcMtime));
      if (!valid) {
        console.log(`${colors.cyan}Checking out ${targetVersion} in express...${colors.reset}`);
        const checkoutRes = await execCmdAsync(["git", "checkout", targetVersion], expressDir);
        if (checkoutRes.status !== 0) {
          console.error(
            `${colors.red}Failed to checkout express: ${checkoutRes.stderr}${colors.reset}`,
          );
          process.exit(1);
        }
        console.log(
          `${colors.cyan}Preparing express repository: scanning code structure...${colors.reset}`,
        );
        const scanRes = await execCmdAsync(["node", scanScript, "."], expressDir);
        if (scanRes.status !== 0) {
          console.error(`${colors.red}Failed to scan express: ${scanRes.stderr}${colors.reset}`);
          process.exit(1);
        }
      } else {
        console.log(`${colors.green}Using cached index for express.${colors.reset}`);
      }
    },
    after: async () => {
      if (forceClean) {
        console.log(
          `${colors.yellow}Cleaning up express .spelunk index as requested...${colors.reset}`,
        );
        const expressSpelunk = path.join(benchmarkReposDir, "express/.spelunk");
        if (fs.existsSync(expressSpelunk)) {
          fs.rmSync(expressSpelunk, { recursive: true, force: true });
        }
      }
    },
    baseline: [
      {
        name: "View lib/express.js",
        run: async () => {
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
        run: async () => {
          const cmd = ["node", outlineScript, "lib/express.js"];
          const res = await execCmdAsync(cmd, path.join(benchmarkReposDir, "express"));
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

/**
 * Runs a set of actions sequentially, simulating an agent turn-by-turn flow.
 * Measures cumulative context tokens and execution duration.
 */
async function runArm(actions: Action[]): Promise<ArmResult> {
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let durationMs = 0;

  let cumulativeContextTokens = 0;
  for (const action of actions) {
    turns++;
    const res = await action.run();
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

/**
 * Helper to compute and format comparison percentage differences.
 */
function formatDiffPercent(base: number, comp: number): string {
  if (base === 0) return "0.0%";
  const diff = ((base - comp) / base) * 100;
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${diff.toFixed(1)}%`;
}

console.log(
  `\n${colors.bold}==========================================================================================${colors.reset}`,
);
console.log(
  `                           ${colors.cyan}E2E AGENTIC EVALUATION HARNESS${colors.reset}`,
);
console.log(
  `${colors.bold}==========================================================================================${colors.reset}\n`,
);

interface ScenarioResult {
  scenario: string;
  baseline: ArmResult;
  spelunk: ArmResult;
}

const evalResults: ScenarioResult[] = [];

for (const scenario of scenarios) {
  console.log(`${colors.bold}Running: ${scenario.name}${colors.reset}`);
  console.log(`Description: ${scenario.description}`);
  if (scenario.before) await scenario.before();
  console.log(
    "------------------------------------------------------------------------------------------",
  );

  const baselineRes = await runArm(scenario.baseline);
  const spelunkRes = await runArm(scenario.spelunk);

  if (scenario.after) await scenario.after();

  evalResults.push({
    scenario: scenario.name,
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

  // Print ASCII Table format
  const colWidths = [18, 25, 20, 28];
  const printRow = (rowCells: string[]) => {
    console.log(rowCells.map((val, cellIndex) => val.padEnd(colWidths[cellIndex])).join(" | "));
  };

  printRow(headers);
  console.log(colWidths.map((w) => "-".repeat(w)).join("-|-"));
  rows.forEach((row) => printRow(row));
  console.log(
    "------------------------------------------------------------------------------------------\n",
  );
}

// Compute aggregate metrics for E2E impact
const avgBaselineTurns =
  evalResults.reduce((accumulator, result) => accumulator + result.baseline.turns, 0) /
  evalResults.length;
const avgSpelunkTurns =
  evalResults.reduce((accumulator, result) => accumulator + result.spelunk.turns, 0) /
  evalResults.length;
const avgBaselineTokens =
  evalResults.reduce((accumulator, result) => accumulator + result.baseline.totalTokens, 0) /
  evalResults.length;
const avgSpelunkTokens =
  evalResults.reduce((accumulator, result) => accumulator + result.spelunk.totalTokens, 0) /
  evalResults.length;
const totalTokensSaved = evalResults.reduce(
  (accumulator, result) => accumulator + (result.baseline.totalTokens - result.spelunk.totalTokens),
  0,
);

console.log(
  `${colors.bold}================================= SUMMARY OF IMPACT ======================================${colors.reset}`,
);
console.log(
  `Average Turn Reduction:      ${colors.green}${formatDiffPercent(avgBaselineTurns, avgSpelunkTurns)}${colors.reset} (${avgBaselineTurns.toFixed(1)} -> ${avgSpelunkTurns.toFixed(1)} turns)`,
);
console.log(
  `Average Token Reduction:     ${colors.green}${formatDiffPercent(avgBaselineTokens, avgSpelunkTokens)}${colors.reset} (${avgBaselineTokens.toFixed(0)} -> ${avgSpelunkTokens.toFixed(0)} tokens)`,
);
console.log(
  `Total BPE Context Saved:     ${colors.green}${totalTokensSaved} tokens saved across all runs${colors.reset}`,
);
console.log(
  `${colors.bold}==========================================================================================${colors.reset}\n`,
);

// Write results summary to JSON
const resultsPath = path.join(benchmarkDir, "agentic_eval_results.json");
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
