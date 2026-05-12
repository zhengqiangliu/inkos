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
  title: z.string().min(1).optional(),
  genre: z.string().min(1).optional(),
  platform: z.string().min(1).optional(),
  language: z.enum(["zh", "en"]).optional(),
  targetChapters: z.number().int().min(1).optional(),
  chapterWordCount: z.number().int().min(1).optional(),
  blurb: z.string().min(1).optional(),
  worldPremise: z.string().min(1).optional(),
  settingNotes: z.string().min(1).optional(),
  protagonist: z.string().min(1).optional(),
  supportingCast: z.string().min(1).optional(),
  conflictCore: z.string().min(1).optional(),
  volumeOutline: z.string().min(1).optional(),
  constraints: z.string().min(1).optional(),
  authorIntent: z.string().min(1).optional(),
  currentFocus: z.string().min(1).optional(),
  nextQuestion: z.string().min(1).optional(),
  missingFields: z.array(z.string().min(1)).default([]),
  readyToCreate: z.boolean().default(false),
});

export type BookCreationDraft = z.infer<typeof BookCreationDraftSchema>;

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

export function clearCreationDraft(session: InteractionSession): InteractionSession {
  if (!session.creationDraft) {
    return session;
  }

  return {
    ...session,
    creationDraft: undefined,
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
