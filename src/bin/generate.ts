import { Command } from "commander";
import path from "path";
import fs from "fs";
import os from "os";
import { execSync } from "child_process";
import { debugCli, debugError, enableDebugAll } from "../utils/debug.js";
import {
  StableSymbolId,
  Symbol,
  TypeScript,
} from "../indexer/typescript/TypeScript.js";
import { TypescriptIndexer } from "../indexer/typescript/TypescriptIndexer.js";
import { INDEXER_DIR } from "./index.js";
import { extractWorkspaces } from "../utils/workspace.js";
import { generateFileTree, parseGitignore } from "../utils/fileTree.js";

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
 * Ignores changes in INDEXER_DIR to allow --continue option to work
 *
 * @param projectPath - Path to the project to check
 * @param expectedBranch - Expected git branch (default: main)
 */
function checkGitStatus(
  projectPath: string,
  expectedBranch: string = "main"
): void {
  try {
    debugCli(`Checking git status in ${projectPath}...`);

    // Check git status
    const gitStatus = execSync("git status --porcelain", {
      cwd: projectPath,
      encoding: "utf8",
    }).trim();

    if (gitStatus) {
      // Filter out changes in INDEXER_DIR (.askexperts) in any workspace to allow --continue option
      const filteredStatus = gitStatus
        .split("\n")
        .filter((line) => {
          // Extract the file path from git status line (format: "XY filename")
          const filePath = line.slice(3); // Remove the first 3 characters (status + space)

          // Check if this is an INDEXER_DIR path in any location
          const pathParts = filePath.split("/");
          const isIndexerDir =
            pathParts.some((part) => part === INDEXER_DIR) ||
            filePath === INDEXER_DIR ||
            filePath.startsWith(INDEXER_DIR + "/");

          return !isIndexerDir;
        })
        .join("\n")
        .trim();

      if (filteredStatus) {
        throw new Error(
          `Git tree is not clean. Please commit or stash your changes first.\nUncommitted changes:\n${filteredStatus}`
        );
      }

      if (gitStatus !== filteredStatus) {
        debugCli(
          `Ignoring changes in ${INDEXER_DIR} directories for --continue compatibility`
        );
      }
    }

    // Check current branch
    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: projectPath,
      encoding: "utf8",
    }).trim();

    if (currentBranch !== expectedBranch) {
      throw new Error(
        `Expected to be on branch '${expectedBranch}', but currently on '${currentBranch}'`
      );
    }

    debugCli(
      `Git status check passed: on branch '${currentBranch}' with clean tree`
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("not a git repository")
    ) {
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
      encoding: "utf8",
    }).trim();

    debugCli(`Current commit hash: ${commitHash}`);
    return commitHash;
  } catch (error) {
    throw new Error(
      `Failed to get git commit hash: ${(error as Error).message}`
    );
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
function validateCommitForContinue(
  docsPath: string,
  currentCommitHash: string
): boolean {
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

  debugCli(
    `Commit hash validation passed for --continue mode: ${currentCommitHash}`
  );
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
  options: {
    debug?: boolean;
    nwc?: string;
    name?: string;
    continue?: boolean;
    threads?: number;
    branch?: string;
    dir?: string;
    maxAmount?: number;
  }
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

    // Check if this is a monorepo with workspaces
    const workspaces = extractWorkspaces(absolutePath);

    if (workspaces.length > 0) {
      debugCli(`Found ${workspaces.length} workspaces in monorepo`);
      // Process each workspace
      for (const workspace of workspaces) {
        debugCli(`Processing workspace: ${workspace.name || workspace.path}`);
        await processWorkspace(
          workspace.path,
          absolutePath,
          currentCommitHash,
          nwcString,
          options
        );
      }
    } else {
      // Process as a single package
      debugCli(`Processing as single package`);
      await processWorkspace(
        absolutePath,
        absolutePath,
        currentCommitHash,
        nwcString,
        options
      );
    }
  } catch (error) {
    debugError(`Error processing project: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Process a single workspace
 *
 * @param workspacePath - Path to the workspace to process
 * @param rootProjectPath - Path to the root project (for relative paths)
 * @param currentCommitHash - Current git commit hash
 * @param nwcString - NWC string for payments
 * @param options - Command options
 */
async function processWorkspace(
  workspacePath: string,
  rootProjectPath: string,
  currentCommitHash: string,
  nwcString: string,
  options: {
    debug?: boolean;
    nwc?: string;
    name?: string;
    continue?: boolean;
    threads?: number;
    branch?: string;
    dir?: string;
    maxAmount?: number;
  }
): Promise<void> {
  const workspaceRelativePath = path.relative(rootProjectPath, workspacePath);
  const workspacePrefix = workspaceRelativePath
    ? workspaceRelativePath + "/"
    : "";

  // Check if tsconfig.json or deno.json exists in the workspace
  const tsconfigPath = path.join(workspacePath, "tsconfig.json");
  const denoJsonPath = path.join(workspacePath, "deno.json");

  if (!fs.existsSync(tsconfigPath) && !fs.existsSync(denoJsonPath)) {
    debugCli(
      `Skipping workspace ${workspacePath}: no tsconfig.json or deno.json found`
    );
    return;
  }

  debugCli(`Processing workspace at: ${workspacePath}`);

  // Create INDEXER_DIR within each workspace, not under the root
  const docsPath = options.dir
    ? path.resolve(process.cwd(), options.dir)
    : path.join(workspacePath, INDEXER_DIR);
  fs.mkdirSync(docsPath, { recursive: true });

  // Handle commit.git file based on --continue option
  if (options.continue) {
    validateCommitForContinue(docsPath, currentCommitHash);
  } else {
    writeCommitFile(docsPath, currentCommitHash);
  }

  debugCli(`Loading workspace project...`);

  const project = new TypeScript(workspacePath);
  const symbols = project.listRootSymbols();
  debugCli(`Workspace has ${symbols.length} root symbols`);

  const symbolInfos: (Symbol & { parentId?: StableSymbolId })[] = [];
  const addInfo = (s: Symbol) => {
    // Don't modify the symbol ID - keep the original file path
    // The workspace prefix will be handled in the output file path only
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

  const indexer = new TypescriptIndexer({
    nwc: nwcString,
    maxAmount: options.maxAmount,
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
    symbol: Symbol & { branch?: Symbol[] },
    projectPath: string,
    docsPath: string,
    indexer: TypescriptIndexer,
    fileCache: {
      currentFile: string;
      fileContent: string;
      existingDocSymbols: Map<string, any>;
    },
    options: {
      debug?: boolean;
      nwc?: string;
      name?: string;
      continue?: boolean;
      threads?: number;
      branch?: string;
      dir?: string;
      maxAmount?: number;
    }
  ): Promise<void> {
    // ======================================
    // NOTE: the file-caching is non-async and that's the
    // only reason it works with our multi-threaded symbol handler,
    // if async is introduced we'll have races with cache access

    // Check if we need to load a new file
    if (symbol.id.file !== fileCache.currentFile) {
      fileCache.currentFile = symbol.id.file;
      // The symbol.id.file is already relative to the workspace, so use it directly
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
            const content = fs.readFileSync(docsFile, "utf8");
            const lines = content.trim().split("\n");

            for (const line of lines) {
              if (line.trim()) {
                const docEntry = JSON.parse(line) as { type?: string };
                // Skip non-symbol entries (file summaries, etc.)
                if (docEntry.type && docEntry.type !== "symbol") continue;

                const docSymbol = docEntry as Symbol;
                fileCache.existingDocSymbols.set(docSymbol.id.hash, docSymbol);
                debugCli(
                  `Loaded existing documentation for symbol: ${docSymbol.id.name} (hash: ${docSymbol.id.hash})`
                );
              }
            }

            debugCli(
              `Loaded ${fileCache.existingDocSymbols.size} documented symbols from ${docsFile}`
            );
          } catch (error) {
            debugError(
              `Error reading existing doc file: ${(error as Error).message}`
            );
          }
        }
      }
    }

    debugCli(
      `Processing file ${symbol.id.file} code ${fileCache.fileContent.length} symbol ${symbol.id.name}...`
    );

    // If continue is enabled and this symbol is already documented, skip it
    if (options.continue && fileCache.existingDocSymbols.has(symbol.id.hash)) {
      debugCli(`Skipping already documented symbol: ${symbol.id.name} (hash: ${symbol.id.hash})`);
      return;
    }
    // sync section
    // ========================================================

    const docs = await indexer.processSymbol(
      symbol.id.file,
      fileCache.fileContent,
      symbol
    );
    console.log("docs: ", JSON.stringify(docs, null, 2));

    const info = {
      ...symbol,
      ...docs,
    };

    // Since each workspace has its own INDEXER_DIR, no need for workspace prefix
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
    existingDocSymbols: new Map<string, any>(),
  };

  // Get the number of threads (default to 1 if not specified)
  const numThreads = options.threads || 1;
  debugCli(`Processing with ${numThreads} parallel threads`);

  // Process symbols in parallel
  const activePromises: Promise<void>[] = [];
  let nextSymbolIndex = 0;

  // Helper function to process the next symbol
  const processNextSymbol = () => {
    if (nextSymbolIndex >= symbolInfos.length)
      throw new Error("No more symbols");

    const symbol = symbolInfos[nextSymbolIndex];
    nextSymbolIndex++;

    return processSymbolAsync(
      symbol,
      workspacePath,
      docsPath,
      indexer,
      fileCache,
      options
    ).catch((error) => {
      debugError(`Error processing symbol ${symbol.id.name}: ${error.message}`);
      // Re-throw to ensure Promise.race catches it
      throw error;
    });
  };

  // Initial filling of the active promises array
  while (
    activePromises.length < numThreads &&
    nextSymbolIndex < symbolInfos.length
  ) {
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

  debugCli(
    "Symbol processing complete. Starting file and directory summaries..."
  );

  // After all symbols are handled, produce per-file and per-dir summaries
  await processFileAndDirSummaries(
    workspacePath,
    docsPath,
    indexer,
    symbolInfos,
    options
  );

  debugCli("File and directory summaries complete.");
}

/**
 * Process file and directory summaries after symbol processing
 */
async function processFileAndDirSummaries(
  workspacePath: string,
  docsPath: string,
  indexer: TypescriptIndexer,
  symbolInfos: (Symbol & { parentId?: StableSymbolId })[],
  options: {
    debug?: boolean;
    nwc?: string;
    name?: string;
    continue?: boolean;
    threads?: number;
    branch?: string;
    dir?: string;
    maxAmount?: number;
  }
): Promise<void> {
  // Collect unique file names from all symbols
  const uniqueFiles = new Set<string>();
  const uniquePaths = new Set<string>();

  // Extract file paths from symbolInfos
  for (const symbol of symbolInfos) {
    if (symbol.id && symbol.id.file) {
      uniqueFiles.add(symbol.id.file);
    }
  }

  debugCli(`Found ${uniqueFiles.size} unique files from symbols`);

  // Always add the workspace root directory
  uniquePaths.add("/"); // Workspace root

  // Extract directory paths from file paths and add to the set
  for (const filePath of uniqueFiles) {
    uniquePaths.add(filePath); // Add the file itself

    // Add all parent directories
    let dirPath = path.dirname(filePath);
    while (dirPath !== "." && dirPath !== "/" && dirPath !== "") {
      uniquePaths.add(dirPath + "/"); // Add trailing / to distinguish dirs from files
      dirPath = path.dirname(dirPath);
    }
  }

  // Sort unique paths by length desc to process leaves of the tree first
  const sortedPaths = Array.from(uniquePaths).sort(
    (a, b) => b.length - a.length
  );
  debugCli(`Processing ${sortedPaths.length} paths (files and directories)`);

  // Process each path
  for (const pathItem of sortedPaths) {
    const isDirectory = pathItem.endsWith("/");
    const cleanPath = isDirectory ? pathItem.slice(0, -1) : pathItem;

    if (isDirectory) {
      await processDirectorySummary(
        workspacePath,
        docsPath,
        cleanPath,
        indexer,
        options
      );
    } else {
      await processFileSummary(
        workspacePath,
        docsPath,
        cleanPath,
        indexer,
        options
      );
    }
  }
}

/**
 * Process a single file summary
 */
async function processFileSummary(
  workspacePath: string,
  docsPath: string,
  filePath: string,
  indexer: TypescriptIndexer,
  options: { continue?: boolean }
): Promise<void> {
  const outputFile = path.join(docsPath, filePath + ".json");

  // Check if --continue option is given and file already has "type":"file" line
  if (options.continue && fs.existsSync(outputFile)) {
    try {
      const content = fs.readFileSync(outputFile, "utf8");
      if (content.includes('"type":"file"')) {
        debugCli(`Skipping file summary for ${filePath} (already exists)`);
        return;
      }
    } catch (error) {
      debugError(
        `Error checking existing file ${outputFile}: ${
          (error as Error).message
        }`
      );
    }
  }

  debugCli(`Processing file summary for: ${filePath}`);

  try {
    // Read the file content
    const fullFilePath = path.join(workspacePath, filePath);
    if (!fs.existsSync(fullFilePath)) {
      debugError(`File not found: ${fullFilePath}`);
      return;
    }

    const fileContent = fs.readFileSync(fullFilePath, "utf8");

    // Process the file with TypescriptIndexer
    const result = await indexer.processFile(filePath, fileContent);

    // Merge with metadata and write to output
    const fileDoc = {
      ...result,
      type: "file",
      path: filePath,
    };

    // Ensure the directory structure exists before writing
    const outputDir = path.dirname(outputFile);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.appendFileSync(outputFile, JSON.stringify(fileDoc) + "\n");
    debugCli(`File summary appended to: ${outputFile}`);
  } catch (error) {
    debugError(
      `Error processing file summary for ${filePath}: ${
        (error as Error).message
      }`
    );
  }
}

/**
 * Process a single directory summary
 */
async function processDirectorySummary(
  workspacePath: string,
  docsPath: string,
  dirPath: string,
  indexer: TypescriptIndexer,
  options: { continue?: boolean }
): Promise<void> {
  // Handle workspace root case where dirPath is "/"
  const normalizedDirPath = dirPath === "/" ? "" : dirPath;
  const outputFile = normalizedDirPath
    ? path.join(docsPath, normalizedDirPath, "summary.json")
    : path.join(docsPath, "summary.json");

  // Check if --continue option is given and summary.json already has "type":"dir" line
  if (options.continue && fs.existsSync(outputFile)) {
    try {
      const content = fs.readFileSync(outputFile, "utf8");
      if (content.includes('"type":"dir"')) {
        debugCli(`Skipping directory summary for ${dirPath} (already exists)`);
        return;
      }
    } catch (error) {
      debugError(
        `Error checking existing directory summary ${outputFile}: ${
          (error as Error).message
        }`
      );
    }
  }

  debugCli(`Processing directory summary for: ${dirPath}`);

  try {
    // Read all json files in the matching sub-dir in docsPath (1 level - no recursion)
    const dirDocsPath = normalizedDirPath
      ? path.join(docsPath, normalizedDirPath)
      : docsPath;
    const fileSummaries: any[] = [];

    if (fs.existsSync(dirDocsPath)) {
      const items = fs.readdirSync(dirDocsPath);
      for (const item of items) {
        const itemPath = path.join(dirDocsPath, item);
        const stats = fs.statSync(itemPath);

        if (
          stats.isFile() &&
          path.extname(itemPath) === ".json" &&
          item !== "summary.json"
        ) {
          try {
            const content = fs.readFileSync(itemPath, "utf8");
            const lines = content.trim().split("\n");

            for (const line of lines) {
              if (line.trim()) {
                const jsonData = JSON.parse(line);
                if (jsonData.type === "file") {
                  fileSummaries.push(jsonData);
                }
              }
            }
          } catch (error) {
            debugError(
              `Error reading file summary ${itemPath}: ${
                (error as Error).message
              }`
            );
          }
        } else if (stats.isDirectory()) {
          // Scan sub-dirs for summary.json files
          const subDirSummaryPath = path.join(itemPath, "summary.json");
          if (fs.existsSync(subDirSummaryPath)) {
            try {
              const content = fs.readFileSync(subDirSummaryPath, "utf8");
              const lines = content.trim().split("\n");

              for (const line of lines) {
                if (line.trim()) {
                  const jsonData = JSON.parse(line);
                  if (jsonData.type === "dir") {
                    fileSummaries.push(jsonData);
                  }
                }
              }
            } catch (error) {
              debugError(
                `Error reading directory summary ${subDirSummaryPath}: ${
                  (error as Error).message
                }`
              );
            }
          }
        }
      }
    }

    // Generate file tree for the source directory
    const sourceDirPath = normalizedDirPath
      ? path.join(workspacePath, normalizedDirPath)
      : workspacePath;
    let tree = "";
    if (fs.existsSync(sourceDirPath)) {
      const gitignorePath = path.join(workspacePath, ".gitignore");
      const gitignorePatterns = parseGitignore(gitignorePath);
      tree = generateFileTree(sourceDirPath, gitignorePatterns);
    }

    // Prepare summaries text
    const summariesText = fileSummaries
      .map((summary) => JSON.stringify(summary))
      .join("\n");

    // Process the directory with TypescriptIndexer
    const result = await indexer.processDir(dirPath, tree, summariesText);

    // Merge with metadata and write to output
    const dirDoc = {
      ...result,
      type: "dir",
      path: dirPath === "/" ? "/" : dirPath + "/",
    };

    // Ensure the directory structure exists before writing
    const outputDir = path.dirname(outputFile);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputFile, JSON.stringify(dirDoc) + "\n");
    debugCli(`Directory summary written to: ${outputFile}`);
  } catch (error) {
    debugError(
      `Error processing directory summary for ${dirPath}: ${
        (error as Error).message
      }`
    );
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
    .option(
      "-c, --continue",
      "Continue processing, skipping symbols that are already documented"
    )
    .option(
      "-t, --threads <number>",
      "Number of parallel processing threads",
      (value) => parseInt(value, 10),
      1
    )
    .option(
      "-b, --branch <string>",
      "Expected git branch (default: main)",
      "main"
    )
    .option(
      "--dir <string>",
      `Output directory for generated docs (default: ${INDEXER_DIR})`
    )
    .option(
      "--max-amount <sats>",
      "Maximum amount in sats to spend per symbol (default: 100)",
      (value) => parseInt(value, 10),
      100
    )
    .action(processProject);
}
