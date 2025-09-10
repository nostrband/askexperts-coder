import { LightningPaymentManager } from "askexperts/mcp";
import { SimplePool } from "nostr-tools";
import { debugTypescriptHacker, debugError } from "../../utils/debug.js";
import { OpenaiAskExperts } from "askexperts/openai";
import { ChatCompletion } from "openai/resources";

const DEFAULT_MODEL = "anthropic/claude-3.7-sonnet";
const DEFAULT_MAX_AMOUNT = 100;

/**
 * A class for analyzing TypeScript files and generating documentation
 */
export class TypescriptIndexer {
  private client: OpenaiAskExperts;
  private pool: SimplePool;
  private paymentManager: LightningPaymentManager;
  private ownedPool: boolean;
  private expertPubkey: string;
  private systemPrompt: string;
  private maxAmount?: number;

  constructor(options: {
    nwc: string;
    systemPrompt: string;
    pool?: SimplePool;
    maxAmount?: number;
    expertPubkey?: string;
  }) {
    this.systemPrompt = options.systemPrompt;
    this.expertPubkey = options.expertPubkey || DEFAULT_MODEL;
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
    debugTypescriptHacker(`Processing code of length: ${code.length}`);

    // Prepend line numbers to code string
    const codeLines = code
      .split("\n")
      .map((line, index) => `${index + 1}|${line}`)
      .join("\n");

    const quote = await this.client.getQuote(this.expertPubkey, {
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
    });

    if (this.maxAmount && quote.amountSats > this.maxAmount) {
      throw new Error(`Amount ${quote.amountSats} exceeds max`);
    }
    debugTypescriptHacker(`Quote for ${quote.amountSats} sats`);

    const reply = (await this.client.execute(quote.quoteId)) as ChatCompletion;
    debugTypescriptHacker("Response usage", JSON.stringify(reply.usage));
    const result = reply.choices[0].message.content || "";

    try {
      debugTypescriptHacker(`Parsing response '${result}'`);
      return JSON.parse(result);
    } catch (e) {
      debugError("Bad llm output json");
      throw e;
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
