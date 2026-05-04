import { fetchJson } from "../hooks/use-api";

export interface ServiceDetailModelInfo {
  readonly id: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly source?: "manual" | "detected";
}

export interface ServiceDetailDetectedConfig {
  readonly apiFormat?: "chat" | "responses";
  readonly stream?: boolean;
  readonly baseUrl?: string;
  readonly modelsSource?: "api" | "fallback";
}

export type ServiceDetailConnectionStatus =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "connected"; models: ServiceDetailModelInfo[] }
  | { state: "error"; message: string }
  | { state: "saving" }
  | { state: "saved" };

type JsonFetcher = typeof fetchJson;

interface ServiceProbeResponse {
  readonly ok: boolean;
  readonly models?: ServiceDetailModelInfo[];
  readonly selectedModel?: string;
  readonly detected?: ServiceDetailDetectedConfig;
  readonly error?: string;
}

function isModelDisabledInConfig(
  modelId: string,
  models: ReadonlyArray<ServiceDetailModelInfo> | undefined,
): boolean {
  if (!Array.isArray(models) || !modelId.trim()) return false;
  const matched = models.filter((model) => model.id === modelId);
  if (matched.length === 0) return false;
  return matched.every((model) => model.enabled === false);
}

function resolvePersistedDefaultModel(args: {
  readonly preferredModel?: string;
  readonly probeSelectedModel?: string;
  readonly detectedModel?: string;
  readonly models?: ReadonlyArray<ServiceDetailModelInfo>;
}): string | undefined {
  const pick = (candidate: string | undefined): string | undefined => {
    const id = candidate?.trim();
    if (!id) return undefined;
    if (isModelDisabledInConfig(id, args.models)) return undefined;
    return id;
  };

  const fromPreferred = pick(args.preferredModel);
  if (fromPreferred) return fromPreferred;

  if (Array.isArray(args.models)) {
    const firstEnabled = args.models.find((model) => model.id.trim().length > 0 && model.enabled !== false);
    if (firstEnabled) return firstEnabled.id;
  }

  const fromProbe = pick(args.probeSelectedModel);
  if (fromProbe) return fromProbe;

  const fromDetected = pick(args.detectedModel);
  if (fromDetected) return fromDetected;

  return undefined;
}

export interface ServiceDetailSingleModelTestResult {
  readonly ok: boolean;
  readonly model: string;
  readonly canConnect: boolean;
  readonly elapsedMs: number;
  readonly apiFormat: "chat" | "responses";
  readonly stream: boolean;
  readonly error?: string;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function probeServiceForDetail(
  serviceId: string,
  body: {
    readonly apiKey: string;
    readonly apiFormat: "chat" | "responses";
    readonly stream: boolean;
    readonly baseUrl?: string;
  },
  deps?: { readonly fetchJsonImpl?: JsonFetcher },
): Promise<ServiceProbeResponse> {
  const fetchJsonImpl = deps?.fetchJsonImpl ?? fetchJson;
  return await fetchJsonImpl<ServiceProbeResponse>(
    `/services/${encodeURIComponent(serviceId)}/test`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export async function rehydrateServiceConnectionStatus(args: {
  readonly effectiveServiceId: string;
  readonly shouldVerify: boolean;
  readonly isCustom: boolean;
  readonly baseUrl: string;
  readonly apiFormat: "chat" | "responses";
  readonly stream: boolean;
  readonly fetchJsonImpl?: JsonFetcher;
}): Promise<{
  readonly apiKey: string;
  readonly status: ServiceDetailConnectionStatus;
  readonly detectedModel: string;
  readonly detectedConfig: ServiceDetailDetectedConfig | null;
}> {
  const fetchJsonImpl = args.fetchJsonImpl ?? fetchJson;
  const secret = await fetchJsonImpl<{ apiKey?: string }>(
    `/services/${encodeURIComponent(args.effectiveServiceId)}/secret`,
  );
  const apiKey = String(secret.apiKey ?? "");

  if (!args.shouldVerify || apiKey.trim().length === 0) {
    return {
      apiKey,
      status: { state: "idle" },
      detectedModel: "",
      detectedConfig: null,
    };
  }

  if (args.isCustom && args.baseUrl.trim().length === 0) {
    return {
      apiKey,
      status: { state: "idle" },
      detectedModel: "",
      detectedConfig: null,
    };
  }

  try {
    const result = await probeServiceForDetail(
      args.effectiveServiceId,
      {
        apiKey: apiKey.trim(),
        apiFormat: args.apiFormat,
        stream: args.stream,
        ...(args.isCustom ? { baseUrl: args.baseUrl.trim() } : {}),
      },
      { fetchJsonImpl },
    );
    if (!result.ok) {
      return {
        apiKey,
        status: { state: "error", message: result.error ?? "连接失败" },
        detectedModel: "",
        detectedConfig: null,
      };
    }
    return {
      apiKey,
      status: { state: "connected", models: result.models ?? [] },
      detectedModel: result.selectedModel ?? "",
      detectedConfig: result.detected ?? null,
    };
  } catch (error) {
    return {
      apiKey,
      status: { state: "error", message: toErrorMessage(error, "连接失败") },
      detectedModel: "",
      detectedConfig: null,
    };
  }
}

export async function saveServiceConfigWithValidation(args: {
  readonly effectiveServiceId: string;
  readonly serviceId: string;
  readonly isCustom: boolean;
  readonly resolvedCustomName: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly apiFormat: "chat" | "responses";
  readonly stream: boolean;
  readonly modelMode?: "auto" | "manual" | "hybrid";
  readonly preferredModel?: string;
  readonly models?: ReadonlyArray<ServiceDetailModelInfo>;
  readonly temperature: string;
  readonly maxTokens: string;
  readonly detectedModel: string;
  readonly fetchJsonImpl?: JsonFetcher;
}): Promise<{
  readonly status: ServiceDetailConnectionStatus;
  readonly detectedModel: string;
  readonly detectedConfig: ServiceDetailDetectedConfig | null;
}> {
  const fetchJsonImpl = args.fetchJsonImpl ?? fetchJson;
  const trimmedKey = args.apiKey.trim();
  const trimmedBaseUrl = args.baseUrl.trim();

  let probeResult: ServiceProbeResponse | null = null;
  if (trimmedKey) {
    probeResult = await probeServiceForDetail(
      args.effectiveServiceId,
      {
        apiKey: trimmedKey,
        apiFormat: args.apiFormat,
        stream: args.stream,
        ...(args.isCustom ? { baseUrl: trimmedBaseUrl } : {}),
      },
      { fetchJsonImpl },
    );
  }

  await fetchJsonImpl(`/services/${encodeURIComponent(args.effectiveServiceId)}/secret`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: trimmedKey }),
  });

  await fetchJsonImpl("/services/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service: args.effectiveServiceId,
      ...(() => {
        const defaultModel = resolvePersistedDefaultModel({
          preferredModel: args.preferredModel,
          probeSelectedModel: probeResult?.selectedModel,
          detectedModel: args.detectedModel,
          models: args.models,
        });
        return defaultModel ? { defaultModel } : {};
      })(),
      services: [
        {
          service: args.isCustom ? "custom" : args.serviceId,
          temperature: parseFloat(args.temperature),
          maxTokens: parseInt(args.maxTokens, 10),
          apiFormat: probeResult?.detected?.apiFormat ?? args.apiFormat,
          stream: typeof probeResult?.detected?.stream === "boolean" ? probeResult.detected.stream : args.stream,
          ...(args.modelMode ? { modelMode: args.modelMode } : {}),
          ...(() => {
            const preferred = resolvePersistedDefaultModel({
              preferredModel: args.preferredModel,
              probeSelectedModel: probeResult?.selectedModel,
              detectedModel: args.detectedModel,
              models: args.models,
            });
            return preferred ? { preferredModel: preferred } : {};
          })(),
          ...(Array.isArray(args.models) ? {
            models: args.models.map((model) => ({
              id: model.id,
              ...(model.name ? { name: model.name } : {}),
              ...(typeof model.enabled === "boolean" ? { enabled: model.enabled } : {}),
              ...(model.source ? { source: model.source } : {}),
            })),
          } : {}),
          ...(args.isCustom ? {
            name: args.resolvedCustomName,
            baseUrl: probeResult?.detected?.baseUrl ?? trimmedBaseUrl,
          } : {}),
        },
      ],
    }),
  });

  if (!probeResult) {
    return {
      status: { state: "saved" },
      detectedModel: "",
      detectedConfig: null,
    };
  }

  return {
    status: { state: "connected", models: probeResult.models ?? [] },
    detectedModel: probeResult.selectedModel ?? "",
    detectedConfig: probeResult.detected ?? null,
  };
}

export async function testServiceModelForDetail(args: {
  readonly serviceId: string;
  readonly modelId: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly apiFormat: "chat" | "responses";
  readonly stream: boolean;
  readonly fetchJsonImpl?: JsonFetcher;
}): Promise<ServiceDetailSingleModelTestResult> {
  const fetchJsonImpl = args.fetchJsonImpl ?? fetchJson;
  const body = {
    ...(args.apiKey?.trim() ? { apiKey: args.apiKey.trim() } : {}),
    ...(args.baseUrl?.trim() ? { baseUrl: args.baseUrl.trim() } : {}),
    apiFormat: args.apiFormat,
    stream: args.stream,
  };

  return await fetchJsonImpl<ServiceDetailSingleModelTestResult>(
    `/services/${encodeURIComponent(args.serviceId)}/models/${encodeURIComponent(args.modelId)}/test`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}
