import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { debugCli, debugError, enableDebugAll } from "../utils/debug.js";
import { TypeScript } from "../indexer/typescript/TypeScript.js";
import { DocSymbol, symbolToDoc } from "../expert/CodeExpert.js";

/**
 * Process JSON files in the indexer_docs directory and convert to docs
 *
 * @param packagePath - Path to the package containing indexer_docs
 * @param options - Command options
 */
async function processDocs(
  packagePath: string,
  options: { debug?: boolean; output?: string; dir?: string }
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

    const docsPath = path.join(absolutePath, "indexer_docs");
    if (!fs.existsSync(docsPath)) {
      debugError(`indexer_docs directory not found at: ${docsPath}`);
      process.exit(1);
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

    // Track statistics
    let processedFiles = 0;
    let processedLines = 0;

    // Recursively process all JSON files in the indexer_docs directory
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
              const doc = symbolToDoc(symbolInfo, symbolInfos, typescript);

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
    debugCli(`Processed ${processedFiles} files with ${processedLines} lines.`);

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
      "Convert generated docs from `indexer_docs` subdir to docstore format"
    )
    .argument("<package_path>", "Path to the package containing indexer_docs")
    .option("-d, --debug", "Enable debug output")
    .option(
      "-o, --output <file>",
      "Output file path to write combined doc content"
    )
    .option(
      "--dir <directory>",
      "Directory to write individual doc files as JSON"
    )
    .action(processDocs);
}
