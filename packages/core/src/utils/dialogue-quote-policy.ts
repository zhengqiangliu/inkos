import type { BookRules } from "../models/book-rules.js";

export type DialogueQuotePolicyMode = "auto" | "force_double" | "force_corner" | "force_none";

export interface ResolvedDialogueQuotePolicy {
  readonly mode: DialogueQuotePolicyMode;
  readonly strict: boolean;
  readonly autoNormalize: boolean;
}

function shouldPromoteAutoMode(policy: ResolvedDialogueQuotePolicy): boolean {
  return policy.mode === "auto" && (policy.strict || policy.autoNormalize);
}

export function resolveDialogueQuotePolicy(
  bookRules: BookRules | null,
  language: "zh" | "en" = "zh",
): ResolvedDialogueQuotePolicy {
  if (language === "en") {
    return {
      mode: "auto",
      strict: false,
      autoNormalize: false,
    };
  }

  const policy = bookRules?.dialogueQuotePolicy;
  if (!policy) {
    return {
      mode: "auto",
      strict: false,
      autoNormalize: false,
    };
  }

  const resolved: ResolvedDialogueQuotePolicy = {
    mode: policy.mode ?? "auto",
    strict: policy.strict ?? false,
    autoNormalize: policy.autoNormalize ?? false,
  };

  return shouldPromoteAutoMode(resolved)
    ? { ...resolved, mode: "force_double" }
    : resolved;
}

export function normalizeDialogueQuotesByPolicy(
  content: string,
  mode: DialogueQuotePolicyMode,
): string {
  if (mode === "force_double") {
    return content
      .replace(/「/g, "“")
      .replace(/」/g, "”")
      .replace(/『/g, "“")
      .replace(/』/g, "”");
  }
  if (mode === "force_corner") {
    return content
      .replace(/“/g, "「")
      .replace(/”/g, "」")
      .replace(/『/g, "「")
      .replace(/』/g, "」");
  }
  return content;
}
