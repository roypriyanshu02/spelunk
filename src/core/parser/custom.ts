import path from "node:path";

const C_STYLE_COMMENT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".svelte",
  ".astro",
  ".c",
  ".cpp",
  ".cc",
  ".c++",
  ".h",
  ".hpp",
  ".hh",
  ".hxx",
  ".h++",
  ".inl",
  ".ipp",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".cs",
  ".php",
  ".php5",
  ".swift",
]);
const SCRIPT_COMMENT_EXTENSIONS = new Set([
  ".py",
  ".pyi",
  ".pyw",
  ".rb",
  ".gemspec",
  ".rake",
  ".sh",
  ".yaml",
  ".yml",
  ".toml",
  ".mk",
]);
const SQL_COMMENT_EXTENSIONS = new Set([".sql", ".psql", ".mysql", ".mssql"]);
const POWERSHELL_COMMENT_EXTENSIONS = new Set([".ps1", ".psm1", ".psd1"]);
const ASM_COMMENT_EXTENSIONS = new Set([".asm", ".s", ".hsm"]);

const JS_FALLBACK_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);
const PYTHON_FALLBACK_EXTENSIONS = new Set([".py", ".pyi", ".pyw"]);
const JVM_FALLBACK_EXTENSIONS = new Set([".java", ".kt", ".kts"]);
const CPP_FALLBACK_EXTENSIONS = new Set([
  ".c",
  ".cpp",
  ".cc",
  ".c++",
  ".h",
  ".hpp",
  ".hh",
  ".hxx",
  ".h++",
  ".inl",
  ".ipp",
]);
const PHP_FALLBACK_EXTENSIONS = new Set([".php", ".php5"]);
const RUBY_FALLBACK_EXTENSIONS = new Set([".rb", ".gemspec", ".rake"]);

/** Static Set of file extensions parsed using custom/regex methods. */
export const customExtensions = new Set([
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
  ".sql",
  ".psql",
  ".mysql",
  ".mssql",
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
  "composer.json",
  "composer.lock",
  "bun.lockb",
  "bunfig.toml",
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
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if ((char === '"' || char === "'") && (i === 0 || line[i - 1] !== "\\")) {
      if (inQuotes && char === quoteChar) {
        if (i + 1 < line.length && line[i + 1] === quoteChar) {
          current += char;
          i++;
        } else {
          inQuotes = false;
        }
      } else if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else {
        current += char;
      }
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields.filter(Boolean);
}

// Static RegExp instances for comment stripping, line/string splitting, and regex parsers
const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;

const NEWLINE_SPLIT_REGEX = /\r?\n/;
const WS_SPLIT_REGEX = /\s+/;

const MAVEN_GROUP_REGEX = /<groupId>([^<]+)<\/groupId>/i;
const MAVEN_ARTIFACT_REGEX = /<artifactId>([^<]+)<\/artifactId>/i;
const CARGO_DEP_LINE_REGEX = /^\s*([a-zA-Z0-9_-]+)\s*=/;

// Static RegExp instances for fallback parsing
const PY_FALLBACK_IMPORT_REGEX = /^\s*(?:import\s+(\S+)|from\s+(\S+)\s+import)/gm;
const PY_FALLBACK_EXPORT_REGEX = /^\s*(?:class|def)\s+([a-zA-Z0-9_]+)/gm;

const GO_FALLBACK_IMPORT_REGEX = /^\s*import\s+(?:\(\s*([\s\S]*?)\)|"([^"]+)")/gm;
const GO_FALLBACK_EXPORT_REGEX = /^\s*(?:func|type|const|var)\s+([A-Z][a-zA-Z0-9_]*)/gm;
const GO_QUOTED_IMPORT_REGEX = /"([^"]+)"/;

const RS_FALLBACK_IMPORT_REGEX = /^\s*use\s+([^;]+);/gm;
const RS_FALLBACK_EXPORT_REGEX = /^\s*pub\s+(?:fn|struct|enum|type|trait|mod)\s+([a-zA-Z0-9_]+)/gm;

const JVM_FALLBACK_IMPORT_REGEX = /^\s*import\s+([^;]+);/gm;
const JVM_FALLBACK_EXPORT_REGEX =
  /^\s*(?:public\s+)?(?:class|interface|enum|object|trait)\s+([a-zA-Z0-9_]+)/gm;

const CPP_FALLBACK_IMPORT_REGEX = /^\s*#include\s+["<]([^">]+)[">]/gm;
const CPP_FALLBACK_EXPORT_REGEX = /^\s*(?:class|struct|namespace)\s+([a-zA-Z0-9_]+)/gm;

const CS_FALLBACK_IMPORT_REGEX = /^\s*using\s+([^;]+);/gm;
const CS_FALLBACK_EXPORT_REGEX =
  /^\s*(?:public\s+)?(?:class|interface|struct|enum|record|namespace)\s+([a-zA-Z0-9_]+)/gm;

const SWIFT_FALLBACK_IMPORT_REGEX = /^\s*import\s+(\S+)/gm;
const SWIFT_FALLBACK_EXPORT_REGEX =
  /^\s*(?:public\s+|open\s+)?(?:class|struct|protocol|enum|actor|extension)\s+([a-zA-Z0-9_]+)/gm;

const PHP_FALLBACK_IMPORT_REGEX = /^\s*use\s+([^;]+);/gm;
const PHP_FALLBACK_EXPORT_REGEX = /^\s*(?:class|interface|trait|enum)\s+([a-zA-Z0-9_]+)/gm;

const RUBY_FALLBACK_IMPORT_REGEX = /^\s*(?:require|load)\s+['"]([^'"]+)['"]/gm;
const RUBY_FALLBACK_EXPORT_REGEX = /^\s*(?:class|module)\s+([a-zA-Z0-9_]+)/gm;

function collectMatches(
  regex: RegExp,
  content: string,
  transform?: (match: RegExpExecArray) => string | undefined,
): string[] {
  regex.lastIndex = 0;
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const val = transform ? transform(match) : match[1];
    if (val) results.push(val);
  }
  return results;
}

// Unified JS-like Import/Export Regexes
const JS_IMPORT_REGEX = /import\s+(?:[^"']*?\s+from\s+)?['"]([^'"]+)['"]/g;
const JS_EXPORT_REGEX =
  /export\s+(?:default\s+)?(?:async\s+)?(?:let|const|var|function|class|interface|type|enum)\s+([a-zA-Z0-9_]+)/g;

const SQL_IMPORT_REGEX =
  /(?:\\i|source|\\import|import|\\include|include)\s+['"]?([^\s'";]+)['"]?/gi;
const SQL_EXPORT_REGEX =
  /create\s+(?:or\s+replace\s+)?(?:temporary\s+|temp\s+|unique\s+)?(?:table|view|procedure|function|trigger|index|type|enum|domain|schema|database)\s+(?:if\s+not\s+exists\s+)?([a-zA-Z0-9_"`.[\]]+)/gi;

const PS_IMPORT_REGEX = /(?:Import-Module|using\s+module)\s+['"]?([a-zA-Z0-9_\-./\\:]+)['"]?/gi;
const PS_DOT_REGEX = /^\s*\.\s+['"]?([^\r\n'"]+\.ps1)['"]?/gim;
const PS_EXPORT_REGEX = /function\s+([a-zA-Z0-9_-]+)/gi;

const ASM_IMPORT_REGEX = /^\s*[%]?include\s+['"<]?([a-zA-Z0-9_\-./\\]+)['">]?/gim;
const ASM_EXPORT_REGEX = /^\s*(?:global|public)\s+([a-zA-Z0-9_]+)/gim;

const SVELTE_SCRIPT_REGEX = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi;
const ASTRO_FM_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;
const DENO_COMMENT_REGEX = /\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm;

const DOCKER_FROM_REGEX = /^\s*FROM\s+(?:--[a-z-]+=\S+\s+)*([^\s#]+)/gim;
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

const TF_SOURCE_REGEX = /source\s*=\s*["']([^"']+)["']/gi;
const TF_MODULE_REGEX = /module\s+["']([^"']+)["']/gi;
const TF_RESOURCE_REGEX = /resource\s+["']([^"']+)["']\s+["']([^"']+)["']/gi;

const MAVEN_DEP_REGEX = /<dependency>([\s\S]*?)<\/dependency>/gi;
const CARGO_NAME_REGEX = /name\s*=\s*["']([^"']+)["']/i;
const CARGO_SECTION_REGEX = /^\[(.*\.)?((dev-|build-)?dependencies)\]/;

const GRADLE_DEP_REGEX =
  /(?:implementation|testImplementation|api|classpath)\s*\(?['"]([^'"]+)['"]/gi;

// Modular Language Parsers

function parseSql(content: string, imports: string[], exports: string[]) {
  SQL_IMPORT_REGEX.lastIndex = 0;
  SQL_EXPORT_REGEX.lastIndex = 0;
  let match;
  while ((match = SQL_IMPORT_REGEX.exec(content)) !== null) {
    imports.push(match[1]);
  }
  while ((match = SQL_EXPORT_REGEX.exec(content)) !== null) {
    const cleanName = match[1].replace(/["`[\]]/g, "");
    if (cleanName) {
      exports.push(cleanName);
    }
  }
}

function parsePowerShell(content: string, imports: string[], exports: string[]) {
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

function parseAssembly(content: string, imports: string[], exports: string[]) {
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

function parseSvelte(content: string, imports: string[], exports: string[]) {
  const cleanContent = content.includes("<!--") ? content.replace(HTML_COMMENT_REGEX, "") : content;
  SVELTE_SCRIPT_REGEX.lastIndex = 0;
  let scriptMatch;
  while ((scriptMatch = SVELTE_SCRIPT_REGEX.exec(cleanContent)) !== null) {
    const scriptContent = scriptMatch[1];
    JS_IMPORT_REGEX.lastIndex = 0;
    JS_EXPORT_REGEX.lastIndex = 0;
    let match;
    while ((match = JS_IMPORT_REGEX.exec(scriptContent)) !== null) {
      imports.push(match[1]);
    }
    while ((match = JS_EXPORT_REGEX.exec(scriptContent)) !== null) {
      exports.push(match[1]);
    }
  }
}

function parseAstro(content: string, imports: string[], exports: string[]) {
  const fmMatch = content.match(ASTRO_FM_REGEX);
  if (fmMatch) {
    const fmContent = fmMatch[1];
    JS_IMPORT_REGEX.lastIndex = 0;
    JS_EXPORT_REGEX.lastIndex = 0;
    let match;
    while ((match = JS_IMPORT_REGEX.exec(fmContent)) !== null) {
      imports.push(match[1]);
    }
    while ((match = JS_EXPORT_REGEX.exec(fmContent)) !== null) {
      exports.push(match[1]);
    }
  }
}

function parseDeno(content: string, imports: string[]) {
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

function parseDockerfile(content: string, imports: string[]) {
  DOCKER_FROM_REGEX.lastIndex = 0;
  let match;
  while ((match = DOCKER_FROM_REGEX.exec(content)) !== null) {
    imports.push(match[1]);
  }
}

function parseDockerCompose(content: string, imports: string[]) {
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

function parsePackageJson(content: string, imports: string[], exports: string[]) {
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
}

function parsePnpmWorkspace(content: string, imports: string[]) {
  PNPM_PKG_REGEX.lastIndex = 0;
  let match;
  while ((match = PNPM_PKG_REGEX.exec(content)) !== null) {
    imports.push(match[1]);
  }
}

function parsePipRequirements(content: string, imports: string[]) {
  const lines = content.split(NEWLINE_SPLIT_REGEX);
  for (const line of lines) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;

    const commentIndex = trimmed.indexOf("#");
    if (commentIndex !== -1) {
      trimmed = trimmed.slice(0, commentIndex).trim();
    }
    if (!trimmed) continue;

    const markerIndex = trimmed.indexOf(";");
    if (markerIndex !== -1) {
      trimmed = trimmed.slice(0, markerIndex).trim();
    }

    if (trimmed.includes("://") || trimmed.startsWith(".") || trimmed.startsWith("/")) {
      continue;
    }

    const pkgMatch = PIP_REQ_REGEX.exec(trimmed);
    if (pkgMatch) imports.push(pkgMatch[1].trim());
  }
}

function parsePipfile(content: string, imports: string[]) {
  PIP_FILE_REGEX.lastIndex = 0;
  let match;
  while ((match = PIP_FILE_REGEX.exec(content)) !== null) {
    imports.push(match[1]);
  }
}

function parsePyprojectToml(content: string, imports: string[]) {
  PIP_DEP_REGEX.lastIndex = 0;
  const depMatch = PIP_DEP_REGEX.exec(content);
  if (depMatch) {
    PIP_PKG_REGEX.lastIndex = 0;
    let match;
    while ((match = PIP_PKG_REGEX.exec(depMatch[1])) !== null) {
      imports.push(match[1]);
    }
  }
}

function parseMakefile(content: string, imports: string[], exports: string[]) {
  MAKE_INCLUDE_REGEX.lastIndex = 0;
  MAKE_TARGET_REGEX.lastIndex = 0;
  let match;
  while ((match = MAKE_INCLUDE_REGEX.exec(content)) !== null) {
    const files = match[1].trim().split(WS_SPLIT_REGEX);
    imports.push(...files);
  }
  while ((match = MAKE_TARGET_REGEX.exec(content)) !== null) {
    if (!match[1].startsWith(".")) {
      exports.push(match[1]);
    }
  }
}

function parseWebpackConfig(content: string, imports: string[]) {
  WEBPACK_REQ_REGEX.lastIndex = 0;
  JS_IMPORT_REGEX.lastIndex = 0;
  let match;
  while ((match = WEBPACK_REQ_REGEX.exec(content)) !== null) {
    imports.push(match[1]);
  }
  while ((match = JS_IMPORT_REGEX.exec(content)) !== null) {
    imports.push(match[1]);
  }
}

function parseTerraform(content: string, imports: string[], exports: string[]) {
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

function parseMavenPom(content: string, imports: string[]) {
  MAVEN_DEP_REGEX.lastIndex = 0;
  let blockMatch;
  while ((blockMatch = MAVEN_DEP_REGEX.exec(content)) !== null) {
    const block = blockMatch[1];
    const groupIdMatch = MAVEN_GROUP_REGEX.exec(block);
    const artifactIdMatch = MAVEN_ARTIFACT_REGEX.exec(block);
    if (groupIdMatch && artifactIdMatch) {
      imports.push(`${groupIdMatch[1].trim()}:${artifactIdMatch[1].trim()}`);
    }
  }
}

function parseCargoToml(content: string, imports: string[], exports: string[]) {
  const nameMatch = CARGO_NAME_REGEX.exec(content);
  if (nameMatch) exports.push(nameMatch[1]);

  const lines = content.split(NEWLINE_SPLIT_REGEX);
  let inDependencySection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed) continue;
    if (trimmed.startsWith("[")) {
      inDependencySection = CARGO_SECTION_REGEX.test(trimmed);
      continue;
    }
    if (inDependencySection) {
      const match = CARGO_DEP_LINE_REGEX.exec(trimmed);
      if (match) {
        imports.push(match[1]);
      }
    }
  }
}

function parseGradle(content: string, imports: string[]) {
  GRADLE_DEP_REGEX.lastIndex = 0;
  let match;
  while ((match = GRADLE_DEP_REGEX.exec(content)) !== null) {
    imports.push(match[1]);
  }
}

function parseComposerJson(content: string, imports: string[], exports: string[]) {
  try {
    const json = JSON.parse(content);
    if (json.name) exports.push(json.name);
    if (json.require) imports.push(...Object.keys(json.require));
    if (json["require-dev"]) imports.push(...Object.keys(json["require-dev"]));
  } catch {}
}

function parseCsv(content: string, exports: string[]) {
  const newlineIndex = content.indexOf("\n");
  const firstLine = newlineIndex === -1 ? content : content.slice(0, newlineIndex);
  if (firstLine) {
    const headers = parseCSVHeader(firstLine);
    exports.push(...headers);
  }
}

const C_STYLE_COMMENT_AND_STRING_REGEX =
  /("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(`(?:\\.|[^`\\])*`)|(<!--[\s\S]*?-->)|(\/\*[\s\S]*?\*\/)|([ \t]*\/\/.*)/g;
const HASH_COMMENT_AND_STRING_REGEX =
  /("""[\s\S]*?""")|('''[\s\S]*?''')|("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|([ \t]*#.*)/g;
const SQL_COMMENT_AND_STRING_REGEX =
  /("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(\/\*[\s\S]*?\*\/)|([ \t]*--.*)/g;
const PS_COMMENT_AND_STRING_REGEX =
  /("(?:[^`"]|`.)*")|('(?:[^']|'')*')|(<#[\s\S]*?#>)|([ \t]*#.*)/g;
const ASM_COMMENT_AND_STRING_REGEX = /("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|([ \t]*;.*)/g;

/**
 * Strips comments from the content based on file extension or filename
 * to avoid matching imports/exports inside comment blocks.
 */
export function stripComments(content: string, ext: string, filename: string): string {
  if (C_STYLE_COMMENT_EXTENSIONS.has(ext)) {
    return content.replace(
      C_STYLE_COMMENT_AND_STRING_REGEX,
      (match, dquote, squote, btick, htmlComment) => {
        if (dquote || squote || btick) {
          return match;
        }
        if (htmlComment) {
          return ext === ".svelte" || ext === ".astro" ? "" : match;
        }
        return "";
      },
    );
  }

  if (
    SCRIPT_COMMENT_EXTENSIONS.has(ext) ||
    filename === "makefile" ||
    filename === "dockerfile" ||
    filename.endsWith(".dockerfile") ||
    filename === "requirements.txt" ||
    filename === "pipfile" ||
    filename === "pyproject.toml" ||
    filename === "cargo.toml" ||
    filename === "pnpm-workspace.yaml"
  ) {
    return content.replace(
      HASH_COMMENT_AND_STRING_REGEX,
      (match, tripleD, tripleS, dquote, squote) => {
        if (tripleD || tripleS || dquote || squote) {
          return match;
        }
        return "";
      },
    );
  }

  if (SQL_COMMENT_EXTENSIONS.has(ext)) {
    return content.replace(SQL_COMMENT_AND_STRING_REGEX, (match, dquote, squote) => {
      if (dquote || squote) {
        return match;
      }
      return "";
    });
  }

  if (POWERSHELL_COMMENT_EXTENSIONS.has(ext)) {
    return content.replace(PS_COMMENT_AND_STRING_REGEX, (match, dquote, squote) => {
      if (dquote || squote) {
        return match;
      }
      return "";
    });
  }

  if (ASM_COMMENT_EXTENSIONS.has(ext)) {
    return content.replace(ASM_COMMENT_AND_STRING_REGEX, (match, dquote, squote) => {
      if (dquote || squote) {
        return match;
      }
      return "";
    });
  }

  return content;
}

type CustomParserFn = (content: string, imports: string[], exports: string[]) => void;

/** Registry mapping file extensions to custom parser functions. */
const EXTENSION_PARSERS: Record<string, CustomParserFn> = {
  ".sql": parseSql,
  ".psql": parseSql,
  ".mysql": parseSql,
  ".mssql": parseSql,
  ".ps1": parsePowerShell,
  ".psm1": parsePowerShell,
  ".psd1": parsePowerShell,
  ".asm": parseAssembly,
  ".s": parseAssembly,
  ".hsm": parseAssembly,
  ".svelte": parseSvelte,
  ".astro": parseAstro,
  ".tf": parseTerraform,
  ".tfvars": parseTerraform,
  ".mk": parseMakefile,
  ".csv": (content, _imp, exp) => parseCsv(content, exp),
};

/** Registry mapping exact filenames to custom parser functions. */
const FILENAME_PARSERS: Record<
  string,
  (content: string, imports: string[], exports: string[]) => void
> = {
  "deno.json": (content, imp) => parseDeno(content, imp),
  "deno.jsonc": (content, imp) => parseDeno(content, imp),
  "docker-compose.yml": (content, imp) => parseDockerCompose(content, imp),
  "docker-compose.yaml": (content, imp) => parseDockerCompose(content, imp),
  "package.json": parsePackageJson,
  "pnpm-workspace.yaml": (content, imp) => parsePnpmWorkspace(content, imp),
  "requirements.txt": (content, imp) => parsePipRequirements(content, imp),
  pipfile: (content, imp) => parsePipfile(content, imp),
  "pyproject.toml": (content, imp) => parsePyprojectToml(content, imp),
  makefile: parseMakefile,
  "pom.xml": (content, imp) => parseMavenPom(content, imp),
  "cargo.toml": parseCargoToml,
  "build.gradle": (content, imp) => parseGradle(content, imp),
  "build.gradle.kts": (content, imp) => parseGradle(content, imp),
  "composer.json": parseComposerJson,
};

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
  content = stripComments(content, ext, filename);
  const imports: string[] = [];
  const exports: string[] = [];

  if (filename.startsWith("dockerfile") || filename.endsWith(".dockerfile")) {
    parseDockerfile(content, imports);
  } else if (filename.startsWith("webpack.config.")) {
    parseWebpackConfig(content, imports);
  } else {
    const parser = EXTENSION_PARSERS[ext] || FILENAME_PARSERS[filename];
    if (parser) {
      parser(content, imports, exports);
    }
  }

  return {
    imports: Array.from(new Set(imports)),
    exports: Array.from(new Set(exports)),
  };
}

/**
 * Performs a regex-based fallback parsing for standard languages when AST parsing is unavailable.
 *
 * @param ext File extension
 * @param content File content to scan
 * @returns Object with parsed imports and exports arrays
 */
export function parseFallback(
  ext: string,
  content: string,
): { imports: string[]; exports: string[] } {
  content = stripComments(content, ext, "");
  const imports: string[] = [];
  const exports: string[] = [];

  if (JS_FALLBACK_EXTENSIONS.has(ext)) {
    imports.push(
      ...collectMatches(JS_IMPORT_REGEX, content),
      ...collectMatches(WEBPACK_REQ_REGEX, content),
    );
    exports.push(...collectMatches(JS_EXPORT_REGEX, content));
  } else if (PYTHON_FALLBACK_EXTENSIONS.has(ext)) {
    imports.push(...collectMatches(PY_FALLBACK_IMPORT_REGEX, content, (m) => m[1] || m[2]));
    exports.push(
      ...collectMatches(PY_FALLBACK_EXPORT_REGEX, content, (m) =>
        m[1].startsWith("_") ? undefined : m[1],
      ),
    );
  } else if (ext === ".go") {
    GO_FALLBACK_IMPORT_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = GO_FALLBACK_IMPORT_REGEX.exec(content)) !== null) {
      if (match[2]) {
        imports.push(match[2]);
      } else if (match[1]) {
        for (const line of match[1].split(NEWLINE_SPLIT_REGEX)) {
          const m = GO_QUOTED_IMPORT_REGEX.exec(line);
          if (m) imports.push(m[1]);
        }
      }
    }
    exports.push(...collectMatches(GO_FALLBACK_EXPORT_REGEX, content));
  } else if (ext === ".rs") {
    imports.push(...collectMatches(RS_FALLBACK_IMPORT_REGEX, content, (m) => m[1].trim()));
    exports.push(...collectMatches(RS_FALLBACK_EXPORT_REGEX, content));
  } else if (JVM_FALLBACK_EXTENSIONS.has(ext)) {
    imports.push(...collectMatches(JVM_FALLBACK_IMPORT_REGEX, content, (m) => m[1].trim()));
    exports.push(...collectMatches(JVM_FALLBACK_EXPORT_REGEX, content));
  } else if (CPP_FALLBACK_EXTENSIONS.has(ext)) {
    imports.push(...collectMatches(CPP_FALLBACK_IMPORT_REGEX, content));
    exports.push(...collectMatches(CPP_FALLBACK_EXPORT_REGEX, content));
  } else if (ext === ".cs") {
    imports.push(...collectMatches(CS_FALLBACK_IMPORT_REGEX, content, (m) => m[1].trim()));
    exports.push(...collectMatches(CS_FALLBACK_EXPORT_REGEX, content));
  } else if (ext === ".swift") {
    imports.push(...collectMatches(SWIFT_FALLBACK_IMPORT_REGEX, content));
    exports.push(...collectMatches(SWIFT_FALLBACK_EXPORT_REGEX, content));
  } else if (PHP_FALLBACK_EXTENSIONS.has(ext)) {
    imports.push(...collectMatches(PHP_FALLBACK_IMPORT_REGEX, content, (m) => m[1].trim()));
    exports.push(...collectMatches(PHP_FALLBACK_EXPORT_REGEX, content));
  } else if (RUBY_FALLBACK_EXTENSIONS.has(ext)) {
    imports.push(...collectMatches(RUBY_FALLBACK_IMPORT_REGEX, content));
    exports.push(...collectMatches(RUBY_FALLBACK_EXPORT_REGEX, content));
  } else if (SQL_COMMENT_EXTENSIONS.has(ext)) {
    parseSql(content, imports, exports);
  }

  return {
    imports: Array.from(new Set(imports)),
    exports: Array.from(new Set(exports)),
  };
}
