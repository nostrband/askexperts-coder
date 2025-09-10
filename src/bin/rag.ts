  import fs from "node:fs";
  import path from "node:path";
  import { Command } from "commander";
  import { debugCli, debugError, enableDebugAll } from "../utils/debug.js";
  import {
    createRagEmbeddings,
    ChromaRagDB,
    RagDocument,
  } from "askexperts/rag";

  /**
   * Process JSON files in the indexer_docs directory and create RAG embeddings
   *
   * @param packagePath - Path to the package containing indexer_docs
   * @param options - Command options
   */
  async function processRagEmbeddings(
    packagePath: string,
    options: { debug?: boolean }
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

      debugCli(`Processing RAG embeddings for package at: ${absolutePath}`);
      debugCli(`Looking for JSON files in: ${docsPath}`);

      // Create RagEmbeddings instance
      const embeddings = createRagEmbeddings();
      await embeddings.start();
      debugCli("Created RagEmbeddings instance");

      // Create ChromaRagDB instance
      const db = new ChromaRagDB();
      debugCli("Created ChromaRagDB instance");

      // Track statistics
      let processedFiles = 0;
      let processedLines = 0;
      let storedEmbeddings = 0;

      // RAG collection
      const collectionName = path.basename(absolutePath);
      debugCli("collectionName", collectionName);

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

              let lineNum = 0;
              for (const line of lines) {
                lineNum++;
                if (line.trim()) {
                  processedLines++;

                  try {
                    // Create embeddings for the line
                    const chunks = await embeddings.embed(line);

                    const docId = `${itemPath}:${lineNum}`;

                    // Store the line and its vectors in the database
                    for (let i = 0; i < chunks.length; i++) {
                      const chunk = chunks[i];
                      const doc: RagDocument = {
                        data: line,
                        vector: chunk.embedding,
                        id: docId + "/" + i,
                        metadata: {
                          doc_related_ids: "",
                          doc_id: docId,
                          chunk: i,
                          doc_created_at: Date.now(),
                          docstore_id: itemPath,
                          doc_metadata: "",
                          extra: "",
                          doc_timestamp: Date.now(),
                          doc_type: "code_doc",
                          offset_start: chunk.offset,
                          offset_end:
                            chunk.offset +
                            (i < chunks.length - 1
                              ? chunks[i + 1].offset
                              : line.length),
                        },
                      };
                      await db.store(path.basename(absolutePath), doc);
                    }
                  } catch (embeddingError) {
                    debugError(
                      `Error creating embedding for line ${processedLines}: ${
                        (embeddingError as Error).message
                      }`
                    );
                  }
                  storedEmbeddings++;

                  if (processedLines % 10 === 0) {
                    debugCli(`Processed ${processedLines} lines so far...`);
                  }
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

      debugCli(`RAG processing complete.`);
      debugCli(`Processed ${processedFiles} files with ${processedLines} lines.`);
      debugCli(`Created and stored ${storedEmbeddings} embeddings.`);
    } catch (error) {
      debugError(`Error processing RAG embeddings: ${(error as Error).message}`);
      process.exit(1);
    }
  }
  
  /**
   * Search for similar documents in the RAG database using a query string
   *
   * @param query - Query string to search for
   * @param packagePath - Path to the package containing the RAG database
   * @param options - Command options
   */
  async function processRagSearch(
    query: string,
    packagePath: string,
    options: { debug?: boolean; limit?: number }
  ): Promise<void> {
    // Enable debug output if debug flag is set
    if (options.debug) {
      enableDebugAll();
    }
  
    // Set default limit if not provided
    const resultLimit = options.limit || 5;
  
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
  
      debugCli(`Searching RAG database for package at: ${absolutePath}`);
      debugCli(`Query: "${query}"`);
  
      // Create RagEmbeddings instance
      const embeddings = createRagEmbeddings();
      await embeddings.start();
      debugCli("Created RagEmbeddings instance");
  
      // Create ChromaRagDB instance
      const db = new ChromaRagDB();
      debugCli("Created ChromaRagDB instance");
  
      // Create embeddings for the query
      const queryChunks = await embeddings.embed(query);
      debugCli(`Created ${queryChunks.length} chunks for the query`);
  
      if (queryChunks.length === 0) {
        debugError("Failed to create embeddings for the query");
        process.exit(1);
      }
  
      // Get collection name from package path
      const collectionName = path.basename(absolutePath);
      debugCli("Collection name:", collectionName);
  
      // Search for similar documents using the first chunk's embedding
      const queryVector = queryChunks[0].embedding;
      const searchResults = await db.search(collectionName, queryVector, resultLimit);
  
      // Display search results
      console.log("\nSearch Results:");
      console.log("---------------");
  
      if (searchResults.length === 0) {
        console.log("No matching results found.");
      } else {
        searchResults.forEach((result, index) => {
          console.log(`\n[${index + 1}] Score: ${(1 - result.distance).toFixed(4)}`);
          console.log(`Data: ${result.data}`);
          console.log(`Source: ${result.metadata.doc_metadata}`);
        });
      }
  
      console.log("\nSearch complete.");
    } catch (error) {
      debugError(`Error searching RAG database: ${(error as Error).message}`);
      process.exit(1);
    }
  }
  
  /**
   * Register the 'rag' command to the provided commander instance
   *
   * @param program - Commander instance to register the command to
   */
  export function registerRagCommand(program: Command): void {
    program
      .command("rag")
      .description("Process JSON files in indexer_docs and create RAG embeddings")
      .argument("<package_path>", "Path to the package containing indexer_docs")
      .option("-d, --debug", "Enable debug output")
      .action(processRagEmbeddings);
  }
  
  /**
   * Register the 'search' command to the provided commander instance
   *
   * @param program - Commander instance to register the command to
   */
  export function registerSearchCommand(program: Command): void {
    program
      .command("search")
      .description("Search for documents in the RAG database using a query string")
      .argument("<query>", "Query string to search for")
      .argument("<package_path>", "Path to the package containing the RAG database")
      .option("-d, --debug", "Enable debug output")
      .option("-l, --limit <number>", "Maximum number of results to return", parseInt)
      .action(processRagSearch);
  }
