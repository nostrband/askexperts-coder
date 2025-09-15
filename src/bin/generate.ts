import { Command } from "commander";
import path from "path";
import fs from "fs";
import os from "os";
import { execSync } from "child_process";
import { debugCli, debugError, enableDebugAll } from "../utils/debug.js";
import { StableSymbolId, Symbol, TypeScript } from "../indexer/typescript/TypeScript.js";
import { TypescriptIndexer } from "../indexer/typescript/TypescriptIndexer.js";
import { INDEXER_DIR } from "./index.js";

const NWC_FILE = ".askexperts-coder.nwc";

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

  // Try to read from file
  const nwcFilePath = path.join(os.homedir(), NWC_FILE);

  if (fs.existsSync(nwcFilePath)) {
    try {
      return fs.readFileSync(nwcFilePath, "utf-8").trim();
    } catch (error) {
      debugError(`Error reading NWC file: ${(error as Error).message}`);
    }
  }

  // If we get here, no NWC string is available
  throw new Error(
    `No NWC string available. Please provide a NWC string using the --nwc option or create a ~/${NWC_FILE} file.`
  );
}

/**
 * Saves the NWC string to the file
 *
 * @param nwcString - The NWC string to save
 */
export function saveNwcString(nwcString: string): void {
  try {
    const nwcFilePath = path.join(os.homedir(), NWC_FILE);
    fs.writeFileSync(nwcFilePath, nwcString);
    debugCli(`NWC string saved to ${nwcFilePath}`);
  } catch (error) {
    debugError(`Error saving NWC string to file: ${(error as Error).message}`);
  }
}

/**
 * Check git status and ensure we're on the expected branch with a clean tree
 *
 * @param projectPath - Path to the project to check
 * @param expectedBranch - Expected git branch (default: main)
 */
function checkGitStatus(projectPath: string, expectedBranch: string = "main"): void {
  try {
    debugCli(`Checking git status in ${projectPath}...`);
    
    // Check git status
    const gitStatus = execSync("git status --porcelain", {
      cwd: projectPath,
      encoding: "utf8"
    }).trim();
    
    if (gitStatus) {
      throw new Error(`Git tree is not clean. Please commit or stash your changes first.\nUncommitted changes:\n${gitStatus}`);
    }
    
    // Check current branch
    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: projectPath,
      encoding: "utf8"
    }).trim();
    
    if (currentBranch !== expectedBranch) {
      throw new Error(`Expected to be on branch '${expectedBranch}', but currently on '${currentBranch}'`);
    }
    
    debugCli(`Git status check passed: on branch '${currentBranch}' with clean tree`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not a git repository")) {
      throw new Error(`Project at ${projectPath} is not a git repository`);
    }
    throw error;
  }
}

/**
 * Get the current git commit hash
 *
 * @param projectPath - Path to the project
 * @returns The current commit hash
 */
function getCurrentCommitHash(projectPath: string): string {
  try {
    const commitHash = execSync("git rev-parse HEAD", {
      cwd: projectPath,
      encoding: "utf8"
    }).trim();
    
    debugCli(`Current commit hash: ${commitHash}`);
    return commitHash;
  } catch (error) {
    throw new Error(`Failed to get git commit hash: ${(error as Error).message}`);
  }
}

/**
 * Write commit hash to INDEXER_DIR/commit.git file
 *
 * @param docsPath - Path to the INDEXER_DIR directory
 * @param commitHash - The commit hash to write
 */
function writeCommitFile(docsPath: string, commitHash: string): void {
  const commitFilePath = path.join(docsPath, "commit.git");
  fs.writeFileSync(commitFilePath, commitHash);
  debugCli(`Commit hash written to ${commitFilePath}`);
}

/**
 * Check if commit.git file exists and validate commit hash for --continue mode
 *
 * @param docsPath - Path to the INDEXER_DIR directory
 * @param currentCommitHash - The current commit hash
 * @returns true if validation passes or file doesn't exist
 */
function validateCommitForContinue(docsPath: string, currentCommitHash: string): boolean {
  const commitFilePath = path.join(docsPath, "commit.git");
  
  if (!fs.existsSync(commitFilePath)) {
    debugCli("commit.git file does not exist, proceeding with --continue");
    writeCommitFile(docsPath, currentCommitHash);
    return true;
  }
  
  const existingCommitHash = fs.readFileSync(commitFilePath, "utf8").trim();
  
  if (existingCommitHash !== currentCommitHash) {
    throw new Error(
      `Commit hash mismatch in --continue mode.\n` +
      `Expected: ${existingCommitHash}\n` +
      `Current:  ${currentCommitHash}\n` +
      `Please ensure you're on the same commit as when generation was started.`
    );
  }
  
  debugCli(`Commit hash validation passed for --continue mode: ${currentCommitHash}`);
  return true;
}

/**
 * Process a project at the specified path
 *
 * @param projectPath - Path to the project to process
 * @param options - Command options
 */
async function processProject(
  projectPath: string,
  options: { debug?: boolean; nwc?: string, name?: string, continue?: boolean, threads?: number, branch?: string }
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

    // Check git status and branch before proceeding
    const expectedBranch = options.branch || "main";
    checkGitStatus(absolutePath, expectedBranch);
    
    // Get current commit hash
    const currentCommitHash = getCurrentCommitHash(absolutePath);
    
    const docsPath = path.join(absolutePath, INDEXER_DIR);
    fs.mkdirSync(docsPath, { recursive: true });
    
    // Handle commit.git file based on --continue option
    if (options.continue) {
      validateCommitForContinue(docsPath, currentCommitHash);
    } else {
      writeCommitFile(docsPath, currentCommitHash);
    }

    debugCli(`Loading project...`);

    const project = new TypeScript(absolutePath);
    const symbols = project.listAllSymbols();
    debugCli(`Project has ${symbols.length} root symbols`);

    const symbolInfos: (Symbol & { parentId?: StableSymbolId })[] = [];
    const addInfo = (s: Symbol) => {
      symbolInfos.push({
        ...s,
        parentId: s.parent?.id,

        // not needed, and can't be stringified
        children: undefined,
        parent: undefined,
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
      options: { debug?: boolean; nwc?: string; name?: string; continue?: boolean; threads?: number; branch?: string }
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
    .description(`Generate docs for package symbols in '${INDEXER_DIR}' subdir`)
    .argument("<path_to_project>", "Path to the project to process")
    .option("-d, --debug", "Enable debug output")
    .option("--nwc <string>", "Lightning Node Connect (NWC) string for payment")
    .option("-n, --name", "Symbol name to find if it is exported")
    .option("-c, --continue", "Continue processing, skipping symbols that are already documented")
    .option("-t, --threads <number>", "Number of parallel processing threads", (value) => parseInt(value, 10), 1)
    .option("-b, --branch <string>", "Expected git branch (default: main)", "main")
    .action(processProject);
}
