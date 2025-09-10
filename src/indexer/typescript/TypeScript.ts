import path from "path";
import ts from "typescript";
import fs from "fs";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

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
  // name: string;
  kind: string;
  // file: string;
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

export class TypeScript {
  private program: ts.Program;
  private packageJson: any;
  private checker: ts.TypeChecker;
  private projectDir: string;
  private options: ts.CompilerOptions;
  private allRoots: FoundExport[];
  private valueRoots: FoundExport[];

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

    this.packageJson = JSON.parse(
      fs.readFileSync(this.projectDir + "/package.json").toString()
    );

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
  pathsTo(target: ts.Symbol | ts.Declaration): AccessPath[] {
    const targetSym = this.toSymbol(target);
    if (!targetSym) return [];
    const targetDecl = targetSym.getDeclarations()?.[0];
    if (!targetDecl) return [];

    const targetResolved = this.resolveAlias(targetSym);
    const targetIsValue = this.symbolHasRuntimeValue(targetResolved);

    const roots = targetIsValue ? this.valueRoots : this.allRoots;

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

      if (this.isClassLike(expResolved)) {
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
            const stepKind = this.isStaticMember(p) ? "static" : "instance";
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
              kind: this.isStaticMember(p) ? "static" : "instance",
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

  /** Extract referenced *type* symbols from a type, including generics’ arguments. */
  private typeTargets(t: ts.Type): ts.Symbol[] {
    const seenDecl = new Set<ts.Declaration>();
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

  /** Collect type *symbols* mentioned syntactically inside a TypeNode.
   * Walks through utility types (Omit/Pick/Promise), unions/intersections,
   * function types, type literals, mapped/conditional types, etc.
   */
  private symbolsFromTypeNodeDeep(node: ts.TypeNode): ts.Symbol[] {
    const out: ts.Symbol[] = [];
    const seenDecl = new Set<ts.Declaration>();

    const addSym = (s?: ts.Symbol) => {
      if (!s) return;
      const d = s.getDeclarations()?.[0];
      if (!d) return;
      if (seenDecl.has(d)) return;
      seenDecl.add(d);
      out.push(s);
    };

    const visit = (n: ts.Node) => {
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
      ts.forEachChild(n, visit);
    };

    visit(node);
    return out;
  }

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
    const d = sym.getDeclarations()?.[0];
    if (!d) return false;
    const f = ts.getOriginalNode(d).getSourceFile();
    // Exclude libraries and external .d.ts
    if (f.isDeclarationFile) return f.fileName.startsWith(this.projectDir);
    return path.resolve(f.fileName).startsWith(this.projectDir);
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
        targetIsType: this.symbolHasRuntimeValue(targetResolved),
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
  // Handles: Identifier (alias), PropertyAccess (obj.prop), ElementAccess (obj["prop"]).
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

  buildStableId(target: ts.Symbol | ts.Declaration) {
    return buildStableId(
      this.program,
      this.projectDir,
      target,
      () => this.allRoots
    );
  }

  listAllSymbols() {
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
        kind: ts.SyntaxKind[decl.kind],
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

  /** Return package-local *types* referenced by the public interface of `target`. */
  public related(target: ts.Symbol | ts.Declaration): RelatedItem[] {
    const sym = this.toSymbol(target);
    if (!sym) return [];
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl) return [];

    const addSet = new Map<ts.Declaration, RelatedItem>();
    const add = (s: ts.Symbol) => {
      if (!s) return;

      // skip generic type parameters like `T`, `K`, etc.
      if ((s.getFlags() & ts.SymbolFlags.TypeParameter) !== 0) return;

      // 👇 Keep alias *names* intact (don’t resolve type aliases)
      const isTypeAlias = (s.getFlags() & ts.SymbolFlags.TypeAlias) !== 0;
      const rs = isTypeAlias ? s : this.resolveAlias(s);

      if (!this.inThisPackage(rs)) return;
      if (this.isAnonymousTypeSym(rs)) return;

      // Don’t filter out by "primitive/global" using the *underlying* anonymous/type;
      // keep alias names even if they alias a primitive/anonymous intersection in part.
      if (!isTypeAlias) {
        const t =
          (this.checker as any).getDeclaredTypeOfSymbol?.(rs) ??
          this.checker.getTypeOfSymbolAtLocation(
            rs,
            rs.valueDeclaration ?? rs.declarations?.[0] ?? decl
          );
        if (this.isGlobalOrPrimitive(t, rs)) return;
      }

      const d = rs.getDeclarations()?.[0];
      if (!d || d === decl) return;
      if (!addSet.has(d)) addSet.set(d, { symbol: rs, ...this.locOfDecl(d) });
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
        for (const p of params)
          if (p.type) this.symbolsFromTypeNodeDeep(p.type).forEach(add);

        // return type
        const rt = sig.getReturnType();
        this.typeTargets(rt).forEach(add);

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
            // arrow/function expressions can also have predicates; check node just in case
            addPredicateTypeFromNode(init as any);
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
      return [...addSet.values()];
    }
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

  public isClassLike(sym: ts.Symbol): boolean {
    const d = sym.valueDeclaration ?? sym.declarations?.[0];
    return !!d && (ts.isClassDeclaration(d) || ts.isClassExpression(d));
  }

  public isFunctionLike(sym: ts.Symbol): boolean {
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    return (
      !!decl &&
      (ts.isFunctionDeclaration(decl) ||
        ts.isMethodDeclaration(decl) ||
        ts.isFunctionExpression(decl) ||
        ts.isMethodSignature(decl) ||
        ts.isArrowFunction(decl as any))
    );
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

  getProgram(): ts.Program {
    return this.program;
  }
  getPackageJson(): any {
    return this.packageJson;
  }
  getOptions(): ts.CompilerOptions {
    return this.options;
  }
}

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

function isFileScopeDeclaration(
  node: ts.Node,
  opts?: { allowNamespaces?: boolean }
): boolean {
  let cur: ts.Node | undefined = node.parent;

  while (cur && !ts.isSourceFile(cur)) {
    // Namespace/module blocks are *not* file scope (set allowNamespaces to true if you want them)
    if (ts.isModuleBlock(cur)) {
      return !!opts?.allowNamespaces; // false by default
    }

    // Inside any function-like -> local
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isConstructorDeclaration(cur) ||
      ts.isGetAccessorDeclaration(cur) ||
      ts.isSetAccessorDeclaration(cur)
    ) {
      return false;
    }

    // Inside class/enum/object literal member -> local/internal
    if (
      ts.isClassDeclaration(cur) ||
      ts.isClassExpression(cur) ||
      ts.isEnumDeclaration(cur) ||
      ts.isObjectLiteralExpression(cur)
    ) {
      return false;
    }

    // Inside block/statement scopes -> local
    if (
      ts.isBlock(cur) ||
      ts.isIfStatement(cur) ||
      ts.isSwitchStatement(cur) ||
      ts.isCaseClause(cur) ||
      ts.isDefaultClause(cur) ||
      ts.isTryStatement(cur) ||
      ts.isCatchClause(cur) ||
      ts.isWithStatement(cur) ||
      ts.isLabeledStatement(cur) ||
      ts.isDoStatement(cur) ||
      ts.isWhileStatement(cur) ||
      ts.isForStatement(cur) ||
      ts.isForInStatement(cur) ||
      ts.isForOfStatement(cur)
    ) {
      return false;
    }

    cur = cur.parent;
  }

  // We reached the SourceFile without hitting any enclosing scope → top-level
  return !!cur && ts.isSourceFile(cur);
}

function shouldSkipAsLocal(node: ts.Node): boolean {
  return !isFileScopeDeclaration(node, { allowNamespaces: true });
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
  const mods = ts.getCombinedModifierFlags(decl);
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
  className: string, // pass "JS"; if you really have an anonymous default class, pass "" to match any
  methodName: string // e.g. "generateSecretKey"
): ts.MethodDeclaration | undefined {
  const sf = program.getSourceFile(path.resolve(absFilePath));
  if (!sf) return;

  let found: ts.MethodDeclaration | undefined;

  const visit = (node: ts.Node) => {
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

/** Utility: is this a file likely to be an entrypoint, by heuristics */
function looksLikeEntrypoint(rel: string): boolean {
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
  if (nameNode && ts.isIdentifier(nameNode)) return nameNode.text;
  if (ts.isExportAssignment(decl)) return "export=";
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
  const sym = symbolFromTarget(checker, target);
  if (!sym) return;

  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (!decl) return;
  const sf = decl.getSourceFile();

  const header = getDeclarationHeader(decl, sf);
  const headerHash = hashHeader(header);

  // overload index among same-name declarations in this container/file
  let overloadIndex = 0;
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) {
    const siblings = (decl.parent as ts.Node)
      .getChildren()
      .filter(
        (n) =>
          (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
          (n as any).name?.getText(sf) === declName(decl, checker)
      ) as Array<typeof decl>;
    if (siblings.length > 1) {
      // sort by normalized header to get stable ordering
      const sorted = [...siblings].sort((a, b) =>
        normalizeHeaderText(getDeclarationHeader(a, sf)).localeCompare(
          normalizeHeaderText(getDeclarationHeader(b, sf))
        )
      );
      overloadIndex = sorted.indexOf(decl);
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

function resolveIfAlias(checker: ts.TypeChecker, s: ts.Symbol): ts.Symbol {
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

  const wantHeaderHash = id.headerHash;
  const considerDecl = (decl: ts.Declaration) => {
    if (ts.SyntaxKind[decl.kind] !== id.kind) return;

    const nameNode =
      (ts as any).getNameOfDeclaration?.(decl) ??
      (ts.isMethodSignature(decl) ||
      ts.isMethodDeclaration(decl) ||
      ts.isFunctionDeclaration(decl)
        ? (decl as any).name
        : undefined);
    const name =
      nameNode && ts.isIdentifier(nameNode) ? nameNode.text : "<anonymous>";
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
    const visit = (n: ts.Node) => {
      // cheap filter by kind & name
      if (
        ts.isClassDeclaration(n) ||
        ts.isInterfaceDeclaration(n) ||
        ts.isEnumDeclaration(n) ||
        ts.isTypeAliasDeclaration(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isMethodSignature(n) ||
        ts.isPropertyDeclaration(n) ||
        ts.isPropertySignature(n) ||
        ts.isVariableDeclaration(n)
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
      const visit = (n: ts.Node) => {
        if (
          ts.isClassDeclaration(n) ||
          ts.isInterfaceDeclaration(n) ||
          ts.isEnumDeclaration(n) ||
          ts.isTypeAliasDeclaration(n) ||
          ts.isFunctionDeclaration(n) ||
          ts.isMethodDeclaration(n) ||
          ts.isPropertyDeclaration(n) ||
          ts.isVariableDeclaration(n)
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

export function createSymbolIdHash(id: StableSymbolId) {
  let data = `${id.file}:${id.kind}:${id.name}:${id.headerHash}:${
    id.overloadIndex || 0
  }`;
  for (const c of id.containerChain) data += `:${c.kind}:${c.name}`;
  return bytesToHex(sha256(data));
}

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
