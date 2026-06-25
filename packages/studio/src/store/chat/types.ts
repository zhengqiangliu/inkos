// -- Data types --

export type { BookCreationWizardStep } from "@actalk/inkos-core";

export interface ToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface TokenUsageSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface AuditSeverityCounts {
  readonly critical: number;
  readonly warning: number;
  readonly info: number;
}

export type AuditFailureGate = "none" | "critical" | "score";

export interface AuditDimensionCheck {
  readonly dimension: string;
  readonly status: "pass" | "warning" | "failed";
  readonly evidence?: string;
}

export interface MessageAuditSummary {
  readonly chapter: number;
  readonly passed: boolean;
  readonly issueCount: number;
  readonly score: number;
  readonly severityCounts?: AuditSeverityCounts;
  readonly failureGate?: AuditFailureGate;
  readonly summary?: string;
  readonly report?: string;
  readonly issues?: ReadonlyArray<string>;
  readonly dimensionChecks?: ReadonlyArray<AuditDimensionCheck>;
}

export interface PipelineStage {
  label: string;
  status: "pending" | "active" | "completed";
  activatedAt?: number;
  progress?: {
    status?: string;          // "thinking" | "streaming" | ...
    elapsedMs: number;
    totalChars: number;
    chineseChars: number;
  };
}

export interface BatchProgressState {
  batchId: string;
  status: "running" | "completed" | "failed";
  total: number;
  completed: number;
  elapsedMs: number;
  currentChapter?: number;
  currentWords?: number;
  failedChapterNumber?: number;
  error?: string;
}

export interface AutoReviewProgressState {
  enabled: boolean;
  phase: "audit" | "revise";
  round: number;
  maxRounds: number;
  final: boolean;
  state?: "retrying" | "passed" | "failed-max-rounds" | "failed-single-audit";
  stopReason?: string;
  mode?: string;
  strategyReason?: string;
  passed?: boolean;
  reviseRoundsUsed?: number;
  failureGate?: AuditFailureGate;
  failedDimensions?: ReadonlyArray<string>;
  mustFixUnresolvedCount?: number;
  mustFixTotalCount?: number;
}

export interface ToolExecution {
  id: string;
  tool: string;
  agent?: string;
  label: string;
  status: "running" | "processing" | "completed" | "error";
  args?: Record<string, unknown>;
  result?: string;
  error?: string;
  stages?: PipelineStage[];
  logs?: string[];
  previewText?: string;
  previewChapterNumber?: number;
  previewKind?: "patch";
  batch?: BatchProgressState;
  autoReview?: AutoReviewProgressState;
  startedAt: number;
  completedAt?: number;
}

// -- Message parts (chronologically ordered for rendering) --

export type MessagePart =
  | { type: "thinking"; content: string; streaming: boolean }
  | { type: "text"; content: string }
  | { type: "tool"; execution: ToolExecution };

export interface Message {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly wizardStep?: import("@actalk/inkos-core").BookCreationWizardStep;
  readonly thinking?: string;
  readonly thinkingStreaming?: boolean;
  readonly audit?: MessageAuditSummary;
  readonly timestamp: number;
  readonly toolCall?: ToolCall;
  readonly toolExecutions?: ToolExecution[];
  readonly parts?: MessagePart[];              // chronological parts for interleaved rendering
}

export interface SessionMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly wizardStep?: import("@actalk/inkos-core").BookCreationWizardStep;
  readonly thinking?: string;
  readonly thinkingStreaming?: boolean;
  readonly audit?: MessageAuditSummary;
  readonly toolExecutions?: ToolExecution[];
  readonly timestamp: number;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly bookId: string | null;
  readonly title: string | null;
  readonly messageCount: number;
  readonly hasWizardStepMessage?: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgentResponse {
  readonly runId?: string;
  readonly response?: string;
  readonly error?: string | { code?: string; message?: string };
  readonly quickMode?: boolean;
  readonly tokenUsage?: TokenUsageSummary;
  readonly details?: {
    readonly draftRaw?: string;
    readonly creationDraft?: unknown;
    readonly creationWizard?: unknown;
    readonly fieldsUpdated?: ReadonlyArray<string>;
    readonly activeBookId?: string;
    readonly toolCall?: ToolCall;
    readonly effects?: {
      readonly writeNext?: {
        readonly persisted?: boolean;
        readonly addedChapterNumbers?: ReadonlyArray<number>;
        readonly repairedChapterNumbers?: ReadonlyArray<number>;
      };
    };
  };
  readonly session?: {
    readonly sessionId?: string;
    readonly bookId?: string | null;
    readonly title?: string | null;
    readonly activeBookId?: string;
    readonly creationDraft?: unknown;
    readonly messages?: ReadonlyArray<SessionMessage>;
  };
  readonly request?: unknown;
}

export interface SessionResponse {
  readonly session?: {
    readonly sessionId?: string;
    readonly bookId?: string | null;
    readonly title?: string | null;
    readonly activeBookId?: string;
    readonly creationDraft?: unknown;
    readonly creationWizard?: unknown;
    readonly messages?: ReadonlyArray<SessionMessage>;
  } | null;
  readonly activeBookId?: string;
}

// -- State interfaces --

export interface BookSummary {
  world: string;
  protagonist: string;
  cast: string;
}

export interface ArtifactChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
  readonly auditIssues?: ReadonlyArray<string>;
  readonly audit?: MessageAuditSummary;
  readonly auditHistory?: ReadonlyArray<{
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
  }>;
}

export interface SessionRuntime {
  readonly sessionId: string;
  readonly bookId: string | null;
  readonly title: string | null;
  readonly hasWizardStepMessage?: boolean;
  readonly messages: ReadonlyArray<Message>;
  readonly currentWizardStep?: import("@actalk/inkos-core").BookCreationWizardStep | null;
  readonly stream: EventSource | null;
  readonly isStreaming: boolean;
  readonly isStopping: boolean;
  readonly stoppedByUser: boolean;
  readonly currentRunId: string | null;
  readonly lastError: string | null;
  readonly pendingBookArgs: Record<string, unknown> | null;
  readonly creationDraft?: import("@actalk/inkos-core").BookCreationDraft;
  readonly creationWizard?: import("@actalk/inkos-core").BookCreationWizardState;
  // 仅前端存在、尚未持久化到磁盘的草稿会话。发送第一条消息时才调 POST /sessions 把它落盘。
  readonly isDraft: boolean;
}

export interface MessageState {
  sessions: Record<string, SessionRuntime>;
  sessionIdsByBook: Record<string, ReadonlyArray<string>>;
  activeSessionId: string | null;
  input: string;
  selectedModel: string | null;
  selectedService: string | null;
}

export interface CreateState {
  bookCreating: boolean;
  createProgress: string;
  bookDataVersion: number;
  sidebarView: "panel" | "artifact";
  artifactSource: "truth" | "wizard";
  artifactFile: string | null;         // foundation file name, e.g. "story_bible.md"
  artifactChapter: number | null;      // chapter number, e.g. 1
  artifactChapterMeta: ArtifactChapterMeta | null;
  artifactEditMode: boolean;
  bookSummary: BookSummary | null;
}

export type ChatState = MessageState & CreateState;

// -- Action interfaces --

export interface MessageActions {
  activateSession: (sessionId: string | null) => void;
  setInput: (text: string) => void;
  addUserMessage: (sessionId: string, content: string, wizardStep?: import("@actalk/inkos-core").BookCreationWizardStep) => void;
  appendAssistantMessage: (sessionId: string, content: string, wizardStep?: import("@actalk/inkos-core").BookCreationWizardStep) => void;
  replaceWizardStepMessage: (sessionId: string, wizardStep: import("@actalk/inkos-core").BookCreationWizardStep, content: string) => void;
  appendStreamChunk: (sessionId: string, text: string, streamTs: number) => void;
  finalizeStream: (sessionId: string, streamTs: number, content: string, toolCall?: ToolCall) => void;
  replaceStreamWithError: (sessionId: string, streamTs: number, errorMsg: string, wizardStep?: import("@actalk/inkos-core").BookCreationWizardStep) => void;
  addErrorMessage: (sessionId: string, errorMsg: string, wizardStep?: import("@actalk/inkos-core").BookCreationWizardStep) => void;
  loadSessionMessages: (sessionId: string, msgs: ReadonlyArray<SessionMessage>) => void;
  loadSessionList: (bookId: string | null) => Promise<void>;
  createSession: (
    bookId: string | null,
    options?: {
      readonly activate?: boolean;
    },
  ) => Promise<string>;
  createDraftSession: (bookId: string | null) => string;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  loadSessionDetail: (sessionId: string) => Promise<void>;
  sendMessage: (
    sessionId: string,
    text: string,
    activeBookId?: string,
    options?: {
      readonly quickMode?: boolean;
      readonly preferFastWriterModel?: boolean;
      readonly skipAutoNewPrefix?: boolean;
      readonly wizardStep?: import("@actalk/inkos-core").BookCreationWizardStep;
      readonly themeGenre?: string;
      readonly forceStream?: boolean;
      readonly responseFormat?: "json_object";
      readonly propagateErrors?: boolean;
      readonly wizardAdvance?: {
        readonly wizardStep: string;
        readonly nextStep?: string;
        readonly language: string;
        readonly stepTitle: string;
        readonly title?: string;
        readonly genre?: string;
        readonly platform?: string;
        readonly targetChapters?: number;
        readonly chapterWordCount?: number;
        readonly instruction?: string;
      };
    },
  ) => Promise<AgentResponse | null>;
  stopMessage: (sessionId: string) => Promise<void>;
  setSelectedModel: (model: string, service: string, options?: { readonly persist?: boolean }) => void;
}

export interface CreateActions {
  setPendingBookArgs: (args: Record<string, unknown> | null) => void;
  setBookCreating: (creating: boolean) => void;
  setCreateProgress: (progress: string) => void;
  handleCreateBook: (sessionId: string, activeBookId?: string) => Promise<string | null>;
  bumpBookDataVersion: () => void;
  openArtifact: (file: string, source?: "truth" | "wizard") => void;
  openChapterArtifact: (
    chapterNum: number,
    options?: {
      readonly edit?: boolean;
      readonly meta?: ArtifactChapterMeta | null;
    },
  ) => void;
  closeArtifact: () => void;
  setBookSummary: (summary: BookSummary | null) => void;
}

// -- Composed store type --

export type ChatStore = ChatState & MessageActions & CreateActions;
