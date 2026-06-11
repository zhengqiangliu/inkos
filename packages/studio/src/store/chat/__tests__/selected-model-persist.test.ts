import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { initialChatState } from "../initialState";
import type { ChatStore } from "../types";
import { createCreateSlice } from "../slices/create/action";
import { createMessageSlice } from "../slices/message/action";
import { fetchJson } from "../../../hooks/use-api";

vi.mock("../../../hooks/use-api", () => ({
  fetchJson: vi.fn(),
}));

function createTestStore() {
  return createStore<ChatStore>()((...a) => ({
    ...initialChatState,
    ...createMessageSlice(...a),
    ...createCreateSlice(...a),
  }));
}

describe("selected model persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists selected service and defaultModel to services config", async () => {
    const store = createTestStore();
    const fetchJsonMock = vi.mocked(fetchJson);
    fetchJsonMock.mockResolvedValue({ ok: true } as never);

    store.getState().setSelectedModel("gpt-4o", "openai");

    await vi.waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith("/services/config", expect.objectContaining({
      method: "PUT",
    })));

    const call = fetchJsonMock.mock.calls.find((args) => args[0] === "/services/config");
    expect(call?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({
        service: "openai",
        defaultModel: "gpt-4o",
        services: [{ service: "openai", preferredModel: "gpt-4o" }],
      }),
    });
  });
});
