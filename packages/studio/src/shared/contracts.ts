/**
 * Shared TypeScript contracts for Studio API/UI communication.
 * Ported from PR #96 (Te9ui1a) — prevents client/server type drift.
 */

// --- Health ---

export interface HealthStatus {
  readonly status: "ok";
  readonly projectRoot: string;
  readonly projectConfigFound: boolean;
  readonly envFound: boolean;
  readonly projectEnvFound: boolean;
  readonly globalConfigFound: boolean;
  readonly bookCount: number;
  readonly provider: string | null;
  readonly model: string | null;
}

// --- Books ---

export interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly platform: string;
  readonly genre: string;
  readonly targetChapters: number;
  readonly chapters: number;
  readonly chapterCount: number;
  readonly lastChapterNumber: number;
  readonly totalWords: number;
  readonly approvedChapters: number;
  readonly pendingReview: number;
  readonly pendingReviewChapters: number;
  readonly failedReview: number;
  readonly failedChapters: number;
  readonly recentRunStatus?: string | null;
  readonly updatedAt: string;
}

export interface BookDetail extends BookSummary {
  readonly createdAt: string;
  readonly chapterWordCount: number;
  readonly language: "zh" | "en" | null;
}

// --- Chapters ---

export interface ChapterSummary {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
  readonly auditIssueCount: number;
  readonly updatedAt: string;
  readonly fileName: string | null;
  readonly auditHistory?: ReadonlyArray<ChapterAuditReport>;
}

export interface ChapterDetail extends ChapterSummary {
  readonly auditIssues: ReadonlyArray<string>;
  readonly reviewNote?: string;
  readonly content: string;
}

export interface ChapterAuditReport {
  readonly auditedAt: string;
  readonly passed: boolean;
  readonly issueCount: number;
  readonly score: number;
  readonly summary?: string;
  readonly report?: string;
  readonly issues: ReadonlyArray<string>;
  readonly severityCounts?: {
    readonly critical: number;
    readonly warning: number;
    readonly info: number;
  };
  readonly failureGate?: "none" | "critical" | "score";
}

export interface SaveChapterPayload {
  readonly content: string;
}

// --- Truth Files ---

export interface TruthFileSummary {
  readonly name: string;
  readonly label: string;
  readonly exists: boolean;
  readonly path: string;
  readonly optional: boolean;
  readonly available: boolean;
}

export interface TruthFileDetail extends TruthFileSummary {
  readonly content: string | null;
}

// --- Review ---

export interface ReviewActionPayload {
  readonly chapterNumber: number;
  readonly reason?: string;
}

// --- Runs ---

export type RunAction = "draft" | "audit" | "revise" | "write-next";

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface RunLogEntry {
  readonly timestamp: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}

export interface RunActionPayload {
  readonly chapterNumber?: number;
}

export interface StudioRun {
  readonly id: string;
  readonly bookId: string;
  readonly chapter: number | null;
  readonly chapterNumber: number | null;
  readonly action: RunAction;
  readonly status: RunStatus;
  readonly stage: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly logs: ReadonlyArray<RunLogEntry>;
  readonly result?: unknown;
  readonly error?: string;
}

export interface RunStreamEvent {
  readonly type: "snapshot" | "status" | "stage" | "log";
  readonly runId: string;
  readonly run?: StudioRun;
  readonly status?: RunStatus;
  readonly stage?: string;
  readonly log?: RunLogEntry;
  readonly result?: unknown;
  readonly error?: string;
}

// --- Book Tasks ---

export type BookTaskType = "write" | "audit";

export type BookTaskStatus =
  | "queued"
  | "running"
  | "paused"
  | "stopping"
  | "retry_waiting"
  | "cancelled"
  | "failed"
  | "succeeded";

export interface BookTaskCreatePayload {
  readonly type?: BookTaskType;
  readonly source?: "book-detail" | "task-center";
  readonly requestedChapters?: number;
  readonly auditChapterStart?: number | null;
  readonly auditChapterEnd?: number | null;
  readonly wordCount?: number;
  readonly quickMode?: boolean;
  readonly preferFastWriterModel?: boolean;
  readonly retryEnabled?: boolean;
  readonly service?: string;
  readonly model?: string;
}

export interface BookTaskPatchPayload {
  readonly retryEnabled?: boolean;
  readonly options?: {
    readonly service?: string | null;
    readonly model?: string | null;
    readonly quickMode?: boolean;
  };
}

export interface BookTask {
  readonly id: string;
  readonly bookId: string;
  readonly type: BookTaskType;
  readonly source: "book-detail" | "task-center";
  readonly title: string;
  readonly status: BookTaskStatus;
  readonly stage: string;
  readonly stageLabel: string | null;
  readonly stageDetail: string | null;
  readonly stageStartedAt: string | null;
  readonly stageUpdatedAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly chapterStartedAt: string | null;
  readonly chapterFinishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly stopRequestedAt: string | null;
  readonly stoppedAt: string | null;
  readonly requestedChapters: number;
  readonly auditChapterStart: number | null;
  readonly auditChapterEnd: number | null;
  readonly completedChapters: number;
  readonly currentChapterNumber: number | null;
  readonly nextChapterNumber: number | null;
  readonly lastChapterNumber: number | null;
  readonly retryCount: number;
  readonly maxRetryAttempts: number;
  readonly retryEnabled: boolean;
  readonly retryAt: string | null;
  readonly writtenChapters: number;
  readonly writtenWords: number;
  readonly tokenUsage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  } | null;
  readonly lastErrorType: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorStage: string | null;
  readonly options: {
    readonly wordCount: number | null;
    readonly quickMode: boolean;
    readonly preferFastWriterModel: boolean;
    readonly service: string | null;
    readonly model: string | null;
  };
  readonly logs: ReadonlyArray<RunLogEntry>;
  readonly exceptionLogs: ReadonlyArray<RunLogEntry>;
  readonly result: unknown | null;
  readonly error: string | null;
}

export interface BookTaskListResponse {
  readonly tasks: ReadonlyArray<BookTask>;
}

export interface GlobalBookTaskSummary {
  readonly totalTasks: number;
  readonly activeTasks: number;
  readonly failedTasks: number;
  readonly queuedTasks: number;
  readonly succeededTasks: number;
  readonly totalWrittenChapters: number;
  readonly totalWrittenWords: number;
  readonly totalTokenUsage: number;
}

export interface GlobalBookTaskItem extends BookTask {
  readonly bookTitle: string | null;
}

export interface GlobalBookTaskListResponse {
  readonly summary: GlobalBookTaskSummary;
  readonly tasks: ReadonlyArray<GlobalBookTaskItem>;
}

export interface BookTaskDetailResponse {
  readonly task: BookTask;
}

export interface BookTaskCreateResponse {
  readonly task: BookTask;
}

export interface BookTaskStopResponse {
  readonly task: BookTask;
}

export interface BookTaskResumeResponse {
  readonly task: BookTask;
}

// --- API Error Response ---

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
