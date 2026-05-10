export interface InkosModel {
  readonly id: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly contextWindow?: number;
}

export interface InkosEndpoint {
  readonly id: string;
  readonly label: string;
  readonly providerFamily: "openai" | "anthropic";
  readonly baseUrl?: string;
  readonly modelsBaseUrl?: string;
  readonly transportDefaults?: {
    readonly apiFormat?: "chat" | "responses";
    readonly stream?: boolean;
  };
  readonly models: readonly InkosModel[];
}
