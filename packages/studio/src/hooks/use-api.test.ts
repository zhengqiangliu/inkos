import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildApiUrl,
  clearApiCache,
  createApiRequestTracker,
  deriveInvalidationPaths,
  fetchCachedJson,
  fetchJson,
  primeApiCache,
} from "./use-api";

beforeEach(() => {
  clearApiCache();
  vi.unstubAllGlobals();
});

describe("buildApiUrl", () => {
  it("returns null for blank paths so callers can skip requests", () => {
    expect(buildApiUrl("")).toBeNull();
    expect(buildApiUrl("   ")).toBeNull();
  });

  it("prefixes api paths once", () => {
    expect(buildApiUrl("/books")).toBe("/api/v1/books");
    expect(buildApiUrl("books")).toBe("/api/v1/books");
    expect(buildApiUrl("/api/v1/books")).toBe("/api/v1/books");
  });
});

describe("fetchJson", () => {
  it("surfaces API error payloads on non-ok responses", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Bad request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchJson("/books", {}, { fetchImpl })).rejects.toThrow("Bad request");
  });

  it("falls back to status text when the body is not JSON", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("boom", {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await expect(fetchJson("/books", {}, { fetchImpl })).rejects.toThrow("500 Internal Server Error");
  });

  it("surfaces nested api error messages from structured error payloads", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "INVALID_BOOK_ID", message: "Invalid book ID: ../bad" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchJson("/books/../bad", {}, { fetchImpl })).rejects.toThrow("Invalid book ID: ../bad");
  });
});

describe("fetchCachedJson", () => {
  it("reuses the same in-flight GET request for identical paths", async () => {
    const controller: { resolve: ((value: Response) => void) | null } = { resolve: null };
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      controller.resolve = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);

    const first = fetchCachedJson<{ ok: boolean }>("/books");
    const second = fetchCachedJson<{ ok: boolean }>("/books");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (!controller.resolve) {
      throw new Error("fetch resolver was not captured");
    }
    controller.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
  });

  it("returns cached data without calling fetch again", async () => {
    primeApiCache("/books/demo", { id: "demo" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCachedJson<{ id: string }>("/books/demo")).resolves.toEqual({ id: "demo" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createApiRequestTracker", () => {
  it("treats only the latest request as current", () => {
    const tracker = createApiRequestTracker();

    const first = tracker.beginRequest();
    const second = tracker.beginRequest();

    expect(tracker.isCurrent(first)).toBe(false);
    expect(tracker.isCurrent(second)).toBe(true);
  });

  it("invalidates outstanding requests after dispose", () => {
    const tracker = createApiRequestTracker();

    const requestId = tracker.beginRequest();
    tracker.dispose();

    expect(tracker.isCurrent(requestId)).toBe(false);
  });
});

describe("deriveInvalidationPaths", () => {
  it("refreshes book collections after creating a book", () => {
    expect(deriveInvalidationPaths("/books/create")).toEqual(["/api/v1/books"]);
  });

  it("refreshes both collections and the current book after book mutations", () => {
    expect(deriveInvalidationPaths("/books/demo/write-next")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
    ]);
    expect(deriveInvalidationPaths("/books/demo/chapters/3/approve")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
    ]);
    expect(deriveInvalidationPaths("/books/demo/wizard/complete")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
    ]);
    expect(deriveInvalidationPaths("/books/demo/chapters/3/meta")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
    ]);
  });

  it("refreshes global tasks after book task mutations", () => {
    expect(deriveInvalidationPaths("/books/demo/tasks")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
      "/api/v1/books/demo/tasks",
      "/api/v1/tasks",
    ]);
  });

  it("refreshes truth file views after truth file mutations", () => {
    expect(deriveInvalidationPaths("/books/demo/truth/story_bible.md")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
      "/api/v1/books/demo/truth",
      "/api/v1/books/demo/truth/story_bible.md",
    ]);
  });

  it("refreshes daemon state after daemon mutations", () => {
    expect(deriveInvalidationPaths("/daemon/start")).toEqual(["/api/v1/daemon"]);
    expect(deriveInvalidationPaths("/daemon/stop")).toEqual(["/api/v1/daemon"]);
  });

  it("refreshes project data after project mutations", () => {
    expect(deriveInvalidationPaths("/project")).toEqual(["/api/v1/project"]);
    expect(deriveInvalidationPaths("/project/language")).toEqual(["/api/v1/project", "/api/v1/project/language"]);
  });
});
