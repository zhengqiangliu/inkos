import { z } from "zod";
import { LengthTelemetrySchema } from "./length-governance.js";

export const ChapterStatusSchema = z.enum([
  "card-generated",
  "drafting",
  "drafted",
  "auditing",
  "audit-passed",
  "audit-failed",
  "state-degraded",
  "revising",
  "ready-for-review",
  "approved",
  "rejected",
  "published",
  "imported",
]);
export type ChapterStatus = z.infer<typeof ChapterStatusSchema>;

export const ChapterAuditReportSchema = z.object({
  auditedAt: z.string().datetime(),
  passed: z.boolean(),
  issueCount: z.number().int().min(0),
  score: z.number().int().min(0).max(100),
  summary: z.string().optional(),
  report: z.string().optional(),
  issues: z.array(z.string()).default([]),
  severityCounts: z.object({
    critical: z.number().int().min(0).default(0),
    warning: z.number().int().min(0).default(0),
    info: z.number().int().min(0).default(0),
  }).optional(),
  failureGate: z.enum(["none", "critical", "score"]).optional(),
});

export type ChapterAuditReport = z.infer<typeof ChapterAuditReportSchema>;

export const ChapterMetaSchema = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  status: ChapterStatusSchema,
  wordCount: z.number().int().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  auditIssues: z.array(z.string()).default([]),
  lengthWarnings: z.array(z.string()).default([]),
  reviewNote: z.string().optional(),
  detectionScore: z.number().min(0).max(1).optional(),
  detectionProvider: z.string().optional(),
  detectedAt: z.string().datetime().optional(),
  lengthTelemetry: LengthTelemetrySchema.optional(),
  auditHistory: z.array(ChapterAuditReportSchema).optional(),
  tokenUsage: z.object({
    promptTokens: z.number().int().default(0),
    completionTokens: z.number().int().default(0),
    totalTokens: z.number().int().default(0),
  }).optional(),
});

export type ChapterMeta = z.infer<typeof ChapterMetaSchema>;
