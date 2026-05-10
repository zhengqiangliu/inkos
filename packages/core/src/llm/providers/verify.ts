import { chatCompletion, createLLMClient } from "../provider.js";
import type { ProjectConfig } from "../../models/project.js";
import { resolveServiceProviderFamily } from "../service-presets.js";

export interface VerifyModelConnectivityInput {
  readonly service: string;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly apiFormat: "chat" | "responses";
  readonly stream: boolean;
  readonly timeoutMs?: number;
}

export interface VerifyModelConnectivityResult {
  readonly ok: boolean;
  readonly elapsedMs: number;
  readonly apiFormat: "chat" | "responses";
  readonly stream: boolean;
  readonly error?: string;
}

function elapsedSince(startedAt: number): number {
  return Math.max(1, Date.now() - startedAt);
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("aborted")) {
    return "timeout";
  }
  if (
    normalized.includes("401")
    || normalized.includes("403")
    || normalized.includes("unauthorized")
    || normalized.includes("forbidden")
    || normalized.includes("api key")
  ) {
    return "auth_failed";
  }
  if (
    normalized.includes("404")
    || normalized.includes("not found")
    || (
      normalized.includes("model")
      && (
        normalized.includes("invalid")
        || normalized.includes("unknown")
        || normalized.includes("not exist")
        || normalized.includes("not available")
        || normalized.includes("doesn't exist")
      )
    )
  ) {
    return "unsupported_model";
  }
  return message;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function verifyModelConnectivity(
  args: VerifyModelConnectivityInput,
): Promise<VerifyModelConnectivityResult> {
  const startedAt = Date.now();
  const baseService = args.service.startsWith("custom:") ? "custom" : args.service;
  const client = createLLMClient({
    provider: resolveServiceProviderFamily(baseService) ?? "openai",
    service: baseService,
    configSource: "studio",
    baseUrl: args.baseUrl,
    apiKey: args.apiKey.trim(),
    model: args.model,
    temperature: 0.7,
    maxTokens: 2048,
    thinkingBudget: 0,
    apiFormat: args.apiFormat,
    stream: args.stream,
  } as ProjectConfig["llm"]);

  try {
    await withTimeout(
      chatCompletion(client, args.model, [{ role: "user", content: "ping" }], { maxTokens: 256 }),
      args.timeoutMs ?? 12_000,
    );
    return {
      ok: true,
      elapsedMs: elapsedSince(startedAt),
      apiFormat: args.apiFormat,
      stream: args.stream,
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: elapsedSince(startedAt),
      apiFormat: args.apiFormat,
      stream: args.stream,
      error: classifyError(error),
    };
  }
}
