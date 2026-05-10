import { ProjectConfigSchema, type LLMConfig, type ProjectConfig } from "../models/project.js";
import { loadProjectConfig, isApiKeyOptionalForEndpoint } from "./config-loader.js";
import { guessServiceFromBaseUrl, resolveServicePreset, resolveServiceProviderFamily } from "../llm/service-presets.js";
import { getServiceApiKey } from "../llm/secrets.js";
import { cliOverlayEnv, legacyEnv, loadLLMEnvLayers, studioIgnoredEnv, type LLMEnvMap } from "./llm-env.js";

export type LLMConsumer = "studio" | "cli" | "daemon" | "deploy";
export type LLMConfigMode = "studio-project" | "cli-project" | "legacy-env";
export type LLMValueSource = "project" | "studio-secret" | "env" | "cli" | "default";

export interface LLMConfigCliOverrides {
  readonly service?: string;
  readonly model?: string;
  readonly apiKeyEnv?: string;
  readonly baseUrl?: string;
  readonly apiFormat?: "chat" | "responses";
  readonly stream?: boolean;
}

export interface ResolveEffectiveLLMConfigInput {
  readonly consumer: LLMConsumer;
  readonly projectRoot: string;
  readonly cli?: LLMConfigCliOverrides;
  readonly requireApiKey?: boolean;
}

export interface EffectiveLLMDiagnostics {
  readonly configMode: LLMConfigMode;
  readonly serviceSource: LLMValueSource;
  readonly modelSource: LLMValueSource;
  readonly apiKeySource: LLMValueSource;
  readonly warnings: readonly string[];
}

export interface EffectiveLLMConfigResult {
  readonly config: ProjectConfig;
  readonly llm: LLMConfig;
  readonly diagnostics: EffectiveLLMDiagnostics;
}

interface ServiceConfigEntry {
  readonly service: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly apiFormat?: "chat" | "responses";
  readonly stream?: boolean;
}

interface MutableDiagnostics {
  configMode: LLMConfigMode;
  serviceSource: LLMValueSource;
  modelSource: LLMValueSource;
  apiKeySource: LLMValueSource;
  warnings: string[];
}

function toMutableConfig(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    llm: {
      ...config.llm,
      ...(Array.isArray(config.llm.services) ? { services: [...config.llm.services] } : {}),
    },
  };
}

export async function resolveEffectiveLLMConfig(
  input: ResolveEffectiveLLMConfigInput,
): Promise<EffectiveLLMConfigResult> {
  // Load without hard API-key requirement first; requirement is enforced after all overrides are applied.
  const baseConfig = await loadProjectConfig(input.projectRoot, {
    requireApiKey: false,
  });
  const config = toMutableConfig(baseConfig);
  const llm = config.llm as LLMConfig;
  const services = normalizeServiceEntries(llm.services);
  const envLayers = await loadLLMEnvLayers(input.projectRoot);
  const configMode = resolveConfigMode(input.consumer, llm, services);
  const env = resolveEnvByMode(configMode, envLayers);

  const diagnostics: MutableDiagnostics = {
    configMode,
    serviceSource: "project",
    modelSource: "project",
    apiKeySource: llm.apiKey ? (llm.configSource === "env" ? "env" : "studio-secret") : "default",
    warnings: [],
  };

  if (configMode === "studio-project") {
    warnIfStudioIgnoresEnv(env, diagnostics);
    warnIfStaleTopLevel(llm, services, diagnostics);
    // Load API key from studio secrets
    const secretApiKey = await getApiKeyFromEntry(input.projectRoot, synthesizeServiceEntry(llm.service));
    if (secretApiKey) {
      llm.apiKey = secretApiKey;
      diagnostics.apiKeySource = "studio-secret";
    }
  } else if (configMode === "cli-project") {
    await applyCliProjectOverlays(llm, services, input, env, diagnostics, input.projectRoot);
  } else {
    await applyLegacyEnvOverlays(llm, input, env, diagnostics, input.projectRoot);
  }

  if (configMode !== "studio-project") {
    applyCommonEnv(config, llm, env);
  }

  if (input.requireApiKey === false) {
    fillNoopLLMDefaults(llm);
  }

  enforceApiKeyRequirement({
    configMode,
    llm,
    requireApiKey: input.requireApiKey,
  });

  const parsed = ProjectConfigSchema.parse(config);
  return {
    config: parsed,
    llm: parsed.llm,
    diagnostics,
  };
}

function resolveConfigMode(
  consumer: LLMConsumer,
  llm: LLMConfig,
  services: readonly ServiceConfigEntry[],
): LLMConfigMode {
  if (consumer === "studio") return "studio-project";
  if (llm.configSource === "env") return "legacy-env";
  if (llm.configSource === "studio" || services.length > 0) return "cli-project";
  return "legacy-env";
}

async function applyCliProjectOverlays(
  llm: LLMConfig,
  services: readonly ServiceConfigEntry[],
  input: ResolveEffectiveLLMConfigInput,
  env: Record<string, string>,
  diagnostics: MutableDiagnostics,
  projectRoot: string,
): Promise<void> {
  const envBaseUrl = stringValue(env.INKOS_LLM_BASE_URL);
  const envService = stringValue(env.INKOS_LLM_SERVICE)
    ?? (envBaseUrl ? guessServiceFromBaseUrl(envBaseUrl) : undefined);
  const requestedService = stringValue(input.cli?.service) ?? envService;

  if (stringValue(input.cli?.service)) diagnostics.serviceSource = "cli";
  else if (envService) diagnostics.serviceSource = "env";

  const selectedEntry = selectServiceEntry(services, requestedService ?? llm.service)
    ?? synthesizeServiceEntry(requestedService ?? llm.service);

  if (selectedEntry) {
    applyServiceEntry(llm, selectedEntry);
  } else if (requestedService) {
    llm.service = requestedService;
  }

  const envModel = stringValue(env.INKOS_LLM_MODEL);
  const requestedModel = stringValue(input.cli?.model) ?? (stringValue(input.cli?.service) ? undefined : envModel);
  if (requestedModel) {
    assertModelBelongsToService(selectedEntry, requestedModel);
    llm.model = requestedModel;
    diagnostics.modelSource = stringValue(input.cli?.model) ? "cli" : "env";
  } else {
    const fallbackModel = resolveServiceModel(
      selectedEntry,
      llm.model,
      llm.defaultModel,
    );
    if (fallbackModel) {
      llm.model = fallbackModel;
      diagnostics.modelSource = llm.model ? "project" : "default";
    }
  }

  const lockServiceByCli = Boolean(stringValue(input.cli?.service));
  if (!lockServiceByCli && envBaseUrl) llm.baseUrl = envBaseUrl;
  if (!lockServiceByCli && stringValue(env.INKOS_LLM_PROVIDER)) {
    llm.provider = env.INKOS_LLM_PROVIDER as LLMConfig["provider"];
  }

  if (stringValue(input.cli?.baseUrl)) {
    llm.baseUrl = input.cli!.baseUrl!.trim();
    diagnostics.serviceSource = "cli";
  }
  if (input.cli?.apiFormat) llm.apiFormat = input.cli.apiFormat;
  if (typeof input.cli?.stream === "boolean") llm.stream = input.cli.stream;

  const envApiKey = !lockServiceByCli ? stringValue(env.INKOS_LLM_API_KEY) : undefined;
  const cliApiKey = input.cli?.apiKeyEnv ? stringValue(env[input.cli.apiKeyEnv]) : undefined;
  const secretApiKey = await getApiKeyFromEntry(projectRoot, selectedEntry ?? synthesizeServiceEntry(llm.service));
  llm.apiKey = cliApiKey ?? envApiKey ?? secretApiKey ?? llm.apiKey ?? "";
  diagnostics.apiKeySource = cliApiKey
    ? "cli"
    : envApiKey
      ? "env"
      : secretApiKey
        ? "studio-secret"
        : llm.apiKey
          ? "project"
          : "default";
}

async function applyLegacyEnvOverlays(
  llm: LLMConfig,
  input: ResolveEffectiveLLMConfigInput,
  env: Record<string, string>,
  diagnostics: MutableDiagnostics,
  projectRoot: string,
): Promise<void> {
  llm.configSource = "env";

  if (stringValue(env.INKOS_LLM_SERVICE)) {
    llm.service = env.INKOS_LLM_SERVICE;
    diagnostics.serviceSource = "env";
  }
  if (stringValue(env.INKOS_LLM_PROVIDER)) {
    llm.provider = env.INKOS_LLM_PROVIDER as LLMConfig["provider"];
  }
  if (stringValue(env.INKOS_LLM_BASE_URL)) {
    llm.baseUrl = env.INKOS_LLM_BASE_URL;
  }
  if (stringValue(env.INKOS_LLM_MODEL)) {
    llm.model = env.INKOS_LLM_MODEL;
    diagnostics.modelSource = "env";
  }

  if (stringValue(input.cli?.service)) {
    const entry = synthesizeServiceEntry(input.cli!.service!.trim());
    if (entry) {
      applyServiceEntry(llm, entry);
      if (!stringValue(input.cli?.model)) {
        llm.model = resolveServiceModel(entry, undefined, llm.defaultModel);
      }
    } else {
      llm.service = input.cli!.service!.trim();
    }
    diagnostics.serviceSource = "cli";
  }

  if (stringValue(input.cli?.model)) {
    const cliModel = input.cli!.model!.trim();
    assertModelBelongsToService(synthesizeServiceEntry(llm.service), cliModel);
    llm.model = cliModel;
    diagnostics.modelSource = "cli";
  }

  if (stringValue(input.cli?.baseUrl)) {
    llm.baseUrl = input.cli!.baseUrl!.trim();
  }
  if (input.cli?.apiFormat) llm.apiFormat = input.cli.apiFormat;
  if (typeof input.cli?.stream === "boolean") llm.stream = input.cli.stream;

  const envApiKey = stringValue(env.INKOS_LLM_API_KEY);
  const cliApiKey = input.cli?.apiKeyEnv ? stringValue(env[input.cli.apiKeyEnv]) : undefined;
  const secretApiKey = await getApiKeyFromEntry(projectRoot, synthesizeServiceEntry(llm.service));
  llm.apiKey = cliApiKey ?? envApiKey ?? secretApiKey ?? llm.apiKey ?? "";
  diagnostics.apiKeySource = cliApiKey
    ? "cli"
    : envApiKey
      ? "env"
      : secretApiKey
        ? "studio-secret"
        : llm.apiKey
          ? "project"
          : "default";
}

function applyServiceEntry(llm: LLMConfig, entry: ServiceConfigEntry): void {
  const preset = resolveServicePreset(entry.service);
  llm.service = entry.service;
  llm.provider = deriveProviderFromService(entry.service);
  llm.baseUrl = entry.baseUrl ?? preset?.baseUrl ?? llm.baseUrl;
  if (entry.temperature !== undefined) llm.temperature = entry.temperature;
  if (entry.maxTokens !== undefined) llm.maxTokens = entry.maxTokens;

  if (entry.apiFormat !== undefined) {
    llm.apiFormat = entry.apiFormat;
  } else if (preset?.api.startsWith("openai-responses")) {
    llm.apiFormat = "responses";
  }

  if (entry.stream !== undefined) {
    llm.stream = entry.stream;
  }
}

function applyCommonEnv(
  config: ProjectConfig,
  llm: LLMConfig,
  env: Record<string, string>,
): void {
  if (stringValue(env.INKOS_LLM_TEMPERATURE)) llm.temperature = Number.parseFloat(env.INKOS_LLM_TEMPERATURE);
  if (stringValue(env.INKOS_LLM_MAX_TOKENS)) llm.maxTokens = Number.parseInt(env.INKOS_LLM_MAX_TOKENS, 10);
  if (stringValue(env.INKOS_LLM_THINKING_BUDGET)) llm.thinkingBudget = Number.parseInt(env.INKOS_LLM_THINKING_BUDGET, 10);
  if (stringValue(env.INKOS_LLM_API_FORMAT) && (env.INKOS_LLM_API_FORMAT === "chat" || env.INKOS_LLM_API_FORMAT === "responses")) {
    llm.apiFormat = env.INKOS_LLM_API_FORMAT;
  }
  if (stringValue(env.INKOS_LLM_STREAM)) {
    llm.stream = parseBoolean(env.INKOS_LLM_STREAM);
  }

  const extraFromEnv: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("INKOS_LLM_EXTRA_") || !value) continue;
    extraFromEnv[key.slice("INKOS_LLM_EXTRA_".length)] = parseEnvValue(value);
  }
  if (Object.keys(extraFromEnv).length > 0) {
    llm.extra = { ...(llm.extra ?? {}), ...extraFromEnv };
  }

  if (stringValue(env.INKOS_DEFAULT_LANGUAGE) && (env.INKOS_DEFAULT_LANGUAGE === "zh" || env.INKOS_DEFAULT_LANGUAGE === "en")) {
    config.language = env.INKOS_DEFAULT_LANGUAGE;
  }
}

function selectServiceEntry(
  services: readonly ServiceConfigEntry[],
  configuredService: unknown,
): ServiceConfigEntry | undefined {
  if (typeof configuredService === "string" && configuredService.length > 0) {
    return services.find((entry) => entry.service === configuredService || serviceEntryKey(entry) === configuredService)
      ?? synthesizeServiceEntry(configuredService);
  }
  return services[0];
}

function synthesizeServiceEntry(service: unknown): ServiceConfigEntry | undefined {
  if (typeof service !== "string" || service.length === 0) return undefined;
  if (service.startsWith("custom:")) {
    return { service: "custom", name: service.slice("custom:".length) || "Custom" };
  }
  if (service === "custom" || resolveServicePreset(service)) {
    return { service };
  }
  return undefined;
}

function resolveServiceModel(
  entry: ServiceConfigEntry | undefined,
  currentModel: string | undefined,
  defaultModel: string | undefined,
): string {
  if (!entry) return defaultModel ?? currentModel ?? "noop-model";
  if (entry.service === "custom" || entry.service === "ollama") {
    return defaultModel ?? currentModel ?? "noop-model";
  }

  const preset = resolveServicePreset(entry.service);
  const known = preset?.knownModels ?? [];
  const candidate = [defaultModel, currentModel]
    .find((model): model is string => Boolean(model && modelBelongsToService(entry.service, model)));
  if (candidate) return candidate;

  return known[0] ?? defaultModel ?? currentModel ?? "noop-model";
}

function assertModelBelongsToService(entry: ServiceConfigEntry | undefined, model: string): void {
  if (!entry || entry.service === "custom" || entry.service === "ollama") return;
  const preset = resolveServicePreset(entry.service);
  if (!preset?.knownModels || preset.knownModels.length === 0) return;
  if (!modelBelongsToService(entry.service, model)) {
    throw new Error(`模型 ${model} 不属于 ${entry.service} 服务，请切换服务或选择该服务下的模型。`);
  }
}

function modelBelongsToService(service: string, model: string): boolean {
  if (service === "custom" || service === "ollama") return true;
  const preset = resolveServicePreset(service);
  if (!preset?.knownModels || preset.knownModels.length === 0) return true;
  return preset.knownModels.some((knownModel) => knownModel.toLowerCase() === model.toLowerCase());
}

function serviceEntryKey(entry: ServiceConfigEntry): string {
  return entry.service === "custom" ? `custom:${entry.name ?? "Custom"}` : entry.service;
}

function deriveProviderFromService(service: string): "anthropic" | "openai" | "custom" {
  if (service === "custom") return "custom";
  return resolveServiceProviderFamily(service) ?? "openai";
}

function warnIfStudioIgnoresEnv(
  env: Record<string, string>,
  diagnostics: MutableDiagnostics,
): void {
  if (Object.keys(env).some((key) => key.startsWith("INKOS_LLM_"))) {
    diagnostics.warnings.push("Studio 运行时不会使用 env 中的 INKOS_LLM_* 配置；请在服务配置页保存 Studio 配置。");
  }
}

function warnIfStaleTopLevel(
  llm: LLMConfig,
  services: readonly ServiceConfigEntry[],
  diagnostics: MutableDiagnostics,
): void {
  if (services.length === 0) return;
  if (["provider", "baseUrl", "model", "apiKey"].some((key) => {
    const value = llm[key as keyof LLMConfig];
    return typeof value === "string" && value.length > 0;
  })) {
    diagnostics.warnings.push("检测到旧顶层 LLM 配置；Studio 模式以选中的 service/defaultModel/secrets 为准。");
  }
}

function fillNoopLLMDefaults(llm: LLMConfig): void {
  if (!llm.provider) llm.provider = "openai";
  if (!llm.baseUrl) llm.baseUrl = "https://example.invalid/v1";
  if (!llm.model) llm.model = "noop-model";
  if (!llm.apiKey) llm.apiKey = "";
}

function enforceApiKeyRequirement(args: {
  readonly configMode: LLMConfigMode;
  readonly llm: LLMConfig;
  readonly requireApiKey?: boolean;
}): void {
  if (args.requireApiKey === false) return;

  const apiKey = (args.llm.apiKey ?? "").trim();
  const apiKeyOptional = isApiKeyOptionalForEndpoint({
    provider: args.llm.provider,
    baseUrl: args.llm.baseUrl,
  });
  if (apiKey || apiKeyOptional) return;

  if (args.configMode === "studio-project") {
    throw new Error(
      "Studio LLM API key not set. Open Studio services and save an API key for the selected service.",
    );
  }

  throw new Error(
    "INKOS_LLM_API_KEY not set. Run 'inkos config set-global' or add it to project .env file.",
  );
}

function normalizeServiceEntries(raw: unknown): ServiceConfigEntry[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({
        service: typeof entry.service === "string" && entry.service.length > 0 ? entry.service : "custom",
        ...(typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {}),
        ...(typeof entry.baseUrl === "string" && entry.baseUrl.length > 0 ? { baseUrl: entry.baseUrl } : {}),
        ...(typeof entry.temperature === "number" ? { temperature: entry.temperature } : {}),
        ...(typeof entry.maxTokens === "number" ? { maxTokens: entry.maxTokens } : {}),
        ...(entry.apiFormat === "chat" || entry.apiFormat === "responses" ? { apiFormat: entry.apiFormat } : {}),
        ...(typeof entry.stream === "boolean" ? { stream: entry.stream } : {}),
      }));
  }

  return [];
}

function parseEnvValue(value: string): unknown {
  if (/^\d+(\.\d+)?$/.test(value)) return Number.parseFloat(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("{") || value.startsWith("[")) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function parseBoolean(value: string): boolean {
  return value === "true" || value === "1" || value === "yes";
}

function stringValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveEnvByMode(
  mode: LLMConfigMode,
  envLayers: {
    global: LLMEnvMap;
    project: LLMEnvMap;
    process: LLMEnvMap;
  },
): Record<string, string> {
  const merged = mode === "studio-project"
    ? studioIgnoredEnv(envLayers)
    : mode === "cli-project"
      ? cliOverlayEnv(envLayers)
      : legacyEnv(envLayers);
  return Object.fromEntries(
    Object.entries(merged)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
      .map(([key, value]) => [key, value.trim()]),
  );
}

async function getApiKeyFromEntry(
  projectRoot: string,
  entry: ServiceConfigEntry | undefined,
): Promise<string | undefined> {
  if (!entry) return undefined;
  const key = serviceEntryKey(entry);
  const apiKey = await getServiceApiKey(projectRoot, key);
  return apiKey ?? undefined;
}
