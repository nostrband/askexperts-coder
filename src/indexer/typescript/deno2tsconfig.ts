interface DenoConfig {
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  exclude?: string[];
}

// These are close to Deno's defaults (as of v1.45+).
const denoDefaults: Record<string, unknown> = {
  strict: true,
  noImplicitAny: true,
  alwaysStrict: true,
  strictNullChecks: true,
  isolatedModules: true,
  target: "ESNext",
  module: "ESNext",
  moduleResolution: "NodeNext",
  jsx: "react-jsx",
  allowJs: false,
  checkJs: false,
  useDefineForClassFields: true,
  forceConsistentCasingInFileNames: true,
  skipLibCheck: true,
  lib: ["es2024", "dom", "dom.iterable"],
};

// Deno-specific compiler options that should be filtered out when converting to tsconfig.json
const denoOnlyOptions = new Set([
  'jsxImportSourceTypes',
  'lib', // Deno lib contains Deno-specific values like "deno.ns" that TypeScript doesn't understand
  // Add other Deno-specific options here as needed
]);

/**
 * Filter out Deno-specific compiler options that TypeScript doesn't support
 * @param options - Compiler options object
 * @returns Filtered compiler options
 */
function filterDenoOnlyOptions(options: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!denoOnlyOptions.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Convert deno.json configuration to tsconfig.json format
 * @param denoConfigText - The raw text content of deno.json
 * @returns Generated tsconfig.json as a string
 */
export function denoConfigToTsConfig(denoConfigText: string): string {
  // Load user config
  let userConfig: DenoConfig = {};
  try {
    userConfig = JSON.parse(denoConfigText) as DenoConfig;
  } catch (error) {
    console.warn("Failed to parse deno.json, using defaults only:", error);
  }

  // Filter out Deno-specific options from user config
  const filteredUserOptions = userConfig.compilerOptions
    ? filterDenoOnlyOptions(userConfig.compilerOptions)
    : {};

  // Merge compilerOptions
  const compilerOptions = {
    ...denoDefaults,
    ...filteredUserOptions,
  };

  // Construct tsconfig.json structure
  const tsconfig = {
    compilerOptions,
    // Use include/exclude from deno.json if provided, otherwise use defaults
    include: userConfig.include ?? ["./"],
    exclude: userConfig.exclude ?? ["node_modules", ".git"],
  };

  return JSON.stringify(tsconfig, null, 2);
}