import { describe, expect, it, vi } from "vitest";
import { probeModelsFromUpstream, probeModelsFromUpstreamDetailed } from "../llm/providers/probe.js";

describe("providers probe", () => {
  it("returns parsed model list on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-5.4" }, { id: "gpt-4o" }] }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await probeModelsFromUpstream("https://api.openai.com/v1", "sk-test", 1000);
    expect(models).toEqual([
      { id: "gpt-5.4", name: "gpt-5.4", contextWindow: 0 },
      { id: "gpt-4o", name: "gpt-4o", contextWindow: 0 },
    ]);
  });

  it("returns empty array on non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await probeModelsFromUpstream("https://api.openai.com/v1", "sk-test", 1000);
    expect(models).toEqual([]);
  });

  it("returns empty array on invalid payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ notData: [] }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const models = await probeModelsFromUpstream("https://api.openai.com/v1", "sk-test", 1000);
    expect(models).toEqual([]);
  });

  it("marks 401/403 as authFailed in detailed mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await probeModelsFromUpstreamDetailed("https://api.openai.com/v1", "sk-test", 1000);
    expect(result.models).toEqual([]);
    expect(result.authFailed).toBe(true);
    expect(result.error).toContain("401");
  });
});
