import { Command } from "commander";
import path from "path";
import fs from "fs";
import os from "os";
import { debugCli, debugError, enableDebugAll } from "../utils/debug.js";
import { StableSymbolId, Symbol, TypeScript } from "../indexer/typescript/TypeScript.js";
import { TypescriptIndexer } from "../indexer/typescript/TypescriptIndexer.js";

/**
 * Gets the NWC string from the provided option, from the file, or throws an error
 *
 * @param optionNwc - NWC string provided via CLI option
 * @returns The NWC string to use
 * @throws Error if no NWC string is available
 */
export function getNwcString(optionNwc?: string): string {
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
export function saveNwcString(nwcString: string): void {
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
  options: { debug?: boolean; nwc?: string, name?: string, continue?: boolean, threads?: number }
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
    fs.mkdirSync(docsPath, { recursive: true });

    debugCli(`Loading project...`);

    const project = new TypeScript(absolutePath);
    const symbols = project.listAllSymbols();
    debugCli(`Project has ${symbols.length} root symbols`);

    // const fillBranch = (s: Symbol, branch?: Symbol[]) => {
    //   if (!branch) branch = [];
    //   if (!s.parent) return branch;
    //   branch.push({ ...s.parent, children: undefined, parent: undefined });
    //   return fillBranch(s.parent, branch);
    // };

    const symbolInfos: (Symbol & { parentId?: StableSymbolId })[] = [];
    const addInfo = (s: Symbol) => {
      // const branch = fillBranch(s);
      symbolInfos.push({
        ...s,
        children: undefined,
        parent: undefined,
        parentId: s.parent?.id,
        // branch,
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
2. Create a short documentation of the implementation details of the symbol - what it does, how it works, what main 
components/modules/functions are used, anything that would help a coder get a rough vision of the implementation without
reading the full source code. If the symbol is trivial, leave this doc entry empty.
3. Return a document in this JSON format (no markdown!): "{ summary: <public_docs>, details: <implementation_docs> }" 
4. Make sure you return valid json with escaped line-breaks in "details" field, especially important when your 
details contain numbered lists. 

If the provided input is invalid, return "ERROR: <reason>" string.
`
    });

    /**
     * Process a single symbol asynchronously
     *
     * @param symbol The symbol to process
     * @param projectPath The absolute path to the project
     * @param docsPath The path to store documentation
     * @param indexer The TypescriptIndexer instance
     * @param fileCache A cache object to store file content
     * @param options Command options
     * @returns Promise that resolves when the symbol is processed
     */
    async function processSymbolAsync(
      symbol: (Symbol & { branch?: Symbol[] }),
      projectPath: string,
      docsPath: string,
      indexer: TypescriptIndexer,
      fileCache: {
        currentFile: string;
        fileContent: string;
        existingDocSymbols: Map<string, any>;
      },
      options: { debug?: boolean; nwc?: string; name?: string; continue?: boolean; threads?: number }
    ): Promise<void> {
      // Check if we need to load a new file
      if (symbol.id.file !== fileCache.currentFile) {
        fileCache.currentFile = symbol.id.file;
        fileCache.fileContent = fs
          .readFileSync(path.join(projectPath, symbol.id.file))
          .toString("utf8");
          
        // Reset the existing doc symbols for the new file
        fileCache.existingDocSymbols.clear();
        
        // Load existing documentation if continue is enabled
        if (options.continue) {
          const docsFile = path.join(docsPath, symbol.id.file + ".json");
          
          if (fs.existsSync(docsFile)) {
            try {
              const content = fs.readFileSync(docsFile, 'utf8');
              const lines = content.trim().split('\n');
              
              for (const line of lines) {
                if (line.trim()) {
                  const docSymbol = JSON.parse(line) as Symbol;
                  fileCache.existingDocSymbols.set(docSymbol.id.name, docSymbol);
                  debugCli(`Loaded existing documentation for symbol: ${docSymbol.id.name}`);
                }
              }
              
              debugCli(`Loaded ${fileCache.existingDocSymbols.size} documented symbols from ${docsFile}`);
            } catch (error) {
              debugError(`Error reading existing doc file: ${(error as Error).message}`);
            }
          }
        }
      }

      debugCli(
        `Processing file ${symbol.id.file} code ${fileCache.fileContent.length} symbol ${symbol.id.name}...`
      );

      // If continue is enabled and this symbol is already documented, skip it
      if (options.continue && fileCache.existingDocSymbols.has(symbol.id.name)) {
        debugCli(`Skipping already documented symbol: ${symbol.id.name}`);
        return;
      }

      const docs = await indexer.processSymbol(symbol.id.file, fileCache.fileContent, symbol);
      console.log("docs: ", JSON.stringify(docs, null, 2));

      const info = {
        ...symbol,
        ...docs
      };

      const docsFile = path.join(docsPath, symbol.id.file + ".json");
      
      // Ensure the directory structure exists before writing
      const docsFileDir = path.dirname(docsFile);
      if (!fs.existsSync(docsFileDir)) {
        fs.mkdirSync(docsFileDir, { recursive: true });
      }

      fs.appendFileSync(docsFile, JSON.stringify(info) + "\n");
    }

    // Initialize the file cache
    const fileCache = {
      currentFile: "",
      fileContent: "",
      existingDocSymbols: new Map<string, any>()
    };
    
    // Get the number of threads (default to 1 if not specified)
    const numThreads = options.threads || 1;
    debugCli(`Processing with ${numThreads} parallel threads`);
    
    // Process symbols in parallel
    const activePromises: Promise<void>[] = [];
    let nextSymbolIndex = 0;
    
    // Helper function to process the next symbol
    const processNextSymbol = () => {
      if (nextSymbolIndex >= symbolInfos.length) throw new Error("No more symbols");
      
      const symbol = symbolInfos[nextSymbolIndex];
      nextSymbolIndex++;
      
      return processSymbolAsync(symbol, absolutePath, docsPath, indexer, fileCache, options)
        .catch(error => {
          debugError(`Error processing symbol ${symbol.id.name}: ${error.message}`);
          // Re-throw to ensure Promise.race catches it
          throw error;
        });
    };
    
    // Initial filling of the active promises array
    while (activePromises.length < numThreads && nextSymbolIndex < symbolInfos.length) {
      const promise = processNextSymbol();
      activePromises.push(promise);
    }
    
    // Process remaining symbols as active ones complete
    while (activePromises.length > 0) {
      try {
        // Create a promise that resolves with the index of the completed promise
        const racePromises = activePromises.map(async (p, index) => {
          await p;
          return index;
        });
        
        // Wait for the first promise to complete
        const completedIndex = await Promise.race(racePromises);
        
        // Remove the completed promise from the active array
        if (completedIndex !== undefined) {
          activePromises.splice(completedIndex, 1);
        }
        
        // Add a new promise if there are more symbols to process
        if (nextSymbolIndex < symbolInfos.length) {
          const newPromise = processNextSymbol();
          activePromises.push(newPromise);
        } else {
          debugCli("No more symbols");
        }
      } catch (error) {
        debugError(`Error in parallel processing: ${(error as Error).message}`);
        // stop
        throw error;
      }
    }

  } catch (error) {
    debugError(`Error processing project: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Register the 'generate' command to the provided commander instance
 *
 * @param program - Commander instance to register the command to
 */
export function registerGenerateCommand(program: Command): void {
  program
    .command("generate")
    .description("Generate docs for package symbols in 'indexer_docs' subdir")
    .argument("<path_to_project>", "Path to the project to process")
    .option("-d, --debug", "Enable debug output")
    .option("--nwc <string>", "Lightning Node Connect (NWC) string for payment")
    .option("-n, --name", "Symbol name to find if it is exported")
    .option("-c, --continue", "Continue processing, skipping symbols that are already documented")
    .option("-t, --threads <number>", "Number of parallel processing threads", (value) => parseInt(value, 10), 1)
    .action(processProject);
}
