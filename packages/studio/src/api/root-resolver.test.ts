import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeStudioProjectRoot } from "./root-resolver.js";

describe("normalizeStudioProjectRoot", () => {
  it("keeps a valid project root unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-root-resolver-"));
    try {
      await writeFile(join(root, "inkos.json"), "{}", "utf-8");
      expect(normalizeStudioProjectRoot(root)).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lifts <project>/books to project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-root-resolver-"));
    try {
      await writeFile(join(root, "inkos.json"), "{}", "utf-8");
      await mkdir(join(root, "books"), { recursive: true });
      expect(normalizeStudioProjectRoot(join(root, "books"))).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lifts <project>/books/<bookId> to project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-root-resolver-"));
    try {
      await writeFile(join(root, "inkos.json"), "{}", "utf-8");
      await mkdir(join(root, "books", "demo-book", "chapters"), { recursive: true });
      expect(normalizeStudioProjectRoot(join(root, "books", "demo-book"))).toBe(root);
      expect(normalizeStudioProjectRoot(join(root, "books", "demo-book", "chapters"))).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
