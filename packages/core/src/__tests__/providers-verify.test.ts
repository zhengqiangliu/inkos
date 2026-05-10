import { beforeEach, describe, expect, it, vi } from "vitest";

const { createLLMClientMock, chatCompletionMock } = vi.hoisted(() => ({
  createLLMClientMock: vi.fn(),
  chatCompletionMock: vi.fn(),
}));

vi.mock("../llm/provider.js", () => ({
  createLLMClient: createLLMClientMock,
  chatCompletion: chatCompletionMock,
}));

import { verifyModelConnectivity } from "../llm/providers/verify.js";

describe("providers verify", () => {
  beforeEach(() => {
    createLLMClientMock.mockReset();
    chatCompletionMock.mockReset();
    createLLMClientMock.mockReturnValue({});
  });

  it("returns ok=true when ping succeeds", async () => {
    chatCompletionMock.mockResolvedValue({
      content: "pong",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const result = await verifyModelConnectivity({
      service: "openai",
      model: "gpt-5.4",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      apiFormat: "chat",
      stream: false,
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.apiFormat).toBe("chat");
    expect(result.stream).toBe(false);
  });

  it("classifies unauthorized errors as auth_failed", async () => {
    chatCompletionMock.mockRejectedValue(new Error("401 unauthorized"));

    const result = await verifyModelConnectivity({
      service: "openai",
      model: "gpt-5.4",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      apiFormat: "chat",
      stream: false,
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("auth_failed");
  });
});