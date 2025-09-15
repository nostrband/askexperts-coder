#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { registerGenerateCommand } from './generate.js';
import { initializeDebug, debugCli } from '../utils/debug.js';
import { registerSymbolsCommand } from './symbols.js';
import { registerPrepareCommand } from './prepare.js';

export const INDEXER_DIR = ".askexperts";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json
const packageJsonPath = join(__dirname, '../../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;

// Initialize debug
initializeDebug();

// Create the main program
const program = new Command();

// Set up program information
program
  .name('askexperts-coder')
  .description('Convert code to RAG for AI experts')
  .version(version);

// Register commands
registerGenerateCommand(program);
registerSymbolsCommand(program);
registerPrepareCommand(program);

// Parse command line arguments and execute
debugCli('Parsing command line arguments');
program.parse(process.argv);

// Display help if no command is provided
if (!process.argv.slice(2).length) {
  debugCli('No command provided, displaying help');
  program.outputHelp();
}