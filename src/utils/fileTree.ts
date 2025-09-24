import fs from "node:fs";
import path from "node:path";
import { debugError } from "./debug.js";

/**
 * Parse .gitignore file and return patterns
 * @param gitignorePath - Path to .gitignore file
 * @returns Array of gitignore patterns
 */
export function parseGitignore(gitignorePath: string): string[] {
  if (!fs.existsSync(gitignorePath)) {
    return [];
  }

  const content = fs.readFileSync(gitignorePath, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * Check if a file path should be ignored based on gitignore patterns
 * @param filePath - Relative file path from project root
 * @param patterns - Array of gitignore patterns
 * @returns True if file should be ignored
 */
export function shouldIgnoreFile(filePath: string, patterns: string[]): boolean {
  // Always ignore these directories
  const alwaysIgnore = ["node_modules", ".askexperts", ".git"];

  for (const ignore of alwaysIgnore) {
    if (filePath.includes(ignore)) {
      return true;
    }
  }

  // Check gitignore patterns
  for (const pattern of patterns) {
    // Simple pattern matching - handle basic cases
    if (pattern.endsWith("/")) {
      // Directory pattern
      const dirPattern = pattern.slice(0, -1);
      if (filePath.startsWith(dirPattern + "/") || filePath === dirPattern) {
        return true;
      }
    } else if (pattern.includes("*")) {
      // Wildcard pattern - basic implementation
      const regex = new RegExp(pattern.replace(/\*/g, ".*"));
      if (regex.test(filePath)) {
        return true;
      }
    } else {
      // Exact match
      if (filePath === pattern || filePath.startsWith(pattern + "/")) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Generate a file tree string with full workspace-root-relative paths
 * @param dirPath - Directory path to scan
 * @param gitignorePatterns - Array of gitignore patterns
 * @param relativePath - Relative path from project root
 * @returns String with full paths, one per line
 */
export function generateFileTree(
  dirPath: string,
  gitignorePatterns: string[],
  relativePath: string = ""
): string {
  let result = "";

  try {
    const items = fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((item) => {
        const itemRelativePath = relativePath
          ? `${relativePath}/${item.name}`
          : item.name;
        return !shouldIgnoreFile(itemRelativePath, gitignorePatterns);
      })
      .sort((a, b) => {
        // Files and directories alphabetically
        return a.name.localeCompare(b.name);
      });

    items.forEach((item) => {
      const itemRelativePath = relativePath
        ? `${relativePath}/${item.name}`
        : item.name;

      if (item.isDirectory()) {
        // Add directory path
        result += `${itemRelativePath}/\n`;
        
        // Recursively process directory contents
        const itemPath = path.join(dirPath, item.name);
        result += generateFileTree(
          itemPath,
          gitignorePatterns,
          itemRelativePath
        );
      } else {
        // Add file path
        result += `${itemRelativePath}\n`;
      }
    });
  } catch (error) {
    debugError(
      `Error reading directory ${dirPath}: ${(error as Error).message}`
    );
  }

  return result;
}