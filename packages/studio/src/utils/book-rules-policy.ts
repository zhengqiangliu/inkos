export type DialogueQuotePolicyMode = "auto" | "force_double" | "force_corner" | "force_none";

export interface DialogueQuotePolicy {
  readonly mode: DialogueQuotePolicyMode;
  readonly strict: boolean;
  readonly autoNormalize: boolean;
}

export interface OpeningThreeChaptersPolicy {
  readonly enabled: boolean;
  readonly applyInGovernedMode: boolean;
  readonly strict: boolean;
  readonly maxCharacters: number;
}

const DEFAULT_POLICY: DialogueQuotePolicy = {
  mode: "auto",
  strict: false,
  autoNormalize: false,
};

const DEFAULT_OPENING_POLICY: OpeningThreeChaptersPolicy = {
  enabled: true,
  applyInGovernedMode: true,
  strict: true,
  maxCharacters: 5,
};

interface FrontmatterSplit {
  readonly hasFrontmatter: boolean;
  readonly frontmatter: string;
  readonly tail: string;
}

function splitFrontmatter(raw: string): FrontmatterSplit {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/);
  if (!match) {
    return {
      hasFrontmatter: false,
      frontmatter: "",
      tail: raw,
    };
  }
  return {
    hasFrontmatter: true,
    frontmatter: match[1] ?? "",
    tail: match[2] ?? "",
  };
}

function findTopLevelYamlBlockRange(lines: ReadonlyArray<string>, key: string): { start: number; end: number } | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const keyPattern = new RegExp(`^\\s*${key}\\s*:\\s*$`);
    if (!keyPattern.test(line) || /^\s/.test(line)) continue;

    let end = i + 1;
    while (end < lines.length) {
      const next = lines[end] ?? "";
      if (next.trim().length === 0) {
        end += 1;
        continue;
      }
      if (!/^\s/.test(next)) break;
      end += 1;
    }
    return { start: i, end };
  }
  return null;
}

export function parseDialogueQuotePolicyFromBookRules(raw: string): DialogueQuotePolicy | null {
  const { hasFrontmatter, frontmatter } = splitFrontmatter(raw);
  if (!hasFrontmatter) return null;
  const lines = frontmatter.split(/\r?\n/);
  const range = findTopLevelYamlBlockRange(lines, "dialogueQuotePolicy");
  if (!range) return null;

  let mode: DialogueQuotePolicyMode = "auto";
  let strict = false;
  let autoNormalize = false;

  for (let i = range.start + 1; i < range.end; i += 1) {
    const line = (lines[i] ?? "").trim();
    const modeMatch = line.match(/^mode\s*:\s*(auto|force_double|force_corner|force_none)\s*$/);
    if (modeMatch?.[1]) {
      mode = modeMatch[1] as DialogueQuotePolicyMode;
      continue;
    }
    const strictMatch = line.match(/^strict\s*:\s*(true|false)\s*$/i);
    if (strictMatch?.[1]) {
      strict = strictMatch[1].toLowerCase() === "true";
      continue;
    }
    const normalizeMatch = line.match(/^autoNormalize\s*:\s*(true|false)\s*$/i);
    if (normalizeMatch?.[1]) {
      autoNormalize = normalizeMatch[1].toLowerCase() === "true";
      continue;
    }
  }

  return { mode, strict, autoNormalize };
}

export function parseOpeningThreeChaptersPolicyFromBookRules(raw: string): OpeningThreeChaptersPolicy | null {
  const { hasFrontmatter, frontmatter } = splitFrontmatter(raw);
  if (!hasFrontmatter) return null;
  const lines = frontmatter.split(/\r?\n/);
  const range = findTopLevelYamlBlockRange(lines, "openingThreeChapters");
  if (!range) return null;

  let enabled = DEFAULT_OPENING_POLICY.enabled;
  let applyInGovernedMode = DEFAULT_OPENING_POLICY.applyInGovernedMode;
  let strict = DEFAULT_OPENING_POLICY.strict;
  let maxCharacters = DEFAULT_OPENING_POLICY.maxCharacters;

  for (let i = range.start + 1; i < range.end; i += 1) {
    const line = (lines[i] ?? "").trim();
    const enabledMatch = line.match(/^enabled\s*:\s*(true|false)\s*$/i);
    if (enabledMatch?.[1]) {
      enabled = enabledMatch[1].toLowerCase() === "true";
      continue;
    }
    const governedMatch = line.match(/^applyInGovernedMode\s*:\s*(true|false)\s*$/i);
    if (governedMatch?.[1]) {
      applyInGovernedMode = governedMatch[1].toLowerCase() === "true";
      continue;
    }
    const strictMatch = line.match(/^strict\s*:\s*(true|false)\s*$/i);
    if (strictMatch?.[1]) {
      strict = strictMatch[1].toLowerCase() === "true";
      continue;
    }
    const maxCharactersMatch = line.match(/^maxCharacters\s*:\s*(\d+)\s*$/i);
    if (maxCharactersMatch?.[1]) {
      const parsed = Number.parseInt(maxCharactersMatch[1], 10);
      if (Number.isFinite(parsed)) {
        maxCharacters = Math.min(8, Math.max(3, Math.trunc(parsed)));
      }
      continue;
    }
  }

  return { enabled, applyInGovernedMode, strict, maxCharacters };
}

function formatPolicyBlock(policy: DialogueQuotePolicy): string[] {
  return [
    "dialogueQuotePolicy:",
    `  mode: ${policy.mode}`,
    `  strict: ${policy.strict ? "true" : "false"}`,
    `  autoNormalize: ${policy.autoNormalize ? "true" : "false"}`,
  ];
}

function formatOpeningPolicyBlock(policy: OpeningThreeChaptersPolicy): string[] {
  return [
    "openingThreeChapters:",
    `  enabled: ${policy.enabled ? "true" : "false"}`,
    `  applyInGovernedMode: ${policy.applyInGovernedMode ? "true" : "false"}`,
    `  strict: ${policy.strict ? "true" : "false"}`,
    `  maxCharacters: ${policy.maxCharacters}`,
  ];
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const result = [...lines];
  while (result.length > 0 && result[result.length - 1]!.trim().length === 0) {
    result.pop();
  }
  return result;
}

export function upsertDialogueQuotePolicyInBookRules(
  raw: string,
  policyInput: Partial<DialogueQuotePolicy>,
): string {
  const policy: DialogueQuotePolicy = {
    ...DEFAULT_POLICY,
    ...policyInput,
  };
  const { hasFrontmatter, frontmatter, tail } = splitFrontmatter(raw);

  const existingLines = hasFrontmatter ? frontmatter.split(/\r?\n/) : [];
  const range = findTopLevelYamlBlockRange(existingLines, "dialogueQuotePolicy");
  const linesWithoutPolicy = range
    ? [...existingLines.slice(0, range.start), ...existingLines.slice(range.end)]
    : [...existingLines];
  const normalizedLines = trimTrailingBlankLines(linesWithoutPolicy);
  const nextFrontmatterLines = [
    ...normalizedLines,
    ...(normalizedLines.length > 0 ? [""] : []),
    ...formatPolicyBlock(policy),
  ];
  const nextFrontmatter = nextFrontmatterLines.join("\n");

  if (hasFrontmatter) {
    return `---\n${nextFrontmatter}\n---${tail.length > 0 ? tail : "\n"}`;
  }

  const body = raw.trimStart();
  if (body.length === 0) {
    return `---\n${nextFrontmatter}\n---\n`;
  }
  return `---\n${nextFrontmatter}\n---\n\n${body}`;
}

export function upsertOpeningThreeChaptersPolicyInBookRules(
  raw: string,
  policyInput: Partial<OpeningThreeChaptersPolicy>,
): string {
  const policy: OpeningThreeChaptersPolicy = {
    ...DEFAULT_OPENING_POLICY,
    ...policyInput,
    maxCharacters: Math.min(8, Math.max(3, Math.trunc(policyInput.maxCharacters ?? DEFAULT_OPENING_POLICY.maxCharacters))),
  };
  const { hasFrontmatter, frontmatter, tail } = splitFrontmatter(raw);

  const existingLines = hasFrontmatter ? frontmatter.split(/\r?\n/) : [];
  const range = findTopLevelYamlBlockRange(existingLines, "openingThreeChapters");
  const linesWithoutPolicy = range
    ? [...existingLines.slice(0, range.start), ...existingLines.slice(range.end)]
    : [...existingLines];
  const normalizedLines = trimTrailingBlankLines(linesWithoutPolicy);
  const nextFrontmatterLines = [
    ...normalizedLines,
    ...(normalizedLines.length > 0 ? [""] : []),
    ...formatOpeningPolicyBlock(policy),
  ];
  const nextFrontmatter = nextFrontmatterLines.join("\n");

  if (hasFrontmatter) {
    return `---\n${nextFrontmatter}\n---${tail.length > 0 ? tail : "\n"}`;
  }

  const body = raw.trimStart();
  if (body.length === 0) {
    return `---\n${nextFrontmatter}\n---\n`;
  }
  return `---\n${nextFrontmatter}\n---\n\n${body}`;
}
