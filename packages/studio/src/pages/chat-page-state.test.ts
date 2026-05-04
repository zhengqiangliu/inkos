import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearBookCreateSessionId,
  filterModelGroups,
  getBookCreateSessionId,
  resolveAssistantPreview,
  resolveModelSelection,
  setBookCreateSessionId,
} from "./chat-page-state";

describe("book-create session localStorage helpers", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    });
  });

  afterEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
  });

  it("getBookCreateSessionId returns null when empty", () => {
    expect(getBookCreateSessionId()).toBeNull();
  });

  it("setBookCreateSessionId + get round-trips", () => {
    setBookCreateSessionId("sess-123");
    expect(getBookCreateSessionId()).toBe("sess-123");
  });

  it("setBookCreateSessionId overwrites previous value", () => {
    setBookCreateSessionId("sess-old");
    setBookCreateSessionId("sess-new");
    expect(getBookCreateSessionId()).toBe("sess-new");
  });

  it("clearBookCreateSessionId removes the key", () => {
    setBookCreateSessionId("sess-123");
    clearBookCreateSessionId();
    expect(getBookCreateSessionId()).toBeNull();
  });

  it("clearBookCreateSessionId is safe when key doesn't exist", () => {
    clearBookCreateSessionId();
    expect(getBookCreateSessionId()).toBeNull();
  });
});

describe("filterModelGroups", () => {
  const grouped = [
    {
      service: "openai",
      label: "OpenAI",
      models: [
        { id: "gpt-5.4", name: "gpt-5.4" },
        { id: "gpt-4o", name: "gpt-4o" },
      ],
    },
    {
      service: "custom:gemma",
      label: "LM Studio",
      models: [
        { id: "google/gemma-4-27b-it", name: "google/gemma-4-27b-it" },
      ],
    },
  ] as const;

  it("returns all groups when search is blank", () => {
    expect(filterModelGroups(grouped, "")).toEqual(grouped);
    expect(filterModelGroups(grouped, "   ")).toEqual(grouped);
  });

  it("filters by model name and preserves only matching groups", () => {
    expect(filterModelGroups(grouped, "gemma")).toEqual([
      {
        service: "custom:gemma",
        label: "LM Studio",
        models: [{ id: "google/gemma-4-27b-it", name: "google/gemma-4-27b-it" }],
      },
    ]);
  });

  it("filters by service label", () => {
    expect(filterModelGroups(grouped, "openai")).toEqual([
      {
        service: "openai",
        label: "OpenAI",
        models: [
          { id: "gpt-5.4", name: "gpt-5.4" },
          { id: "gpt-4o", name: "gpt-4o" },
        ],
      },
    ]);
  });
});

describe("resolveModelSelection", () => {
  const grouped = [
    {
      service: "openai",
      label: "OpenAI",
      models: [
        { id: "gpt-5.4", name: "gpt-5.4" },
        { id: "gpt-4o", name: "gpt-4o" },
      ],
    },
    {
      service: "custom:gemma",
      label: "LM Studio",
      models: [
        { id: "google/gemma-4-27b-it", name: "google/gemma-4-27b-it" },
      ],
    },
  ] as const;

  it("returns selected model when still valid", () => {
    expect(resolveModelSelection(grouped, "gpt-4o", "openai")).toEqual({
      model: "gpt-4o",
      service: "openai",
    });
  });

  it("falls back to first model when selection becomes invalid", () => {
    expect(resolveModelSelection(grouped, "removed-model", "openai")).toEqual({
      model: "gpt-5.4",
      service: "openai",
    });
  });

  it("falls back to first model when service mismatches", () => {
    expect(resolveModelSelection(grouped, "gpt-5.4", "missing-service")).toEqual({
      model: "gpt-5.4",
      service: "openai",
    });
  });

  it("returns null for empty groups", () => {
    expect(resolveModelSelection([], "gpt-5.4", "openai")).toBeNull();
  });
});

describe("resolveAssistantPreview", () => {
  it("shows audit-only preview without fake chapter text", () => {
    expect(resolveAssistantPreview({
      content: "",
      hasAudit: true,
    })).toEqual({
      shouldShowPreview: true,
      previewLabel: "审计结果",
      previewContent: "",
    });
  });

  it("hides preview when there is neither content nor audit", () => {
    expect(resolveAssistantPreview({
      content: "",
      hasAudit: false,
    })).toEqual({
      shouldShowPreview: false,
      previewLabel: "正文流预览",
      previewContent: "",
    });
  });

  it("shows combined label when both content and audit are present", () => {
    expect(resolveAssistantPreview({
      content: "正文片段",
      hasAudit: true,
    })).toEqual({
      shouldShowPreview: true,
      previewLabel: "正文流预览 / 审计结果",
      previewContent: "正文片段",
    });
  });
});
