import { expect, test, describe, beforeEach } from "vitest";
import { parseFile, resetParser } from "@core";

beforeEach(() => {
  resetParser(); // clean module state between tests
});

describe("Parser — AST parser", () => {
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

  test("Supported languages: JVM, C++, C#, PHP, Swift", async () => {
    // JVM
    const jvm = await parseFile("A.java", "import com.foo.Bar;\npublic class A {}");
    expect(jvm.imports).toContain("com.foo.Bar");
    expect(jvm.exports).toContain("A");

    // C/C++
    const cpp = await parseFile("a.cpp", '#include "foo.h"\nclass MyClass {};');
    expect(cpp.imports).toContain("foo.h");
    expect(cpp.exports).toContain("MyClass");

    // C#
    const cs = await parseFile("a.cs", "using System.Text;\npublic class Program {}");
    expect(cs.imports).toContain("System.Text");
    expect(cs.exports).toContain("Program");

    // PHP
    const php = await parseFile("a.php", "<?php use App\\Models\\User;\nclass Controller {}");
    expect(php.imports).toContain("App\\Models\\User");
    expect(php.exports).toContain("Controller");

    // Swift
    const swift = await parseFile("a.swift", "import Foundation\nstruct User {}");
    expect(swift.imports).toContain("Foundation");
    expect(swift.exports).toContain("User");

    // Ruby
    const ruby = await parseFile("a.rb", "require 'json'\nclass MyClass\nend");
    expect(ruby.imports).toContain("json");
    expect(ruby.exports).toContain("MyClass");
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

  test("Verify support is removed for Scala, Zig, OCaml, Elisp, Objective-C, Solidity, TLA+", async () => {
    const scala = await parseFile("A.scala", "import foo.bar\nclass A {}");
    expect(scala.imports).toEqual([]);
    expect(scala.exports).toEqual([]);

    const zig = await parseFile("a.zig", 'const std = @import("std");');
    expect(zig.imports).toEqual([]);
    expect(zig.exports).toEqual([]);

    const ocaml = await parseFile("a.ml", "open List");
    expect(ocaml.imports).toEqual([]);
    expect(ocaml.exports).toEqual([]);

    const elisp = await parseFile("a.el", "(require 'cl-lib)");
    expect(elisp.imports).toEqual([]);
    expect(elisp.exports).toEqual([]);

    const objc = await parseFile("a.m", "#import <Foundation/Foundation.h>");
    expect(objc.imports).toEqual([]);
    expect(objc.exports).toEqual([]);

    const solidity = await parseFile("a.sol", 'import "./Ownable.sol";');
    expect(solidity.imports).toEqual([]);
    expect(solidity.exports).toEqual([]);

    const tla = await parseFile("a.tla", "EXTENDS Naturals");
    expect(tla.imports).toEqual([]);
    expect(tla.exports).toEqual([]);
  });

  test("Verify custom parsing for newly added formats", async () => {
    // SQL
    const sql = await parseFile(
      "schema.sql",
      "CREATE TABLE users (id int);\n\\i another.sql\nSOURCE third.sql",
    );
    expect(sql.exports).toContain("users");
    expect(sql.imports).toContain("another.sql");
    expect(sql.imports).toContain("third.sql");

    // PowerShell
    const ps = await parseFile(
      "script.ps1",
      'Import-Module ActiveDirectory\n. ".\\helper.ps1"\nfunction Get-User {}',
    );
    expect(ps.exports).toContain("Get-User");
    expect(ps.imports).toContain("ActiveDirectory");
    expect(ps.imports).toContain(".\\helper.ps1");

    // Assembly
    const asm = await parseFile("main.asm", 'global _start\n%include "header.inc"');
    expect(asm.exports).toContain("_start");
    expect(asm.imports).toContain("header.inc");

    // Svelte
    const svelte = await parseFile(
      "App.svelte",
      "<script>\nimport Header from './Header.svelte';\nexport let title = 'Hi';\n</script>",
    );
    expect(svelte.imports).toContain("./Header.svelte");
    expect(svelte.exports).toContain("title");

    // Svelte with whitespace/attributes in closing tag
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

    // Svelte with commented-out script tags
    const svelteCommented = await parseFile(
      "App.svelte",
      "<!-- <script>\nimport Hidden from './Hidden.svelte';\nexport let hidden = true;\n</script> -->\n<script>\nimport Visible from './Visible.svelte';\nexport let visible = true;\n</script>",
    );
    expect(svelteCommented.imports).toContain("./Visible.svelte");
    expect(svelteCommented.imports).not.toContain("./Hidden.svelte");
    expect(svelteCommented.exports).toContain("visible");
    expect(svelteCommented.exports).not.toContain("hidden");

    // Svelte with nested commented-out script tags
    const svelteNestedCommented = await parseFile(
      "App.svelte",
      "<!-- <!-- <script>\nimport Hidden from './Hidden.svelte';\nexport let hidden = true;\n</script> --> -->\n<script>\nimport Visible from './Visible.svelte';\nexport let visible = true;\n</script>",
    );
    expect(svelteNestedCommented.imports).toContain("./Visible.svelte");
    expect(svelteNestedCommented.imports).not.toContain("./Hidden.svelte");
    expect(svelteNestedCommented.exports).toContain("visible");
    expect(svelteNestedCommented.exports).not.toContain("hidden");

    // Astro
    const astro = await parseFile(
      "index.astro",
      "---\nimport Layout from '../Layout.astro';\nexport const title = 'Home';\n---",
    );
    expect(astro.imports).toContain("../Layout.astro");
    expect(astro.exports).toContain("title");

    // Docker
    const dockerfile = await parseFile("Dockerfile", "FROM node:18-alpine");
    expect(dockerfile.imports).toContain("node:18-alpine");

    // npm/pnpm/yarn
    const packageJson = await parseFile(
      "package.json",
      JSON.stringify({
        name: "my-module",
        dependencies: { lodash: "^4.17.21" },
      }),
    );
    expect(packageJson.exports).toContain("my-module");
    expect(packageJson.imports).toContain("lodash");

    // Pip
    const reqs = await parseFile("requirements.txt", "requests==2.26.0\n# comment\n-r other.txt");
    expect(reqs.imports).toContain("requests");

    // Make
    const make = await parseFile("Makefile", "include config.mk\nbuild:\n\techo 'Done'");
    expect(make.imports).toContain("config.mk");
    expect(make.exports).toContain("build");

    // Webpack
    const webpack = await parseFile(
      "webpack.config.js",
      "const path = require('path');\nimport foo from 'bar';",
    );
    expect(webpack.imports).toContain("path");
    expect(webpack.imports).toContain("bar");

    // Terraform
    const tf = await parseFile(
      "main.tf",
      'module "vpc" {\n  source = "./modules/vpc"\n}\nresource "aws_instance" "web" {}',
    );
    expect(tf.imports).toContain("./modules/vpc");
    expect(tf.exports).toContain("vpc");
    expect(tf.exports).toContain("aws_instance.web");

    // Cargo
    const cargo = await parseFile(
      "Cargo.toml",
      '[package]\nname = "my-crate"\n[dependencies]\nserde = "1.0"',
    );
    expect(cargo.exports).toContain("my-crate");
    expect(cargo.imports).toContain("serde");

    // CSV
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
});
