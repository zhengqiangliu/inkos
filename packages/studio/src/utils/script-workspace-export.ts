import type { ScriptWorkspace, ScriptWorkspaceEpisode } from "../shared/contracts";

function sanitizeFileSegment(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildScriptWorkspaceExportFileName(bookTitle: string, suffix: string): string {
  const base = sanitizeFileSegment(bookTitle) || "book";
  const tail = sanitizeFileSegment(suffix) || "script-workspace";
  return `${base}-${tail}.txt`;
}

export function buildEpisodeVideoPromptExportText(episode: ScriptWorkspaceEpisode): string {
  const lines = [
    `${episode.title}`,
    `章节：第${episode.chapterNumber}章 ${episode.chapterTitle}`,
    `总时长：${episode.durationSec} 秒`,
    `分段数：${episode.segments.length}`,
    "",
  ];
  for (const segment of episode.segments) {
    lines.push(`[${segment.title}]`);
    lines.push(`时长：${segment.durationSec} 秒`);
    lines.push(segment.imageToVideoPrompt);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function buildWorkspaceVideoPromptExportText(workspace: ScriptWorkspace): string {
  const lines = [
    "小说转剧本 - 图生视频提示词汇总",
    `选中章节：${workspace.selectedChapterNumbers.join("、") || "无"}`,
    `视觉风格：${workspace.config.visualStyle}`,
    `导演手法：${workspace.config.directorMethod}`,
    `AI：${workspace.config.aiTool} / ${workspace.config.aiModel}`,
    "",
  ];
  for (const episode of workspace.episodes) {
    lines.push(buildEpisodeVideoPromptExportText(episode));
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function downloadTextFile(filename: string, content: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("当前环境不支持导出文件");
  }
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}
