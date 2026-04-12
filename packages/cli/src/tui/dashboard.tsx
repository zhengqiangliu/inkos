import React, { useEffect, useRef, useState } from "react";
import {
  appendInteractionMessage,
  processProjectInteractionInput,
  routeNaturalLanguageIntent,
  type InteractionIntentType,
  type InteractionRuntimeTools,
  type InteractionSession,
} from "@actalk/inkos-core";
import { Box, Text, useApp, useInput } from "ink";
import { describeActivityState } from "./activity-state.js";
import { resolveChatDepthProfile, type ChatDepth } from "./chat-depth.js";
import { appendStreamingAssistantChunk, createOptimisticUserMessageSession } from "./chat-draft.js";
import { renderComposerDisplay } from "./composer-display.js";
import { formatTuiResult } from "./output.js";
import { buildDashboardViewModel, type DashboardMessageRow } from "./dashboard-model.js";
import { buildInputHistory, moveHistoryCursor } from "./input-history.js";
import { formatModeLabel, getTuiCopy, normalizeStageLabel, type TuiLocale } from "./i18n.js";
import { loadProjectSession, persistProjectSession, resolveSessionActiveBook } from "./session-store.js";
import { classifyLocalTuiCommand, parseDepthCommand } from "./local-commands.js";
import {
  applySlashSuggestion,
  getNextSlashSelection,
  getSlashSuggestions,
  SLASH_COMMANDS,
} from "./slash-autocomplete.js";
import { WARM_ACCENT, WARM_BORDER, WARM_MUTED, WARM_REPLY } from "./theme.js";

export interface InkTuiDashboardProps {
  readonly locale: TuiLocale;
  readonly projectName: string;
  readonly activeBookTitle?: string;
  readonly modelLabel: string;
  readonly depthLabel?: string;
  readonly session: InteractionSession;
  readonly inputValue: string;
  readonly isSubmitting: boolean;
  readonly sinceTimestamp?: number;
  readonly lastError?: string;
  readonly slashSuggestions?: ReadonlyArray<string>;
  readonly selectedSlashIndex?: number;
  readonly showComposerCursor?: boolean;
  readonly onInputChange?: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
}

export interface InkTuiAppProps {
  readonly locale: TuiLocale;
  readonly projectRoot: string;
  readonly projectName: string;
  readonly modelLabel: string;
  readonly initialSession: InteractionSession;
  readonly tools: InteractionRuntimeTools;
  readonly chatStreamBridge?: {
    onTextDelta?: (text: string) => void;
    getChatRequestOptions?: () => {
      readonly temperature?: number;
      readonly maxTokens?: number;
    };
  };
}

export function InkTuiDashboard(props: InkTuiDashboardProps): React.JSX.Element {
  const copy = getTuiCopy(props.locale);
  const model = buildDashboardViewModel({
    copy,
    projectName: props.projectName,
    activeBookTitle: props.activeBookTitle,
    modelLabel: props.modelLabel,
    depthLabel: props.depthLabel,
    session: props.session,
    isSubmitting: props.isSubmitting,
    lastError: props.lastError,
    sinceTimestamp: props.sinceTimestamp,
  });
  const activeAccent = props.isSubmitting ? WARM_ACCENT : statusColor(model.executionStatus);
  const composer = renderComposerDisplay(props.inputValue, model.composerPlaceholder, props.showComposerCursor ?? false);

  return (
    <Box flexDirection="column" width="100%" paddingX={2}>
      <Text color={WARM_MUTED}>{model.headerLine}</Text>

      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        {model.messageRows.length > 0 ? (
          model.messageRows.map((row) => <ConversationRow key={row.key} row={row} />)
        ) : (
          <MutedText>{copy.composer.emptyConversation}</MutedText>
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={activeAccent}>
          <ExecutionBadge status={model.executionStatus} color={activeAccent} />
          {" "}
          {model.statusPrimaryLine}
        </Text>
        <Text color={model.errorText ? "red" : props.isSubmitting ? WARM_ACCENT : WARM_MUTED}>
          {model.statusSecondaryLine}
        </Text>

        <Box
          marginTop={1}
          flexDirection="column"
          width="100%"
          borderStyle="round"
          borderColor={props.isSubmitting ? WARM_ACCENT : WARM_BORDER}
          paddingX={1}
        >
          <Box>
            <Text color={props.isSubmitting ? WARM_ACCENT : WARM_ACCENT} bold>
              ›{" "}
            </Text>
            <Text color={composer.isPlaceholder ? WARM_MUTED : WARM_REPLY}>
              {composer.text}
            </Text>
            {composer.cursor ? (
              <Text color={props.isSubmitting ? WARM_ACCENT : WARM_ACCENT}>
                {composer.cursor}
              </Text>
            ) : null}
          </Box>
          <Text color={props.isSubmitting ? WARM_ACCENT : WARM_MUTED}>
            {model.composerStatus} • {model.composerHelper}
          </Text>
          {props.slashSuggestions && props.slashSuggestions.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {props.slashSuggestions.slice(0, 5).map((suggestion, index) => {
                const isSelected = index === (props.selectedSlashIndex ?? 0);
                return (
                  <Text key={suggestion} color={isSelected ? WARM_ACCENT : WARM_MUTED}>
                    {isSelected ? "› " : "  "}
                    {suggestion}
                  </Text>
                );
              })}
            </Box>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}

export function InkTuiApp(props: InkTuiAppProps): React.JSX.Element {
  const { exit } = useApp();
  const copy = getTuiCopy(props.locale);
  const [session, setSession] = useState(props.initialSession);
  const [inputValue, setInputValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastError, setLastError] = useState<string | undefined>();
  const [sinceTimestamp, setSinceTimestamp] = useState<number | undefined>();
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [historyState, setHistoryState] = useState<{ cursor: number | null; draft: string }>({
    cursor: null,
    draft: "",
  });
  const [activityIntent, setActivityIntent] = useState<InteractionIntentType | "unknown">("unknown");
  const [activityFrameIndex, setActivityFrameIndex] = useState(0);
  const [chatDepth, setChatDepth] = useState<ChatDepth>("normal");
  const [showComposerCursor, setShowComposerCursor] = useState(true);
  const assistantDraftTimestampRef = useRef<number | null>(null);
  const submitLockRef = useRef(false);
  const slashSuggestions = getSlashSuggestions(inputValue, SLASH_COMMANDS);
  const inputHistory = buildInputHistory(session.messages);
  const activity = describeActivityState(activityIntent, copy);
  const chatDepthProfile = resolveChatDepthProfile(chatDepth);

  useEffect(() => {
    if (!isSubmitting) {
      setActivityFrameIndex(0);
      return;
    }

    const timer = setInterval(() => {
      setActivityFrameIndex((current) => (current + 1) % activity.frames.length);
    }, activity.intervalMs);
    return () => clearInterval(timer);
  }, [activity.frames.length, activity.intervalMs, isSubmitting]);

  useEffect(() => {
    if (isSubmitting) {
      setShowComposerCursor(false);
      return;
    }

    setShowComposerCursor(true);
    const timer = setInterval(() => {
      setShowComposerCursor((current) => !current);
    }, 700);
    return () => clearInterval(timer);
  }, [isSubmitting]);

  if (props.chatStreamBridge) {
    props.chatStreamBridge.getChatRequestOptions = () => ({
      temperature: chatDepthProfile.temperature,
      maxTokens: chatDepthProfile.maxTokens,
    });
  }

  props.chatStreamBridge && (props.chatStreamBridge.onTextDelta = (text: string) => {
    const timestamp = assistantDraftTimestampRef.current;
    if (timestamp === null) {
      return;
    }

    setSession((current) => appendStreamingAssistantChunk(current, text, timestamp));
  });

  useInput((_input, key) => {
    if (key.escape) {
      exit();
      return;
    }

    if (slashSuggestions.length > 0 && key.tab) {
      setInputValue(applySlashSuggestion(inputValue, slashSuggestions, selectedSlashIndex));
      setSelectedSlashIndex(0);
      return;
    }

    if (key.backspace || key.delete) {
      setInputValue((current) => current.slice(0, -1));
      setSelectedSlashIndex(0);
      return;
    }

    if (slashSuggestions.length > 0 && key.downArrow) {
      setSelectedSlashIndex((current) => getNextSlashSelection(current, slashSuggestions.length, "down"));
      return;
    }

    if (slashSuggestions.length > 0 && key.upArrow) {
      setSelectedSlashIndex((current) => getNextSlashSelection(current, slashSuggestions.length, "up"));
      return;
    }

    if (key.downArrow) {
      const next = moveHistoryCursor(inputHistory, historyState, inputValue, "down");
      setHistoryState(next.state);
      setInputValue(next.value);
      return;
    }

    if (key.upArrow) {
      const next = moveHistoryCursor(inputHistory, historyState, inputValue, "up");
      setHistoryState(next.state);
      setInputValue(next.value);
      return;
    }

    if (key.return) {
      void handleSubmit(inputValue);
      return;
    }

    if (_input && !_input.includes("\r") && !_input.includes("\n") && !key.ctrl && !key.meta) {
      setInputValue((current) => current + _input);
      setSelectedSlashIndex(0);
    }
  });

  const appendSystemNote = (content: string) => {
    setLastError(undefined);
    setSession((current) => appendInteractionMessage(current, {
      role: "system",
      content,
      timestamp: Date.now(),
    }));
  };

  const handleSubmit = async (rawValue: string) => {
    const input = rawValue.trim();
    if (!input || isSubmitting || submitLockRef.current) {
      return;
    }
    submitLockRef.current = true;

    try {
      const localCommand = classifyLocalTuiCommand(input);
      const depthCommand = parseDepthCommand(input);
      if (localCommand) {
        setInputValue("");

        if (localCommand === "quit") {
          exit();
          return;
        }

        if (localCommand === "help") {
          appendSystemNote(copy.notes.help);
          return;
        }

        if (localCommand === "status") {
          const stage = normalizeStageLabel(
            session.currentExecution?.stageLabel ?? session.currentExecution?.status ?? "idle",
            copy,
          );
          appendSystemNote(copy.notes.status(stage, formatModeLabel(session.automationMode, copy)));
          return;
        }

        if (localCommand === "clear") {
          setLastError(undefined);
          setSinceTimestamp(Date.now());
          return;
        }

        if (localCommand === "config") {
          appendSystemNote(copy.notes.config);
          return;
        }
      }

      if (depthCommand) {
        setInputValue("");
        setChatDepth(depthCommand);
        appendSystemNote(copy.notes.depthSet(copy.depthLabels[depthCommand]));
        return;
      }

      const activeBookId = await resolveSessionActiveBook(props.projectRoot, session);
      const routed = routeNaturalLanguageIntent(input, { activeBookId });
      const userTimestamp = Date.now();
      const assistantDraftTimestamp = routed.intent === "chat" ? userTimestamp + 1 : null;
      assistantDraftTimestampRef.current = assistantDraftTimestamp;
      setActivityIntent(routed.intent);
      setIsSubmitting(true);
      setLastError(undefined);
      setInputValue("");
      setHistoryState({ cursor: null, draft: "" });
      setSession((current) => createOptimisticUserMessageSession(current, input, userTimestamp));

      const result = await processProjectInteractionInput({
        projectRoot: props.projectRoot,
        input,
        tools: props.tools,
        activeBookId,
      });
      const summary = formatTuiResult({
        intent: result.request.intent,
        status: result.session.currentExecution?.status ?? "completed",
        bookId: result.session.activeBookId,
        mode: result.request.mode,
        responseText: result.responseText,
        locale: props.locale,
      });
      const nextSession = appendInteractionMessage(result.session, {
        role: "assistant",
        content: summary,
        timestamp: Date.now(),
      });
      await persistProjectSession(props.projectRoot, nextSession);
      setSession(nextSession);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedSession = await loadProjectSession(props.projectRoot);
      setSession(failedSession);
      setLastError(message);
    } finally {
      assistantDraftTimestampRef.current = null;
      setIsSubmitting(false);
      setActivityIntent("unknown");
      submitLockRef.current = false;
    }
  };

  const activitySession = isSubmitting
    ? {
        ...session,
        currentExecution: {
          status: "planning" as const,
          bookId: session.activeBookId,
          chapterNumber: session.activeChapterNumber,
          stageLabel: `${activity.label} ${activity.frames[activityFrameIndex] ?? ""}`.trim(),
        },
      }
    : session;

  return (
    <InkTuiDashboard
      locale={props.locale}
      projectName={props.projectName}
      activeBookTitle={activitySession.activeBookId}
      modelLabel={props.modelLabel}
      depthLabel={copy.depthLabels[chatDepth]}
      session={activitySession}
      inputValue={inputValue}
      isSubmitting={isSubmitting}
      sinceTimestamp={sinceTimestamp}
      lastError={lastError}
      slashSuggestions={slashSuggestions}
      selectedSlashIndex={selectedSlashIndex}
      showComposerCursor={showComposerCursor}
      onInputChange={(value) => {
        setInputValue(value);
        setSelectedSlashIndex(0);
        setHistoryState((current) => current.cursor === null ? current : { cursor: null, draft: value });
      }}
      onSubmit={(value) => {
        void handleSubmit(value);
      }}
    />
  );
}

function ConversationRow(props: { readonly row: DashboardMessageRow }): React.JSX.Element {
  if (props.row.role === "user") {
    return (
      <Box marginBottom={1}>
        <Text color="gray">│ {props.row.content}</Text>
      </Box>
    );
  }

  return (
    <Box marginBottom={1}>
      <Text color={messageColor(props.row.role)}>
        {props.row.role === "assistant" ? props.row.content : `${props.row.label}  ${props.row.content}`}
      </Text>
    </Box>
  );
}

function ExecutionBadge(props: { readonly status: string; readonly color?: string }): React.JSX.Element {
  return (
    <Text color={props.color ?? statusColor(props.status)} bold>
      ●
    </Text>
  );
}

function MutedText(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return <Text color={WARM_MUTED}>{props.children}</Text>;
}

function messageColor(role: DashboardMessageRow["role"]): string {
  switch (role) {
    case "user":
      return WARM_MUTED;
    case "assistant":
      return WARM_REPLY;
    case "system":
      return WARM_ACCENT;
    default:
      return WARM_REPLY;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return WARM_REPLY;
    case "failed":
      return "red";
    case "blocked":
    case "waiting_human":
      return WARM_ACCENT;
    case "writing":
    case "repairing":
    case "planning":
    case "composing":
    case "persisting":
      return WARM_ACCENT;
    default:
      return WARM_MUTED;
  }
}
