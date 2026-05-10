import type { InkosEndpoint } from "./types.js";
import { OPENAI_ENDPOINTS } from "./endpoints/openai.js";
import { ANTHROPIC_ENDPOINTS } from "./endpoints/anthropic.js";

export type { InkosEndpoint, InkosModel } from "./types.js";

const ALL_ENDPOINTS: readonly InkosEndpoint[] = [
  ...OPENAI_ENDPOINTS,
  ...ANTHROPIC_ENDPOINTS,
];

const ENDPOINT_MAP = new Map(ALL_ENDPOINTS.map((endpoint) => [endpoint.id, endpoint]));

export function getAllEndpoints(): readonly InkosEndpoint[] {
  return ALL_ENDPOINTS;
}

export function getEndpoint(id: string): InkosEndpoint | undefined {
  return ENDPOINT_MAP.get(id);
}
