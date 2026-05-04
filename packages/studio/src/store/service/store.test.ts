import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchJsonMock = vi.fn();

vi.mock("../../hooks/use-api", () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}));

import { useServiceStore } from "./store";

describe("useServiceStore", () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    useServiceStore.setState({
      services: [],
      servicesLoading: false,
      modelsByService: {},
    });
  });

  it("refreshServices clears cached models and refetches service list", async () => {
    useServiceStore.setState({
      services: [{ service: "openai", label: "OpenAI", connected: true }],
      servicesLoading: false,
      modelsByService: {
        openai: {
          models: [{ id: "gpt-5.4", name: "gpt-5.4" }],
          loading: false,
          error: null,
        },
      },
    });
    fetchJsonMock.mockResolvedValueOnce({
      services: [{ service: "openai", label: "OpenAI", connected: true }],
    });

    await useServiceStore.getState().refreshServices();

    expect(fetchJsonMock).toHaveBeenCalledWith("/services");
    expect(useServiceStore.getState().modelsByService).toEqual({});
    expect(useServiceStore.getState().services).toEqual([
      { service: "openai", label: "OpenAI", connected: true },
    ]);
  });
});
