import { useApi } from "./use-api";

export type ConfigSource = "env" | "studio";
export type EnvScope = "project" | "global" | null;

export interface EnvConfigSummary {
  readonly detected: boolean;
  readonly provider: string | null;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly hasApiKey: boolean;
}

export interface ServicesConfigPayload {
  readonly services: Array<Record<string, unknown>>;
  readonly service: string | null;
  readonly defaultModel: string | null;
  readonly configSource: ConfigSource;
  readonly envConfig: {
    readonly project: EnvConfigSummary;
    readonly global: EnvConfigSummary;
    readonly effectiveSource: EnvScope;
  };
}

export function useServicesConfig() {
  return useApi<ServicesConfigPayload>("/services/config");
}
