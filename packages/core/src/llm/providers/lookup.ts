import { getAllEndpoints, getEndpoint, type InkosModel } from "./index.js";

const PROVIDER_PRIORITY: readonly string[] = [
  "anthropic", "openai", "deepseek", "moonshot", "kimicode",
  "minimax", "bailian", "zhipu", "siliconflow", "ppio", "openrouter", "ollama", "custom",
];

export function lookupModel(serviceId: string, modelId: string): InkosModel | undefined {
  const lowerId = modelId.toLowerCase();
  const endpoint = getEndpoint(serviceId);
  const directHit = endpoint?.models.find((model) => model.id.toLowerCase() === lowerId);
  if (directHit) return directHit;

  const hits: Array<{ model: InkosModel; endpointId: string }> = [];
  for (const item of getAllEndpoints()) {
    const matched = item.models.find((model) => model.id.toLowerCase() === lowerId);
    if (matched) hits.push({ model: matched, endpointId: item.id });
  }

  if (hits.length === 0) return undefined;
  hits.sort((left, right) => {
    const li = PROVIDER_PRIORITY.indexOf(left.endpointId);
    const ri = PROVIDER_PRIORITY.indexOf(right.endpointId);
    return (li === -1 ? 999 : li) - (ri === -1 ? 999 : ri);
  });

  return hits[0]!.model;
}

export function listEnabledModels(serviceId: string): InkosModel[] {
  const endpoint = getEndpoint(serviceId);
  if (!endpoint) return [];
  return endpoint.models.filter((model) => model.enabled !== false);
}

export function listActiveTextModels(serviceId: string): InkosModel[] {
  return listEnabledModels(serviceId);
}
