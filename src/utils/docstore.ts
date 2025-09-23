import path from "node:path";
import { Doc } from "askexperts/docstore";
import {
  StableSymbolId,
  Symbol,
  TypeScript,
} from "../indexer/typescript/TypeScript.js";
import {
  createSymbolIdHash,
  equalStableId,
  getDeclarationHeader,
  isClassLike,
  isFunctionLike,
} from "../indexer/typescript/utils.js";
import ts from "typescript";

export type DocSymbol = Symbol & {
  parentId?: StableSymbolId;
  summary: string;
  details: string;
};

export function symbolToDoc(
  symbolInfo: DocSymbol,
  symbolInfos: DocSymbol[],
  typescript: TypeScript,
  commitHash?: string,
  workspaceRelativePath?: string
): Doc {
  // Create timestamps (current time in seconds)
  const timestamp = Math.floor(Date.now() / 1000);

  // Backward compat
  if (!symbolInfo.id.hash)
    symbolInfo.id.hash = createSymbolIdHash(symbolInfo.id);

  // Get the symbol
  const symDecl = typescript.resolveStableId(symbolInfo.id);
  if (!symDecl) throw new Error(`Failed to find symbol ${symbolInfo.id}`);

  const { symbol, decl } = symDecl;

  // Related symbols
  const related = typescript.related(symbol);
  // Import paths
  const paths = typescript.pathsToRanked(symbol);

  // Doc metadata
  let metadata = '';
  if (workspaceRelativePath) {
    metadata += `workspace: ${workspaceRelativePath}\n`;
  }
  
  // Make file path relative to project root instead of workspace
  const filePathFromRoot = workspaceRelativePath
    ? path.posix.join(workspaceRelativePath, symbolInfo.id.file)
    : symbolInfo.id.file;
  
  metadata += `file: ${filePathFromRoot}\n`;
  metadata += `lines: ${symbolInfo.start.split(":")[0]}:${symbolInfo.end.split(":")[0]}\n`;
  metadata += `id: ${symbolInfo.id.hash}\n`;
  if (commitHash) {
    metadata += `commit: ${commitHash}\n`;
  }

  // Prefix/suffix for 'interface'
  let parentPrefix = "";
  let parentSuffix = "";
  let parentId = symbolInfo.parentId;
  while (parentId) {
    const symDecl = typescript.resolveStableId(parentId);
    if (!symDecl) break;

    parentPrefix =
      getDeclarationHeader(symDecl.decl, symDecl.decl.getSourceFile()) +
      "\n// ...\n" +
      parentPrefix;
    parentSuffix += "\n//...\n}";
    parentId = symbolInfos.find((s) =>
      equalStableId(s.id, parentId!)
    )?.parentId;
  }

  // Interface string body
  const header = getDeclarationHeader(decl, decl.getSourceFile());
  const body = decl.getText();
  const interfaceString = isClassLike(symbol)
    ? typescript.printClassLikePublicInterface(
        decl as ts.ClassDeclaration | ts.ClassExpression,
        {}
      )
    : isFunctionLike(symbol)
    ? header
    : body;

  // The doc content: the interface with prefix/suffix and summary docs
  let content = `
declaration:
${parentPrefix}${interfaceString}${parentSuffix}

summary:
${symbolInfo.summary}
`.trim();

  // Details if exist
  if (symbolInfo.details) content += `\n\ndetails:\n${symbolInfo.details}`;

  // List of related symbols just for readability
  if (related.length)
    content += `\n\nrelated: ${related.map((r) => r.symbol.name).join(",")}`;

  // Full body if needed
  if (body !== interfaceString) {
    content += `\n\ncode:\n${body}`;
  }

  // Format import examples
  let usage = "";
  for (const p of paths) {
    let line =
      typescript.makeImportStatement(
        p.root,
        typescript.getPackageJson()?.name || "<package>"
      ) + "\n";
    if (p.steps.length) line += (p.requiresNew ? "new " : "") + p.pretty + "\n";
    usage += line;
  }
  if (usage) content += `\n\nimport/access examples:\n${usage}`;

  // Create Doc object
  // Modify doc ID for monorepos
  const docId = workspaceRelativePath ? `${workspaceRelativePath}:${symbolInfo.id.hash}` : symbolInfo.id.hash;
  
  const doc: Doc = {
    id: docId,
    docstore_id: "", // This will be set when the document is added to a docstore
    timestamp,
    created_at: timestamp, // Same as timestamp for new documents
    type: "typescript_symbol_doc",
    data: content, // Use the markdown string directly as the data field
    metadata,
    embeddings: [],
    related_ids: related
      .map((r) => typescript.buildStableId(r.symbol))
      .filter((id) => !!id)
      .map((id) => id.hash),
  };

  return doc;
}
