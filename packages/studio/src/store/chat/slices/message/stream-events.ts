import type { StateCreator } from "zustand";
import type {
  AutoReviewProgressState,
  ChatStore,
  BookCreationWizardStep,
  Message,
  MessageActions,
  MessageAuditSummary,
  MessagePart,
  PipelineStage,
} from "../../types";
import { shouldRefreshSidebarForTool } from "../../message-policy";
import {
  deriveFlat,
  extractToolError,
  findRunningToolPart,
  getOrCreateStream,
  replaceLast,
  resolveToolLabel,
  sessionMatchesEvent,
  summarizeResult,
  updateSession,
} from "./runtime";

type SliceSet = Parameters<StateCreator<ChatStore, [], [], MessageActions>>[0];
type SliceGet = Parameters<StateCreator<ChatStore, [], [], MessageActions>>[1];

interface AttachSessionStreamListenersInput {
  sessionId: string;
  runId: string;
  streamTs: number;
  streamEs: EventSource;
  set: SliceSet;
  get: SliceGet;
}

function toPartialText(partialResult: unknown): string | undefined {
  if (typeof partialResult === "string") return partialResult.trim() || undefined;
  if (!partialResult || typeof partialResult !== "object") return undefined;
  const payload = partialResult as { content?: unknown; text?: unknown };
  if (typeof payload.text === "string" && payload.text.trim()) return payload.text.trim();
  if (typeof payload.content === "string" && payload.content.trim()) return payload.content.trim();
  if (Array.isArray(payload.content)) {
    const text = payload.content
      .filter((item): item is { type?: unknown; text?: unknown } => !!item && typeof item === "object")
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => String(item.text).trim())
      .filter(Boolean)
      .join("\n");
    return text || undefined;
  }
  return undefined;
}

function hasLegacySessionMatch(sessionId: string, data: unknown, runId: string): boolean {
  if (!data || typeof data !== "object") return false;
  const event = data as { sessionId?: unknown; runId?: unknown };
  if (event.sessionId !== sessionId) return false;
  return event.runId === undefined || event.runId === null;
}

function normalizeAuditSeverityCounts(value: unknown): MessageAuditSummary["severityCounts"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const counts = value as { critical?: unknown; warning?: unknown; info?: unknown };
  const critical = Number(counts.critical ?? 0);
  const warning = Number(counts.warning ?? 0);
  const info = Number(counts.info ?? 0);
  if (!Number.isFinite(critical) || !Number.isFinite(warning) || !Number.isFinite(info)) return undefined;
  return {
    critical: Math.max(0, Math.trunc(critical)),
    warning: Math.max(0, Math.trunc(warning)),
    info: Math.max(0, Math.trunc(info)),
  };
}

function normalizeAuditIssueTexts(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAuditFailureGate(value: unknown): MessageAuditSummary["failureGate"] | undefined {
  if (value === "none" || value === "critical" || value === "score") {
    return value;
  }
  return undefined;
}

function normalizeAuditDimensionChecks(value: unknown): MessageAuditSummary["dimensionChecks"] | undefined {
  type AuditDimensionCheck = NonNullable<MessageAuditSummary["dimensionChecks"]>[number];
  if (!Array.isArray(value)) return undefined;
  const normalized: AuditDimensionCheck[] = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const payload = item as { dimension?: unknown; status?: unknown; evidence?: unknown };
      const dimension = typeof payload.dimension === "string" ? payload.dimension.trim() : "";
      if (!dimension) return null;
      const status = payload.status === "pass" || payload.status === "warning" || payload.status === "failed"
        ? payload.status
        : null;
      if (!status) return null;
      const evidence = typeof payload.evidence === "string" && payload.evidence.trim()
        ? payload.evidence.trim()
        : undefined;
      return {
        dimension,
        status,
        ...(evidence ? { evidence } : {}),
      };
    })
    .filter((item): item is AuditDimensionCheck => item !== null);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAuditSummary(data: unknown): MessageAuditSummary | null {
  if (!data || typeof data !== "object") return null;
  const payload = data as {
    chapter?: unknown;
    chapterNumber?: unknown;
    passed?: unknown;
    issueCount?: unknown;
    score?: unknown;
    severityCounts?: unknown;
    failureGate?: unknown;
    summary?: unknown;
    report?: unknown;
    issues?: unknown;
    dimensionChecks?: unknown;
  };
  const chapterRaw = payload.chapterNumber ?? payload.chapter;
  const chapter = Number(chapterRaw);
  if (!Number.isFinite(chapter) || chapter <= 0) return null;

  const issues = normalizeAuditIssueTexts(payload.issues);
  const severityCounts = normalizeAuditSeverityCounts(payload.severityCounts);
  const failureGate = normalizeAuditFailureGate(payload.failureGate);
  const dimensionChecks = normalizeAuditDimensionChecks(payload.dimensionChecks);
  const issueCountRaw = Number(payload.issueCount);
  const issueCount = Number.isFinite(issueCountRaw)
    ? Math.max(0, Math.trunc(issueCountRaw))
    : issues?.length ?? 0;
  const scoreRaw = Number(payload.score);
  const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, Math.trunc(scoreRaw))) : 0;

  return {
    chapter,
    passed: Boolean(payload.passed),
    issueCount,
    score,
    ...(severityCounts ? { severityCounts } : {}),
    ...(failureGate ? { failureGate } : {}),
    ...(typeof payload.summary === "string" && payload.summary.trim()
      ? { summary: payload.summary.trim() }
      : {}),
    ...(typeof payload.report === "string" && payload.report.trim()
      ? { report: payload.report.trim() }
      : {}),
    ...(issues ? { issues } : {}),
    ...(dimensionChecks ? { dimensionChecks } : {}),
  };
}

function shouldIgnoreHeartbeatLog(message: string): boolean {
  return /（进行中\s*\d+s）|\(\d+s elapsed\)/i.test(message);
}

function detectStageFromLog(message: string, stages?: PipelineStage[]): string | undefined {
  if (!stages?.length) return undefined;
  const normalized = message.trim();
  const direct = stages.find((stage) => normalized.includes(stage.label));
  if (direct) return direct.label;

  if (/后写校验|正文清洗|字数归一化|spot-fix|post-write/i.test(normalized)) {
    const mapped = stages.find((stage) => /正文清洗与校验/i.test(stage.label));
    if (mapped) return mapped.label;
  }

  // Writer internal phases may not use the exact pipeline stage labels.
  // Map these logs to the nearest visible stage so the UI does not appear stuck.
  if (/阶段\s*2[:：]|状态结算|提取第\d+章事实|回写到真相文件/i.test(normalized)) {
    const mapped = stages.find((stage) => /生成最终真相文件/i.test(stage.label));
    if (mapped) return mapped.label;
  }

  const match = normalized.match(/阶段(?:\s*\d+[a-z]?)*[:：]\s*([^\(\（]+)/i);
  if (!match?.[1]) return undefined;
  const candidate = match[1].trim();
  const mapped = stages.find((stage) => candidate.includes(stage.label) || stage.label.includes(candidate));
  return mapped?.label;
}

function promoteStage(stages: PipelineStage[] | undefined, targetLabel: string): PipelineStage[] | undefined {
  if (!stages?.length) return stages;
  const index = stages.findIndex((stage) => stage.label === targetLabel);
  if (index < 0) return stages;
  const now = Date.now();

  return stages.map((stage, i) => {
    if (i < index) {
      return stage.status === "completed"
        ? stage
        : { ...stage, status: "completed" as const };
    }
    if (i === index) {
      return stage.status === "active"
        ? stage
        : { ...stage, status: "active" as const, activatedAt: now };
    }
    if (stage.status === "active") {
      return { ...stage, status: "pending" as const };
    }
    return stage;
  });
}

function resolveTelemetryToolId(parts: MessagePart[] | undefined): string | undefined {
  const allParts = [...(parts ?? [])];
  const runningTool = findRunningToolPart(allParts);
  if (runningTool) return runningTool.execution.id;
  for (let i = allParts.length - 1; i >= 0; i -= 1) {
    const part = allParts[i];
    if (part?.type === "tool") {
      return part.execution.id;
    }
  }
  return undefined;
}

function inferAgentFromLog(message: string): string | undefined {
  const match = message.match(/\[(writer|auditor|reviser|architect)\]/i);
  return match?.[1]?.toLowerCase();
}

function ensureFallbackExecutionPart(args: {
  readonly parts: MessagePart[];
  readonly runId: string;
  readonly toolId?: string;
  readonly tool?: string;
  readonly agent?: string;
}): { parts: MessagePart[]; toolId: string } {
  const toolId = typeof args.toolId === "string" && args.toolId.trim().length > 0
    ? args.toolId.trim()
    : `telemetry-${args.runId}`;
  const existing = args.parts.find((part) => part.type === "tool" && part.execution.id === toolId);
  if (existing) {
    return { parts: args.parts, toolId };
  }
  const tool = typeof args.tool === "string" && args.tool.trim().length > 0 ? args.tool.trim() : "sub_agent";
  const execution = {
    id: toolId,
    tool,
    ...(args.agent ? { agent: args.agent } : {}),
    label: resolveToolLabel(tool, args.agent),
    status: "running" as const,
    startedAt: Date.now(),
  };
  return {
    parts: [...args.parts, { type: "tool", execution }],
    toolId,
  };
}

function findLatestPartIndex(
  parts: MessagePart[],
  predicate: (part: MessagePart) => boolean,
): number {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (predicate(parts[i]!)) return i;
  }
  return -1;
}

function resolveExecutionLabel(
  tool: string,
  agent?: string,
  args?: Record<string, unknown>,
): string {
  if (tool === "sub_agent" && agent === "reviser") {
    const mode = typeof args?.mode === "string" ? args.mode.trim().toLowerCase() : "";
    if (mode === "rewrite") return "重写";
  }
  if (tool === "sub_agent" && agent === "writer") {
    const action = typeof args?.action === "string" ? args.action.trim().toLowerCase() : "";
    if (action === "rewrite" || action === "rewrite-batch") return "重写";
  }
  return resolveToolLabel(tool, agent);
}

function mergeStreamMessage(stream: Message, parts: MessagePart[]): Message {
  const flat = deriveFlat(parts);
  return {
    ...stream,
    content: flat.content,
    thinking: flat.thinking,
    thinkingStreaming: flat.thinkingStreaming,
    toolExecutions: flat.toolExecutions,
    parts,
  };
}

function applyWizardStepToStreamMessage(
  stream: Message,
  wizardStep: BookCreationWizardStep | undefined,
): Message {
  return wizardStep ? { ...stream, wizardStep } : stream;
}

function getWizardStep(runtime: { currentWizardStep?: BookCreationWizardStep | null }): BookCreationWizardStep | undefined {
  return runtime.currentWizardStep ?? undefined;
}

function appendTextPart(parts: MessagePart[], text: string): MessagePart[] {
  if (!text) return parts;
  const next = [...parts];
  const last = next[next.length - 1];
  if (last?.type === "text") {
    next[next.length - 1] = { ...last, content: last.content + text };
    return next;
  }
  next.push({ type: "text", content: text });
  return next;
}

function normalizeAutoReviewStateValue(value: unknown): AutoReviewProgressState["state"] | undefined {
  if (
    value === "retrying"
    || value === "passed"
    || value === "failed-max-rounds"
    || value === "failed-single-audit"
  ) {
    return value;
  }
  return undefined;
}

function extractAutoReviewSignals(data: unknown): {
  readonly failureGate?: AutoReviewProgressState["failureGate"];
  readonly failedDimensions?: ReadonlyArray<string>;
  readonly mustFixUnresolvedCount?: number;
  readonly mustFixTotalCount?: number;
} {
  if (!data || typeof data !== "object") return {};
  const payload = data as {
    failureGate?: unknown;
    dimensionChecks?: unknown;
    latestRevisionMustFixOutcomes?: unknown;
    latestRevisionMustFixUnresolvedCount?: unknown;
    latestRevisionMustFixTotalCount?: unknown;
  };
  const failureGate = normalizeAuditFailureGate(payload.failureGate);
  const dimensionChecks = normalizeAuditDimensionChecks(payload.dimensionChecks);
  const failedDimensions = dimensionChecks
    ?.filter((item) => item.status === "failed")
    .map((item) => item.dimension)
    .filter((item) => item.trim().length > 0);

  let mustFixTotalCount: number | undefined;
  let mustFixUnresolvedCount: number | undefined;
  if (Array.isArray(payload.latestRevisionMustFixOutcomes)) {
    const normalized = payload.latestRevisionMustFixOutcomes.filter(
      (item): item is { outcome?: unknown } => !!item && typeof item === "object",
    );
    mustFixTotalCount = normalized.length;
    mustFixUnresolvedCount = normalized.filter((item) => item.outcome !== "resolved").length;
  }
  const explicitTotal = Number(payload.latestRevisionMustFixTotalCount);
  if (Number.isFinite(explicitTotal) && explicitTotal >= 0) {
    mustFixTotalCount = Math.max(0, Math.trunc(explicitTotal));
  }
  const explicitUnresolved = Number(payload.latestRevisionMustFixUnresolvedCount);
  if (Number.isFinite(explicitUnresolved) && explicitUnresolved >= 0) {
    mustFixUnresolvedCount = Math.max(0, Math.trunc(explicitUnresolved));
  }

  return {
    ...(failureGate ? { failureGate } : {}),
    ...(failedDimensions && failedDimensions.length > 0 ? { failedDimensions } : {}),
    ...(typeof mustFixUnresolvedCount === "number" ? { mustFixUnresolvedCount } : {}),
    ...(typeof mustFixTotalCount === "number" ? { mustFixTotalCount } : {}),
  };
}

function toAutoReviewProgress(
  data: unknown,
  fallbackPhase: "audit" | "revise",
): AutoReviewProgressState | null {
  if (!data || typeof data !== "object") return null;
  const payload = data as {
    phase?: unknown;
    round?: unknown;
    maxRounds?: unknown;
    autoReviewFinal?: unknown;
    autoReviewState?: unknown;
    autoReviewStopReason?: unknown;
    mode?: unknown;
    strategyReason?: unknown;
    passed?: unknown;
    reviseRoundsUsed?: unknown;
    audit?: { passed?: unknown } | unknown;
  };
  const roundRaw = Number(payload.round);
  if (!Number.isFinite(roundRaw) || roundRaw <= 0) return null;
  const maxRoundsRaw = Number(payload.maxRounds);
  if (!Number.isFinite(maxRoundsRaw) || maxRoundsRaw < 0) return null;
  const round = Math.max(1, Math.trunc(roundRaw));
  const maxRounds = Math.max(0, Math.trunc(maxRoundsRaw));
  const phase = payload.phase === "audit" || payload.phase === "revise"
    ? payload.phase
    : fallbackPhase;
  const passed = typeof payload.passed === "boolean"
    ? payload.passed
    : (payload.audit && typeof payload.audit === "object" && typeof (payload.audit as { passed?: unknown }).passed === "boolean"
      ? Boolean((payload.audit as { passed?: unknown }).passed)
      : undefined);
  const reviseRoundsUsedRaw = Number(payload.reviseRoundsUsed);
  const reviseRoundsUsed = Number.isFinite(reviseRoundsUsedRaw)
    ? Math.max(0, Math.trunc(reviseRoundsUsedRaw))
    : phase === "revise"
      ? round
      : Math.max(0, round - 1);
  const stopReason = typeof payload.autoReviewStopReason === "string" && payload.autoReviewStopReason.trim().length > 0
    ? payload.autoReviewStopReason.trim()
    : undefined;
  const mode = typeof payload.mode === "string" && payload.mode.trim().length > 0
    ? payload.mode.trim()
    : undefined;
  const strategyReason = typeof payload.strategyReason === "string" && payload.strategyReason.trim().length > 0
    ? payload.strategyReason.trim()
    : undefined;
  const state = normalizeAutoReviewStateValue(payload.autoReviewState);
  return {
    enabled: maxRounds > 0,
    phase,
    round,
    maxRounds,
    final: Boolean(payload.autoReviewFinal),
    ...(state ? { state } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(mode ? { mode } : {}),
    ...(strategyReason ? { strategyReason } : {}),
    ...(typeof passed === "boolean" ? { passed } : {}),
    reviseRoundsUsed,
  };
}

function updateExecutionAutoReviewProgress(args: {
  readonly parts: MessagePart[];
  readonly runId: string;
  readonly data: unknown;
  readonly fallbackPhase: "audit" | "revise";
}): MessagePart[] {
  let parts = [...args.parts];
  const progress = toAutoReviewProgress(args.data, args.fallbackPhase);
  const signals = extractAutoReviewSignals(args.data);
  if (!progress && Object.keys(signals).length === 0) return parts;
  const payload = args.data as { id?: unknown };
  let targetToolId = typeof payload.id === "string" && payload.id.trim().length > 0
    ? payload.id.trim()
    : resolveTelemetryToolId(parts);
  if (!targetToolId) {
    const ensured = ensureFallbackExecutionPart({
      parts,
      runId: args.runId,
      toolId: `review-${args.runId}`,
      tool: "sub_agent",
      agent: progress?.phase === "revise" ? "reviser" : "auditor",
    });
    parts = ensured.parts;
    targetToolId = ensured.toolId;
  }

  return parts.map((part) => {
    if (part.type !== "tool" || part.execution.id !== targetToolId) return part;
    const previous = part.execution.autoReview;
    const nextAutoReview = {
      ...(previous ?? progress ?? {
        enabled: false,
        phase: args.fallbackPhase,
        round: 1,
        maxRounds: 0,
        final: false,
      }),
      ...(progress ?? {}),
      ...(progress?.phase === "audit" && previous?.mode ? { mode: previous.mode } : {}),
      ...signals,
    };
    return {
      type: "tool" as const,
      execution: {
        ...part.execution,
        autoReview: nextAutoReview,
      },
    };
  });
}

export function attachSessionStreamListeners({
  sessionId,
  runId,
  streamTs,
  streamEs,
  set,
  get,
}: AttachSessionStreamListenersInput): void {
  streamEs.addEventListener("thinking:start", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId)) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = [...(stream.parts ?? []), { type: "thinking" as const, content: "", streaming: true }];
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("thinking:delta", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId) || !data?.text) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = [...(stream.parts ?? [])];
          const thinkingIndex = findLatestPartIndex(parts, (part) => part.type === "thinking");
          if (thinkingIndex >= 0) {
            const thinking = parts[thinkingIndex];
            if (thinking?.type === "thinking") {
              parts[thinkingIndex] = {
                ...thinking,
                content: thinking.content + data.text,
                streaming: true,
              };
            }
          } else {
            parts.push({ type: "thinking", content: data.text, streaming: true });
          }
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("thinking:end", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId)) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          let parts = [...(stream.parts ?? [])];
          let closedAnyStreamingThinking = false;
          parts = parts.map((part) => {
            if (part.type !== "thinking" || part.streaming !== true) return part;
            closedAnyStreamingThinking = true;
            return { ...part, streaming: false };
          });
          if (!closedAnyStreamingThinking) {
            const latestThinkingIndex = findLatestPartIndex(parts, (part) => part.type === "thinking");
            if (latestThinkingIndex >= 0) {
              const thinking = parts[latestThinkingIndex];
              if (thinking?.type === "thinking") {
                parts[latestThinkingIndex] = { ...thinking, streaming: false };
              }
            }
          }
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("draft:delta", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId) || !data?.text) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = appendTextPart([...(stream.parts ?? [])], data.text);
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("tool:start", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId) || !data?.tool) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = [...(stream.parts ?? [])];


          const agent = data.tool === "sub_agent" ? (data.args?.agent as string | undefined) : undefined;
          const stages: PipelineStage[] | undefined = Array.isArray(data.stages) && data.stages.length > 0
            ? (data.stages as string[]).map((label, index) => ({
              label,
              status: index === 0 ? "active" as const : "pending" as const,
              ...(index === 0 ? { activatedAt: Date.now() } : {}),
            }))
            : undefined;

          // Tool starts often create a full execution with stages, while log-based
          // estimates (e.g. ensureFallbackExecutionPart) may have left a stale
          // telemetry-only entry behind. Remove any such placeholder for this runId.
          const filtered = parts.filter((p) => p.type !== "tool" || !p.execution.id.startsWith(`telemetry-${runId}`));

          filtered.push({
            type: "tool",
            execution: {
              id: data.id as string,
              tool: data.tool as string,
              agent,
              label: resolveExecutionLabel(
                data.tool as string,
                agent,
                data.args as Record<string, unknown> | undefined,
              ),
              status: "running",
              args: data.args as Record<string, unknown> | undefined,
              stages,
              startedAt: Date.now(),
            },
          });

          return { messages: replaceLast(messages, mergeStreamMessage(stream, filtered)) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("tool:end", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId) || !data?.tool) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = (stream.parts ?? []).map((part) => {
            if (part.type !== "tool" || part.execution.id !== data.id) return part;
            const execution = { ...part.execution };
            execution.status = data.isError ? "error" : "completed";
            execution.completedAt = Date.now();
            execution.stages = execution.stages?.map((stage) =>
              stage.status !== "completed"
                ? { ...stage, status: "completed" as const }
                : stage,
            );
            if (data.isError) execution.error = extractToolError(data.result);
            else execution.result = summarizeResult(data.result);
            return { type: "tool" as const, execution };
          });
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));

      if (shouldRefreshSidebarForTool(data.tool as string)) {
        get().bumpBookDataVersion();
      }
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("tool:update", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId) || !data?.tool) return;
      const partialText = toPartialText(data.partialResult);
      if (!partialText) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          let parts = [...(stream.parts ?? [])];
          const runningTool = findRunningToolPart(parts);
          const requestedToolId = typeof data.id === "string" ? data.id : undefined;
          let targetToolId = requestedToolId ?? runningTool?.execution.id;
          if (
            requestedToolId
            && !parts.some((part) => part.type === "tool" && part.execution.id === requestedToolId)
          ) {
            const ensured = ensureFallbackExecutionPart({
              parts,
              runId,
              toolId: requestedToolId,
              tool: typeof data.tool === "string" ? data.tool : "sub_agent",
              agent: typeof data?.args?.agent === "string" ? data.args.agent : undefined,
            });
            parts = ensured.parts;
            targetToolId = ensured.toolId;
          }
          if (!targetToolId) {
            const ensured = ensureFallbackExecutionPart({
              parts,
              runId,
              tool: typeof data.tool === "string" ? data.tool : "sub_agent",
            });
            parts = ensured.parts;
            targetToolId = ensured.toolId;
          }
          parts = parts.map((part) => {
            if (part.type !== "tool" || part.execution.id !== targetToolId) return part;
            return {
              type: "tool" as const,
              execution: {
                ...part.execution,
                logs: [...(part.execution.logs ?? []), partialText],
              },
            };
          });
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("log", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId)) return;
      const message = data?.message as string | undefined;
      if (!message) return;
      if (shouldIgnoreHeartbeatLog(message)) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          let parts = [...(stream.parts ?? [])];
          let targetToolId = findRunningToolPart(parts)?.execution.id;
          if (!targetToolId) {
            const ensured = ensureFallbackExecutionPart({
              parts,
              runId,
              tool: "sub_agent",
              agent: inferAgentFromLog(message),
            });
            parts = ensured.parts;
            targetToolId = ensured.toolId;
          }
          const targetTool = parts.find(
            (part): part is Extract<MessagePart, { type: "tool" }> =>
              part.type === "tool" && part.execution.id === targetToolId,
          );
          const stageLabel = detectStageFromLog(message, targetTool?.execution.stages);
          parts = parts.map((part) => {
            if (part.type !== "tool" || part.execution.id !== targetToolId) return part;
            return {
              type: "tool" as const,
              execution: {
                ...part.execution,
                logs: [...(part.execution.logs ?? []), message],
                ...(stageLabel
                  ? { stages: promoteStage(part.execution.stages, stageLabel) }
                  : {}),
              },
            };
          });
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("llm:progress", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      const legacyMatch = hasLegacySessionMatch(sessionId, data, runId);
      if (!sessionMatchesEvent(sessionId, data, runId) && !legacyMatch) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const runningTool = findRunningToolPart([...(stream.parts ?? [])]);
          if (!runningTool?.execution.stages) return {};
          const parts = (stream.parts ?? []).map((part) => {
            if (part.type !== "tool" || part.execution.id !== runningTool.execution.id) return part;
            return {
              type: "tool" as const,
              execution: {
                ...part.execution,
                stages: part.execution.stages?.map((stage) =>
                  stage.status === "active"
                    ? {
                        ...stage,
                        progress: {
                          status: data.status,
                          elapsedMs: data.elapsedMs,
                          totalChars: data.totalChars,
                          chineseChars: data.chineseChars,
                        },
                      }
                    : stage,
                ),
              },
            };
          });
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("chapter:delta", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId)) return;
      const text = typeof data?.text === "string" ? data.text : "";
      if (!text) return;
      const chapterNumber = typeof data?.chapterNumber === "number" ? data.chapterNumber : undefined;
      const isPatchPreview = data?.previewType === "patch";
      if (!isPatchPreview) {
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = appendTextPart([...(stream.parts ?? [])], text);
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
      return;
    }
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = appendTextPart([...(stream.parts ?? [])], text);
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("batch:progress", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId)) return;
      const total = Number(data?.total ?? 0);
      if (!Number.isFinite(total) || total <= 0) return;
      const completed = Math.max(0, Number(data?.completed ?? 0));
      const elapsedMs = Math.max(0, Number(data?.elapsedMs ?? 0));
      const status: "running" | "completed" | "failed" = data?.status === "completed"
        ? "completed"
        : data?.status === "failed"
          ? "failed"
          : "running";
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          let parts = [...(stream.parts ?? [])];
          const runningTool = findRunningToolPart(parts);
          let targetToolId = typeof data?.id === "string"
            ? data.id
            : runningTool?.execution.id;
          if (!targetToolId) {
            const ensured = ensureFallbackExecutionPart({
              parts,
              runId,
              toolId: typeof data?.batchId === "string" ? data.batchId : undefined,
              tool: "sub_agent",
              agent: "writer",
            });
            parts = ensured.parts;
            targetToolId = ensured.toolId;
          }
          if (!targetToolId) return {};
          parts = parts.map((part) => {
            if (part.type !== "tool" || part.execution.id !== targetToolId) return part;
            return {
              type: "tool" as const,
              execution: {
                ...part.execution,
                batch: {
                  batchId: typeof data?.batchId === "string" ? data.batchId : `${targetToolId}:batch`,
                  status,
                  total,
                  completed,
                  elapsedMs,
                  ...(Number.isFinite(Number(data?.currentChapter))
                    ? { currentChapter: Number(data.currentChapter) }
                    : {}),
                  ...(Number.isFinite(Number(data?.currentWords))
                    ? { currentWords: Number(data.currentWords) }
                    : {}),
                  ...(Number.isFinite(Number(data?.failedChapterNumber))
                    ? { failedChapterNumber: Number(data.failedChapterNumber) }
                    : {}),
                  ...(typeof data?.error === "string" && data.error.trim()
                    ? { error: data.error.trim() }
                    : {}),
                },
              },
            };
          });
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("persist:check", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId)) return;
      const status = typeof data?.status === "string" ? data.status : "completed";
      const logText = status === "started"
        ? "[persist:check] 开始校验章节落盘一致性"
        : `[persist:check] ${data?.persisted ? "通过" : "失败"}`
          + ` before=${Number(data?.beforeCount ?? 0)}`
          + ` after=${Number(data?.afterCount ?? 0)}`
          + ` added=${Array.isArray(data?.addedChapterNumbers) && data.addedChapterNumbers.length > 0 ? data.addedChapterNumbers.join(",") : "-"}`
          + ` missing=${Array.isArray(data?.missingChapterFiles) && data.missingChapterFiles.length > 0 ? data.missingChapterFiles.join(",") : "-"}`;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          let parts = [...(stream.parts ?? [])];
          let targetToolId = resolveTelemetryToolId(parts);
          if (!targetToolId) {
            const ensured = ensureFallbackExecutionPart({
              parts,
              runId,
              toolId: `persist-${runId}`,
              tool: "sub_agent",
              agent: "writer",
            });
            parts = ensured.parts;
            targetToolId = ensured.toolId;
          }
          parts = parts.map((part) => {
            if (part.type !== "tool" || part.execution.id !== targetToolId) return part;
            return {
              type: "tool" as const,
              execution: {
                ...part.execution,
                logs: [...(part.execution.logs ?? []), logText],
              },
            };
          });
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("persist:repair", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId)) return;
      const status = typeof data?.status === "string" ? data.status : "completed";
      const repaired = Array.isArray(data?.repairedChapterNumbers) && data.repairedChapterNumbers.length > 0
        ? data.repairedChapterNumbers.join(",")
        : "-";
      const reason = typeof data?.reason === "string" && data.reason.trim() ? ` reason=${data.reason.trim()}` : "";
      const logText = `[persist:repair] status=${status} chapters=${repaired}${reason}`;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          let parts = [...(stream.parts ?? [])];
          let targetToolId = resolveTelemetryToolId(parts);
          if (!targetToolId) {
            const ensured = ensureFallbackExecutionPart({
              parts,
              runId,
              toolId: `persist-${runId}`,
              tool: "sub_agent",
              agent: "writer",
            });
            parts = ensured.parts;
            targetToolId = ensured.toolId;
          }
          parts = parts.map((part) => {
            if (part.type !== "tool" || part.execution.id !== targetToolId) return part;
            return {
              type: "tool" as const,
              execution: {
                ...part.execution,
                logs: [...(part.execution.logs ?? []), logText],
              },
            };
          });
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("audit:start", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId)) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = updateExecutionAutoReviewProgress({
            parts: [...(stream.parts ?? [])],
            runId,
            data,
            fallbackPhase: "audit",
          });
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("revise:start", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId)) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = updateExecutionAutoReviewProgress({
            parts: [...(stream.parts ?? [])],
            runId,
            data,
            fallbackPhase: "revise",
          });
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("revise:complete", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId)) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = updateExecutionAutoReviewProgress({
            parts: [...(stream.parts ?? [])],
            runId,
            data,
            fallbackPhase: "revise",
          });
          return { messages: replaceLast(messages, applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime))) };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("audit:complete", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId)) return;
      const audit = normalizeAuditSummary(data);
      if (!audit) return;
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (runtime) => {
          const [messages, stream] = getOrCreateStream(runtime.messages, streamTs);
          const parts = updateExecutionAutoReviewProgress({
            parts: [...(stream.parts ?? [])],
            runId,
            data,
            fallbackPhase: "audit",
          });
          const merged = applyWizardStepToStreamMessage(mergeStreamMessage(stream, parts), getWizardStep(runtime));
          return {
            messages: replaceLast(messages, { ...merged, audit }),
          };
        }),
      }));
    } catch {
      // ignore
    }
  });

  streamEs.addEventListener("wizard:advanced", (event: MessageEvent) => {
    try {
      const data = event.data ? JSON.parse(event.data) : null;
      if (!sessionMatchesEvent(sessionId, data, runId)) return;
      const { creationDraft, creationWizard } = data as {
        creationDraft?: unknown;
        creationWizard?: unknown;
      };
      set((state) => ({
        sessions: updateSession(state.sessions, sessionId, (session) => ({
          ...(creationDraft ? { creationDraft: creationDraft as never } : {}),
          ...(creationWizard ? { creationWizard: creationWizard as never } : {}),
        })),
      }));
    } catch {
      // ignore
    }
  });
}
