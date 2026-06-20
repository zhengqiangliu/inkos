import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  InteractionEvent,
  Logger,
  PipelineRunner,
  StateManager,
  ReviseMode,
  LLMClient,
  BookConfig,
  Platform,
  ToolDefinition,
} from "../index.js";
import { chatCompletion, chatWithTools } from "../index.js";
import { readGenreProfile } from "../agents/rules-reader.js";
import { executeEditTransaction } from "./edit-controller.js";
import type { InteractionRuntimeTools } from "./runtime.js";
import {
  extractIntroCharacterNameHints,
  syncIntroCharacterNames,
  type BookCreationDraft,
  type BookCreationWizardStep,
} from "./session.js";
import type { ParsedGenreProfile } from "../models/genre-profile.js";
import { writeExportArtifact } from "./export-artifact.js";

type PipelineLike = Pick<PipelineRunner, "writeNextChapter" | "reviseDraft"> & {
    readonly initBook?: (
      book: BookConfig,
      options?: {
        readonly externalContext?: string;
        readonly authorIntent?: string;
        readonly currentFocus?: string;
        readonly foundationBrief?: string;
      },
    ) => Promise<void>;
};
type StateLike = Pick<StateManager, "ensureControlDocuments" | "bookDir" | "loadBookConfig" | "loadChapterIndex" | "saveChapterIndex" | "listBooks">;
type InstrumentablePipelineLike = PipelineLike & {
  readonly config?: {
    logger?: Logger;
    client?: LLMClient;
    model?: string;
    projectRoot?: string;
  };
};

interface WizardGenreContext {
  readonly profile: ParsedGenreProfile["profile"];
  readonly body: string;
}

function normalizePlatform(platform?: string): Platform {
  switch (platform) {
    case "tomato":
    case "feilu":
    case "qidian":
      return platform;
    default:
      return "other";
  }
}

function deriveBookId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 30);
}

function buildBookConfig(input: {
  readonly title: string;
  readonly genre?: string;
  readonly platform?: string;
  readonly language?: "zh" | "en";
  readonly chapterWordCount?: number;
  readonly targetChapters?: number;
}): BookConfig {
  const now = new Date().toISOString();
  return {
    id: deriveBookId(input.title),
    title: input.title,
    platform: normalizePlatform(input.platform),
    genre: input.genre ?? "other",
    status: "outlining",
    creationState: "ready",
    targetChapters: input.targetChapters ?? 200,
    chapterWordCount: input.chapterWordCount ?? 3000,
    ...(input.language ? { language: input.language } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function buildCreationExternalContext(input: {
  readonly blurb?: string;
  readonly storyBackground?: string;
}): string | undefined {
  const sections = [
    input.storyBackground ? `## 故事背景\n${input.storyBackground}` : undefined,
    input.blurb ? `## 简介卖点\n${input.blurb}` : undefined,
  ].filter((section): section is string => Boolean(section?.trim()));

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join("\n\n");
}

function buildIntroCharacterNameConstraintBlock(input?: {
  readonly blurb?: string;
  readonly storyBackground?: string;
  readonly introMarkdown?: string;
  readonly draftFields?: Readonly<Record<string, string>>;
  readonly protagonist?: string;
  readonly supportingCast?: string;
  readonly introCharacterNames?: ReadonlyArray<string>;
}): string | undefined {
  const names = extractIntroCharacterNameHints(input);
  if (names.length === 0) return undefined;
  return [
    "## 简介已约定角色名",
    `- 角色名：${names.join("、")}`,
    "- 后续所有向导页必须沿用这些角色名称，不得擅自改名、替换、合并角色或新增别名，除非用户明确要求。",
    "- 如果当前页需要补主角、配角、卷纲、大纲、人物弧光或人物关系，请优先围绕这些已约定角色展开。",
  ].join("\n");
}

function parseIntroMarkdownDraft(input: string): { readonly blurb: string; readonly storyBackground: string } {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { blurb: "", storyBackground: "" };

  let blurb = "";
  let storyBackground = "";
  let current: "blurb" | "storyBackground" = "blurb";

  const write = (text: string) => {
    if (!text) return;
    if (current === "blurb") {
      blurb = blurb ? `${blurb} ${text}` : text;
    } else {
      storyBackground = storyBackground ? `${storyBackground} ${text}` : text;
    }
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s*(.+)$/);
    if (headingMatch?.[1]) {
      const heading = headingMatch[1].trim().toLowerCase();
      if (/(一句话卖点|简介\/卖点|简介|卖点|one-line hook|hook)/i.test(heading)) {
        current = "blurb";
        continue;
      }
      if (/(故事背景|背景|story background)/i.test(heading)) {
        current = "storyBackground";
        continue;
      }
      continue;
    }

    const normalized = line.replace(/[：:]\s*/g, ":");
    if (/^(简介\/卖点|简介|卖点|一句话卖点|one-line hook|hook):/i.test(normalized)) {
      current = "blurb";
      write(normalized.replace(/^(简介\/卖点|简介|卖点|一句话卖点|one-line hook|hook):\s*/i, ""));
      continue;
    }
    if (/^(故事背景|背景|story background):/i.test(normalized)) {
      current = "storyBackground";
      write(normalized.replace(/^(故事背景|背景|story background):\s*/i, ""));
      continue;
    }
    write(line);
  }

  return { blurb: blurb.trim(), storyBackground: storyBackground.trim() };
}

function extractIntroTitleFromMarkdown(input: string): string | undefined {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const heading = line.match(/^#\s*(.+)$/);
    if (heading?.[1]?.trim()) return heading[1].trim();
    const titleLine = line.match(/^(?:title|书名)[:=：]\s*(.+)$/i);
    if (titleLine?.[1]?.trim()) return titleLine[1].trim();
  }
  return undefined;
}

function parseIntroRevisionOutput(input: string): {
  readonly title?: string;
  readonly blurb?: string;
  readonly storyBackground?: string;
  readonly body: string;
} {
  const lines = input.split(/\r?\n/);
  const bodyLines: string[] = [];
  let title: string | undefined;
  let blurb: string | undefined;
  let storyBackground: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      bodyLines.push(line);
      continue;
    }

    const match = trimmed.match(/^(title|书名|blurb|storyBackground|introMarkdown)\s*[:：]\s*(.*)$/i);
    if (match) {
      const key = match[1]!.toLowerCase();
      const value = match[2]?.trim() ?? "";
      if ((key === "title" || key === "书名") && value) title = value;
      if (key === "blurb" && value) blurb = value;
      if (key === "storybackground" && value) storyBackground = value;
      if (key === "intromarkdown" && value) bodyLines.push(value);
      continue;
    }

    bodyLines.push(line);
  }

  return {
    ...(title ? { title } : {}),
    ...(blurb ? { blurb } : {}),
    ...(storyBackground ? { storyBackground } : {}),
    body: bodyLines.join("\n").trim(),
  };
}

type IntroNarrativeField =
  | "title"
  | "blurb"
  | "storyBackground"
  | "plotDirection"
  | "characterGrowth"
  | "coreConflict"
  | "coreValue"
  | "style"
  | "protagonist"
  | "hook";

const INTRO_NARRATIVE_LABELS: ReadonlyArray<{
  readonly aliases: ReadonlyArray<string>;
  readonly field: IntroNarrativeField;
}> = [
  { aliases: ["候选书名", "推荐书名", "书名"], field: "title" },
  { aliases: ["一句话爆款卖点", "一句话爆点", "一句话卖点", "核心卖点", "卖点"], field: "blurb" },
  { aliases: ["故事概述", "故事梗概", "故事背景", "背景"], field: "storyBackground" },
  { aliases: ["故事走向", "故事主线", "剧情主线", "主线设计", "剧情走向"], field: "plotDirection" },
  { aliases: ["主要人物成长路径", "人物成长路径", "人物成长", "主角成长", "角色成长", "成长路径"], field: "characterGrowth" },
  { aliases: ["核心冲突", "主要冲突", "冲突焦点", "矛盾焦点"], field: "coreConflict" },
  { aliases: ["核心价值观", "价值观", "立意", "主题表达"], field: "coreValue" },
  { aliases: ["赛道定位", "题材定位", "风格定位"], field: "style" },
  { aliases: ["主角人设", "核心人设", "主角设定", "人物设定"], field: "protagonist" },
  { aliases: ["开篇钩子", "引爆点", "矛盾引爆点", "爽点设计", "情感张力"], field: "hook" },
];

const INTRO_NARRATIVE_LABEL_TO_FIELD = new Map<string, IntroNarrativeField>(
  INTRO_NARRATIVE_LABELS.flatMap((entry) => entry.aliases.map((alias) => [alias, entry.field] as const)),
);

const INTRO_NARRATIVE_REGEX = new RegExp(
  `(^|[\\n。！？!?；;])\\s*(${[...INTRO_NARRATIVE_LABEL_TO_FIELD.keys()]
    .sort((a, b) => b.length - a.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\\s*[：:]\\s*`,
  "g",
);

function normalizeNarrativeIntroValue(text: string): string {
  return text
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function joinNarrativeIntroParts(parts: ReadonlyArray<string>): string {
  const unique = Array.from(new Set(parts.map((part) => normalizeNarrativeIntroValue(part)).filter(Boolean)));
  return unique.join("\n\n").trim();
}

function buildMeaningfulIntroBodyMarkdown(params: {
  readonly title?: string;
  readonly blurb?: string;
  readonly storyBackground?: string;
  readonly plotDirection?: string;
  readonly characterGrowth?: string;
  readonly coreConflict?: string;
  readonly coreValue?: string;
}): string {
  const sections = [
    params.blurb?.trim() ? `## 一句话卖点\n${params.blurb.trim()}` : undefined,
    params.storyBackground?.trim() ? `## 故事概述\n${params.storyBackground.trim()}` : undefined,
    params.plotDirection?.trim() ? `## 故事走向\n${params.plotDirection.trim()}` : undefined,
    params.characterGrowth?.trim() ? `## 主要人物成长路径\n${params.characterGrowth.trim()}` : undefined,
    params.coreConflict?.trim() ? `## 核心冲突\n${params.coreConflict.trim()}` : undefined,
    params.coreValue?.trim() ? `## 核心价值观\n${params.coreValue.trim()}` : undefined,
  ].filter((section): section is string => Boolean(section));
  if (sections.length < 4) {
    return "";
  }
  return ["# 简介正文", ...sections].join("\n\n").trim();
}

function synthesizeIntroMarkdownFromNarrative(input: string): string {
  const source = input.trim();
  if (!source) return "";

  const matches = Array.from(source.matchAll(INTRO_NARRATIVE_REGEX));
  if (matches.length < 4) {
    return "";
  }

  const buckets: Record<Exclude<IntroNarrativeField, "title">, string[]> = {
    blurb: [],
    storyBackground: [],
    plotDirection: [],
    characterGrowth: [],
    coreConflict: [],
    coreValue: [],
    style: [],
    protagonist: [],
    hook: [],
  };
  let title = "";

  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const alias = current?.[2]?.trim() ?? "";
    const field = INTRO_NARRATIVE_LABEL_TO_FIELD.get(alias);
    if (!field) continue;
    const valueStart = (current?.index ?? 0) + current?.[0].length;
    const valueEnd = matches[i + 1]?.index ?? source.length;
    const value = normalizeNarrativeIntroValue(source.slice(valueStart, valueEnd));
    if (!value) continue;
    if (field === "title") {
      if (!title) title = value;
      continue;
    }
    buckets[field].push(value);
  }

  const blurb = joinNarrativeIntroParts([
    ...buckets.blurb,
    ...(buckets.blurb.length === 0 ? buckets.style.slice(0, 1) : []),
    ...(buckets.blurb.length === 0 ? buckets.hook.slice(0, 1) : []),
  ]);
  const storyBackground = joinNarrativeIntroParts([
    ...buckets.storyBackground,
    ...(buckets.storyBackground.length === 0 ? buckets.protagonist.slice(0, 1) : []),
    ...(buckets.storyBackground.length === 0 ? buckets.hook.slice(0, 1) : []),
  ]);
  const plotDirection = joinNarrativeIntroParts([
    ...buckets.plotDirection,
    ...(buckets.plotDirection.length === 0 ? buckets.hook.slice(0, 1) : []),
  ]);
  const characterGrowth = joinNarrativeIntroParts([
    ...buckets.characterGrowth,
    ...(buckets.characterGrowth.length === 0 ? buckets.protagonist.slice(0, 1) : []),
  ]);
  const coreConflict = joinNarrativeIntroParts([
    ...buckets.coreConflict,
    ...(buckets.coreConflict.length === 0 ? buckets.hook.slice(0, 1) : []),
  ]);
  const coreValue = joinNarrativeIntroParts([
    ...buckets.coreValue,
    ...(buckets.coreValue.length === 0 ? buckets.style.slice(0, 1) : []),
  ]);

  const markdown = buildMeaningfulIntroBodyMarkdown({
    title,
    blurb,
    storyBackground,
    plotDirection,
    characterGrowth,
    coreConflict,
    coreValue,
  });
  return hasMeaningfulIntroMarkdown(markdown) ? markdown : "";
}

function findIntroBodyStartIndex(input: string): number {
  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    const remaining = lines.slice(i).join("\n").trim();
    if (looksLikeIntroBodyMarkdown(remaining)) {
      return i;
    }
  }
  return -1;
}

function extractIntroMarkdownBody(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (looksLikeIntroBodyMarkdown(trimmed)) {
    return trimmed;
  }
  const startIndex = findIntroBodyStartIndex(trimmed);
  if (startIndex < 0) {
    return "";
  }
  return trimmed.split(/\r?\n/).slice(startIndex).join("\n").trim();
}

export function normalizeIntroRevisionOutput(input: string): string {
  const parsed = parseIntroRevisionOutput(input);
  const body = extractIntroMarkdownBody(parsed.body);
  if (body && looksLikeIntroBodyMarkdown(body)) {
    return dedupeIntroMarkdownSections(body);
  }
  const extractedFromRaw = extractIntroMarkdownBody(input);
  if (extractedFromRaw && looksLikeIntroBodyMarkdown(extractedFromRaw)) {
    return dedupeIntroMarkdownSections(extractedFromRaw);
  }
  const synthesized = synthesizeIntroMarkdownFromNarrative(input);
  if (synthesized) {
    return dedupeIntroMarkdownSections(synthesized);
  }
  return "";
}

function dedupeIntroMarkdownSections(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return trimmed;

  const dedupeTitles = new Set([
    "一句话卖点",
    "故事概述",
    "故事走向",
    "主要人物成长路径",
    "核心冲突",
    "核心价值观",
  ]);
  const lines = trimmed.split(/\r?\n/);
  const output: string[] = [];
  const seen = new Set<string>();
  let skippingDuplicateSection = false;
  let skipHeadingLevel = 0;

  for (const line of lines) {
    const trimmedLine = line.trim();
    const headingMatch = trimmedLine.match(/^(#{1,6})\s*(.+)$/);
    if (skippingDuplicateSection) {
      if (!headingMatch) {
        continue;
      }
      const headingLevel = headingMatch[1]!.length;
      if (headingLevel > skipHeadingLevel) {
        continue;
      }
      skippingDuplicateSection = false;
    }

    if (headingMatch) {
      const headingLevel = headingMatch[1]!.length;
      const headingTitle = headingMatch[2]!.trim();
      if (headingLevel === 2 && dedupeTitles.has(headingTitle)) {
        if (seen.has(headingTitle)) {
          skippingDuplicateSection = true;
          skipHeadingLevel = headingLevel;
          continue;
        }
        seen.add(headingTitle);
      }
    }

    output.push(line);
  }

  return output.join("\n").trim();
}

function looksLikeIntroBodyMarkdown(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/^(已|好的|我来|我先|正在|开始|生成|修改|润色|总结|汇报|说明)/.test(trimmed)) return false;
  return /(^|\n)\s*#\s+/.test(trimmed)
    || /(^|\n)\s*##\s+(一句话卖点|故事概述|故事走向|主要人物成长路径|核心冲突|核心价值观)/.test(trimmed);
}

function hasMeaningfulIntroMarkdown(content: string): boolean {
  const trimmed = content.trim();
  if (!looksLikeIntroBodyMarkdown(trimmed)) return false;
  const requiredSections = [
    "一句话卖点",
    "故事概述",
    "故事走向",
    "主要人物成长路径",
    "核心冲突",
    "核心价值观",
  ];
  const sectionCount = requiredSections.filter((section) => trimmed.includes(section)).length;
  const meaningfulBodyLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line
      && !/^#/.test(line)
      && !/^-+\s*$/.test(line)
      && line !== "-"
      && line !== "—"
      && line !== "…"
      && line !== "..."
      && !/^(题材|平台|主题)[:：]/.test(line),
    );
  const substantiveLines = meaningfulBodyLines.filter((line) => line.length >= 8);
  return sectionCount >= 4 && substantiveLines.length >= 4;
}

function scoreIntroMarkdownCandidate(content: string): number {
  const trimmed = content.trim();
  if (!looksLikeIntroBodyMarkdown(trimmed)) return Number.NEGATIVE_INFINITY;
  const requiredSections = [
    "一句话卖点",
    "故事概述",
    "故事走向",
    "主要人物成长路径",
    "核心冲突",
    "核心价值观",
  ];
  const sectionCount = requiredSections.filter((section) => trimmed.includes(section)).length;
  const concreteLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line
      && !/^#/.test(line)
      && !/^-+\s*$/.test(line)
      && line !== "-"
      && line !== "—"
      && line !== "…"
      && line !== "..."
      && !/^(题材|平台|主题)[:：]/.test(line),
    );
  const substantiveCount = concreteLines.filter((line) => line.length >= 8).length;
  const placeholderCount = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line === "-" || line === "—" || line === "…" || line === "..." || /^-\s*$/.test(line))
    .length;
  return sectionCount * 100 + substantiveCount * 12 + Math.min(500, trimmed.length / 2) - placeholderCount * 40;
}

function normalizeIntroMarkdownCandidate(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  if (looksLikeIntroBodyMarkdown(trimmed)) return trimmed;
  const startIndex = findIntroBodyStartIndex(trimmed);
  if (startIndex < 0) return "";
  return trimmed.split(/\r?\n/).slice(startIndex).join("\n").trim();
}

export function pickBestIntroMarkdownCandidate(candidates: ReadonlyArray<string | null | undefined>): string {
  let best = "";
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const normalized = normalizeIntroMarkdownCandidate(candidate?.trim() ?? "");
    if (!normalized) continue;
    const score = scoreIntroMarkdownCandidate(normalized);
    if (score > bestScore) {
      best = normalized;
      bestScore = score;
    }
  }
  return best;
}

export function buildFallbackIntroRevisionOutput(parsed: {
  readonly title?: string;
  readonly blurb?: string;
  readonly storyBackground?: string;
}): string {
  return buildIntroBodyMarkdown({
    title: parsed.title,
    blurb: parsed.blurb,
    storyBackground: parsed.storyBackground,
  });
}

function createIntroRevisionStreamNormalizer(): (chunk: string) => string {
  let carry = "";
  return (chunk: string): string => {
    if (!chunk) return "";
    const combined = carry + chunk;
    const lines = combined.split(/\r?\n/);
    carry = lines.pop() ?? "";
    const output: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        output.push(line);
        continue;
      }
      const match = trimmed.match(/^(title|书名|blurb|storyBackground|introMarkdown)\s*[:：]\s*(.*)$/i);
      if (match) {
        const key = match[1]!.toLowerCase();
        const value = match[2]?.trim() ?? "";
        if (key === "intromarkdown" && value) {
          output.push(value);
        }
        continue;
      }
      output.push(line);
    }
    return output.join("\n");
  };
}

function buildIntroBodyMarkdown(params: {
  readonly title?: string;
  readonly genre?: string;
  readonly platform?: string;
  readonly theme?: string;
  readonly blurb?: string;
  readonly storyBackground?: string;
  readonly plotDirection?: string;
  readonly characterGrowth?: string;
  readonly coreConflict?: string;
  readonly coreValue?: string;
}): string {
  const sections = [
    "# 简介正文",
    params.genre?.trim() ? `- 题材：${params.genre.trim()}` : undefined,
    params.platform?.trim() ? `- 平台：${params.platform.trim()}` : undefined,
    params.theme?.trim() ? `- 主题：${params.theme.trim()}` : undefined,
    "",
    `## 一句话卖点\n${params.blurb?.trim() || "-"}`,
    `## 故事概述\n${params.storyBackground?.trim() || "-"}`,
    `## 故事走向\n${params.plotDirection?.trim() || "-"}`,
    `## 主要人物成长路径\n${params.characterGrowth?.trim() || "-"}`,
    `## 核心冲突\n${params.coreConflict?.trim() || "-"}`,
    `## 核心价值观\n${params.coreValue?.trim() || "-"}`,
  ].filter((line): line is string => Boolean(line));
  return sections.join("\n\n");
}

function stripLeadingBookTitleHeading(markdown: string, title?: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) return trimmed;
  const normalizedTitle = title?.trim();
  if (!normalizedTitle) return trimmed;
  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? "";
  if (firstLine === `# ${normalizedTitle}` || firstLine === `## ${normalizedTitle}`) {
    return lines.slice(1).join("\n").replace(/^\s*\r?\n/, "").trim();
  }
  return trimmed;
}

function normalizeWizardMarkdownOutput(
  step: BookCreationWizardStep,
  markdown: string,
  existingDraft?: BookCreationDraft,
): string {
  const trimmed = markdown.trim();
  if (!trimmed) return trimmed;
  if (step === "intro" || step === "world" || step === "outline") {
    return stripLeadingBookTitleHeading(trimmed, existingDraft?.title);
  }
  return trimmed;
}

function looksLikeWizardStepMarkdown(
  step: Exclude<BookCreationWizardStep, "intro">,
  content: string,
): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;

  switch (step) {
    case "world":
      return /(^|\n)\s*(#|##|###|[-*])?\s*(世界观|补充设定|World premise|Setting notes)/m.test(trimmed) || trimmed.length >= 40;
    case "outline":
      return /(^|\n)\s*(#|##|###|[-*])?\s*(大纲|核心冲突|小说大纲|Outline|Conflict)/m.test(trimmed) || trimmed.length >= 40;
    case "volume":
      return /(^|\n)\s*(#|##|###|[-*])?\s*(卷纲|Volume)/m.test(trimmed) || trimmed.length >= 40;
    case "characters":
      return /(^|\n)\s*(#|##|###|[-*])?\s*(主角|配角|角色矩阵|Protagonist|Supporting cast|Character matrix)/m.test(trimmed) || trimmed.length >= 40;
    case "arc":
      return /(^|\n)\s*(#|##|###|[-*])?\s*(人物弧光|Character arc)/m.test(trimmed)
        && /(^|\n)\s*(###|##|[-*]|\d+\.)\s*(核心弧光|起点状态|成长转折|终点状态)/m.test(trimmed);
    case "relation":
      return /(^|\n)\s*(#|##|###)?\s*(人物关系|Relationship map)/m.test(trimmed)
        && /(^|\n)\s*(###|##|[-*]|\d+\.)\s*(核心关系|对立关系|隐藏联系|潜在冲突|Core relationships|Opposing relationships|Hidden links|Potential conflicts)/m.test(trimmed);
  }
}

function stripWizardPreamble(
  step: Exclude<BookCreationWizardStep, "intro">,
  markdown: string,
): string {
  const trimmed = markdown.trim();
  if (!trimmed) return trimmed;

  const lines = trimmed.split(/\r?\n/);
  let startIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const candidate = lines.slice(i).join("\n").trim();
    if (!candidate) continue;
    if (looksLikeWizardStepMarkdown(step, candidate)) {
      startIndex = i;
      break;
    }
  }

  if (startIndex <= 0) return trimmed;

  const prefix = lines.slice(0, startIndex).map((line) => line.trim()).filter(Boolean);
  const hasPreambleSignal = prefix.some((line) => /^(我来|我先|先来|首先|接下来|由于|根据|基于|让我|让我们|分析|思考|推断|考虑|说明|总结|汇报|处理|正在|将要|计划|下面|如下|为了)/.test(line)
    || /思考|分析|根据|基于|推断|先看|先审|我会|我将|打算|计划|说明|总结|汇报|确认|看看/.test(line));
  if (!hasPreambleSignal) return trimmed;

  return lines.slice(startIndex).join("\n").trim();
}

function buildVolumeOutlineContext(input: {
  readonly novelOutline?: string;
  readonly conflictCore?: string;
  readonly worldPremise?: string;
  readonly settingNotes?: string;
}): string | undefined {
  const sections = [
    input.novelOutline ? `## 小说大纲\n${input.novelOutline}` : undefined,
    input.conflictCore ? `## 核心冲突\n${input.conflictCore}` : undefined,
    input.worldPremise ? `## 世界观与核心设定\n${input.worldPremise}` : undefined,
    input.settingNotes ? `## 补充设定\n${input.settingNotes}` : undefined,
  ].filter((section): section is string => Boolean(section?.trim()));

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join("\n\n");
}

function buildWorldContext(input: {
  readonly blurb?: string;
  readonly storyBackground?: string;
  readonly worldPremise?: string;
  readonly settingNotes?: string;
  readonly novelOutline?: string;
  readonly conflictCore?: string;
}): string | undefined {
  const sections = [
    input.blurb ? `## 简介 / 卖点\n${input.blurb}` : undefined,
    input.storyBackground ? `## 故事背景\n${input.storyBackground}` : undefined,
    input.worldPremise ? `## 世界观草案\n${input.worldPremise}` : undefined,
    input.settingNotes ? `## 补充设定\n${input.settingNotes}` : undefined,
    input.novelOutline ? `## 小说大纲\n${input.novelOutline}` : undefined,
    input.conflictCore ? `## 核心冲突\n${input.conflictCore}` : undefined,
  ].filter((section): section is string => Boolean(section?.trim()));

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join("\n\n");
}

function buildOutlineContext(input: {
  readonly blurb?: string;
  readonly storyBackground?: string;
  readonly worldPremise?: string;
  readonly settingNotes?: string;
  readonly novelOutline?: string;
  readonly conflictCore?: string;
  readonly protagonist?: string;
  readonly supportingCast?: string;
}): string | undefined {
  const sections = [
    input.blurb ? `## 简介 / 卖点\n${input.blurb}` : undefined,
    input.storyBackground ? `## 故事背景\n${input.storyBackground}` : undefined,
    input.worldPremise ? `## 世界观与核心设定\n${input.worldPremise}` : undefined,
    input.settingNotes ? `## 补充设定\n${input.settingNotes}` : undefined,
    input.novelOutline ? `## 小说大纲草案\n${input.novelOutline}` : undefined,
    input.conflictCore ? `## 核心冲突\n${input.conflictCore}` : undefined,
    input.protagonist ? `## 主角设定\n${input.protagonist}` : undefined,
    input.supportingCast ? `## 关键配角 / 势力\n${input.supportingCast}` : undefined,
  ].filter((section): section is string => Boolean(section?.trim()));

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join("\n\n");
}

function buildCharactersContext(input: {
  readonly blurb?: string;
  readonly storyBackground?: string;
  readonly worldPremise?: string;
  readonly settingNotes?: string;
  readonly novelOutline?: string;
  readonly conflictCore?: string;
  readonly protagonist?: string;
  readonly supportingCast?: string;
  readonly characterMatrix?: string;
}): string | undefined {
  const sections = [
    input.blurb ? `## 简介 / 卖点\n${input.blurb}` : undefined,
    input.storyBackground ? `## 故事背景\n${input.storyBackground}` : undefined,
    input.worldPremise ? `## 世界观与核心设定\n${input.worldPremise}` : undefined,
    input.settingNotes ? `## 补充设定\n${input.settingNotes}` : undefined,
    input.novelOutline ? `## 小说大纲\n${input.novelOutline}` : undefined,
    input.conflictCore ? `## 核心冲突\n${input.conflictCore}` : undefined,
    input.protagonist ? `## 主角设定\n${input.protagonist}` : undefined,
    input.supportingCast ? `## 关键配角 / 势力\n${input.supportingCast}` : undefined,
    input.characterMatrix ? `## 角色矩阵草案\n${input.characterMatrix}` : undefined,
  ].filter((section): section is string => Boolean(section?.trim()));

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join("\n\n");
}

function buildCharacterArcContext(input: {
  readonly blurb?: string;
  readonly storyBackground?: string;
  readonly characterArc?: string;
  readonly protagonist?: string;
  readonly supportingCast?: string;
  readonly conflictCore?: string;
  readonly novelOutline?: string;
  readonly volumeOutline?: string;
  readonly worldPremise?: string;
  readonly settingNotes?: string;
}): string | undefined {
  const sections = [
    input.blurb ? `## 简介 / 卖点\n${input.blurb}` : undefined,
    input.storyBackground ? `## 故事背景\n${input.storyBackground}` : undefined,
    input.characterArc ? `## 人物弧光草案\n${input.characterArc}` : undefined,
    input.protagonist ? `## 主角设定\n${input.protagonist}` : undefined,
    input.supportingCast ? `## 关键配角 / 势力\n${input.supportingCast}` : undefined,
    input.conflictCore ? `## 核心冲突\n${input.conflictCore}` : undefined,
    input.novelOutline ? `## 小说大纲\n${input.novelOutline}` : undefined,
    input.volumeOutline ? `## 卷纲规划\n${input.volumeOutline}` : undefined,
    input.worldPremise ? `## 世界观与核心设定\n${input.worldPremise}` : undefined,
    input.settingNotes ? `## 补充设定\n${input.settingNotes}` : undefined,
  ].filter((section): section is string => Boolean(section?.trim()));

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join("\n\n");
}

function buildRelationshipMapContext(input: {
  readonly blurb?: string;
  readonly storyBackground?: string;
  readonly relationshipMap?: string;
  readonly protagonist?: string;
  readonly supportingCast?: string;
  readonly characterArc?: string;
  readonly conflictCore?: string;
  readonly novelOutline?: string;
  readonly volumeOutline?: string;
  readonly worldPremise?: string;
  readonly settingNotes?: string;
}): string | undefined {
  const sections = [
    input.blurb ? `## 简介 / 卖点\n${input.blurb}` : undefined,
    input.storyBackground ? `## 故事背景\n${input.storyBackground}` : undefined,
    input.relationshipMap ? `## 人物关系草案\n${input.relationshipMap}` : undefined,
    input.protagonist ? `## 主角设定\n${input.protagonist}` : undefined,
    input.supportingCast ? `## 关键配角 / 势力\n${input.supportingCast}` : undefined,
    input.characterArc ? `## 人物弧光\n${input.characterArc}` : undefined,
    input.conflictCore ? `## 核心冲突\n${input.conflictCore}` : undefined,
    input.novelOutline ? `## 小说大纲\n${input.novelOutline}` : undefined,
    input.volumeOutline ? `## 卷纲规划\n${input.volumeOutline}` : undefined,
    input.worldPremise ? `## 世界观与核心设定\n${input.worldPremise}` : undefined,
    input.settingNotes ? `## 补充设定\n${input.settingNotes}` : undefined,
  ].filter((section): section is string => Boolean(section?.trim()));

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join("\n\n");
}

function buildWizardBaseParamsContext(input?: {
  readonly title?: string;
  readonly genre?: string;
  readonly genreAlias?: string;
  readonly mappedGenreId?: string;
  readonly platform?: string;
  readonly language?: "zh" | "en";
  readonly targetChapters?: number;
  readonly chapterWordCount?: number;
}): string | undefined {
  if (!input) return undefined;

  const themeGenre = input.genreAlias?.trim() || input.mappedGenreId?.trim() || input.genre?.trim() || "";
  const rows = [
    input.title?.trim() ? `- 书名：${input.title.trim()}` : undefined,
    input.genre?.trim() ? `- 题材：${input.genre.trim()}` : undefined,
    themeGenre ? `- 题材锚点：${themeGenre}` : undefined,
    input.platform?.trim() ? `- 平台：${input.platform.trim()}` : undefined,
    input.language?.trim() ? `- 语言：${input.language.trim()}` : undefined,
    typeof input.targetChapters === "number" ? `- 目标章数：${input.targetChapters}` : undefined,
    typeof input.chapterWordCount === "number" ? `- 每章字数：${input.chapterWordCount}` : undefined,
  ].filter((row): row is string => Boolean(row?.trim()));

  if (rows.length === 0) {
    return undefined;
  }

  return ["## 基础参数", ...rows].join("\n");
}

function resolveTruthArtifactTarget(fileName: string): { readonly dir: "story" | "wizard"; readonly fileName: string } {
  const trimmed = fileName.trim();
  if (/人物关系页\.md$/i.test(trimmed) || /relation\.md$/i.test(trimmed) || /^relationship_map\.md$/i.test(trimmed)) {
    return { dir: "wizard", fileName: "relationship_map.md" };
  }
  if (/人物弧光页\.md$/i.test(trimmed) || /arc\.md$/i.test(trimmed) || /^character_arc\.md$/i.test(trimmed)) {
    return { dir: "wizard", fileName: "character_arc.md" };
  }
  return { dir: "story", fileName: trimmed };
}

type WizardMode = "generate" | "modify";
type IntroRevisionMode = "generate" | "revise" | "polish";

const WIZARD_STEP_FIELDS: Record<BookCreationWizardStep, ReadonlyArray<string>> = {
  intro: ["blurb", "storyBackground", "introMarkdown"],
  world: ["worldPremise", "settingNotes"],
  outline: ["novelOutline", "conflictCore"],
  volume: ["volumeOutline"],
  characters: ["protagonist", "supportingCast", "characterMatrix"],
  arc: ["characterArc"],
  relation: ["relationshipMap"],
};

const WIZARD_STEP_PROMPTS: Record<BookCreationWizardStep, {
  readonly title: string;
  readonly framework: ReadonlyArray<string>;
  readonly constraints: ReadonlyArray<string>;
}> = {
  intro: {
    title: "简介 / 故事背景",
    framework: ["一句话卖点", "故事背景", "主角处境", "引爆点", "核心悬念"],
    constraints: [
      "只补当前页，不要扩写世界观、卷纲、角色矩阵、关系等其他页。",
      "正文首行禁止显示书名，不要把作品名写成 Markdown 一级标题。",
      "一句话卖点必须能直接用于书籍简介或封面文案开头。",
      "背景和引爆点要具体，不要散文式抒情。",
    ],
  },
  world: {
    title: "世界观",
    framework: ["时间 / 空间背景", "规则体系", "势力 / 阵营", "资源 / 权力结构", "不可违背的世界规则"],
    constraints: [
      "只补世界观页，不要写故事大纲或人物弧光。",
      "正文首行禁止显示书名，不要把作品名写成 Markdown 一级标题。",
      "世界规则必须可检查、可执行、可复用。",
      "势力和资源结构必须服务冲突，不要堆设定名词。",
    ],
  },
  outline: {
    title: "小说大纲",
    framework: [
      "故事主线",
      "核心冲突",
      "结构设计",
      "大事件时间线（按剧情顺序）",
      "落点设计（关键章节 / 关键场景收束）",
      "卡点设计（章节中段 / 转折点 / 追读点）",
      "主角成长路径",
    ],
    constraints: [
      "只补大纲页，不要写卷级结构或人物关系页。",
      "正文首行禁止显示书名，不要把作品名写成 Markdown 一级标题。",
      "大事件时间线必须按剧情顺序排列，不能按卷拆分。",
      "结构设计要说明前中后段的功能分配。",
      "落点设计必须写清楚关键章节或关键场景的收尾钩子、反转或悬念。",
      "卡点设计必须写清楚章节中段、转折点和追读点。",
      "不要出现每卷、卷1、卷2、卷末收束等表述。",
    ],
  },
  volume: {
    title: "卷纲规划",
    framework: ["总卷数", "每卷目标", "每卷主冲突", "每卷收束", "卷末钩子", "卷与主线关系"],
    constraints: [
      "只补卷纲页，不要重写全书总大纲。",
      "每卷必须有明确推进目标和卷末收束点。",
      "卷纲必须和主线成长同步，不要空转。",
      "总卷数、各卷章节范围与卷间推进必须严格服从基础参数中的目标章数；如果目标章数是 200 章，就按 200 章体量规划卷数、每卷跨度和阶段推进。",
      "各卷章节范围相加必须能覆盖目标章数，不得按 100-150 章或更短体量压缩分卷，也不要留下大量未规划章节。",
      "每卷章节跨度要和该卷承担的主冲突、成长阶段、卷末收束相匹配，不要出现卷数很少但单卷承载过多剧情，或卷数很多但每卷无实质推进的失衡规划。",
    ],
  },
  characters: {
    title: "主角 / 配角",
    framework: ["主角卡", "关键配角卡", "角色矩阵", "人物功能", "出场节点"],
    constraints: [
      "只补角色页，不要写完整关系网或结局。",
      "角色必须有明确剧情功能，避免空名词堆砌。",
      "主角和关键配角都要有可追踪的动机与作用。",
    ],
  },
  arc: {
    title: "人物弧光",
    framework: [
      "核心弧光",
      "起点状态：性格缺陷 / 内心恐惧 / 错误信念",
      "成长转折：触发事件 / 内心挣扎 / 觉醒时刻 / 持续考验",
      "终点状态：性格蜕变 / 克服恐惧 / 新信念 / 残留痕迹",
    ],
    constraints: [
      "只补人物弧光页，不要扩写角色矩阵或世界观。",
      "必须按“核心弧光 -> 起点状态 -> 成长转折 -> 终点状态”的顺序输出。",
      "必须围绕角色逐个展开，至少写出主角和 2 个关键角色的完整弧光，不要只给总框架。",
      "每个角色都要写明从哪里来、被什么推动、发生了什么变化、最后成为什么。",
      "起点状态必须明确写出性格缺陷、内心恐惧、错误信念。",
      "成长转折必须明确写出触发事件、内心挣扎、觉醒时刻、持续考验。",
      "终点状态必须明确写出性格蜕变、克服恐惧、新信念、残留痕迹。",
      "每一项都要具体、可落地、可写进章节，不要空泛总结。",
      "必须直接输出可落盘的 Markdown 正文，禁止输出任何“已重写”“已保存”“相比原内容”“总结”“汇报”之类说明。",
      "必须基于简介、故事背景、世界观、小说大纲、卷纲规划、主角和配角去写，不得只复述当前页框架。",
      "必须写出至少 3 条具体变化线索或事件触发点，不能只写标题和占位符。",
      "参考结构应接近：角色名 -> 核心弧光 -> 起点状态 -> 成长转折 -> 终点状态；每个小节都要写满具体内容。",
    ],
  },
  relation: {
    title: "人物关系",
    framework: ["核心关系", "对立关系", "隐藏联系", "潜在冲突"],
    constraints: [
      "只补人物关系页，不要写大纲或卷纲。",
      "不要询问用户“是不是生成人物关系”或任何确认问题，直接生成正文。",
      "必须围绕角色逐个写出关系链，至少覆盖主角与 2 个关键角色，不要只给抽象关系框架。",
      "关系必须能推动剧情，不只是身份表。",
      "必须按“核心关系 -> 对立关系 -> 隐藏联系 -> 潜在冲突”的顺序输出。",
      "每条关系都要尽量采用“角色A → 角色B：具体关系内容”的写法，直接写实质，不要只写标签。",
      "必须直接输出可落盘的 Markdown 正文，禁止输出任何“已重写”“已保存”“相比原内容”“总结”“汇报”之类说明。",
      "必须基于简介、故事背景、世界观、小说大纲、卷纲规划、主角和配角去写，不得只复述当前页框架。",
      "必须写出至少 6 条具体关系条目，且至少包含 2 条对立关系、2 条隐藏联系或潜在冲突。",
      "隐藏联系必须带出旧案、把柄、身份秘密、误解来源或历史伤痕中的至少一种。",
      "潜在冲突必须说明一旦真相曝光或利益变化，关系会如何反转，并能直接转成后续剧情事件。",
      "参考结构应接近：核心关系 -> 对立关系 -> 隐藏联系 -> 潜在冲突；每条关系都要写具体互动、代价和变化。",
    ],
  },
};

const INTRO_GENERATION_PROMPT = {
  title: "简介 / 故事背景",
  framework: ["书名", "一句话卖点", "故事概述", "故事走向", "主要人物成长路径", "核心冲突", "核心价值观"],
  constraints: [
    "只生成当前页，不要扩写世界观、卷纲、角色矩阵、关系等其他页。",
    "书名信息必须明确，但正文首行禁止显示书名，不要把书名写成 Markdown 一级标题。",
    "一句话卖点必须能直接用于书籍简介或封面文案开头。",
    "故事概述、故事走向、人物成长路径、核心冲突、核心价值观要具体，不能只写抽象设定。",
    "不要输出生成说明、分析过程、结尾总结或建议下一步。",
  ],
} as const;

const INTRO_REVISION_SYSTEM_PROMPT = [
  "你是 InkOS 的简介 / 故事背景专用修订助手。",
  "你只处理简介页，不要把内容扩写到世界观、角色矩阵、卷纲或章节大纲。",
  "如果用户要求按题材生成，要优先遵守题材约束。",
  "如果用户要求修改或润色，要在保留原意的基础上优化表达和钩子。",
  "你只能输出一篇完整的 Markdown 正文，使用 ## 段落标题组织内容。",
  "如果当前还没有已定书名且任务要求生成书名，允许在正文前单独输出一行“书名：<生成的书名>”作为元数据；除此之外，禁止输出 title、blurb、storyBackground、introMarkdown 之类的字段标签或结构化前缀。",
  "每个段落都必须写出有信息量的实质正文，不能用占位符“-”“…”或空标题敷衍。",
  "不要反问用户确认参数；如果信息足够，直接生成完整正文或直接修改正文。",
].join(" ");

function getWizardStepTemplate(step: BookCreationWizardStep) {
  return WIZARD_STEP_PROMPTS[step] ?? WIZARD_STEP_PROMPTS.intro;
}

export function buildWizardPrompt(
  step: BookCreationWizardStep,
  mode: WizardMode,
  userMessage: string,
  existingDraft?: BookCreationDraft,
  genreContext?: WizardGenreContext,
  explicitGenre?: string,
): string {
  const template = step === "intro" && mode === "generate"
    ? INTRO_GENERATION_PROMPT
    : getWizardStepTemplate(step);
  const allowedFields = WIZARD_STEP_FIELDS[step].join("、");
  const draftBlock = existingDraft
    ? ["## 当前草案", JSON.stringify(existingDraft, null, 2)].join("\n")
    : "## 当前草案\n（空）";
  const baseParamsContext = buildWizardBaseParamsContext(existingDraft);
  const introCharacterNameBlock = step === "intro"
    ? undefined
    : buildIntroCharacterNameConstraintBlock({
        blurb: existingDraft?.blurb,
        storyBackground: existingDraft?.storyBackground,
        introMarkdown: existingDraft?.introMarkdown,
        draftFields: existingDraft?.draftFields,
        protagonist: existingDraft?.protagonist,
        supportingCast: existingDraft?.supportingCast,
        introCharacterNames: existingDraft?.introCharacterNames,
      });
  const introCharacterNames = step === "intro"
    ? []
    : extractIntroCharacterNameHints({
        blurb: existingDraft?.blurb,
        storyBackground: existingDraft?.storyBackground,
        introMarkdown: existingDraft?.introMarkdown,
        draftFields: existingDraft?.draftFields,
        protagonist: existingDraft?.protagonist,
        supportingCast: existingDraft?.supportingCast,
        introCharacterNames: existingDraft?.introCharacterNames,
      });
  const stepContext = step === "world"
    ? buildWorldContext({
        blurb: existingDraft?.blurb,
        storyBackground: existingDraft?.storyBackground,
        worldPremise: existingDraft?.worldPremise,
        settingNotes: existingDraft?.settingNotes,
        novelOutline: existingDraft?.novelOutline,
        conflictCore: existingDraft?.conflictCore,
      })
    : step === "outline"
      ? buildOutlineContext({
          blurb: existingDraft?.blurb,
          storyBackground: existingDraft?.storyBackground,
          worldPremise: existingDraft?.worldPremise,
          settingNotes: existingDraft?.settingNotes,
          novelOutline: existingDraft?.novelOutline,
          conflictCore: existingDraft?.conflictCore,
          protagonist: existingDraft?.protagonist,
          supportingCast: existingDraft?.supportingCast,
        })
      : step === "characters"
        ? buildCharactersContext({
            blurb: existingDraft?.blurb,
            storyBackground: existingDraft?.storyBackground,
            worldPremise: existingDraft?.worldPremise,
            settingNotes: existingDraft?.settingNotes,
            novelOutline: existingDraft?.novelOutline,
            conflictCore: existingDraft?.conflictCore,
            protagonist: existingDraft?.protagonist,
            supportingCast: existingDraft?.supportingCast,
            characterMatrix: existingDraft?.characterMatrix,
          })
        : step === "volume"
    ? buildVolumeOutlineContext({
        novelOutline: existingDraft?.novelOutline,
        conflictCore: existingDraft?.conflictCore,
        worldPremise: existingDraft?.worldPremise,
        settingNotes: existingDraft?.settingNotes,
      })
        : step === "arc"
      ? buildCharacterArcContext({
          blurb: existingDraft?.blurb,
          storyBackground: existingDraft?.storyBackground,
          characterArc: existingDraft?.characterArc,
          protagonist: existingDraft?.protagonist,
          supportingCast: existingDraft?.supportingCast,
          conflictCore: existingDraft?.conflictCore,
          novelOutline: existingDraft?.novelOutline,
          volumeOutline: existingDraft?.volumeOutline,
          worldPremise: existingDraft?.worldPremise,
          settingNotes: existingDraft?.settingNotes,
        })
      : step === "relation"
        ? buildRelationshipMapContext({
            blurb: existingDraft?.blurb,
            storyBackground: existingDraft?.storyBackground,
            relationshipMap: existingDraft?.relationshipMap,
            protagonist: existingDraft?.protagonist,
            supportingCast: existingDraft?.supportingCast,
            characterArc: existingDraft?.characterArc,
            conflictCore: existingDraft?.conflictCore,
            novelOutline: existingDraft?.novelOutline,
            volumeOutline: existingDraft?.volumeOutline,
            worldPremise: existingDraft?.worldPremise,
            settingNotes: existingDraft?.settingNotes,
          })
    : undefined;
  const modeLabel = step === "intro" && mode === "generate"
    ? "生成正式简介"
    : mode === "generate"
      ? "生成当前页"
      : "只修改当前页";
  const genreBlock = genreContext
    ? [
        "## 题材库约束",
        `- 题材：${genreContext.profile.name} (${genreContext.profile.id})`,
        `- 章节类型：${genreContext.profile.chapterTypes.join("、") || "无"}`,
        `- 节奏规则：${genreContext.profile.pacingRule || "无"}`,
        `- 数值体系：${genreContext.profile.numericalSystem ? "有" : "无"}`,
        `- 战力体系：${genreContext.profile.powerScaling ? "有" : "无"}`,
        `- 时代考据：${genreContext.profile.eraResearch ? "需要" : "不需要"}`,
        `- 疲劳词：${genreContext.profile.fatigueWords.slice(0, 12).join("、") || "无"}`,
        `- 读者爽点：${genreContext.profile.satisfactionTypes.join("、") || "无"}`,
        "",
        "## 题材规则正文",
        genreContext.body.trim() || "（无）",
      ].join("\n")
    : explicitGenre
      ? [
          "## 题材约束",
          `- 题材：${explicitGenre}`,
          "- 必须严格遵守该题材的风格、世界观特征和常见设定。",
          "- 禁止混入其他题材的专有名词、体系或世界规则。",
        ].join("\n")
      : "";
  const constraints = [
    ...template.constraints,
    ...(introCharacterNames.length > 0
      ? [`简介中已约定角色名：${introCharacterNames.join("、")}。当前页必须严格沿用这些名字，不得擅自改名、替换角色名称、合并角色或新增别名；如需补充角色相关内容，优先以这些名字为准。`]
      : []),
    `只允许更新以下字段：${allowedFields}。其他字段必须保持草案原值。`,
    "多轮修正时，如果用户只要求改一个字段，只改这个字段，不要顺手重写同页其他字段。",
    ...((step === "intro" || step === "world" || step === "outline")
      ? ["正文必须直接从当前页标题或当前页结构进入，禁止以书名作为首行标题。"]
      : []),
  ];

  return [
    `当前步骤：${template.title}`,
    `模式：${modeLabel}`,
    "",
    ...(baseParamsContext ? [baseParamsContext, ""] : []),
    ...(introCharacterNameBlock ? [introCharacterNameBlock, ""] : []),
    ...(genreBlock ? [genreBlock, ""] : []),
    ...(stepContext ? [stepContext, ""] : []),
    "内容框架必须包含：",
    ...template.framework.map((item, index) => `${index + 1}. ${item}`),
    "",
    "约束：",
    ...constraints.map((item, index) => `${index + 1}. ${item}`),
    "",
    draftBlock,
    "",
    "## 用户输入",
    userMessage.trim(),
  ].join("\n");
}

function parseToolCallArguments(toolCall: { arguments: string } | undefined): Record<string, unknown> {
  if (!toolCall) return {};
  try {
    const parsed = JSON.parse(toolCall.arguments);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function applyWizardStepDraft(
  step: BookCreationWizardStep,
  existingDraft: BookCreationDraft | undefined,
  concept: string,
  fields: Readonly<Record<string, unknown>>,
): BookCreationDraft {
  const draft: BookCreationDraft = {
    concept,
    missingFields: [],
    readyToCreate: false,
    ...(existingDraft ?? {}),
  };
  const allowedFields = new Set(WIZARD_STEP_FIELDS[step]);

  for (const [key, value] of Object.entries(fields)) {
    if (!allowedFields.has(key) || value === undefined || value === null || value === "") {
      continue;
    }
    const text = typeof value === "string" ? value : String(value);
    switch (key) {
      case "blurb":
        draft.blurb = text;
        break;
      case "introMarkdown":
        draft.draftFields = {
          ...(draft.draftFields ?? {}),
          introMarkdown: text,
        };
        break;
      case "storyBackground":
        draft.storyBackground = text;
        break;
      case "worldPremise":
        draft.worldPremise = text;
        break;
      case "settingNotes":
        draft.settingNotes = text;
        break;
      case "novelOutline":
        draft.novelOutline = text;
        break;
      case "conflictCore":
        draft.conflictCore = text;
        break;
      case "volumeOutline":
        draft.volumeOutline = text;
        break;
      case "protagonist":
        draft.protagonist = text;
        break;
      case "supportingCast":
        draft.supportingCast = text;
        break;
      case "characterMatrix":
        draft.characterMatrix = text;
        break;
      case "characterArc":
        draft.characterArc = text;
        break;
      case "relationshipMap":
        draft.relationshipMap = text;
        break;
      case "title":
        draft.title = text;
        break;
      case "genre":
        draft.genre = text;
        break;
      case "platform":
        draft.platform = text;
        break;
      case "language":
        if (text === "zh" || text === "en") draft.language = text;
        break;
      case "targetChapters": {
        const n = Number(text);
        if (Number.isFinite(n) && n > 0) draft.targetChapters = Math.trunc(n);
        break;
      }
      case "chapterWordCount": {
        const n = Number(text);
        if (Number.isFinite(n) && n > 0) draft.chapterWordCount = Math.trunc(n);
        break;
      }
    }
  }

  return syncIntroCharacterNames(draft);
}

async function runWizardDraftTool(params: {
  readonly pipeline: InstrumentablePipelineLike;
  readonly step: BookCreationWizardStep;
  readonly mode: WizardMode;
  readonly input: string;
  readonly existingDraft?: BookCreationDraft;
  readonly themeGenre?: string;
  readonly onThinkingDelta?: (text: string) => void;
  readonly onDraftDelta?: (text: string) => void;
  readonly onDraftRawDelta?: (text: string) => void;
}): Promise<{
  readonly draft: BookCreationDraft;
  readonly responseText: string;
  readonly fieldsUpdated: ReadonlyArray<string>;
  readonly draftRaw: string;
}> {
  const { pipeline, step, mode, input, existingDraft, themeGenre } = params;
  const concept = input.trim() || existingDraft?.concept || getWizardStepTemplate(step).title;
  const projectRoot = pipeline.config?.projectRoot;
  const effectiveGenre = themeGenre?.trim() || existingDraft?.genre;
  const genreContext = effectiveGenre && projectRoot
    ? await readGenreProfile(projectRoot, effectiveGenre).catch(() => null)
    : null;

  if (!pipeline.config?.client || !pipeline.config?.model) {
    return {
      draft: applyWizardStepDraft(step, existingDraft, concept, {}),
      responseText: "请先配置 LLM 模型，然后再继续建书向导。",
      fieldsUpdated: [],
      draftRaw: "",
    };
  }

  const stepTitle = getWizardStepTemplate(step).title;
  const thinkingLead = [
    `正在处理当前${stepTitle}页正文。`,
    step === "world"
      ? "正在整理世界规则、空间气氛与关键势力。"
      : step === "outline"
        ? "正在收束主线结构、章节卡点与推进节奏。"
        : step === "volume"
          ? "正在规划分卷目标、节奏分段与关键转折。"
          : step === "characters"
            ? "正在梳理主角、配角与功能分工。"
            : step === "arc"
              ? "正在组织角色弧光、成长拐点与终局变化。"
              : step === "relation"
                ? "正在搭建人物关系、冲突链与剧情引擎。"
                : "正在收束当前页结构、核心设定与字段约束。",
  ];
  for (const line of thinkingLead) {
    params.onThinkingDelta?.(line);
  }

  const result = await chatWithTools(
    pipeline.config.client,
    pipeline.config.model,
    [
      {
        role: "system",
        content: [
          "你是 InkOS 的建书向导助手。",
        "你只能处理当前步骤，并且只能更新当前页允许的字段。",
        "不要改写其他页面内容。",
        "如果信息不足，可以给出合理默认值，但必须保持当前页框架完整。",
        "题材库约束优先于通用表达，必须遵守题材规则和禁忌。",
        "你必须输出当前页正文，不要输出总结、汇报、保存说明或改写说明。",
      ].join(" "),
      },
      {
        role: "user",
        content: buildWizardPrompt(step, mode, input, existingDraft, genreContext ?? undefined, effectiveGenre),
      },
    ],
    [SAVE_BOOK_WIZARD_STEP_TOOL],
    { temperature: 0.35 },
  );

  if (result.content) {
    params.onDraftRawDelta?.(result.content);
    params.onDraftDelta?.(result.content);
  }
  const toolArgs = parseToolCallArguments(result.toolCalls[0]);
  const parsedIntro = step === "intro" ? parseIntroMarkdownDraft(input) : null;
  const normalizedArgs = step === "intro" ? {
    title: typeof toolArgs.title === "string" ? toolArgs.title : existingDraft?.title ?? "",
    blurb: typeof toolArgs.blurb === "string" ? toolArgs.blurb : parsedIntro?.blurb ?? "",
    storyBackground: typeof toolArgs.storyBackground === "string" ? toolArgs.storyBackground : parsedIntro?.storyBackground ?? "",
  } : toolArgs;
  const draft = applyWizardStepDraft(step, existingDraft, concept, normalizedArgs);
  const normalizedDraftRaw = normalizeWizardMarkdownOutput(step, result.content?.trim() || "", draft);
  const cleanedDraftRaw = step === "arc" || step === "relation"
    ? stripWizardPreamble(step, normalizedDraftRaw || result.content?.trim() || "")
    : normalizedDraftRaw;
  if (step === "intro" && normalizedDraftRaw) {
    draft.draftFields = {
      ...(draft.draftFields ?? {}),
      introMarkdown: normalizedDraftRaw,
    };
  }
  return {
    draft,
    responseText: cleanedDraftRaw || normalizedDraftRaw || result.content?.trim() || "已更新当前页内容。",
    fieldsUpdated: Object.keys(normalizedArgs).filter((key) => WIZARD_STEP_FIELDS[step].includes(key)),
    draftRaw: cleanedDraftRaw || normalizedDraftRaw,
  };
}

async function runIntroRevisionTool(params: {
  readonly pipeline: InstrumentablePipelineLike;
  readonly input: string;
  readonly existingDraft?: BookCreationDraft;
  readonly revisionKind?: IntroRevisionMode;
  readonly themeGenre?: string;
  readonly writingLanguage?: "zh" | "en";
  readonly targetChapters?: number;
  readonly chapterWordCount?: number;
  readonly onThinkingDelta?: (text: string) => void;
  readonly onDraftDelta?: (text: string) => void;
  readonly onDraftRawDelta?: (text: string) => void;
}): Promise<{
  readonly draft: BookCreationDraft;
  readonly responseText: string;
  readonly fieldsUpdated: ReadonlyArray<string>;
  readonly draftRaw: string;
}> {
  const { pipeline, input, existingDraft, revisionKind = "revise", themeGenre, writingLanguage, targetChapters, chapterWordCount } = params;
  const concept = existingDraft?.concept ?? input;
  const projectRoot = pipeline.config?.projectRoot;
  const genreContext = themeGenre && projectRoot
    ? await readGenreProfile(projectRoot, themeGenre).catch(() => null)
    : existingDraft?.genre && projectRoot
      ? await readGenreProfile(projectRoot, existingDraft.genre).catch(() => null)
      : null;

  if (!pipeline.config?.client || !pipeline.config?.model) {
    return {
      draft: applyFieldsToDraft(existingDraft, {}, concept),
      responseText: "请先配置 LLM 模型，然后再修改简介。",
      fieldsUpdated: [],
      draftRaw: "",
    };
  }

  const thinkingLead = [
    revisionKind === "polish" ? "正在润色简介正文。" : revisionKind === "generate" ? "正在生成简介正文。" : "正在修改简介正文。",
    "正在收束书名、卖点、故事概述、故事走向、人物成长、核心冲突和核心价值观。",
  ];
  for (const line of thinkingLead) {
    params.onThinkingDelta?.(line);
  }
  const baseUserPrompt = buildIntroRevisionPrompt({
    mode: revisionKind,
    userMessage: input,
    existingDraft,
    genreContext,
    writingLanguage,
    targetChapters,
    chapterWordCount,
  });
  const needsGeneratedTitle = revisionKind === "generate" && !(existingDraft?.title?.trim());

  const attemptIntroGeneration = async (
    reinforce: string | undefined,
    stream: boolean,
  ): Promise<{ readonly body: string; readonly title?: string }> => {
    const emitDraftDelta = createIntroRevisionStreamNormalizer();
    let streamedDraft = "";
    let streamedRaw = "";
    const result = await chatCompletion(
      pipeline.config!.client!,
      pipeline.config!.model!,
      [
        { role: "system", content: [INTRO_REVISION_SYSTEM_PROMPT, "你只能输出完整正文，不要输出工具调用，不要输出解释说明。"].join(" ") },
        { role: "user", content: reinforce ? `${baseUserPrompt}\n\n${reinforce}` : baseUserPrompt },
      ],
      {
        temperature: revisionKind === "polish" ? 0.25 : 0.35,
        onTextDelta: stream
          ? (text) => {
              streamedRaw += text;
              const normalizedChunk = emitDraftDelta(text);
              if (normalizedChunk) {
                streamedDraft += normalizedChunk;
                params.onDraftDelta?.(normalizedChunk);
                params.onDraftRawDelta?.(normalizedChunk);
              }
            }
          : undefined,
      },
    );
    const rawDraft = result.content.trim();
    const resolvedTitle = extractIntroTitleFromMarkdown(rawDraft)
      ?? extractIntroTitleFromMarkdown(streamedRaw)
      ?? existingDraft?.title?.trim();
    return {
      title: resolvedTitle,
      body: stripLeadingBookTitleHeading(
        pickBestIntroMarkdownCandidate([
        stream ? normalizeIntroRevisionOutput(streamedDraft) : undefined,
        normalizeIntroRevisionOutput(rawDraft),
        rawDraft,
      ]),
        resolvedTitle,
      ),
    };
  };

  const RETRY_REINFORCEMENT = [
    "上一次输出不是合格的简介正文（出现了字段标签、占位符“-”，或段落正文为空）。",
    "请重新输出：必须是一篇完整的 Markdown 正文，包含 一句话卖点、故事概述、故事走向、主要人物成长路径、核心冲突、核心价值观 六个 ## 段落。",
    "每个段落都要写出有信息量的实质内容，禁止任何字段标签、结构化前缀或占位符。",
  ].join("\n");

  const candidates: Array<{ readonly body: string; readonly title?: string }> = [];
  let normalizedDraft = "";
  let resolvedTitle = existingDraft?.title?.trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stream = true; // 所有重试都保持流式输出，让用户看到AI工作台的实时进度
    const candidate = await attemptIntroGeneration(attempt === 0 ? undefined : RETRY_REINFORCEMENT, stream);
    if (candidate.body) candidates.push(candidate);
    if (candidate.body && hasMeaningfulIntroMarkdown(candidate.body) && (!needsGeneratedTitle || candidate.title?.trim())) {
      normalizedDraft = candidate.body;
      resolvedTitle = candidate.title?.trim() || resolvedTitle;
      break;
    }
  }
  if (!normalizedDraft) {
    const bestCandidate = candidates.reduce<{ readonly body: string; readonly title?: string } | null>((best, current) => {
      if (!current.body) return best;
      if (!best) return current;
      return scoreIntroMarkdownCandidate(current.body) > scoreIntroMarkdownCandidate(best.body) ? current : best;
    }, null);
    normalizedDraft = bestCandidate?.body ?? "";
    resolvedTitle = bestCandidate?.title?.trim() || resolvedTitle;
  }
  const parsedIntro = parseIntroMarkdownDraft(normalizedDraft);
  const parsedTitle = resolvedTitle ?? extractIntroTitleFromMarkdown(normalizedDraft) ?? existingDraft?.title?.trim();
  const normalizedArgs: Record<string, string> = {};
  if (parsedTitle) normalizedArgs.title = parsedTitle;
  if (parsedIntro.blurb) normalizedArgs.blurb = parsedIntro.blurb;
  if (parsedIntro.storyBackground) normalizedArgs.storyBackground = parsedIntro.storyBackground;
  if (normalizedDraft) normalizedArgs.introMarkdown = normalizedDraft;

  if (!normalizedArgs.title && existingDraft?.title?.trim()) {
    normalizedArgs.title = existingDraft.title.trim();
  }
  if (needsGeneratedTitle && !normalizedArgs.title?.trim()) {
    const preservedDraft = applyFieldsToDraft(existingDraft, {}, concept);
    return {
      draft: {
        ...preservedDraft,
        draftFields: existingDraft?.draftFields,
        readyToCreate: false,
      },
      responseText: "Agent 未生成可用书名，请补充题材/卖点后重试。",
      fieldsUpdated: [],
      draftRaw: "",
    };
  }

  const introIsMeaningful = Boolean(normalizedArgs.introMarkdown)
    && hasMeaningfulIntroMarkdown(normalizedArgs.introMarkdown);
  if (!introIsMeaningful) {
    // 不再用空骨架兜底：Agent 没产出合格正文就如实失败，保留既有草案，让前端提示重试。
    const preservedDraft = applyFieldsToDraft(
      existingDraft,
      normalizedArgs.title ? { title: normalizedArgs.title } : {},
      concept,
    );
    return {
      draft: {
        ...preservedDraft,
        draftFields: existingDraft?.draftFields,
        readyToCreate: false,
      },
      responseText: "Agent 未生成合格的简介正文（多次重试后仍为空或仅有框架），请补充卖点/题材后重试。",
      fieldsUpdated: normalizedArgs.title ? ["title"] : [],
      draftRaw: "",
    };
  }

  const draft = applyFieldsToDraft(existingDraft, normalizedArgs, concept);
  draft.worldPremise = existingDraft?.worldPremise;
  draft.settingNotes = existingDraft?.settingNotes;
  draft.novelOutline = existingDraft?.novelOutline;
  draft.protagonist = existingDraft?.protagonist;
  draft.supportingCast = existingDraft?.supportingCast;
  draft.characterMatrix = existingDraft?.characterMatrix;
  draft.characterArc = existingDraft?.characterArc;
  draft.relationshipMap = existingDraft?.relationshipMap;
  draft.conflictCore = existingDraft?.conflictCore;
  draft.volumeOutline = existingDraft?.volumeOutline;
  draft.constraints = existingDraft?.constraints;
  draft.authorIntent = existingDraft?.authorIntent;
  draft.currentFocus = existingDraft?.currentFocus;
  if (normalizedArgs.introMarkdown) {
    draft.draftFields = {
      ...(draft.draftFields ?? {}),
      introMarkdown: normalizedArgs.introMarkdown,
    };
  }
  if (themeGenre?.trim()) {
    draft.genre = themeGenre.trim();
    draft.mappedGenreId = draft.mappedGenreId ?? themeGenre.trim();
    draft.genreAlias = draft.genreAlias ?? themeGenre.trim();
    draft.genreSource = draft.genreSource ?? "builtin";
  }

  return {
    draft: {
      ...draft,
      readyToCreate: false,
    },
    responseText: normalizedDraft || (revisionKind === "polish" ? "已润色简介与故事背景。" : "已修改简介与故事背景。"),
    fieldsUpdated: Object.keys(normalizedArgs).filter((key) => ["title", "blurb", "storyBackground", "introMarkdown", "genre", "genreAlias", "genreSource", "mappedGenreId"].includes(key)),
    draftRaw: normalizedDraft,
  };
}

export function buildChapterFileLookup(files: ReadonlyArray<string>): ReadonlyMap<number, string> {
  const lookup = new Map<number, string>();
  for (const file of files) {
    if (!file.endsWith(".md") || !/^\d{4}/.test(file)) {
      continue;
    }
    const chapterNumber = parseInt(file.slice(0, 4), 10);
    if (!lookup.has(chapterNumber)) {
      lookup.set(chapterNumber, file);
    }
  }
  return lookup;
}

async function exportBookToPath(state: StateLike, bookId: string, options: {
  readonly format?: "txt" | "md" | "epub";
  readonly approvedOnly?: boolean;
  readonly outputPath?: string;
}) {
  return writeExportArtifact(state, bookId, options);
}

function mapStageMessageToStatus(message: string): InteractionEvent["status"] | undefined {
  const lower = message.trim().toLowerCase();
  if (
    lower.includes("planning next chapter")
    || lower.includes("generating foundation")
    || lower.includes("reviewing foundation")
    || lower.includes("preparing chapter inputs")
    || message.includes("规划下一章意图")
    || message.includes("生成基础设定")
    || message.includes("审核基础设定")
    || message.includes("准备章节输入")
  ) {
    return "planning";
  }
  if (
    lower.includes("composing chapter runtime context")
    || message.includes("组装章节运行时上下文")
  ) {
    return "composing";
  }
  if (
    lower.includes("writing chapter draft")
    || message.includes("撰写章节草稿")
  ) {
    return "writing";
  }
  if (
    lower.includes("auditing draft")
    || message.includes("审计草稿")
  ) {
    return "assessing";
  }
  if (
    lower.includes("fixing")
    || lower.includes("revising chapter")
    || lower.includes("rewrite")
    || lower.includes("repair")
    || message.includes("自动修复")
    || message.includes("整章改写")
    || message.includes("修订第")
  ) {
    return "repairing";
  }
  if (
    lower.includes("persist")
    || lower.includes("saving")
    || lower.includes("snapshot")
    || lower.includes("rebuilding final truth files")
    || lower.includes("validating truth file updates")
    || lower.includes("syncing memory indexes")
    || message.includes("落盘")
    || message.includes("保存")
    || message.includes("快照")
    || message.includes("校验真相文件变更")
    || message.includes("生成最终真相文件")
    || message.includes("同步记忆索引")
  ) {
    return "persisting";
  }
  return undefined;
}

function extractStageDetail(message: string): string | undefined {
  if (message.startsWith("Stage: ")) {
    return message.slice("Stage: ".length).trim();
  }
  if (message.startsWith("阶段：")) {
    return message.slice("阶段：".length).trim();
  }
  return undefined;
}

function createInteractionLogger(
  original: Logger | undefined,
  events: InteractionEvent[],
  bookId: string,
): Logger {
  const emit = (level: "debug" | "info" | "warn" | "error", message: string): void => {
    const stageDetail = extractStageDetail(message);
    const stageStatus = stageDetail ? mapStageMessageToStatus(stageDetail) : undefined;

    if (stageDetail && stageStatus) {
      events.push({
        kind: "stage.changed",
        timestamp: Date.now(),
        status: stageStatus,
        bookId,
        detail: stageDetail,
      });
      return;
    }

    if (level === "warn") {
      events.push({
        kind: "task.warning",
        timestamp: Date.now(),
        status: "blocked",
        bookId,
        detail: message,
      });
      return;
    }

    if (level === "error") {
      events.push({
        kind: "task.failed",
        timestamp: Date.now(),
        status: "failed",
        bookId,
        detail: message,
      });
    }
  };

  const wrap = (base: Logger | undefined): Logger => ({
    debug: (msg, ctx) => {
      emit("debug", msg);
      base?.debug(msg, ctx);
    },
    info: (msg, ctx) => {
      emit("info", msg);
      base?.info(msg, ctx);
    },
    warn: (msg, ctx) => {
      emit("warn", msg);
      base?.warn(msg, ctx);
    },
    error: (msg, ctx) => {
      emit("error", msg);
      base?.error(msg, ctx);
    },
    child: (tag, extraCtx) => wrap(base?.child(tag, extraCtx)),
  });

  return wrap(original);
}

async function withPipelineInteractionTelemetry<T extends { chapterNumber?: number }>(
  pipeline: InstrumentablePipelineLike,
  bookId: string,
  executor: () => Promise<T>,
): Promise<T & {
  __interaction: {
    events: ReadonlyArray<InteractionEvent>;
    activeChapterNumber?: number;
  };
}> {
  const events: InteractionEvent[] = [];
  const originalLogger = pipeline.config?.logger;
  if (pipeline.config) {
    pipeline.config.logger = createInteractionLogger(originalLogger, events, bookId);
  }

  try {
    const result = await executor();
    return {
      ...result,
      __interaction: {
        events,
        ...(typeof result.chapterNumber === "number"
          ? { activeChapterNumber: result.chapterNumber }
          : {}),
      },
    };
  } finally {
    if (pipeline.config) {
      pipeline.config.logger = originalLogger;
    }
  }
}

const CREATE_BOOK_TOOL: ToolDefinition = {
  name: "create_book",
  description: "根据用户简介创建书籍壳。只保存简介 / 故事背景，不生成世界观、大纲或角色设定。",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "书名" },
      genre: { type: "string", description: "题材标识，如 xuanhuan, urban, romance, scifi, mystery" },
      platform: { type: "string", enum: ["tomato", "qidian", "feilu", "other"], description: "发布平台" },
      language: { type: "string", enum: ["zh", "en"], description: "写作语言，默认 zh" },
      brief: { type: "string", description: "创意简述，会传给 Architect 智能体生成完整的世界观、主角、冲突等 foundation 文件。把用户提到的所有创意要素都写进这里。" },
      storyBackground: { type: "string", description: "简介 / 故事背景" },
      introMarkdown: { type: "string", description: "简介正文 Markdown" },
    },
    required: ["title", "genre", "platform", "brief"],
  },
};

const SAVE_BOOK_WIZARD_STEP_TOOL: ToolDefinition = {
  name: "save_book_wizard_step",
  description: "保存当前向导页草案，只更新当前页允许的字段，不创建书籍。",
  parameters: CREATE_BOOK_TOOL.parameters,
};

const BOOK_DRAFT_SYSTEM_PROMPT = [
  "你是 InkOS 的建书助手。用户会描述想写的书，你需要调用 save_book_wizard_step 工具来保存当前页草案。",
  "",
  "规则：",
  "1. 从用户描述中推断所有字段，大胆预填合理默认值。",
  "2. brief 字段要详细，但只用于当前页草案，不要越权补齐其他页面。",
  "3. storyBackground、worldPremise、novelOutline、volumeOutline、characterArc、relationshipMap 都必须按当前页允许的框架填充，不要自由散写。",
  "4. 如果用户后续要求修改某些字段，重新调用 save_book_wizard_step 工具，只更新被提到的字段，其余保持不变。",
  "5. 不要只回复文字讨论——必须调用 save_book_wizard_step 工具输出结构化参数。",
].join("\n");

/** Map directive field keys to BookCreationDraft property names. */
function applyFieldsToDraft(
  existing: BookCreationDraft | undefined,
  fields: Readonly<Record<string, string>>,
  concept: string,
): BookCreationDraft {
  const draft: BookCreationDraft = {
    concept,
    missingFields: [],
    readyToCreate: false,
    ...(existing ?? {}),
  };

  for (const [key, value] of Object.entries(fields)) {
    if (!value) continue;

    switch (key) {
      case "title":
        draft.title = value;
        break;
      case "genre":
        draft.genre = value;
        break;
      case "platform":
        draft.platform = value;
        break;
      case "language":
        if (value === "zh" || value === "en") draft.language = value;
        break;
      case "targetChapters": {
        const n = parseInt(value, 10);
        if (!Number.isNaN(n) && n > 0) draft.targetChapters = n;
        break;
      }
      case "chapterWordCount":
      case "chapterLength": {
        const n = parseInt(value, 10);
        if (!Number.isNaN(n) && n > 0) draft.chapterWordCount = n;
        break;
      }
      case "blurb":
        draft.blurb = value;
        break;
      case "brief":
        draft.blurb = value;
        break;
      case "introMarkdown":
        draft.introMarkdown = value;
        draft.draftFields = {
          ...(draft.draftFields ?? {}),
          introMarkdown: value,
        };
        break;
      case "storyBackground":
        draft.storyBackground = value;
        break;
      case "worldPremise":
        draft.worldPremise = value;
        break;
      case "settingNotes":
        draft.settingNotes = value;
        break;
      case "novelOutline":
        draft.novelOutline = value;
        break;
      case "protagonist":
        draft.protagonist = value;
        break;
      case "supportingCast":
        draft.supportingCast = value;
        break;
      case "characterMatrix":
        draft.characterMatrix = value;
        break;
      case "characterArc":
        draft.characterArc = value;
        break;
      case "relationshipMap":
        draft.relationshipMap = value;
        break;
      case "conflictCore":
        draft.conflictCore = value;
        break;
      case "volumeOutline":
        draft.volumeOutline = value;
        break;
      case "constraints":
        draft.constraints = value;
        break;
      case "authorIntent":
        draft.authorIntent = value;
        break;
      case "currentFocus":
        draft.currentFocus = value;
        break;
      // Unknown keys are silently ignored — the LLM may emit
      // application-level keys we don't map to the draft struct.
    }
  }

  return syncIntroCharacterNames(draft);
}

function buildLegacyDraftUserContent(input: string, existingDraft?: BookCreationDraft): string {
  if (!existingDraft) return input;
  return [
    `当前草案参数：${JSON.stringify(existingDraft, null, 2)}`,
    "",
    `用户输入：${input}`,
  ].join("\n");
}

export function buildIntroRevisionPrompt(params: {
  readonly mode: IntroRevisionMode;
  readonly userMessage: string;
  readonly existingDraft?: BookCreationDraft;
  readonly genreContext?: WizardGenreContext | null;
  readonly writingLanguage?: "zh" | "en";
  readonly targetChapters?: number;
  readonly chapterWordCount?: number;
}): string {
  const { mode, userMessage, existingDraft, genreContext, writingLanguage, targetChapters, chapterWordCount } = params;
  const needsGeneratedTitle = mode === "generate" && !(existingDraft?.title?.trim());
  const chapterScaleConstraint = typeof targetChapters === "number"
    ? `7. 故事走向、主要人物成长路径、核心冲突的铺排必须服从 ${targetChapters} 章的长篇节奏约束；如果目标是 ${targetChapters} 章，就按 ${targetChapters} 章体量设计阶段推进、成长跨度和冲突升级，禁止压缩成 100-150 章或更短篇幅的中短篇节奏。`
    : "7. 故事走向、主要人物成长路径、核心冲突的铺排必须服从既定目标章数，不要按更短篇幅压缩节奏。";
  const draftBlock = existingDraft
    ? ["## 当前草案", JSON.stringify(existingDraft, null, 2)].join("\n")
    : "## 当前草案\n（空）";
  const contentMode = mode === "polish"
    ? "润色正式简介"
    : mode === "generate"
      ? "生成正式简介"
      : "修改正式简介";
  const genreBlock = genreContext
    ? [
        "## 题材库约束",
        `- 题材：${genreContext.profile.name} (${genreContext.profile.id})`,
        `- 章节类型：${genreContext.profile.chapterTypes.join("、") || "无"}`,
        `- 节奏规则：${genreContext.profile.pacingRule || "无"}`,
        `- 数值体系：${genreContext.profile.numericalSystem ? "有" : "无"}`,
        `- 战力体系：${genreContext.profile.powerScaling ? "有" : "无"}`,
        `- 时代考据：${genreContext.profile.eraResearch ? "需要" : "不需要"}`,
        `- 疲劳词：${genreContext.profile.fatigueWords.slice(0, 12).join("、") || "无"}`,
        `- 读者爽点：${genreContext.profile.satisfactionTypes.join("、") || "无"}`,
        "",
        "## 题材规则正文",
        genreContext.body.trim() || "（无）",
      ].join("\n")
    : "";

  return [
    `模式：${contentMode}`,
    "目标页：简介 / 故事背景",
    "输出方式：直接输出正文，不要反问任何确认项，不要把问题抛回给用户。",
    writingLanguage ? `写作语言：${writingLanguage}` : "写作语言：已由左侧向导固定",
    typeof targetChapters === "number" ? `目标章节数：${targetChapters}` : "目标章节数：已由左侧向导固定",
    typeof chapterWordCount === "number" ? `每章字数：${chapterWordCount}` : "每章字数：已由左侧向导固定",
    "约束：以上三项已在左侧向导中固定，不要再次询问，不要把它们当成待确认问题。",
    "",
    ...(genreBlock ? [genreBlock, ""] : []),
    "内容框架必须包含：",
    "1. 书名",
    "2. 一句话卖点",
    "3. 故事概述",
    "4. 故事走向",
    "5. 主要人物成长路径",
    "6. 核心冲突",
    "7. 核心价值观",
    "",
    "输出要求：",
    needsGeneratedTitle
      ? "1. 当前还没有书名。你必须先单独输出一行“书名：<生成的书名>”，然后从下一行开始输出完整 Markdown 正文。"
      : "1. 只输出完整 Markdown 正文，不要输出 title、blurb、storyBackground、introMarkdown 这类字段标签。",
    needsGeneratedTitle
      ? "2. 除了这一行“书名：...”元数据外，不要输出其他字段标签或结构化前缀。"
      : "2. 不要输出“title：”“blurb：”“storyBackground：”“introMarkdown：”这种结构化前缀。",
    "3. 正文首行禁止显示书名，不要输出“# 书名”或任何把书名放在第一行的标题。",
    "4. 不要输出“以上是草案”“如果你确认”等前后缀说明。",
    "5. 不要扩写到世界观、人物关系、卷纲或章节目录。",
    "6. 不要再次询问写作语言、目标章节数、每章字数；它们已经确定。",
    chapterScaleConstraint,
    "8. 用户输入只是创作素材和约束，不要原样复述用户输入，也不要把要求改写成正文内容。",
    "",
    draftBlock,
    "",
    "## 用户输入",
    userMessage.trim(),
    "",
    "约束：",
    "1. 如果已有题材，必须保留并强化题材一致性。",
    "2. 润色模式优先保留原信息结构，修改模式允许重写表达。",
    "3. 输出正文必须是可直接落库的正式文案，不要夹带生成过程说明。",
  ].join("\n");
}

async function runLegacyDraftTool(params: {
  readonly pipeline: InstrumentablePipelineLike;
  readonly input: string;
  readonly existingDraft?: BookCreationDraft;
  readonly themeGenre?: string;
}): Promise<{
  readonly draft: BookCreationDraft;
  readonly responseText: string;
  readonly toolCall?: { name: string; arguments: Record<string, unknown> };
}> {
  const { pipeline, input, existingDraft, themeGenre } = params;
  const concept = existingDraft?.concept ?? input;

  if (!pipeline.config?.client || !pipeline.config?.model) {
    return {
      draft: applyFieldsToDraft(existingDraft, {}, concept),
      responseText: "请先配置 LLM 模型，然后再创建书籍。",
    };
  }

  const result = await chatWithTools(
    pipeline.config.client,
    pipeline.config.model,
    [
      { role: "system", content: BOOK_DRAFT_SYSTEM_PROMPT },
      { role: "user", content: [
        themeGenre ? `## 题材\n${themeGenre}` : undefined,
        buildLegacyDraftUserContent(input, existingDraft),
      ].filter((item): item is string => Boolean(item)).join("\n\n") },
    ],
    [SAVE_BOOK_WIZARD_STEP_TOOL],
    { temperature: 0.4 },
  );

  const toolCall = result.toolCalls[0];
  const parsedArgs = parseToolCallArguments(toolCall);
  const normalizedArgs: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsedArgs)) {
    if (value === undefined || value === null) continue;
    normalizedArgs[key] = typeof value === "string" ? value : String(value);
  }

  const draft = applyFieldsToDraft(existingDraft, normalizedArgs, concept);
  if (themeGenre?.trim()) {
    draft.genre = themeGenre.trim();
    draft.mappedGenreId = draft.mappedGenreId ?? themeGenre.trim();
    draft.genreAlias = draft.genreAlias ?? themeGenre.trim();
    draft.genreSource = draft.genreSource ?? "builtin";
  }
  return {
    draft: {
      ...draft,
      readyToCreate: Boolean(draft.title && draft.genre && draft.platform),
    },
    responseText: result.content?.trim() || "已生成建书参数，请确认或修改。",
    toolCall: toolCall
      ? {
          name: toolCall.name,
          arguments: parsedArgs,
        }
      : undefined,
  };
}

function formatDraftForUserMessage(
  existingDraft: BookCreationDraft | undefined,
  userMessage: string,
): string {
  const parts: string[] = [];

  if (existingDraft) {
    parts.push("## 当前草案状态");
    const entries = Object.entries(existingDraft).filter(
      ([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0),
    );
    for (const [key, value] of entries) {
      parts.push(`- **${key}**: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
    parts.push("");
  }

  parts.push("## 用户输入");
  parts.push(userMessage);

  return parts.join("\n");
}

export function createInteractionToolsFromDeps(
  pipeline: PipelineLike,
  state: StateLike,
  hooks?: {
    readonly onChatTextDelta?: (text: string) => void;
    readonly onThinkingDelta?: (text: string) => void;
    readonly onDraftTextDelta?: (text: string) => void;
    readonly onDraftRawDelta?: (text: string) => void;
    readonly getChatRequestOptions?: () => {
      readonly temperature?: number;
      readonly maxTokens?: number;
    };
  },
): InteractionRuntimeTools {
  const instrumentedPipeline = pipeline as InstrumentablePipelineLike;

  return {
    listBooks: () => state.listBooks(),
    developBookDraft: async (input, existingDraft, wizardStep, themeGenre) => {
      const result = await runLegacyDraftTool({
        pipeline: instrumentedPipeline,
        input,
        existingDraft,
        themeGenre,
      });
      return {
        __interaction: {
          responseText: result.responseText,
          details: {
            creationDraft: result.draft,
            toolCall: result.toolCall,
          },
        },
      };
    },
    reviseBookIntro: async (input, existingDraft, revisionKind = "revise", themeGenre) => {
      const result = await runIntroRevisionTool({
        pipeline: instrumentedPipeline,
        input,
        existingDraft,
        revisionKind,
        themeGenre,
        onThinkingDelta: hooks?.onThinkingDelta,
        onDraftDelta: hooks?.onDraftTextDelta,
        onDraftRawDelta: hooks?.onDraftRawDelta,
      });
      return {
        __interaction: {
          responseText: result.responseText,
          details: {
            creationDraft: result.draft,
            fieldsUpdated: result.fieldsUpdated,
            draftRaw: result.draftRaw,
          },
        },
      };
    },
    saveBookWizardStep: async (input, existingDraft, wizardStep = "intro", themeGenre) => {
      const result = await runWizardDraftTool({
        pipeline: instrumentedPipeline,
        step: wizardStep,
        mode: "modify",
        input,
        existingDraft,
        themeGenre,
        onThinkingDelta: hooks?.onThinkingDelta,
        onDraftDelta: hooks?.onDraftTextDelta,
        onDraftRawDelta: hooks?.onDraftRawDelta,
      });
      return {
        __interaction: {
          responseText: result.responseText,
          details: {
            creationDraft: result.draft,
            fieldsUpdated: result.fieldsUpdated,
            draftRaw: result.draftRaw,
          },
        },
      };
    },
    advanceBookWizard: async (input, existingDraft, wizardStep = "intro", themeGenre) => {
      const result = await runWizardDraftTool({
        pipeline: instrumentedPipeline,
        step: wizardStep,
        mode: "generate",
        input,
        existingDraft,
        themeGenre,
        onThinkingDelta: hooks?.onThinkingDelta,
        onDraftDelta: hooks?.onDraftTextDelta,
        onDraftRawDelta: hooks?.onDraftRawDelta,
      });
      return {
        __interaction: {
          responseText: result.responseText,
          details: {
            creationDraft: result.draft,
            fieldsUpdated: result.fieldsUpdated,
            draftRaw: result.draftRaw,
          },
        },
      };
    },
    createBook: async (input) => {
      const book = buildBookConfig(input);
      if (!pipeline.initBook) {
        throw new Error("Pipeline does not support shared book creation.");
      }
      const foundationBrief = buildCreationExternalContext(input);
      await pipeline.initBook(book, {
        externalContext: foundationBrief,
        foundationBrief,
        authorIntent: input.authorIntent,
        currentFocus: input.currentFocus,
      });
      return {
        bookId: book.id,
        title: book.title,
        __interaction: {
          responseText: `Created ${book.title} (${book.id}).`,
          details: {
            bookId: book.id,
            title: book.title,
          },
        },
      };
    },
    exportBook: async (bookId, options) => {
      const result = await exportBookToPath(state, bookId, options);
      return {
        ...result,
        __interaction: {
          responseText: `Exported ${bookId} to ${result.outputPath} (${result.chaptersExported} chapters).`,
          details: {
            outputPath: result.outputPath,
            chaptersExported: result.chaptersExported,
            totalWords: result.totalWords,
            format: result.format,
          },
        },
      };
    },
    chat: async (input, options) => {
      const bookLabel = options.bookId ?? "none";
      const chatRequestOptions = hooks?.getChatRequestOptions?.() ?? {};
      let response: Awaited<ReturnType<typeof chatCompletion>> | undefined;
      if (instrumentedPipeline.config?.client && instrumentedPipeline.config?.model) {
        try {
          response = await chatCompletion(
            instrumentedPipeline.config.client,
            instrumentedPipeline.config.model,
            [
              {
                role: "system",
                content: [
                  "You are InkOS inside the terminal workbench.",
                  "Respond conversationally and briefly.",
                  "If there is no active book, help the user decide what to write next.",
                  "If there is an active book, keep the answer grounded in that book context.",
                ].join(" "),
              },
              {
                role: "user",
                content: `activeBook=${bookLabel}\nautomationMode=${options.automationMode}\nmessage=${input}`,
              },
            ],
            {
              temperature: chatRequestOptions.temperature ?? 0.4,
              ...(chatRequestOptions.maxTokens !== undefined && { maxTokens: chatRequestOptions.maxTokens }),
              onTextDelta: hooks?.onChatTextDelta,
            },
          );
        } catch (err) {
          // Thinking models (e.g. kimi-k2.5) may return empty content for simple inputs.
          // Only swallow empty-content errors; re-throw everything else (network, auth, etc.)
          const msg = err instanceof Error ? err.message : "";
          if (!msg.includes("empty") && !msg.includes("content")) {
            throw err;
          }
        }
      }

      return {
        __interaction: {
          responseText: response?.content?.trim()
            || (options.bookId
              ? `I’m here. Active book is ${options.bookId}.`
              : "I’m here. No active book yet."),
        },
      };
    },
    writeNextChapter: (bookId) => withPipelineInteractionTelemetry(
      instrumentedPipeline,
      bookId,
      () => pipeline.writeNextChapter(bookId),
    ),
    reviseDraft: (bookId, chapterNumber, mode) => withPipelineInteractionTelemetry(
      instrumentedPipeline,
      bookId,
      () => pipeline.reviseDraft(bookId, chapterNumber, mode as ReviseMode),
    ),
    patchChapterText: async (bookId, chapterNumber, targetText, replacementText) => {
      const execution = await executeEditTransaction(
        {
          bookDir: (targetBookId) => state.bookDir(targetBookId),
          loadChapterIndex: (targetBookId) => state.loadChapterIndex(targetBookId),
          saveChapterIndex: (targetBookId, index) => state.saveChapterIndex(targetBookId, index),
        },
        {
          kind: "chapter-local-edit",
          bookId,
          chapterNumber,
          instruction: `Replace ${targetText} with ${replacementText}`,
          targetText,
          replacementText,
        },
      );
      return {
        __interaction: {
          activeChapterNumber: chapterNumber,
          responseText: execution.summary,
        },
      };
    },
    renameEntity: async (bookId, oldValue, newValue) => {
      const execution = await executeEditTransaction(
        {
          bookDir: (targetBookId) => state.bookDir(targetBookId),
          loadChapterIndex: (targetBookId) => state.loadChapterIndex(targetBookId),
          saveChapterIndex: (targetBookId, index) => state.saveChapterIndex(targetBookId, index),
        },
        {
          kind: "entity-rename",
          bookId,
          entityType: "character",
          oldValue,
          newValue,
        },
      );
      return {
        __interaction: {
          responseText: execution.summary,
        },
      };
    },
    updateCurrentFocus: async (bookId, content) => {
      await state.ensureControlDocuments(bookId);
      await writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), content, "utf-8");
    },
    updateAuthorIntent: async (bookId, content) => {
      await state.ensureControlDocuments(bookId);
      await writeFile(join(state.bookDir(bookId), "story", "author_intent.md"), content, "utf-8");
    },
    writeTruthFile: async (bookId, fileName, content) => {
      await state.ensureControlDocuments(bookId);
      const target = resolveTruthArtifactTarget(fileName);
      const targetDir = join(state.bookDir(bookId), target.dir);
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, target.fileName), content, "utf-8");
    },
  };
}

