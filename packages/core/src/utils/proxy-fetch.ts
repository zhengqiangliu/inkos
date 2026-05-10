type ProxyEnv = Record<string, string | undefined>;

type Dispatcher = {
  dispatch(): void;
};

type RequestInitWithDispatcher = RequestInit & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatcher?: any;
};

export function resolveProxyUrl(explicitProxyUrl?: string, env: ProxyEnv = process.env): string | undefined {
  const candidate = [
    explicitProxyUrl,
    env.INKOS_LLM_PROXY_URL,
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
  ].find((value) => typeof value === "string" && value.trim().length > 0)?.trim();

  if (!candidate) return undefined;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`);
  }
  return candidate;
}

export async function buildProxyFetchInit(
  init: RequestInit = {},
  explicitProxyUrl?: string,
  env: ProxyEnv = process.env,
): Promise<RequestInitWithDispatcher> {
  const proxyUrl = resolveProxyUrl(explicitProxyUrl, env);
  if (!proxyUrl) return init;

  // Keep undici optional to avoid hard dependency drift in existing local setup.
  try {
    const importUndici = new Function("return import('undici')") as () => Promise<{
      ProxyAgent?: new (url: string) => unknown;
    }>;
    const undici = await importUndici();
    const ProxyAgentCtor = undici.ProxyAgent;
    if (!ProxyAgentCtor) return init;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ...init, dispatcher: new ProxyAgentCtor(proxyUrl) } as any;
  } catch {
    return init;
  }
}

export async function fetchWithProxy(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  explicitProxyUrl?: string,
  env: ProxyEnv = process.env,
): Promise<Response> {
  const mergedInit = await buildProxyFetchInit(init, explicitProxyUrl, env);
  return fetch(input, mergedInit);
}
