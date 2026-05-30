import { z } from "zod";
import { AutomationModeSchema, type AutomationMode } from "./modes.js";
import { ExecutionStateSchema, InteractionEventSchema, type InteractionEvent } from "./events.js";

export const PendingDecisionSchema = z.object({
  kind: z.string().min(1),
  bookId: z.string().min(1),
  chapterNumber: z.number().int().min(1).optional(),
  summary: z.string().min(1),
});

export type PendingDecision = z.infer<typeof PendingDecisionSchema>;

export const MessageAuditDimensionCheckSchema = z.object({
  dimension: z.string(),
  status: z.enum(["pass", "warning", "failed"]),
  evidence: z.string().optional(),
});

export const BookCreationWizardStepSchema = z.enum([
  "intro",
  "world",
  "outline",
  "volume",
  "characters",
  "arc",
  "relation",
  "review",
]);

export type BookCreationWizardStep = z.infer<typeof BookCreationWizardStepSchema>;

export const MessageAuditSummarySchema = z.object({
  chapter: z.number().int().min(1),
  passed: z.boolean(),
  issueCount: z.number().int().nonnegative(),
  score: z.number().int().nonnegative(),
  severityCounts: z.object({
    critical: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
  }).optional(),
  failureGate: z.enum(["none", "critical", "score"]).optional(),
  summary: z.string().optional(),
  report: z.string().optional(),
  issues: z.array(z.string()).optional(),
  dimensionChecks: z.array(MessageAuditDimensionCheckSchema).optional(),
});

export type MessageAuditSummary = z.infer<typeof MessageAuditSummarySchema>;

export const PipelineStageProgressSchema = z.object({
  status: z.string().optional(),
  elapsedMs: z.number().int().nonnegative(),
  totalChars: z.number().int().nonnegative(),
  chineseChars: z.number().int().nonnegative(),
});

export const PipelineStageSchema = z.object({
  label: z.string(),
  status: z.enum(["pending", "active", "completed"]),
  activatedAt: z.number().int().nonnegative().optional(),
  progress: PipelineStageProgressSchema.optional(),
});

export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const ToolExecutionBatchSchema = z.object({
  batchId: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
  currentChapter: z.number().int().min(1).optional(),
  currentWords: z.number().int().nonnegative().optional(),
  failedChapterNumber: z.number().int().min(1).optional(),
  error: z.string().optional(),
});

export type ToolExecutionBatch = z.infer<typeof ToolExecutionBatchSchema>;

export const ToolExecutionAutoReviewSchema = z.object({
  enabled: z.boolean(),
  phase: z.enum(["audit", "revise"]),
  round: z.number().int().min(1),
  maxRounds: z.number().int().nonnegative(),
  final: z.boolean(),
  state: z.enum(["retrying", "passed", "failed-max-rounds", "failed-single-audit"]).optional(),
  stopReason: z.string().optional(),
  mode: z.string().optional(),
  strategyReason: z.string().optional(),
  passed: z.boolean().optional(),
  reviseRoundsUsed: z.number().int().nonnegative().optional(),
  failureGate: z.enum(["none", "critical", "score"]).optional(),
  failedDimensions: z.array(z.string()).optional(),
  mustFixUnresolvedCount: z.number().int().nonnegative().optional(),
  mustFixTotalCount: z.number().int().nonnegative().optional(),
});

export type ToolExecutionAutoReview = z.infer<typeof ToolExecutionAutoReviewSchema>;

export const ToolExecutionSchema = z.object({
  id: z.string(),
  tool: z.string(),
  agent: z.string().optional(),
  label: z.string(),
  status: z.enum(["running", "processing", "completed", "error"]),
  args: z.record(z.unknown()).optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  stages: z.array(PipelineStageSchema).optional(),
  logs: z.array(z.string()).optional(),
  previewText: z.string().optional(),
  previewChapterNumber: z.number().int().min(1).optional(),
  previewKind: z.enum(["patch"]).optional(),
  batch: ToolExecutionBatchSchema.optional(),
  autoReview: ToolExecutionAutoReviewSchema.optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
});

export type ToolExecution = z.infer<typeof ToolExecutionSchema>;

export const InteractionMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  wizardStep: BookCreationWizardStepSchema.optional(),
  thinking: z.string().optional(),
  thinkingStreaming: z.boolean().optional(),
  toolExecutions: z.array(ToolExecutionSchema).optional(),
  audit: MessageAuditSummarySchema.optional(),
  timestamp: z.number().int().nonnegative(),
}).superRefine((message, ctx) => {
  if ((message.role === "user" || message.role === "system") && message.content.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "content is required",
    });
  }
});

export type InteractionMessage = z.infer<typeof InteractionMessageSchema>;

export const BookCreationDraftSchema = z.object({
  concept: z.string().min(1),
  rawConcept: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  genre: z.string().min(1).optional(),
  genreAlias: z.string().min(1).optional(),
  genreSource: z.enum(["builtin", "project", "custom"]).optional(),
  mappedGenreId: z.string().min(1).optional(),
  platform: z.string().min(1).optional(),
  language: z.enum(["zh", "en"]).optional(),
  targetChapters: z.number().int().min(1).optional(),
  chapterWordCount: z.number().int().min(1).optional(),
  blurb: z.string().min(1).optional(),
  storyBackground: z.string().min(1).optional(),
  worldPremise: z.string().min(1).optional(),
  settingNotes: z.string().min(1).optional(),
  novelOutline: z.string().min(1).optional(),
  protagonist: z.string().min(1).optional(),
  supportingCast: z.string().min(1).optional(),
  characterMatrix: z.string().min(1).optional(),
  characterArc: z.string().min(1).optional(),
  relationshipMap: z.string().min(1).optional(),
  conflictCore: z.string().min(1).optional(),
  volumeOutline: z.string().min(1).optional(),
  constraints: z.string().min(1).optional(),
  authorIntent: z.string().min(1).optional(),
  currentFocus: z.string().min(1).optional(),
  nextQuestion: z.string().min(1).optional(),
  draftFields: z.record(z.string(), z.string()).optional(),
  confirmedFields: z.array(z.string().min(1)).optional(),
  missingFields: z.array(z.string().min(1)).default([]),
  readyToCreate: z.boolean().default(false),
});

export type BookCreationDraft = z.infer<typeof BookCreationDraftSchema>;

function hasAnyText(...values: ReadonlyArray<string | undefined>): boolean {
  return values.some((value) => typeof value === "string" && value.trim().length > 0);
}

export const BookCreationIntroPageDraftSchema = z.object({
  blurb: z.string().min(1).optional(),
  storyBackground: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!hasAnyText(value.blurb, value.storyBackground)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blurb"],
      message: "intro page requires either blurb or storyBackground",
    });
  }
});

export const BookCreationWorldPageDraftSchema = z.object({
  worldPremise: z.string().min(1).optional(),
  settingNotes: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!hasAnyText(value.worldPremise, value.settingNotes)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["worldPremise"],
      message: "world page requires worldPremise or settingNotes",
    });
  }
});

export const BookCreationOutlinePageDraftSchema = z.object({
  novelOutline: z.string().min(1).optional(),
  conflictCore: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!hasAnyText(value.novelOutline, value.conflictCore)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["novelOutline"],
      message: "outline page requires novelOutline or conflictCore",
    });
  }
});

export const BookCreationVolumePageDraftSchema = z.object({
  volumeOutline: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!hasAnyText(value.volumeOutline)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["volumeOutline"],
      message: "volume page requires volumeOutline",
    });
  }
});

export const BookCreationCharactersPageDraftSchema = z.object({
  protagonist: z.string().min(1).optional(),
  supportingCast: z.string().min(1).optional(),
  characterMatrix: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!hasAnyText(value.protagonist, value.supportingCast, value.characterMatrix)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["protagonist"],
      message: "characters page requires protagonist/supportingCast/characterMatrix",
    });
  }
});

export const BookCreationArcPageDraftSchema = z.object({
  characterArc: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!hasAnyText(value.characterArc)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["characterArc"],
      message: "arc page requires characterArc",
    });
  }
});

export const BookCreationRelationPageDraftSchema = z.object({
  relationshipMap: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!hasAnyText(value.relationshipMap)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["relationshipMap"],
      message: "relation page requires relationshipMap",
    });
  }
});

export const BookCreationReviewDraftSchema = z.object({
  title: z.string().min(1),
  genre: z.string().min(1),
  platform: z.string().min(1),
  language: z.enum(["zh", "en"]).optional(),
  targetChapters: z.number().int().min(1),
  chapterWordCount: z.number().int().min(1),
});

export const BookCreationPageDraftSchemaMap = {
  intro: BookCreationIntroPageDraftSchema,
  world: BookCreationWorldPageDraftSchema,
  outline: BookCreationOutlinePageDraftSchema,
  volume: BookCreationVolumePageDraftSchema,
  characters: BookCreationCharactersPageDraftSchema,
  arc: BookCreationArcPageDraftSchema,
  relation: BookCreationRelationPageDraftSchema,
  review: BookCreationReviewDraftSchema,
} as const;

export interface BookCreationConsistencyResult {
  readonly readyToCreate: boolean;
  readonly missingFields: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

function extractStepDraftPayload(
  step: BookCreationWizardStep,
  draft: BookCreationDraft,
): Record<string, unknown> {
  switch (step) {
    case "intro":
      return {
        blurb: draft.blurb,
        storyBackground: draft.storyBackground,
      };
    case "world":
      return {
        worldPremise: draft.worldPremise,
        settingNotes: draft.settingNotes,
      };
    case "outline":
      return {
        novelOutline: draft.novelOutline,
        conflictCore: draft.conflictCore,
      };
    case "volume":
      return {
        volumeOutline: draft.volumeOutline,
      };
    case "characters":
      return {
        protagonist: draft.protagonist,
        supportingCast: draft.supportingCast,
        characterMatrix: draft.characterMatrix,
      };
    case "arc":
      return {
        characterArc: draft.characterArc,
      };
    case "relation":
      return {
        relationshipMap: draft.relationshipMap,
      };
    case "review":
      return {
        title: draft.title,
        genre: draft.genre,
        platform: draft.platform,
        language: draft.language,
        targetChapters: draft.targetChapters,
        chapterWordCount: draft.chapterWordCount,
      };
  }
}

export const BookCreationWizardStateSchema = z.object({
  currentStep: BookCreationWizardStepSchema.default("intro"),
  completedSteps: z.array(BookCreationWizardStepSchema).default([]),
  stepNotes: z.record(z.string(), z.string()).default({}),
  updatedAt: z.number().int().nonnegative().optional(),
});

export type BookCreationWizardState = z.infer<typeof BookCreationWizardStateSchema>;

const BOOK_CREATION_WIZARD_ORDER: ReadonlyArray<BookCreationWizardStep> = [
  "intro",
  "world",
  "outline",
  "volume",
  "characters",
  "arc",
  "relation",
  "review",
];

function uniqueWizardSteps(steps: ReadonlyArray<BookCreationWizardStep>): BookCreationWizardStep[] {
  return [...new Set(steps)];
}

function resolveWizardStepOrDefault(step?: BookCreationWizardStep): BookCreationWizardStep {
  return step && BOOK_CREATION_WIZARD_ORDER.includes(step) ? step : "intro";
}

export const DraftRoundSchema = z.object({
  roundId: z.number().int().min(1),
  userMessage: z.string(),
  assistantRaw: z.string(),
  fieldsUpdated: z.array(z.string()).default([]),
  summary: z.string().default(""),
  timestamp: z.number().int().nonnegative(),
});

export type DraftRound = z.infer<typeof DraftRoundSchema>;

export const InteractionSessionSchema = z.object({
  sessionId: z.string().min(1),
  projectRoot: z.string().min(1),
  activeBookId: z.string().min(1).optional(),
  activeChapterNumber: z.number().int().min(1).optional(),
  creationDraft: BookCreationDraftSchema.optional(),
  creationWizard: BookCreationWizardStateSchema.optional(),
  draftRounds: z.array(DraftRoundSchema).default([]),
  automationMode: AutomationModeSchema.default("semi"),
  messages: z.array(InteractionMessageSchema).default([]),
  events: z.array(InteractionEventSchema).default([]),
  pendingDecision: PendingDecisionSchema.optional(),
  currentExecution: ExecutionStateSchema.optional(),
});

export type InteractionSession = z.infer<typeof InteractionSessionSchema>;

// -- Per-book session --

export const BookSessionSchema = z.object({
  sessionId: z.string().min(1),
  bookId: z.string().nullable(),
  title: z.string().nullable().default(null),
  messages: z.array(InteractionMessageSchema).default([]),
  creationDraft: BookCreationDraftSchema.optional(),
  creationWizard: BookCreationWizardStateSchema.optional(),
  draftRounds: z.array(DraftRoundSchema).default([]),
  events: z.array(InteractionEventSchema).default([]),
  currentExecution: ExecutionStateSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export type BookSession = z.infer<typeof BookSessionSchema>;

// -- Global session (simplified) --

export const GlobalSessionSchema = z.object({
  activeBookId: z.string().min(1).optional(),
  automationMode: AutomationModeSchema.default("semi"),
});

export type GlobalSession = z.infer<typeof GlobalSessionSchema>;

export function createBookSession(bookId: string | null, sessionId?: string): BookSession {
  const now = Date.now();
  return {
    sessionId: sessionId ?? `${now}-${Math.random().toString(36).slice(2, 8)}`,
    bookId,
    title: null,
    messages: [],
    draftRounds: [],
    events: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function appendBookSessionMessage(
  session: BookSession,
  message: InteractionMessage,
): BookSession {
  return {
    ...session,
    messages: [...session.messages, message].sort((a, b) => a.timestamp - b.timestamp),
    updatedAt: Date.now(),
  };
}

export function upsertBookSessionMessage(
  session: BookSession,
  message: InteractionMessage,
): BookSession {
  const index = session.messages.findIndex(
    (entry) => entry.role === message.role && entry.timestamp === message.timestamp,
  );
  const messages = index >= 0
    ? session.messages.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...message } : entry))
    : [...session.messages, message];
  return {
    ...session,
    messages: [...messages].sort((a, b) => a.timestamp - b.timestamp),
    updatedAt: Date.now(),
  };
}

export function bindActiveBook(
  session: InteractionSession,
  bookId: string,
  chapterNumber?: number,
): InteractionSession {
  return {
    ...session,
    activeBookId: bookId,
    ...(chapterNumber !== undefined ? { activeChapterNumber: chapterNumber } : {}),
  };
}

export function clearPendingDecision(session: InteractionSession): InteractionSession {
  if (!session.pendingDecision) {
    return session;
  }

  return {
    ...session,
    pendingDecision: undefined,
  };
}

export function updateCreationDraft(
  session: InteractionSession,
  draft: BookCreationDraft,
): InteractionSession {
  return {
    ...session,
    creationDraft: draft,
  };
}

export function updateCreationWizard(
  session: InteractionSession,
  wizard: BookCreationWizardState,
): InteractionSession {
  return {
    ...session,
    creationWizard: wizard,
  };
}

export function inferCreationWizardState(
  draft: BookCreationDraft | undefined,
  existing?: BookCreationWizardState,
): BookCreationWizardState | undefined {
  if (!draft) {
    return existing;
  }

  const completedSteps: BookCreationWizardStep[] = [];
  if (draft.storyBackground || draft.blurb) completedSteps.push("intro");
  if (draft.worldPremise || draft.settingNotes) completedSteps.push("world");
  if (draft.novelOutline || draft.conflictCore) completedSteps.push("outline");
  if (draft.volumeOutline) completedSteps.push("volume");
  if (draft.protagonist || draft.supportingCast) completedSteps.push("characters");
  if (draft.characterArc || draft.characterMatrix) completedSteps.push("arc");
  if (draft.relationshipMap) completedSteps.push("relation");
  if (draft.readyToCreate || completedSteps.length === BOOK_CREATION_WIZARD_ORDER.length - 1) {
    completedSteps.push("review");
  }

  const completed = uniqueWizardSteps([...(existing?.completedSteps ?? []), ...completedSteps]);
  const currentStep = existing?.currentStep && BOOK_CREATION_WIZARD_ORDER.includes(existing.currentStep)
    ? existing.currentStep
    : BOOK_CREATION_WIZARD_ORDER.find((step) => !completed.includes(step)) ?? "review";
  const stepNotes: Record<string, string> = {
    ...(existing?.stepNotes ?? {}),
    intro: draft.nextQuestion ?? existing?.stepNotes?.intro ?? "",
  };

  return {
    currentStep,
    completedSteps: completed,
    stepNotes,
    updatedAt: Date.now(),
  };
}

export function advanceCreationWizardState(
  session: InteractionSession,
  currentStep?: BookCreationWizardStep,
): BookCreationWizardState {
  const wizard = session.creationWizard ?? {
    currentStep: "intro",
    completedSteps: [],
    stepNotes: {},
  };
  const step = resolveWizardStepOrDefault(currentStep ?? wizard.currentStep);
  const stepIndex = BOOK_CREATION_WIZARD_ORDER.indexOf(step);
  const nextStep = BOOK_CREATION_WIZARD_ORDER[stepIndex + 1] ?? "review";
  return {
    currentStep: nextStep,
    completedSteps: uniqueWizardSteps([...(wizard.completedSteps ?? []), step]),
    stepNotes: wizard.stepNotes ?? {},
    updatedAt: Date.now(),
  };
}

export function retreatCreationWizardState(
  session: InteractionSession,
  currentStep?: BookCreationWizardStep,
): BookCreationWizardState {
  const wizard = session.creationWizard ?? {
    currentStep: "intro",
    completedSteps: [],
    stepNotes: {},
  };
  const step = resolveWizardStepOrDefault(currentStep ?? wizard.currentStep);
  const stepIndex = BOOK_CREATION_WIZARD_ORDER.indexOf(step);
  const previousStep = BOOK_CREATION_WIZARD_ORDER[Math.max(0, stepIndex - 1)] ?? "intro";
  return {
    currentStep: previousStep,
    completedSteps: uniqueWizardSteps((wizard.completedSteps ?? []).filter((item) => item !== step)),
    stepNotes: wizard.stepNotes ?? {},
    updatedAt: Date.now(),
  };
}

export function validateCreationDraftConsistency(
  draft: BookCreationDraft | undefined,
): BookCreationConsistencyResult {
  const missingFields: string[] = [];
  const warnings: string[] = [];

  if (!draft) {
    return {
      readyToCreate: false,
      missingFields: ["concept", "title", "genre", "platform", "targetChapters", "chapterWordCount"],
      warnings: ["draft missing"],
    };
  }

  const pageChecks = [
    ["intro", BookCreationIntroPageDraftSchema.safeParse({
      blurb: draft.blurb,
      storyBackground: draft.storyBackground,
    })],
    ["world", BookCreationWorldPageDraftSchema.safeParse({
      worldPremise: draft.worldPremise,
      settingNotes: draft.settingNotes,
    })],
    ["outline", BookCreationOutlinePageDraftSchema.safeParse({
      novelOutline: draft.novelOutline,
      conflictCore: draft.conflictCore,
    })],
    ["volume", BookCreationVolumePageDraftSchema.safeParse({
      volumeOutline: draft.volumeOutline,
    })],
    ["characters", BookCreationCharactersPageDraftSchema.safeParse({
      protagonist: draft.protagonist,
      supportingCast: draft.supportingCast,
      characterMatrix: draft.characterMatrix,
    })],
    ["arc", BookCreationArcPageDraftSchema.safeParse({
      characterArc: draft.characterArc,
    })],
    ["relation", BookCreationRelationPageDraftSchema.safeParse({
      relationshipMap: draft.relationshipMap,
    })],
    ["review", BookCreationReviewDraftSchema.safeParse({
      title: draft.title ?? "",
      genre: draft.genre ?? "",
      platform: draft.platform ?? "",
      language: draft.language,
      targetChapters: draft.targetChapters ?? 0,
      chapterWordCount: draft.chapterWordCount ?? 0,
    })],
  ] as const;

  for (const [step, result] of pageChecks) {
    if (!result.success) {
      missingFields.push(step);
      warnings.push(...result.error.issues.map((issue) => `${step}:${issue.path.join(".") || "page"}`));
    }
  }

  return {
    readyToCreate: missingFields.length === 0,
    missingFields,
    warnings,
  };
}

export function clearCreationDraft(session: InteractionSession): InteractionSession {
  if (!session.creationDraft) {
    return session.creationWizard ? { ...session, creationWizard: undefined } : session;
  }

  return {
    ...session,
    creationDraft: undefined,
    creationWizard: undefined,
    draftRounds: [],
  };
}

export function updateAutomationMode(
  session: InteractionSession,
  automationMode: AutomationMode,
): InteractionSession {
  return {
    ...session,
    automationMode,
  };
}

export function appendInteractionMessage(
  session: InteractionSession,
  message: InteractionMessage,
): InteractionSession {
  return {
    ...session,
    messages: [...session.messages, message].sort((left, right) => left.timestamp - right.timestamp),
  };
}

export function appendInteractionEvent(
  session: InteractionSession,
  event: InteractionEvent,
): InteractionSession {
  return {
    ...session,
    events: [...session.events, event],
  };
}
