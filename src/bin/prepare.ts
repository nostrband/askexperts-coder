import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { Command } from "commander";
import { debugCli, debugError, enableDebugAll } from "../utils/debug.js";
import { TypeScript } from "../indexer/typescript/TypeScript.js";
import { INDEXER_DIR } from "./index.js";
import { DocSymbol, symbolToDoc } from "../utils/docstore.js";
import { Doc } from "askexperts/docstore";
import { extractWorkspaces } from "../utils/workspace.js";

/**
 * Read a file and validate it's UTF-8 encoded
 * @param filePath - Path to the file to read
 * @returns File content as string
 * @throws Error if file cannot be read as UTF-8
 */
function readFileAsUtf8(filePath: string): string {
  const buf = fs.readFileSync(filePath);

  // quick binary test: any NUL bytes
  if (buf.includes(0x00)) {
    throw new Error("File looks binary (contains NUL bytes).");
  }

  // strict UTF-8 validation (throws on any invalid sequence)
  const dec = new TextDecoder("utf-8", { fatal: true }); // fatal => throw on errors
  return dec.decode(buf);
}

/**
 * Get the current commit hash from git
 * @param projectPath - Path to the project root
 * @returns Current commit hash or undefined if not in a git repository
 */
function getCurrentCommitHash(projectPath: string): string | undefined {
  try {
    const result = execSync("git rev-parse HEAD", {
      cwd: projectPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.trim();
  } catch (error) {
    debugError(
      `Failed to get current commit hash: ${(error as Error).message}`
    );
    return undefined;
  }
}

/**
 * Create a Doc object for an included file
 * @param filePath - Relative path to the file from project root
 * @param content - File content
 * @param always - Whether to mark as 'include: always'
 * @param commitHash - Optional commit hash
 * @param workspaceRelativePath - Optional workspace relative path for monorepos
 * @returns Doc object
 */
function createIncludedDoc(
  filePath: string,
  content: string,
  always?: boolean,
  commitHash?: string,
  workspaceRelativePath?: string
): Doc {
  const timestamp = Math.floor(Date.now() / 1000);

  // Create ID with workspace prefix for monorepos
  const baseId = createHash("sha256")
    .update(`${filePath}:${content}`)
    .digest("hex");
  const id = workspaceRelativePath
    ? `${workspaceRelativePath}:${baseId}`
    : baseId;

  let metadata = "type: file\n";
  if (workspaceRelativePath) {
    metadata += `workspace: ${workspaceRelativePath}\n`;
  }
  metadata += `file: ${filePath}`;
  if (commitHash) {
    metadata += `\ncommit: ${commitHash}`;
  }

  const doc: Doc = {
    id,
    docstore_id: "", // This will be set when the document is added to a docstore
    timestamp,
    created_at: timestamp,
    type: "file",
    data: content,
    metadata,
    embeddings: [],
    related_ids: [],
  };

  // Add 'include: always' only if always flag is true
  if (always) {
    doc.include = "always";
  }

  return doc;
}

/**
 * Expand file masks (like "*.md") to actual file paths
 * @param basePath - Base path to search from
 * @param pattern - File pattern (can be exact path or mask like "*.md")
 * @returns Array of matching file paths relative to basePath
 */
function expandFileMask(basePath: string, pattern: string): string[] {
  // If pattern doesn't contain wildcards, treat as exact path
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return [pattern];
  }

  const results: string[] = [];

  try {
    // Simple glob implementation for basic patterns like "*.md"
    if (pattern.startsWith("*.")) {
      const extension = pattern.slice(1); // Remove the '*'
      const scanDirectory = (dirPath: string, relativePath: string = "") => {
        const items = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const item of items) {
          const itemPath = path.join(dirPath, item.name);
          const itemRelativePath = relativePath
            ? `${relativePath}/${item.name}`
            : item.name;

          if (item.isFile() && item.name.endsWith(extension)) {
            results.push(itemRelativePath);
          } else if (
            item.isDirectory() &&
            !shouldIgnoreFile(itemRelativePath, [])
          ) {
            // Recursively scan subdirectories, but skip ignored ones
            scanDirectory(itemPath, itemRelativePath);
          }
        }
      };

      scanDirectory(basePath);
    } else {
      // For more complex patterns, we could add more sophisticated glob matching
      // For now, just treat as exact path
      results.push(pattern);
    }
  } catch (error) {
    debugError(
      `Error expanding file mask "${pattern}": ${(error as Error).message}`
    );
  }

  return results;
}

/**
 * Handle included files (both always and include) for a given path (root or workspace)
 * @param basePath - Base path to resolve files from (root or workspace path)
 * @param rootProjectPath - Root project path for resolving --always and --include options
 * @param alwaysOptions - Array of --always paths provided by user (relative to root)
 * @param includeOptions - Array of --include paths provided by user (relative to root)
 * @param useDefaults - Whether to include default files
 * @param commitHash - Optional commit hash
 * @param outputFilePath - Optional output file path
 * @param outputDirPath - Optional output directory path
 * @param workspaceRelativePath - Optional workspace relative path for monorepos
 * @returns Number of processed files
 */
async function handleIncludedFiles(
  basePath: string,
  rootProjectPath: string,
  alwaysOptions: string[],
  includeOptions: string[],
  useDefaults: boolean,
  commitHash?: string,
  outputFilePath?: string,
  outputDirPath?: string,
  workspaceRelativePath?: string
): Promise<number> {
  let processedCount = 0;

  // Determine which files to process for --always
  let alwaysFilesToProcess: string[] = [];

  if (alwaysOptions.length > 0) {
    // User provided --always options, use them (they are relative to root)
    alwaysFilesToProcess = alwaysOptions.map((alwaysPath) => {
      // Convert root-relative path to basePath-relative path
      const absoluteAlwaysPath = path.resolve(rootProjectPath, alwaysPath);
      return path.relative(basePath, absoluteAlwaysPath);
    });
  } else if (useDefaults) {
    // Use default always files - changed from "*.md" to "README.md"
    alwaysFilesToProcess = [
      "package.json",
      "deno.json",
      "tsconfig.json",
      "README.md",
    ];
  }

  // Determine which files to process for --include
  let includeFilesToProcess: string[] = [];

  if (includeOptions.length > 0) {
    // User provided --include options, use them (they are relative to root)
    includeFilesToProcess = includeOptions.map((includePath) => {
      // Convert root-relative path to basePath-relative path
      const absoluteIncludePath = path.resolve(rootProjectPath, includePath);
      return path.relative(basePath, absoluteIncludePath);
    });
  } else if (useDefaults) {
    // Use default include files - "*.md"
    includeFilesToProcess = ["*.md"];
  }

  // Expand any file masks in both lists
  const expandedAlwaysFiles: string[] = [];
  for (const filePattern of alwaysFilesToProcess) {
    const expandedPaths = expandFileMask(basePath, filePattern);
    expandedAlwaysFiles.push(...expandedPaths);
  }

  const expandedIncludeFiles: string[] = [];
  for (const filePattern of includeFilesToProcess) {
    const expandedPaths = expandFileMask(basePath, filePattern);
    expandedIncludeFiles.push(...expandedPaths);
  }

  // Create sets of files for various checks
  const alwaysFilesSet = new Set(expandedAlwaysFiles);
  const includeFilesSet = new Set(expandedIncludeFiles);

  // Combine files, ensuring --always takes precedence over --include
  const allFilesToProcess = [...expandedAlwaysFiles];
  for (const includeFile of expandedIncludeFiles) {
    if (!alwaysFilesSet.has(includeFile)) {
      allFilesToProcess.push(includeFile);
    }
  }

  for (const relativePath of allFilesToProcess) {
    const fullPath = path.resolve(basePath, relativePath);

    try {
      if (!fs.existsSync(fullPath)) {
        if (
          (alwaysFilesSet.has(relativePath) && alwaysOptions.length > 0) ||
          (includeFilesSet.has(relativePath) && includeOptions.length > 0)
        )
          debugError(`Included file not found: ${fullPath}`);
        continue;
      }

      if (!fs.statSync(fullPath).isFile()) {
        debugError(`Included path is not a file: ${fullPath}`);
        continue;
      }

      const isAlwaysFile = alwaysFilesSet.has(relativePath);
      debugCli(
        `Processing ${
          isAlwaysFile ? "always-included" : "included"
        } file: ${relativePath}`
      );

      const content = readFileAsUtf8(fullPath);
      // Always use path relative to project root for metadata
      const metadataPath = path.relative(rootProjectPath, fullPath);
      const doc = createIncludedDoc(
        metadataPath,
        content,
        isAlwaysFile,
        commitHash,
        workspaceRelativePath
      );

      if (outputFilePath) {
        // Append the line to the output file
        fs.appendFileSync(
          outputFilePath,
          "=========================\n" +
            doc.metadata +
            (doc.include ? "\ninclude: always" : "") +
            "\n" +
            doc.data +
            "\n\n"
        );
      }

      if (outputDirPath) {
        // Write each doc to a separate file using hash of doc.id for filename
        const fileNameHash = createHash("sha256").update(doc.id).digest("hex");
        const docFilePath = path.join(outputDirPath, `${fileNameHash}.aedoc`);
        fs.writeFileSync(docFilePath, JSON.stringify(doc, null, 2));
      }

      processedCount++;
    } catch (error) {
      debugError(
        `Error processing always-included file ${relativePath}: ${
          (error as Error).message
        }`
      );
      throw error; // Re-throw to stop processing as requested
    }
  }

  return processedCount;
}

/**
 * Parse .gitignore file and return patterns
 * @param gitignorePath - Path to .gitignore file
 * @returns Array of gitignore patterns
 */
function parseGitignore(gitignorePath: string): string[] {
  if (!fs.existsSync(gitignorePath)) {
    return [];
  }

  const content = fs.readFileSync(gitignorePath, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * Check if a file path should be ignored based on gitignore patterns
 * @param filePath - Relative file path from project root
 * @param patterns - Array of gitignore patterns
 * @returns True if file should be ignored
 */
function shouldIgnoreFile(filePath: string, patterns: string[]): boolean {
  // Always ignore these directories
  const alwaysIgnore = ["node_modules", ".askexperts", ".git"];

  for (const ignore of alwaysIgnore) {
    if (filePath.includes(ignore)) {
      return true;
    }
  }

  // Check gitignore patterns
  for (const pattern of patterns) {
    // Simple pattern matching - handle basic cases
    if (pattern.endsWith("/")) {
      // Directory pattern
      const dirPattern = pattern.slice(0, -1);
      if (filePath.startsWith(dirPattern + "/") || filePath === dirPattern) {
        return true;
      }
    } else if (pattern.includes("*")) {
      // Wildcard pattern - basic implementation
      const regex = new RegExp(pattern.replace(/\*/g, ".*"));
      if (regex.test(filePath)) {
        return true;
      }
    } else {
      // Exact match
      if (filePath === pattern || filePath.startsWith(pattern + "/")) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Generate a file tree string with |- formatting
 * @param dirPath - Directory path to scan
 * @param gitignorePatterns - Array of gitignore patterns
 * @param prefix - Current prefix for tree formatting
 * @param isLast - Whether this is the last item in current level
 * @param relativePath - Relative path from project root
 * @returns Tree string representation
 */
function generateFileTree(
  dirPath: string,
  gitignorePatterns: string[],
  prefix: string = "",
  isLast: boolean = true,
  relativePath: string = ""
): string {
  let result = "";

  try {
    const items = fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((item) => {
        const itemRelativePath = relativePath
          ? `${relativePath}/${item.name}`
          : item.name;
        return !shouldIgnoreFile(itemRelativePath, gitignorePatterns);
      })
      .sort((a, b) => {
        // Directories first, then files, both alphabetically
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    items.forEach((item, index) => {
      const isLastItem = index === items.length - 1;
      const connector = isLastItem ? "└── " : "├── ";
      const itemRelativePath = relativePath
        ? `${relativePath}/${item.name}`
        : item.name;

      result += `${prefix}${connector}${item.name}\n`;

      if (item.isDirectory()) {
        const newPrefix = prefix + (isLastItem ? "    " : "│   ");
        const itemPath = path.join(dirPath, item.name);
        result += generateFileTree(
          itemPath,
          gitignorePatterns,
          newPrefix,
          isLastItem,
          itemRelativePath
        );
      }
    });
  } catch (error) {
    debugError(
      `Error reading directory ${dirPath}: ${(error as Error).message}`
    );
  }

  return result;
}

/**
 * Create a synthetic document containing the project file tree
 * @param packagePath - Path to the package root
 * @param workspaceRelativePath - Optional workspace relative path for monorepos
 * @returns Doc object for the project files
 */
function createProjectFilesDoc(
  packagePath: string,
  workspaceRelativePath?: string,
  commitHash?: string
): Doc {
  const timestamp = Math.floor(Date.now() / 1000);

  // Parse gitignore
  const gitignorePath = path.join(packagePath, ".gitignore");
  const gitignorePatterns = parseGitignore(gitignorePath);

  // Generate file tree
  const projectName = path.basename(packagePath);
  let fileTree = `${projectName}/\n`;
  fileTree += generateFileTree(packagePath, gitignorePatterns);

  // Create document ID with workspace prefix for monorepos
  const baseId = `${packagePath}:project_files`;
  const id = workspaceRelativePath
    ? `${workspaceRelativePath}:project_files`
    : baseId;

  let metadata = "type: project_files\n";
  if (workspaceRelativePath) {
    metadata += `workspace: ${workspaceRelativePath}\n`;
  }
  if (commitHash) {
    metadata += `commit: ${commitHash}\n`;
  }

  const doc: Doc = {
    id,
    docstore_id: "", // This will be set when the document is added to a docstore
    timestamp,
    created_at: timestamp,
    type: "project_files",
    data: fileTree,
    metadata,
    embeddings: [],
    related_ids: [],
    include: "always",
  };

  return doc;
}

/**
 * Process JSON files in the INDEXER_DIR directory and convert to docs
 *
 * @param packagePath - Path to the package containing INDEXER_DIR
 * @param options - Command options
 */
async function processDocs(
  packagePath: string,
  options: {
    debug?: boolean;
    output?: string;
    dir?: string;
    always?: string[];
    include?: string[];
    docs?: string;
  }
): Promise<void> {
  // Enable debug output if debug flag is set
  if (options.debug) {
    enableDebugAll();
  }

  try {
    // Resolve the package path to an absolute path
    const absolutePath = path.resolve(process.cwd(), packagePath);

    // Check if the directory exists
    if (!fs.existsSync(absolutePath)) {
      debugError(`Package directory not found at path: ${absolutePath}`);
      process.exit(1);
    }

    // Check if the path is a directory
    if (!fs.statSync(absolutePath).isDirectory()) {
      debugError(`The path ${absolutePath} is not a directory`);
      process.exit(1);
    }

    // Check if either output or dir option is provided
    if (!options.output && !options.dir) {
      debugError("Either --output or --dir option must be specified");
      process.exit(1);
    }

    // Prepare output file path if output option is provided
    const outputFilePath = options.output
      ? path.resolve(process.cwd(), options.output)
      : undefined;

    // Prepare directory path if dir option is provided
    const outputDirPath = options.dir
      ? path.resolve(process.cwd(), options.dir)
      : undefined;

    // Create output directory if it doesn't exist
    if (outputDirPath && !fs.existsSync(outputDirPath)) {
      fs.mkdirSync(outputDirPath, { recursive: true });
    }

    // Get current commit hash from git
    const currentCommitHash = getCurrentCommitHash(absolutePath);
    if (!currentCommitHash) {
      debugError(
        "Failed to get current commit hash. Make sure you're in a git repository."
      );
      process.exit(1);
    }
    debugCli(`Current commit hash: ${currentCommitHash}`);

    // Handle included files (both always and include) for the root project first
    debugCli(`Processing included files for project root`);
    const rootIncludedCount = await handleIncludedFiles(
      absolutePath,
      absolutePath,
      options.always || [],
      options.include || [],
      true, // use defaults for root
      currentCommitHash, // use current commit hash
      outputFilePath,
      outputDirPath,
      undefined // no workspace path for root
    );
    debugCli(`Processed ${rootIncludedCount} included files for project root`);

    // Create and process the synthetic project files document for the entire project
    debugCli(`Creating synthetic project files document for entire project`);
    const projectFilesDoc = createProjectFilesDoc(
      absolutePath,
      undefined,
      currentCommitHash
    );

    if (outputFilePath) {
      // Append the project files doc to the output file
      fs.appendFileSync(
        outputFilePath,
        "=========================\n" +
          projectFilesDoc.metadata +
          (projectFilesDoc.include ? "\ninclude: always" : "") +
          "\n" +
          projectFilesDoc.data +
          "\n\n"
      );
    }

    if (outputDirPath) {
      // Write the project files doc to a separate file using hash of doc.id for filename
      const fileNameHash = createHash("sha256")
        .update(projectFilesDoc.id)
        .digest("hex");
      const docFilePath = path.join(outputDirPath, `${fileNameHash}.aedoc`);
      fs.writeFileSync(docFilePath, JSON.stringify(projectFilesDoc, null, 2));
    }

    debugCli(`Created synthetic project files document for entire project`);

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
          outputFilePath,
          outputDirPath,
          options,
          currentCommitHash
        );
      }
    } else {
      // Process as a single package
      debugCli(`Processing as single package`);
      await processWorkspace(
        absolutePath,
        absolutePath,
        outputFilePath,
        outputDirPath,
        options,
        currentCommitHash
      );
    }
  } catch (error) {
    debugError(`Error preparing files: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Process a single workspace
 */
async function processWorkspace(
  workspacePath: string,
  rootProjectPath: string,
  outputFilePath?: string,
  outputDirPath?: string,
  options?: {
    debug?: boolean;
    output?: string;
    dir?: string;
    always?: string[];
    include?: string[];
    docs?: string;
  },
  currentCommitHash?: string
): Promise<void> {
  const workspaceRelativePath = path.relative(rootProjectPath, workspacePath);
  const isMonorepo = workspaceRelativePath !== "";

  // Check if tsconfig.json exists in the workspace
  const tsconfigPath = path.join(workspacePath, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    debugCli(`Skipping workspace ${workspacePath}: no tsconfig.json found`);
    return;
  }

  debugCli(`Processing workspace at: ${workspacePath}`);

  // Determine docs path - either from --docs option or default to workspacePath/INDEXER_DIR
  const docsPath = options?.docs
    ? path.resolve(process.cwd(), options.docs)
    : path.join(workspacePath, INDEXER_DIR);

  if (!fs.existsSync(docsPath)) {
    const pathDescription = options?.docs
      ? `Custom docs directory not found at: ${docsPath}`
      : `${INDEXER_DIR} directory not found at: ${docsPath}`;
    debugError(pathDescription);
    return; // Skip this workspace instead of exiting
  }

  // Read commit hash from commit.git file and validate it matches current commit
  const commitFilePath = path.join(docsPath, "commit.git");
  let docsCommitHash: string | undefined;
  if (fs.existsSync(commitFilePath)) {
    docsCommitHash = fs.readFileSync(commitFilePath, "utf8").trim();
    debugCli(`Found docs commit hash: ${docsCommitHash}`);

    // Validate that docs commit hash matches current commit hash
    if (currentCommitHash && docsCommitHash !== currentCommitHash) {
      debugError(
        `Commit hash mismatch! Current commit: ${currentCommitHash}, Docs commit: ${docsCommitHash}`
      );
      debugError(
        "The generated docs are from a different commit than the current files."
      );
      debugError("Please regenerate the docs or checkout the correct commit.");
      process.exit(1);
    }
  } else {
    debugCli(
      "No commit.git file found, proceeding without docs commit hash validation"
    );
  }

  debugCli(`Looking for JSON files in: ${docsPath}`);

  const typescript = new TypeScript(workspacePath);

  // Handle included files only if --always and --include options weren't provided
  // (if they were provided, they were already handled at the root level)
  let includedProcessedCount = 0;
  if (
    (!options?.always || options.always.length === 0) &&
    (!options?.include || options.include.length === 0)
  ) {
    debugCli(`Processing default included files for workspace`);
    includedProcessedCount = await handleIncludedFiles(
      workspacePath,
      rootProjectPath,
      [], // no --always options
      [], // no --include options
      true, // use defaults
      currentCommitHash, // use current commit hash for consistency
      outputFilePath,
      outputDirPath,
      isMonorepo ? workspaceRelativePath : undefined
    );
    debugCli(`Processed ${includedProcessedCount} included files`);
  } else {
    debugCli(`Skipping workspace included files (handled at root level)`);
  }

  // Note: project_files doc is now created at project root level, not per workspace

  // Track statistics
  let processedSymbols = 0;
  let foundSymbols = 0;
  let missingSymbols = 0;

  // Get all symbols from TypeScript analysis
  debugCli(`Getting all symbols from TypeScript analysis...`);
  const allSymbols = typescript.listAllSymbols();
  debugCli(`Found ${allSymbols.length} symbols from TypeScript analysis`);

  // Create a map of all available DocSymbols from JSON files for quick lookup
  const docSymbolMap = new Map<
    string,
    { symbolInfo: DocSymbol; allSymbolInfos: DocSymbol[] }
  >();

  // Recursively scan all JSON files to build the map
  const scanJsonFiles = (dirPath: string) => {
    if (!fs.existsSync(dirPath)) return;

    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stats = fs.statSync(itemPath);

      if (stats.isDirectory()) {
        scanJsonFiles(itemPath);
      } else if (stats.isFile() && path.extname(itemPath) === ".json") {
        try {
          const content = fs.readFileSync(itemPath, "utf8");
          const lines = content.trim().split("\n");
          const symbolInfos: DocSymbol[] = [];

          for (const line of lines) {
            if (!line.trim()) continue;
            const symbolInfo = JSON.parse(line) as DocSymbol;
            symbolInfos.push(symbolInfo);
          }

          // Add each symbol to the map using its hash as key
          for (const symbolInfo of symbolInfos) {
            if (symbolInfo.id && symbolInfo.id.hash) {
              docSymbolMap.set(symbolInfo.id.hash, {
                symbolInfo,
                allSymbolInfos: symbolInfos,
              });
            }
          }
        } catch (error) {
          debugError(
            `Error reading JSON file ${itemPath}: ${(error as Error).message}`
          );
        }
      }
    }
  };

  debugCli(`Scanning JSON files in: ${docsPath}`);
  scanJsonFiles(docsPath);
  debugCli(`Found ${docSymbolMap.size} symbols in JSON files`);

  // Process each symbol from TypeScript analysis
  for (const symbol of allSymbols) {
    processedSymbols++;

    if (processedSymbols % 100 === 0) {
      debugCli(
        `Processed ${processedSymbols}/${allSymbols.length} symbols so far...`
      );
    }

    // Look for matching DocSymbol in JSON files
    const symbolHash = symbol.id.hash;
    const docSymbolEntry = docSymbolMap.get(symbolHash);

    if (!docSymbolEntry) {
      debugError(
        `Symbol not found in JSON files: ${symbol.id.name} (${symbol.id.kind}) in ${symbol.id.file} - hash: ${symbolHash}`
      );
      missingSymbols++;
      continue;
    }

    foundSymbols++;
    const { symbolInfo, allSymbolInfos } = docSymbolEntry;

    try {
      const doc = symbolToDoc(
        symbolInfo,
        allSymbolInfos,
        typescript,
        docsCommitHash, // use docs commit hash for symbol docs (they were generated from that commit)
        isMonorepo ? workspaceRelativePath : undefined
      );

      if (outputFilePath) {
        // Append the line to the output file
        fs.appendFileSync(
          outputFilePath,
          "=========================\n" +
            doc.metadata +
            "\n" +
            doc.data +
            "\n\n"
        );
      }

      if (outputDirPath) {
        // Write each doc to a separate file using hash of doc.id for filename
        const fileNameHash = createHash("sha256").update(doc.id).digest("hex");
        const docFilePath = path.join(outputDirPath, `${fileNameHash}.aedoc`);
        fs.writeFileSync(docFilePath, JSON.stringify(doc, null, 2));
      }
    } catch (error) {
      debugError(
        `Error processing symbol ${symbolInfo.id.name}: ${
          (error as Error).message
        }`
      );
    }
  }

  debugCli(`Workspace preparation complete.`);
  debugCli(
    `Processed ${includedProcessedCount} included files and ${processedSymbols} symbols (${foundSymbols} found, ${missingSymbols} missing).`
  );
}

/**
 * Register the 'import' command to the provided commander instance
 *
 * @param program - Commander instance to register the command to
 */
export function registerPrepareCommand(program: Command): void {
  program
    .command("prepare")
    .description(
      `Convert generated docs from '${INDEXER_DIR}' subdir to docstore format`
    )
    .argument(
      `<package_path>", "Path to the package containing '${INDEXER_DIR}'`
    )
    .option("-d, --debug", "Enable debug output")
    .option(
      "-o, --output <file>",
      "Output file path to write combined doc content"
    )
    .option(
      "--dir <directory>",
      "Directory to write individual doc files as JSON"
    )
    .option(
      "--always <path>",
      "Sub-paths from the project to be included into the docs and marked as 'include=\"always\"' (can be specified multiple times)",
      (value: string, previous: string[] = []) => {
        return [...previous, value];
      },
      []
    )
    .option(
      "--include <path>",
      "Sub-paths from the project to be included into the docs (can be specified multiple times)",
      (value: string, previous: string[] = []) => {
        return [...previous, value];
      },
      []
    )
    .option(
      "--docs <path>",
      "Path to the docs directory (relative to current working directory). If not specified, uses <package_path>/.askexperts"
    )
    .action(processDocs);
}
