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

export interface TaskChecklistItem {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly order: number;
  readonly note?: string | null;
}

export interface TaskChecklistTemplateSummary {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface TaskChecklist {
  readonly bookId: string;
  readonly templateId?: string;
  readonly items: ReadonlyArray<TaskChecklistItem>;
  readonly updatedAt: string;
}

export interface TaskChecklistResponse {
  readonly checklist: TaskChecklist;
  readonly templates?: ReadonlyArray<TaskChecklistTemplateSummary>;
}

export interface TaskChecklistSavePayload {
  readonly templateId?: string;
  readonly items: ReadonlyArray<{
    readonly id?: string;
    readonly text: string;
    readonly done?: boolean;
    readonly note?: string | null;
  }>;
}

// --- Script Workspace ---

export interface ScriptWorkspacePromptTemplates {
  readonly script: string;
  readonly image: string;
  readonly video: string;
}

export type ScriptWorkspaceGenerationStrategy = "chapter" | "episode";

export interface ScriptWorkspaceConfig {
  readonly visualStyle: string;
  readonly directorMethod: string;
  readonly aiTool: string;
  readonly aiModel: string;
  readonly generationStrategy?: ScriptWorkspaceGenerationStrategy;
  readonly chaptersPerEpisode?: number;
  readonly episodeDurationSec: number;
  readonly segmentDurationSec: number;
  readonly segmentDurationMinSec: number;
  readonly segmentDurationMaxSec: number;
  readonly scriptPrompts: ScriptWorkspacePromptTemplates;
}

export interface ScriptWorkspaceEntity {
  readonly name: string;
  readonly description: string;
  readonly sourceChapterNumbers: ReadonlyArray<number>;
}

export interface ScriptWorkspaceScene {
  readonly id: string;
  readonly episodeNumber: number;
  readonly chapterNumber: number;
  readonly sourceChapterNumbers?: ReadonlyArray<number>;
  readonly title: string;
  readonly description: string;
  readonly location: string;
  readonly timeOfDay: string;
  readonly characters: ReadonlyArray<string>;
  readonly props: ReadonlyArray<string>;
  readonly assets: ReadonlyArray<string>;
}

export interface ScriptWorkspaceSegment {
  readonly id: string;
  readonly order: number;
  readonly episodeNumber: number;
  readonly chapterNumber: number;
  readonly sourceChapterNumbers?: ReadonlyArray<number>;
  readonly title: string;
  readonly scene: string;
  readonly durationSec: number;
  readonly characters: ReadonlyArray<string>;
  readonly props: ReadonlyArray<string>;
  readonly assets: ReadonlyArray<string>;
  readonly scriptText: string;
  readonly textToImagePrompt: string;
  readonly imageToVideoPrompt: string;
}

export interface ScriptWorkspaceEpisode {
  readonly episodeNumber: number;
  readonly chapterNumber: number;
  readonly sourceChapterNumbers?: ReadonlyArray<number>;
  readonly chapterTitle: string;
  readonly title: string;
  readonly summary: string;
  readonly durationSec: number;
  readonly segments: ReadonlyArray<ScriptWorkspaceSegment>;
}

export interface ScriptWorkspaceExtraction {
  readonly scenes: ReadonlyArray<ScriptWorkspaceScene>;
  readonly characters: ReadonlyArray<ScriptWorkspaceEntity>;
  readonly props: ReadonlyArray<ScriptWorkspaceEntity>;
  readonly assets: ReadonlyArray<ScriptWorkspaceEntity>;
}

export interface ScriptWorkspace {
  readonly bookId: string;
  readonly selectedChapterNumbers: ReadonlyArray<number>;
  readonly updatedAt: string;
  readonly config: ScriptWorkspaceConfig;
  readonly scriptPrompt: string;
  readonly extraction: ScriptWorkspaceExtraction;
  readonly episodes: ReadonlyArray<ScriptWorkspaceEpisode>;
}

export interface ScriptWorkspaceResponse {
  readonly workspace: ScriptWorkspace;
}

export interface ScriptWorkspaceSavePayload {
  readonly workspace: ScriptWorkspace;
}

export interface ScriptWorkspaceGeneratePayload {
  readonly selectedChapterNumbers?: ReadonlyArray<number>;
  readonly config?: Partial<ScriptWorkspaceConfig>;
}

export interface ScriptWorkspaceHistoryEntry {
  readonly bookId: string;
  readonly version: number;
  readonly action: string;
  readonly savedAt: string;
  readonly workspace: ScriptWorkspace;
}

export interface ScriptWorkspaceHistoryResponse {
  readonly history: ReadonlyArray<ScriptWorkspaceHistoryEntry>;
}

export interface ScriptWorkspaceDiffResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changedFields: ReadonlyArray<string>;
  readonly from: ScriptWorkspace;
  readonly to: ScriptWorkspace;
}

// --- Production Workspace ---

export type ProductionDialogueType = "none" | "dialogue" | "inner_monologue" | "voiceover";

export interface ProductionShot {
  readonly id: string;
  readonly episodeNumber: number;
  readonly chapterNumber: number;
  readonly sourceChapterNumbers?: ReadonlyArray<number>;
  readonly segmentId: string;
  readonly segmentOrder: number;
  readonly shotNumber: number;
  readonly track: string;
  readonly title: string;
  readonly scene: string;
  readonly durationSec: number;
  readonly shotType: string;
  readonly cameraMovement: string;
  readonly dialogue: string;
  readonly dialogueType: ProductionDialogueType;
  readonly mood: string;
  readonly lighting: string;
  readonly shouldGenerateImage: boolean;
  readonly characters: ReadonlyArray<string>;
  readonly props: ReadonlyArray<string>;
  readonly assets: ReadonlyArray<string>;
  readonly scriptText: string;
  readonly textToImagePrompt: string;
  readonly imageToVideoPrompt: string;
}

export interface ProductionEpisode {
  readonly episodeNumber: number;
  readonly chapterNumber: number;
  readonly sourceChapterNumbers?: ReadonlyArray<number>;
  readonly title: string;
  readonly chapterTitle: string;
  readonly summary: string;
  readonly durationSec: number;
  readonly trackCount: number;
  readonly shots: ReadonlyArray<ProductionShot>;
}

export interface ProductionWorkspace {
  readonly bookId: string;
  readonly selectedChapterNumbers: ReadonlyArray<number>;
  readonly updatedAt: string;
  readonly sourceScriptUpdatedAt: string;
  readonly sourceConfig: ScriptWorkspaceConfig;
  readonly episodes: ReadonlyArray<ProductionEpisode>;
}

export interface ProductionWorkspaceResponse {
  readonly workspace: ProductionWorkspace;
}

export interface ProductionWorkspaceSavePayload {
  readonly workspace: ProductionWorkspace;
}

export interface ProductionWorkspaceGeneratePayload {
  readonly scriptWorkspace?: ScriptWorkspace;
}

// --- Director Plan ---

export interface DirectorPlanEpisode {
  readonly episodeNumber: number;
  readonly title: string;
  readonly storyGoal: string;
  readonly emotionalBeat: string;
  readonly pacing: string;
  readonly lensLanguage: string;
  readonly blockingNotes: string;
  readonly lightingNotes: string;
  readonly soundNotes: string;
  readonly continuityNotes: string;
}

export interface DirectorPlan {
  readonly bookId: string;
  readonly updatedAt: string;
  readonly sourceProductionUpdatedAt: string;
  readonly sourceConfig: ScriptWorkspaceConfig;
  readonly visualStatement: string;
  readonly directorIntent: string;
  readonly visualRules: ReadonlyArray<string>;
  readonly cameraRules: ReadonlyArray<string>;
  readonly colorScript: ReadonlyArray<string>;
  readonly episodePlans: ReadonlyArray<DirectorPlanEpisode>;
}

export interface DirectorPlanResponse {
  readonly plan: DirectorPlan;
}

export interface DirectorPlanSavePayload {
  readonly plan: DirectorPlan;
}

export interface DirectorPlanGeneratePayload {
  readonly productionWorkspace?: ProductionWorkspace;
}

export interface DirectorPlanHistoryEntry {
  readonly bookId: string;
  readonly version: number;
  readonly action: string;
  readonly savedAt: string;
  readonly plan: DirectorPlan;
}

export interface DirectorPlanHistoryResponse {
  readonly history: ReadonlyArray<DirectorPlanHistoryEntry>;
}

export interface DirectorPlanDiffResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changedFields: ReadonlyArray<string>;
  readonly from: DirectorPlan;
  readonly to: DirectorPlan;
}

// --- Asset Library ---

export type AssetLibraryItemType = "character" | "prop" | "scene" | "reference";
export type AssetLibraryItemStatus =
  | "draft"
  | "prompt_ready"
  | "image_generating"
  | "image_ready"
  | "video_generating"
  | "video_ready"
  | "rejected";

export type AssetGenerationStatus = "pending" | "queued" | "generating" | "ready" | "failed" | "rejected";

export interface AssetLibraryGenerationState {
  readonly imageStatus: AssetGenerationStatus;
  readonly videoStatus: AssetGenerationStatus;
  readonly needsRegeneration: boolean;
  readonly lastError: string;
  readonly notes: string;
}

export interface AssetLibraryItem {
  readonly id: string;
  readonly type: AssetLibraryItemType;
  readonly name: string;
  readonly description: string;
  readonly episodeNumbers: ReadonlyArray<number>;
  readonly shotIds: ReadonlyArray<string>;
  readonly referenceCount: number;
  readonly prompt: string;
  readonly status: AssetLibraryItemStatus;
  readonly thumbnailPath: string;
  readonly filePath: string;
  readonly generation: AssetLibraryGenerationState;
  readonly tags: ReadonlyArray<string>;
}

export interface AssetLibrary {
  readonly bookId: string;
  readonly updatedAt: string;
  readonly sourceProductionUpdatedAt: string;
  readonly items: ReadonlyArray<AssetLibraryItem>;
}

export interface AssetLibraryResponse {
  readonly library: AssetLibrary;
}

export interface AssetLibrarySavePayload {
  readonly library: AssetLibrary;
}

export interface AssetLibraryGeneratePayload {
  readonly productionWorkspace?: ProductionWorkspace;
}

export interface AssetLibraryHistoryEntry {
  readonly bookId: string;
  readonly version: number;
  readonly action: string;
  readonly savedAt: string;
  readonly library: AssetLibrary;
}

export interface AssetLibraryHistoryResponse {
  readonly history: ReadonlyArray<AssetLibraryHistoryEntry>;
}

export interface AssetLibraryDiffResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changedFields: ReadonlyArray<string>;
  readonly from: AssetLibrary;
  readonly to: AssetLibrary;
}

export interface AssetLibraryUploadResponse {
  readonly path: string;
  readonly fileName: string;
  readonly url: string;
  readonly library: AssetLibrary;
}

export interface AssetLibraryUploadPayload {
  readonly itemId: string;
  readonly kind: "thumbnail" | "file";
  readonly fileName: string;
  readonly dataUrl: string;
}

// --- API Error Response ---

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
