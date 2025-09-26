import fs from "fs";
import path from "path";

export interface WorkspaceInfo {
  path: string;
  name?: string;
}

/**
 * Extract workspace paths from a project directory.
 * Supports multiple workspace configuration formats:
 * - package.json workspaces (array format): "workspaces": ["packages/*"]
 * - package.json workspaces (object format): "workspaces": { "packages": ["packages/*"] }
 * - deno.json workspaces: "workspace": ["packages/*"]
 * - pnpm-workspace.yaml: packages: - "packages/*"
 *
 * @param projectPath - Path to the project root
 * @returns Array of workspace paths, or empty array if no workspaces found
 */
export function extractWorkspaces(projectPath: string): WorkspaceInfo[] {
  const workspaces: WorkspaceInfo[] = [];
  const resolvedProjectPath = path.resolve(projectPath);

  // Check package.json workspaces
  const packageJsonPath = path.join(resolvedProjectPath, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (packageJson.workspaces) {
        let workspacePatterns: string[] = [];
        
        if (Array.isArray(packageJson.workspaces)) {
          // Format: "workspaces": ["packages/*", "apps/*"]
          workspacePatterns = packageJson.workspaces;
        } else if (typeof packageJson.workspaces === 'object' && packageJson.workspaces !== null) {
          // Format: "workspaces": { "packages": ["packages/*"] }
          if (Array.isArray(packageJson.workspaces.packages)) {
            workspacePatterns = packageJson.workspaces.packages;
          } else {
            console.warn(`Invalid workspaces.packages format in package.json: expected array, got ${typeof packageJson.workspaces.packages}`);
          }
        } else {
          console.warn(`Invalid workspaces format in package.json: expected array or object, got ${typeof packageJson.workspaces}`);
        }
        
        for (const pattern of workspacePatterns) {
          if (typeof pattern === 'string') {
            const expandedPaths = expandWorkspacePattern(resolvedProjectPath, pattern);
            workspaces.push(...expandedPaths);
          } else {
            console.warn(`Invalid workspace pattern: expected string, got ${typeof pattern}`);
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to parse package.json: ${error}`);
    }
  }

  // Check deno.json workspaces
  const denoJsonPath = path.join(resolvedProjectPath, "deno.json");
  if (fs.existsSync(denoJsonPath)) {
    try {
      const denoJson = JSON.parse(fs.readFileSync(denoJsonPath, "utf8"));
      if (denoJson.workspace && Array.isArray(denoJson.workspace)) {
        for (const pattern of denoJson.workspace) {
          const expandedPaths = expandWorkspacePattern(resolvedProjectPath, pattern);
          workspaces.push(...expandedPaths);
        }
      }
    } catch (error) {
      console.warn(`Failed to parse deno.json: ${error}`);
    }
  }

  // Check pnpm-workspace.yaml
  const pnpmWorkspacePath = path.join(resolvedProjectPath, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmWorkspacePath)) {
    try {
      const yamlContent = fs.readFileSync(pnpmWorkspacePath, "utf8");
      const workspacePatterns = parseYamlPackages(yamlContent);
      
      for (const pattern of workspacePatterns) {
        const expandedPaths = expandWorkspacePattern(resolvedProjectPath, pattern);
        workspaces.push(...expandedPaths);
      }
    } catch (error) {
      console.warn(`Failed to parse pnpm-workspace.yaml: ${error}`);
    }
  }

  // Deduplicate workspaces by path
  const uniqueWorkspaces = new Map<string, WorkspaceInfo>();
  for (const workspace of workspaces) {
    uniqueWorkspaces.set(workspace.path, workspace);
  }

  return Array.from(uniqueWorkspaces.values());
}

/**
 * Expand a workspace pattern (like "packages/*" or "packages/**") to actual directory paths
 */
function expandWorkspacePattern(projectPath: string, pattern: string): WorkspaceInfo[] {
  const workspaces: WorkspaceInfo[] = [];
  
  try {
    // Handle glob patterns like "packages/*" and "packages/**"
    if (pattern.includes("*")) {
      if (pattern.endsWith("/*")) {
        // Single level: "packages/*"
        const baseDir = pattern.slice(0, -2); // Remove "/*"
        const basePath = path.resolve(projectPath, baseDir);
        
        if (fs.existsSync(basePath)) {
          const entries = fs.readdirSync(basePath, { withFileTypes: true });
          
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const fullPath = path.join(basePath, entry.name);
              const workspace = createWorkspaceInfo(fullPath);
              if (workspace) {
                workspaces.push(workspace);
              }
            }
          }
        }
      } else if (pattern.endsWith("/**")) {
        // Recursive: "packages/**"
        const baseDir = pattern.slice(0, -3); // Remove "/**"
        const basePath = path.resolve(projectPath, baseDir);
        
        if (fs.existsSync(basePath)) {
          const recursiveWorkspaces = findWorkspacesRecursively(basePath);
          workspaces.push(...recursiveWorkspaces);
        }
      } else {
        // Other glob patterns - for now, treat as exact path
        console.warn(`Unsupported glob pattern: ${pattern}. Treating as exact path.`);
        const fullPath = path.resolve(projectPath, pattern);
        const workspace = createWorkspaceInfo(fullPath);
        if (workspace) {
          workspaces.push(workspace);
        }
      }
    } else {
      // Handle exact paths (no wildcards)
      const fullPath = path.resolve(projectPath, pattern);
      const workspace = createWorkspaceInfo(fullPath);
      if (workspace) {
        workspaces.push(workspace);
      }
    }
  } catch (error) {
    console.warn(`Failed to expand workspace pattern "${pattern}": ${error}`);
  }

  return workspaces;
}

/**
 * Create a WorkspaceInfo object for a given path if it contains a valid package
 */
function createWorkspaceInfo(fullPath: string): WorkspaceInfo | null {
  const packageJsonPath = path.join(fullPath, "package.json");
  const denoJsonPath = path.join(fullPath, "deno.json");
  
  if (fs.existsSync(packageJsonPath)) {
    let name: string | undefined;
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      name = packageJson.name;
    } catch {
      // Ignore parsing errors for individual package.json files
    }
    
    return {
      path: fullPath,
      name
    };
  } else if (fs.existsSync(denoJsonPath)) {
    let name: string | undefined;
    try {
      const denoJson = JSON.parse(fs.readFileSync(denoJsonPath, "utf8"));
      name = denoJson.name;
    } catch {
      // Ignore parsing errors for individual deno.json files
    }
    
    return {
      path: fullPath,
      name
    };
  }
  
  return null;
}

/**
 * Recursively find all workspaces in a directory tree
 */
function findWorkspacesRecursively(basePath: string): WorkspaceInfo[] {
  const workspaces: WorkspaceInfo[] = [];
  
  try {
    const entries = fs.readdirSync(basePath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(basePath, entry.name);
        
        // Check if this directory is a workspace
        const workspace = createWorkspaceInfo(fullPath);
        if (workspace) {
          workspaces.push(workspace);
        }
        
        // Recursively search subdirectories
        const subWorkspaces = findWorkspacesRecursively(fullPath);
        workspaces.push(...subWorkspaces);
      }
    }
  } catch (error) {
    // Ignore permission errors or other issues with specific directories
  }
  
  return workspaces;
}

/**
 * Simple YAML parser for pnpm-workspace.yaml packages field
 * Only handles the basic case: packages: - <pattern>
 */
function parseYamlPackages(yamlContent: string): string[] {
  const packages: string[] = [];
  const lines = yamlContent.split('\n');
  let inPackagesSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    
    if (trimmed === 'packages:') {
      inPackagesSection = true;
      continue;
    }
    
    if (inPackagesSection) {
      // Check if we've left the packages section (new top-level key)
      if (trimmed && !trimmed.startsWith('-') && !trimmed.startsWith(' ') && trimmed.includes(':')) {
        inPackagesSection = false;
        continue;
      }
      
      // Parse package entry: - "packages/*" or - packages/*
      if (trimmed.startsWith('-')) {
        const packagePattern = trimmed.substring(1).trim();
        // Remove quotes if present
        const cleanPattern = packagePattern.replace(/^["']|["']$/g, '');
        if (cleanPattern) {
          packages.push(cleanPattern);
        }
      }
    }
  }

  return packages;
}