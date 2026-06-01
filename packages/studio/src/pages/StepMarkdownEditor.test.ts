import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { StepMarkdownEditor } from "./StepMarkdownEditor";

describe("StepMarkdownEditor", () => {
  it("renders markdown content in preview mode", () => {
    const html = renderToStaticMarkup(
      createElement(StepMarkdownEditor, {
        spec: {
          title: "世界观",
          description: "只编辑当前页内容，默认以 Markdown 预览显示。",
          sections: [{ key: "worldPremise", title: "世界观", placeholder: "世界观：..." }],
        },
        value: "# 标题\n\n- 项目",
        editing: false,
        onToggleEditing: () => undefined,
        onValueChange: () => undefined,
        onAiModify: () => undefined,
      })
    );

    expect(html).toContain("标题");
    expect(html).toContain("编辑");
  });

  it("keeps the ai modify entry available in preview mode", () => {
    const html = renderToStaticMarkup(
      createElement(StepMarkdownEditor, {
        spec: {
          title: "卷纲规划",
          description: "只编辑当前页内容，默认以 Markdown 预览显示。",
          sections: [{ key: "volumeOutline", title: "卷纲方向", placeholder: "卷纲：..." }],
        },
        value: "## 第一卷\n- 目标：建立冲突",
        editing: false,
        onToggleEditing: () => undefined,
        onValueChange: () => undefined,
        onAiModify: () => undefined,
      })
    );

    expect(html).toContain("AI 修改");
    expect(html).toContain("AI 润色");
  });
});
