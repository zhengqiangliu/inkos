import type { InkosEndpoint } from "../types.js";
import { KIMI_CODE } from "./kimiCode.js";

export const ANTHROPIC_ENDPOINTS: readonly InkosEndpoint[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    providerFamily: "anthropic",
    baseUrl: "https://api.anthropic.com",
    transportDefaults: { apiFormat: "chat", stream: true },
    models: [],
  },
  KIMI_CODE,
  {
    id: "minimax",
    label: "MiniMax",
    providerFamily: "anthropic",
    baseUrl: "https://api.minimaxi.com/anthropic",
    transportDefaults: { apiFormat: "chat", stream: true },
    models: [
      { id: "MiniMax-M2.7", name: "MiniMax-M2.7" },
      { id: "MiniMax-M2.7-highspeed", name: "MiniMax-M2.7-highspeed" },
      { id: "MiniMax-M2.5", name: "MiniMax-M2.5" },
      { id: "MiniMax-M2.5-highspeed", name: "MiniMax-M2.5-highspeed" },
      { id: "MiniMax-M2.1", name: "MiniMax-M2.1" },
      { id: "MiniMax-M2.1-highspeed", name: "MiniMax-M2.1-highspeed" },
      { id: "MiniMax-M2", name: "MiniMax-M2" },
    ],
  },
  {
    id: "bailian",
    label: "百炼 (通义千问)",
    providerFamily: "anthropic",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    modelsBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    transportDefaults: { apiFormat: "chat", stream: true },
    models: [],
  },
];
