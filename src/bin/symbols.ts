import { Command } from "commander";
import { debugError } from "askexperts/common";
import { enableDebugAll, debugTypescript } from "../utils/debug.js";
import { Symbol, TypeScript } from "../indexer/typescript/TypeScript.js";
import { extractWorkspaces } from "../utils/workspace.js";
import path from "path";
import fs from "fs";

export function listAllSymbols(projectPath: string, showHash?: boolean) {
  // Check if this is a monorepo with workspaces
  const workspaces = extractWorkspaces(projectPath);
  
  if (workspaces.length > 0) {
    // Process each workspace
    for (const workspace of workspaces) {
      listAllSymbolsForWorkspace(workspace.path, projectPath, showHash);
    }
  } else {
    // Process as a single package
    listAllSymbolsForWorkspace(projectPath, projectPath, showHash);
  }
}

function listAllSymbolsForWorkspace(workspacePath: string, rootProjectPath: string, showHash?: boolean) {
  // Check if tsconfig.json or deno.json exists in this workspace
  const tsconfigPath = path.join(workspacePath, 'tsconfig.json');
  const denoJsonPath = path.join(workspacePath, 'deno.json');
  
  if (!fs.existsSync(tsconfigPath) && !fs.existsSync(denoJsonPath)) {
    console.log(`Skipping workspace ${workspacePath} - no tsconfig.json or deno.json found`);
    return;
  }
  
  const parser = new TypeScript(workspacePath);
  const symbols = parser.listRootSymbols();
  debugTypescript(`Workspace ${workspacePath} root symbols ${symbols.length}`);
  
  // Calculate the relative path from root project to this workspace
  const workspaceRelativePath = path.relative(rootProjectPath, workspacePath);
  const workspacePrefix = workspaceRelativePath ? workspaceRelativePath + "/" : "";
  
  const printedSymbols = new Set<string>();
  const print = (s: Symbol, offset: number = 0) => {
    // Prevent infinite recursion by tracking printed symbols
    // Include start position to make the key unique for each symbol
    const symbolKey = `${s.id.file}:${s.start}:${s.id.name}:${s.id.kind}:${s.id.overloadIndex}`;
    if (printedSymbols.has(symbolKey)) {
      // debugTypescript(`Circular reference detected in symbol hierarchy: ${s.id.name} at ${s.id.file}`);
      // console.log(`${" ".repeat(offset)}[CIRCULAR REFERENCE: ${s.id.name}]`);
      return;
    }
    printedSymbols.add(symbolKey);
    
    // For overloaded functions, we need to resolve back to the specific declaration
    // that was used to create this symbol, not just use s.self
    const resolved = parser.resolveStableId(s.id);
    if (!resolved) throw new Error("Failed to resolve "+JSON.stringify(s.id));

    const related = parser.related(resolved.decl);
    
    // Prepend workspace path to the file path
    const fileWithWorkspace = workspacePrefix + s.id.file;
    
    console.log(
      `${" ".repeat(offset)}${fileWithWorkspace}:${s.start}:${s.end}:${s.id.name}:${
        s.id.kind
      }:${s.id.overloadIndex} rel: ${related
        .map((r) => parser.buildStableId(r.symbol)?.name)
        .join(",")}${showHash ? ` h: ${s.id.hash}` : ''}` //  ${JSON.stringify(s.id)}
    );
    for (const c of s.children || []) {
      print(c, offset + 2);
    }
  };
  for (const c of symbols) print(c);
}

// --- helpers ---

async function processSymbols(
  tsConfigPath: string,
  options: { debug?: boolean; ts_config_path?: string, hash?: boolean }
): Promise<void> {
  // Enable debug output if debug flag is set
  if (options.debug) {
    enableDebugAll();
  }

  try {
    listAllSymbols(tsConfigPath, options.hash);
  } catch (error) {
    debugError(`Error processing project: ${(error as Error).message}`);
    if (options.debug) {
      console.error("Stack trace:", (error as Error).stack);
    }
    process.exit(1);
  }
}

/**
 * Register the 'file' command to the provided commander instance
 *
 * @param program - Commander instance to register the command to
 */
export function registerSymbolsCommand(program: Command): void {
  program
    .command("symbols")
    .description("Process a TypeScript package and print all symbols")
    .argument("<package_path>", "Path to the package")
    .option("-d, --debug", "Enable debug output")
    .option("--hash", "Show symbol id hashes")
    .action(processSymbols);
}
