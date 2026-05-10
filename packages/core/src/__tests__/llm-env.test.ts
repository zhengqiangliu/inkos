import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadLLMEnvLayers, cliOverlayEnv, legacyEnv, studioIgnoredEnv } from "../utils/llm-env.js";

describe("llm-env layers", () => {
  let root = "";

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("loads project .env and merges with process env", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-llm-env-"));
    await writeFile(join(root, ".env"), [
      "INKOS_LLM_SERVICE=moonshot",
      "INKOS_LLM_MODEL=kimi-k2.5",
      "INKOS_LLM_API_KEY=sk-project",
    ].join("\n"), "utf-8");

    const processEnv: NodeJS.ProcessEnv = {
      INKOS_LLM_MODEL: "gpt-5.4",
      INKOS_DEFAULT_LANGUAGE: "zh",
    };

    const layers = await loadLLMEnvLayers(root, processEnv);
    const cli = cliOverlayEnv(layers);
    const legacy = legacyEnv(layers);
    const studio = studioIgnoredEnv(layers);

    expect(cli.INKOS_LLM_SERVICE).toBe("moonshot");
    expect(cli.INKOS_LLM_MODEL).toBe("gpt-5.4");
    expect(legacy.INKOS_LLM_API_KEY).toBe("sk-project");
    expect(studio.INKOS_DEFAULT_LANGUAGE).toBe("zh");
  });
});
