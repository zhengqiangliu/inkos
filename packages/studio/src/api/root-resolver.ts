import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Studio occasionally starts from `<project>/books` or `<project>/books/<bookId>`.
 * In those cases, auto-lift back to the true InkOS project root to avoid
 * generating nested `books/books/...` paths.
 */
export function normalizeStudioProjectRoot(inputRoot: string): string {
  const resolvedInput = resolve(inputRoot);
  const projectRoot = findNearestProjectRoot(resolvedInput);
  if (!projectRoot) {
    return resolvedInput;
  }

  const relativeToProject = relative(projectRoot, resolvedInput).replace(/\\/g, "/");
  if (relativeToProject === "books" || relativeToProject.startsWith("books/")) {
    return projectRoot;
  }

  return resolvedInput;
}

function findNearestProjectRoot(startPath: string): string | undefined {
  let cursor = resolve(startPath);
  while (true) {
    if (existsSync(join(cursor, "inkos.json"))) {
      return cursor;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}
