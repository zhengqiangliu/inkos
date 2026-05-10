import { fetchWithProxy } from "../../utils/proxy-fetch.js";

export interface ProbedModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
}

export interface ProbedModelsResult {
  readonly models: ReadonlyArray<ProbedModel>;
  readonly error?: string;
  readonly authFailed?: boolean;
}

export async function probeModelsFromUpstream(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<ReadonlyArray<ProbedModel>> {
  return (await probeModelsFromUpstreamDetailed(baseUrl, apiKey, timeoutMs)).models;
}

export async function probeModelsFromUpstreamDetailed(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<ProbedModelsResult> {
  if (!baseUrl) return { models: [] };

  try {
    const modelsUrl = baseUrl.replace(/\/$/, "") + "/models";
    const response = await fetchWithProxy(modelsUrl, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        models: [],
        error: `服务商返回 ${response.status}: ${body.slice(0, 200)}`,
        authFailed: response.status === 401 || response.status === 403,
      };
    }

    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(payload.data)) {
      return { models: [] };
    }

    const models = payload.data
      .filter((item): item is { id: string } => typeof item.id === "string" && item.id.trim().length > 0)
      .map((item) => ({ id: item.id, name: item.id, contextWindow: 0 }));
    return { models };
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
