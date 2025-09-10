import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { SimplePool } from 'nostr-tools';
import { debugCli, debugError, enableDebugAll } from '../utils/debug.js';
import { DBExpert } from 'askexperts/db';
import { ChromaRagDB } from 'askexperts/rag';
import { createRagEmbeddings } from 'askexperts/rag';
import { LightningPaymentManager } from 'askexperts/payments';
import { OpenaiProxyExpertBase } from 'askexperts/experts';
import { AskExpertsServer } from 'askexperts/server';
import { createOpenAI } from 'askexperts/openai';
import { CodeExpert } from '../expert/CodeExpert.js';
import { getNwcString, saveNwcString } from './generate.js';

/**
 * Starts a CodeExpert for a given package
 * 
 * @param packagePath - Path to the package to analyze
 * @param options - Command options
 */
async function startExpert(
  packagePath: string,
  options: { debug?: boolean; nwc?: string }
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

    debugCli(`Starting expert for package at: ${absolutePath}`);

    // Generate private key (Uint8Array)
    const privkeyBytes = generateSecretKey();
    
    // Create hex string version for DBExpert storage
    const privkeyHex = Buffer.from(privkeyBytes).toString('hex');
    
    // Create DBExpert structure with required fields
    const expert: DBExpert = {
      privkey: privkeyHex,
      pubkey: getPublicKey(privkeyBytes),
      model: "openai/gpt-oss-120b",
      system_prompt: `
  You are an expert on 'nostr-tools' library, it's description is: "Tools for developing Nostr clients".
  For each user query you will get the list of symbols and their documentation that might be relevant
  to user's request. Use this context to reply as accurately as possible, if unsure - admit so, do not guess.
      `,
    };

    debugCli(`Created expert with pubkey: ${expert.pubkey}`);

    // Create RAG DB
    const ragDB = new ChromaRagDB();
    const ragEmbeddings = createRagEmbeddings();
    await ragEmbeddings.start();
    debugCli("Created ChromaRagDB and RagEmbeddings instances");

    // Get NWC string from options, file, or error
    const nwcString = getNwcString(options.nwc);

    // If NWC was provided via CLI, save it
    if (options.nwc) {
      saveNwcString(options.nwc);
    }

    // Helper functions
    const str2arr = (s: string) => s.split(',');
    const paymentManager = new LightningPaymentManager(nwcString);
    const pool = new SimplePool();

    // Create OpenAI interface instance
    const openai = createOpenAI({
      pool,
      paymentManager,
    });

    // Create server using original Uint8Array (not the hex string)
    const server = new AskExpertsServer({
      privkey: privkeyBytes,
      pool,
      paymentManager,
      description: expert.description,
      // discoveryRelays: str2arr(expert.discovery_relays || ''),
      hashtags: str2arr(expert.discovery_hashtags || ''),
      nickname: expert.nickname,
      picture: expert.picture,
      profileHashtags: str2arr(expert.hashtags || ''),
    });

    // Create OpenaiProxyExpertBase instance
    const openaiExpert = new OpenaiProxyExpertBase({
      server,
      openai,
      model: expert.model || 'gpt-oss-120b',
    });

    const codeExpert = new CodeExpert({
      openaiExpert,
      expert,
      ragDB,
      packagePath: absolutePath,
    });

    debugCli(`Starting CodeExpert...`);
    await codeExpert.start();
    debugCli(`CodeExpert started successfully`);

    // Handle Ctrl+C to terminate gracefully
    process.on('SIGINT', async () => {
      debugCli('Received SIGINT, terminating CodeExpert...');
      await codeExpert[Symbol.asyncDispose]();
      process.exit(0);
    });

    debugCli(`Expert is running. Press Ctrl+C to terminate.`);
  } catch (error) {
    debugError(`Error starting expert: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Register the 'expert' command to the provided commander instance
 * 
 * @param program - Commander instance to register the command to
 */
export function registerExpertCommand(program: Command): void {
  program
    .command('expert')
    .description('Start a CodeExpert for a given package')
    .argument('<package_path>', 'Path to the package to analyze')
    .option('-d, --debug', 'Enable debug output')
    .option('--nwc <string>', 'Lightning Node Connect (NWC) string for payment')
    .action(startExpert);
}