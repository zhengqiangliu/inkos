import { z } from "zod";

export const ChapterPlanStatusSchema = z.enum([
  "missing",
  "planned",
  "used",
  "backfilled",
  "approved",
  "locked",
]);
export type ChapterPlanStatus = z.infer<typeof ChapterPlanStatusSchema>;

export const ChapterPlanSourceSchema = z.enum([
  "auto",
  "manual",
  "inferred_from_text",
  "regenerated",
]);
export type ChapterPlanSource = z.infer<typeof ChapterPlanSourceSchema>;

export const ChapterPlanAnchorRefsSchema = z.object({
  outlineAnchorId: z.string().optional(),
  worldRefs: z.array(z.string()).default([]),
  characterRefs: z.array(z.string()).default([]),
  emotionRefs: z.array(z.string()).default([]),
  hookRefs: z.array(z.string()).default([]),
});
export type ChapterPlanAnchorRefs = z.infer<typeof ChapterPlanAnchorRefsSchema>;

export const ChapterPlanDriftFlagSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type ChapterPlanDriftFlag = z.infer<typeof ChapterPlanDriftFlagSchema>;

export const ChapterPlanSchema = z.object({
  chapterNumber: z.number().int().min(1),
  chapterName: z.string().min(1),
  highlight: z.string().min(1),
  coreConflict: z.string().min(1),
  plotAndConflict: z.string().min(1),
  emotionalTone: z.string().min(1),
  endingHook: z.string().min(1),
  status: ChapterPlanStatusSchema.default("planned"),
  source: ChapterPlanSourceSchema.default("auto"),
  version: z.number().int().min(1).default(1),
  confidence: z.number().min(0).max(1).optional(),
  needsReview: z.boolean().default(false),
  anchorRefs: ChapterPlanAnchorRefsSchema.default({
    worldRefs: [],
    characterRefs: [],
    emotionRefs: [],
    hookRefs: [],
  }),
  driftFlags: z.array(ChapterPlanDriftFlagSchema).default([]),
  lockedFields: z.array(z.string()).default([]),
  hookAssignment: z.array(z.string()).default([]),
  requiredRecoverHooks: z.array(z.string()).default([]),
  maxNewHooks: z.number().int().min(0).default(3),
  maxRecoveryPerChapter: z.number().int().min(0).default(3),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ChapterPlan = z.infer<typeof ChapterPlanSchema>;

export const ChapterPlanCollectionSchema = z.object({
  plans: z.array(ChapterPlanSchema).default([]),
  history: z.record(
    z.string(),
    z.array(ChapterPlanSchema).default([]),
  ).default({}),
  updatedAt: z.string().datetime(),
});
export type ChapterPlanCollection = z.infer<typeof ChapterPlanCollectionSchema>;
