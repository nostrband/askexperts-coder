#!/usr/bin/env node

import { Command } from 'commander';
import { registerGenerateCommand } from './generate.js';
import { initializeDebug, debugCli } from '../utils/debug.js';
import { registerSymbolsCommand } from './symbols.js';
import { registerRagCommand, registerSearchCommand } from './rag.js';
import { registerExpertCommand } from './expert.js';
import { registerPrepareCommand } from './import.js';

// Initialize debug
initializeDebug();

// Create the main program
const program = new Command();

// Set up program information
program
  .name('askexperts-hacker')
  .description('AI agent that analyzes TypeScript source codebases to produce searchable documentation')
  .version('1.0.0');

// Register commands
registerGenerateCommand(program);
registerSymbolsCommand(program);
registerRagCommand(program);
registerSearchCommand(program);
registerExpertCommand(program);
registerPrepareCommand(program);

// Parse command line arguments and execute
debugCli('Parsing command line arguments');
program.parse(process.argv);

// Display help if no command is provided
if (!process.argv.slice(2).length) {
  debugCli('No command provided, displaying help');
  program.outputHelp();
}