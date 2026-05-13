import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendInteractionEvent, appendInteractionMessage } from "./session.js";
import { routeNaturalLanguageIntent } from "./nl-router.js";
import type { InteractionRequest } from "./intents.js";
import type { InteractionRuntimeTools } from "./runtime.js";
import { runInteractionRequest } from "./runtime.js";
import {
  loadProjectSession,
  persistProjectSession,
  resolveSessionActiveBook,
} from "./project-session-store.js";

function summarizeStructuredRequest(request: InteractionRequest): string {
  const parts: string[] = [request.intent];
  if ("instruction" in request && typeof request.instruction === "string" && request.instruction.trim()) {
    parts.push(request.instruction.trim());
  } else if ("title" in request && typeof request.title === "string" && request.title.trim()) {
    parts.push(`title=${request.title.trim()}`);
  }
  if ("genre" in request && typeof request.genre === "string" && request.genre.trim()) {
    parts.push(`genre=${request.genre.trim()}`);
  }
  if ("platform" in request && typeof request.platform === "string" && request.platform.trim()) {
    parts.push(`platform=${request.platform.trim()}`);
  }
  if ("targetChapters" in request && typeof request.targetChapters === "number") {
    parts.push(`targetChapters=${request.targetChapters}`);
  }
  if ("chapterWordCount" in request && typeof request.chapterWordCount === "number") {
    parts.push(`chapterWordCount=${request.chapterWordCount}`);
  }
  if ("language" in request && typeof request.language === "string" && request.language.trim()) {
    parts.push(`language=${request.language.trim()}`);
  }
  if ("wizardStep" in request && typeof request.wizardStep === "string" && request.wizardStep.trim()) {
    parts.push(`step=${request.wizardStep}`);
  }
  return parts.join(" | ");
}

async function processProjectInteractionRequestInternal(params: {
  readonly projectRoot: string;
  readonly request: InteractionRequest;
  readonly tools: InteractionRuntimeTools;
  readonly activeBookId?: string;
}) {
  const requestLanguage = await detectProjectInteractionLanguage(params.projectRoot);
  const localizedRequest = attachRequestLanguage(params.request, requestLanguage);
  const session = await loadProjectSession(params.projectRoot);
  const restoredBookId = await resolveSessionActiveBook(params.projectRoot, session);
  const resolvedBookId = params.activeBookId ?? localizedRequest.bookId ?? restoredBookId;
  const sessionWithBook = resolvedBookId && session.activeBookId !== resolvedBookId
    ? { ...session, activeBookId: resolvedBookId }
    : session;
  const userSession = appendInteractionMessage(sessionWithBook, {
    role: "user",
    content: summarizeStructuredRequest(localizedRequest),
    timestamp: Date.now(),
  });

  try {
    const result = await runInteractionRequest({
      session: userSession,
      request: localizedRequest,
      tools: params.tools,
    });
    const responseText = result.responseText?.trim();
    const assistantSession = responseText
      ? appendInteractionMessage(result.session, {
          role: "assistant",
          content: responseText,
          timestamp: Date.now(),
        })
      : result.session;
    await persistProjectSession(params.projectRoot, assistantSession);
    return {
      ...result,
      session: assistantSession,
      request: localizedRequest,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failedSession = appendInteractionEvent({
      ...sessionWithBook,
      currentExecution: {
        status: "failed",
        bookId: sessionWithBook.activeBookId,
        chapterNumber: sessionWithBook.activeChapterNumber,
        stageLabel: localizedRequest.language === "en" ? `failed ${localizedRequest.intent}` : `执行失败：${localizedRequest.intent}`,
      },
    }, {
      kind: "task.failed",
      timestamp: Date.now(),
      status: "failed",
      bookId: sessionWithBook.activeBookId,
      chapterNumber: sessionWithBook.activeChapterNumber,
      detail,
    });
    await persistProjectSession(params.projectRoot, failedSession);
    throw error;
  }
}

export async function processProjectInteractionInput(params: {
  readonly projectRoot: string;
  readonly input: string;
  readonly tools: InteractionRuntimeTools;
  readonly activeBookId?: string;
}) {
  const requestLanguage = await detectProjectInteractionLanguage(params.projectRoot);
  const session = await loadProjectSession(params.projectRoot);
  const restoredBookId = await resolveSessionActiveBook(params.projectRoot, session);
  const resolvedBookId = params.activeBookId ?? restoredBookId;
  const sessionWithBook = resolvedBookId && session.activeBookId !== resolvedBookId
    ? { ...session, activeBookId: resolvedBookId }
    : session;
  const userSession = appendInteractionMessage(sessionWithBook, {
    role: "user",
    content: params.input,
    timestamp: Date.now(),
  });
  const request = attachRequestLanguage(routeNaturalLanguageIntent(params.input, {
    activeBookId: userSession.activeBookId,
    hasCreationDraft: Boolean(userSession.creationDraft),
  }), requestLanguage);
  try {
    const result = await runInteractionRequest({
      session: userSession,
      request,
      tools: params.tools,
    });
    const responseText = result.responseText?.trim();
    const assistantSession = responseText
      ? appendInteractionMessage(result.session, {
          role: "assistant",
          content: responseText,
          timestamp: Date.now(),
        })
      : result.session;
    await persistProjectSession(params.projectRoot, assistantSession);
    return {
      ...result,
      session: assistantSession,
      request,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failedSession = appendInteractionEvent({
      ...userSession,
      currentExecution: {
        status: "failed",
        bookId: userSession.activeBookId,
        chapterNumber: userSession.activeChapterNumber,
        stageLabel: request.language === "en" ? `failed ${request.intent}` : `执行失败：${request.intent}`,
      },
    }, {
      kind: "task.failed",
      timestamp: Date.now(),
      status: "failed",
      bookId: userSession.activeBookId,
      chapterNumber: userSession.activeChapterNumber,
      detail,
    });
    await persistProjectSession(params.projectRoot, failedSession);
    throw error;
  }
}

export async function processProjectInteractionRequest(params: {
  readonly projectRoot: string;
  readonly request: InteractionRequest;
  readonly tools: InteractionRuntimeTools;
  readonly activeBookId?: string;
}) {
  return processProjectInteractionRequestInternal(params);
}

function attachRequestLanguage(
  request: InteractionRequest,
  language: "zh" | "en" | undefined,
): InteractionRequest {
  if (request.language || !language) {
    return request;
  }

  return {
    ...request,
    language,
  };
}

async function detectProjectInteractionLanguage(projectRoot: string): Promise<"zh" | "en" | undefined> {
  try {
    const raw = await readFile(join(projectRoot, "inkos.json"), "utf-8");
    const parsed = JSON.parse(raw) as { language?: string };
    return parsed.language === "en" ? "en" : parsed.language === "zh" ? "zh" : undefined;
  } catch {
    return undefined;
  }
}
