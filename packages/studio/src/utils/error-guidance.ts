const SUGGESTION_MARKERS = ["建议：", "可执行修复：", "下一步："] as const;

function inferSuggestion(message: string): string | null {
  const text = message.trim();
  if (!text) return null;

  if (/未触发写作器|未触发写作工具|章节尚未生成/i.test(text)) {
    return "建议：请重试“写第N章”或“写下一章”，并确认已选择可用模型。";
  }
  if (/未落盘|落盘失败|未检测到新章节索引写入|索引.*缺失|正文文件缺失/i.test(text)) {
    return "建议：先执行“修复落盘”或“修复第N章落盘与索引”，再继续写作。";
  }
  if (/state-degraded|状态降级/i.test(text)) {
    return "建议：先执行“修复最新章节落库和索引”或“修复第N章落库和索引”，恢复后再继续。";
  }
  if (/模型未返回文本|empty response|returned empty/i.test(text)) {
    return "建议：切换支持流式输出的模型，并检查协议（chat/responses）与 stream 配置。";
  }
  return null;
}

export function withErrorGuidance(message: string): string {
  const text = message.trim();
  if (!text) return message;
  if (SUGGESTION_MARKERS.some((marker) => text.includes(marker))) return text;
  const suggestion = inferSuggestion(text);
  if (!suggestion) return text;
  return `${text}\n${suggestion}`;
}

