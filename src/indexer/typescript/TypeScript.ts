import path from "path";
import ts from "typescript";

export type FoundExport = {
  exportName: string;
  importKind: "named" | "default" | "namespace" | "exportEquals";
  moduleFile: string;
  isTypeOnly: boolean;
  declarationFile: string;
  reexportedFrom?: string;
};

export type AccessStep =
  | { kind: "static"; member: string } // e.g., ".Completions"
  | { kind: "instance"; member: string } // e.g., ".completions"
  | { kind: "call"; member: string }; // e.g., ".create()"

export type AccessPath = {
  /** Which exported surface we started from */
  root: FoundExport;
  /** Whether the chain requires constructing an instance of the root class */
  requiresNew?: boolean;
  /** Member chain from the root to the target method */
  steps: AccessStep[];
  /** Pretty string like `new OpenAI().completions.completions.create()` */
  pretty: string;
};

export type Symbol = {
  name: string;
  kind: string;
  file: string;
  start: string;
  end: string;
  isExported: boolean;
  documentation?: string;
  jsDocTags?: { name: string; text?: string }[];
  declText: string; // the declaration text
  bodyText?: string; // function/method body, when present
  children?: Symbol[]; // child nodes in the symbol hierarchy
  parent?: Symbol;
  paths?: AccessPath[];
};

export class TypeScript {
  program: ts.Program;
  private checker: ts.TypeChecker;
  private projectDir: string;
  private options: ts.CompilerOptions;

  constructor(projectDir: string, tsconfigName = "tsconfig.json") {
    this.projectDir = path.resolve(projectDir);

    const configPath = ts.findConfigFile(
      this.projectDir,
      ts.sys.fileExists,
      tsconfigName
    );
    if (!configPath)
      throw new Error(`No ${tsconfigName} under ${this.projectDir}`);

    const host: ts.ParseConfigFileHost = {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      },
    };

    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
    if (!parsed) throw new Error(`Failed to parse ${configPath}`);

    const rootNames = parsed.fileNames.filter((f) =>
      path.resolve(f).startsWith(this.projectDir)
    );
    this.options = parsed.options;

    this.program = ts.createProgram(rootNames, parsed.options);
    this.checker = this.program.getTypeChecker();
  }

  findClassMethodDecl(
    absFilePath: string,
    className: string,
    methodName: string
  ) {
    return findClassMethodDecl(
      this.program,
      absFilePath,
      className,
      methodName
    );
  }

  findFunctionDecl(absFilePath: string, fnName: string) {
    return findFunctionDecl(this.program, absFilePath, fnName);
  }

  findVariableDecl(absFilePath: string, varName: string) {
    return findVariableDecl(this.program, absFilePath, varName);
  }

  findInterfaceDecl(
    absFilePath: string,
    ifaceName: string
  ): ts.InterfaceDeclaration | undefined {
    return findInterfaceDecl(this.program, absFilePath, ifaceName);
  }

  /** Find exports with the exact exported name `name`. */
  find(name: string): FoundExport[] {
    return this.collectExports((_exp, expName) => expName === name);
  }

  /** List *all* exports of the package. */
  list(): FoundExport[] {
    return this.collectExports(() => true);
  }

  /**
   * Given a declaration or symbol (e.g., the `create` method on `Completions`),
   * return all access paths from exported surfaces to that symbol.
   */
  callPathsTo(targetSym: ts.Symbol, targetDecl: ts.Declaration): AccessPath[] {
    // const targetSym = this.toSymbol(target);
    // if (!targetSym) return [];
    // const targetDecl = targetSym.getDeclarations()?.[0];
    // if (!targetDecl) return [];

    // If they passed a method declaration, we’ll look for a callable member named the same
    // const targetName = targetSym.getName();

    // Roots: every exported *value* symbol
    const roots = this.list().filter((e) => !e.isTypeOnly);

    const paths: AccessPath[] = [];
    for (const root of roots) {
      // Load the exported symbol at the module boundary
      const expSym = this.getExportedSymbol(root);
      if (!expSym) continue;

      // Two starting “types” for classes: static side and instance side
      // For variables/functions, we just have their value type.
      const startNodes: {
        type: ts.Type;
        steps: AccessStep[];
        requiresNew?: boolean;
      }[] = [];

      if (this.isClassLike(expSym)) {
        const instanceType = this.checker.getDeclaredTypeOfSymbol(expSym);
        const staticType = this.checker.getTypeOfSymbolAtLocation(
          expSym,
          expSym.valueDeclaration ?? expSym.declarations?.[0] ?? targetDecl
        );

        startNodes.push({ type: staticType, steps: [], requiresNew: false });
        startNodes.push({ type: instanceType, steps: [], requiresNew: true });
      } else {
        const valType = this.checker.getTypeOfSymbolAtLocation(
          expSym,
          expSym.valueDeclaration ?? expSym.declarations?.[0] ?? targetDecl
        );
        if (valType)
          startNodes.push({ type: valType, steps: [], requiresNew: false });
      }

      // BFS through members until we hit the exact method symbol
      const seen = new Set<string>();
      const queue = [...startNodes];

      while (queue.length) {
        const node = queue.shift()!;
        const key = this.typeKey(node.type, node.requiresNew);
        if (seen.has(key)) continue;
        seen.add(key);

        // 1) Methods: if this type has a callable member whose declaration == target
        const props = this.checker.getPropertiesOfType(node.type);
        for (const p of props) {
          const pName = p.getName();

          // Method match? (compare declarations)
          for (const d of p.getDeclarations() ?? []) {
            if (
              ts.isMethodDeclaration(d) ||
              ts.isMethodSignature(d) ||
              ts.isFunctionLike(d)
            ) {
              // Fully resolve alias and compare declaration identity
              const resolved = this.resolveAlias(p);
              const rd = resolved.getDeclarations()?.[0];
              if (rd && rd === targetDecl) {
                const steps = [
                  ...node.steps,
                  { kind: "call", member: pName } as AccessStep,
                ];
                paths.push(this.toAccessPath(root, steps, node.requiresNew));
              }
            }
          }

          // 2) Properties: enqueue their type for deeper traversal
          const pType = this.checker.getTypeOfSymbolAtLocation(
            p,
            p.valueDeclaration ?? p.declarations?.[0] ?? targetDecl
          );
          if (pType) {
            const isStatic = this.isStaticMember(p);
            const step: AccessStep = {
              kind: isStatic ? "static" : "instance",
              member: pName,
            };
            queue.push({
              type: pType,
              steps: [...node.steps, step],
              requiresNew: node.requiresNew,
            });
          }
        }

        // 3) If this is a constructor function type, also traverse its “prototype” (instance) members
        const constructSigs = node.type.getConstructSignatures?.() ?? [];
        if (constructSigs.length) {
          const instance = constructSigs[0].getReturnType();
          if (instance) {
            // No explicit step here; “requiresNew” already flags the need for construction
            queue.push({
              type: instance,
              steps: node.steps,
              requiresNew: true,
            });
          }
        }
      }
    }

    // Dedupe structurally
    return dedupe(
      paths,
      (p) => `${p.root.moduleFile}::${p.root.exportName}::${p.pretty}`
    );
  }

  listAllSymbols() {
    // Create a symbol map to track parent-child relationships
    const symbolMap = new Map<ts.Node, Symbol>();
    const rootSymbols: Symbol[] = [];

    const addRow = (
      nameNode: ts.Node,
      decl: ts.Declaration,
      parent?: ts.Node
    ) => {
      const sf = decl.getSourceFile();
      const sym =
        this.checker.getSymbolAtLocation(nameNode) ??
        ((decl as any).symbol as ts.Symbol | undefined);
      if (!sym) return;

      // Skip private symbols (private class members and local variables)
      if (isPrivateOrLocalSymbol(decl)) return;

      const { line, character } = ts.getLineAndCharacterOfPosition(
        sf,
        decl.getStart(sf, /*includeJsDoc*/ true)
      );
      const { line: lineEnd, character: characterEnd } =
        ts.getLineAndCharacterOfPosition(sf, decl.getEnd());
      const doc = sym.getDocumentationComment(this.checker);
      const documentation = ts.displayPartsToString(doc).trim() || undefined;
      const jsDocTags =
        sym.getJsDocTags?.().map((t) => ({
          name: t.name,
          text: t.text?.map((p) => p.text).join(""),
        })) || undefined;
      const isExported = hasExportModifier(decl);

      const declText = getDeclarationHeader(decl, sf);

      const symbol: Symbol = {
        name: sym.getName(),
        kind: ts.SyntaxKind[decl.kind],
        file: path.relative(this.projectDir, sf.fileName),
        start: `${line + 1}:${character + 1}`,
        end: `${lineEnd + 1}:${characterEnd + 1}`,
        isExported,
        documentation,
        jsDocTags,
        declText,
        // bodyText,
        children: [],
        // paths: this.callPathsTo(sym, decl),
      };

      symbolMap.set(decl, symbol);

      // Add to parent's children if parent exists
      if (parent && symbolMap.has(parent)) {
        const parentSymbol = symbolMap.get(parent)!;
        if (!parentSymbol.children) {
          parentSymbol.children = [];
        }
        symbol.parent = parentSymbol;
        parentSymbol.children.push(symbol);
      } else {
        // This is a top-level symbol
        rootSymbols.push(symbol);
      }
    };

    // put this near your other helpers if you want
    const addObjectLiteralMembers = (
      obj: ts.ObjectLiteralExpression,
      parentForMembers: ts.Node // usually the VariableDeclaration
    ) => {
      for (const prop of obj.properties) {
        // isNProfile: (...) => ...
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
          addRow(prop.name, prop, parentForMembers);
          // also walk into the initializer (arrow/function) with the property as parent
          if (prop.initializer) {
            // visit will still run later, but do it explicitly if you want tighter parenting
            // visit(prop.initializer, prop);  <-- call your visit here if available in scope
          }
        }

        // isNProfile(...) { ... }  (object-literal method)
        else if (ts.isMethodDeclaration(prop) && ts.isIdentifier(prop.name)) {
          addRow(prop.name, prop, parentForMembers);
        }

        // get isNProfile() { ... } / set isNProfile(v) { ... }
        else if (
          ts.isGetAccessorDeclaration(prop) &&
          ts.isIdentifier(prop.name)
        ) {
          addRow(prop.name, prop, parentForMembers);
        } else if (
          ts.isSetAccessorDeclaration(prop) &&
          ts.isIdentifier(prop.name)
        ) {
          addRow(prop.name, prop, parentForMembers);
        }

        // shorthand `{ foo }`
        else if (ts.isShorthandPropertyAssignment(prop)) {
          addRow(prop.name, prop, parentForMembers);
        }
        // spread `{ ...other }` has no name; usually skip
      }
    };

    // Walk every source file and collect declarations with names
    for (const sf of this.program.getSourceFiles()) {
      // Skip lib*.d.ts etc. — remove this filter if you want everything
      if (sf.isDeclarationFile && !sf.fileName.endsWith(".d.ts")) continue;

      // Skip files outside the tsconfig directory
      const relativePath = path.relative(this.projectDir, sf.fileName);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath))
        continue;

      const visit = (node: ts.Node, parent?: ts.Node) => {
        if (ts.isFunctionDeclaration(node) && node.name) {
          addRow(node.name, node, parent);
        } else if (ts.isClassDeclaration(node) && node.name) {
          addRow(node.name, node, parent);
          node.members.forEach((member) => {
            if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name))
              addRow(member.name, member, node);
            else if (
              ts.isPropertyDeclaration(member) &&
              ts.isIdentifier(member.name)
            )
              addRow(member.name, member, node);
            else if (
              ts.isGetAccessorDeclaration(member) &&
              ts.isIdentifier(member.name)
            )
              addRow(member.name, member, node);
            else if (
              ts.isSetAccessorDeclaration(member) &&
              ts.isIdentifier(member.name)
            )
              addRow(member.name, member, node);
          });
        } else if (ts.isInterfaceDeclaration(node)) {
          addRow(node.name, node, parent);
          node.members.forEach((member) => {
            if (ts.isMethodSignature(member) && ts.isIdentifier(member.name))
              addRow(member.name, member, node);
            else if (
              ts.isPropertySignature(member) &&
              ts.isIdentifier(member.name)
            )
              addRow(member.name, member, node);
          });
        } else if (ts.isTypeAliasDeclaration(node)) {
          addRow(node.name, node, parent);
        } else if (ts.isEnumDeclaration(node)) {
          addRow(node.name, node, parent);
          node.members.forEach((member) => {
            if (ts.isIdentifier(member.name)) addRow(member.name, member, node);
          });
        } else if (ts.isModuleDeclaration(node)) {
          addRow(node.name, node, parent);
          if (node.body && ts.isModuleBlock(node.body)) {
            node.body.statements.forEach((stmt) => visit(stmt, node));
          }
        } else if (ts.isVariableStatement(node)) {
          for (const d of node.declarationList.declarations) {
            collectBindingNames(d.name, (bn) => addRow(bn, d, parent));

            // 👇 NEW: if initializer is an object literal, collect its members.
            if (d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
              addObjectLiteralMembers(d.initializer, d);
            }
          }
        }

        // Continue traversing for other nodes (we already manually handled class/interface/enum/module bodies)
        if (
          !(
            ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isEnumDeclaration(node) ||
            (ts.isModuleDeclaration(node) &&
              node.body &&
              ts.isModuleBlock(node.body))
          )
        ) {
          ts.forEachChild(node, (child) => visit(child, node));
        }
      };

      // Start with no parent for top-level declarations
      visit(sf);
    }

    return rootSymbols;
  }

  // --- internals used by find/list/pathsTo ---
  // helper: check if the export is specifically `export * as ns from "./x"`
  private isNamespaceReexport(exp: ts.Symbol): boolean {
    const decls = exp.getDeclarations() ?? [];
    return decls.some((d) => ts.isNamespaceExport(d));
  }

  private collectExports(
    filter: (exp: ts.Symbol, name: string) => boolean
  ): FoundExport[] {
    const results: FoundExport[] = [];

    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const full = path.resolve(sf.fileName);
      if (!full.startsWith(this.projectDir)) continue;

      const moduleSymbol = this.checker.getSymbolAtLocation(sf);
      if (!moduleSymbol) continue;

      // Standard and re-exports
      for (const exp of this.checker.getExportsOfModule(moduleSymbol)) {
        const expName = exp.getName();
        if (!filter(exp, expName)) continue;

        const isTypeOnly = (exp.flags & ts.SymbolFlags.Type) !== 0;
        const kind =
          expName === "default"
            ? "default"
            : this.isNamespaceReexport(exp)
            ? "namespace"
            : "named";

        const resolved = this.resolveAlias(exp);
        const declFile =
          resolved.getDeclarations()?.[0]?.getSourceFile().fileName ??
          sf.fileName;

        results.push({
          exportName: expName,
          importKind: kind,
          moduleFile: full,
          isTypeOnly,
          declarationFile: path.resolve(declFile),
          reexportedFrom: this.getReexportSpecifier(exp),
        });
      }

      // CommonJS `export =`
      for (const stmt of sf.statements) {
        if (ts.isExportAssignment(stmt) && stmt.isExportEquals) {
          const sym = this.checker.getSymbolAtLocation(stmt.expression);
          if (!sym) continue;
          if (!filter(sym, "export=")) continue;

          const resolved = this.resolveAlias(sym);
          const declFile =
            resolved.getDeclarations()?.[0]?.getSourceFile().fileName ??
            sf.fileName;

          results.push({
            exportName: "export=",
            importKind: "exportEquals",
            moduleFile: full,
            isTypeOnly: false,
            declarationFile: path.resolve(declFile),
          });
        }
      }
    }

    return dedupe(results, (r) => `${r.moduleFile}::${r.exportName}`);
  }

  private getExportedSymbol(root: FoundExport): ts.Symbol | undefined {
    const sf = this.program.getSourceFile(root.moduleFile);
    if (!sf) return;
    const moduleSym = this.checker.getSymbolAtLocation(sf);
    if (!moduleSym) return;

    // "default" handled via exports.get("default")
    const expTable = this.checker.getExportsOfModule(moduleSym);
    const match = expTable.find((s) => s.getName() === root.exportName);
    return match ? this.resolveAlias(match) : undefined;
  }

  private toSymbol(x: ts.Declaration | ts.Symbol): ts.Symbol | undefined {
    if ((x as ts.Symbol).getDeclarations) return x as ts.Symbol;
    const decl = x as ts.Declaration;
    const nameNode = (decl as any).name as ts.Node | undefined;
    if (nameNode) {
      const s = this.checker.getSymbolAtLocation(nameNode);
      if (s) return s;
    }
    return (decl as any).symbol as ts.Symbol | undefined;
  }

  private isClassLike(sym: ts.Symbol): boolean {
    const d = sym.valueDeclaration ?? sym.declarations?.[0];
    return !!d && (ts.isClassDeclaration(d) || ts.isClassExpression(d));
  }

  private isStaticMember(sym: ts.Symbol): boolean {
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

  private resolveAlias(s: ts.Symbol): ts.Symbol {
    return s.flags & ts.SymbolFlags.Alias
      ? this.checker.getAliasedSymbol(s)
      : s;
  }

  private typeKey(t: ts.Type, requiresNew?: boolean): string {
    // Make a stable-ish key based on symbol + flags + requiresNew
    const s = t.getSymbol();
    const id = s
      ? s.getName() +
        "@" +
        (s.declarations?.[0]?.getSourceFile().fileName ?? "?")
      : `#anon(${t.flags})`;
    return `${requiresNew ? "new:" : "val:"}${id}`;
  }

  private getReexportSpecifier(exp: ts.Symbol): string | undefined {
    for (const d of exp.getDeclarations() ?? []) {
      if (
        ts.isExportSpecifier(d) &&
        d.parent.parent.moduleSpecifier &&
        ts.isStringLiteral(d.parent.parent.moduleSpecifier)
      ) {
        return d.parent.parent.moduleSpecifier.text;
      }
      if (
        ts.isNamespaceExport(d) &&
        ts.isExportDeclaration(d.parent) &&
        d.parent.moduleSpecifier &&
        ts.isStringLiteral(d.parent.moduleSpecifier)
      ) {
        return d.parent.moduleSpecifier.text;
      }
    }
    return undefined;
  }

  private toAccessPath(
    root: FoundExport,
    steps: AccessStep[],
    requiresNew?: boolean
  ): AccessPath {
    const chain = steps
      .map((step) => {
        if (step.kind === "call") return `.${step.member}()`;
        return `.${step.member}`;
      })
      .join("");

    const rootName =
      root.exportName === "default" ? "<default>" : root.exportName;
    const pretty = `${requiresNew ? `new ${rootName}()` : rootName}${chain}`;
    return { root, steps, requiresNew, pretty };
  }

  getProgram(): ts.Program {
    return this.program;
  }
  getOptions(): ts.CompilerOptions {
    return this.options;
  }
}

function getDeclarationHeader(decl: ts.Declaration, sf: ts.SourceFile): string {
  const src = sf.text;
  const start = decl.getStart(sf);

  // 1) class / interface / enum: slice before body "{"
  if (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl) || ts.isEnumDeclaration(decl)) {
    const bodyStart = decl.members.pos; // right after "{"
    return src.slice(start, bodyStart).trim();
  }

  // 2) type alias: stop before type-literal/mapped-type "{"
  if (ts.isTypeAliasDeclaration(decl)) {
    const t = decl.type;
    if (t && (ts.isTypeLiteralNode(t) || ts.isMappedTypeNode(t))) {
      const bracePos = t.getStart(sf); // at "{"
      return src.slice(start, bracePos).trim();          // "type X ="
    }
    // generic fallback: just header "type X ="
    const eqIdx = src.indexOf("=", start);
    if (eqIdx > -1 && eqIdx < decl.end) return src.slice(start, eqIdx + 1).trim();
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
    decl.body && ts.isBlock(decl.body)
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
  if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
    const objStart = decl.initializer.getStart(sf); // at "{"
    return src.slice(start, objStart).trim();       // "export const NostrTypeGuard ="
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
        return src.slice(propStart, bodyStart).trim();  // "isNProfile: function(...): T"
      }
      // no block body (unlikely), fall through
    }
  }

  // 7) Fallback: declarations without bodies (overloads, ambient) are fine as-is
  return decl.getText(sf);
}

/**
 * Determines if a symbol is private (private class member) or local (local variable)
 * @param decl The declaration to check
 * @returns true if the symbol is private or local and should be skipped
 */
function isPrivateOrLocalSymbol(decl: ts.Declaration): boolean {
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

function hasExportModifier(decl: ts.Declaration): boolean {
  const mods = ts.getCombinedModifierFlags(decl as ts.Declaration);
  return (
    (mods & ts.ModifierFlags.Export) !== 0 ||
    (mods & ts.ModifierFlags.Default) !== 0
  );
}

function collectBindingNames(
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
function dedupe<T>(arr: T[], key: (t: T) => string): T[] {
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

export function findClassDecl(
  program: ts.Program,
  absFilePath: string,
  className: string
): ts.ClassDeclaration | undefined {
  const sf = program.getSourceFile(path.resolve(absFilePath));
  if (!sf) return;
  let out: ts.ClassDeclaration | undefined;

  sf.forEachChild(function walk(node) {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      out = node;
    }
    ts.forEachChild(node, walk);
  });
  return out;
}

export function findClassMethodDecl(
  program: ts.Program,
  absFilePath: string,
  className: string,
  methodName: string
): ts.MethodDeclaration | ts.MethodSignature | undefined {
  const cls = findClassDecl(program, absFilePath, className);
  if (!cls) return;
  return cls.members.find(
    (m) =>
      (ts.isMethodDeclaration(m) || ts.isMethodSignature(m)) &&
      ts.isIdentifier(m.name) &&
      m.name.text === methodName
  ) as ts.MethodDeclaration | ts.MethodSignature | undefined;
}

export function findFunctionDecl(
  program: ts.Program,
  absFilePath: string,
  fnName: string
): ts.FunctionDeclaration | undefined {
  const sf = program.getSourceFile(path.resolve(absFilePath));
  if (!sf) return;
  let out: ts.FunctionDeclaration | undefined;

  sf.forEachChild(function walk(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) {
      out = node;
    }
    ts.forEachChild(node, walk);
  });
  return out;
}

export function findVariableDecl(
  program: ts.Program,
  absFilePath: string,
  varName: string
): ts.VariableDeclaration | undefined {
  const sf = program.getSourceFile(path.resolve(absFilePath));
  if (!sf) return;
  let out: ts.VariableDeclaration | undefined;

  sf.forEachChild(function walk(node) {
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

export function findInterfaceDecl(
  program: ts.Program,
  absFilePath: string,
  ifaceName: string
): ts.InterfaceDeclaration | undefined {
  const sf = program.getSourceFile(path.resolve(absFilePath));
  if (!sf) return;
  let out: ts.InterfaceDeclaration | undefined;

  sf.forEachChild(function walk(node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === ifaceName) {
      out = node;
    }
    ts.forEachChild(node, walk);
  });
  return out;
}
