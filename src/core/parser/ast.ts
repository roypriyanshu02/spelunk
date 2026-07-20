import Parser from "web-tree-sitter";

const RUBY_IMPORT_METHODS = new Set(["require", "require_relative", "load", "import"]);
const JS_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);
const PYTHON_EXTENSIONS = new Set([".py", ".pyi", ".pyw"]);
const JVM_EXTENSIONS = new Set([".java", ".kt", ".kts", ".scala", ".sc", ".sbt"]);
const CPP_EXTENSIONS = new Set([
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
const PHP_EXTENSIONS = new Set([".php", ".php5"]);
const RUBY_EXTENSIONS = new Set([".rb", ".gemspec", ".rake"]);

/**
 * Traverses a syntax node in pre-order without using call stack recursion.
 *
 * @param rootNode Tree-sitter root node to walk
 * @param callback Function called on each visited node. Return false to skip visiting its children.
 */
export function traverse(
  rootNode: Parser.SyntaxNode,
  callback: (node: Parser.SyntaxNode) => boolean | void,
) {
  const cursor = rootNode.walk();
  try {
    while (true) {
      const node = cursor.currentNode;
      const goDeeper = callback(node) !== false;

      if (goDeeper && cursor.gotoFirstChild()) {
        continue;
      }
      if (cursor.gotoNextSibling()) {
        continue;
      }
      let backtracking = true;
      while (backtracking) {
        if (!cursor.gotoParent()) {
          return;
        }
        if (cursor.gotoNextSibling()) {
          backtracking = false;
        }
      }
    }
  } finally {
    cursor.delete();
  }
}

function extractJs(tree: Parser.Tree) {
  const imports: string[] = [];
  const exports: string[] = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "import_statement") {
      const sourceNode = node.childForFieldName("source");
      if (sourceNode) {
        imports.push(sourceNode.text.replace(/['"]/g, ""));
      }
      return false;
    }

    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn && fn.text === "require") {
        const args = node.childForFieldName("arguments");
        if (args) {
          const firstArg = args.namedChild(0);
          if (firstArg && (firstArg.type === "string" || firstArg.type === "string_literal")) {
            imports.push(firstArg.text.replace(/['"]/g, ""));
          }
        }
      }
    }

    if (node.type === "export_statement") {
      const sourceNode = node.childForFieldName("source");
      if (sourceNode) {
        imports.push(sourceNode.text.replace(/['"]/g, ""));
      }
      const declarationNode = node.childForFieldName("declaration");
      if (declarationNode) {
        if (
          declarationNode.type === "lexical_declaration" ||
          declarationNode.type === "variable_declaration"
        ) {
          for (let i = 0; i < declarationNode.childCount; i++) {
            const child = declarationNode.child(i);
            if (child && child.type === "variable_declarator") {
              const nameNode = child.childForFieldName("name");
              if (nameNode) exports.push(nameNode.text);
            }
          }
        } else {
          const nameNode =
            declarationNode.childForFieldName("name") || declarationNode.namedChild(0);
          if (nameNode) exports.push(nameNode.text);
        }
      }
    }

    if (node.type === "export_specifier") {
      const nameNode =
        node.childForFieldName("alias") || node.childForFieldName("name") || node.namedChild(0);
      if (nameNode) exports.push(nameNode.text);
      return false;
    }

    if (node.type === "assignment_expression") {
      const left = node.childForFieldName("left");
      if (left) {
        if (left.text === "module.exports" || left.text === "exports") {
          const right = node.childForFieldName("right");
          if (right) {
            if (right.type === "identifier") {
              exports.push(right.text);
            } else if (right.type === "assignment_expression") {
              const deepRight = right.childForFieldName("right");
              if (deepRight && deepRight.type === "identifier") {
                exports.push(deepRight.text);
              }
            } else if (
              right.type === "function_expression" ||
              right.type === "function_declaration"
            ) {
              const name = right.childForFieldName("name");
              if (name) exports.push(name.text);
            }
          }
        } else if (left.type === "member_expression") {
          const obj = left.childForFieldName("object");
          const prop = left.childForFieldName("property");
          if (obj && prop && (obj.text === "exports" || obj.text === "module.exports")) {
            exports.push(prop.text);
          }
        }
      }
    }

    if (
      node.type === "class_body" ||
      node.type === "object" ||
      node.type === "array" ||
      node.type === "statement_block"
    ) {
      return false;
    }
  });

  return { imports, exports };
}

function extractPython(tree: Parser.Tree) {
  const imports: string[] = [];
  const exports: string[] = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "import_statement") {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === "dotted_name") {
          imports.push(child.text);
        }
      }
      return false;
    }
    if (node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module") || node.namedChild(0);
      if (moduleNode) {
        imports.push(moduleNode.text);
      }
      return false;
    }
    if (node.type === "class_definition" || node.type === "function_definition") {
      if (node.parent?.type === "module") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const name = nameNode.text;
          if (!name.startsWith("_")) {
            exports.push(name);
          }
        }
      }
      return false;
    }
  });

  return { imports, exports };
}

function extractGo(tree: Parser.Tree) {
  const imports: string[] = [];
  const exports: string[] = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "import_spec") {
      const pathNode = node.childForFieldName("path");
      if (pathNode) {
        imports.push(pathNode.text.replace(/['"]/g, ""));
      }
      return false;
    }
    if (
      node.type === "function_declaration" ||
      node.type === "type_spec" ||
      node.type === "value_spec"
    ) {
      const nameNode = node.childForFieldName("name");
      if (nameNode && /^[A-Z]/.test(nameNode.text)) {
        exports.push(nameNode.text);
      }
      return false;
    }
  });

  return { imports, exports };
}

function extractRust(tree: Parser.Tree) {
  const imports: string[] = [];
  const exports: string[] = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "use_declaration") {
      const pathNode = node.namedChild(0);
      if (pathNode) {
        imports.push(pathNode.text);
      }
      return false;
    }
    if (
      node.type === "function_item" ||
      node.type === "struct_item" ||
      node.type === "enum_item" ||
      node.type === "type_item" ||
      node.type === "trait_item" ||
      node.type === "mod_item"
    ) {
      let isPublic = false;
      for (let i = 0; i < node.childCount; i++) {
        if (node.child(i)?.type === "visibility_modifier") {
          isPublic = true;
          break;
        }
      }
      if (isPublic) {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          exports.push(nameNode.text);
        }
      }
      return false;
    }
  });

  return { imports, exports };
}

function extractJvm(tree: Parser.Tree) {
  const imports: string[] = [];
  const exports: string[] = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "import_declaration") {
      const nameNode = node.childForFieldName("name") || node.namedChild(0);
      if (nameNode) imports.push(nameNode.text);
      return false;
    }
    if (
      node.type === "class_declaration" ||
      node.type === "class_definition" ||
      node.type === "interface_declaration" ||
      node.type === "interface_definition" ||
      node.type === "enum_declaration" ||
      node.type === "enum_definition" ||
      node.type === "object_declaration" ||
      node.type === "object_definition" ||
      node.type === "trait_declaration" ||
      node.type === "trait_definition"
    ) {
      const nameNode = node.childForFieldName("name");
      if (nameNode) exports.push(nameNode.text);
      return false;
    }
  });

  return { imports, exports };
}

function extractCpp(tree: Parser.Tree) {
  const imports: string[] = [];
  const exports: string[] = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "preproc_include") {
      const pathNode = node.childForFieldName("path") || node.namedChild(0);
      if (pathNode) {
        imports.push(pathNode.text.replace(/['"<>]/g, ""));
      }
      return false;
    }
    if (
      node.type === "class_specifier" ||
      node.type === "struct_specifier" ||
      node.type === "namespace_definition"
    ) {
      const nameNode = node.childForFieldName("name");
      if (nameNode) exports.push(nameNode.text);
      if (node.type === "class_specifier" || node.type === "struct_specifier") {
        return false;
      }
    }
  });

  return { imports, exports };
}

function extractCsharp(tree: Parser.Tree) {
  const imports: string[] = [];
  const exports: string[] = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "using_directive") {
      const nameNode = node.namedChild(0);
      if (nameNode) {
        imports.push(nameNode.text.replace(/;/g, "").trim());
      }
      return false;
    }
    if (
      node.type === "class_declaration" ||
      node.type === "interface_declaration" ||
      node.type === "struct_declaration" ||
      node.type === "enum_declaration" ||
      node.type === "record_declaration" ||
      node.type === "namespace_declaration"
    ) {
      const nameNode = node.childForFieldName("name") || node.namedChild(0);
      if (nameNode) exports.push(nameNode.text);
      if (node.type !== "namespace_declaration") {
        return false;
      }
    }
  });

  return { imports, exports };
}

function extractSwift(tree: Parser.Tree) {
  const imports: string[] = [];
  const exports: string[] = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "import_declaration") {
      const pathNode = node.namedChild(0);
      if (pathNode) imports.push(pathNode.text);
      return false;
    }
    if (
      node.type === "class_declaration" ||
      node.type === "struct_declaration" ||
      node.type === "protocol_declaration" ||
      node.type === "enum_declaration" ||
      node.type === "actor_declaration" ||
      node.type === "extension_declaration"
    ) {
      const nameNode = node.childForFieldName("name") || node.namedChild(0);
      if (nameNode) exports.push(nameNode.text);
      return false;
    }
  });

  return { imports, exports };
}

function extractPhp(tree: Parser.Tree) {
  const imports: string[] = [];
  const exports: string[] = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "namespace_use_clause") {
      const nameNode = node.namedChild(0);
      if (nameNode) imports.push(nameNode.text);
      return false;
    }
    if (
      node.type === "class_declaration" ||
      node.type === "interface_declaration" ||
      node.type === "trait_declaration" ||
      node.type === "enum_declaration" ||
      node.type === "namespace_definition"
    ) {
      const nameNode = node.childForFieldName("name") || node.namedChild(0);
      if (nameNode) exports.push(nameNode.text);
      if (node.type !== "namespace_definition") {
        return false;
      }
    }
  });

  return { imports, exports };
}

function extractRuby(tree: Parser.Tree) {
  const imports: string[] = [];
  const exports: string[] = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "call" && RUBY_IMPORT_METHODS.has(node.namedChild(0)?.text ?? "")) {
      const argList = node.namedChild(1);
      if (argList) {
        const firstArg = argList.namedChild(0);
        if (firstArg) {
          imports.push(firstArg.text.replace(/['"]/g, ""));
        }
      }
      return false;
    }
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name") || node.namedChild(0);
      if (nameNode) exports.push(nameNode.text);
      return false;
    }
  });

  return { imports, exports };
}

/**
 * Extracts imports and exports from a tree-sitter Tree.
 * Filters by Rust visibility ('pub') and Python module-level names.
 *
 * @param ext File extension
 * @param tree Parsed syntax tree
 * @returns Imports and exports lists
 */
export function extractASTData(
  ext: string,
  tree: Parser.Tree,
): { imports: string[]; exports: string[] } {
  let result: { imports: string[]; exports: string[] };

  if (JS_EXTENSIONS.has(ext)) {
    result = extractJs(tree);
  } else if (PYTHON_EXTENSIONS.has(ext)) {
    result = extractPython(tree);
  } else if (ext === ".go") {
    result = extractGo(tree);
  } else if (ext === ".rs") {
    result = extractRust(tree);
  } else if (JVM_EXTENSIONS.has(ext)) {
    result = extractJvm(tree);
  } else if (CPP_EXTENSIONS.has(ext)) {
    result = extractCpp(tree);
  } else if (ext === ".cs") {
    result = extractCsharp(tree);
  } else if (ext === ".swift") {
    result = extractSwift(tree);
  } else if (PHP_EXTENSIONS.has(ext)) {
    result = extractPhp(tree);
  } else if (RUBY_EXTENSIONS.has(ext)) {
    result = extractRuby(tree);
  } else {
    result = { imports: [], exports: [] };
  }

  return {
    imports: Array.from(new Set(result.imports)),
    exports: Array.from(new Set(result.exports)),
  };
}

export const astExtensions = new Set([
  ...JS_EXTENSIONS,
  ...PYTHON_EXTENSIONS,
  ".go",
  ".rs",
  ...JVM_EXTENSIONS,
  ...CPP_EXTENSIONS,
  ".cs",
  ".swift",
  ...PHP_EXTENSIONS,
  ...RUBY_EXTENSIONS,
]);
