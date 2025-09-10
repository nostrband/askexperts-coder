import { Ask, debugExpert, ExpertBid, Prompt } from "askexperts/common";
import { FORMAT_OPENAI, FORMAT_TEXT } from "askexperts/common";
import { createRagEmbeddings, RagDB, RagEmbeddings } from "askexperts/rag";
import { OpenaiProxyExpertBase } from "askexperts/experts";
// import { Doc, DocStoreClient } from "../docstore/interfaces.js";
// import { DocstoreToRag, createRagEmbeddings } from "../rag/index.js";
import { DBExpert } from "askexperts/db";
import { ChatCompletionCreateParams } from "openai/resources";
import { debugError } from "../utils/debug.js";
import {
  createSymbolIdHash,
  equalStableId,
  getDeclarationHeader,
  StableSymbolId,
  Symbol,
  TypeScript,
} from "../indexer/typescript/TypeScript.js";
import ts from "typescript";
import path from "path";
import { Doc } from "askexperts/docstore";

/**
 * CodeExpert implementation for NIP-174
 * Provides expert access to context using docstore and rag
 */
export class CodeExpert {
  /**
   * OpenaiExpertBase instance
   */
  private openaiExpert: OpenaiProxyExpertBase;

  /** Expert info */
  private expert: DBExpert;

  /** Hashtags we're watching */
  private discovery_hashtags: string[] = [];

  private packagePath: string;

  private typescript: TypeScript;

  /**
   * RAG embeddings provider
   */
  private ragEmbeddings?: RagEmbeddings;

  /**
   * RAG database
   */
  private ragDB: RagDB;

  /**
   * Creates a new CodeExpert instance
   *
   * @param options - Configuration options
   */
  constructor(options: {
    openaiExpert: OpenaiProxyExpertBase;
    expert: DBExpert;
    ragDB: RagDB;
    packagePath: string;
  }) {
    this.expert = options.expert;
    this.openaiExpert = options.openaiExpert;

    // Store RAG database
    this.ragDB = options.ragDB;

    this.packagePath = options.packagePath;
    this.typescript = new TypeScript(this.packagePath);

    // // Store DocStore components
    // this.docStoreClient = options.docStoreClient;
    // this.docstoreId = options.docstoreId;

    // // Sync from docstore to rag
    // this.docstoreToRag = new DocstoreToRag(this.ragDB, this.docStoreClient);

    // Set our onAsk to the openaiExpert.server
    this.openaiExpert.server.onAsk = this.onAsk.bind(this);

    // Set onGetContext (renamed from onPromptContext)
    this.openaiExpert.onGetContext = this.onGetContext.bind(this);
    this.openaiExpert.onGetInvoiceDescription =
      this.onGetInvoiceDescription.bind(this);
  }

  /**
   * Starts the expert and crawls the Nostr profile
   */
  async start(): Promise<void> {
    try {
      debugExpert(`Starting CodeExpert`);

      // // Get docstore to determine model
      // const docstore = await this.docStoreClient.getDocstore(this.docstoreId);
      // if (!docstore) {
      //   throw new Error(`Docstore with ID ${this.docstoreId} not found`);
      // }

      // // Use docstore model for embeddings
      // debugExpert(`Using docstore model: ${docstore.model}`);

      // Create and initialize embeddings with the docstore model
      this.ragEmbeddings = createRagEmbeddings();
      await this.ragEmbeddings.start();
      debugExpert("RAG embeddings initialized with docstore model");

      // // Start syncing docs to RAG
      // const collectionName = this.ragCollectionName();
      // debugExpert(
      //   `Starting sync from docstore ${this.docstoreId} to RAG collection ${collectionName}`
      // );

      // // Sync from docstore to RAG
      // await new Promise<void>(async (resolve) => {
      //   this.syncController = await this.docstoreToRag.sync({
      //     docstore_id: this.docstoreId,
      //     collection_name: collectionName,
      //     onDocMeta: (doc, embedding, metadata) => {
      //       return Promise.resolve(metadata);
      //     },
      //     onDoc: async (doc: Doc) => {
      //       this.docs.push(doc);
      //       return true;
      //     },
      //     onEof: resolve,
      //   });
      // });

      // debugExpert(
      //   `Completed syncing docstore to RAG collection ${collectionName}, docs ${this.docs.length}`
      // );

      // Parse hashtags
      this.discovery_hashtags =
        this.expert.discovery_hashtags?.split(",") || [];

      // Set hashtags to openaiExpert.server.hashtags
      this.openaiExpert.server.hashtags = [...this.discovery_hashtags];

      const system_prompt = this.expert.system_prompt || "";

      // Set onGetSystemPrompt to return the static systemPrompt
      this.openaiExpert.onGetSystemPrompt = (_: Prompt) =>
        Promise.resolve(system_prompt);

      // Set nickname and description to openaiExpert.server
      this.openaiExpert.server.nickname = this.expert.nickname || "";
      this.openaiExpert.server.description = this.expert.description || "";

      // Start the OpenAI expert
      await this.openaiExpert.start();

      debugExpert(`CodeExpert started successfully`);
    } catch (error) {
      debugError("Error starting CodeExpert:", error);
      throw error;
    }
  }

  /**
   * Handles ask events
   *
   * @param ask - The ask event
   * @returns Promise resolving to a bid if interested, or undefined to ignore
   */
  private async onAsk(ask: Ask): Promise<ExpertBid | undefined> {
    try {
      const tags = ask.hashtags;

      // Check if the ask is relevant to this expert
      if (!tags.find((s) => this.discovery_hashtags.includes(s))) {
        return undefined;
      }

      debugExpert(`CodeExpert received ask: ${ask.id}`);

      // Return a bid with our offer
      return {
        offer: this.expert.description || "I can answer your question",
      };
    } catch (error) {
      debugError("Error handling ask in CodeExpert:", error);
      return undefined;
    }
  }

  /**
   * Disposes of resources when the expert is no longer needed
   */
  async [Symbol.asyncDispose]() {
    debugExpert("Clearing CodeExpert");
    // this.docstoreToRag[Symbol.dispose]();
    // this.syncController?.stop();
  }

  private ragCollectionName() {
    const collectionName = path.basename(this.packagePath);
    return collectionName;
  }

  private onGetInvoiceDescription(prompt: Prompt): Promise<string> {
    return Promise.resolve(`Payment to expert ${this.expert.pubkey}...`);
  }

  /**
   * Callback for OpenaiExpert to get context for prompts
   *
   * @param prompt - The prompt to get context for
   * @returns Promise resolving to context string
   */
  private async onGetContext(prompt: Prompt): Promise<string> {
    try {
      // We will throw this to signal that the expert doesn't
      // have any relevant knowledge and quote should include this error
      const notFound = new Error("Expert has no knowledge on the subject");

      if (!this.ragEmbeddings) {
        // || !this.docs.length) {
        throw notFound;
      }

      // Extract text from prompt based on format
      let promptText: string = "";

      if (prompt.format === FORMAT_OPENAI) {
        // For OpenAI format, extract text from up to last 10 messages
        const content = prompt.content as ChatCompletionCreateParams;
        const messages = content.messages;
        if (messages && messages.length > 0) {
          // Get the last user message
          const userMessages = messages
            .filter((msg: any) => msg.role === "user")
            .slice(-1);

          promptText = userMessages
            .map((msg) =>
              typeof msg.content === "string"
                ? msg.content
                : msg.content
                    ?.filter((m) => m.type === "text")
                    .map((m) => m.text)
                    .join(" ")
            )
            .join("\n");
        }
      } else if (prompt.format === FORMAT_TEXT) {
        // For text format, use content directly
        promptText = prompt.content;
      }

      if (!promptText) {
        throw notFound;
      }

      // Generate embeddings for all prompt texts sequentially
      const embeddings: number[][] = [];
      debugExpert("promptText", promptText);

      // Process each text sequentially
      const chunks = await this.ragEmbeddings!.embed(promptText);

      // Extract embeddings from chunks
      for (const chunk of chunks) {
        embeddings.push(chunk.embedding);
      }

      if (embeddings.length === 0) {
        throw notFound;
      }

      // Take up to 20 most recent chunks
      const recentEmbeddings = embeddings.slice(-20);
      const limit = Math.min(50, Math.ceil(200 / recentEmbeddings.length));

      // Search for similar content in the RAG database using batch search
      const batchResults = await this.ragDB.searchBatch(
        this.ragCollectionName(),
        recentEmbeddings,
        limit // result per query embedding
      );

      const results = batchResults.flat();
      // Distance comparison is meaningless across chunks
      // .sort((a, b) => a.distance - b.distance);
      if (!results.length) {
        throw notFound;
      }

      debugExpert(
        `Rag search results ${results.length} chunks distance ${
          results[0].distance
        }:${results[results.length - 1].distance}`
      );

      debugExpert(`Rag matching chunks ${results.length}`);
      const docs = new Map<string, any>();
      for (const r of results) {
        try {
          let doc = docs.get(r.metadata.doc_id);
          if (doc) continue;

          doc = JSON.parse(r.data);
          docs.set(r.metadata.doc_id, doc);

          const absFilePath = path.join(this.packagePath, doc.file);

          let symbol: ts.Declaration | undefined;
          if (doc.kind === "MethodDeclaration" && doc.branch.length > 0) {
            symbol = this.typescript.findClassMethodDecl(
              absFilePath,
              doc.branch[0].name,
              doc.name
            );
          }

          if (symbol) {
            const paths = this.typescript.pathsToRanked(symbol);
            doc.usagePaths = paths;
          }
        } catch (e) {
          debugError("Bad doc data", r.data, e);
        }
      }
      debugExpert(`Rag matching docs ${docs.size}`);

      const files = new Set<string>();
      for (const doc of docs.values()) {
        const path = doc.file as string;
        files.add(path);
      }

      const jsonContext = JSON.stringify([...docs.values()], null, 2);
      debugExpert("jsonContext", jsonContext);
      debugExpert(
        `onGetContext results ${results.length} context ${jsonContext.length} chars`
      );
      return jsonContext;
    } catch (error) {
      debugError("Error generating prompt context:", error);
      throw error;
    }
  }
}

export type DocSymbol = Symbol & {
  parentId?: StableSymbolId;
  summary: string;
  details: string;
};

export function symbolToDoc(
  symbolInfo: DocSymbol,
  symbolInfos: DocSymbol[],
  typescript: TypeScript
): Doc {
  // Create timestamps (current time in seconds)
  const timestamp = Math.floor(Date.now() / 1000);

  // Backward compat
  if (!symbolInfo.id.hash)
    symbolInfo.id.hash = createSymbolIdHash(symbolInfo.id);

  // Get the symbol
  const symDecl = typescript.resolveStableId(symbolInfo.id);
  if (!symDecl) throw new Error(`Failed to find symbol ${symbolInfo.id}`);

  const { symbol, decl } = symDecl;

  // Related symbols
  const related = typescript.related(symbol);
  // Import paths
  const paths = typescript.pathsToRanked(symbol);

  // Doc metadata
  const metadata = `
file: ${symbolInfo.id.file}
lines: ${symbolInfo.start.split(":")[0]}:${symbolInfo.end.split(":")[0]}
`.trim();

  // Prefix/suffix for 'interface'
  let parentPrefix = "";
  let parentSuffix = "";
  let parentId = symbolInfo.parentId;
  while (parentId) {
    const symDecl = typescript.resolveStableId(parentId);
    if (!symDecl) break;

    parentPrefix =
      getDeclarationHeader(symDecl.decl, symDecl.decl.getSourceFile()) +
      "\n// ...\n" +
      parentPrefix;
    parentSuffix += "\n//...\n}";
    parentId = symbolInfos.find((s) =>
      equalStableId(s.id, parentId!)
    )?.parentId;
  }

  // Interface string body
  const header = getDeclarationHeader(decl, decl.getSourceFile());
  const body = decl.getText();
  const interfaceString = typescript.isClassLike(symbol)
    ? typescript.printClassLikePublicInterface(
        decl as ts.ClassDeclaration | ts.ClassExpression,
        {}
      )
    : typescript.isFunctionLike(symbol)
    ? header
    : body;

  // The doc content: the interface with prefix/suffix and summary docs
  let content = `
declaration:
${parentPrefix}${interfaceString}${parentSuffix}

summary:
${symbolInfo.summary}
`.trim();

  // Details if exist
  if (symbolInfo.details) content += `\n\ndetails:\n${symbolInfo.details}`;

  // List of related symbols just for readability
  if (related.length)
    content += `\n\nrelated: ${related.map((r) => r.symbol.name).join(",")}`;

  // Full body if needed
  if (body !== interfaceString) {
    content += `\n\ncode:\n${body}`;
  }

  // Format import examples
  let usage = "";
  for (const p of paths) {
    let line =
      typescript.makeImportStatement(
        p.root,
        typescript.getPackageJson()?.name || "<package>"
      ) + "\n";
    if (p.steps.length) line += (p.requiresNew ? "new " : "") + p.pretty + "\n";
    usage += line;
  }
  if (usage) content += `\n\nimport/access examples:\n${usage}`;

  // Create Doc object
  const doc: Doc = {
    id: symbolInfo.id.hash,
    docstore_id: "", // This will be set when the document is added to a docstore
    timestamp,
    created_at: timestamp, // Same as timestamp for new documents
    type: "typescript_symbol_doc",
    data: content, // Use the markdown string directly as the data field
    metadata,
    embeddings: [],
    related_ids: related
      .map((r) => typescript.buildStableId(r.symbol))
      .filter((id) => !!id)
      .map((id) => id.hash),
  };

  return doc;
}
