import type { InkosEndpoint } from "../types.js";

export const KIMI_CODE: InkosEndpoint = {
  id: "kimicode",
  label: "Kimi Code",
  providerFamily: "anthropic",
  baseUrl: "https://api.kimi.com/coding",
  modelsBaseUrl: "https://api.kimi.com/coding/v1",
  transportDefaults: { apiFormat: "chat", stream: true },
  models: [{ id: "kimi-for-coding", name: "kimi-for-coding" }],
};
