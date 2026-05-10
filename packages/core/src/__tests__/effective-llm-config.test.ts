import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEffectiveLLMConfig } from "../utils/effective-llm-config.js";

const ENV_KEYS = [
  "INKOS_LLM_PROVIDER",
  "INKOS_LLM_BASE_URL",
  "INKOS_LLM_SERVICE",
  "INKOS_LLM_MODEL",
  "INKOS_LLM_API_KEY",
  "INKOS_LLM_TEMPERATURE",
  "INKOS_LLM_MAX_TOKENS",
  "INKOS_LLM_THINKING_BUDGET",
  "INKOS_LLM_API_FORMAT",
  "INKOS_LLM_STREAM",
  "INKOS_DEFAULT_LANGUAGE",
] as const;

describe("resolveEffectiveLLMConfig", () => {
  let root = "";
  const previousEnv = new Map<string, string | undefined>();

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const previous = previousEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    previousEnv.clear();

    if (root) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  function resetEnv(): void {
    for (const key of ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  }

  it("applies env overlays in cli-project mode when cli.service is not forced", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-effective-cli-project-env-"));
    resetEnv();

    process.env.INKOS_LLM_SERVICE = "openai";
    process.env.INKOS_LLM_MODEL = "gpt-5.4";
    process.env.INKOS_LLM_API_KEY = "sk-env";

    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "effective-config-project",
      version: "0.1.0",
      llm: {
        configSource: "studio",
        provider: "openai",
        service: "moonshot",
        baseUrl: "https://api.moonshot.cn/v1",
        model: "kimi-k2.5",
        services: [
          { service: "moonshot", baseUrl: "https://api.moonshot.cn/v1" },
          { service: "openai", baseUrl: "https://api.openai.com/v1" },
        ],
      },
      notify: [],
    }, null, 2), "utf-8");

    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(
      join(root, ".inkos", "secrets.json"),
      JSON.stringify({ services: { moonshot: { apiKey: "sk-moon" }, openai: { apiKey: "sk-open" } } }, null, 2),
      "utf-8",
    );

    const result = await resolveEffectiveLLMConfig({
      consumer: "cli",
      projectRoot: root,
    });

    expect(result.llm.service).toBe("openai");
    expect(result.llm.model).toBe("gpt-5.4");
    expect(result.llm.apiKey).toBe("sk-env");
    expect(result.diagnostics.serviceSource).toBe("env");
    expect(result.diagnostics.modelSource).toBe("env");
    expect(result.diagnostics.apiKeySource).toBe("env");
  });

  it("does not use INKOS_LLM_API_KEY when service is explicitly forced from CLI", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-effective-cli-project-cli-"));
    resetEnv();

    process.env.INKOS_LLM_API_KEY = "sk-env";

    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "effective-config-project-cli",
      version: "0.1.0",
      llm: {
        configSource: "studio",
        provider: "openai",
        service: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.4",
        defaultModel: "kimi-k2.5",
        services: [
          { service: "moonshot", baseUrl: "https://api.moonshot.cn/v1" },
          { service: "openai", baseUrl: "https://api.openai.com/v1" },
        ],
      },
      notify: [],
    }, null, 2), "utf-8");

    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(
      join(root, ".inkos", "secrets.json"),
      JSON.stringify({ services: { moonshot: { apiKey: "sk-moon" }, openai: { apiKey: "sk-open" } } }, null, 2),
      "utf-8",
    );

    const result = await resolveEffectiveLLMConfig({
      consumer: "cli",
      projectRoot: root,
      cli: { service: "moonshot" },
    });

    expect(result.llm.service).toBe("moonshot");
    expect(result.llm.apiKey).toBe("sk-moon");
    expect(result.diagnostics.serviceSource).toBe("cli");
    expect(result.diagnostics.apiKeySource).toBe("studio-secret");
  });

  it("uses studio-specific API key error message for studio consumer", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-effective-studio-error-"));
    resetEnv();

    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "effective-studio-error",
      version: "0.1.0",
      llm: {
        configSource: "studio",
        provider: "openai",
        service: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.4",
      },
      notify: [],
    }, null, 2), "utf-8");

    await mkdir(join(root, ".inkos"), { recursive: true });
    // Don't write secrets.json - that's what triggers the error

    await expect(resolveEffectiveLLMConfig({
      consumer: "studio",
      projectRoot: root,
      requireApiKey: true,
    })).rejects.toThrow(/Studio LLM API key not set/i);
  });

  it("does not apply INKOS_LLM_* overlays in studio mode", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-effective-studio-ignore-env-"));
    resetEnv();

    process.env.INKOS_LLM_MODEL = "gpt-5.4";
    process.env.INKOS_LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.INKOS_LLM_API_KEY = "sk-env";

    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "effective-studio-ignore-env",
      version: "0.1.0",
      llm: {
        configSource: "studio",
        provider: "openai",
        service: "moonshot",
        baseUrl: "https://api.moonshot.cn/v1",
        model: "kimi-k2.5",
      },
      notify: [],
    }, null, 2), "utf-8");

    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(
      join(root, ".inkos", "secrets.json"),
      JSON.stringify({ services: { moonshot: { apiKey: "sk-moon" } } }, null, 2),
      "utf-8",
    );

    const result = await resolveEffectiveLLMConfig({
      consumer: "studio",
      projectRoot: root,
    });

    expect(result.llm.model).toBe("kimi-k2.5");
    expect(result.llm.baseUrl).toBe("https://api.moonshot.cn/v1");
    expect(result.llm.apiKey).toBe("sk-moon");
    expect(result.diagnostics.warnings.length).toBeGreaterThan(0);
  });
});
