import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findProjectRoot } from "../utils.js";

describe("findProjectRoot", () => {
  let tempDir: string;
  let cwdSpy: { mockReturnValue: (value: string) => unknown; mockRestore: () => void };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "inkos-find-root-"));
    cwdSpy = vi.spyOn(process, "cwd");
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns current directory when not under a project books subtree", async () => {
    const workspace = join(tempDir, "workspace");
    await mkdir(workspace, { recursive: true });
    cwdSpy.mockReturnValue(workspace);

    expect(findProjectRoot()).toBe(workspace);
  });

  it("throws when started inside <project>/books", async () => {
    const projectRoot = join(tempDir, "project-a");
    const booksDir = join(projectRoot, "books");
    await mkdir(booksDir, { recursive: true });
    await writeFile(join(projectRoot, "inkos.json"), "{}\n", "utf-8");
    cwdSpy.mockReturnValue(booksDir);

    expect(() => findProjectRoot()).toThrow("Do not start InkOS from inside");
    expect(() => findProjectRoot()).toThrow(projectRoot);
  });

  it("throws when started inside <project>/books/<bookId>/...", async () => {
    const projectRoot = join(tempDir, "project-b");
    const deepDir = join(projectRoot, "books", "harbor", "story");
    await mkdir(deepDir, { recursive: true });
    await writeFile(join(projectRoot, "inkos.json"), "{}\n", "utf-8");
    cwdSpy.mockReturnValue(deepDir);

    expect(() => findProjectRoot()).toThrow("Do not start InkOS from inside");
    expect(() => findProjectRoot()).toThrow(projectRoot);
  });
});
