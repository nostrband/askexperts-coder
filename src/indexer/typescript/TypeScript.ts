/**
 * TypeScript Export & Symbol Analysis
 *
 * Overview
 * This module builds a developer-centric view of a package’s “public interface”.
 * It:
 * - Collects all exports (named, default, namespace, CommonJS export=), following re-exports.
 * - Lists all symbols declared at file/public scope, including:
 *   - classes, interfaces, type aliases, enums, functions, variables, modules
 *   - class/interface members (methods, fields, accessors, index signatures, constructors)
 *   - members of inline type literals (type Foo = { ... }) and object literals inside exported consts
 * - Computes access paths from exported surfaces to a target symbol (how a consumer would use it),
 *   traversing static/instance members and callable steps (BFS), and marks when construction is required.
 * - Finds related types used across the public API surface:
 *   - function/method parameters and return types (including type predicates)
 *   - class/interface heritage (extends/implements) and members
 *   - type alias targets and generic arguments
 *   - variable declared/inferred types and initializer chains (e.g., i.generateSecretKey, a.b().c.d)
 * - Generates stable symbol IDs that survive formatting and line changes, using:
 *   project-relative path, kind/name, container chain, normalized header hash, and overload index,
 *   plus optional export hints to assist future resolution.
 * - Emits correct import statements for each FoundExport (named, default, namespace, export=),
 *   trimming /index and respecting project root vs src/rootDir heuristics.
 * - Ranks paths (rankPaths) so canonical, human-friendly access paths are preferred:
 *   favors entrypoints/barrels, preferred names (default, OpenAI), class roots for values,
 *   and penalizes deep folders, private-like steps, and internal hops (e.g. _client).
 *
 * Key Implementation Details and Fixes
 * - Exports:
 *   - Namespace re-exports (export * as ns from './x') are detected and emitted as namespace roots.
 *   - isTypeOnly is computed from the resolved symbol’s runtime presence, not from syntax alone.
 * - Paths (pathsTo):
 *   - Direct-hit optimization: if an exported symbol is the target, return the root with no steps.
 *   - Variables that alias functions/properties are recognized via initializerTargetsSymbol:
 *     handles Identifiers and property/element access (obj.prop / obj["prop"]).
 *   - BFS traverses static and instance sides for classes; callable members produce only call steps (.foo(...)).
 *   - Deduplication by root/export and the “pretty” string.
 * - Related types (related):
 *   - Deep type-node traversal (symbolsFromTypeNodeDeep) covers utility types (Omit/Pick/Promise),
 *     unions/intersections, mapped/conditional/indexed types, type queries/import types, etc.
 *   - Value-side walking (symbolsFromValueExprDeep) collects symbols from initializer chains and new expressions.
 *   - Filters exclude primitives/globals/stdlib and anonymous/internal shapes; keeps only in-repo symbols.
 *   - Includes the container type (class/interface) for member declarations.
 * - listAllSymbols:
 *   - Skips locals using shouldSkipAsLocal while allowing type/interface/class members.
 *   - Includes constructors explicitly and members of type-literal aliases.
 *   - Also enumerates object-literal members inside exported consts.
 * - Stable IDs:
 *   - Header-only slicing (getDeclarationHeader) removes bodies to stabilize across formatting changes.
 *   - Overload index is derived from normalized headers among siblings.
 *   - Resolution (resolveStableId) uses kind/name/container/headerHash, with project-wide fallback scan.
 * - Import generation:
 *   - Correctly distinguishes namespace exports from named imports.
 *   - Trims .ts/.tsx/.mts/.cts and trailing /index, respects rootDir/src heuristics.
 *
 * Usage
 * - Construct an analyzer for a package directory with a tsconfig:
 *   const tsx = new TypeScript(projectDir, "tsconfig.json?");
 * - Query exports/symbols:
 *   tsx.list() / tsx.find(name) / tsx.listAllSymbols()
 * - Compute usage paths and rank them:
 *   tsx.pathsTo(symbolOrDecl) / tsx.pathsToRanked(symbolOrDecl, options)
 * - Discover related types:
 *   tsx.related(symbolOrDecl)
 * - Generate stable IDs and resolve them later:
 *   tsx.buildStableId(symbolOrDecl) / tsx.resolveStableId(id)
 * - Generate an import statement for an export:
 *   tsx.makeImportStatement(foundExport, packageName?)
 * - Print a class’s public interface:
 *   tsx.printClassLikePublicInterface(classNode, options)
 *
 * Performance/Debugging
 * - This analyzer walks ASTs and types; it can be heavy on large codebases.
 * - Toggle debug logging via the instance field `debug`.
 *
 * This file is intentionally verbose with helper routines for clarity and resilience across TS versions.
 */
import path from "path";
import ts from "typescript";
import fs from "fs";
import {
  buildStableId,
  collectBindingNames,
  dedupe,
  findClassMethodDecl,
  findFunctionDecl,
  findInterfaceDecl,
  findVariableDecl,
  getDeclarationHeader,
  hasExportModifier,
  isClassLike,
  isPrivateOrLocalSymbol,
  isStaticMember,
  looksLikeEntrypoint,
  makeImportStatement,
  printClassLikePublicInterface,
  resolveIfAlias,
  resolveStableId,
  shouldSkipAsLocal,
} from "./utils.js";
import { denoConfigToTsConfig } from "./deno2tsconfig.js";

export type FoundExport = {
  exportName: string;
  importKind: "named" | "default" | "namespace" | "exportEquals";
  moduleFile: string;
  isTypeOnly: boolean;
  declarationFile: string;
  reexportedFrom?: string;
  symbol: ts.Symbol;
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

export type StableSymbolId = {
  hash: string;
  file: string; // project-relative posix path
  kind: string;
  name: string;
  containerChain: Array<{ kind: ts.SyntaxKind; name: string }>;
  headerHash: string; // sha256 of normalized header
  exportHints?: Array<{ moduleFile: string; exportName: string }>;
  overloadIndex?: number;
};

export type Symbol = {
  id: StableSymbolId;
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

export type RankOptions = {
  /** absolute paths to files you consider primary entrypoints (e.g., index.ts) */
  entrypoints?: string[];
  /** export names to boost (e.g., "default", "OpenAI") */
  preferredRootNames?: string[];
  /** If the target is type-only (e.g., export type ...), prefer barrels/entrypoints more. */
  targetIsType?: boolean;
};

export type RankedPath = AccessPath & { score: number };

type RelatedItem = {
  symbol: ts.Symbol;
  file?: string;
  line?: number;
  column?: number;
};

/**
 * Analyzer entry point for a TypeScript project.
 *
 * Responsibilities:
 * - Parse tsconfig and build a Program/TypeChecker for the given projectDir.
 * - Collect export roots (allRoots/valueRoots) used by path discovery and ranking.
 * - Provide high-level APIs: list/find exports, pathsTo/pathsToRanked, related, listAllSymbols,
 *   stable-id build/resolve, and import generation.
 *
 * Note: this class favors package-internal symbols and ignores node_modules externals.
 */
export class TypeScript {
  private program: ts.Program;
  private packageJson: any;
  private checker: ts.TypeChecker;
  private projectDir: string;
  private options: ts.CompilerOptions;
  private allRoots: FoundExport[];
  private valueRoots: FoundExport[];
  private relatedCallStack?: Set<string>;

  // Class field you can flip at runtime
  private debug = false;

  private dbg(...args: any[]) {
    if (this.debug) console.log("[TSX]", ...args);
  }

  private symInfo(s?: ts.Symbol) {
    if (!s) return "<no symbol>";
    const d = s.getDeclarations()?.[0];
    const file = d?.getSourceFile().fileName ?? "<nofile>";
    const name = s.getName();
    const kind = d ? ts.SyntaxKind[d.kind] : "<nokind>";
    return `${name} @ ${path.basename(file)} [${kind}]`;
  }

  private nodeInfo(n: ts.Node) {
    const sf = n.getSourceFile();
    const { line, character } = ts.getLineAndCharacterOfPosition(
      sf,
      n.getStart(sf, true)
    );
    return `${ts.SyntaxKind[n.kind]} "${n
      .getText()
      .slice(0, 80)}" @ ${path.basename(sf.fileName)}:${line + 1}:${
      character + 1
    }`;
  }

  /**
   * Create an analyzer for a project.
   * - Locates and parses the provided tsconfig.
   * - Creates a Program/TypeChecker limited to files under projectDir.
   * - Pre-computes export roots (allRoots) and valueRoots (!isTypeOnly) for fast path search.
   */
  constructor(projectDir: string, tsconfigName = "tsconfig.json") {
    this.projectDir = path.resolve(projectDir);

    // Try to find existing tsconfig first
    let configPath = ts.findConfigFile(
      this.projectDir,
      ts.sys.fileExists,
      tsconfigName
    );
    
    let parsed: ts.ParsedCommandLine;
    
    if (configPath) {
      // Use existing tsconfig.json
      const host: ts.ParseConfigFileHost = {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
        },
      };

      const parsedConfig = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
      if (!parsedConfig) throw new Error(`Failed to parse ${configPath}`);
      parsed = parsedConfig;
    } else {
      // Check if deno.json exists and generate tsconfig from it
      const denoJsonPath = path.join(this.projectDir, "deno.json");
      if (fs.existsSync(denoJsonPath)) {
        const denoConfigText = fs.readFileSync(denoJsonPath, "utf8");
        const tsconfigText = denoConfigToTsConfig(denoConfigText);
        
        // Parse the generated tsconfig
        const tsconfigJson = ts.parseConfigFileTextToJson("tsconfig.json", tsconfigText);
        if (tsconfigJson.error) {
          throw new Error(`Failed to parse generated tsconfig: ${ts.flattenDiagnosticMessageText(tsconfigJson.error.messageText, "\n")}`);
        }
        
        const host: ts.ParseConfigHost = {
          useCaseSensitiveFileNames: true,
          readDirectory: ts.sys.readDirectory,
          fileExists: ts.sys.fileExists,
          readFile: ts.sys.readFile,
        };
        
        parsed = ts.parseJsonConfigFileContent(
          tsconfigJson.config,
          host,
          this.projectDir
        );
        
        if (parsed.errors.length > 0) {
          const errorMessages = parsed.errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, "\n"));
          throw new Error(`Failed to parse generated tsconfig: ${errorMessages.join(", ")}`);
        }
      } else {
        throw new Error(`No ${tsconfigName} or deno.json found under ${this.projectDir}`);
      }
    }

    // Try to read package.json first, fallback to deno.json
    const packageJsonPath = path.join(this.projectDir, "package.json");
    const denoJsonPath = path.join(this.projectDir, "deno.json");
    
    if (fs.existsSync(packageJsonPath)) {
      this.packageJson = JSON.parse(
        fs.readFileSync(packageJsonPath).toString()
      );
    } else if (fs.existsSync(denoJsonPath)) {
      this.packageJson = JSON.parse(
        fs.readFileSync(denoJsonPath).toString()
      );
    } else {
      throw new Error(`No package.json or deno.json found in ${this.projectDir}`);
    }

    const rootNames = parsed.fileNames.filter((f) =>
      path.resolve(f).startsWith(this.projectDir)
    );
    this.options = parsed.options;

    this.program = ts.createProgram(rootNames, parsed.options);
    this.checker = this.program.getTypeChecker();

    this.allRoots = this.list();
    this.valueRoots = this.allRoots.filter((e) => !e.isTypeOnly);
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

  /** Find exports whose exported name exactly matches `name` (after alias resolution). */
  find(name: string): FoundExport[] {
    return this.collectExports((_exp, expName) => expName === name);
  }

  /** List all exports in the project, including named/default/namespace and CommonJS export= assignments. */
  list(): FoundExport[] {
    return this.collectExports(() => true);
  }

  /**
   * Compute all consumer-facing access paths to a target declaration/symbol.
   *
   * Implementation details and heuristics:
   * - Determines if the target has a runtime value; if not, only considers type roots (no BFS into members).
   * - Augments the pre-collected roots with a synthetic direct submodule root if the target is exported
   *   from its own source file (e.g. directly exported from that file).
   * - Direct-hit optimization: if an exported symbol resolves to the target symbol (by declaration identity),
   *   returns a path with zero member steps.
   * - Exported variable aliasing: recognizes alias patterns via initializerTargetsSymbol() for:
   *   Identifier, PropertyAccessExpression (obj.prop), ElementAccessExpression (obj["prop"]).
   *   This allows paths like `export const create = client.create` to be discovered as direct paths.
   * - BFS traversal:
   *   - For class exports, traverses both static side (constructor function) and instance side
   *     (by enqueuing the instance type via construct signatures).
   *   - For each property:
   *     - If callable, yields a call step (".foo(...)") only, avoiding a duplicate plain property step.
   *       Direct-hit on callable compares both symbol and declaration identity.
   *     - If non-callable, may produce a direct match step and enqueues its type for deeper traversal.
   *   - Records whether construction is required (requiresNew) when traversing the instance side.
   * - Dedupes resulting paths by moduleFile + exportName + pretty string.
   */
  pathsTo(target: ts.Symbol | ts.Declaration): AccessPath[] {
    const targetSym = this.toSymbol(target);
    if (!targetSym) return [];
    const targetDecl = targetSym.getDeclarations()?.[0];
    if (!targetDecl) return [];

    const targetResolved = this.resolveAlias(targetSym);
    const targetIsValue = this.symbolHasRuntimeValue(targetResolved);

    const roots = [...(targetIsValue ? this.valueRoots : this.allRoots)];

    const paths: AccessPath[] = [];

    // ⬇️ Add a direct submodule root for the target’s own source file
    const sf = targetDecl.getSourceFile();
    const modSym = this.checker.getSymbolAtLocation(sf);
    if (modSym) {
      const name = targetResolved.getName();
      const direct = this.checker
        .getExportsOfModule(modSym)
        .find((s) => s.getName() === name);
      if (direct) {
        const resolved = this.resolveAlias(direct);
        // Only if it has a runtime value
        if (this.symbolHasRuntimeValue(resolved)) {
          roots.push({
            exportName: name,
            importKind: "named",
            moduleFile: path.resolve(sf.fileName),
            isTypeOnly: false,
            declarationFile: path.resolve(targetDecl.getSourceFile().fileName),
            reexportedFrom: undefined,
            symbol: resolved,
          });
        }
      }
    }

    // Use the pre-computed roots array from constructor
    for (const root of roots) {
      const expSym = this.getExportedSymbol(root);
      if (!expSym) continue;
      const expResolved = this.resolveAlias(expSym);

      // --- DIRECT-HIT: exported symbol IS the target (e.g., `export function getDB() {}`)
      if (this.sameSymbol(expResolved, targetResolved)) {
        // No member steps needed; the root itself is the target.
        paths.push(
          this.toAccessPath(root, /*steps*/ [], /*requiresNew*/ false)
        );
        // (Optionally, add a variant that shows invocation, if you want a `()` suffix)
        continue; // no need to BFS this root
      }

      if (!targetIsValue) {
        // For type-only targets, don't BFS into members.
        continue;
      }

      // --- NEW: exported variable whose initializer aliases the target method/property
      {
        const d = expResolved.valueDeclaration ?? expResolved.declarations?.[0];
        if (d && ts.isVariableDeclaration(d) && d.initializer) {
          if (this.initializerTargetsSymbol(d.initializer, targetResolved)) {
            // You can return no steps (the exported name is the access path),
            // or include a note if you want. Rendering can add "()" for callables.
            paths.push(this.toAccessPath(root, [], false));
            continue;
          }
        }
      }

      // Two starting “types” for classes: static side and instance side
      const startNodes: {
        type: ts.Type;
        steps: AccessStep[];
        requiresNew?: boolean;
      }[] = [];

      if (isClassLike(expResolved)) {
        const instanceType = this.checker.getDeclaredTypeOfSymbol(expResolved);
        const staticType = this.checker.getTypeOfSymbolAtLocation(
          expResolved,
          expResolved.valueDeclaration ??
            expResolved.declarations?.[0] ??
            targetDecl
        );
        startNodes.push({ type: staticType, steps: [], requiresNew: false });
        startNodes.push({ type: instanceType, steps: [], requiresNew: true });
      } else {
        const valType = this.checker.getTypeOfSymbolAtLocation(
          expResolved,
          expResolved.valueDeclaration ??
            expResolved.declarations?.[0] ??
            targetDecl
        );
        if (valType)
          startNodes.push({ type: valType, steps: [], requiresNew: false });
      }

      // BFS through members until we hit the exact method/property symbol
      const seen = new Set<string>();
      const queue = [...startNodes];

      while (queue.length) {
        const node = queue.shift()!;
        const key = this.typeKey(node.type, node.requiresNew);
        if (seen.has(key)) continue;
        seen.add(key);

        // 1) Properties: enqueue and check for method/property direct match
        for (const p of this.checker.getPropertiesOfType(node.type)) {
          const pName = p.getName();
          const resolvedP = this.resolveAlias(p);

          // Compute once
          const pDeclForLoc =
            p.valueDeclaration ?? p.declarations?.[0] ?? targetDecl;
          const pType = this.checker.getTypeOfSymbolAtLocation(p, pDeclForLoc);
          const isCallable = !!pType?.getCallSignatures?.().length;

          if (isCallable) {
            // Callable member -> only produce a call-step path (no plain property path)
            const rd = resolvedP.getDeclarations()?.[0];

            // Direct-hit method/function (compare by declaration or symbol)
            if (
              (rd && rd === targetDecl) ||
              this.sameSymbol(resolvedP, targetResolved)
            ) {
              const steps = [
                ...node.steps,
                { kind: "call", member: pName } as AccessStep,
              ];
              paths.push(this.toAccessPath(root, steps, node.requiresNew));
            }

            // Do NOT enqueue callable as a property; skip to next prop
            // (If you want to traverse into its return type, do it explicitly here.)
            continue;
          }

          // --- Non-callable property handling ---

          // Direct-hit on a non-callable property symbol
          if (this.sameSymbol(resolvedP, targetResolved)) {
            const stepKind = isStaticMember(p) ? "static" : "instance";
            const steps = [
              ...node.steps,
              { kind: stepKind as "static" | "instance", member: pName },
            ];
            paths.push(this.toAccessPath(root, steps, node.requiresNew));
            // Note: we still enqueue below to allow deeper matches through this property.
          }

          // Enqueue property type for deeper traversal
          if (pType) {
            const step: AccessStep = {
              kind: isStaticMember(p) ? "static" : "instance",
              member: pName,
            };
            queue.push({
              type: pType,
              steps: [...node.steps, step],
              requiresNew: node.requiresNew,
            });
          }
        }

        // 2) If the current node is a constructor function, traverse its instance
        const constructSigs = node.type.getConstructSignatures?.() ?? [];
        if (constructSigs.length) {
          const instance = constructSigs[0].getReturnType();
          if (instance) {
            queue.push({
              type: instance,
              steps: node.steps,
              requiresNew: true,
            });
          }
        }
      }
    }

    const deduped = dedupe(
      paths,
      (p) => `${p.root.moduleFile}::${p.root.exportName}::${p.pretty}`
    );

    // return pruneNamespaceDuplicates(deduped);
    return deduped;
  }

  /**
   * Determine whether a type/symbol is a primitive/global that should be ignored in public related() results.
   * Heuristics:
   * - Filters TS primitives (any/unknown/never/string/number/boolean/bigint/void/undefined/null/symbol).
   * - Treats stdlib and external declaration files (outside projectDir) as global.
   * - Skips common global containers (Promise, Map, Set, Array, Uint8Array).
   */
  private isGlobalOrPrimitive(t: ts.Type, sym?: ts.Symbol): boolean {
    // primitives & ‘lib’ stuff
    if (
      t.flags &
      (ts.TypeFlags.Any |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.Never |
        ts.TypeFlags.String |
        ts.TypeFlags.Number |
        ts.TypeFlags.Boolean |
        ts.TypeFlags.BigInt |
        ts.TypeFlags.Void |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Null |
        ts.TypeFlags.ESSymbol)
    )
      return true;

    const s = sym ?? t.symbol;
    if (!s) return false;
    const d = s.getDeclarations()?.[0];
    if (!d) return false;
    const sf = d.getSourceFile();
    // stdlib or node types
    if (
      sf.isDeclarationFile &&
      !path.resolve(sf.fileName).startsWith(this.projectDir)
    )
      return true;
    // Common global objects we don’t want to surface
    const name = s.getName();
    return (
      name === "Promise" ||
      name === "Map" ||
      name === "Set" ||
      name === "Array" ||
      name === "Uint8Array"
    );
  }

  /**
   * Extract referenced type symbols from a ts.Type.
   * - Prefers alias symbols when present (aliasSymbol) to keep meaningful names.
   * - Handles unions/intersections by visiting constituent types.
   * - Handles generic references (TypeReference): collects target symbol and visits typeArguments.
   * - Falls back to the type’s own symbol when applicable.
   * Output is unique by first declaration identity.
   */
  private typeTargets(t: ts.Type): ts.Symbol[] {
    const seenDecl = new Set<ts.Declaration>();
    const visitedTypes = new Set<ts.Type>();
    const out: ts.Symbol[] = [];

    const pushSym = (s?: ts.Symbol) => {
      if (!s) return;
      const d = s.getDeclarations()?.[0];
      if (!d) return;
      if (seenDecl.has(d)) return;
      seenDecl.add(d);
      out.push(s);
    };

    const visit = (ty: ts.Type) => {
      // Prevent infinite recursion by tracking visited types
      if (visitedTypes.has(ty)) {
        return;
      }
      visitedTypes.add(ty);
      
      // Prefer alias name when present
      const aliasSym = (ty as any).aliasSymbol as ts.Symbol | undefined;
      if (aliasSym) pushSym(aliasSym);

      // Unions/intersections: visit constituents
      if (ty.isUnionOrIntersection?.()) {
        (ty as ts.UnionOrIntersectionType).types.forEach(visit);
        return;
      }

      // Type references (generics / named types)
      const ref = ty as ts.TypeReference;
      if (ref.target) {
        pushSym(ref.target.symbol);
        (ref.typeArguments ?? []).forEach(visit);
        return;
      }

      // Conditional/instantiation can still have a symbol
      pushSym(ty.symbol);
    };

    visit(t);
    return out;
  }

  /** From a TypeNode, get a Type, then referenced target symbols (safe for declared signatures). */
  private targetsFromTypeNode(node: ts.TypeNode): ts.Symbol[] {
    const t = this.checker.getTypeFromTypeNode(node);
    return this.typeTargets(t);
  }

  /** Collect type symbols from a heritage clause entry: `extends/implements Foo<T, U>` */
  private symbolsFromHeritageEntry(
    ht: ts.ExpressionWithTypeArguments
  ): ts.Symbol[] {
    const syms: ts.Symbol[] = [];
    const seen = new Set<ts.Declaration>();
    const add = (s?: ts.Symbol) => {
      if (!s) return;
      const d = s.getDeclarations()?.[0];
      if (!d || seen.has(d)) return;
      seen.add(d);
      syms.push(s);
    };

    // Foo
    const head = this.checker.getSymbolAtLocation(ht.expression);
    add(head);

    // <T, U>
    for (const a of ht.typeArguments ?? []) {
      for (const s of this.symbolsFromTypeNodeDeep(a)) add(s);
    }
    return syms;
  }

  /**
   * Deeply collect type symbols syntactically referenced inside a TypeNode.
   * Coverage:
   * - TypeReference (including QualifiedName): collects referenced symbol and recurses into typeArguments.
   * - Array/Union/Intersection/Parenthesized types.
   * - Function/Constructor types: parameter and return types.
   * - TypeLiteral: property/method signatures and index signatures.
   * - Mapped types, Indexed access types, Type operators (keyof/readonly/unique).
   * - Conditional types (check/extends/true/false).
   * - Type predicates (x is Y) via TypePredicateNode.
   * - Type queries (typeof Foo) and ImportType ("import('mod').Foo").
   * Results are unique by declaration identity; globals are not filtered here (higher-level filters apply).
   */
  private symbolsFromTypeNodeDeep(node: ts.TypeNode): ts.Symbol[] {
    const out: ts.Symbol[] = [];
    const seenDecl = new Set<ts.Declaration>();
    const visitedNodes = new Set<ts.Node>();

    const addSym = (s?: ts.Symbol) => {
      if (!s) return;
      const d = s.getDeclarations()?.[0];
      if (!d) return;
      if (seenDecl.has(d)) return;
      seenDecl.add(d);
      out.push(s);
    };

    const visit = (n: ts.Node) => {
      // Prevent infinite recursion by tracking visited nodes
      if (visitedNodes.has(n)) {
        return;
      }
      visitedNodes.add(n);
      
      // Recurse into child nodes by kind
      if (ts.isTypeReferenceNode(n)) {
        // Collect the referenced name (e.g., SubscriptionParams, EventTemplate, Promise, Omit)
        const nameNode = n.typeName; // Identifier | QualifiedName
        const sym = this.checker.getSymbolAtLocation(
          ts.isQualifiedName(nameNode) ? nameNode.right : nameNode
        );
        // Keep symbol (will be filtered later by `add()` to drop globals like Promise/Omit)
        if (sym) addSym(sym);

        // Recurse into type arguments (e.g., Omit<SubscriptionParams, 'onclose'>)
        for (const a of n.typeArguments ?? []) visit(a);
        return;
      }

      if (ts.isArrayTypeNode(n)) {
        visit(n.elementType);
        return;
      }
      if (ts.isUnionTypeNode(n) || ts.isIntersectionTypeNode(n)) {
        for (const t of n.types) visit(t);
        return;
      }
      if (ts.isParenthesizedTypeNode(n)) {
        visit(n.type);
        return;
      }

      if (ts.isTypeLiteralNode(n)) {
        for (const m of n.members) {
          if (ts.isPropertySignature(m) && m.type) visit(m.type);
          else if (ts.isMethodSignature(m)) {
            for (const p of m.parameters) if (p.type) visit(p.type);
            if (m.type) visit(m.type);
          } else if (ts.isIndexSignatureDeclaration(m) && m.type) {
            visit(m.type);
          }
        }
        return;
      }

      if (ts.isFunctionTypeNode(n) || ts.isConstructorTypeNode(n)) {
        for (const p of n.parameters) if (p.type) visit(p.type);
        if (n.type) visit(n.type);
        return;
      }

      if (ts.isMappedTypeNode(n)) {
        if (n.typeParameter.constraint) visit(n.typeParameter.constraint);
        if (n.type) visit(n.type);
        return;
      }

      if (ts.isIndexedAccessTypeNode(n)) {
        visit(n.objectType);
        visit(n.indexType);
        return;
      }

      if (ts.isTypeOperatorNode(n)) {
        // keyof, readonly, unique
        visit(n.type);
        return;
      }

      if (ts.isConditionalTypeNode(n)) {
        visit(n.checkType);
        visit(n.extendsType);
        visit(n.trueType);
        visit(n.falseType);
        return;
      }

      if (ts.isTypePredicateNode(n)) {
        if (n.type) visit(n.type); // e.g. `x is VerifiedEvent`
        return;
      }

      if (ts.isTypeQueryNode(n)) {
        // typeof Foo → symbol of "Foo"
        const sym = this.checker.getSymbolAtLocation(n.exprName);
        if (sym) addSym(sym);
        return;
      }

      if (ts.isImportTypeNode(n)) {
        // import("mod").Foo — resolve the qualifier if present
        if (n.qualifier) {
          const sym = this.checker.getSymbolAtLocation(n.qualifier);
          if (sym) addSym(sym);
        }
        // typeArguments may reference local types too
        for (const a of n.typeArguments ?? []) visit(a);
        return;
      }

      // default: drill into children
      ts.forEachChild(n, (child) => {
        if (!visitedNodes.has(child)) {
          visit(child);
        }
      });
      
    };

    visit(node);
    return out;
  }

  /**
   * Determine whether a symbol corresponds to an anonymous/inline type shape.
   * Considered anonymous:
   * - Type literals ({ ... }) and method/property signatures within them
   * - Function/method declarations or expressions used as inline types
   * - Arrow functions used as inline types
   * - JSDoc typedef tags
   * Rationale: these shapes are internal implementation details and should not be surfaced
   * as first-class “related” public API types.
   */
  private isAnonymousTypeSym(sym: ts.Symbol): boolean {
    const d = sym.getDeclarations() ?? [];
    if (!d.length) return true;
    return d.every(
      (x) =>
        ts.isTypeLiteralNode(x) ||
        // instead of isSignatureDeclaration
        ts.isFunctionDeclaration(x) ||
        ts.isMethodDeclaration(x) ||
        ts.isFunctionExpression(x) ||
        ts.isArrowFunction(x) ||
        ts.isMethodSignature(x) ||
        // ts.isSignatureDeclaration(x) ||
        ts.isJSDocTypedefTag(x as any)
    );
  }

  private inThisPackage(sym: ts.Symbol): boolean {
    let s = sym;

    // If it's an alias with no decls, try resolving it
    if (
      (!s.getDeclarations() || s.getDeclarations()!.length === 0) &&
      s.getFlags() & ts.SymbolFlags.Alias
    ) {
      try {
        s = this.checker.getAliasedSymbol(s);
      } catch {
        // ignore
      }
    }

    const d = s.getDeclarations()?.[0];
    if (!d) return false;

    const sf = d.getSourceFile();
    const abs = path.resolve(sf.fileName);

    // Hard exclude external deps even if they live under projectDir
    if (abs.includes(`${path.sep}node_modules${path.sep}`)) return false;

    // Allow files inside the repo (both .ts and your own .d.ts)
    if (!sf.isDeclarationFile) {
      return abs.startsWith(this.projectDir);
    }

    // Declaration files: permit only if inside the repo and not node_modules
    return abs.startsWith(this.projectDir);
  }

  private isPublicClassElement(m: ts.ClassElement): boolean {
    const mods = ts.getCombinedModifierFlags(m);
    if (mods & ts.ModifierFlags.Private || mods & ts.ModifierFlags.Protected)
      return false;
    const name = (m as any).name as ts.Node | undefined;
    if (name && ts.isPrivateIdentifier(name)) return false; // #private
    return true;
  }

  private locOfDecl(d?: ts.Declaration): {
    file?: string;
    line?: number;
    column?: number;
  } {
    if (!d) return {};
    const sf = d.getSourceFile();
    const { line, character } = ts.getLineAndCharacterOfPosition(
      sf,
      d.getStart(sf, true)
    );
    return { file: sf.fileName, line: line + 1, column: character + 1 };
  }

  private resolveAlias(s: ts.Symbol): ts.Symbol {
    return s.flags & ts.SymbolFlags.Alias
      ? this.checker.getAliasedSymbol(s)
      : s;
  }

  private projectRel(p: string): string {
    return path.relative(this.projectDir, path.resolve(p)).replace(/\\/g, "/");
  }

  /**
   * Rank candidate access paths with human-centric heuristics.
   * Scoring:
   * - Bonuses:
   *   - Entrypoints (index.ts, src/index.ts, or provided entrypoints) → strong bonus.
   *   - Preferred root names ("default", "OpenAI" by default) → moderate bonus.
   *   - Default export → bonus.
   *   - Class export roots → slight bonus for values.
   *   - If target is a type, add extra bonus for entrypoints/barrels.
   * - Penalties:
   *   - Long member chains (non-call steps) → length penalty.
   *   - Private-ish steps (leading "_" or "#") → private penalty per step.
   *   - Internal `_client` hops → client penalty.
   *   - Deep folders (beyond package root) → depth penalty (stronger if target is a type).
   *   - Namespace roots for types get a tiny penalty compared to named/entry exports.
   * Sorts by descending score, then by shorter pretty string.
   */
  private rankPaths(paths: AccessPath[], opts?: RankOptions): RankedPath[] {
    const entryset = new Set(
      (opts?.entrypoints ?? []).map((f) => path.resolve(f))
    );
    const preferred = new Set(
      opts?.preferredRootNames ?? ["default", "OpenAI"]
    );

    const scored = paths.map((p) => {
      const rel = this.projectRel(p.root.moduleFile);
      const stepCount = p.steps.filter((s) => s.kind !== "call").length;

      const privateSteps = p.steps.filter(
        (s) => s.member.startsWith("_") || s.member.startsWith("#")
      ).length;

      const hasClientHop = p.steps.some((s) => s.member === "_client");
      const depth = rel.split("/").length - 1; // folders deep

      const isEntrypoint =
        entryset.has(path.resolve(p.root.moduleFile)) ||
        looksLikeEntrypoint(rel);

      // Base bonuses
      const entrypointBaseBonus = isEntrypoint ? 50 : 0;
      const preferredRootBonus = preferred.has(p.root.exportName) ? 20 : 0;
      const defaultExportBonus = p.root.exportName === "default" ? 15 : 0;

      // If the *target* is a type, give an extra boost to entrypoints/barrels
      const typeEntrypointBonus = opts?.targetIsType && isEntrypoint ? 20 : 0;

      // If the *target* is a type, prefer named/entry exports over namespace roots a bit
      const typeNamespacePenalty =
        opts?.targetIsType && p.root.importKind === "namespace" ? 5 : 0;

      // Slightly prefer class roots for values (unchanged)
      const classRootBonus = (() => {
        const sym = this.getExportedSymbol(p.root);
        if (!sym) return 0;
        const d = sym.valueDeclaration ?? sym.declarations?.[0];
        return d && (ts.isClassDeclaration(d) || ts.isClassExpression(d))
          ? 10
          : 0;
      })();

      // penalties
      const depthFactor = opts?.targetIsType ? 4 : 3; // types prefer shallower paths more
      const lengthPenalty = stepCount * 10;
      const privatePenalty = privateSteps * 6;
      const clientPenalty = hasClientHop ? 12 : 0;
      const depthPenalty = Math.max(0, depth - 1) * depthFactor;

      const score =
        100 +
        entrypointBaseBonus +
        typeEntrypointBonus +
        preferredRootBonus +
        defaultExportBonus +
        classRootBonus -
        lengthPenalty -
        privatePenalty -
        clientPenalty -
        depthPenalty -
        typeNamespacePenalty;

      return { ...p, score };
    });

    scored.sort(
      (a, b) => b.score - a.score || a.pretty.length - b.pretty.length
    );
    return scored;
  }

  private toResolvedSymbol(target: ts.Symbol | ts.Declaration) {
    const targetSym = this.toSymbol(target);
    if (!targetSym) return undefined;
    const targetDecl = targetSym.getDeclarations()?.[0];
    if (!targetDecl) return undefined;
    return this.resolveAlias(targetSym);
  }

  /** Ranked variant: keep `pathsTo` as-is, or replace it with this behavior. */
  pathsToRanked(
    target: ts.Symbol | ts.Declaration,
    opts?: RankOptions
  ): RankedPath[] {
    const raw = this.pathsTo(target);
    const targetResolved = this.toResolvedSymbol(target);
    if (targetResolved)
      return this.rankPaths(raw, {
        ...opts,
        targetIsType: !this.symbolHasRuntimeValue(targetResolved),
      });
    else return raw.map((s) => ({ ...s, score: 0 }));
  }

  // --- helpers ---

  // Compare underlying declaration identity
  private sameSymbol(a?: ts.Symbol, b?: ts.Symbol): boolean {
    if (!a || !b) return false;
    const ad = this.resolveAlias(a).getDeclarations()?.[0];
    const bd = this.resolveAlias(b).getDeclarations()?.[0];
    return !!ad && !!bd && ad === bd;
  }

  // Try to determine whether an exported var's initializer resolves to the target symbol.
  // Recognizes common aliasing patterns used in barrels or surface shims.
  // Handles:
  // - Identifier: follows one-hop alias or variable initializer recursively.
  // - PropertyAccess: matches by name on the property identifier.
  // - ElementAccess with string literal: looks up property on the object type.
  private initializerTargetsSymbol(
    init: ts.Expression,
    target: ts.Symbol
  ): boolean {
    // 1) x  (identifier) → follow aliases one hop
    if (ts.isIdentifier(init)) {
      const sym = this.checker.getSymbolAtLocation(init);
      if (!sym) return false;
      const res = this.resolveAlias(sym);
      return (
        this.sameSymbol(res, target) ||
        this.variableDeclInitializerTargets(res, target)
      );
    }

    // 2) obj.prop
    if (ts.isPropertyAccessExpression(init)) {
      const nameSym = this.checker.getSymbolAtLocation(init.name);
      if (nameSym && this.sameSymbol(this.resolveAlias(nameSym), target)) {
        return true;
      }
      return false;
    }

    // 3) obj["prop"]
    if (ts.isElementAccessExpression(init)) {
      const arg = init.argumentExpression;
      if (arg && ts.isStringLiteral(arg)) {
        // Resolve by getting the type of obj and looking up the property
        const objType = this.checker.getTypeAtLocation(init.expression);
        const prop = objType.getProperty(arg.text);
        if (prop && this.sameSymbol(this.resolveAlias(prop), target))
          return true;
      }
      return false;
    }

    // (Optional) recognize `obj.prop.bind(obj)` etc. if you need it later.

    return false;
  }

  // If sym is a variable with an initializer, test that initializer.
  private variableDeclInitializerTargets(
    sym: ts.Symbol,
    target: ts.Symbol
  ): boolean {
    const d = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!d || !ts.isVariableDeclaration(d) || !d.initializer) return false;
    return this.initializerTargetsSymbol(d.initializer, target);
  }

  /**
   * Build a StableSymbolId for a declaration/symbol.
   * Stable across formatting/line changes using:
   * - project-relative file, kind, name, container chain
   * - normalized declaration header hash
   * - overload index among same-named siblings
   * Includes export hints for better future resolution.
   */
  buildStableId(target: ts.Symbol | ts.Declaration) {
    return buildStableId(
      this.program,
      this.projectDir,
      target,
      () => this.allRoots
    );
  }

  /**
   * Enumerate all publicly-surfaced symbols across source files.
   * - Visits file-scope declarations; skips locals via shouldSkipAsLocal and private members.
   * - Includes: classes/interfaces/types/enums/functions/variables/modules.
   * - Includes class members (methods/fields/accessors/index signatures/constructors).
   * - Includes interface/type-literal members and members of object literals in exported consts.
   * - Attaches documentation/tags, declaration header text, stable id, parent/children relations.
   * - Returns the list of root symbols, with children tree under each root.
   */
  listRootSymbols() {
    // Create a symbol map to track parent-child relationships
    const symbolMap = new Map<ts.Node, Symbol>();
    const rootSymbols: Symbol[] = [];
    const listExports = () => this.allRoots;

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
      if (shouldSkipAsLocal(decl)) return;

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

      const id = buildStableId(
        this.program,
        this.projectDir,
        decl,
        listExports
      );
      if (!id) throw new Error("Failed to build stable id");
      const symbol: Symbol = {
        id,
        // name: sym.getName(),
        // kind: ts.SyntaxKind[decl.kind],
        // file: path.relative(this.projectDir, sf.fileName),
        start: `${line + 1}:${character + 1}`,
        end: `${lineEnd + 1}:${characterEnd + 1}`,
        isExported,
        documentation,
        jsDocTags,
        declText,
        // bodyText,
        children: [],
        // paths: this.pathsTo(decl),
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
      if (sf.isDeclarationFile) continue;

      // Skip files outside the tsconfig directory
      const relativePath = path.relative(this.projectDir, sf.fileName);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath))
        continue;

      // Add cycle detection to prevent infinite recursion
      const visitedNodes = new Set<ts.Node>();
      
      const visit = (node: ts.Node, parent?: ts.Node) => {
        // Prevent infinite recursion by tracking visited nodes
        if (visitedNodes.has(node)) {
          return;
        }
        visitedNodes.add(node);
        if (ts.isFunctionDeclaration(node) && node.name) {
          addRow(node.name, node, parent);
        } else if (ts.isClassDeclaration(node) && node.name) {
          addRow(node.name, node, parent);
          node.members.forEach((member) => {
            // constructor (no name node)
            if (ts.isConstructorDeclaration(member)) {
              // pass the member itself as the "name node" so addRow uses decl.symbol
              addRow(member as unknown as ts.Node, member, node);
              return;
            }

            // methods
            if (ts.isMethodDeclaration(member)) {
              // name can be Identifier | StringLiteral | NumericLiteral | ComputedPropertyName
              const nameNode = (member.name ?? member) as ts.Node;
              addRow(nameNode, member, node);
              return;
            }

            // properties (incl. static)
            if (ts.isPropertyDeclaration(member)) {
              const nameNode = (member.name ?? member) as ts.Node;
              addRow(nameNode, member, node);
              return;
            }

            // accessors
            if (
              ts.isGetAccessorDeclaration(member) ||
              ts.isSetAccessorDeclaration(member)
            ) {
              const nameNode = (member.name ?? member) as ts.Node;
              addRow(nameNode, member, node);
              return;
            }

            // index signature (classes can have them)
            if (ts.isIndexSignatureDeclaration(member)) {
              addRow(member as unknown as ts.Node, member as any, node);
              return;
            }

            // (optional) skip constructors; they have no name node
            // if (ts.isConstructorDeclaration(member)) { /* usually skip */ }
          });
        } else if (ts.isInterfaceDeclaration(node)) {
          addRow(node.name, node, parent);
          node.members.forEach((member) => {
            if (ts.isMethodSignature(member)) {
              // Use the name node if present, otherwise the member itself
              addRow(member.name ?? member, member, node);
            } else if (ts.isPropertySignature(member)) {
              // Accept Identifier | StringLiteral | NumericLiteral | ComputedPropertyName
              // Always use member.name for property signatures, fallback to member only if name is undefined
              const nameNode = member.name ? member.name : member;
              addRow(nameNode, member, node);
            } else if (ts.isIndexSignatureDeclaration(member)) {
              // Optional: include index signatures as well
              addRow(member, member as any, node);
            }
          });
        } else if (ts.isTypeAliasDeclaration(node)) {
          addRow(node.name, node, parent);
          // If the alias includes any inline type literal anywhere (including unions/intersections),
          // enumerate its members as child symbols. This covers cases like:
          //   type X = WebSocket & { ping?(): void; on?(event: 'pong', fn: () => void): any }
          const addTypeLiteralMembersDeep = (tn: ts.TypeNode) => {
            const walk = (n: ts.TypeNode) => {
              if (ts.isTypeLiteralNode(n)) {
                for (const m of n.members) {
                  if (ts.isPropertySignature(m)) {
                    // name can be Identifier | StringLiteral | NumericLiteral | ComputedPropertyName
                    const nameNode = (m.name ?? (m as unknown as ts.Node)) as ts.Node;
                    addRow(nameNode, m, node);
                  } else if (ts.isMethodSignature(m)) {
                    const nameNode = (m.name ?? (m as unknown as ts.Node)) as ts.Node;
                    addRow(nameNode, m, node);
                  } else if (ts.isIndexSignatureDeclaration(m)) {
                    // No name node; pass the member itself so addRow falls back to decl.symbol
                    addRow(m as unknown as ts.Node, m as any, node);
                  }
                  // Optionally include call/construct signatures declared in type literals
                  else if (
                    ts.isCallSignatureDeclaration(m) ||
                    ts.isConstructSignatureDeclaration(m)
                  ) {
                    addRow(m as unknown as ts.Node, m as any, node);
                  }
                }
                return;
              }
              // Unwrap parens
              if (ts.isParenthesizedTypeNode(n)) {
                walk(n.type);
                return;
              }
              // Traverse unions and intersections to find embedded type literals
              if (ts.isIntersectionTypeNode(n) || ts.isUnionTypeNode(n)) {
                for (const t of n.types) walk(t);
                return;
              }
              // Other node kinds (TypeReference, MappedType, etc.) don't contain direct members to enumerate.
            };
            walk(tn);
          };
          if (node.type) addTypeLiteralMembersDeep(node.type);
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
          ts.forEachChild(node, (child) => {
            // Only visit if we haven't seen this child before
            if (!visitedNodes.has(child)) {
              visit(child, node);
            }
          });
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

  /**
   * Collect all exports from each source file module.
   * - Includes named/default exports and re-exports (checks getExportsOfModule).
   * - Detects namespace re-exports (export * as ns from "./x") and treats them as namespace roots.
   * - Determines type-only vs value exports via symbolHasRuntimeValue() on the resolved symbol.
   * - Also scans for CommonJS `export =` assignments.
   * - Provides reexportedFrom path when available to inform import statement generation.
   * - Dedupes by moduleFile + exportName + importKind + type/value nature.
   */
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

        const isNs = this.isNamespaceReexport(exp);
        const resolved = this.resolveAlias(exp);
        const isTypeOnly = isNs ? false : !this.symbolHasRuntimeValue(resolved);

        const kind: FoundExport["importKind"] =
          expName === "default" ? "default" : isNs ? "namespace" : "named";

        const declFile =
          resolved.getDeclarations()?.[0]?.getSourceFile().fileName ??
          sf.fileName;

        const reex = this.getReexportSpecifier(exp);
        results.push({
          exportName: expName,
          importKind: kind,
          moduleFile: full,
          isTypeOnly,
          declarationFile: path.resolve(declFile),
          reexportedFrom: reex
            ? path.resolve(this.projectDir, reex)
            : undefined,
          symbol: resolved,
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
            symbol: resolved,
          });
        }
      }
    }

    // const byKey = new Map<string, FoundExport>();
    // for (const r of results) {
    //   const k = `${r.moduleFile}::${r.exportName}`;
    //   const prev = byKey.get(k);
    //   if (!prev) {
    //     byKey.set(k, r);
    //     continue;
    //   }
    //   // prefer the one that is NOT type-only (i.e., has runtime value)
    //   if (prev.isTypeOnly && !r.isTypeOnly) byKey.set(k, r);
    // }
    // return [...byKey.values()];

    // return dedupe(results, (r) => `${r.moduleFile}::${r.exportName}`);
    return dedupe(
      results,
      (r) =>
        `${r.moduleFile}::${r.exportName}::${r.importKind}::${
          r.isTypeOnly ? "type" : "value"
        }`
    );
  }

  /**
   * Return package-local types referenced by the public interface of `target`.
   *
   * What is considered “related”:
   * - For type aliases: all symbols referenced in the aliased type (deep traversal).
   * - For interfaces: members’ parameter/return types, index signatures, and heritage (extends).
   * - For classes: public members only (filters out private/protected and #private),
   *   constructor parameter types, property types (declared or inferred), accessors, and heritage.
   * - For functions/methods: parameters, return type; includes older TS predicate nodes (x is Y).
   * - For variables: both declared/inferred type and value-side initializer chains
   *   (e.g., i.generateSecretKey, a.b().c.d), plus constructor/new-expression targets.
   * - Includes the container type (class/interface) for member declarations.
   *
   * Filters/constraints:
   * - Excludes type parameters (T), primitives/globals/std libs (Promise, Map, Array, node/lib.d.ts),
   *   and “anonymous”/inline type shapes.
   * - inThisPackage() ensures symbols originate from the current project (not node_modules).
   * - Value-side references are lenient (no alias resolution, skip anonymous filtering) but still
   *   require top-level declarations from this package.
   *
   * Returns unique items by declaration identity with source location hints.
   */
  public related(target: ts.Symbol | ts.Declaration): RelatedItem[] {
    // Add recursion tracking for the related method
    if (!this.relatedCallStack) {
      this.relatedCallStack = new Set<string>();
    }
    
    // If target is already a declaration, use it directly; otherwise get symbol and its first declaration
    let decl: ts.Declaration;
    let sym: ts.Symbol;
    
    if ((target as ts.Symbol).getDeclarations) {
      // Target is a symbol
      sym = target as ts.Symbol;
      const firstDecl = sym.valueDeclaration ?? sym.declarations?.[0];
      if (!firstDecl) return [];
      decl = firstDecl;
    } else {
      // Target is a declaration - use it directly
      decl = target as ts.Declaration;
      const resolvedSym = this.toSymbol(target);
      if (!resolvedSym) return [];
      sym = resolvedSym;
    }
    
    // Create a unique key for this declaration to detect cycles
    const sf = decl.getSourceFile();
    const declKey = `${sf.fileName}:${decl.getStart(sf)}:${ts.SyntaxKind[decl.kind]}`;
    
    if (this.relatedCallStack.has(declKey)) {
      this.dbg(`Circular reference detected in related() for: ${declKey}`);
      return []; // Return empty to break the cycle
    }
    
    this.relatedCallStack.add(declKey);

    const addSet = new Map<ts.Declaration, RelatedItem>();
    const add = (s: ts.Symbol) => {
      if (!s) {
        this.dbg("add: skip <null>");
        return;
      }

      // skip type params
      if ((s.getFlags() & ts.SymbolFlags.TypeParameter) !== 0) {
        this.dbg("add: skip type-param", this.symInfo(s));
        return;
      }

      const isTypeAlias = (s.getFlags() & ts.SymbolFlags.TypeAlias) !== 0;
      const rs = isTypeAlias ? s : this.resolveAlias(s);

      if (!this.inThisPackage(rs)) {
        this.dbg("add: skip not-in-package", this.symInfo(rs));
        return;
      }
      if (this.isAnonymousTypeSym(rs)) {
        this.dbg("add: skip anonymous", this.symInfo(rs));
        return;
      }

      if (!isTypeAlias) {
        const t =
          (this.checker as any).getDeclaredTypeOfSymbol?.(rs) ??
          this.checker.getTypeOfSymbolAtLocation(
            rs,
            rs.valueDeclaration ?? rs.declarations?.[0] ?? decl
          );
        if (this.isGlobalOrPrimitive(t, rs)) {
          this.dbg("add: skip global/primitive", this.symInfo(rs));
          return;
        }
      }

      const d = rs.getDeclarations()?.[0];
      if (!d) {
        this.dbg("add: skip no decl", this.symInfo(rs));
        return;
      }
      if (d === decl) {
        this.dbg("add: skip (same decl as target)", this.symInfo(rs));
        return;
      }
      if (addSet.has(d)) {
        this.dbg("add: dup", this.symInfo(rs));
        return;
      }

      this.dbg("add: KEEP", this.symInfo(rs));
      addSet.set(d, { symbol: rs, ...this.locOfDecl(d) });
    };

    const isTopLevel = (d: ts.Declaration) => {
      let p: ts.Node | undefined = d.parent;
      while (p && !ts.isSourceFile(p)) {
        if (ts.isFunctionLike(p)) return false;
        p = p.parent;
      }
      return true;
    };

    // NEW: lenient add for VALUE-side references (property/call/new chains)
    // - no alias resolution
    // - no primitive/global filtering
    // - no "anonymous type" filtering (we only need a real declaration)
    const addValueRef = (s: ts.Symbol | undefined) => {
      if (!s) {
        this.dbg("addValueRef: skip <null>");
        return;
      }

      // skip generic params
      if ((s.getFlags() & ts.SymbolFlags.TypeParameter) !== 0) {
        this.dbg("addValueRef: skip type-param", this.symInfo(s));
        return;
      }

      // we keep the symbol as-is (don’t resolve aliases here)
      const d = s.getDeclarations()?.[0];
      if (!d) {
        this.dbg("addValueRef: skip no decl", this.symInfo(s));
        return;
      }
      if (d === decl) {
        this.dbg("addValueRef: skip (same decl as target)", this.symInfo(s));
        return;
      }

      if (!isTopLevel(d)) {
        this.dbg("addValueRef: skip non-top-level", this.symInfo(s));
        return;
      }

      // must be from this package
      if (!this.inThisPackage(s)) {
        this.dbg("addValueRef: skip not-in-package", this.symInfo(s));
        return;
      }

      if (addSet.has(d)) {
        this.dbg("addValueRef: dup", this.symInfo(s));
        return;
      }
      this.dbg("addValueRef: KEEP", this.symInfo(s));
      addSet.set(d, { symbol: s, ...this.locOfDecl(d) });
    };

    // Add predicate target from a declaration node if it has a type predicate (`x is Y`)
    const addPredicateTypeFromNode = (
      node: ts.Node & { type?: ts.TypeNode }
    ) => {
      const tn = node.type;
      if (tn && ts.isTypePredicateNode(tn) && tn.type) {
        const predT = this.checker.getTypeFromTypeNode(tn.type);
        this.typeTargets(predT).forEach(add);
      }
    };

    // If the node is a member of a class/interface, include its container type
    const addContainerIfAny = () => {
      let p: ts.Node | undefined = decl.parent;
      while (p) {
        if (
          ts.isInterfaceDeclaration(p) ||
          ts.isClassDeclaration(p) ||
          ts.isClassExpression(p)
        ) {
          const nameNode = (p as any).name;
          if (nameNode) {
            const cs = this.checker.getSymbolAtLocation(nameNode);
            if (cs) add(cs);
          }
          break;
        }
        p = p.parent;
      }
    };

    // --- Handle by declaration kind ---

    // 1) TYPE ALIAS
    if (ts.isTypeAliasDeclaration(decl)) {
      const syms = this.symbolsFromTypeNodeDeep(decl.type);
      syms.forEach(add);
      return [...addSet.values()];
    }

    // 2) INTERFACE
    if (ts.isInterfaceDeclaration(decl)) {
      for (const hc of decl.heritageClauses ?? []) {
        for (const t of hc.types) this.symbolsFromHeritageEntry(t).forEach(add);
      }
      for (const m of decl.members) {
        if (ts.isMethodSignature(m) || ts.isConstructSignatureDeclaration(m)) {
          for (const p of m.parameters)
            if (p.type) this.symbolsFromTypeNodeDeep(p.type).forEach(add);
          if (m.type) this.symbolsFromTypeNodeDeep(m.type).forEach(add);
          // handle type predicate on the signature
          addPredicateTypeFromNode(m as any);
        } else if (ts.isPropertySignature(m) && m.type) {
          this.symbolsFromTypeNodeDeep(m.type).forEach(add);
        } else if (ts.isIndexSignatureDeclaration(m) && m.type) {
          this.symbolsFromTypeNodeDeep(m.type).forEach(add);
        }
      }
      return [...addSet.values()];
    }

    // 3) CLASS
    if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) {
      for (const hc of decl.heritageClauses ?? []) {
        for (const t of hc.types) this.symbolsFromHeritageEntry(t).forEach(add);
      }
      for (const m of decl.members) {
        if (!this.isPublicClassElement(m)) continue;

        if (ts.isConstructorDeclaration(m)) {
          for (const p of m.parameters)
            if (p.type) this.symbolsFromTypeNodeDeep(p.type).forEach(add);
          continue;
        }

        if (
          (ts.isMethodDeclaration(m) ||
            ts.isGetAccessorDeclaration(m) ||
            ts.isSetAccessorDeclaration(m)) &&
          m.type
        ) {
          if (ts.isMethodDeclaration(m)) {
            for (const p of m.parameters)
              if (p.type) this.symbolsFromTypeNodeDeep(p.type).forEach(add);
          }
          this.symbolsFromTypeNodeDeep(m.type).forEach(add);
          // method declarations don't carry a TypePredicateNode in `type`, so nothing extra here
          continue;
        }

        if (ts.isPropertyDeclaration(m)) {
          if (m.type) this.symbolsFromTypeNodeDeep(m.type).forEach(add);
          else {
            const ms = (m as any).symbol as ts.Symbol | undefined;
            const mt = ms
              ? this.checker.getTypeOfSymbolAtLocation(ms, m)
              : this.checker.getTypeAtLocation(m);
            this.typeTargets(mt).forEach(add);
          }
          continue;
        }
      }
      return [...addSet.values()];
    }

    // 4) FUNCTION / METHOD / METHOD SIGNATURE
    if (
      ts.isFunctionDeclaration(decl) ||
      ts.isMethodDeclaration(decl) ||
      ts.isFunctionExpression(decl) ||
      ts.isMethodSignature(decl) ||
      ts.isArrowFunction(decl as any) // in case we ever get here with arrows
    ) {
      // include container interface/class if this is a member
      addContainerIfAny();

      const sig = this.checker.getSignatureFromDeclaration(
        decl as ts.SignatureDeclaration
      );
      if (sig) {
        const params = (decl as ts.SignatureDeclaration).parameters ?? [];
        
        // Process parameter types from type annotations (syntactic)
        for (const p of params)
          if (p.type) this.symbolsFromTypeNodeDeep(p.type).forEach(add);

        // Process return type from type annotation (syntactic) if available
        const functionLikeDecl = decl as ts.FunctionLikeDeclaration;
        if (functionLikeDecl.type) {
          // Use the syntactic type annotation to preserve type alias references
          this.symbolsFromTypeNodeDeep(functionLikeDecl.type).forEach(add);
        } else {
          // Fallback to resolved type if no type annotation
          const rt = sig.getReturnType();
          this.typeTargets(rt).forEach(add);
        }

        // type predicate: from node (older TS)
        addPredicateTypeFromNode(decl as any);

        return [...addSet.values()];
      }
      // fallback: infer
      const t = this.checker.getTypeOfSymbolAtLocation(sym, decl);
      t.getCallSignatures().forEach((s) => {
        s.getParameters().forEach((ps) => {
          const pd = ps.valueDeclaration ?? ps.declarations?.[0];
          if (pd && ts.isParameter(pd) && pd.type)
            this.symbolsFromTypeNodeDeep(pd.type).forEach(add);
        });
        this.typeTargets(s.getReturnType()).forEach(add);
      });
      return [...addSet.values()];
    }

    // 5) VARIABLE declarations (includes arrow functions / new expressions)
    if (ts.isVariableDeclaration(decl)) {
      // VALUE-SIDE: collect symbols from initializer chains (b, c, d, e in b.c().d.e())
      if (decl.initializer) {
        this.dbg("VAR init:", this.nodeInfo(decl.initializer));
        for (const s of this.symbolsFromValueExprDeep(decl.initializer)) {
          this.dbg("VAR init -> add:", this.symInfo(s));
          addValueRef(s);
        }
      } else {
        this.dbg("VAR no initializer");
      }

      // TYPE-SIDE (existing logic)
      if (decl.type) {
        this.symbolsFromTypeNodeDeep(decl.type).forEach(add);
      } else {
        const init = decl.initializer;
        if (init && ts.isNewExpression(init)) {
          const ct = this.checker.getTypeAtLocation(init.expression);
          this.typeTargets(ct).forEach(add);
        } else if (
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          const sig = this.checker.getSignatureFromDeclaration(init);
          if (sig) {
            init.parameters.forEach(
              (p) => p.type && this.symbolsFromTypeNodeDeep(p.type).forEach(add)
            );
            this.typeTargets(sig.getReturnType()).forEach(add);
            // No longer needed with symbolsFromValueExprDeep above.
            // arrow/function expressions can also have predicates; check node just in case
            // addPredicateTypeFromNode(init as any);
          }
        } else {
          const vt = this.checker.getTypeOfSymbolAtLocation(sym, decl);
          this.typeTargets(vt).forEach(add);
        }
      }
      addContainerIfAny();
      return [...addSet.values()];
    }

    // 6) Property/Accessor declarations
    if (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) {
      addContainerIfAny();
      const tn = (decl as any).type as ts.TypeNode | undefined;
      if (tn) this.symbolsFromTypeNodeDeep(tn).forEach(add);
      else {
        const t = this.checker.getTypeOfSymbolAtLocation(sym, decl);
        this.typeTargets(t).forEach(add);
      }
      return [...addSet.values()];
    }

    // Default fallback
    {
      const t = this.checker.getTypeOfSymbolAtLocation(sym, decl);
      this.typeTargets(t).forEach(add);
      addContainerIfAny();
      const result = [...addSet.values()];
      this.relatedCallStack.delete(declKey);
      return result;
    }
  }

  /**
   * Resolve the exported symbol object corresponding to a FoundExport entry.
   * Uses the module SourceFile symbol table and returns the alias-resolved symbol.
   */
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

  /**
   * Normalize a declaration or symbol into a symbol.
   * Attempts, in order:
   * - If already a symbol, return it.
   * - Resolve by declaration's name node via checker.getSymbolAtLocation.
   * - Fallback to the declaration's .symbol (works for many decl kinds).
   */
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

  /**
   * Produce a stable-ish key for a type node during BFS over member graphs.
   * - Combines whether construction is required with the type's symbol name and file.
   * - De-dupes exploration of the same logical node across different traversal paths.
   */
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

  /**
   * For an export symbol, return the module specifier it re-exports from, if any.
   * Supports both:
   * - `export { x as y } from './mod'`
   * - `export * as ns from './mod'`
   */
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

  /**
   * Materialize an AccessPath object from a root export and its member steps.
   * - Pretty-printing:
   *   - If there are no steps and the root is callable, appends "(...)".
   *   - Otherwise uses "[...]" to indicate a non-callable root value when leafless.
   * - When requiresNew is true, renders "new <Root>(...)".
   */
  private toAccessPath(
    root: FoundExport,
    steps: AccessStep[],
    requiresNew?: boolean
  ): AccessPath {
    const chain = steps
      .map((s) => (s.kind === "call" ? `.${s.member}(...)` : `.${s.member}`))
      .join("");
    const rootName =
      root.exportName === "default" ? "<default>" : root.exportName;

    // Append () when the root itself is callable and there are no further steps
    let rootSuffix = "";
    if (!steps.length) {
      const sym = this.getExportedSymbol(root);
      if (sym) {
        const t = this.checker.getTypeOfSymbolAtLocation(
          sym,
          sym.valueDeclaration ?? sym.declarations?.[0]!
        );
        if (t?.getCallSignatures?.().length) rootSuffix = "(...)";
        else rootSuffix = "[...]";
      }
    }

    const pretty = `${
      requiresNew ? `new ${rootName}(...)` : rootName
    }${rootSuffix}${chain}`;
    return { root, steps, requiresNew, pretty };
  }

  /**
   * Resolve a previously built StableSymbolId back to a live declaration/symbol in the current Program.
   * Matches by kind/name/container chain/header hash, with a project-wide fallback if the file moved.
   */
  resolveStableId(
    id: StableSymbolId
  ): { decl: ts.Declaration; symbol: ts.Symbol } | undefined {
    return resolveStableId(this.program, this.projectDir, id);
  }

  printClassLikePublicInterface(
    classNode: ts.ClassDeclaration | ts.ClassExpression,
    opts: {
      includeStatic?: boolean;
      includeConstructor?: boolean;
      preferOuterVarNameForClassExpression?: boolean; // default: true
    } = {}
  ): string {
    return printClassLikePublicInterface(classNode, this.checker, opts);
  }

  /**
   * Generate an import statement for a FoundExport.
   * Handles:
   * - default vs named vs namespace vs CommonJS export=
   * - trimming file extensions and /index suffixes
   * - respecting rootDir/src/packageRoot for module specifier construction
   * When packageName is provided, emits package-based specifiers (e.g., "lib/foo").
   */
  makeImportStatement(exp: FoundExport, packageName?: string): string {
    return makeImportStatement(exp, {
      program: this.program,
      packageRoot: this.projectDir,
      packageName,
    });
  }

  private symbolHasRuntimeValue(sym: ts.Symbol): boolean {
    const s = resolveIfAlias(this.checker, sym);
    if (!s) return false;

    // Quick win: declaration-based
    if (s.valueDeclaration) return true;

    const flags = s.getFlags();

    // Definitely runtime values
    if (
      flags &
      (ts.SymbolFlags.Function |
        ts.SymbolFlags.Class |
        ts.SymbolFlags.Enum |
        ts.SymbolFlags.Variable)
    )
      return true;

    // Namespaces and ES modules (namespace objects at runtime)
    if (flags & (ts.SymbolFlags.Namespace | ts.SymbolFlags.ValueModule))
      return true;

    // Fallback: inspect declarations
    for (const d of s.getDeclarations() ?? []) {
      if (
        ts.isVariableDeclaration(d) ||
        ts.isFunctionDeclaration(d) ||
        ts.isClassDeclaration(d) ||
        ts.isEnumDeclaration(d)
      )
        return true;
      // `namespace Foo {}` is runtime (value namespace)
      if (ts.isModuleDeclaration(d)) return true;
      // A SourceFile can also back a namespace object when imported as a module
      if (ts.isSourceFile(d)) return true;
    }

    return false;
  }

  /** Collect symbols referenced by a *value* expression chain (b.c().d.e(), i.generateSecretKey, new Foo()…).
   * Returns unique symbols by declaration identity, in first-seen order. */
  private symbolsFromValueExprDeep(expr: ts.Expression): ts.Symbol[] {
    const out: ts.Symbol[] = [];
    const seen = new Set<ts.Declaration>();
    const visitedNodes = new Set<ts.Node>();
    let recursionDepth = 0;
    const MAX_RECURSION_DEPTH = 500;
    
    const push = (label: string, s?: ts.Symbol) => {
      if (!s) {
        this.dbg("push:", label, "<no symbol>");
        return;
      }
      if ((s.getFlags() & ts.SymbolFlags.TypeParameter) !== 0) {
        this.dbg("push:", label, "skip type-param", this.symInfo(s));
        return;
      }
      const d = s.getDeclarations()?.[0];
      if (!d) {
        this.dbg("push:", label, "skip no decl", this.symInfo(s));
        return;
      }
      if (seen.has(d)) {
        this.dbg("push:", label, "dup", this.symInfo(s));
        return;
      }
      seen.add(d);
      this.dbg("push:", label, this.symInfo(s));
      out.push(s);
    };

    const visit = (e: ts.Expression) => {
      recursionDepth++;
      
      if (recursionDepth > MAX_RECURSION_DEPTH) {
        console.error(`symbolsFromValueExprDeep: Maximum recursion depth exceeded at ${recursionDepth}. Node kind: ${ts.SyntaxKind[e.kind]}`);
        throw new Error(`Stack overflow prevented in symbolsFromValueExprDeep at depth ${recursionDepth}`);
      }
      
      // Prevent infinite recursion by tracking visited nodes
      if (visitedNodes.has(e)) {
        recursionDepth--;
        return;
      }
      visitedNodes.add(e);
      
      if (recursionDepth % 50 === 0) {
        console.log(`symbolsFromValueExprDeep depth: ${recursionDepth}, Node: ${ts.SyntaxKind[e.kind]}`);
      }
      
      this.dbg("visit:", this.nodeInfo(e));

      // unwrap
      if (
        ts.isParenthesizedExpression(e) ||
        ts.isAsExpression(e) ||
        (ts as any).isTypeAssertionExpression?.(e) ||
        (ts as any).isNonNullExpression?.(e)
      ) {
        visit((e as any).expression);
        return;
      }
      if (ts.isAwaitExpression(e)) {
        visit(e.expression);
        return;
      }

      if (ts.isIdentifier(e)) {
        push("identifier", this.checker.getSymbolAtLocation(e));
        return;
      }
      if (
        e.kind === ts.SyntaxKind.ThisKeyword ||
        e.kind === ts.SyntaxKind.SuperKeyword
      )
        return;

      if (ts.isPropertyAccessExpression(e)) {
        // base
        visit(e.expression);

        // Try whole expr first
        let propSym = this.checker.getSymbolAtLocation(e);
        this.dbg("  PAE whole:", this.symInfo(propSym));

        if (!propSym) {
          // name-only
          propSym = this.checker.getSymbolAtLocation(e.name);
          this.dbg("  PAE name :", this.symInfo(propSym));
        }

        if (!propSym) {
          // type fallback
          const objType = this.checker.getTypeAtLocation(e.expression);
          const byType = this.checker.getPropertyOfType(objType, e.name.text);
          this.dbg("  PAE type :", this.symInfo(byType));
          propSym = byType;
        }

        push("prop", propSym);
        return;
      }

      if (ts.isElementAccessExpression(e)) {
        visit(e.expression);
        const objType = this.checker.getTypeAtLocation(e.expression);
        const key = e.argumentExpression;

        if (key && ts.isStringLiteral(key)) {
          const p = this.checker.getPropertyOfType(objType, key.text);
          this.dbg("  EAE str :", key.text, this.symInfo(p));
          push("elem[str]", p);
        } else if (key && ts.isIdentifier(key)) {
          const keySym = this.checker.getSymbolAtLocation(key);
          const kd = keySym?.valueDeclaration ?? keySym?.declarations?.[0];
          const init =
            kd && ts.isVariableDeclaration(kd) ? kd.initializer : undefined;
          if (init && ts.isStringLiteral(init)) {
            const p = this.checker.getPropertyOfType(objType, init.text);
            this.dbg("  EAE id->str :", init.text, this.symInfo(p));
            push("elem[id->str]", p);
          } else {
            this.dbg("  EAE id unresolved:", key.getText());
          }
        }
        return;
      }

      if (ts.isCallExpression(e)) {
        const sig = this.checker.getResolvedSignature(e);
        const decl = sig?.declaration;
        let calleeSym: ts.Symbol | undefined =
          (decl && (decl as any).symbol) || undefined;
        this.dbg(
          "  CALL sig.decl:",
          decl ? ts.SyntaxKind[decl.kind] : "<none>",
          "sym:",
          this.symInfo(calleeSym)
        );

        if (!calleeSym) {
          const callee = e.expression;
          calleeSym =
            this.checker.getSymbolAtLocation(callee) ||
            (ts.isPropertyAccessExpression(callee)
              ? this.checker.getSymbolAtLocation(callee.name)
              : undefined);
          this.dbg("  CALL expr sym:", this.symInfo(calleeSym));
        }

        push("call", calleeSym);
        visit(e.expression);
        // e.arguments?.forEach(visit);
        return;
      }

      if (ts.isNewExpression(e)) {
        const sig = this.checker.getResolvedSignature(e);
        let cls: ts.Symbol | undefined =
          (sig?.declaration && (sig.declaration as any).symbol) ||
          this.checker.getSymbolAtLocation(e.expression);
        this.dbg("  NEW cls:", this.symInfo(cls));
        push("new", cls);
        if (ts.isExpression(e.expression)) visit(e.expression);
        return;
      }

      if (ts.isConditionalExpression(e)) {
        visit(e.whenTrue);
        visit(e.whenFalse);
        return;
      }
      if (ts.isBinaryExpression(e)) {
        const op = e.operatorToken.kind;
        if (
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken ||
          op === ts.SyntaxKind.AmpersandAmpersandToken
        ) {
          visit(e.left);
          visit(e.right);
          return;
        }
      }

      ts.forEachChild(e, (c) => {
        if (ts.isExpression(c) && !visitedNodes.has(c)) {
          visit(c);
        }
      });
      
    };

    visit(expr);
    this.dbg(
      "value-walk result:",
      out.map((s) => this.symInfo(s))
    );
    return out;
  }

  /** Access the underlying ts.Program. */
  getProgram(): ts.Program {
    return this.program;
  }
  /** The parsed package.json at project root. */
  getPackageJson(): any {
    return this.packageJson;
  }
  /** Compiler options used by the Program. */
  getOptions(): ts.CompilerOptions {
    return this.options;
  }
}
