/**
 * @file ast.ts
 * @description Traverses tree-sitter AST and extracts language-specific imports and exports.
 */

import Parser from "web-tree-sitter";

/**
 * Traverses a syntax node in pre-order without using call stack recursion.
 *
 * @param rootNode Tree-sitter root node to walk
 * @param callback Function called on each visited node
 */
export function traverse(rootNode: Parser.SyntaxNode, callback: (node: Parser.SyntaxNode) => void) {
  const cursor = rootNode.walk();
  while (true) {
    callback(cursor.currentNode);
    if (cursor.gotoFirstChild()) {
      continue;
    }
    if (cursor.gotoNextSibling()) {
      continue;
    }
    let backtracking = true;
    while (backtracking) {
      if (!cursor.gotoParent()) {
        cursor.delete();
        return;
      }
      if (cursor.gotoNextSibling()) {
        backtracking = false;
      }
    }
  }
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
  const imports: string[] = [];
  const exports: string[] = [];

  // AST-based extraction for JavaScript/TypeScript family
  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) {
    traverse(tree.rootNode, (node) => {
      // Import statements
      if (node.type === "import_statement") {
        const sourceNode = node.childForFieldName("source");
        if (sourceNode) {
          const rawText = sourceNode.text;
          imports.push(rawText.replace(/['"]/g, ""));
        }
      }
      // CommonJS require
      else if (node.type === "call_expression") {
        const fn = node.childForFieldName("function");
        if (fn && fn.text === "require") {
          const args = node.childForFieldName("arguments");
          if (args && args.childCount >= 3) {
            const firstArg = args.child(1);
            if (firstArg && (firstArg.type === "string" || firstArg.type === "string_literal")) {
              imports.push(firstArg.text.replace(/['"]/g, ""));
            }
          }
        }
      }
      // Export statements
      else if (node.type === "export_statement") {
        const sourceNode = node.childForFieldName("source");
        if (sourceNode) {
          const rawText = sourceNode.text;
          // Re-exports (e.g. export { x } from "./y") are registered as imports because
          // they import symbols from the source module before exporting them.
          imports.push(rawText.replace(/['"]/g, ""));
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
            const nameNode = declarationNode.childForFieldName("name") || declarationNode.child(1);
            if (nameNode) exports.push(nameNode.text);
          }
        }
      } else if (node.type === "export_specifier") {
        const nameNode =
          node.childForFieldName("alias") || node.childForFieldName("name") || node.child(0);
        if (nameNode) exports.push(nameNode.text);
      }
      // CommonJS assignments (module.exports = ... or exports.foo = ...)
      else if (node.type === "assignment_expression") {
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
    });
  }
  // Python imports and exports extraction from AST
  else if ([".py", ".pyi", ".pyw"].includes(ext)) {
    traverse(tree.rootNode, (node) => {
      if (node.type === "import_statement") {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type === "dotted_name") {
            imports.push(child.text);
          }
        }
      } else if (node.type === "import_from_statement") {
        const moduleNode = node.childForFieldName("module") || node.child(1);
        if (moduleNode) {
          imports.push(moduleNode.text);
        }
      } else if (node.type === "class_definition" || node.type === "function_definition") {
        // Enforce Python export visibility: must be module-level and not private (no leading underscore)
        if (node.parent?.type === "module") {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const name = nameNode.text;
            if (!name.startsWith("_")) {
              exports.push(name);
            }
          }
        }
      }
    });
  }
  // Go imports extraction from AST
  else if (ext === ".go") {
    traverse(tree.rootNode, (node) => {
      if (node.type === "import_spec") {
        const pathNode = node.childForFieldName("path");
        if (pathNode) {
          imports.push(pathNode.text.replace(/['"]/g, ""));
        }
      } else if (
        node.type === "function_declaration" ||
        node.type === "type_spec" ||
        node.type === "value_spec"
      ) {
        const nameNode = node.childForFieldName("name");
        if (nameNode && /^[A-Z]/.test(nameNode.text)) {
          exports.push(nameNode.text);
        }
      }
    });
  }
  // Rust imports and exports extraction from AST
  else if (ext === ".rs") {
    traverse(tree.rootNode, (node) => {
      if (node.type === "use_declaration") {
        const pathNode = node.child(1);
        if (pathNode) {
          imports.push(pathNode.text);
        }
      } else if (
        node.type === "function_item" ||
        node.type === "struct_item" ||
        node.type === "enum_item" ||
        node.type === "type_item" ||
        node.type === "trait_item" ||
        node.type === "mod_item"
      ) {
        // Enforce Rust visibility: must have a visibility_modifier child (i.e. starts with 'pub')
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
      }
    });
  }
  // JVM family (Java, Kotlin) AST extraction
  else if ([".java", ".kt", ".kts"].includes(ext)) {
    traverse(tree.rootNode, (node) => {
      if (node.type === "import_declaration") {
        const nameNode = node.childForFieldName("name") || node.child(1);
        if (nameNode) imports.push(nameNode.text);
      } else if (
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
      }
    });
  }
  // C / C++ AST extraction
  else if (
    [".c", ".cpp", ".cc", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++", ".inl", ".ipp"].includes(ext)
  ) {
    traverse(tree.rootNode, (node) => {
      if (node.type === "preproc_include") {
        const pathNode = node.childForFieldName("path") || node.child(1);
        if (pathNode) {
          imports.push(pathNode.text.replace(/['"<>]/g, ""));
        }
      } else if (
        node.type === "class_specifier" ||
        node.type === "struct_specifier" ||
        node.type === "namespace_definition"
      ) {
        const nameNode = node.childForFieldName("name");
        if (nameNode) exports.push(nameNode.text);
      }
    });
  }
  // C# AST extraction
  else if (ext === ".cs") {
    traverse(tree.rootNode, (node) => {
      if (node.type === "using_directive") {
        const nameNode = node.child(1);
        if (nameNode) {
          imports.push(nameNode.text.replace(/;/g, "").trim());
        }
      } else if (
        node.type === "class_declaration" ||
        node.type === "interface_declaration" ||
        node.type === "struct_declaration" ||
        node.type === "enum_declaration" ||
        node.type === "record_declaration" ||
        node.type === "namespace_declaration"
      ) {
        const nameNode = node.childForFieldName("name") || node.child(1);
        if (nameNode) exports.push(nameNode.text);
      }
    });
  }
  // Swift AST extraction
  else if (ext === ".swift") {
    traverse(tree.rootNode, (node) => {
      if (node.type === "import_declaration") {
        const pathNode = node.child(1);
        if (pathNode) imports.push(pathNode.text);
      } else if (
        node.type === "class_declaration" ||
        node.type === "struct_declaration" ||
        node.type === "protocol_declaration" ||
        node.type === "enum_declaration" ||
        node.type === "actor_declaration" ||
        node.type === "extension_declaration"
      ) {
        const nameNode = node.childForFieldName("name") || node.child(1);
        if (nameNode) exports.push(nameNode.text);
      }
    });
  }
  // PHP AST extraction
  else if ([".php", ".php5"].includes(ext)) {
    traverse(tree.rootNode, (node) => {
      if (node.type === "namespace_use_clause") {
        const nameNode = node.child(0);
        if (nameNode) imports.push(nameNode.text);
      } else if (
        node.type === "class_declaration" ||
        node.type === "interface_declaration" ||
        node.type === "trait_declaration" ||
        node.type === "enum_declaration" ||
        node.type === "namespace_definition"
      ) {
        const nameNode = node.childForFieldName("name") || node.child(1);
        if (nameNode) exports.push(nameNode.text);
      }
    });
  }
  // Ruby AST extraction
  else if ([".rb", ".gemspec", ".rake"].includes(ext)) {
    traverse(tree.rootNode, (node) => {
      if (
        node.type === "call" &&
        ["require", "require_relative", "load", "import"].includes(node.child(0)?.text ?? "")
      ) {
        const argList = node.child(1);
        if (argList) {
          const firstArg = argList.child(0);
          if (firstArg) {
            imports.push(firstArg.text.replace(/['"]/g, ""));
          }
        }
      } else if (node.type === "class" || node.type === "module") {
        const nameNode = node.childForFieldName("name") || node.child(1);
        if (nameNode) exports.push(nameNode.text);
      }
    });
  }

  return {
    imports: Array.from(new Set(imports)),
    exports: Array.from(new Set(exports)),
  };
}
