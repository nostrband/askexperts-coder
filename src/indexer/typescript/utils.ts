import path from "path";
import ts from "typescript";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { AccessPath, FoundExport, StableSymbolId } from "./TypeScript.js";

/**
 * Extract a stable declaration "header" string for ID hashing and documentation.
 * Strategy by kind:
 * - class/interface/enum: slice text up to the opening brace.
 * - type alias: slice "type X =" before type literal/mapped type, generic fallback to "type X =".
 * - function-like with Block body: slice up to the opening brace.
 * - arrow function: slice up to the "=>".
 * - variable with object literal initializer: slice up to "{"
 * - object-literal property with arrow/function initializer: slice up to "=>" or "{"
 * - method signatures: return signature text as-is (no body).
 * Fallback: return decl.getText(sf) for ambient/overload/no-body cases.
 */
export function getDeclarationHeader(
  decl: ts.Declaration,
  sf: ts.SourceFile
): string {
  const src = sf.text;
  const start = decl.getStart(sf);

  // 1) class / interface / enum: slice before body "{"
  if (
    ts.isClassDeclaration(decl) ||
    ts.isInterfaceDeclaration(decl) ||
    ts.isEnumDeclaration(decl)
  ) {
    const bodyStart = decl.members.pos; // right after "{"
    return src.slice(start, bodyStart).trim();
  }

  // 2) type alias: stop before type-literal/mapped-type "{"
  if (ts.isTypeAliasDeclaration(decl)) {
    const t = decl.type;
    if (t && (ts.isTypeLiteralNode(t) || ts.isMappedTypeNode(t))) {
      const bracePos = t.getStart(sf); // at "{"
      return src.slice(start, bracePos).trim(); // "type X ="
    }
    // generic fallback: just header "type X ="
    const eqIdx = src.indexOf("=", start);
    if (eqIdx > -1 && eqIdx < decl.end)
      return src.slice(start, eqIdx + 1).trim();
    return `type ${decl.name.getText(sf)}`.trim();
  }

  // 3) function-like with a Block body: slice before the body block
  if (
    (ts.isFunctionDeclaration(decl) ||
      ts.isMethodDeclaration(decl) ||
      ts.isGetAccessorDeclaration(decl) ||
      ts.isSetAccessorDeclaration(decl) ||
      ts.isConstructorDeclaration(decl) ||
      ts.isFunctionExpression(decl)) &&
    decl.body &&
    ts.isBlock(decl.body)
  ) {
    const bodyStart = decl.body.pos; // just after "{"
    return src.slice(start, bodyStart).trim(); // "export function parse(...): { ... }"
  }

  // 4) Arrow function: slice up to the "=>"
  if (ts.isArrowFunction(decl)) {
    const arrowPos = decl.equalsGreaterThanToken.getStart(sf);
    return src.slice(start, arrowPos).trim();
  }

  // 5) Variable with object-literal initializer: slice before "{"
  if (
    ts.isVariableDeclaration(decl) &&
    decl.initializer &&
    ts.isObjectLiteralExpression(decl.initializer)
  ) {
    const objStart = decl.initializer.getStart(sf); // at "{"
    return src.slice(start, objStart).trim(); // "export const NostrTypeGuard ="
  }

  // 6) Object-literal property with arrow/function initializer: trim initializer body
  if (ts.isPropertyAssignment(decl)) {
    const init = decl.initializer;
    const propStart = decl.getStart(sf, true);
    if (init && ts.isArrowFunction(init)) {
      const arrowPos = init.equalsGreaterThanToken.getStart(sf);
      return src.slice(propStart, arrowPos).trim(); // "isNProfile: (v?: ...): v is NProfile"
    }
    if (init && ts.isFunctionExpression(init)) {
      if (init.body && ts.isBlock(init.body)) {
        const bodyStart = init.body.pos;
        return src.slice(propStart, bodyStart).trim(); // "isNProfile: function(...): T"
      }
      // no block body (unlikely), fall through
    }
  }

  // Method signature in the interface
  if (ts.isMethodSignature(decl)) {
    // collapse huge inline return type literals to "{ … }"
    const base = src.slice(start, decl.end).trim();
    // if you want to collapse a type-literal return: detect `: {` and replace till matching '}'
    return base; // signatures have no body anyway
  }

  // 7) Fallback: declarations without bodies (overloads, ambient) are fine as-is
  return decl.getText(sf);
}
/** True if `node` is declared at file/public-surface scope (not a local). */
function isFileScopeDeclaration(
  node: ts.Node,
  opts?: { allowNamespaces?: boolean }
): boolean {
  let cur: ts.Node | undefined = node.parent;

  while (cur) {
    // Reached a file container → file scope
    if (ts.isSourceFile(cur)) return true;

    // Namespace/module blocks: treat as file scope if allowed
    if (ts.isModuleBlock(cur)) return !!opts?.allowNamespaces;

    // Public-surface containers → their members are not locals
    if (ts.isClassDeclaration(cur) || ts.isClassExpression(cur)) return true;
    if (ts.isInterfaceDeclaration(cur)) return true;
    if (ts.isTypeLiteralNode(cur)) return true; // <--- NEW
    if (ts.isEnumDeclaration(cur)) return true;

    // Function-like → locals
    if (isFunctionLikeNode(cur)) return false;
    if (ts.isBlock(cur) && cur.parent && isFunctionLikeNode(cur.parent))
      return false;

    // Top-level statement container (non-decl) → locals
    if (isTopLevelNonDeclStmt(cur)) return false;

    cur = cur.parent;
  }
  return false;
}

export function shouldSkipAsLocal(node: ts.Node): boolean {
  // Never skip type members (interface / type-literal)
  if (ts.isTypeElement(node)) return false;
  return !isFileScopeDeclaration(node, { allowNamespaces: true });
}

/**
 * Determines if a symbol is private (private class member) or local (local variable)
 * @param decl The declaration to check
 * @returns true if the symbol is private or local and should be skipped
 */
export function isPrivateOrLocalSymbol(decl: ts.Declaration): boolean {
  // Check for private modifier on class members
  if (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Private) {
    return true;
  }

  // Check for private identifier (# prefix) on class property
  if (
    (ts.isPropertyDeclaration(decl) ||
      ts.isMethodDeclaration(decl) ||
      ts.isGetAccessorDeclaration(decl) ||
      ts.isSetAccessorDeclaration(decl)) &&
    ts.isPrivateIdentifier(decl.name)
  ) {
    return true;
  }

  // Check for local variables (variables inside functions)
  if (ts.isVariableDeclaration(decl)) {
    // Walk up the tree to see if this variable is inside a function
    let parent: ts.Node | undefined = decl.parent;
    while (parent) {
      if (
        ts.isFunctionDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isArrowFunction(parent)
      ) {
        // It's a local variable inside a function
        return true;
      }
      parent = parent.parent;
    }
  }

  return false;
}

export function hasExportModifier(decl: ts.Declaration): boolean {
  const mods = ts.getCombinedModifierFlags(decl);
  return (
    (mods & ts.ModifierFlags.Export) !== 0 ||
    (mods & ts.ModifierFlags.Default) !== 0
  );
}

export function collectBindingNames(
  name: ts.BindingName,
  onId: (id: ts.Identifier) => void
) {
  if (ts.isIdentifier(name)) {
    onId(name);
  } else if (ts.isArrayBindingPattern(name)) {
    for (const e of name.elements) {
      if (ts.isOmittedExpression(e)) continue;
      if (e.name) collectBindingNames(e.name, onId);
    }
  } else if (ts.isObjectBindingPattern(name)) {
    for (const p of name.elements) {
      collectBindingNames(p.name, onId);
    }
  }
}

// Simple array dedupe by key
export function dedupe<T>(arr: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of arr) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

/**
 * Find a ClassDeclaration by file and class name.
 * Notes:
 * - Scans only the specified source file.
 * - Matches named class declarations (exported or not).
 * - Does not consider class expressions assigned to variables (use findClassMethodDecl for that).
 */
export function findClassDecl(
  program: ts.Program,
  absFilePath: string,
  className: string
): ts.ClassDeclaration | undefined {
  const sf = program.getSourceFile(path.resolve(absFilePath));
  if (!sf) return;
  let out: ts.ClassDeclaration | undefined;
  const visited = new Set<ts.Node>();

  sf.forEachChild(function walk(node) {
    if (visited.has(node)) return;
    visited.add(node);
    
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      out = node;
    }
    ts.forEachChild(node, walk);
  });
  return out;
}

/**
 * Find a MethodDeclaration within a class (declaration or expression) in a given file.
 * Handles:
 * - Named class declarations.
 * - Class expressions assigned to a variable (e.g., `export const JS = class { ... }`),
 *   matching the outer variable name as the "class name".
 * - If className is empty, will match any default class declaration in the file.
 * Limitations:
 * - If a method is implemented as a property with an arrow function, this returns undefined.
 */
export function findClassMethodDecl(
  program: ts.Program,
  absFilePath: string,
  className: string, // pass "JS"; if you really have an anonymous default class, pass "" to match any
  methodName: string // e.g. "generateSecretKey"
): ts.MethodDeclaration | undefined {
  const sf = program.getSourceFile(path.resolve(absFilePath));
  if (!sf) return;

  let found: ts.MethodDeclaration | undefined;
  const visited = new Set<ts.Node>();

  const visit = (node: ts.Node) => {
    if (visited.has(node)) return;
    visited.add(node);
    // Case 1: class declaration (named or default)
    if (ts.isClassDeclaration(node)) {
      const matchesName = className ? node.name?.text === className : true;
      if (matchesName) {
        const m = findMethodInClass(node, methodName);
        if (m) {
          found = m;
          return;
        }
      }
    }

    // Case 2: const JS = class (...) { ... }  OR  export const JS = class { ... }
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (className && d.name.text !== className) continue;
        if (d.initializer && ts.isClassExpression(d.initializer)) {
          const m = findMethodInClass(d.initializer, methodName);
          if (m) {
            found = m;
            return;
          }
        }
      }
    }

    // Case 3: export default class { ... } with no name, but caller provided the name:
    // We can’t match by name; if className is empty, accept any default class in file.
    // (Handled by Case 1 when className === "")

    if (!found) ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

function findMethodInClass(
  cls: ts.ClassDeclaration | ts.ClassExpression,
  methodName: string
): ts.MethodDeclaration | undefined {
  for (const member of cls.members) {
    // methods like: generateSecretKey() { ... }  or async generateSecretKey() { ... }
    if (
      ts.isMethodDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === methodName
    ) {
      return member;
    }
    // If someone wrote it as a property with an arrow function:
    // generateSecretKey = () => { ... }
    if (
      ts.isPropertyDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === methodName
    ) {
      if (member.initializer && ts.isArrowFunction(member.initializer)) {
        // You can return the property declaration or wrap it to a synthetic “method” if you prefer
        return undefined; // or cast if your later code handles PropertyDeclaration
      }
    }
  }
  return undefined;
}

/**
 * Find a top-level FunctionDeclaration by name within a specific file.
 * Notes:
 * - Only matches declared functions (not variables initialized with arrow/functions).
 * - Ignores functions nested inside other scopes.
 */
export function findFunctionDecl(
  program: ts.Program,
  absFilePath: string,
  fnName: string
): ts.FunctionDeclaration | undefined {
  const sf = program.getSourceFile(path.resolve(absFilePath));
  if (!sf) return;
  let out: ts.FunctionDeclaration | undefined;
  const visited = new Set<ts.Node>();

  sf.forEachChild(function walk(node) {
    if (visited.has(node)) return;
    visited.add(node);
    
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) {
      out = node;
    }
    ts.forEachChild(node, walk);
  });
  return out;
}

/**
 * Find a top-level VariableDeclaration by identifier name within a file.
 * Notes:
 * - Scans variable statements and returns the first matching declaration.
 * - Does not drill into destructuring patterns; matches only identifier names.
 */
export function findVariableDecl(
  program: ts.Program,
  absFilePath: string,
  varName: string
): ts.VariableDeclaration | undefined {
  const sf = program.getSourceFile(path.resolve(absFilePath));
  if (!sf) return;
  let out: ts.VariableDeclaration | undefined;
  const visited = new Set<ts.Node>();

  sf.forEachChild(function walk(node) {
    if (visited.has(node)) return;
    visited.add(node);
    
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === varName) {
          out = decl;
        }
      }
    }
    ts.forEachChild(node, walk);
  });
  return out;
}

/**
 * Find an InterfaceDeclaration by name within a specific file.
 * Notes:
 * - Scans only the specified source file.
 * - Returns the first matching interface declaration.
 */
export function findInterfaceDecl(
  program: ts.Program,
  absFilePath: string,
  ifaceName: string
): ts.InterfaceDeclaration | undefined {
  const sf = program.getSourceFile(path.resolve(absFilePath));
  if (!sf) return;
  let out: ts.InterfaceDeclaration | undefined;
  const visited = new Set<ts.Node>();

  sf.forEachChild(function walk(node) {
    if (visited.has(node)) return;
    visited.add(node);
    
    if (ts.isInterfaceDeclaration(node) && node.name.text === ifaceName) {
      out = node;
    }
    ts.forEachChild(node, walk);
  });
  return out;
}

/** Utility: is this a file likely to be an entrypoint, by heuristics */
export function looksLikeEntrypoint(rel: string): boolean {
  // favor index.ts at repo root or src/index.ts, and top-level files in general
  return (
    rel === "index.ts" ||
    rel === "src/index.ts" ||
    /^index\.(ts|tsx|mts|cts)$/.test(rel.split("/").pop() || "")
  );
}

// --- helpers you already have / similar ---
function projectRel(projectDir: string, file: string) {
  return path.relative(projectDir, path.resolve(file)).replace(/\\/g, "/");
}

function normalizeHeaderText(txt: string): string {
  // Strip comments and collapse whitespace to stabilize
  const noComments = txt
    // /* ... */ (not perfect but fine for headers)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // // ...
    .replace(/(^|\s)\/\/.*$/gm, "");
  return noComments.replace(/\s+/g, " ").trim();
}

function hashHeader(txt: string): string {
  return bytesToHex(sha256(normalizeHeaderText(txt))).slice(0, 16);
}

// Walk up containers (class/interface/module)
function containerChainOf(
  decl: ts.Declaration,
  checker: ts.TypeChecker
): Array<{ kind: ts.SyntaxKind; name: string }> {
  const out: Array<{ kind: ts.SyntaxKind; name: string }> = [];
  let cur: ts.Node | undefined = decl.parent;
  while (cur && !ts.isSourceFile(cur)) {
    if (ts.isClassDeclaration(cur) && cur.name)
      out.push({ kind: cur.kind, name: cur.name.text });
    else if (ts.isInterfaceDeclaration(cur))
      out.push({ kind: cur.kind, name: cur.name.text });
    else if (ts.isModuleDeclaration(cur))
      out.push({ kind: cur.kind, name: cur.name.getText() });
    else if (ts.isEnumDeclaration(cur))
      out.push({ kind: cur.kind, name: cur.name.text });
    cur = cur.parent;
  }
  return out.reverse();
}

function declName(decl: ts.Declaration, checker: ts.TypeChecker): string {
  const nameNode = (decl as any).name as ts.Node | undefined;

  // Constructor has no name node
  if (ts.isConstructorDeclaration(decl)) {
    return "constructor";
  }

  // Call signatures have no name node - use special identifier
  if (ts.isCallSignatureDeclaration(decl)) {
    return "__call";
  }

  // Construct signatures have no name node - use special identifier
  if (ts.isConstructSignatureDeclaration(decl)) {
    return "__new";
  }

  if (nameNode) {
    if (ts.isIdentifier(nameNode)) return nameNode.text;
    if (ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
      return nameNode.text;
    }
    if (ts.isComputedPropertyName(nameNode)) {
      const expr = nameNode.expression;
      return `[${ts.isIdentifier(expr) ? expr.text : expr.getText()}]`;
    }
  }

  // export { a as b } from '...'
  if (ts.isExportSpecifier(decl)) {
    // the exported name (rhs of `as`) is what consumers see
    return (decl.name ?? decl.propertyName)?.getText() ?? "<anonymous>";
  }

  if (ts.isExportAssignment(decl)) return "export=";

  if (ts.isIndexSignatureDeclaration(decl)) {
    const p = decl.parameters?.[0];
    if (p && ts.isIdentifier(p.name)) return `[${p.name.text}]`;
    return "[index]";
  }

  return "<anonymous>";
}

function symbolFromTarget(
  checker: ts.TypeChecker,
  target: ts.Symbol | ts.Declaration
): ts.Symbol | undefined {
  // Already a symbol?
  if ((target as ts.Symbol).getDeclarations) return target as ts.Symbol;

  const decl = target as ts.Declaration;

  // Most declarations (incl. default exports) have a .symbol
  const direct = (decl as any).symbol as ts.Symbol | undefined;
  if (direct) return direct;

  // Try the declaration's "name" node (handles identifiers, string names, computed names, etc.)
  const getNameOfDecl = (ts as any).getNameOfDeclaration as
    | ((d: ts.Declaration) => ts.Node | undefined)
    | undefined;

  const nameNode =
    getNameOfDecl?.(decl) ??
    // Fallback for older TS: try common cases
    (ts.isFunctionDeclaration(decl) && decl.name
      ? decl.name
      : ts.isClassDeclaration(decl) && decl.name
      ? decl.name
      : ts.isInterfaceDeclaration(decl)
      ? decl.name
      : ts.isTypeAliasDeclaration(decl)
      ? decl.name
      : ts.isEnumDeclaration(decl)
      ? decl.name
      : undefined);

  if (nameNode) {
    const byName = checker.getSymbolAtLocation(nameNode);
    if (byName) return byName;
  }

  // Variable declarations may use binding patterns. Handle all cases explicitly.
  if (ts.isVariableDeclaration(decl)) {
    const bn = decl.name;

    // const id = ...
    if (ts.isIdentifier(bn)) {
      const s = checker.getSymbolAtLocation(bn);
      if (s) return s;
    }

    // const { a, b: c, ...rest } = ...
    if (ts.isObjectBindingPattern(bn)) {
      for (const el of bn.elements) {
        // el.name can be Identifier | BindingPattern
        if (ts.isIdentifier(el.name)) {
          const s = checker.getSymbolAtLocation(el.name);
          if (s) return s; // return first identifier in the pattern
        } else if (
          ts.isObjectBindingPattern(el.name) ||
          ts.isArrayBindingPattern(el.name)
        ) {
          // nested pattern: dive one level to find an identifier
          for (const nested of el.name.elements) {
            if (ts.isBindingElement(nested) && ts.isIdentifier(nested.name)) {
              const s = checker.getSymbolAtLocation(nested.name);
              if (s) return s;
            }
          }
        }
      }
    }

    // const [a, , c] = ...
    if (ts.isArrayBindingPattern(bn)) {
      for (const el of bn.elements) {
        if (ts.isOmittedExpression(el)) continue;
        if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
          const s = checker.getSymbolAtLocation(el.name);
          if (s) return s;
        }
        if (
          ts.isBindingElement(el) &&
          (ts.isObjectBindingPattern(el.name) ||
            ts.isArrayBindingPattern(el.name))
        ) {
          for (const nested of el.name.elements) {
            if (ts.isBindingElement(nested) && ts.isIdentifier(nested.name)) {
              const s = checker.getSymbolAtLocation(nested.name);
              if (s) return s;
            }
          }
        }
      }
    }
  }

  // Last-resort: sometimes the checker can resolve the decl node itself
  try {
    const s = checker.getSymbolAtLocation(decl as unknown as ts.Node);
    if (s) return s;
  } catch {}

  return undefined;
}

export function buildStableId(
  program: ts.Program,
  projectDir: string,
  target: ts.Symbol | ts.Declaration,
  listExports?: () => Array<{
    moduleFile: string;
    exportName: string;
    symbol: ts.Symbol;
  }>
): StableSymbolId | undefined {
  const checker = program.getTypeChecker();
  
  // If target is already a declaration, use it directly; otherwise get symbol and its first declaration
  let decl: ts.Declaration;
  let sym: ts.Symbol;
  
  if ((target as ts.Symbol).getDeclarations) {
    // Target is a symbol
    sym = target as ts.Symbol;
    const firstDecl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!firstDecl) return;
    decl = firstDecl;
  } else {
    // Target is a declaration - use it directly
    decl = target as ts.Declaration;
    const resolvedSym = symbolFromTarget(checker, target);
    if (!resolvedSym) return;
    sym = resolvedSym;
  }
  const sf = decl.getSourceFile();

  const header = getDeclarationHeader(decl, sf);
  const headerHash = hashHeader(header);
  

  // overload index among same-name declarations in this container/file
  let overloadIndex = 0;
  
  // Check if this declaration can have overloads
  const canHaveOverloads =
    ts.isFunctionDeclaration(decl) ||
    ts.isMethodDeclaration(decl) ||
    ts.isMethodSignature(decl) ||
    ts.isConstructorDeclaration(decl) ||
    ts.isCallSignatureDeclaration(decl) ||
    ts.isConstructSignatureDeclaration(decl);
    
  if (canHaveOverloads) {
    const targetName = declName(decl, checker);
    const parent = decl.parent;
    
    // Find all sibling declarations with the same name that could be overloads
    let siblings: ts.Declaration[] = [];
    
    if (ts.isSourceFile(parent)) {
      // Top-level function overloads
      siblings = parent.statements
        .filter((stmt): stmt is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(stmt) &&
          stmt.name?.getText(sf) === targetName
        );
    } else if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
      // Class method overloads (including constructors)
      siblings = parent.members
        .filter((member): member is ts.MethodDeclaration | ts.ConstructorDeclaration =>
          (ts.isMethodDeclaration(member) && member.name?.getText(sf) === targetName) ||
          (ts.isConstructorDeclaration(member) && targetName === "constructor")
        );
    } else if (ts.isInterfaceDeclaration(parent)) {
      // Interface method/call signature overloads
      siblings = parent.members
        .filter((member): member is ts.MethodSignature | ts.CallSignatureDeclaration | ts.ConstructSignatureDeclaration =>
          (ts.isMethodSignature(member) && member.name?.getText(sf) === targetName) ||
          (ts.isCallSignatureDeclaration(member) && targetName === "__call") ||
          (ts.isConstructSignatureDeclaration(member) && targetName === "__new")
        );
    } else if (ts.isTypeLiteralNode(parent)) {
      // Type literal method/call signature overloads
      siblings = parent.members
        .filter((member): member is ts.MethodSignature | ts.CallSignatureDeclaration | ts.ConstructSignatureDeclaration =>
          (ts.isMethodSignature(member) && member.name?.getText(sf) === targetName) ||
          (ts.isCallSignatureDeclaration(member) && targetName === "__call") ||
          (ts.isConstructSignatureDeclaration(member) && targetName === "__new")
        );
    }
    
    if (siblings.length > 1) {
      // sort by normalized header to get stable ordering
      const sorted = [...siblings].sort((a, b) =>
        normalizeHeaderText(getDeclarationHeader(a, sf)).localeCompare(
          normalizeHeaderText(getDeclarationHeader(b, sf))
        )
      );
      
      // Find the index by comparing normalized headers instead of object references
      const currentHeader = normalizeHeaderText(getDeclarationHeader(decl, sf));
      
      overloadIndex = sorted.findIndex(sib =>
        normalizeHeaderText(getDeclarationHeader(sib, sf)) === currentHeader
      );
      
      // Fallback to position-based comparison if headers are identical
      if (overloadIndex === -1) {
        overloadIndex = sorted.findIndex(sib => {
          const sibStart = sib.getStart(sf);
          const declStart = decl.getStart(sf);
          return sibStart === declStart;
        });
      }
    }
  }

  // optional export hints
  let exportHints: StableSymbolId["exportHints"] | undefined;
  if (listExports) {
    const hints = [];
    const target = resolveIfAlias(checker, sym);
    for (const e of listExports()) {
      const expResolved = resolveIfAlias(checker, e.symbol);
      if (sameSymbol(checker, expResolved, target)) {
        hints.push({
          moduleFile: projectRel(projectDir, e.moduleFile),
          exportName: e.exportName,
        });
      }
    }
    if (hints.length) exportHints = hints;
  }

  const stableId: StableSymbolId = {
    hash: "",
    file: projectRel(projectDir, sf.fileName),
    kind: ts.SyntaxKind[decl.kind],
    name: declName(decl, checker),
    containerChain: containerChainOf(decl, checker),
    headerHash,
    exportHints,
    overloadIndex,
  };
  stableId.hash = createSymbolIdHash(stableId);
  return stableId;
}

export function resolveIfAlias(checker: ts.TypeChecker, s: ts.Symbol): ts.Symbol {
  return s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
}

function sameSymbol(
  checker: ts.TypeChecker,
  a?: ts.Symbol,
  b?: ts.Symbol
): boolean {
  if (!a || !b) return false;
  // Compare by first declaration identity (robust across aliases)
  const ar = resolveIfAlias(checker, a);
  const br = resolveIfAlias(checker, b);
  const ad = ar.getDeclarations()?.[0];
  const bd = br.getDeclarations()?.[0];
  return !!ad && !!bd && ad === bd;
}

export function resolveStableId(
  program: ts.Program,
  projectDir: string,
  id: StableSymbolId
): { decl: ts.Declaration; symbol: ts.Symbol } | undefined {
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(path.resolve(projectDir, id.file));
  const candidates: ts.Declaration[] = [];

  const considerDecl = (decl: ts.Declaration) => {
    if (ts.SyntaxKind[decl.kind] !== id.kind) return;

    const name = declName(decl, checker);
    if (name !== id.name) return;

    const cc = containerChainOf(decl, checker);
    if (JSON.stringify(cc) !== JSON.stringify(id.containerChain)) return;

    const hdr = getDeclarationHeader(decl, decl.getSourceFile());
    const hash = hashHeader(hdr);
    if (hash !== id.headerHash) return;

    candidates.push(decl);
  };

  if (file) {
    // fast path: search only in that file
    const visited = new Set<ts.Node>();
    const visit = (n: ts.Node) => {
      if (visited.has(n)) return;
      visited.add(n);
      
      // cheap filter by kind & name
      if (
        ts.isClassDeclaration(n) ||
        ts.isInterfaceDeclaration(n) ||
        ts.isEnumDeclaration(n) ||
        ts.isTypeAliasDeclaration(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isMethodSignature(n) ||
        ts.isConstructorDeclaration(n) ||
        ts.isCallSignatureDeclaration(n) ||
        ts.isConstructSignatureDeclaration(n) ||
        ts.isGetAccessorDeclaration(n) ||
        ts.isSetAccessorDeclaration(n) ||
        ts.isPropertyDeclaration(n) ||
        ts.isPropertySignature(n) ||
        ts.isIndexSignatureDeclaration(n) ||
        ts.isPropertyAssignment(n) ||
        ts.isShorthandPropertyAssignment(n) ||
        ts.isEnumMember(n) ||
        ts.isVariableDeclaration(n) ||
        ts.isModuleDeclaration(n)
      )
        considerDecl(n as ts.Declaration);
      ts.forEachChild(n, visit);
    };
    visit(file);
  }

  // fallback: if nothing found (file moved), do a project-wide scan using name/kind/container/hash
  if (!candidates.length) {
    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const visited = new Set<ts.Node>();
      const visit = (n: ts.Node) => {
        if (visited.has(n)) return;
        visited.add(n);
        
        if (
          ts.isClassDeclaration(n) ||
          ts.isInterfaceDeclaration(n) ||
          ts.isEnumDeclaration(n) ||
          ts.isTypeAliasDeclaration(n) ||
          ts.isFunctionDeclaration(n) ||
          ts.isMethodDeclaration(n) ||
          ts.isConstructorDeclaration(n) ||
          ts.isCallSignatureDeclaration(n) ||
          ts.isConstructSignatureDeclaration(n) ||
          ts.isGetAccessorDeclaration(n) ||
          ts.isSetAccessorDeclaration(n) ||
          ts.isPropertyDeclaration(n) ||
          ts.isIndexSignatureDeclaration(n) ||
          ts.isPropertyAssignment(n) ||
          ts.isShorthandPropertyAssignment(n) ||
          ts.isEnumMember(n) ||
          ts.isVariableDeclaration(n) ||
          ts.isModuleDeclaration(n)
        )
          considerDecl(n as ts.Declaration);
        ts.forEachChild(n, visit);
      };
      visit(sf);
      if (candidates.length) break;
    }
  }

  // disambiguate overloads if present
  if (candidates.length > 1 && typeof id.overloadIndex === "number") {
    const sorted = [...candidates].sort((a, b) =>
      normalizeHeaderText(
        getDeclarationHeader(a, a.getSourceFile())
      ).localeCompare(
        normalizeHeaderText(getDeclarationHeader(b, b.getSourceFile()))
      )
    );
    const pick = sorted[id.overloadIndex] ?? sorted[0];
    return {
      decl: pick,
      symbol:
        ((pick as any).symbol as ts.Symbol) ??
        checker.getSymbolAtLocation((pick as any).name),
    };
  }

  const decl = candidates[0];
  if (!decl) return undefined;
  return {
    decl,
    symbol:
      ((decl as any).symbol as ts.Symbol) ??
      checker.getSymbolAtLocation((decl as any).name),
  };
}

/**
 * Create a content hash for StableSymbolId fields that define identity.
 * Includes:
 * - file, kind, name, headerHash, overloadIndex and containerChain entries.
 * Produces a hex sha256 digest string.
 */
export function createSymbolIdHash(id: StableSymbolId) {
  let data = `${id.file}:${id.kind}:${id.name}:${id.headerHash}:${
    id.overloadIndex || 0
  }`;
  for (const c of id.containerChain) data += `:${c.kind}:${c.name}`;
  return bytesToHex(sha256(data));
}

/**
 * Compare two StableSymbolId values for identity equivalence.
 * - If both include a hash, compares by hash.
 * - Otherwise compares kind, name, containerChain, headerHash, overloadIndex, and file.
 */
export function equalStableId(a: StableSymbolId, b: StableSymbolId): boolean {
  if (a.hash && b.hash) return a.hash === b.hash;

  // Compare declaration kind
  if (a.kind !== b.kind) return false;

  // Compare name
  if (a.name !== b.name) return false;

  // Compare container chain length + items
  if (a.containerChain.length !== b.containerChain.length) return false;
  for (let i = 0; i < a.containerChain.length; i++) {
    const ac = a.containerChain[i];
    const bc = b.containerChain[i];
    if (ac.kind !== bc.kind || ac.name !== bc.name) return false;
  }

  // Compare header hash
  if (a.headerHash !== b.headerHash) return false;

  // Compare overload index
  if ((a.overloadIndex ?? 0) !== (b.overloadIndex ?? 0)) return false;

  // File path: treat project-relative path as primary key.
  // If file moved, you may want to ignore this, but by default include it.
  if (a.file !== b.file) return false;

  return true;
}

/** Print a class's public interface (header + public members, no bodies).
 *  Works for ClassDeclaration and ClassExpression (assigned to a variable).
 *  If it's a class expression assigned to `const X = class Foo ...`, we render `export class X ... { ... }`
 *  so docs reflect how the API is actually used.
 */
export function printClassLikePublicInterface(
  classNode: ts.ClassDeclaration | ts.ClassExpression,
  checker: ts.TypeChecker,
  opts: {
    includeStatic?: boolean;
    includeConstructor?: boolean;
    preferOuterVarNameForClassExpression?: boolean; // default: true
  } = {}
): string {
  const sf = classNode.getSourceFile();
  const includeStatic = opts.includeStatic ?? true;
  const includeCtor = opts.includeConstructor ?? true;
  const preferOuter = opts.preferOuterVarNameForClassExpression ?? true;

  // --- Determine header context/name/modifiers ---
  // Default to the class node's own name (may be undefined for anonymous class exprs)
  let renderedName = classNode.name?.text;
  let exportPrefix = "";

  // If it's a class expression assigned to a variable, prefer the variable name (what consumers use)
  if (ts.isClassExpression(classNode) && preferOuter) {
    const vd = findEnclosingVariableDeclaration(classNode);
    if (vd && ts.isIdentifier(vd.name)) {
      renderedName = vd.name.text;
      // Pull `export` from the VariableStatement modifiers
      const vs = findAncestor<ts.VariableStatement>(vd, ts.isVariableStatement);
      if (vs) {
        const isExport = vs.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword
        );
        const isDefault = vs.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.DefaultKeyword
        );
        if (isExport && isDefault) {
          exportPrefix = "export default ";
        } else if (isExport) {
          exportPrefix = "export ";
        }
      }
    }
  }

  // Fallback synthetic name if still anonymous
  if (!renderedName) renderedName = "/*anonymous*/";

  // Build the class header text up to `{`, but replace the name token with `renderedName`
  const rawHeader = sf.text
    .slice(classNode.getStart(sf, true), classNode.members.pos - 1)
    .trim();
  const header = replaceClassNameInHeader(
    rawHeader,
    classNode.name?.getText(sf),
    renderedName
  );

  // --- Collect public members (no bodies/initializers) ---
  const lines: string[] = [];
  for (const m of classNode.members) {
    if (!isPublicMember(m)) continue;

    const isStatic =
      (ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static) !== 0;
    if (!includeStatic && isStatic) continue;

    // Constructor
    if (ts.isConstructorDeclaration(m)) {
      if (!includeCtor) continue;
      lines.push(indent(sliceBeforeBody(m, sf).trim().replace(/\s*$/, ";")));
      continue;
    }

    // Methods / accessors: header only
    if (
      (ts.isMethodDeclaration(m) ||
        ts.isGetAccessorDeclaration(m) ||
        ts.isSetAccessorDeclaration(m)) &&
      isIdentifierName(m.name)
    ) {
      lines.push(indent(sliceBeforeBody(m, sf).trim().replace(/\s*$/, ";")));
      continue;
    }

    // Properties / fields: drop initializer, ensure type (infer if missing)
    if (ts.isPropertyDeclaration(m) && isIdentifierName(m.name)) {
      const base = sliceBeforeInitializer(m, sf).trim();
      let line = base;
      if (!hasTypeAnnotation(base)) {
        const sym = (m as any).symbol as ts.Symbol | undefined;
        const t = sym
          ? checker.getTypeOfSymbolAtLocation(sym, m)
          : checker.getTypeAtLocation(m);
        line = `${base}: ${checker.typeToString(t)}`;
      }
      lines.push(indent(ensureSemicolon(line)));
      continue;
    }

    // Index signature in class (rare)
    if (ts.isIndexSignatureDeclaration(m)) {
      lines.push(indent(m.getText(sf).replace(/\{[\s\S]*\}$/, ";")));
      continue;
    }
  }

  return `${exportPrefix}${header}{\n${lines.join("\n")}\n}`;
}

// ---------- helpers ----------

function isPublicMember(m: ts.ClassElement): boolean {
  const mods = ts.getCombinedModifierFlags(m);
  if (mods & ts.ModifierFlags.Private || mods & ts.ModifierFlags.Protected)
    return false;
  const name = (m as any).name as ts.Node | undefined;
  if (name && ts.isPrivateIdentifier(name)) return false; // #private
  return true;
}

function isIdentifierName(
  n: ts.PropertyName | ts.BindingName | undefined
): n is ts.Identifier {
  return !!n && ts.isIdentifier(n);
}

function sliceBeforeBody(
  node:
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
    | ts.ConstructorDeclaration,
  sf: ts.SourceFile
): string {
  if (!node.body) return node.getText(sf);
  const start = node.getStart(sf, true);
  const bodyStart = node.body.pos; // just after "{"
  return sf.text.slice(start, bodyStart).trim();
}

function sliceBeforeInitializer(
  node: ts.PropertyDeclaration,
  sf: ts.SourceFile
): string {
  const start = node.getStart(sf, true);
  if (node.initializer) {
    const initStart = node.initializer.getStart(sf);
    return sf.text
      .slice(start, initStart)
      .replace(/\=\s*$/, "")
      .trim();
  }
  return node.getText(sf);
}

function ensureSemicolon(s: string): string {
  return /[;}]$/.test(s.trim()) ? s.trim() : s.trim() + ";";
}

function indent(s: string, n = 2): string {
  const pad = " ".repeat(n);
  return s
    .split(/\r?\n/)
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

/** Replace the class name token in a header snippet with a different rendered name.
 *  Handles: "export class Foo extends Base" and "class Foo implements X".
 *  If no original name, inject the new name after "class".
 */
function replaceClassNameInHeader(
  header: string,
  originalName: string | undefined,
  newName: string
): string {
  if (originalName) {
    // Replace only the first standalone occurrence of originalName after the keyword "class"
    return header.replace(
      new RegExp(`\\bclass\\s+${escapeRegExp(originalName)}\\b`),
      `class ${newName}`
    );
  }
  // anonymous class: insert name after "class"
  return header.replace(/\bclass\b/, `class ${newName}`);
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Walk up from a ClassExpression to its enclosing VariableDeclaration, if any. */
function findEnclosingVariableDeclaration(
  node: ts.Node
): ts.VariableDeclaration | undefined {
  // classExpr -> VariableDeclaration.initializer
  if (
    node.parent &&
    ts.isVariableDeclaration(node.parent) &&
    node.parent.initializer === node
  ) {
    return node.parent;
  }
  return undefined;
}

function findAncestor<T extends ts.Node>(
  n: ts.Node,
  pred: (x: ts.Node) => x is T
): T | undefined {
  let cur: ts.Node | undefined = n.parent;
  while (cur) {
    if (pred(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

function hasTypeAnnotation(fragment: string): boolean {
  // crude but works for our sliced property text
  return /:\s*[^=]+$/.test(fragment) || /:\s*[^;]+;?$/.test(fragment);
}

export function makeImportStatement(
  exp: FoundExport,
  opts: {
    program: ts.Program; // the TS Program
    packageRoot: string; // absolute path to the package root (where package.json is)
    packageName?: string; // e.g. "my-lib" -> "my-lib/foo"
  }
): string {
  const { program, packageRoot, packageName } = opts;

  // Prefer re-export source (barrel) if present
  let fromAbs = exp.moduleFile ?? exp.reexportedFrom ?? exp.declarationFile;

  // Normalize helpers
  const norm = (p: string) => p.replace(/\\/g, "/");
  const dropExt = (p: string) => p.replace(/\.[mc]?tsx?$/i, "");
  const dropIndex = (p: string) => p.replace(/(?:^|\/)index$/i, "");

  // Determine the "source root" to cut (rootDir, or <packageRoot>/src, else packageRoot)
  const co = program.getCompilerOptions();
  const tryAbs = (p?: string) => (p ? path.resolve(p) : undefined);

  const rootDirAbs = tryAbs(co.rootDir);
  const pkgRootAbs = path.resolve(packageRoot);
  const srcAbs = path.join(pkgRootAbs, "src");

  let cutBase: string;
  if (rootDirAbs && fromAbs.startsWith(rootDirAbs)) {
    cutBase = rootDirAbs;
  } else if (fromAbs.startsWith(srcAbs)) {
    cutBase = srcAbs;
  } else if (fromAbs.startsWith(pkgRootAbs)) {
    cutBase = pkgRootAbs;
  } else {
    // file is outside package (rare)—fall back to dirname
    cutBase = path.dirname(fromAbs);
  }

  // Build module specifier path (relative to cutBase)
  let rel = norm(path.relative(cutBase, fromAbs));
  rel = dropIndex(dropExt(rel));

  let spec: string;
  if (packageName) {
    // Package import
    spec = rel ? `${packageName}/${rel}` : packageName;
  } else {
    // Relative import
    if (!rel || rel === "" || rel === ".") {
      spec = "./";
    } else {
      spec = rel.startsWith(".") ? rel : `./${rel}`;
    }
  }

  // Emit statement by kind
  switch (exp.importKind) {
    case "default":
      return `import ${exp.exportName} from '${spec}';`;
    case "named":
    // export * as <name> from '...'
    // ⟶ import { <name> } from '...'
    case "namespace":
      if (exp.isTypeOnly) {
        return `import type { ${exp.exportName} } from '${spec}';`;
      }
      return `import { ${exp.exportName} } from '${spec}';`;
    case "exportEquals":
      // CommonJS style
      return `import ${exp.exportName} = require('${spec}');`;
    default:
      throw new Error(`Unknown importKind: ${(exp as any).importKind}`);
  }
}

function pruneNamespaceDuplicates(paths: AccessPath[]): AccessPath[] {
  // If there is no non-namespace path at all, keep everything.
  const hasNonNamespace = paths.some((p) => p.root.importKind !== "namespace");
  if (!hasNonNamespace) return paths;

  // Collect the source modules of non-namespace roots (prefer reexport origin if present)
  const directSources = new Set(
    paths
      .filter((p) => p.root.importKind !== "namespace")
      .map(
        (p) =>
          p.root.reexportedFrom ?? p.root.declarationFile ?? p.root.moduleFile
      )
  );

  // Drop namespace paths that point back to a module already covered by a direct root
  return paths.filter((p) => {
    if (p.root.importKind !== "namespace") return true;
    const nsSource =
      p.root.reexportedFrom ?? p.root.declarationFile ?? p.root.moduleFile;
    return !directSources.has(nsSource);
  });
}

export function isClassLike(sym: ts.Symbol): boolean {
  const d = sym.valueDeclaration ?? sym.declarations?.[0];
  return !!d && (ts.isClassDeclaration(d) || ts.isClassExpression(d));
}

export function isFunctionLike(sym: ts.Symbol): boolean {
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  return !!decl && isFunctionLikeNode(decl);
}

function isFunctionLikeNode(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isTopLevelNonDeclStmt(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isIfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node) ||
    ts.isTryStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isWithStatement(node) ||
    ts.isLabeledStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node)
  );
}

export function isStaticMember(sym: ts.Symbol): boolean {
  for (const d of sym.getDeclarations() ?? []) {
    if (ts.isPropertyDeclaration(d) || ts.isMethodDeclaration(d)) {
      return !!(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Static);
    }
    // JS assignment like `Chat.Completions = Completions` compiles to a
    // property assignment on the constructor function; it shows up as a property symbol
    // on the class's static side, so treat it as static.
  }
  // If no declaration info, fall back to assuming instance
  return false;
}
