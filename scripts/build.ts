import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

async function build(): Promise<void> {
  const startTime = performance.now();
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const skillDir = path.join(projectRoot, "skills/spelunk");
  const scriptOutDir = path.join(skillDir, "scripts");
  const refTargetDir = path.join(skillDir, "references");
  const refSrcDir = path.join(projectRoot, "references");

  const relCommon = path.relative(projectRoot, path.join(scriptOutDir, "common.mjs"));
  const relRefSrc = path.relative(projectRoot, refSrcDir);
  const relRefTarget = path.relative(projectRoot, refTargetDir);
  const relSkillDir = path.relative(projectRoot, skillDir);

  const commonPath = path.join(scriptOutDir, "common.mjs");
  if (fs.existsSync(commonPath)) {
    console.log(`Minifying ${relCommon}...`);
    let content = fs.readFileSync(commonPath, "utf-8");
    content = content.replace(/eval\(func\)/g, "(0, eval)(func)");
    fs.writeFileSync(commonPath, content, "utf-8");

    const bundle = await rolldown({
      input: commonPath,
      external: (id) => id.startsWith("node:") || id.endsWith(".mjs"),
      treeshake: true,
    });
    const { output } = await bundle.generate({
      minify: true,
      sourcemap: true,
      format: "esm",
    });
    if (output[0]?.code) {
      fs.writeFileSync(commonPath, output[0].code, "utf-8");
      if (output[0]?.map) {
        fs.writeFileSync(`${commonPath}.map`, JSON.stringify(output[0].map), "utf-8");
      }
    }
  } else {
    console.warn(`Warning: Could not find ${relCommon}. Skipping minification.`);
  }

  console.log("Copying tree-sitter WASM binary...");
  let treeSitterWasm: string;
  try {
    treeSitterWasm = fileURLToPath(import.meta.resolve("web-tree-sitter/tree-sitter.wasm"));
  } catch {
    throw new Error(
      "Could not resolve web-tree-sitter package. Ensure web-tree-sitter is installed.",
    );
  }

  if (!fs.existsSync(treeSitterWasm)) {
    throw new Error(
      `Tree-sitter WASM binary not found at "${treeSitterWasm}". Reinstall web-tree-sitter.`,
    );
  }
  fs.copyFileSync(treeSitterWasm, path.join(scriptOutDir, "tree-sitter.wasm"));

  if (!fs.existsSync(refSrcDir)) {
    throw new Error(
      `Reference directory not found at "${relRefSrc}". Ensure the references directory exists.`,
    );
  }

  console.log(`Copying reference documentation from ${relRefSrc} to ${relRefTarget}...`);
  fs.mkdirSync(refTargetDir, { recursive: true });
  fs.cpSync(refSrcDir, refTargetDir, { recursive: true });

  console.log("Rewriting documentation links for skill package...");
  for (const file of fs.readdirSync(refTargetDir, { recursive: true })) {
    if (typeof file === "string" && file.endsWith(".md")) {
      const filePath = path.join(refTargetDir, file);
      let content = fs.readFileSync(filePath, "utf-8");

      // Rewrite local development TS paths and CLI syntax to published build script (.mjs) paths
      content = content
        .replace(/\[([a-z]+)\.ts\]\(\.\.\/src\/commands\/\1\.ts\)/g, "[$1.mjs](../scripts/$1.mjs)")
        .replace(/\(\.\.\/src\/commands\/([a-z]+)\.ts\)/g, "(../scripts/$1.mjs)")
        .replace(/`src\/commands\/([a-z]+)\.ts`/g, "`scripts/$1.mjs`")
        .replace(/spelunk query/g, "node <skill-path>/scripts/query.mjs")
        .replace(
          /spelunk (find|outline|deps|explain|diff|export|scan|status)/g,
          "node <skill-path>/scripts/$1.mjs",
        );
      fs.writeFileSync(filePath, content, "utf-8");
    }
  }

  const elapsedMs = Math.round(performance.now() - startTime);
  console.log(`Build complete in ${elapsedMs}ms. Output written to ${relSkillDir}.`);
}

try {
  await build();
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Build failed: ${message}`);
  process.exit(1);
}
