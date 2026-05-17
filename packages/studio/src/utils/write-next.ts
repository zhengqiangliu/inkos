import { useChatStore } from "../store/chat";

const BOOK_DETAIL_SESSION_KEY_PREFIX = "inkos.book-detail.session-id.";

export function readBookDetailSessionId(bookId: string): string | null {
  return globalThis.localStorage?.getItem(`${BOOK_DETAIL_SESSION_KEY_PREFIX}${bookId}`) ?? null;
}

export function writeBookDetailSessionId(bookId: string, sessionId: string): void {
  globalThis.localStorage?.setItem(`${BOOK_DETAIL_SESSION_KEY_PREFIX}${bookId}`, sessionId);
}

export function clearBookDetailSessionId(bookId: string): void {
  globalThis.localStorage?.removeItem(`${BOOK_DETAIL_SESSION_KEY_PREFIX}${bookId}`);
}

async function ensureBookSessionId(bookId: string): Promise<string> {
  const existing = readBookDetailSessionId(bookId);
  if (existing) return existing;

  const state = useChatStore.getState();
  const activeSessionId = state.activeSessionId;
  if (activeSessionId) {
    const activeSession = state.sessions[activeSessionId];
    if (activeSession?.bookId === bookId) {
      writeBookDetailSessionId(bookId, activeSessionId);
      return activeSessionId;
    }
  }

  const sessionIds = state.sessionIdsByBook[bookId] ?? [];
  if (sessionIds.length > 0) {
    const sessionId = sessionIds[0]!;
    writeBookDetailSessionId(bookId, sessionId);
    return sessionId;
  }

  const createdSessionId = await state.createSession(bookId);
  writeBookDetailSessionId(bookId, createdSessionId);
  return createdSessionId;
}

export async function resolveBookDetailSessionId(
  bookId: string,
  preferredSessionId?: string | null,
): Promise<string> {
  const store = useChatStore.getState();
  const preferred = preferredSessionId?.trim() || "";
  if (preferred) {
    const preferredSession = store.sessions[preferred];
    if (preferredSession?.bookId === bookId) {
      writeBookDetailSessionId(bookId, preferred);
      return preferred;
    }
  }

  const activeSessionId = store.activeSessionId;
  if (activeSessionId) {
    const activeSession = store.sessions[activeSessionId];
    if (activeSession?.bookId === bookId) {
      writeBookDetailSessionId(bookId, activeSessionId);
      return activeSessionId;
    }
  }

  const cached = readBookDetailSessionId(bookId);
  if (cached) {
    const cachedSession = store.sessions[cached];
    if (cachedSession?.bookId === bookId) {
      return cached;
    }
  }

  const sessionIds = store.sessionIdsByBook[bookId] ?? [];
  if (sessionIds.length > 0) {
    const sessionId = sessionIds[0]!;
    writeBookDetailSessionId(bookId, sessionId);
    return sessionId;
  }

  return await ensureBookSessionId(bookId);
}

export async function dispatchWriteNextInstruction(
  bookId: string,
  language?: string,
  sessionId?: string | null,
): Promise<void> {
  const instruction = language === "en" ? "write next chapter" : "写下一章";
  const store = useChatStore.getState();
  let effectiveSessionId = sessionId?.trim() || "";
  if (effectiveSessionId) {
    const explicitSession = store.sessions[effectiveSessionId];
    if (explicitSession?.bookId !== bookId) {
      effectiveSessionId = "";
    }
  }
  if (!effectiveSessionId) {
    effectiveSessionId = await resolveBookDetailSessionId(bookId);
  }
  const resolvedSession = store.sessions[effectiveSessionId];
  if (!resolvedSession) throw new Error("无法找到会话");
  if (resolvedSession.isStreaming) {
    throw new Error("当前会话正在执行中，请先等待或停止当前任务。");
  }

  writeBookDetailSessionId(bookId, effectiveSessionId);
  useChatStore.getState().activateSession(effectiveSessionId);
  await useChatStore.getState().sendMessage(effectiveSessionId, instruction, bookId, {
    skipAutoNewPrefix: true,
  });
}
