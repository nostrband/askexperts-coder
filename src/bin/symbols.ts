import { Command } from "commander";
import { debugError } from "askexperts/common";
import { enableDebugAll } from "../utils/debug.js";
import { Symbol, TypeScript } from "../indexer/typescript/TypeScript.js";

export function listAllSymbols(projectPath: string) {
  const parser = new TypeScript(projectPath);
  const symbols = parser.listAllSymbols();
  const rows: any[] = [];
  const print = (s: Symbol) => {
    rows.push({
      ...s,
      children: undefined,
      parent: undefined,
      // branch,
      parentId: s.parent?.id,
    });
  };

  const printSymbols = (ss: Symbol[]) => {
    for (const s of ss) {
      print(s);
      if (s.children) printSymbols(s.children);
    }
  };

  printSymbols(symbols);

  // Output as a single JSON array with nested structure
  console.log(JSON.stringify(rows, null, 2));
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
