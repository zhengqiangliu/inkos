import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { PipelineRunner } from "../pipeline/runner.js";
import { type ReviseMode } from "../agents/reviser.js";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { StateManager } from "../state/manager.js";
import { createInteractionToolsFromDeps } from "../interaction/project-tools.js";
import { writeExportArtifact } from "../interaction/export-artifact.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

/**
 * Tool paths are documented as relative to books/. Some prompts still include
 * examples with an extra `books/` prefix, so we normalize it away defensively.
 */
function normalizeBooksRelativePath(relativePath: string): string {
  const trimmed = relativePath.trim().replace(/^[\\/]+/, "");
  return trimmed.replace(/^books(?:[\\/]|$)/i, "");
}

/**
 * Resolve a user-supplied relative path against the books root and guard
 * against path-traversal (../ etc.).
 */
function safeBooksPath(booksRoot: string, relativePath: string): string {
  const normalizedRelativePath = normalizeBooksRelativePath(relativePath);
  const resolved = resolve(booksRoot, normalize(normalizedRelativePath));
  const rel = relative(booksRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  return resolved;
}

function resolveToolBookId(
  toolName: string,
  paramsBookId: string | undefined,
  activeBookId: string | null,
): string {
  const resolvedBookId = normalizeBookIdInput(paramsBookId) ?? normalizeBookIdInput(activeBookId ?? undefined);
  if (!resolvedBookId) {
    throw new Error(`${toolName} requires bookId when there is no active book.`);
  }
  return resolvedBookId;
}

function createDeterministicInteractionTools(pipeline: PipelineRunner, projectRoot: string) {
  const state = new StateManager(projectRoot);
  return createInteractionToolsFromDeps(pipeline, state);
}

type AuditSeverity = "critical" | "warning" | "info";

function normalizeAuditSeverity(input: unknown): AuditSeverity {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "critical" || value === "error" || value === "严重") return "critical";
  if (value === "warning" || value === "warn" || value === "警告") return "warning";
  return "info";
}

function auditSeverityRank(severity: AuditSeverity): number {
  if (severity === "critical") return 0;
  if (severity === "warning") return 1;
  return 2;
}

function estimateAuditScore(counts: Readonly<Record<AuditSeverity, number>>): number {
  const raw = 100 - counts.critical * 35 - counts.warning * 12 - counts.info * 4;
  return Math.max(0, Math.min(100, raw));
}

function formatAuditIssueLine(issue: { severity?: unknown; category?: unknown; description?: unknown }): string {
  const severity = normalizeAuditSeverity(issue.severity);
  const category = String(issue.category ?? "").trim();
  const description = String(issue.description ?? "").trim();
  const body = category && description
    ? `${category}: ${description}`
    : category || description || "未提供问题描述";
  return `[${severity}] ${body}`;
}

function buildSubAgentAuditReport(args: {
  readonly chapterNumber: number;
  readonly passed: boolean;
  readonly summary?: string;
  readonly issues: ReadonlyArray<{ severity?: unknown; category?: unknown; description?: unknown }>;
}): string {
  const normalized = args.issues
    .map((issue) => ({
      severity: normalizeAuditSeverity(issue.severity),
      category: String(issue.category ?? "").trim(),
      description: String(issue.description ?? "").trim(),
    }))
    .sort((left, right) => auditSeverityRank(left.severity) - auditSeverityRank(right.severity));
  const counts = normalized.reduce<Record<AuditSeverity, number>>(
    (acc, issue) => {
      acc[issue.severity] += 1;
      return acc;
    },
    { critical: 0, warning: 0, info: 0 },
  );
  const score = estimateAuditScore(counts);
  const issueCount = normalized.length;
  const header = args.passed
    ? issueCount > 0
      ? `第${args.chapterNumber}章审计通过，发现${issueCount}项非阻断问题。`
      : `第${args.chapterNumber}章审计通过。`
    : `第${args.chapterNumber}章审计未通过，共${issueCount}项问题。`;

  const lines = [header];
  lines.push(`审计评分：${score}/100（严重 ${counts.critical} / 警告 ${counts.warning} / 提示 ${counts.info}）`);
  const summary = args.summary?.trim();
  if (summary) {
    lines.push(`审计报告：${summary}`);
  }
  if (normalized.length > 0) {
    const grouped: Record<AuditSeverity, string[]> = { critical: [], warning: [], info: [] };
    for (const issue of normalized) {
      grouped[issue.severity].push(formatAuditIssueLine(issue));
    }
    lines.push("问题清单：");
    if (grouped.critical.length > 0) {
      lines.push("严重：");
      grouped.critical.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    }
    if (grouped.warning.length > 0) {
      lines.push("警告：");
      grouped.warning.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    }
    if (grouped.info.length > 0) {
      lines.push("提示：");
      grouped.info.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 1. SubAgentTool (sub_agent)
// ---------------------------------------------------------------------------

const SubAgentParams = Type.Object({
  agent: Type.Optional(Type.Union([
    Type.Literal("architect"),
    Type.Literal("writer"),
    Type.Literal("auditor"),
    Type.Literal("reviser"),
    Type.Literal("exporter"),
  ])),
  instruction: Type.Optional(Type.String({ description: "Natural language instruction for the sub-agent. Required for architect, optional for others." })),
  bookId: Type.Optional(Type.String({ description: "Book ID — required for all agents except architect" })),
  chapterNumber: Type.Optional(Type.Number({ description: "auditor/reviser: target chapter number. Omit to use the latest chapter." })),
  chapterCount: Type.Optional(Type.Number({ description: "writer only: number of consecutive chapters to write. Default: 1." })),
  // -- architect params --
  title: Type.Optional(Type.String({ description: "architect only: explicit book title. Required when creating a book." })),
  genre: Type.Optional(Type.String({ description: "architect only: genre (xuanhuan, urban, mystery, romance, scifi, fantasy, wuxia, general, etc.)" })),
  platform: Type.Optional(Type.Union([
    Type.Literal("tomato"),
    Type.Literal("qidian"),
    Type.Literal("feilu"),
    Type.Literal("other"),
  ], { description: "architect only: target platform. Default: other" })),
  language: Type.Optional(Type.Union([
    Type.Literal("zh"),
    Type.Literal("en"),
  ], { description: "architect only: writing language. Default: zh" })),
  targetChapters: Type.Optional(Type.Number({ description: "architect only: total chapter count. Default: 200" })),
  chapterWordCount: Type.Optional(Type.Number({ description: "architect/writer: words per chapter. Default: 3000" })),
  // -- reviser params --
  mode: Type.Optional(Type.Union([
    Type.Literal("spot-fix"),
    Type.Literal("polish"),
    Type.Literal("rewrite"),
    Type.Literal("rework"),
    Type.Literal("anti-detect"),
  ], { description: "reviser only: revision mode. Default: spot-fix" })),
  // -- exporter params --
  format: Type.Optional(Type.Union([
    Type.Literal("txt"),
    Type.Literal("md"),
    Type.Literal("epub"),
  ], { description: "exporter only: export format. Default: txt" })),
  approvedOnly: Type.Optional(Type.Boolean({ description: "exporter only: export only approved chapters. Default: false" })),
});

function deriveBookIdFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

function normalizeBookIdInput(bookId: string | undefined): string | undefined {
  if (bookId === undefined) return undefined;
  const normalized = bookId.trim()
    .replace(/^[\\/]+/, "")
    .replace(/^books(?:[\\/]|$)/i, "");
  if (!normalized) {
    throw new Error("Invalid bookId: empty value.");
  }
  if (/[\\/]/.test(normalized)) {
    throw new Error(`Invalid bookId "${bookId}". bookId must not contain path separators.`);
  }
  return normalized;
}

const REVISION_INTENT_RE = /(修订|重订|修改|改写|重写|润色|精修|polish|rewrite|rework|revise|spot-fix|anti-detect|fix)/i;
const REWRITE_INTENT_RE = /(重写|rewrite|rework)/i;

function inferSubAgentFromInstruction(instruction: string): Static<typeof SubAgentParams>["agent"] | undefined {
  const text = instruction.trim().toLowerCase();
  if (!text) return undefined;
  if (/(导出|export|epub|\bmd\b|markdown|txt)/i.test(text)) return "exporter";
  if (/(审计|审核|audit)/i.test(text)) return "auditor";
  if (REVISION_INTENT_RE.test(text)) return "reviser";
  if (/(继续写|写下一章|再来一章|continue|write next|next chapter)/i.test(text)) return "writer";
  if (/(建书|创建|新书|create book|init book|architect)/i.test(text)) return "architect";
  return undefined;
}

function inferChapterNumberFromInstruction(instruction: string): number | undefined {
  const zh = instruction.match(/(?:第\s*)?(\d+)\s*章/);
  if (zh?.[1]) return parseInt(zh[1], 10);
  const en = instruction.match(/chapter\s*(\d+)/i);
  if (en?.[1]) return parseInt(en[1], 10);
  return undefined;
}

function inferChapterCountFromInstruction(instruction: string): number | undefined {
  const zh = instruction.match(/(?:连续|连写|一口气写|再写|写)\s*(\d+)\s*章/);
  if (zh?.[1]) return parseInt(zh[1], 10);
  const en = instruction.match(/(?:write|continue)\s*(\d+)\s*chapters?/i);
  if (en?.[1]) return parseInt(en[1], 10);
  return undefined;
}

function inferRevisionModeFromInstruction(instruction: string): ReviseMode {
  return REWRITE_INTENT_RE.test(instruction) ? "rewrite" : "spot-fix";
}

export function createSubAgentTool(
  pipeline: PipelineRunner,
  activeBookId: string | null,
  projectRoot?: string,
  resolveTurnInstruction?: () => string | undefined,
): AgentTool<typeof SubAgentParams> {
  return {
    name: "sub_agent",
    description:
      "Delegate a heavy operation to a specialised sub-agent. " +
      "Use agent='architect' to initialise a new book, 'writer' to write the next chapter, " +
      "'auditor' to audit quality, 'reviser' to revise a chapter, 'exporter' to export.",
    label: "Sub-Agent",
    parameters: SubAgentParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof SubAgentParams>,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<undefined>> {
      const { agent, instruction: rawInstruction, bookId, title, chapterNumber, chapterCount, genre, platform, language, targetChapters, chapterWordCount, mode, format, approvedOnly } = params;
      const fallbackInstruction = resolveTurnInstruction?.()?.trim() ?? "";
      const instruction = rawInstruction?.trim() || fallbackInstruction;
      const resolvedAgent = agent ?? inferSubAgentFromInstruction(instruction);
      const resolvedChapterNumber = chapterNumber ?? inferChapterNumberFromInstruction(instruction);
      const resolvedChapterCount = chapterCount ?? inferChapterCountFromInstruction(instruction);
      let resolvedBookId: string | undefined;

      const progress = (msg: string) => {
        onUpdate?.(textResult(msg));
      };

      try {
        resolvedBookId = normalizeBookIdInput(bookId) ?? normalizeBookIdInput(activeBookId ?? undefined);
      } catch (err: any) {
        return textResult(err?.message ?? String(err));
      }

      try {
        if (!rawInstruction?.trim() && instruction) {
          progress("sub_agent call omitted instruction; recovered from current user request.");
        }
        if (!agent && resolvedAgent) {
          progress(`sub_agent call omitted agent; inferred agent="${resolvedAgent}".`);
        }
        if (chapterNumber === undefined && resolvedChapterNumber !== undefined) {
          progress(`sub_agent call omitted chapterNumber; inferred chapterNumber=${resolvedChapterNumber}.`);
        }
        if (chapterCount === undefined && resolvedChapterCount !== undefined) {
          progress(`sub_agent call omitted chapterCount; inferred chapterCount=${resolvedChapterCount}.`);
        }

        if (!resolvedAgent) {
          return textResult(
            "Error: agent is required for sub_agent. Use one of: architect, writer, auditor, reviser, exporter.",
          );
        }
        switch (resolvedAgent) {
          case "architect": {
            if (resolvedBookId) {
              return textResult("当前已有书籍，不需要建书。如果你想创建新书，请先回到首页。");
            }
            const resolvedTitle = title?.trim();
            if (!resolvedTitle) {
              return textResult('Error: title is required for the architect agent.');
            }
            const id = normalizeBookIdInput(bookId) || deriveBookIdFromTitle(resolvedTitle) || `book-${Date.now().toString(36)}`;
            const now = new Date().toISOString();
            progress(`Starting architect for book "${id}"...`);
            await pipeline.initBook(
              {
                id,
                title: resolvedTitle,
                genre: genre ?? "general",
                platform: (platform ?? "other") as any,
                language: (language ?? "zh") as any,
                status: "outlining" as any,
                targetChapters: targetChapters ?? 200,
                chapterWordCount: chapterWordCount ?? 3000,
                createdAt: now,
                updatedAt: now,
              },
              { externalContext: instruction },
            );
            progress(`Architect finished — book "${id}" foundation created.`);
            return textResult(`Book "${resolvedTitle}" (${id}) initialised successfully. Foundation files are ready.`);
          }

          case "writer": {
            if (!resolvedBookId) return textResult("Error: bookId is required for the writer agent.");
            if (instruction && resolvedChapterNumber !== undefined && REVISION_INTENT_RE.test(instruction)) {
              const reroutedMode: ReviseMode = (mode as ReviseMode) ?? inferRevisionModeFromInstruction(instruction);
              progress(
                `Detected chapter-revision instruction; rerouting to reviser for chapter ${resolvedChapterNumber} (${reroutedMode}).`,
              );
              await pipeline.reviseDraft(resolvedBookId, resolvedChapterNumber, reroutedMode);
              progress(`Revision complete for "${resolvedBookId}".`);
              return textResult(
                `Revision (${reroutedMode}) complete for "${resolvedBookId}" chapter ${resolvedChapterNumber}.`,
              );
            }
            const batchCount = Math.max(1, resolvedChapterCount ?? 1);
            if (batchCount === 1) {
              progress(`Writing next chapter for "${resolvedBookId}"...`);
              const result = await pipeline.writeNextChapter(resolvedBookId, chapterWordCount);
              progress(`Writer finished chapter for "${resolvedBookId}".`);
              return textResult(
                `Chapter written for "${resolvedBookId}". ` +
                `Word count: ${(result as any).wordCount ?? "unknown"}.`,
              );
            }

            progress(`Writing ${batchCount} consecutive chapters for "${resolvedBookId}"...`);
            let completed = 0;
            let firstChapterNumber: number | null = null;
            let lastChapterNumber: number | null = null;
            let totalWords = 0;
            while (completed < batchCount) {
              try {
                const result = await pipeline.writeNextChapter(resolvedBookId, chapterWordCount);
                completed += 1;
                const chapterNum = Number((result as any).chapterNumber ?? 0);
                const words = Number((result as any).wordCount ?? 0);
                if (firstChapterNumber === null && Number.isFinite(chapterNum) && chapterNum > 0) {
                  firstChapterNumber = chapterNum;
                }
                if (Number.isFinite(chapterNum) && chapterNum > 0) {
                  lastChapterNumber = chapterNum;
                }
                if (Number.isFinite(words) && words > 0) {
                  totalWords += words;
                }
                progress(
                  `Writer progress ${completed}/${batchCount}: chapter ${Number.isFinite(chapterNum) && chapterNum > 0 ? chapterNum : "unknown"} (${Number.isFinite(words) && words > 0 ? words : "unknown"} words).`,
                );
              } catch (error: any) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`Batch write failed after ${completed}/${batchCount} chapters: ${message}`);
              }
            }
            progress(`Writer batch finished for "${resolvedBookId}".`);
            return textResult(
              `Batch write complete for "${resolvedBookId}": ${completed} chapters` +
              (firstChapterNumber && lastChapterNumber ? ` (chapter ${firstChapterNumber}-${lastChapterNumber})` : "") +
              (totalWords > 0 ? `, ${totalWords} words total.` : "."),
            );
          }

          case "auditor": {
            if (!resolvedBookId) return textResult("Error: bookId is required for the auditor agent.");
            progress(`Auditing chapter ${resolvedChapterNumber ?? "latest"} for "${resolvedBookId}"...`);
            const audit = await pipeline.auditDraft(resolvedBookId, resolvedChapterNumber);
            const auditIssues = Array.isArray(audit.issues) ? audit.issues : [];
            progress(`Audit complete for "${resolvedBookId}".`);
            return textResult(buildSubAgentAuditReport({
              chapterNumber: audit.chapterNumber ?? resolvedChapterNumber ?? 0,
              passed: audit.passed,
              summary: audit.summary,
              issues: auditIssues,
            }));
          }

          case "reviser": {
            if (!resolvedBookId) return textResult("Error: bookId is required for the reviser agent.");
            const resolvedMode: ReviseMode = (mode as ReviseMode) ?? "spot-fix";
            progress(`Revising "${resolvedBookId}" chapter ${resolvedChapterNumber ?? "latest"} in ${resolvedMode} mode...`);
            await pipeline.reviseDraft(resolvedBookId, resolvedChapterNumber, resolvedMode);
            progress(`Revision complete for "${resolvedBookId}".`);
            return textResult(`Revision (${resolvedMode}) complete for "${resolvedBookId}" chapter ${resolvedChapterNumber ?? "latest"}.`);
          }

          case "exporter": {
            if (!resolvedBookId) return textResult("Error: bookId is required for the exporter agent.");
            if (!projectRoot) return textResult("Error: exporter requires projectRoot.");
            const inferredFormat = format ?? (/epub/i.test(instruction)
              ? "epub"
              : /markdown|\bmd\b/i.test(instruction)
                ? "md"
                : "txt");
            const exportApprovedOnly = approvedOnly ?? /approved|已通过|通过章节/.test(instruction);
            const state = new StateManager(projectRoot);
            const result = await writeExportArtifact(state, resolvedBookId, {
              format: inferredFormat,
              approvedOnly: exportApprovedOnly,
            });
            return textResult(
              `Exported "${resolvedBookId}": ${result.chaptersExported} chapters, ${result.totalWords} words → ${result.outputPath}`,
            );
          }

          default:
            return textResult(`Unknown agent: ${resolvedAgent}`);
        }
      } catch (err: any) {
        console.error(`[sub_agent] "${resolvedAgent}" failed:`, err);
        if (err instanceof Error) {
          throw err;
        }
        throw new Error(`Sub-agent "${resolvedAgent}" failed: ${err?.message ?? String(err)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Deterministic writing tools
// ---------------------------------------------------------------------------

const WriteTruthFileParams = Type.Object({
  bookId: Type.Optional(Type.String({ description: "Book ID. Omit to use the active book." })),
  fileName: Type.String({ description: "Truth file name under story/, e.g. story_bible.md or current_focus.md." }),
  content: Type.String({ description: "Full replacement content for the truth file." }),
});

export function createWriteTruthFileTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  activeBookId: string | null,
): AgentTool<typeof WriteTruthFileParams> {
  const tools = createDeterministicInteractionTools(pipeline, projectRoot);
  return {
    name: "write_truth_file",
    description: "Replace a truth/control file under story/ using deterministic project tools.",
    label: "Write Truth File",
    parameters: WriteTruthFileParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
      const bookId = resolveToolBookId("write_truth_file", params.bookId, activeBookId);
      await tools.writeTruthFile(bookId, params.fileName, params.content);
      return textResult(`Updated "${params.fileName}" for "${bookId}".`);
    },
  };
}

const RenameEntityParams = Type.Object({
  bookId: Type.Optional(Type.String({ description: "Book ID. Omit to use the active book." })),
  oldValue: Type.String({ description: "Current entity name." }),
  newValue: Type.String({ description: "New entity name." }),
});

export function createRenameEntityTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  activeBookId: string | null,
): AgentTool<typeof RenameEntityParams> {
  const tools = createDeterministicInteractionTools(pipeline, projectRoot);
  return {
    name: "rename_entity",
    description: "Rename an entity across truth files and chapters using deterministic edit control.",
    label: "Rename Entity",
    parameters: RenameEntityParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
      const bookId = resolveToolBookId("rename_entity", params.bookId, activeBookId);
      const result = await tools.renameEntity(bookId, params.oldValue, params.newValue) as {
        readonly __interaction?: { readonly responseText?: string };
      };
      const summary = result.__interaction?.responseText ?? `Renamed "${params.oldValue}" to "${params.newValue}" in "${bookId}".`;
      return textResult(summary);
    },
  };
}

const PatchChapterTextParams = Type.Object({
  bookId: Type.Optional(Type.String({ description: "Book ID. Omit to use the active book." })),
  chapterNumber: Type.Number({ description: "Chapter number to patch." }),
  targetText: Type.String({ description: "Exact text to replace." }),
  replacementText: Type.String({ description: "Replacement text." }),
});

export function createPatchChapterTextTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  activeBookId: string | null,
): AgentTool<typeof PatchChapterTextParams> {
  const tools = createDeterministicInteractionTools(pipeline, projectRoot);
  return {
    name: "patch_chapter_text",
    description: "Apply a deterministic local text patch to a chapter and mark it for review.",
    label: "Patch Chapter",
    parameters: PatchChapterTextParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
      const bookId = resolveToolBookId("patch_chapter_text", params.bookId, activeBookId);
      const result = await tools.patchChapterText(
        bookId,
        params.chapterNumber,
        params.targetText,
        params.replacementText,
      ) as {
        readonly __interaction?: { readonly responseText?: string };
      };
      const summary = result.__interaction?.responseText ?? `Patched chapter ${params.chapterNumber} for "${bookId}".`;
      return textResult(summary);
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Read Tool
// ---------------------------------------------------------------------------

const ReadParams = Type.Object({
  path: Type.String({ description: "File path relative to books/, e.g. {bookId}/story/story_bible.md" }),
});

export function createReadTool(projectRoot: string): AgentTool<typeof ReadParams> {
  const booksRoot = join(projectRoot, "books");

  return {
    name: "read",
    description: "Read a file from the book directory. Path is relative to books/.",
    label: "Read File",
    parameters: ReadParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof ReadParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const filePath = safeBooksPath(booksRoot, params.path);
        let content = await readFile(filePath, "utf-8");
        if (content.length > 10_000) {
          content = content.slice(0, 10_000) + "\n\n... [truncated at 10 000 chars]";
        }
        return textResult(content);
      } catch (err: any) {
        return textResult(`Failed to read "${params.path}": ${err?.message ?? String(err)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Edit Tool
// ---------------------------------------------------------------------------

const EditParams = Type.Object({
  path: Type.String({ description: "File path relative to books/" }),
  old_string: Type.String({ description: "Exact string to find in the file" }),
  new_string: Type.String({ description: "Replacement string" }),
});

export function createEditTool(projectRoot: string): AgentTool<typeof EditParams> {
  const booksRoot = join(projectRoot, "books");

  return {
    name: "edit",
    description:
      "Edit a file under books/ via exact string replacement. " +
      "old_string must appear exactly once in the file. " +
      "For chapter text use patch_chapter_text; for canonical truth files (story_bible/volume_outline/book_rules/current_focus) prefer write_truth_file; " +
      "to rewrite or polish a whole chapter call sub_agent with agent=\"reviser\".",
    label: "Edit File",
    parameters: EditParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof EditParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const filePath = safeBooksPath(booksRoot, params.path);
        const content = await readFile(filePath, "utf-8");
        const idx = content.indexOf(params.old_string);
        if (idx === -1) {
          return textResult(`old_string not found in "${params.path}".`);
        }
        if (content.indexOf(params.old_string, idx + 1) !== -1) {
          return textResult(`old_string appears more than once in "${params.path}". Provide a more specific match.`);
        }
        const updated = content.slice(0, idx) + params.new_string + content.slice(idx + params.old_string.length);
        await writeFile(filePath, updated, "utf-8");
        return textResult(`File "${params.path}" updated successfully.`);
      } catch (err: any) {
        return textResult(`Failed to edit "${params.path}": ${err?.message ?? String(err)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Write Tool
// ---------------------------------------------------------------------------

const WriteFileParams = Type.Object({
  path: Type.String({ description: "File path relative to books/" }),
  content: Type.String({ description: "Full file content to write" }),
});

export function createWriteFileTool(projectRoot: string): AgentTool<typeof WriteFileParams> {
  const booksRoot = join(projectRoot, "books");

  return {
    name: "write",
    description:
      "Create a new file, or fully replace an existing file's content under books/. " +
      "Parent directories are created automatically. Existing content is overwritten silently — " +
      "for canonical truth files prefer write_truth_file; " +
      "for whole-chapter rewrites/polishing call sub_agent with agent=\"reviser\".",
    label: "Write File",
    parameters: WriteFileParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof WriteFileParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const filePath = safeBooksPath(booksRoot, params.path);
        const parentDir = resolve(filePath, "..");
        const { mkdir } = await import("node:fs/promises");
        await mkdir(parentDir, { recursive: true });
        await writeFile(filePath, params.content, "utf-8");
        return textResult(`File "${params.path}" written successfully.`);
      } catch (err: any) {
        return textResult(`Failed to write "${params.path}": ${err?.message ?? String(err)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Grep Tool
// ---------------------------------------------------------------------------

const GrepParams = Type.Object({
  bookId: Type.String({ description: "Book ID to search within" }),
  pattern: Type.String({ description: "Search pattern (plain text or regex)" }),
});

export function createGrepTool(projectRoot: string): AgentTool<typeof GrepParams> {
  const booksRoot = join(projectRoot, "books");

  return {
    name: "grep",
    description:
      "Search for a text pattern across a book's story/ and chapters/ directories. Returns matching lines.",
    label: "Search",
    parameters: GrepParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof GrepParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const bookDir = safeBooksPath(booksRoot, params.bookId);
        const regex = new RegExp(params.pattern, "gi");
        const results: string[] = [];

        async function searchDir(dir: string, prefix: string) {
          let entries: string[];
          try {
            entries = await readdir(dir);
          } catch {
            return; // directory doesn't exist
          }
          for (const entry of entries) {
            const fullPath = join(dir, entry);
            const entryStat = await stat(fullPath);
            if (entryStat.isDirectory()) {
              await searchDir(fullPath, `${prefix}${entry}/`);
            } else if (entry.endsWith(".md") || entry.endsWith(".txt") || entry.endsWith(".json")) {
              const content = await readFile(fullPath, "utf-8");
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  results.push(`${prefix}${entry}:${i + 1}: ${lines[i]}`);
                  regex.lastIndex = 0; // reset for next test
                }
              }
            }
          }
        }

        await Promise.all([
          searchDir(join(bookDir, "story"), "story/"),
          searchDir(join(bookDir, "chapters"), "chapters/"),
        ]);

        if (results.length === 0) {
          return textResult(`No matches for "${params.pattern}" in book "${params.bookId}".`);
        }

        const truncated = results.length > 100
          ? results.slice(0, 100).join("\n") + `\n\n... [${results.length - 100} more matches]`
          : results.join("\n");

        return textResult(truncated);
      } catch (err: any) {
        return textResult(`Grep failed: ${err?.message ?? String(err)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Ls Tool
// ---------------------------------------------------------------------------

const LsParams = Type.Object({
  bookId: Type.String({ description: "Book ID" }),
  subdir: Type.Optional(
    Type.String({ description: "Subdirectory within the book, e.g. 'story', 'chapters', 'story/runtime'" }),
  ),
});

export function createLsTool(projectRoot: string): AgentTool<typeof LsParams> {
  const booksRoot = join(projectRoot, "books");

  return {
    name: "ls",
    description: "List files in a book directory. Optionally specify a subdirectory like 'story' or 'chapters'.",
    label: "List Files",
    parameters: LsParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof LsParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const base = safeBooksPath(booksRoot, params.bookId);
        const target = params.subdir ? safeBooksPath(base, params.subdir) : base;

        const entries = await readdir(target);
        const details: string[] = [];

        for (const entry of entries) {
          const fullPath = join(target, entry);
          try {
            const entryStat = await stat(fullPath);
            const suffix = entryStat.isDirectory() ? "/" : ` (${entryStat.size} bytes)`;
            details.push(`${entry}${suffix}`);
          } catch {
            details.push(entry);
          }
        }

        if (details.length === 0) {
          return textResult(`Directory is empty: ${params.bookId}/${params.subdir ?? ""}`);
        }

        return textResult(details.join("\n"));
      } catch (err: any) {
        return textResult(`Failed to list "${params.bookId}/${params.subdir ?? ""}": ${err?.message ?? String(err)}`);
      }
    },
  };
}
