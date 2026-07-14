import fs from "fs";
import path from "path";
import { execSync } from "child_process";

async function build(): Promise<void> {
  if (!import.meta.dirname) {
    throw new Error("import.meta.dirname is unavailable. Node >= 24 is required.");
  }
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const skillDir = path.join(projectRoot, "skills/spelunk");
  const scriptOutDir = path.join(skillDir, "scripts");

  // Clean and recreate output directory
  fs.mkdirSync(scriptOutDir, { recursive: true });

  console.log("Running tsdown compiler...");
  const tsdownBin = path.join(projectRoot, "node_modules/.bin/tsdown");
  if (fs.existsSync(tsdownBin)) {
    execSync(`"${tsdownBin}"`, { stdio: "inherit", cwd: projectRoot });
  } else {
    execSync("npx --no-install tsdown", { stdio: "inherit", cwd: projectRoot });
  }

  // Copy WebAssembly file for parsing
  console.log("Copying tree-sitter WASM binary...");
  const treeSitterWasm = path.join(projectRoot, "node_modules/web-tree-sitter/tree-sitter.wasm");
  if (fs.existsSync(treeSitterWasm)) {
    fs.copyFileSync(treeSitterWasm, path.join(scriptOutDir, "tree-sitter.wasm"));
  } else {
    throw new Error("tree-sitter.wasm not found in node_modules/web-tree-sitter. Build failed.");
  }

  console.log("Spelunk unified skill build completed successfully.");
}

build().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
