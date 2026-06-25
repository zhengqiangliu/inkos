import { useState, useEffect, useCallback, useRef } from "react";

const BASE = "/api/v1";
const API_INVALIDATE_EVENT = "inkos:api-invalidate";

interface ApiInvalidateDetail {
  readonly paths: ReadonlyArray<string>;
}

interface ApiRequestTracker {
  beginRequest: () => number;
  isCurrent: (requestId: number) => boolean;
  dispose: () => void;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly payload?: unknown;

  constructor(args: {
    readonly message: string;
    readonly status: number;
    readonly code?: string;
    readonly details?: unknown;
    readonly payload?: unknown;
  }) {
    super(args.message);
    this.name = "ApiRequestError";
    this.status = args.status;
    this.code = args.code;
    this.details = args.details;
    this.payload = args.payload;
  }
}

export function buildApiUrl(path: string): string | null {
  const normalized = String(path ?? "").trim();
  if (!normalized) return null;
  if (normalized.startsWith(`${BASE}/`) || normalized === BASE) {
    return normalized;
  }
  return normalized.startsWith("/") ? `${BASE}${normalized}` : `${BASE}/${normalized}`;
}

export function deriveInvalidationPaths(path: string): ReadonlyArray<string> {
  const normalized = buildApiUrl(path);
  if (!normalized) return [];

  if (normalized === "/api/v1/books/create") {
    return ["/api/v1/books"];
  }

  if (normalized === "/api/v1/project") {
    return ["/api/v1/project"];
  }

  if (normalized.startsWith("/api/v1/project/")) {
    return ["/api/v1/project", normalized];
  }

  const bookAction = normalized.match(/^\/api\/v1\/books\/([^/]+)\/(write-next|draft)$/);
  if (bookAction) {
    return ["/api/v1/books", `/api/v1/books/${bookAction[1]}`];
  }

  const chapterAction = normalized.match(/^\/api\/v1\/books\/([^/]+)\/chapters\/\d+\/(approve|reject)$/);
  if (chapterAction) {
    return ["/api/v1/books", `/api/v1/books/${chapterAction[1]}`];
  }

  const chapterMetaAction = normalized.match(/^\/api\/v1\/books\/([^/]+)\/chapters\/\d+\/meta$/);
  if (chapterMetaAction) {
    return ["/api/v1/books", `/api/v1/books/${chapterMetaAction[1]}`];
  }

  const wizardCompleteAction = normalized.match(/^\/api\/v1\/books\/([^/]+)\/wizard\/complete$/);
  if (wizardCompleteAction) {
    return ["/api/v1/books", `/api/v1/books/${wizardCompleteAction[1]}`];
  }

  const taskAction = normalized.match(/^\/api\/v1\/books\/([^/]+)\/tasks(?:\/[^/]+(?:\/stop)?)?$/);
  if (taskAction) {
    return ["/api/v1/books", `/api/v1/books/${taskAction[1]}`, `/api/v1/books/${taskAction[1]}/tasks`, "/api/v1/tasks"];
  }

  const checklistAction = normalized.match(/^\/api\/v1\/books\/([^/]+)\/task-checklist$/);
  if (checklistAction) {
    return ["/api/v1/books", `/api/v1/books/${checklistAction[1]}`, `/api/v1/books/${checklistAction[1]}/task-checklist`];
  }

  const scriptWorkspaceAction = normalized.match(/^\/api\/v1\/books\/([^/]+)\/script-workspace(?:\/generate)?$/);
  if (scriptWorkspaceAction) {
    return ["/api/v1/books", `/api/v1/books/${scriptWorkspaceAction[1]}`, `/api/v1/books/${scriptWorkspaceAction[1]}/script-workspace`];
  }

  const globalTaskAction = normalized.match(/^\/api\/v1\/tasks(?:\/[^/]+\/[^/]+(?:\/(stop|resume|retry))?)?$/);
  if (globalTaskAction) {
    return ["/api/v1/tasks"];
  }

  if (/^\/api\/v1\/daemon\/(start|stop)$/.test(normalized)) {
    return ["/api/v1/daemon"];
  }

  return [];
}

export function createApiRequestTracker(): ApiRequestTracker {
  let currentRequestId = 0;
  let active = true;

  return {
    beginRequest: () => {
      currentRequestId += 1;
      return currentRequestId;
    },
    isCurrent: (requestId) => active && requestId === currentRequestId,
    dispose: () => {
      active = false;
      currentRequestId += 1;
    },
  };
}

export function invalidateApiPaths(paths: ReadonlyArray<string>): void {
  if (!paths.length || typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent<ApiInvalidateDetail>(API_INVALIDATE_EVENT, {
    detail: { paths: [...new Set(paths)] },
  }));
}

async function readErrorPayload(res: Response): Promise<{
  readonly message: string;
  readonly code?: string;
  readonly details?: unknown;
  readonly payload?: unknown;
}> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const json = await res.json() as {
        error?: unknown;
        details?: unknown;
      };
      const payload = json as unknown;
      if (typeof json.error === "string" && json.error.trim()) {
        return {
          message: json.error,
          ...(json.details !== undefined ? { details: json.details } : {}),
          payload,
        };
      }
      if (json.error && typeof json.error === "object") {
        const err = json.error as { code?: unknown; message?: unknown };
        const message = typeof err.message === "string" && err.message.trim()
          ? err.message
          : `${res.status} ${res.statusText}`.trim();
        return {
          message,
          ...(typeof err.code === "string" && err.code.trim() ? { code: err.code } : {}),
          ...(json.details !== undefined ? { details: json.details } : {}),
          payload,
        };
      }
    } catch {
      // fall through
    }
  }
  return { message: `${res.status} ${res.statusText}`.trim() };
}

export async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
  deps?: { readonly fetchImpl?: typeof fetch },
): Promise<T> {
  const url = buildApiUrl(path);
  if (!url) {
    throw new Error("API path is required");
  }

  const fetchImpl = deps?.fetchImpl ?? fetch;
  const res = await fetchImpl(url, init);

  if (!res.ok) {
    const error = await readErrorPayload(res);
    throw new ApiRequestError({
      message: error.message,
      status: res.status,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
      ...(error.payload !== undefined ? { payload: error.payload } : {}),
    });
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    if (!text.trim()) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  return await res.json() as T;
}

export function useApi<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const trackerRef = useRef<ApiRequestTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = createApiRequestTracker();
  }

  useEffect(() => () => {
    trackerRef.current?.dispose();
  }, []);

  const refetch = useCallback(async () => {
    const url = buildApiUrl(path);
    if (!url) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    const requestId = trackerRef.current?.beginRequest() ?? 0;
    setLoading(true);
    setError(null);
    try {
      const json = await fetchJson<T>(url);
      if (!trackerRef.current?.isCurrent(requestId)) return;
      setData(json);
    } catch (e) {
      if (!trackerRef.current?.isCurrent(requestId)) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!trackerRef.current?.isCurrent(requestId)) return;
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const url = buildApiUrl(path);
    if (!url || typeof window === "undefined") {
      return;
    }

    const handleInvalidate = (event: Event) => {
      const detail = (event as CustomEvent<ApiInvalidateDetail>).detail;
      if (!detail?.paths.includes(url)) return;
      void refetch();
    };

    window.addEventListener(API_INVALIDATE_EVENT, handleInvalidate);
    return () => {
      window.removeEventListener(API_INVALIDATE_EVENT, handleInvalidate);
    };
  }, [path, refetch]);

  return { data, loading, error, refetch };
}

export async function postApi<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetchJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  invalidateApiPaths(deriveInvalidationPaths(path));
  return result;
}

export async function putApi<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetchJson<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  invalidateApiPaths(deriveInvalidationPaths(path));
  return result;
}

export async function patchApi<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetchJson<T>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  invalidateApiPaths(deriveInvalidationPaths(path));
  return result;
}

export async function deleteApi<T>(path: string): Promise<T> {
  const result = await fetchJson<T>(path, {
    method: "DELETE",
  });
  invalidateApiPaths(deriveInvalidationPaths(path));
  return result;
}
