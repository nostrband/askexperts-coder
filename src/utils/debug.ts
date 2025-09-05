import debug from 'debug';

// Namespace for our application
const BASE_NAMESPACE = 'askexperts-hacker';
const ASKEXPERTS_PREFIX = 'askexperts';

// Debug functions for different modules
export const debugCli = debug(`${BASE_NAMESPACE}:cli`);
export const debugTypescriptHacker = debug(`${BASE_NAMESPACE}:typescript-hacker`);
export const debugError = debug(`${BASE_NAMESPACE}:error`);

// Helper for tracking execution path (useful for debugging)
export const debugTrace = debug(`${BASE_NAMESPACE}:trace`);

/**
 * Initialize debug settings
 * This can be called at application startup to set up any debug configuration
 */
export function initializeDebug(): void {
  // Enable stderr output if DEBUG environment variable is set
  if (process.env.DEBUG) {
    // Any additional debug setup can go here
    debugTrace('Debug initialized');
  }
}

/**
 * Enable all debug namespaces in the application
 * This makes all debugXX methods actually print to stderr
 */
export function enableDebugAll(): void {
  // Enable the debug namespaces immediately
  debug.enable(`${BASE_NAMESPACE}:*,${ASKEXPERTS_PREFIX}:*`);
  
  debugTrace('All debug namespaces enabled');
}

/**
 * Helper to log structured output (useful for CLI commands that output JSON)
 * This ensures structured output goes to stdout, not stderr
 *
 * @param data - The data to output to stdout
 */
export function outputStructured(data: any): void {
  // Output structured data to stdout
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}