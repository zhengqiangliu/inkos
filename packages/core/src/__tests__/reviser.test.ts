import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviserAgent } from "../agents/reviser.js";
import { buildLengthSpec } from "../utils/length-metrics.js";
import type { AuditIssue } from "../agents/continuity.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

const CRITICAL_ISSUE: AuditIssue = {
  severity: "critical",
  category: "continuity",
  description: "Fix the broken continuity",
  suggestion: "Repair the contradiction",
  issueId: "ISSUE-07",
  dimensionId: "continuity",
  excerpt: "The scene jumps without transition.",
};

describe("ReviserAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers book language override when building revision prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-lang-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    await writeFile(
      join(bookDir, "book.json"),
      JSON.stringify({
        id: "english-book",
        title: "English Book",
        genre: "xuanhuan",
        platform: "royalroad",
        chapterWordCount: 800,
        targetChapters: 60,
        status: "active",
        language: "en",
        createdAt: "2026-03-23T00:00:00.000Z",
        updatedAt: "2026-03-23T00:00:00.000Z",
      }, null, 2),
      "utf-8",
    );
    await writeFile(
      join(bookDir, "story", "foundation_brief.md"),
      "# Foundation Brief\n\nThe mentor debt and harbor ledger drive the story.\n",
      "utf-8",
    );

    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- repaired",
        "",
        "=== REVISED_CONTENT ===",
        "Revised chapter content.",
        "",
        "=== UPDATED_STATE ===",
        "State card",
        "",
        "=== UPDATED_HOOKS ===",
        "Hooks board",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(bookDir, "Original chapter content.", 1, [CRITICAL_ISSUE], "rewrite", "xuanhuan");

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";
      const userPrompt = messages?.[1]?.content ?? "";

      expect(systemPrompt).toContain("MUST be in English");
      expect(systemPrompt).toContain("written entirely in English");
      expect(userPrompt).toContain("Foundation Brief");
      expect(userPrompt).toContain("mentor debt and harbor ledger");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps rewrite mode local-first instead of encouraging full-chapter replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-rewrite-guardrail-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- repaired",
        "",
        "=== PATCHES ===",
        "--- PATCH 1 ---",
        "TARGET_TEXT:",
        "原始正文。",
        "REPLACEMENT_TEXT:",
        "修订后的正文。",
        "--- END PATCH ---",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(bookDir, "原始正文。", 1, [CRITICAL_ISSUE], "rewrite", "xuanhuan");

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";

      expect(systemPrompt).toContain("优先保留原文的绝大部分句段");
      expect(systemPrompt).toContain("除非问题跨越整章");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tells the model to preserve the target range when a length spec is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- repaired",
        "",
        "=== PATCHES ===",
        "--- PATCH 1 ---",
        "TARGET_TEXT:",
        "原始正文。",
        "REPLACEMENT_TEXT:",
        "修订后的正文。",
        "--- END PATCH ---",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(
        bookDir,
        "原始正文。",
        1,
        [CRITICAL_ISSUE],
        "spot-fix",
        "xuanhuan",
        {
          lengthSpec: buildLengthSpec(220, "zh"),
        },
      );

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";
      const userPrompt = messages?.[1]?.content ?? "";

      expect(systemPrompt).toContain("保持章节字数在目标区间内");
      expect(systemPrompt).toContain("=== PATCHES ===");
      expect(systemPrompt).not.toContain("=== REVISED_CONTENT ===");
      expect(userPrompt).toContain("目标字数：220");
      expect(userPrompt).toContain("允许区间：190-250");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconstructs revised content from spot-fix patches and preserves untouched text", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-spotfix-patch-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- 收紧了开头动作句。",
        "",
        "=== PATCHES ===",
        "--- PATCH 1 ---",
        "TARGET_TEXT:",
        "林越没有立刻进去。",
        "REPLACEMENT_TEXT:",
        "林越先停在门槛外，侧耳听了一息。",
        "--- END PATCH ---",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    const original = [
      "门轴轻轻响了一下。",
      "林越没有立刻进去。",
      "",
      "巷子尽头的风还在吹。",
      "他把手按在潮冷的门框上，没有出声。",
      "更远处传来极轻的脚步回响，又很快断掉。",
    ].join("\n");

    try {
      const result = await agent.reviseChapter(
        bookDir,
        original,
        1,
        [CRITICAL_ISSUE],
        "spot-fix",
        "xuanhuan",
      );

      expect(result.revisedContent).toBe([
        "门轴轻轻响了一下。",
        "林越先停在门槛外，侧耳听了一息。",
        "",
        "巷子尽头的风还在吹。",
        "他把手按在潮冷的门框上，没有出声。",
        "更远处传来极轻的脚步回响，又很快断掉。",
      ].join("\n"));
      expect(result.fixedIssues).toEqual(["[ISSUE-07] - 收紧了开头动作句。"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires issue-id based targeted fixes in revise prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-issue-id-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "[ISSUE-01] 已修复。",
        "",
        "=== REVISED_CONTENT ===",
        "Revised chapter content.",
        "",
        "=== UPDATED_STATE ===",
        "State card",
        "",
        "=== UPDATED_HOOKS ===",
        "Hooks board",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(
        bookDir,
        "Original chapter content.",
        1,
        [CRITICAL_ISSUE],
        "rewrite",
        "xuanhuan",
      );
      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";
      const userPrompt = messages?.[1]?.content ?? "";

      expect(systemPrompt).toContain("FIXED_ISSUES");
      expect(systemPrompt).toContain("优先沿用原 issueId");
      expect(userPrompt).toContain("[ISSUE-07]");
      expect(userPrompt).toContain("[continuity]");
      expect(userPrompt).toContain("[critical]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects audit gate and unresolved issue context into revise prompt when provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-audit-context-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "[ISSUE-01] 已修复。",
        "",
        "=== REVISED_CONTENT ===",
        "修订后的正文。",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(
        bookDir,
        "原始正文。",
        1,
        [CRITICAL_ISSUE],
        "rewrite",
        "xuanhuan",
        {
          reviseContext: {
            failureGate: "critical",
            score: 62,
            passScoreThreshold: 80,
            mustFixFirstIssueIds: ["ISSUE-01"],
            unresolvedIssueIdsFromPrevRound: ["ISSUE-01"],
            issueClassCounts: { structural: 2, textual: 1 },
            primaryIssueClass: "structural",
            dimensionChecks: [
              { dimension: "大纲偏离检测", status: "failed", evidence: "主线推进缺失" },
            ],
          },
        },
      );

      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined;
      const userPrompt = messages?.[1]?.content ?? "";
      expect(userPrompt).toContain("## 审计门禁信息");
      expect(userPrompt).toContain("failureGate: critical");
      expect(userPrompt).toContain("门禁策略：critical gate");
      expect(userPrompt).toContain("当前评分: 62");
      expect(userPrompt).toContain("通过阈值: 80");
      expect(userPrompt).toContain("距离通过阈值还差: 18");
      expect(userPrompt).toContain("问题分类计数：structural=2, textual=1");
      expect(userPrompt).toContain("主问题类型：structural");
      expect(userPrompt).toContain("ISSUE-01");
      expect(userPrompt).toContain("必须优先修复");
      expect(userPrompt).toContain("## 本轮失败维度（优先修复）");
      expect(userPrompt).toContain("大纲偏离检测");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes structure overload directives in revise prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-structure-overload-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "[ISSUE-01] 已修复。",
        "",
        "=== REVISED_CONTENT ===",
        "修订后的正文。",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(
        bookDir,
        "原始正文。",
        1,
        [CRITICAL_ISSUE],
        "rewrite",
        "xuanhuan",
        {
          reviseContext: {
            failureGate: "score",
            score: 48,
            passScoreThreshold: 80,
            scoreShortfall: 32,
            structureOverload: {
              enabled: true,
              reason: "结构债务过重",
              signals: [
                { code: "hook_debt_pressure", severity: "warning", message: "伏笔债务偏高", suggestion: "回收旧伏笔" },
              ],
            },
            issueClassCounts: { structural: 3, textual: 1 },
            primaryIssueClass: "structural",
          },
        },
      );

      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined;
      const userPrompt = messages?.[1]?.content ?? "";
      expect(userPrompt).toContain("结构过载");
      expect(userPrompt).toContain("本轮唯一目标");
      expect(userPrompt).toContain("hook_debt_pressure");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders externalContext as a separate revise prompt block", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-external-context-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "[ISSUE-01] 已修复。",
        "",
        "=== REVISED_CONTENT ===",
        "修订后的正文。",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(
        bookDir,
        "原始正文。",
        1,
        [CRITICAL_ISSUE],
        "rewrite",
        "xuanhuan",
        {
          externalContext: "把注意力收回师债主线，并保留柜台后的异常灯光。",
          userBrief: "只收紧结尾，不要改动主线。",
        },
      );

      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined;
      const userPrompt = messages?.[1]?.content ?? "";
      expect(userPrompt).toContain("## 外部指令");
      expect(userPrompt).toContain("把注意力收回师债主线，并保留柜台后的异常灯光");
      expect(userPrompt).toContain("## 用户修订要求");
      expect(userPrompt).toContain("只收紧结尾，不要改动主线");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not render failed-dimension block when dimensionChecks has only warning/pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-dimension-check-warning-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "[ISSUE-01] 已修复。",
        "",
        "=== REVISED_CONTENT ===",
        "修订后的正文。",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(
        bookDir,
        "原始正文。",
        1,
        [CRITICAL_ISSUE],
        "rewrite",
        "xuanhuan",
        {
          reviseContext: {
            failureGate: "score",
            score: 70,
            passScoreThreshold: 80,
            mustFixFirstIssueIds: ["ISSUE-01"],
            unresolvedIssueIdsFromPrevRound: ["ISSUE-01"],
            dimensionChecks: [
              { dimension: "时间线检查", status: "warning", evidence: "局部跳跃" },
              { dimension: "角色一致性", status: "pass", evidence: "通过" },
            ],
          },
        },
      );

      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined;
      const userPrompt = messages?.[1]?.content ?? "";
      expect(userPrompt).toContain("## 审计门禁信息");
      expect(userPrompt).toContain("failureGate: score");
      expect(userPrompt).toContain("门禁策略：score gate");
      expect(userPrompt).not.toContain("## 本轮失败维度（优先修复）");
      expect(userPrompt).not.toContain("时间线检查");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces structural truth-action block when structural issues are present", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-structural-block-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });
    const structuralIssue: AuditIssue = {
      severity: "warning",
      category: "卷纲一致性",
      description: "卷纲偏离，主线推进失焦。",
      suggestion: "对齐卷纲锚点。",
    };

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "[ISSUE-01] 已修复。",
        "",
        "=== REVISED_CONTENT ===",
        "修订后的正文。",
        "",
        "=== STRUCTURAL_TRUTH_ACTIONS ===",
        "[ISSUE-01] file=current_state.md action=补齐卷纲锚点 reason=修复主线偏移",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(bookDir, "原始正文。", 1, [structuralIssue], "rewrite", "xuanhuan");
      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";
      expect(systemPrompt).toContain("=== STRUCTURAL_TRUTH_ACTIONS ===");
      expect(systemPrompt).toContain("结构修复模式（强制）");
      expect(systemPrompt).toContain("current_state.md / pending_hooks.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to original chapter when rewrite output crosses chapter boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-boundary-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "[ISSUE-01] 已修复。",
        "",
        "=== REVISED_CONTENT ===",
        "# 第2章 越界内容",
        "跨章段落。",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    const original = "这是第1章正文。";
    try {
      const result = await agent.reviseChapter(bookDir, original, 1, [CRITICAL_ISSUE], "rewrite", "xuanhuan");
      expect(result.revisedContent).toBe(original);
      expect(result.fixedIssues.some((line) => line.includes("章节边界保护"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes FIXED_ISSUES to issue-id mapped lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-fixed-map-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "修复了角色动机冲突。",
        "补强了结尾推进。",
        "",
        "=== REVISED_CONTENT ===",
        "修订后的正文。",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    const issues: AuditIssue[] = [
      {
        severity: "warning",
        category: "动机一致性",
        description: "角色动机断裂。",
        suggestion: "补齐动机桥接。",
      },
      {
        severity: "warning",
        category: "收束",
        description: "章末落点偏弱。",
        suggestion: "强化章末推进。",
      },
    ];
    try {
      const result = await agent.reviseChapter(bookDir, "原始正文。", 1, issues, "rewrite", "xuanhuan");
      expect(result.fixedIssues[0]).toContain("[ISSUE-01]");
      expect(result.fixedIssues[1]).toContain("[ISSUE-02]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("streams spot-fix patch deltas when onSpotFixPatchDelta is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-spotfix-stream-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chunks = [
      [
        "=== FIXED_ISSUES ===",
        "- 修复了关键句。",
        "",
        "=== PATCHES ===",
        "--- PATCH 1 ---",
        "TARGET_TEXT:",
        "原句。",
        "",
      ].join("\n"),
      [
        "REPLACEMENT_TEXT:",
        "新句。",
        "--- END PATCH ---",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
    ];
    vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockImplementation(
      async (...args: any[]) => {
        const options = args[1] as { onTextDelta?: (text: string) => void } | undefined;
        for (const chunk of chunks) {
          options?.onTextDelta?.(chunk);
        }
        return {
          content: chunks.join(""),
          usage: ZERO_USAGE,
        };
      },
    );

    const patchDeltas: string[] = [];
    const original = ["开头。", "原句。", "结尾。"].join("\n");

    try {
      const result = await agent.reviseChapter(
        bookDir,
        original,
        1,
        [CRITICAL_ISSUE],
        "spot-fix",
        "xuanhuan",
        {
          onSpotFixPatchDelta: (text) => patchDeltas.push(text),
        },
      );

      expect(patchDeltas.join("")).toContain("--- PATCH 1 ---");
      expect(patchDeltas.join("")).toContain("REPLACEMENT_TEXT");
      expect(result.revisedContent.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses selected summary and hook evidence instead of full long-history markdown in governed mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-governed-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "# Pending Hooks",
          "",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| guild-route | 1 | mystery | open | 2 | 6 | Merchant guild trail |",
          "| mentor-oath | 8 | relationship | open | 99 | 101 | Mentor oath debt with Lin Yue |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "chapter_summaries.md"),
        [
          "# Chapter Summaries",
          "",
          "| 1 | Guild Trail | Merchant guild flees west | Route clues only | None | guild-route seeded | tense | action |",
          "| 99 | Trial Echo | Lin Yue | Mentor left without explanation | Oath token matters again | mentor-oath advanced | aching | fallout |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 100\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(
        join(storyDir, "story_bible.md"),
        [
          "# Story Bible",
          "",
          "- The jade seal cannot be destroyed.",
          "- Guildmaster Ren secretly forged the harbor roster in chapter 140.",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "character_matrix.md"),
        [
          "# 角色交互矩阵",
          "",
          "### 角色档案",
          "| 角色 | 核心标签 | 反差细节 | 说话风格 | 性格底色 | 与主角关系 | 核心动机 | 当前目标 |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| Lin Yue | oath | restraint | clipped | stubborn | self | repay debt | find mentor |",
          "| Guildmaster Ren | guild | swagger | loud | opportunistic | rival | stall Mara | seize seal |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
    ]);

    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- repaired",
        "",
        "=== PATCHES ===",
        "--- PATCH 1 ---",
        "TARGET_TEXT:",
        "原始正文。",
        "REPLACEMENT_TEXT:",
        "修订后的正文。",
        "--- END PATCH ---",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(
        bookDir,
        "原始正文。",
        100,
        [CRITICAL_ISSUE],
        "spot-fix",
        "xuanhuan",
        {
          chapterIntent: "# Chapter Intent\n\n## Goal\nBring the focus back to the mentor oath conflict.\n",
          contextPackage: {
            chapter: 100,
            selectedContext: [
              {
                source: "story/story_bible.md",
                reason: "Preserve canon constraints referenced by mustKeep.",
                excerpt: "The jade seal cannot be destroyed.",
              },
              {
                source: "story/volume_outline.md",
                reason: "Anchor the default planning node for this chapter.",
                excerpt: "Track the mentor oath fallout.",
              },
              {
                source: "story/chapter_summaries.md#99",
                reason: "Relevant episodic memory.",
                excerpt: "Trial Echo | Mentor left without explanation | mentor-oath advanced",
              },
              {
                source: "story/pending_hooks.md#mentor-oath",
                reason: "Carry forward unresolved hook.",
                excerpt: "relationship | open | 101 | Mentor oath debt with Lin Yue",
              },
            ],
          },
          ruleStack: {
            layers: [{ id: "L4", name: "current_task", precedence: 70, scope: "local" }],
            sections: {
              hard: ["current_state"],
              soft: ["current_focus"],
              diagnostic: ["continuity_audit"],
            },
            overrideEdges: [],
            activeOverrides: [],
          },
          lengthSpec: buildLengthSpec(220, "zh"),
        },
      );

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const userPrompt = messages?.[1]?.content ?? "";

      expect(userPrompt).toContain("story/chapter_summaries.md#99");
      expect(userPrompt).toContain("story/pending_hooks.md#mentor-oath");
      expect(userPrompt).toContain("story/story_bible.md");
      expect(userPrompt).toContain("story/volume_outline.md");
      expect(userPrompt).not.toContain("| 1 | Guild Trail |");
      expect(userPrompt).not.toContain("guild-route | 1 | mystery");
      expect(userPrompt).not.toContain("Guildmaster Ren secretly forged the harbor roster in chapter 140.");
      expect(userPrompt).not.toContain("| Guildmaster Ren | guild | swagger | loud | opportunistic | rival | stall Mara | seize seal |");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
