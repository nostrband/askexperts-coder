import { Command } from "commander";
import path from "path";
import fs from "fs";
import os from "os";
import { debugCli, debugError, enableDebugAll } from "../utils/debug.js";
import { Symbol, TypeScript } from "../indexer/typescript/TypeScript.js";
import { TypescriptIndexer } from "../indexer/typescript/TypescriptIndexer.js";

/**
 * Gets the NWC string from the provided option, from the file, or throws an error
 *
 * @param optionNwc - NWC string provided via CLI option
 * @returns The NWC string to use
 * @throws Error if no NWC string is available
 */
function getNwcString(optionNwc?: string): string {
  // If NWC string is provided via CLI option, use it
  if (optionNwc) {
    return optionNwc;
  }

  // Try to read from ~/.askexperts-hacker-nwc file
  const nwcFilePath = path.join(os.homedir(), ".askexperts-hacker-nwc");

  if (fs.existsSync(nwcFilePath)) {
    try {
      return fs.readFileSync(nwcFilePath, "utf-8").trim();
    } catch (error) {
      debugError(`Error reading NWC file: ${(error as Error).message}`);
    }
  }

  // If we get here, no NWC string is available
  throw new Error(
    "No NWC string available. Please provide a NWC string using the --nwc option or create a ~/.askexperts-hacker-nwc file."
  );
}

/**
 * Saves the NWC string to the ~/.askexperts-hacker-nwc file
 *
 * @param nwcString - The NWC string to save
 */
function saveNwcString(nwcString: string): void {
  try {
    const nwcFilePath = path.join(os.homedir(), ".askexperts-hacker-nwc");
    fs.writeFileSync(nwcFilePath, nwcString);
    debugCli(`NWC string saved to ${nwcFilePath}`);
  } catch (error) {
    debugError(`Error saving NWC string to file: ${(error as Error).message}`);
  }
}

/**
 * Process a project at the specified path
 *
 * @param projectPath - Path to the project to process
 * @param options - Command options
 */
async function processProject(
  projectPath: string,
  options: { debug?: boolean; nwc?: string, name?: string }
): Promise<void> {
  // Enable debug output if debug flag is set
  if (options.debug) {
    enableDebugAll();
  }

  // Get NWC string from options, file, or error
  const nwcString = getNwcString(options.nwc);

  // If NWC was provided via CLI, save it
  if (options.nwc) {
    saveNwcString(options.nwc);
  }

  try {
    // Resolve the project path to an absolute path
    const absolutePath = path.resolve(process.cwd(), projectPath);

    // Check if the directory exists
    if (!fs.existsSync(absolutePath)) {
      debugError(`Project directory not found at path: ${absolutePath}`);
      process.exit(1);
    }

    // Check if the path is a directory
    if (!fs.statSync(absolutePath).isDirectory()) {
      debugError(`The path ${absolutePath} is not a directory`);
      process.exit(1);
    }

    debugCli(`Project path: ${absolutePath}`);

    const docsPath = path.join(absolutePath, 'indexer_docs');
    fs.mkdirSync(docsPath);

    debugCli(`Loading project...`);

    const project = new TypeScript(absolutePath);
    const symbols = project.listAllSymbols();
    debugCli(`Project has ${symbols.length} symbols`);

    const fillBranch = (s: Symbol, branch?: Symbol[]) => {
      if (!branch) branch = [];
      if (!s.parent) return branch;
      branch.push({ ...s.parent, children: undefined, parent: undefined });
      return fillBranch(s.parent, branch);
    };

    const symbolInfos: (Symbol & { branch?: Symbol[] })[] = [];
    const addInfo = (s: Symbol) => {
      const branch = fillBranch(s);
      symbolInfos.push({
        ...s,
        children: undefined,
        parent: undefined,
        branch,
      });
    };

    const addSymbols = (ss: Symbol[]) => {
      for (const s of ss) {
        addInfo(s);
        if (s.children) addSymbols(s.children);
      }
    };

    addSymbols(symbols);

    // Sort by filename
    // symbolInfos.sort((a, b) =>
    //   a.file < b.file ? -1 : a.file > b.file ? 1 : 0
    // );

    const indexer = new TypescriptIndexer({
      nwc: nwcString,
      systemPrompt: `
You are a TypeScript expert, your task is to create documentation for every symbol in a typescript project.

User will provide:
1. .ts file path within the project.
2. The contents of the file, with line numbers prepended in "<lineNumber>|<codeLine>" format.
3. Description of the symbol with name, declaration and start/end line:column numbers.

You job is:
1. Create a short documentation of the public "side" of the symbol - what it does, what params accepts, what is returned, 
what public side effects happen, etc.
2. Create a short documentation of the implementation details of the symbol - how it works, what main 
components/modules/functions are used, anything that would help a coder get a rough vision of the implementation without
reading the full source code.
3. Return a json (no markdown) of the format: { summary: <public_docs>, details: <implementation_docs> } 

If the provided input is invalid, return "ERROR: <reason>" string.
`
    });

    let file = "";
    let code = "";
    for (const s of symbolInfos) {
      if (s.file !== file) {
        file = s.file;
        code = fs
          .readFileSync(path.join(absolutePath, s.file))
          .toString("utf8");
      }

      debugCli(
        `Processing file ${file} code ${code.length} symbol ${s.name}...`
      );

      const { branch, ...symbolWithoutBranch } = s;
      const docs = await indexer.processSymbol(file, code, symbolWithoutBranch);
      console.log("docs: ", JSON.stringify(docs, null, 2));

      const info = {
        ...s,
        ...docs
      };

      const docsFile = path.join(docsPath, file + ".json");

      fs.appendFileSync(docsFile, JSON.stringify(info) + "\n");
    }

    //   const finder = new TypeScript(absolutePath);
    //   if (options.name) {
    //     const exports = finder.find(options.name);
    //     console.log("exports", exports);
    //   } else {
    //     const methodDecl = finder.findClassMethodDecl(
    //       path.join(absolutePath, "src/resources/chat/completions/completions.ts"),
    //       "Completions",
    //       "create"
    //     );
    //     if (!methodDecl) throw new Error("Completions.create not found");

    //     const paths = finder.pathsTo(methodDecl);
    //     for (const p of paths) {
    //       console.log(
    //         p.pretty,
    //         " ← via export",
    //         JSON.stringify(p.root.exportName),
    //         "in",
    //         p.root.moduleFile
    //       );
    //     }
    //   }
  } catch (error) {
    debugError(`Error processing project: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Register the 'package' command to the provided commander instance
 *
 * @param program - Commander instance to register the command to
 */
export function registerPackageCommand(program: Command): void {
  program
    .command("package")
    .description("Process a project at the specified path")
    .argument("<path_to_project>", "Path to the project to process")
    .option("-d, --debug", "Enable debug output")
    .option("-n, --name", "Symbol name to find if it is exported")
    .action(processProject);
}
