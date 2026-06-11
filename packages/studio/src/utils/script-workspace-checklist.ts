import type { TaskChecklistItem, TaskChecklistTemplateSummary } from "../shared/contracts.js";

export type ScriptWorkspaceChecklistTemplateDefinition = {
  id: string;
  label: string;
  description: string;
  buildItems: () => ReadonlyArray<TaskChecklistItem>;
};

const TEMPLATE_DEFINITIONS: ReadonlyArray<ScriptWorkspaceChecklistTemplateDefinition> = [
  {
    id: "short-video",
    label: "短视频改编",
    description: "适合小说章节改编为 10-15 秒多段短视频。",
    buildItems: () => [
      { id: "scope", text: "确认选章/选集范围", done: false, order: 0, note: "按章或按集选择改编范围" },
      { id: "extract", text: "提取场景、角色、道具、素材", done: false, order: 1 },
      { id: "script", text: "生成剧本与分场", done: false, order: 2 },
      { id: "image-prompt", text: "生成文生图提示词", done: false, order: 3 },
      { id: "video-prompt", text: "生成图生视频提示词", done: false, order: 4, note: "每段 10-15 秒，一集多段" },
      { id: "review", text: "复核并保存", done: false, order: 5 },
    ],
  },
  {
    id: "comic-adaptation",
    label: "漫改分镜",
    description: "适合强调镜头感、角色表演和分镜节奏的改编流程。",
    buildItems: () => [
      { id: "scope", text: "确认选章与角色重点", done: false, order: 0, note: "优先锁定主冲突与角色关系" },
      { id: "scene-board", text: "拆分镜头级场景板", done: false, order: 1 },
      { id: "character-look", text: "整理角色造型与情绪参考", done: false, order: 2 },
      { id: "script", text: "生成分镜剧本与对白节奏", done: false, order: 3 },
      { id: "image-prompt", text: "生成角色卡与关键帧提示词", done: false, order: 4 },
      { id: "video-prompt", text: "生成镜头运动与转场提示词", done: false, order: 5 },
      { id: "review", text: "检查镜头连贯与节奏密度", done: false, order: 6 },
    ],
  },
  {
    id: "previs",
    label: "电影预演",
    description: "适合较长集时长、强调场面调度和导演手法的预演清单。",
    buildItems: () => [
      { id: "scope", text: "确认分集范围与总时长", done: false, order: 0, note: "先锁定每集时长与多段时长边界" },
      { id: "blocking", text: "规划场景调度与演员站位", done: false, order: 1 },
      { id: "props", text: "核对关键道具与场景素材", done: false, order: 2 },
      { id: "script", text: "生成导演版剧本与分段说明", done: false, order: 3 },
      { id: "image-prompt", text: "生成关键镜头预演图提示词", done: false, order: 4 },
      { id: "video-prompt", text: "生成图生视频与机位提示词", done: false, order: 5 },
      { id: "review", text: "复核镜头调度、光线和节奏", done: false, order: 6 },
    ],
  },
];

export const DEFAULT_SCRIPT_WORKSPACE_CHECKLIST_TEMPLATE_ID = "short-video";

export function listScriptWorkspaceChecklistTemplates(): ReadonlyArray<TaskChecklistTemplateSummary> {
  return TEMPLATE_DEFINITIONS.map(({ id, label, description }) => ({ id, label, description }));
}

export function resolveScriptWorkspaceChecklistTemplateId(templateId?: string | null): string {
  const normalized = typeof templateId === "string" ? templateId.trim() : "";
  if (!normalized) return DEFAULT_SCRIPT_WORKSPACE_CHECKLIST_TEMPLATE_ID;
  return TEMPLATE_DEFINITIONS.some((template) => template.id === normalized)
    ? normalized
    : DEFAULT_SCRIPT_WORKSPACE_CHECKLIST_TEMPLATE_ID;
}

export function buildScriptWorkspaceChecklistTemplate(templateId?: string | null): ReadonlyArray<TaskChecklistItem> {
  const resolvedId = resolveScriptWorkspaceChecklistTemplateId(templateId);
  const template = TEMPLATE_DEFINITIONS.find((entry) => entry.id === resolvedId) ?? TEMPLATE_DEFINITIONS[0]!;
  return template.buildItems().map((item, index) => ({
    ...item,
    order: index,
  }));
}
