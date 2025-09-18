import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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
    throw new Error('File looks binary (contains NUL bytes).');
  }

  // strict UTF-8 validation (throws on any invalid sequence)
  const dec = new TextDecoder('utf-8', { fatal: true }); // fatal => throw on errors
  return dec.decode(buf);
}

/**
 * Create a Doc object for an always-included file
 * @param filePath - Relative path to the file from project root
 * @param content - File content
 * @param commitHash - Optional commit hash
 * @param workspaceRelativePath - Optional workspace relative path for monorepos
 * @returns Doc object
 */
function createAlwaysIncludedDoc(filePath: string, content: string, commitHash?: string, workspaceRelativePath?: string): Doc {
  const timestamp = Math.floor(Date.now() / 1000);
  
  // Create ID with workspace prefix for monorepos
  const baseId = createHash("sha256").update(`${filePath}:${content}`).digest("hex");
  const id = workspaceRelativePath ? `${workspaceRelativePath}:${baseId}` : baseId;
  
  let metadata = '';
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
    include: "always"
  };

  return doc;
}

/**
 * Process always-included files and write them as docs
 * @param packagePath - Path to the package
 * @param alwaysPaths - Array of file paths to always include
 * @param commitHash - Optional commit hash
 * @param outputFilePath - Optional output file path
 * @param outputDirPath - Optional output directory path
 * @param workspaceRelativePath - Optional workspace relative path for monorepos
 * @returns Number of processed files
 */
async function processAlwaysIncludedFiles(
  packagePath: string,
  alwaysPaths: string[],
  commitHash?: string,
  outputFilePath?: string,
  outputDirPath?: string,
  workspaceRelativePath?: string
): Promise<number> {
  let processedCount = 0;

  for (const relativePath of alwaysPaths) {
    const fullPath = path.join(packagePath, relativePath);
    
    try {
      if (!fs.existsSync(fullPath)) {
        debugError(`Always-included file not found: ${fullPath}`);
        continue;
      }

      if (!fs.statSync(fullPath).isFile()) {
        debugError(`Always-included path is not a file: ${fullPath}`);
        continue;
      }

      debugCli(`Processing always-included file: ${relativePath}`);
      
      const content = readFileAsUtf8(fullPath);
      const doc = createAlwaysIncludedDoc(relativePath, content, commitHash, workspaceRelativePath);

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

      processedCount++;
    } catch (error) {
      debugError(`Error processing always-included file ${relativePath}: ${(error as Error).message}`);
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
  
  const content = fs.readFileSync(gitignorePath, 'utf8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

/**
 * Check if a file path should be ignored based on gitignore patterns
 * @param filePath - Relative file path from project root
 * @param patterns - Array of gitignore patterns
 * @returns True if file should be ignored
 */
function shouldIgnoreFile(filePath: string, patterns: string[]): boolean {
  // Always ignore these directories
  const alwaysIgnore = ['node_modules', '.askexperts', '.git'];
  
  for (const ignore of alwaysIgnore) {
    if (filePath.includes(ignore)) {
      return true;
    }
  }
  
  // Check gitignore patterns
  for (const pattern of patterns) {
    // Simple pattern matching - handle basic cases
    if (pattern.endsWith('/')) {
      // Directory pattern
      const dirPattern = pattern.slice(0, -1);
      if (filePath.startsWith(dirPattern + '/') || filePath === dirPattern) {
        return true;
      }
    } else if (pattern.includes('*')) {
      // Wildcard pattern - basic implementation
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      if (regex.test(filePath)) {
        return true;
      }
    } else {
      // Exact match
      if (filePath === pattern || filePath.startsWith(pattern + '/')) {
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
  prefix: string = '',
  isLast: boolean = true,
  relativePath: string = ''
): string {
  let result = '';
  
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(item => {
        const itemRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name;
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
      const connector = isLastItem ? '└── ' : '├── ';
      const itemRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name;
      
      result += `${prefix}${connector}${item.name}\n`;
      
      if (item.isDirectory()) {
        const newPrefix = prefix + (isLastItem ? '    ' : '│   ');
        const itemPath = path.join(dirPath, item.name);
        result += generateFileTree(itemPath, gitignorePatterns, newPrefix, isLastItem, itemRelativePath);
      }
    });
  } catch (error) {
    debugError(`Error reading directory ${dirPath}: ${(error as Error).message}`);
  }
  
  return result;
}

/**
 * Create a synthetic document containing the project file tree
 * @param packagePath - Path to the package root
 * @param workspaceRelativePath - Optional workspace relative path for monorepos
 * @returns Doc object for the project files
 */
function createProjectFilesDoc(packagePath: string, workspaceRelativePath?: string): Doc {
  const timestamp = Math.floor(Date.now() / 1000);
  
  // Parse gitignore
  const gitignorePath = path.join(packagePath, '.gitignore');
  const gitignorePatterns = parseGitignore(gitignorePath);
  
  // Generate file tree
  const projectName = path.basename(packagePath);
  let fileTree = `${projectName}/\n`;
  fileTree += generateFileTree(packagePath, gitignorePatterns);
  
  // Create document ID with workspace prefix for monorepos
  const baseId = `${packagePath}:project-files`;
  const id = workspaceRelativePath ? `${workspaceRelativePath}:project-files` : baseId;
  
  let metadata = '';
  if (workspaceRelativePath) {
    metadata += `workspace: ${workspaceRelativePath}\n`;
  }
  metadata += 'project files';
  
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
    include: "always"
  };
  
  return doc;
}

/**
 * Create a workspace-aware version of symbolToDoc with modified metadata
 */
function symbolToDocWithWorkspace(
  symbolInfo: DocSymbol,
  symbolInfos: DocSymbol[],
  typescript: TypeScript,
  commitHash?: string,
  workspaceRelativePath?: string
): Doc {
  // Get the original doc
  const doc = symbolToDoc(symbolInfo, symbolInfos, typescript, commitHash);
  
  // Modify metadata to include workspace and symbol ID
  let metadata = '';
  if (workspaceRelativePath) {
    metadata += `workspace: ${workspaceRelativePath}\n`;
  }
  metadata += `file: ${symbolInfo.id.file}\n`;
  metadata += `lines: ${symbolInfo.start.split(":")[0]}:${symbolInfo.end.split(":")[0]}\n`;
  metadata += `id: ${symbolInfo.id.hash}`;
  if (commitHash) {
    metadata += `\ncommit: ${commitHash}`;
  }
  
  // Modify doc ID for monorepos
  const newId = workspaceRelativePath ? `${workspaceRelativePath}:${symbolInfo.id.hash}` : symbolInfo.id.hash;
  
  return {
    ...doc,
    id: newId,
    metadata
  };
}

/**
 * Process JSON files in the INDEXER_DIR directory and convert to docs
 *
 * @param packagePath - Path to the package containing INDEXER_DIR
 * @param options - Command options
 */
async function processDocs(
  packagePath: string,
  options: { debug?: boolean; output?: string; dir?: string; always?: string[]; docs?: string }
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

    // Check if this is a monorepo with workspaces
    const workspaces = extractWorkspaces(absolutePath);
    
    if (workspaces.length > 0) {
      debugCli(`Found ${workspaces.length} workspaces in monorepo`);
      // Process each workspace
      for (const workspace of workspaces) {
        debugCli(`Processing workspace: ${workspace.name || workspace.path}`);
        await processWorkspace(workspace.path, absolutePath, outputFilePath, outputDirPath, options);
      }
    } else {
      // Process as a single package
      debugCli(`Processing as single package`);
      await processWorkspace(absolutePath, absolutePath, outputFilePath, outputDirPath, options);
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
  options?: { debug?: boolean; output?: string; dir?: string; always?: string[]; docs?: string }
): Promise<void> {
  const workspaceRelativePath = path.relative(rootProjectPath, workspacePath);
  const isMonorepo = workspaceRelativePath !== '';
  
  // Check if tsconfig.json exists in the workspace
  const tsconfigPath = path.join(workspacePath, 'tsconfig.json');
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

  // Read commit hash from commit.git file
  const commitFilePath = path.join(docsPath, "commit.git");
  let commitHash: string | undefined;
  if (fs.existsSync(commitFilePath)) {
    commitHash = fs.readFileSync(commitFilePath, "utf8").trim();
    debugCli(`Found commit hash: ${commitHash}`);
  } else {
    debugCli("No commit.git file found, proceeding without commit hash");
  }

  debugCli(`Looking for JSON files in: ${docsPath}`);

  const typescript = new TypeScript(workspacePath);

  // Handle always-included files
  const alwaysPaths = options?.always && options.always.length > 0
    ? options.always
    : ["package.json", "tsconfig.json", "README.md"];
  
  debugCli(`Processing always-included files: ${alwaysPaths.join(", ")}`);
  
  const alwaysProcessedCount = await processAlwaysIncludedFiles(
    workspacePath,
    alwaysPaths,
    commitHash,
    outputFilePath,
    outputDirPath,
    isMonorepo ? workspaceRelativePath : undefined
  );

  debugCli(`Processed ${alwaysProcessedCount} always-included files`);

  // Create and process the synthetic project files document
  debugCli(`Creating synthetic project files document`);
  const projectFilesDoc = createProjectFilesDoc(workspacePath, isMonorepo ? workspaceRelativePath : undefined);
  
  if (outputFilePath) {
    // Append the project files doc to the output file
    fs.appendFileSync(
      outputFilePath,
      "=========================\n" +
        projectFilesDoc.metadata +
        "\n" +
        projectFilesDoc.data +
        "\n\n"
    );
  }

  if (outputDirPath) {
    // Write the project files doc to a separate file using hash of doc.id for filename
    const fileNameHash = createHash("sha256").update(projectFilesDoc.id).digest("hex");
    const docFilePath = path.join(outputDirPath, `${fileNameHash}.aedoc`);
    fs.writeFileSync(docFilePath, JSON.stringify(projectFilesDoc, null, 2));
  }

  debugCli(`Created synthetic project files document`);

  // Track statistics
  let processedFiles = 0;
  let processedLines = 0;

  // Recursively process all JSON files in the INDEXER_DIR directory
  const processDirectory = async (dirPath: string) => {
    const items = fs.readdirSync(dirPath);

    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stats = fs.statSync(itemPath);

      if (stats.isDirectory()) {
        // Recursively process subdirectories
        await processDirectory(itemPath);
      } else if (stats.isFile() && path.extname(itemPath) === ".json") {
        // Process JSON files
        debugCli(`Processing file: ${itemPath}`);

        try {
          const content = fs.readFileSync(itemPath, "utf8");
          const lines = content.trim().split("\n");
          const symbolInfos: DocSymbol[] = [];
          for (const line of lines) {
            if (!line.trim()) continue;
            const symbolInfo = JSON.parse(line) as DocSymbol;
            symbolInfos.push(symbolInfo);
          }

          for (const symbolInfo of symbolInfos) {
            const doc = symbolToDocWithWorkspace(
              symbolInfo,
              symbolInfos,
              typescript,
              commitHash,
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

            processedLines++;

            if (processedLines % 100 === 0) {
              debugCli(`Processed ${processedLines} lines so far...`);
            }
          }

          processedFiles++;
        } catch (error) {
          debugError(
            `Error processing file ${itemPath}: ${(error as Error).message}`
          );
        }
      }
    }
  };

  // Start processing
  await processDirectory(docsPath);

  debugCli(`Workspace preparation complete.`);
  debugCli(`Processed ${alwaysProcessedCount} always-included files and ${processedFiles} JSON files with ${processedLines} lines.`);
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
    .argument(`<package_path>", "Path to the package containing '${INDEXER_DIR}'`)
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
      "--docs <path>",
      "Path to the docs directory (relative to current working directory). If not specified, uses <package_path>/.askexperts"
    )
    .action(processDocs);
}
