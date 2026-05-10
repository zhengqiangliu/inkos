import { describe, expect, it } from "vitest";
import { getAllEndpoints, getEndpoint } from "../llm/providers/index.js";
import { listEnabledModels, lookupModel } from "../llm/providers/lookup.js";

describe("providers registry", () => {
  it("registers core endpoints used by studio", () => {
    const ids = new Set(getAllEndpoints().map((endpoint) => endpoint.id));
    expect(ids.has("openai")).toBe(true);
    expect(ids.has("moonshot")).toBe(true);
    expect(ids.has("bailian")).toBe(true);
    expect(ids.has("kimicode")).toBe(true);
    expect(ids.has("custom")).toBe(true);
  });

  it("resolves endpoint defaults", () => {
    const endpoint = getEndpoint("kimicode");
    expect(endpoint).toBeDefined();
    expect(endpoint?.providerFamily).toBe("anthropic");
    expect(endpoint?.baseUrl).toBe("https://api.kimi.com/coding");
  });

  it("lookupModel finds known model by priority scan", () => {
    const model = lookupModel("openai", "MiniMax-M2.7");
    expect(model).toBeDefined();
    expect(model?.id).toBe("MiniMax-M2.7");
  });

  it("listEnabledModels returns static models for minimax", () => {
    const models = listEnabledModels("minimax");
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((model) => model.id === "MiniMax-M2.7")).toBe(true);
  });
});
