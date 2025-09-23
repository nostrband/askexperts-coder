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
  lib: ["esnext", "dom", "dom.iterable"],
};

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

  // Merge compilerOptions
  const compilerOptions = {
    ...denoDefaults,
    ...(userConfig.compilerOptions ?? {}),
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