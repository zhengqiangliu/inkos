import type { SSEMessage } from "./use-sse";

const START_EVENTS = new Set(["write:start", "draft:start", "agent:start"]);
const TERMINAL_EVENTS = new Set([
  "write:complete",
  "write:error",
  "draft:complete",
  "draft:error",
  "agent:complete",
  "agent:error",
  "agent:stopped",
]);
const BOOK_REFRESH_EVENTS = new Set([
  "write:complete",
  "write:error",
  "draft:complete",
  "draft:error",
  "rewrite:complete",
  "rewrite:error",
  "revise:complete",
  "revise:error",
  "audit:complete",
  "audit:error",
  "approve:complete",
  "approve:error",
  "delete:complete",
  "delete:error",
  "agent:complete",
  "agent:error",
]);

const BOOK_COLLECTION_REFRESH_EVENTS = new Set([
  "book:created",
  "book:updated",
  "book:deleted",
  "book:error",
  "write:complete",
  "write:error",
  "draft:complete",
  "draft:error",
  "rewrite:complete",
  "rewrite:error",
  "revise:complete",
  "revise:error",
  "audit:complete",
  "audit:error",
  "approve:complete",
  "approve:error",
  "delete:complete",
  "delete:error",
  "agent:complete",
  "agent:error",
]);

const DAEMON_STATUS_REFRESH_EVENTS = new Set([
  "daemon:started",
  "daemon:stopped",
  "daemon:error",
]);

export interface BookActivity {
  readonly writing: boolean;
  readonly drafting: boolean;
  readonly lastError: string | null;
}

function getBookId(message: SSEMessage): string | null {
  const data = message.data as { bookId?: unknown; activeBookId?: unknown } | null;
  if (typeof data?.bookId === "string") return data.bookId;
  return typeof data?.activeBookId === "string" ? data.activeBookId : null;
}

export function deriveActiveBookIds(messages: ReadonlyArray<SSEMessage>): ReadonlySet<string> {
  const active = new Set<string>();

  for (const message of messages) {
    const bookId = getBookId(message);
    if (!bookId) continue;

    if (START_EVENTS.has(message.event)) {
      active.add(bookId);
      continue;
    }

    if (TERMINAL_EVENTS.has(message.event)) {
      active.delete(bookId);
    }
  }

  return active;
}

export function deriveBookActivity(messages: ReadonlyArray<SSEMessage>, bookId: string): BookActivity {
  let writing = false;
  let drafting = false;
  let lastError: string | null = null;

  for (const message of messages) {
    if (getBookId(message) !== bookId) continue;

    const data = message.data as { error?: unknown } | null;

    switch (message.event) {
      case "write:start":
        writing = true;
        lastError = null;
        break;
      case "write:complete":
        writing = false;
        lastError = null;
        break;
      case "write:error":
        writing = false;
        lastError = typeof data?.error === "string" ? data.error : "Unknown error";
        break;
      case "draft:start":
        drafting = true;
        lastError = null;
        break;
      case "draft:complete":
        drafting = false;
        lastError = null;
        break;
      case "draft:error":
        drafting = false;
        lastError = typeof data?.error === "string" ? data.error : "Unknown error";
        break;
      case "agent:start":
        writing = true;
        drafting = false;
        lastError = null;
        break;
      case "agent:complete":
      case "agent:stopped":
        writing = false;
        drafting = false;
        lastError = null;
        break;
      case "agent:error":
        writing = false;
        drafting = false;
        lastError = typeof data?.error === "string" ? data.error : "Unknown error";
        break;
      default:
        break;
    }
  }

  return { writing, drafting, lastError };
}

export function shouldRefetchBookView(message: SSEMessage, bookId: string): boolean {
  return getBookId(message) === bookId && BOOK_REFRESH_EVENTS.has(message.event);
}

export function shouldRefetchBookCollections(message: SSEMessage | undefined): boolean {
  return Boolean(message && BOOK_COLLECTION_REFRESH_EVENTS.has(message.event));
}

export function shouldRefetchDaemonStatus(message: SSEMessage | undefined): boolean {
  return Boolean(message && DAEMON_STATUS_REFRESH_EVENTS.has(message.event));
}
