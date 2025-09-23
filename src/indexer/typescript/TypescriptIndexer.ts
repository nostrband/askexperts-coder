import { LightningPaymentManager } from "askexperts/mcp";
import { SimplePool } from "nostr-tools";
import { debugTypescript, debugError } from "../../utils/debug.js";
import { OpenaiAskExperts } from "askexperts/openai";
import { ChatCompletion, ChatCompletionCreateParams } from "openai/resources";

const DEFAULT_MODEL = "anthropic/claude-3.7-sonnet";
const DEFAULT_FALLBACK_MODEL = "openai/gpt-oss-120b";
const DEFAULT_MAX_AMOUNT = 100;
const DEFAULT_PROMPT = `
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
`;

const DEFAULT_FILE_PROMPT = `
You are a TypeScript expert, your task is to create a summary documentation for a typescript file.

User will provide:
1. .ts file path within the project.
2. The contents of the file, with line numbers prepended in "<lineNumber>|<codeLine>" format.

You job is:
1. Create a short summary of the public "side" of the file - main exported symbols, their purpose, what they do and how. 
Be brief, several sentences should be enough, this summary only serves as a pointer for deeper investigation of the file
contents.
2. Create a short summary of the implementation details of the file - how things work, what main
components/modules/functions are used, anything that would help a coder get a rough vision of the implementation without
reading the full source code. If the file is trivial, leave this doc entry empty.
3. Return a document in this JSON format (no markdown!): "{ summary: <public_docs>, details: <implementation_docs> }"
4. Make sure you return valid json with escaped line-breaks in "details" field, especially important when your
details contain numbered lists.

If the provided input is invalid, return "ERROR: <reason>" string.
`;

const DEFAULT_DIR_PROMPT = `
You are a TypeScript expert, your task is to create a summary documentation for a directory with typescript files.

User will provide:
1. Dir path within the project.
2. Dir structure (tree of files in the dir).
3. The summaries for each of the typescript file (purpose, main exported symbols, etc)

You job is:
1. Create a short summary of the public "side" of the dir - main exported symbols, overall purpose, general theme 
of files grouped in this dir. Be brief, several sentences should be enough, this summary only serves as a pointer for 
deeper investigation of the dir contents.
2. Return a document in this JSON format (no markdown!): "{ summary: <public_docs> }"
3. Make sure you return valid json with escaped line-breaks in "details" field, especially important when your
details contain numbered lists.

If the provided input is invalid, return "ERROR: <reason>" string.
`;

/**
 * A class for analyzing TypeScript files and generating documentation
 */
export class TypescriptIndexer {
  private client: OpenaiAskExperts;
  private pool: SimplePool;
  private paymentManager: LightningPaymentManager;
  private ownedPool: boolean;
  private expertPubkey: string;
  private fallbackExpertPubkey: string;
  private systemPrompt: string;
  private maxAmount?: number;

  constructor(options: {
    nwc: string;
    systemPrompt?: string;
    pool?: SimplePool;
    maxAmount?: number;
    expertPubkey?: string;
    fallbackExpertPubkey?: string;
  }) {
    this.systemPrompt = options.systemPrompt || DEFAULT_PROMPT;
    this.expertPubkey = options.expertPubkey || DEFAULT_MODEL;
    this.fallbackExpertPubkey =
      options.fallbackExpertPubkey || DEFAULT_FALLBACK_MODEL;
    this.maxAmount = options.maxAmount || DEFAULT_MAX_AMOUNT;

    // Create LightningPaymentManager
    this.paymentManager = new LightningPaymentManager(options.nwc);

    // Track if we're creating our own pool or using a provided one
    this.ownedPool = !options.pool;
    this.pool = options.pool || new SimplePool();

    // Create OpenAI instance
    this.client = new OpenaiAskExperts(this.paymentManager, {
      pool: this.pool,
    });
  }

  public async start() {}

  /**
   * Process a TypeScript file code and extract documentation
   *
   * @param code - Contents of the TypeScript file to process
   * @throws Error - Currently throws an error as implementation is pending
   */
  public async processSymbol(
    file: string,
    code: string,
    symbol: any
  ): Promise<any> {
    debugTypescript(`Processing code of length: ${code.length}`);

    // Prepend line numbers to code string
    const codeLines = code
      .split("\n")
      .map((line, index) => `${index + 1}|${line}`)
      .join("\n");

    const request: ChatCompletionCreateParams = {
      model: this.expertPubkey,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: this.systemPrompt,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `File: ${file}`,
            },
            {
              type: "text",
              text: codeLines,
              // NOTE: we're forcing the model to cache the code
              // FIXME doesn't seem to work properly
              // @ts-ignore
              cache_control: {
                type: "ephemeral",
              },
            },
            {
              type: "text",
              text: JSON.stringify(symbol),
            },
          ],
        },
      ],
    };
    const quote = await this.client.getQuote(this.expertPubkey, request);

    if (this.maxAmount && quote.amountSats > this.maxAmount) {
      throw new Error(`Amount ${quote.amountSats} exceeds max`);
    }
    debugTypescript(`Quote for ${quote.amountSats} sats`);

    const reply = (await this.client.execute(quote.quoteId)) as ChatCompletion;
    debugTypescript("Response usage", JSON.stringify(reply.usage));
    const result = reply.choices[0].message.content || "";

    try {
      debugTypescript(`Parsing response '${result}'`);
      return JSON.parse(result);
    } catch (e) {
      debugError("Bad llm output json, trying fallback model");

      // Try fallback model
      try {
        const fallbackQuote = await this.client.getQuote(
          this.fallbackExpertPubkey,
          { ...request, model: this.fallbackExpertPubkey }
        );

        if (this.maxAmount && fallbackQuote.amountSats > this.maxAmount) {
          throw new Error(
            `Fallback amount ${fallbackQuote.amountSats} exceeds max`
          );
        }
        debugTypescript(`Fallback quote for ${fallbackQuote.amountSats} sats`);

        const fallbackReply = (await this.client.execute(
          fallbackQuote.quoteId
        )) as ChatCompletion;
        debugTypescript(
          "Fallback response usage",
          JSON.stringify(fallbackReply.usage)
        );
        const fallbackResult = fallbackReply.choices[0].message.content || "";

        try {
          debugTypescript(`Parsing fallback response '${fallbackResult}'`);
          return JSON.parse(fallbackResult);
        } catch (fallbackError) {
          debugError("Fallback model also returned invalid JSON");
          throw new Error(
            "Both primary and fallback models returned invalid JSON"
          );
        }
      } catch (fallbackError) {
        debugError("Fallback model request failed", fallbackError);
        throw fallbackError;
      }
    }
  }

  [Symbol.dispose]() {
    this.client[Symbol.dispose]();
    this.paymentManager[Symbol.dispose]();

    // Destroy the pool if we created it internally
    if (this.ownedPool && this.pool) {
      this.pool.destroy();
    }
  }
}
