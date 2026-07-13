/**
 * @file custom.ts
 * @description Regex-based and schema-based parsers for non-AST file formats.
 */

import path from "node:path";

/** Static Set of file extensions parsed using custom/regex methods. */
export const customExtensions = new Set([
  ".sql",
  ".psql",
  ".mysql",
  ".mssql",
  ".ps1",
  ".psm1",
  ".psd1",
  ".asm",
  ".s",
  ".hsm",
  ".svelte",
  ".astro",
  ".tf",
  ".tfvars",
  ".terraform.lock.hcl",
  ".mk",
  ".sqlite",
  ".sqlite3",
  ".db",
  ".db3",
  ".s3db",
  ".sl3",
  ".mdb",
  ".accdb",
  ".duckdb",
  ".ora",
  ".csv",
]);

export const customFilenames = new Set([
  "deno.json",
  "deno.jsonc",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".dockerignore",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  ".npmrc",
  ".yarnrc",
  "requirements.txt",
  "pipfile",
  "pipfile.lock",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "makefile",
  "webpack.config.js",
  "webpack.config.ts",
  "webpack.config.cjs",
  "webpack.config.mjs",
  "webpack.config.babel.js",
  "pom.xml",
  "cargo.toml",
  "cargo.lock",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "ansible.cfg",
  "hosts",
  "playbook.yml",
  "playbook.yaml",
  "composer.json",
  "composer.lock",
  "bun.lockb",
  "bunfig.toml",
  "postgresql.conf",
  "pg_hba.conf",
  "my.cnf",
  "my.ini",
  "redis.conf",
  "mongod.conf",
  "mongo.conf",
  "mariadb.cnf",
  "elasticsearch.yml",
  "elasticsearch.yaml",
  "tnsnames.ora",
  "listener.ora",
  "sqlnet.ora",
  "dynamodb.json",
  "dynamodb-local.json",
  "bigquery.json",
  "config.toml",
  "supabase.toml",
  "firestore.indexes.json",
  "firestore.rules",
  "h2.properties",
  "database.rules.json",
  "cosmosdb.json",
  "snowflake.yml",
  "snowflake.yaml",
  "influxdb.conf",
  "influxdb.yaml",
  "databricks.json",
  "databricks-sql.json",
  "cassandra.yaml",
  "cassandra.conf",
  "neo4j.conf",
  "valkey.conf",
  "clickhouse-config.xml",
  "clickhouse-server.xml",
  "db2.conf",
  "redshift.json",
  "cockroach.json",
  "pb_schema.json",
  "datomic.json",
]);

/**
 * Determines whether a file path corresponds to a custom non-AST format (e.g. SQL, Svelte, CSV, Dockerfile, pnpm configs).
 *
 * @param filePath The file path to check.
 * @returns True if the file should be parsed using regex or custom parsers, false otherwise.
 */
export function isCustomFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const filename = path.basename(filePath).toLowerCase();

  if (filename.startsWith("dockerfile") || filename.endsWith(".dockerfile")) {
    return true;
  }

  return customExtensions.has(ext) || customFilenames.has(filename);
}

/**
 * Parses the header line of a CSV file, accounting for potential quoted fields and escapes.
 *
 * @param line The first line (header) of the CSV file.
 * @returns An array of trimmed header names.
 */
export function parseCSVHeader(line: string): string[] {
  const headers: string[] = [];
  let i = 0;
  while (i < line.length) {
    // Skip leading whitespace of the field
    while (i < line.length && /\s/.test(line[i])) {
      i++;
    }
    if (i >= line.length) break;

    let field = "";
    if (line[i] === '"' || line[i] === "'") {
      const quoteChar = line[i];
      i++; // skip the quote
      while (i < line.length) {
        if (line[i] === quoteChar) {
          // Check for escaped quote (two consecutive quotes)
          if (i + 1 < line.length && line[i + 1] === quoteChar) {
            field += quoteChar;
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          field += line[i];
          i++;
        }
      }
      // Consume until the next comma or end of string
      while (i < line.length && line[i] !== ",") {
        i++;
      }
      if (i < line.length && line[i] === ",") {
        i++;
      }
    } else {
      // Unquoted field
      const commaIndex = line.indexOf(",", i);
      if (commaIndex === -1) {
        field = line.slice(i);
        i = line.length;
      } else {
        field = line.slice(i, commaIndex);
        i = commaIndex + 1;
      }
    }
    headers.push(field.trim());
  }
  return headers.filter(Boolean);
}

// Pre-compiled regex patterns to avoid compiler and GC overhead
const SQL_IMPORT_REGEX = /(?:\\i|source)\s+['"]?([^\s'";]+)['"]?/gi;
const SQL_EXPORT_REGEX =
  /create\s+(?:or\s+replace\s+)?(?:table|view|procedure|function|trigger)\s+([a-zA-Z0-9_".]+)/gi;

const PS_IMPORT_REGEX = /(?:Import-Module|using\s+module)\s+['"]?([a-zA-Z0-9_\-./\\:]+)['"]?/gi;
const PS_DOT_REGEX = /^\s*\.\s+['"]?([^\r\n'"]+\.ps1)['"]?/gim;
const PS_EXPORT_REGEX = /function\s+([a-zA-Z0-9_-]+)/gi;

const ASM_IMPORT_REGEX = /^\s*[%]?include\s+['"<]?([a-zA-Z0-9_\-./\\]+)['">]?/gim;
const ASM_EXPORT_REGEX = /^\s*(?:global|public)\s+([a-zA-Z0-9_]+)/gim;

const SVELTE_SCRIPT_REGEX = /<script[^>]*>([\s\S]*?)<\/script>/gi;
const SVELTE_IMPORT_REGEX = /import\s+(?:[^"']*?\s+from\s+)?['"]([^'"]+)['"]/g;
const SVELTE_EXPORT_REGEX = /export\s+(?:let|const|var|function|class)\s+([a-zA-Z0-9_]+)/g;

const ASTRO_FM_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/d;
const ASTRO_IMPORT_REGEX = /import\s+(?:[^"']*?\s+from\s+)?['"]([^'"]+)['"]/g;
const ASTRO_EXPORT_REGEX = /export\s+(?:let|const|var|function|class)\s+([a-zA-Z0-9_]+)/g;

const DENO_COMMENT_REGEX = /\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm;

const DOCKER_FROM_REGEX = /^\s*FROM\s+([^\s#]+)/gim;
const DOCKER_IMAGE_REGEX = /image\s*:\s*([^\r\n#\s]+)/gi;
const DOCKER_BUILD_REGEX = /context\s*:\s*([^\r\n#\s]+)/gi;

const PNPM_PKG_REGEX = /-\s*['"]?([^\r\n'"]+)['"]?/gi;

const PIP_REQ_REGEX = /^([a-zA-Z0-9_\-[\]]+)/;
const PIP_FILE_REGEX = /^\s*([a-zA-Z0-9_-]+)\s*=\s*/gm;
const PIP_DEP_REGEX = /dependencies\s*=\s*\[([\s\S]*?)\]/gi;
const PIP_PKG_REGEX = /['"]([a-zA-Z0-9_-]+)/g;

const MAKE_INCLUDE_REGEX = /^\s*-?include\s+([^\r\n#]+)/gm;
const MAKE_TARGET_REGEX = /^([a-zA-Z0-9_\-./]+)\s*:(?!=)/gm;

const WEBPACK_REQ_REGEX = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const WEBPACK_IMPORT_REGEX = /import\s+(?:[^"']*?\s+from\s+)?['"]([^'"]+)['"]/g;

const TF_SOURCE_REGEX = /source\s*=\s*["']([^"']+)["']/gi;
const TF_MODULE_REGEX = /module\s+["']([^"']+)["']/gi;
const TF_RESOURCE_REGEX = /resource\s+["']([^"']+)["']\s+["']([^"']+)["']/gi;

const MAVEN_DEP_REGEX = /<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/gi;

const CARGO_NAME_REGEX = /name\s*=\s*["']([^"']+)["']/i;
const CARGO_PKG_REGEX = /^\s*([a-zA-Z0-9_-]+)\s*=\s*/gm;

const GRADLE_DEP_REGEX =
  /(?:implementation|testImplementation|api|classpath)\s*\(?['"]([^'"]+)['"]/gi;

/**
 * Parses non-AST files (config files, scripts, lockfiles, CSVs) using regex or custom parsers.
 *
 * @param filePath File path
 * @param content File content
 * @returns Imports and exports lists
 */
export function parseCustomFile(
  filePath: string,
  content: string,
): { imports: string[]; exports: string[] } {
  const ext = path.extname(filePath).toLowerCase();
  const filename = path.basename(filePath).toLowerCase();
  const imports: string[] = [];
  const exports: string[] = [];

  // 1. SQL
  if ([".sql", ".psql", ".mysql", ".mssql"].includes(ext)) {
    SQL_IMPORT_REGEX.lastIndex = 0;
    SQL_EXPORT_REGEX.lastIndex = 0;
    let match;
    while ((match = SQL_IMPORT_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
    while ((match = SQL_EXPORT_REGEX.exec(content)) !== null) {
      exports.push(match[1].replace(/"/g, ""));
    }
  }
  // 2. PowerShell
  else if ([".ps1", ".psm1", ".psd1"].includes(ext)) {
    PS_IMPORT_REGEX.lastIndex = 0;
    PS_DOT_REGEX.lastIndex = 0;
    PS_EXPORT_REGEX.lastIndex = 0;
    let match;
    while ((match = PS_IMPORT_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
    while ((match = PS_DOT_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
    while ((match = PS_EXPORT_REGEX.exec(content)) !== null) {
      exports.push(match[1]);
    }
  }
  // 3. Assembly
  else if ([".asm", ".s", ".hsm"].includes(ext)) {
    ASM_IMPORT_REGEX.lastIndex = 0;
    ASM_EXPORT_REGEX.lastIndex = 0;
    let match;
    while ((match = ASM_IMPORT_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
    while ((match = ASM_EXPORT_REGEX.exec(content)) !== null) {
      exports.push(match[1]);
    }
  }
  // 4. Svelte
  else if (ext === ".svelte") {
    SVELTE_SCRIPT_REGEX.lastIndex = 0;
    let scriptMatch;
    while ((scriptMatch = SVELTE_SCRIPT_REGEX.exec(content)) !== null) {
      const scriptContent = scriptMatch[1];
      SVELTE_IMPORT_REGEX.lastIndex = 0;
      SVELTE_EXPORT_REGEX.lastIndex = 0;
      let match;
      while ((match = SVELTE_IMPORT_REGEX.exec(scriptContent)) !== null) {
        imports.push(match[1]);
      }
      while ((match = SVELTE_EXPORT_REGEX.exec(scriptContent)) !== null) {
        exports.push(match[1]);
      }
    }
  }
  // 5. Astro
  else if (ext === ".astro") {
    const fmMatch = content.match(ASTRO_FM_REGEX);
    if (fmMatch) {
      const fmContent = fmMatch[1];
      ASTRO_IMPORT_REGEX.lastIndex = 0;
      ASTRO_EXPORT_REGEX.lastIndex = 0;
      let match;
      while ((match = ASTRO_IMPORT_REGEX.exec(fmContent)) !== null) {
        imports.push(match[1]);
      }
      while ((match = ASTRO_EXPORT_REGEX.exec(fmContent)) !== null) {
        exports.push(match[1]);
      }
    }
  }
  // 6. Deno
  else if (filename === "deno.json" || filename === "deno.jsonc") {
    try {
      DENO_COMMENT_REGEX.lastIndex = 0;
      const cleanContent = content.replace(DENO_COMMENT_REGEX, "$1");
      const json = JSON.parse(cleanContent);
      if (json.imports) {
        for (const val of Object.values(json.imports)) {
          if (typeof val === "string") imports.push(val);
        }
      }
      if (json.scopes) {
        for (const scopeVal of Object.values(json.scopes)) {
          if (typeof scopeVal === "object" && scopeVal !== null) {
            for (const val of Object.values(scopeVal)) {
              if (typeof val === "string") imports.push(val);
            }
          }
        }
      }
    } catch {}
  }
  // 7. Docker
  else if (filename.startsWith("dockerfile") || filename.endsWith(".dockerfile")) {
    DOCKER_FROM_REGEX.lastIndex = 0;
    let match;
    while ((match = DOCKER_FROM_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
  } else if (filename === "docker-compose.yml" || filename === "docker-compose.yaml") {
    DOCKER_IMAGE_REGEX.lastIndex = 0;
    DOCKER_BUILD_REGEX.lastIndex = 0;
    let match;
    while ((match = DOCKER_IMAGE_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
    while ((match = DOCKER_BUILD_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
  }
  // 8. npm, pnpm, yarn
  else if (filename === "package.json") {
    try {
      const json = JSON.parse(content);
      if (json.name) exports.push(json.name);
      for (const key of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        if (json[key]) {
          imports.push(...Object.keys(json[key]));
        }
      }
    } catch {}
  } else if (filename === "pnpm-workspace.yaml") {
    PNPM_PKG_REGEX.lastIndex = 0;
    let match;
    while ((match = PNPM_PKG_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
  }
  // 9. Pip
  else if (filename === "requirements.txt") {
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("-")) {
        const pkgMatch = PIP_REQ_REGEX.exec(trimmed);
        if (pkgMatch) imports.push(pkgMatch[1]);
      }
    }
  } else if (filename === "pipfile") {
    PIP_FILE_REGEX.lastIndex = 0;
    let match;
    while ((match = PIP_FILE_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
  } else if (filename === "pyproject.toml") {
    PIP_DEP_REGEX.lastIndex = 0;
    let depMatch = PIP_DEP_REGEX.exec(content);
    if (depMatch) {
      PIP_PKG_REGEX.lastIndex = 0;
      let match;
      while ((match = PIP_PKG_REGEX.exec(depMatch[1])) !== null) {
        imports.push(match[1]);
      }
    }
  }
  // 10. Make
  else if (filename === "makefile" || ext === ".mk") {
    MAKE_INCLUDE_REGEX.lastIndex = 0;
    MAKE_TARGET_REGEX.lastIndex = 0;
    let match;
    while ((match = MAKE_INCLUDE_REGEX.exec(content)) !== null) {
      const files = match[1].trim().split(/\s+/);
      imports.push(...files);
    }
    while ((match = MAKE_TARGET_REGEX.exec(content)) !== null) {
      if (!match[1].startsWith(".")) {
        exports.push(match[1]);
      }
    }
  }
  // 11. Webpack
  else if (filename.startsWith("webpack.config.")) {
    WEBPACK_REQ_REGEX.lastIndex = 0;
    WEBPACK_IMPORT_REGEX.lastIndex = 0;
    let match;
    while ((match = WEBPACK_REQ_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
    while ((match = WEBPACK_IMPORT_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
  }
  // 12. Terraform
  else if ([".tf", ".tfvars"].includes(ext)) {
    TF_SOURCE_REGEX.lastIndex = 0;
    TF_MODULE_REGEX.lastIndex = 0;
    TF_RESOURCE_REGEX.lastIndex = 0;
    let match;
    while ((match = TF_SOURCE_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
    while ((match = TF_MODULE_REGEX.exec(content)) !== null) {
      exports.push(match[1]);
    }
    while ((match = TF_RESOURCE_REGEX.exec(content)) !== null) {
      exports.push(`${match[1]}.${match[2]}`);
    }
  }
  // 13. Maven
  else if (filename === "pom.xml") {
    MAVEN_DEP_REGEX.lastIndex = 0;
    let match;
    while ((match = MAVEN_DEP_REGEX.exec(content)) !== null) {
      imports.push(`${match[1]}:${match[2]}`);
    }
  }
  // 14. Cargo
  else if (filename === "cargo.toml") {
    const nameMatch = CARGO_NAME_REGEX.exec(content);
    if (nameMatch) exports.push(nameMatch[1]);
    CARGO_PKG_REGEX.lastIndex = 0;
    let match;
    while ((match = CARGO_PKG_REGEX.exec(content)) !== null) {
      if (
        match[1] !== "name" &&
        match[1] !== "version" &&
        match[1] !== "authors" &&
        match[1] !== "edition"
      ) {
        imports.push(match[1]);
      }
    }
  }
  // 15. Gradle
  else if (filename === "build.gradle" || filename === "build.gradle.kts") {
    GRADLE_DEP_REGEX.lastIndex = 0;
    let match;
    while ((match = GRADLE_DEP_REGEX.exec(content)) !== null) {
      imports.push(match[1]);
    }
  }
  // 16. Composer
  else if (filename === "composer.json") {
    try {
      const json = JSON.parse(content);
      if (json.name) exports.push(json.name);
      if (json.require) imports.push(...Object.keys(json.require));
      if (json["require-dev"]) imports.push(...Object.keys(json["require-dev"]));
    } catch {}
  }
  // 17. CSV
  else if (ext === ".csv") {
    const firstLine = content.split(/\r?\n/)[0];
    if (firstLine) {
      const headers = parseCSVHeader(firstLine);
      exports.push(...headers);
    }
  }

  return {
    imports: Array.from(new Set(imports)),
    exports: Array.from(new Set(exports)),
  };
}
