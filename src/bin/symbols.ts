import { Command } from "commander";
import { debugError } from "askexperts/common";
import { enableDebugAll } from "../utils/debug.js";
import { Symbol, TypeScript } from "../indexer/typescript/TypeScript.js";

export function listAllSymbols(projectPath: string) {
  const parser = new TypeScript(projectPath);
  const symbols = parser.listAllSymbols();
  const print = (s: Symbol, offset: number = 0) => {
    // For overloaded functions, we need to resolve back to the specific declaration
    // that was used to create this symbol, not just use s.self
    const resolved = parser.resolveStableId(s.id);
    if (!resolved) throw new Error("Failed to resolve "+JSON.stringify(s.id));

    const related = parser.related(resolved.decl);
    console.log(
      `${" ".repeat(offset)}${s.id.file}:${s.start}:${s.end}:${s.id.name}:${
        s.id.kind
      }:${s.id.overloadIndex} rel: ${related
        .map((r) => parser.buildStableId(r.symbol)?.name)
        .join(",")}` //  ${JSON.stringify(s.id)}
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
  options: { debug?: boolean; ts_config_path?: string }
): Promise<void> {
  // Enable debug output if debug flag is set
  if (options.debug) {
    enableDebugAll();
  }

  try {
    listAllSymbols(tsConfigPath);
  } catch (error) {
    debugError(`Error processing project: ${(error as Error).message}`);
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
    .action(processSymbols);
}
