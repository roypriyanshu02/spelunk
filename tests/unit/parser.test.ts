import { expect, test, describe, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock node:fs globally to hide tree-sitter-json.wasm from parser
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<any>();
  const mockExistsSync = (p: any) => {
    const pStr = String(p).replace(/\\/g, "/");
    if (pStr.includes("tree-sitter-wasms/out/tree-sitter-json.wasm")) {
      return false;
    }
    return original.existsSync(p);
  };
  const mockAccess = async (p: any) => {
    const pStr = String(p).replace(/\\/g, "/");
    if (pStr.includes("tree-sitter-wasms/out/tree-sitter-json.wasm")) {
      throw new Error("File not found (mocked)");
    }
    return original.promises.access(p);
  };
  const mockReadFile = async (p: any, options?: any) => {
    const pStr = String(p).replace(/\\/g, "/");
    if (pStr.includes("tree-sitter-wasms/out/tree-sitter-json.wasm")) {
      throw new Error("File not found (mocked)");
    }
    return original.promises.readFile(p, options);
  };
  const mockPromises = {
    ...original.promises,
    access: mockAccess,
    readFile: mockReadFile,
  };
  return {
    ...original,
    existsSync: mockExistsSync,
    promises: mockPromises,
    default: {
      ...original.default,
      existsSync: mockExistsSync,
      promises: mockPromises,
    },
  };
});

import { parseFile, resetParser } from "@core";
import { parseFallback, stripComments } from "../../src/core/parser/custom";
import {
  incrementConsecutiveErrors,
  findWasmPath,
  getLanguage,
  getWasmCacheDir,
  clearWasmCache,
  downloadWasmBinary,
} from "../../src/core/parser/wasm";

const TEST_CACHE_DIR = path.join(os.tmpdir(), `spelunk-test-cache-${Date.now()}`);

describe("Parser — AST and Regex Fallbacks", () => {
  beforeAll(() => {
    resetParser();
    process.env.SPELUNK_WASM_DIR = TEST_CACHE_DIR;
  });

  afterAll(() => {
    resetParser();
    delete process.env.SPELUNK_WASM_DIR;
    fs.rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.SPELUNK_WASM_DIR = TEST_CACHE_DIR;
    fs.rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      throw new Error(`Real network fetch blocked in test: ${url}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("JS: ES module imports extracted", async () => {
    const { imports } = await parseFile(
      "a.js",
      `import fs from 'fs';\nimport { x } from 'node:path';`,
    );
    expect(imports).toContain("fs");
    expect(imports).toContain("node:path");
  });

  test("JS/TS: re-exports extracted as imports", async () => {
    const { imports, exports } = await parseFile(
      "a.ts",
      `export { SpelunkDB } from "./db";\nexport * from "./scanner";`,
    );
    expect(imports).toContain("./db");
    expect(imports).toContain("./scanner");
    expect(exports).toContain("SpelunkDB");
  });

  test("JS: CommonJS require extracted", async () => {
    const { imports } = await parseFile("a.js", `const p = require('path');`);
    expect(imports).toContain("path");
  });

  test("TS: named exports extracted", async () => {
    const { exports } = await parseFile(
      "a.ts",
      `export const foo = 1;\nexport function bar() {}\nexport class Baz {}`,
    );
    expect(exports).toContain("foo");
    expect(exports).toContain("bar");
    expect(exports).toContain("Baz");
  });

  test("TS: type imports extracted", async () => {
    const { imports } = await parseFile("a.ts", `import type { Foo } from './foo';`);
    expect(imports).toContain("./foo");
  });

  test("Python: imports and exports extracted", async () => {
    const { imports, exports } = await parseFile(
      "a.py",
      `import os\nfrom pathlib import Path\nclass MyClass:\n    pass\ndef my_func():\n    pass`,
    );
    expect(imports).toContain("os");
    expect(imports).toContain("pathlib");
    expect(exports).toContain("MyClass");
    expect(exports).toContain("my_func");
  });

  test("Go: single + block imports extracted", async () => {
    const { imports } = await parseFile(
      "a.go",
      `import "fmt"\nimport (\n  "os"\n  "path/filepath"\n)`,
    );
    expect(imports).toContain("fmt");
    expect(imports).toContain("os");
    expect(imports).toContain("path/filepath");
  });

  test("Rust: use declarations and exports extracted", async () => {
    const { imports, exports } = await parseFile(
      "a.rs",
      `use std::fs;\nuse std::io::Write;\npub struct MyStruct {}\npub enum MyEnum {}\npub fn my_func() {}`,
    );
    expect(imports).toContain("std::fs");
    expect(imports).toContain("std::io::Write");
    expect(exports).toContain("MyStruct");
    expect(exports).toContain("MyEnum");
    expect(exports).toContain("my_func");
  });

  test("JS/TS variants: .mjs, .cjs, .mts, .cts extracted", async () => {
    const mjsResult = await parseFile("a.mjs", `import foo from 'bar';\nexport const baz = 1;`);
    expect(mjsResult.imports).toContain("bar");
    expect(mjsResult.exports).toContain("baz");

    const ctsResult = await parseFile(
      "a.cts",
      `import type { foo } from 'bar';\nexport function baz() {}`,
    );
    expect(ctsResult.imports).toContain("bar");
    expect(ctsResult.exports).toContain("baz");
  });

  test("Supported languages: 24+", async () => {
    const jvm = await parseFile("A.java", "import com.foo.Bar;\npublic class A {}");
    expect(jvm.imports).toContain("com.foo.Bar");
    expect(jvm.exports).toContain("A");

    const cpp = await parseFile("a.cpp", '#include "foo.h"\nclass MyClass {};');
    expect(cpp.imports).toContain("foo.h");
    expect(cpp.exports).toContain("MyClass");

    const cs = await parseFile("a.cs", "using System.Text;\npublic class Program {}");
    expect(cs.imports).toContain("System.Text");
    expect(cs.exports).toContain("Program");

    const php = await parseFile("a.php", "<?php use App\\Models\\User;\nclass Controller {}");
    expect(php.imports).toContain("App\\Models\\User");
    expect(php.exports).toContain("Controller");

    const swift = await parseFile("a.swift", "import Foundation\nstruct User {}");
    expect(swift.imports).toContain("Foundation");
    expect(swift.exports).toContain("User");

    const ruby = await parseFile("a.rb", "require 'json'\nclass MyClass\nend");
    expect(ruby.imports).toContain("json");
    expect(ruby.exports).toContain("MyClass");

    const sql = await parseFile("a.sql", "\\i references/init.sql\nCREATE TABLE users (id INT);");
    expect(sql.imports).toContain("references/init.sql");
    expect(sql.exports).toContain("users");

    const scala = await parseFile("A.scala", "import foo.bar\nclass A {}");
    expect(scala.imports).toContain("foo.bar");
    expect(scala.exports).toContain("A");

    const ocaml = await parseFile("a.ml", "open List");
    expect(ocaml.imports).toEqual([]); // parsed via wasm without custom extractor

    const ql = await parseFile("a.ql", "import java");
    expect(ql.imports).toEqual([]); // parsed via wasm without custom extractor

    const ejs = await parseFile("a.ejs", "<div></div>");
    expect(ejs.imports).toEqual([]); // parsed via wasm without custom extractor
  });

  test("Unsupported languages (no regex fallback): return empty arrays", async () => {
    const mdx = await parseFile("a.mdx", `import { Chart } from './Chart';`);
    expect(mdx.imports).toEqual([]);
    expect(mdx.exports).toEqual([]);

    const prisma = await parseFile("schema.prisma", "model User { id Int }");
    expect(prisma.imports).toEqual([]);
    expect(prisma.exports).toEqual([]);

    const css = await parseFile("style.css", ".btn { color: red; }");
    expect(css.imports).toEqual([]);
    expect(css.exports).toEqual([]);

    const xyz = await parseFile("a.xyz", "some content");
    expect(xyz.imports).toEqual([]);
    expect(xyz.exports).toEqual([]);
  });

  test("Verify AST parsing for unofficial languages (Zig, Elisp, Objective-C, Solidity, TLA+, Elm, ReScript)", async () => {
    const zig = await parseFile("a.zig", 'const std = @import("std");');
    expect(zig.imports).toEqual([]); // parsed via WASM

    const elisp = await parseFile("a.el", "(require 'cl-lib)");
    expect(elisp.imports).toEqual([]); // parsed via WASM

    const objc = await parseFile("a.m", "#import <Foundation/Foundation.h>");
    expect(objc.imports).toEqual([]); // parsed via WASM

    const solidity = await parseFile("a.sol", 'import "./Ownable.sol";');
    expect(solidity.imports).toEqual([]); // parsed via WASM

    const tla = await parseFile("a.tla", "EXTENDS Naturals");
    expect(tla.imports).toEqual([]); // parsed via WASM

    const elm = await parseFile("a.elm", "import Html");
    expect(elm.imports).toEqual([]); // parsed via WASM

    const res = await parseFile("a.res", "open Belt");
    expect(res.imports).toEqual([]); // parsed via WASM
  });

  test("Verify custom parsing for newly added formats", async () => {
    const sql = await parseFile(
      "schema.sql",
      "CREATE TABLE users (id int);\n\\i another.sql\nSOURCE third.sql",
    );
    expect(sql.exports).toContain("users");
    expect(sql.imports).toContain("another.sql");
    expect(sql.imports).toContain("third.sql");

    const ps = await parseFile(
      "script.ps1",
      'Import-Module ActiveDirectory\n. ".\\helper.ps1"\nfunction Get-User {}',
    );
    expect(ps.exports).toContain("Get-User");
    expect(ps.imports).toContain("ActiveDirectory");
    expect(ps.imports).toContain(".\\helper.ps1");

    const asm = await parseFile("main.asm", 'global _start\n%include "header.inc"');
    expect(asm.exports).toContain("_start");
    expect(asm.imports).toContain("header.inc");

    const svelte = await parseFile(
      "App.svelte",
      "<script>\nimport Header from './Header.svelte';\nexport let title = 'Hi';\n</script>",
    );
    expect(svelte.imports).toContain("./Header.svelte");
    expect(svelte.exports).toContain("title");

    const svelteWhitespace = await parseFile(
      "App.svelte",
      "<script>\nimport Header from './Header.svelte';\nexport let title = 'Hi';\n</script  >",
    );
    expect(svelteWhitespace.imports).toContain("./Header.svelte");
    expect(svelteWhitespace.exports).toContain("title");

    const svelteAttributes = await parseFile(
      "App.svelte",
      "<script>\nimport Header from './Header.svelte';\nexport let title = 'Hi';\n</script foo=\"bar\">",
    );
    expect(svelteAttributes.imports).toContain("./Header.svelte");
    expect(svelteAttributes.exports).toContain("title");

    const svelteCommented = await parseFile(
      "App.svelte",
      "<!-- <script>\nimport Hidden from './Hidden.svelte';\nexport let hidden = true;\n</script> -->\n<script>\nimport Visible from './Visible.svelte';\nexport let visible = true;\n</script>",
    );
    expect(svelteCommented.imports).toContain("./Visible.svelte");
    expect(svelteCommented.imports).not.toContain("./Hidden.svelte");
    expect(svelteCommented.exports).toContain("visible");
    expect(svelteCommented.exports).not.toContain("hidden");

    const svelteNestedCommented = await parseFile(
      "App.svelte",
      "<!-- <!-- <script>\nimport Hidden from './Hidden.svelte';\nexport let hidden = true;\n</script> --> -->\n<script>\nimport Visible from './Visible.svelte';\nexport let visible = true;\n</script>",
    );
    expect(svelteNestedCommented.imports).toContain("./Visible.svelte");
    expect(svelteNestedCommented.imports).not.toContain("./Hidden.svelte");
    expect(svelteNestedCommented.exports).toContain("visible");
    expect(svelteNestedCommented.exports).not.toContain("hidden");

    const astro = await parseFile(
      "index.astro",
      "---\nimport Layout from '../Layout.astro';\nexport const title = 'Home';\n---",
    );
    expect(astro.imports).toContain("../Layout.astro");
    expect(astro.exports).toContain("title");

    const dockerfile = await parseFile("Dockerfile", "FROM node:18-alpine");
    expect(dockerfile.imports).toContain("node:18-alpine");

    const packageJson = await parseFile(
      "package.json",
      JSON.stringify({
        name: "my-module",
        dependencies: { lodash: "^4.17.21" },
      }),
    );
    expect(packageJson.exports).toContain("my-module");
    expect(packageJson.imports).toContain("lodash");

    const reqs = await parseFile("requirements.txt", "requests==2.26.0\n# comment\n-r other.txt");
    expect(reqs.imports).toContain("requests");

    const make = await parseFile("Makefile", "include config.mk\nbuild:\n\techo 'Done'");
    expect(make.imports).toContain("config.mk");
    expect(make.exports).toContain("build");

    const webpack = await parseFile(
      "webpack.config.js",
      "const path = require('path');\nimport foo from 'bar';",
    );
    expect(webpack.imports).toContain("path");
    expect(webpack.imports).toContain("bar");

    const tf = await parseFile(
      "main.tf",
      'module "vpc" {\n  source = "./modules/vpc"\n}\nresource "aws_instance" "web" {}',
    );
    expect(tf.imports).toContain("./modules/vpc");
    expect(tf.exports).toContain("vpc");
    expect(tf.exports).toContain("aws_instance.web");

    const cargo = await parseFile(
      "Cargo.toml",
      '[package]\nname = "my-crate"\n[dependencies]\nserde = "1.0"',
    );
    expect(cargo.exports).toContain("my-crate");
    expect(cargo.imports).toContain("serde");

    const csvBasic = await parseFile("data.csv", "name,email,age");
    expect(csvBasic.exports).toEqual(["name", "email", "age"]);

    const csvQuoted = await parseFile("data.csv", "\"First Name\",'Last Name',age");
    expect(csvQuoted.exports).toEqual(["First Name", "Last Name", "age"]);

    const csvQuotesWithCommas = await parseFile("data.csv", '"Name, Full",email,phone');
    expect(csvQuotesWithCommas.exports).toEqual(["Name, Full", "email", "phone"]);

    const csvEscapedQuotes = await parseFile("data.csv", '"Name ""A""",email');
    expect(csvEscapedQuotes.exports).toEqual(['Name "A"', "email"]);

    const csvEmptyValues = await parseFile("data.csv", ",email,,phone,");
    expect(csvEmptyValues.exports).toEqual(["email", "phone"]);
  });

  test("Verify support is removed for requested extensions", async () => {
    const extensions = [
      ".resi",
      ".res",
      ".elm",
      ".php3",
      ".php4",
      ".tcc",
      ".jbuilder",
      ".phps",
      ".ctp",
      ".luau",
      ".edn",
      ".ru",
      ".csx",
      ".cxx",
      ".phtml",
      ".ksh",
    ];
    for (const ext of extensions) {
      const result = await parseFile(`test${ext}`, "some content");
      expect(result.imports).toEqual([]);
      expect(result.exports).toEqual([]);
    }
  });

  test("JS: CommonJS exports extracted", async () => {
    const { exports } = await parseFile(
      "a.js",
      `module.exports = myFunc;\nmodule.exports.baz = 1;\nexports.foo = bar;`,
    );
    expect(exports).toContain("myFunc");
    expect(exports).toContain("baz");
    expect(exports).toContain("foo");
  });

  test("Go: exports extracted (capitalized functions/types)", async () => {
    const { exports } = await parseFile(
      "a.go",
      `package main\nfunc MyExportedFunc() {}\nfunc privateFunc() {}\ntype MyExportedType struct {}`,
    );
    expect(exports).toContain("MyExportedFunc");
    expect(exports).toContain("MyExportedType");
    expect(exports).not.toContain("privateFunc");
  });

  test("Verify remaining custom formats parsing", async () => {
    const denoJson = await parseFile(
      "deno.json",
      JSON.stringify({ imports: { oak: "https://deno.land/x/oak/mod.ts" } }),
    );
    expect(denoJson.imports).toContain("https://deno.land/x/oak/mod.ts");

    const dockerCompose = await parseFile(
      "docker-compose.yml",
      "services:\n  web:\n    image: nginx:alpine\n    ports:\n      - '80:80'",
    );
    expect(dockerCompose.imports).toContain("nginx:alpine");

    const pnpmWorkspace = await parseFile(
      "pnpm-workspace.yaml",
      "packages:\n  - 'packages/*'\n  - '!**/test/**'",
    );
    expect(pnpmWorkspace.imports).toEqual(["packages/*", "!**/test/**"]);

    const pipfile = await parseFile(
      "Pipfile",
      "[packages]\nrequests = '*'\n[dev-packages]\npytest = '*'",
    );
    expect(pipfile.imports).toContain("requests");
    expect(pipfile.imports).toContain("pytest");

    const pyproject = await parseFile(
      "pyproject.toml",
      'dependencies = [\n  "requests>=2.26.0"\n]',
    );
    expect(pyproject.imports).toContain("requests");

    const pom = await parseFile(
      "pom.xml",
      "<project>\n  <dependencies>\n    <dependency>\n      <groupId>org.junit.jupiter</groupId>\n      <artifactId>junit-jupiter-api</artifactId>\n    </dependency>\n  </dependencies>\n</project>",
    );
    expect(pom.imports).toContain("org.junit.jupiter:junit-jupiter-api");

    const gradle = await parseFile(
      "build.gradle",
      "dependencies {\n    implementation 'com.google.guava:guava:30.1-jre'\n}",
    );
    expect(gradle.imports).toContain("com.google.guava:guava:30.1-jre");

    const composer = await parseFile(
      "composer.json",
      JSON.stringify({
        name: "my/project",
        require: { "monolog/monolog": "1.0.*" },
      }),
    );
    expect(composer.exports).toContain("my/project");
    expect(composer.imports).toContain("monolog/monolog");
  });

  test("Verify regex fallbacks for various file types", () => {
    const js = parseFallback(
      ".ts",
      "import x from 'y';\nexport const foo = 1;\nrequire('z');\nexport interface MyInterface<T> {}\nexport type MyType = string;\nexport enum MyEnum { A }\nexport async function myAsyncFunc<T extends object>() {}",
    );
    expect(js.imports).toContain("y");
    expect(js.imports).toContain("z");
    expect(js.exports).toContain("foo");
    expect(js.exports).toContain("MyInterface");
    expect(js.exports).toContain("MyType");
    expect(js.exports).toContain("MyEnum");
    expect(js.exports).toContain("myAsyncFunc");

    const py = parseFallback(
      ".py",
      "import foo\nfrom bar import baz\ndef my_func(): pass\nclass MyClass: pass",
    );
    expect(py.imports).toContain("foo");
    expect(py.imports).toContain("bar");
    expect(py.exports).toContain("my_func");
    expect(py.exports).toContain("MyClass");

    const go = parseFallback(".go", 'import (\n  "fmt"\n)\nfunc Exported() {}');
    expect(go.imports).toContain("fmt");
    expect(go.exports).toContain("Exported");

    const rs = parseFallback(".rs", "use std::io;\npub fn exported_func() {}");
    expect(rs.imports).toContain("std::io");
    expect(rs.exports).toContain("exported_func");

    const java = parseFallback(".java", "import java.util.List;\npublic class ExportedClass {}");
    expect(java.imports).toContain("java.util.List");
    expect(java.exports).toContain("ExportedClass");

    const cpp = parseFallback(".cpp", "#include <vector>\nclass ExportedClass {};");
    expect(cpp.imports).toContain("vector");
    expect(cpp.exports).toContain("ExportedClass");

    const cs = parseFallback(".cs", "using System;\npublic class ExportedClass {}");
    expect(cs.imports).toContain("System");
    expect(cs.exports).toContain("ExportedClass");

    const swift = parseFallback(".swift", "import UIKit\npublic class ExportedClass {}");
    expect(swift.imports).toContain("UIKit");
    expect(swift.exports).toContain("ExportedClass");

    const php = parseFallback(".php", "use App\\Models\\User;\nclass ExportedClass {}");
    expect(php.imports).toContain("App\\Models\\User");
    expect(php.exports).toContain("ExportedClass");

    const ruby = parseFallback(".rb", "require 'json'\nclass ExportedClass\nend");
    expect(ruby.imports).toContain("json");
    expect(ruby.exports).toContain("ExportedClass");

    const sql = parseFallback(
      ".sql",
      "\\i references/init.sql\nCREATE TABLE IF NOT EXISTS users (id INT);\nCREATE VIEW active_users AS SELECT 1;\nCREATE UNIQUE INDEX idx_email ON users(email);\nCREATE TYPE status_type AS ENUM ('a');",
    );
    expect(sql.imports).toContain("references/init.sql");
    expect(sql.exports).toContain("users");
    expect(sql.exports).toContain("active_users");
    expect(sql.exports).toContain("idx_email");
    expect(sql.exports).toContain("status_type");

    const psql = parseFallback(
      ".psql",
      "\\include extra.sql\nCREATE TEMPORARY TABLE temp_data (id INT);",
    );
    expect(psql.imports).toContain("extra.sql");
    expect(psql.exports).toContain("temp_data");

    const mysql = parseFallback(".mysql", "SOURCE tables.sql;\nCREATE TABLE `orders` (id INT);");
    expect(mysql.imports).toContain("tables.sql");
    expect(mysql.exports).toContain("orders");

    const mssql = parseFallback(".mssql", "CREATE TABLE [dbo].[Products] (id INT);");
    expect(mssql.exports).toContain("dbo.Products");
  });

  test("stripComments strips comments for different file types", () => {
    expect(stripComments("a // comment\nb", ".js", "")).toBe("a\nb");
    expect(stripComments("a /* comment */ b", ".js", "")).toBe("a  b");
    expect(stripComments("a // comment\nb", ".mjs", "")).toBe("a\nb");
    expect(stripComments("a // comment\nb", ".cjs", "")).toBe("a\nb");
    expect(stripComments("a // comment\nb", ".mts", "")).toBe("a\nb");
    expect(stripComments("a // comment\nb", ".cts", "")).toBe("a\nb");
    expect(stripComments("a // comment\nb", ".hpp", "")).toBe("a\nb");
    expect(stripComments("a // comment\nb", ".hh", "")).toBe("a\nb");
    expect(stripComments("a // comment\nb", ".kts", "")).toBe("a\nb");
    expect(stripComments("a // comment\nb", ".php5", "")).toBe("a\nb");
    expect(stripComments("a # comment\nb", ".py", "")).toBe("a\nb");
    expect(stripComments("a # comment\nb", ".pyi", "")).toBe("a\nb");
    expect(stripComments("a # comment\nb", ".gemspec", "")).toBe("a\nb");
    expect(stripComments("a # comment\nb", "", "makefile")).toBe("a\nb");
    expect(stripComments("a # comment\nb", "", "dockerfile")).toBe("a\nb");
    expect(stripComments("a # comment\nb", "", "foo.dockerfile")).toBe("a\nb");
    expect(stripComments("a -- comment\nb", ".sql", "")).toBe("a\nb");
    expect(stripComments("a /* comment */ b", ".sql", "")).toBe("a  b");
    expect(stripComments("a # comment\nb", ".ps1", "")).toBe("a\nb");
    expect(stripComments("a <# comment #> b", ".ps1", "")).toBe("a  b");
    expect(stripComments("a ; comment\nb", ".asm", "")).toBe("a\nb");
    expect(stripComments("a comment", ".txt", "")).toBe("a comment");

    // String-aware comment stripping validations (prevent URL corruption)
    expect(stripComments('const url = "http://example.com"; // comment', ".js", "")).toBe(
      'const url = "http://example.com";',
    );
    expect(stripComments("url = 'http://example.com#anchor' # comment", ".py", "")).toBe(
      "url = 'http://example.com#anchor'",
    );
    expect(stripComments('SELECT "http://url--here"; -- comment', ".sql", "")).toBe(
      'SELECT "http://url--here";',
    );
    expect(stripComments('echo "http://url#here" # comment', ".ps1", "")).toBe(
      'echo "http://url#here"',
    );
    expect(stripComments('db "http://url;here" ; comment', ".asm", "")).toBe(
      'db "http://url;here"',
    );
  });

  test("recycle parser on consecutive errors", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 52; i++) {
      incrementConsecutiveErrors();
    }
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Recycled parser instance after 50 consecutive syntax errors."),
    );
    errorSpy.mockRestore();
    resetParser();
  });

  test("findWasmPath precedence order: customDir/SPELUNK_WASM_DIR -> node_modules -> getWasmCacheDir -> script bundle dir", () => {
    const dummyDir = path.join(TEST_CACHE_DIR, "dummy_custom");
    fs.mkdirSync(dummyDir, { recursive: true });
    const dummyWasm = path.join(dummyDir, "tree-sitter-javascript.wasm");
    fs.writeFileSync(dummyWasm, "dummy");

    const foundCustom = findWasmPath(
      "node_modules/tree-sitter-wasms/out/tree-sitter-javascript.wasm",
      dummyDir,
    );
    expect(foundCustom).toBe(dummyWasm);

    process.env.SPELUNK_WASM_DIR = dummyDir;
    const foundEnv = findWasmPath("node_modules/tree-sitter-wasms/out/tree-sitter-javascript.wasm");
    expect(foundEnv).toBe(dummyWasm);
    delete process.env.SPELUNK_WASM_DIR;
  });

  test("getLanguage respects SPELUNK_FORCE_FALLBACK", async () => {
    process.env.SPELUNK_FORCE_FALLBACK = "true";
    const lang = await getLanguage(".js");
    expect(lang).toBeNull();
    delete process.env.SPELUNK_FORCE_FALLBACK;
  });

  test("getLanguage deduplicates warnings on regex fallback", async () => {
    resetParser();
    process.env.SPELUNK_OFFLINE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // First call emits warning
    await getLanguage(".unknown_nonexistent_ext"); // null because not in EXT_TO_WASM
    const lang1 = await getLanguage(".json"); // in EXT_TO_WASM, but mocked missing/offline
    expect(lang1).toBeNull();

    // Second call for same language should NOT emit duplicate warning
    const lang2 = await getLanguage(".json");
    expect(lang2).toBeNull();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[spelunk] Warning: Failed to load AST grammar for .json (tree-sitter-json.wasm). Falling back to regex parsing.",
      ),
    );
    delete process.env.SPELUNK_OFFLINE;
  });

  test("re-exports downloader functions from wasm.ts", () => {
    expect(typeof getWasmCacheDir).toBe("function");
    expect(typeof clearWasmCache).toBe("function");
    expect(typeof downloadWasmBinary).toBe("function");
  });
});
