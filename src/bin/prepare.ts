import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Command } from "commander";
import { debugCli, debugError, enableDebugAll } from "../utils/debug.js";
import { TypeScript } from "../indexer/typescript/TypeScript.js";
import { INDEXER_DIR } from "./index.js";
import { DocSymbol, symbolToDoc } from "../utils/docstore.js";
import { Doc } from "askexperts/docstore";

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
 * @returns Doc object
 */
function createAlwaysIncludedDoc(filePath: string, content: string, commitHash?: string): Doc {
  const timestamp = Math.floor(Date.now() / 1000);
  const id = createHash("sha256").update(`${filePath}:${content}`).digest("hex");
  
  let metadata = `file: ${filePath}`;
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
 * @returns Number of processed files
 */
async function processAlwaysIncludedFiles(
  packagePath: string,
  alwaysPaths: string[],
  commitHash?: string,
  outputFilePath?: string,
  outputDirPath?: string
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
      const doc = createAlwaysIncludedDoc(relativePath, content, commitHash);

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
        // Write each doc to a separate file
        const docFilePath = path.join(outputDirPath, `${doc.id}.aedoc`);
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
 * Process JSON files in the INDEXER_DIR directory and convert to docs
 *
 * @param packagePath - Path to the package containing INDEXER_DIR
 * @param options - Command options
 */
async function processDocs(
  packagePath: string,
  options: { debug?: boolean; output?: string; dir?: string; always?: string[] }
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

    const docsPath = path.join(absolutePath, INDEXER_DIR);
    if (!fs.existsSync(docsPath)) {
      debugError(`${INDEXER_DIR} directory not found at: ${docsPath}`);
      process.exit(1);
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

    debugCli(`Processing files for package at: ${absolutePath}`);
    debugCli(`Looking for JSON files in: ${docsPath}`);

    const typescript = new TypeScript(packagePath);

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

    // Handle always-included files
    const alwaysPaths = options.always && options.always.length > 0
      ? options.always
      : ["package.json", "tsconfig.json", "README.md"];
    
    debugCli(`Processing always-included files: ${alwaysPaths.join(", ")}`);
    
    const alwaysProcessedCount = await processAlwaysIncludedFiles(
      absolutePath,
      alwaysPaths,
      commitHash,
      outputFilePath,
      outputDirPath
    );

    debugCli(`Processed ${alwaysProcessedCount} always-included files`);

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
              const doc = symbolToDoc(symbolInfo, symbolInfos, typescript, commitHash);

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
                // Write each doc to a separate file
                const docFilePath = path.join(outputDirPath, `${doc.id}.aedoc`);
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

    debugCli(`Preparation complete.`);
    debugCli(`Processed ${alwaysProcessedCount} always-included files and ${processedFiles} JSON files with ${processedLines} lines.`);

    if (outputFilePath) {
      debugCli(`Output written to file: ${outputFilePath}`);
    }

    if (outputDirPath) {
      debugCli(`Individual docs written to directory: ${outputDirPath}`);
    }
  } catch (error) {
    debugError(`Error preparing files: ${(error as Error).message}`);
    process.exit(1);
  }
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
    .action(processDocs);
}
