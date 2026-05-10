import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "dotenv";
import { GLOBAL_ENV_PATH } from "./config-loader.js";

export type LLMEnvMap = Record<string, string | undefined>;

export interface LLMEnvLayers {
  readonly global: LLMEnvMap;
  readonly project: LLMEnvMap;
  readonly process: LLMEnvMap;
}

export async function loadLLMEnvLayers(
  root: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<LLMEnvLayers> {
  const global = await parseEnvFile(GLOBAL_ENV_PATH);
  const project = await parseEnvFile(join(root, ".env"));

  // Keep compatibility with code paths that still read process.env directly.
  hydrateProcessEnvFromEnvFiles(processEnv, global, project);

  return {
    global,
    project,
    process: { ...processEnv },
  };
}

export function mergeEnvMaps(...layers: readonly LLMEnvMap[]): LLMEnvMap {
  const merged: LLMEnvMap = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

export function studioIgnoredEnv(layers: LLMEnvLayers): LLMEnvMap {
  return mergeEnvMaps(layers.global, layers.project, layers.process);
}

export function cliOverlayEnv(layers: LLMEnvLayers): LLMEnvMap {
  return mergeEnvMaps(layers.global, layers.project, layers.process);
}

export function legacyEnv(layers: LLMEnvLayers): LLMEnvMap {
  return mergeEnvMaps(layers.global, layers.project, layers.process);
}

async function parseEnvFile(path: string): Promise<LLMEnvMap> {
  try {
    return parse(await readFile(path, "utf-8"));
  } catch {
    return {};
  }
}

function hydrateProcessEnvFromEnvFiles(
  processEnv: NodeJS.ProcessEnv,
  global: LLMEnvMap,
  project: LLMEnvMap,
): void {
  const fileEnv = mergeEnvMaps(global, project);
  for (const [key, value] of Object.entries(fileEnv)) {
    if (value !== undefined && processEnv[key] === undefined) {
      processEnv[key] = value;
    }
  }
}
