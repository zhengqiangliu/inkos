import { BaseAgent } from "./base.js";
import type { AgentContext } from "./base.js";
import type { BookConfig } from "../models/book.js";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface WriteChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
}

export interface WriteChapterOutput {
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly wordCount: number;
  readonly preWriteCheck: string;
  readonly postSettlement: string;
  readonly updatedState: string;
  readonly updatedLedger: string;
  readonly updatedHooks: string;
}

export class WriterAgent extends BaseAgent {
  get name(): string {
    return "writer";
  }

  async writeChapter(input: WriteChapterInput): Promise<WriteChapterOutput> {
    const { book, bookDir, chapterNumber } = input;

    const [storyBible, volumeOutline, styleGuide, currentState, ledger, hooks] =
      await Promise.all([
        this.readFileOrDefault(join(bookDir, "story/story_bible.md")),
        this.readFileOrDefault(join(bookDir, "story/volume_outline.md")),
        this.readFileOrDefault(join(bookDir, "story/style_guide.md")),
        this.readFileOrDefault(join(bookDir, "story/current_state.md")),
        this.readFileOrDefault(join(bookDir, "story/particle_ledger.md")),
        this.readFileOrDefault(join(bookDir, "story/pending_hooks.md")),
      ]);

    const recentChapters = await this.loadRecentChapters(bookDir, chapterNumber);

    const systemPrompt = this.buildSystemPrompt(book, styleGuide);
    const userPrompt = this.buildUserPrompt({
      chapterNumber,
      storyBible,
      volumeOutline,
      currentState,
      ledger,
      hooks,
      recentChapters,
      wordCount: book.chapterWordCount,
    });

    const response = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { maxTokens: 16384, temperature: 0.7 },
    );

    return this.parseOutput(chapterNumber, response.content);
  }

  async saveChapter(
    bookDir: string,
    output: WriteChapterOutput,
  ): Promise<void> {
    const chaptersDir = join(bookDir, "chapters");
    const storyDir = join(bookDir, "story");
    await mkdir(chaptersDir, { recursive: true });

    const paddedNum = String(output.chapterNumber).padStart(4, "0");
    const filename = `${paddedNum}_${this.sanitizeFilename(output.title)}.md`;

    const chapterContent = [
      `# 第${output.chapterNumber}章 ${output.title}`,
      "",
      output.content,
    ].join("\n");

    await Promise.all([
      writeFile(join(chaptersDir, filename), chapterContent, "utf-8"),
      writeFile(join(storyDir, "current_state.md"), output.updatedState, "utf-8"),
      writeFile(join(storyDir, "particle_ledger.md"), output.updatedLedger, "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), output.updatedHooks, "utf-8"),
    ]);
  }

  private buildSystemPrompt(book: BookConfig, styleGuide: string): string {
    return `你是一位专业的${book.genre}网络小说作家。你为${book.platform}平台写作。

## 核心规则

1. 以简体中文工作，句子长短交替，段落适合手机阅读
2. 每章${book.chapterWordCount}字左右
3. 主角杀伐果断、极致利己、有底线但不圣母
4. 严格维护数值体系，资源变动必须精确到具体数字
5. 伏笔前后呼应，不留悬空线
6. 只读必要上下文，不机械重复已有内容
7. 配角有血有肉，反派不降智

## 创作铁律

- Show, don't tell：用细节堆砌真实，用行动证明强大
- 反派的每一步动作必须追溯到其已知信息、资源约束和性格习惯
- 反派不能基于不可能知道的信息行动（信息越界检查）
- 三章内必有明确反馈：打脸、收益兑现、信息反转、地位变化
- 每段至少带来一项新信息、态度变化或利益变化，避免空转
- 同质资源重复吞噬必须写明衰减，不得默认全额结算
- 不要用"暴涨""海量""难以估量"跳过数值结算
- 不要让主角为推剧情突然仁慈、犯蠢、讲武德
- 不要无铺垫强行让退场角色回归

## 语言约束

- 避免连续重复同一句式、同一主语开头
- 高疲劳词（冷笑、蝼蚁、倒吸凉气、瞳孔骤缩）单章最多出现1次
- 群像反应不要一律"全场震惊"，改写成1-2个具体角色的身体反应
- 台词贴身份、阶层和处境，不堆通用狠话

## 章节类型识别

动笔前先判断本章类型：
- 战斗章：重画面、受力、收益兑现
- 布局章：重试探、交易、威慑、利益交换
- 过渡章：重状态变化、战后余波、下一步钩子
- 回收章：优先回应旧伏笔，再打开新问题

## 文风指南

${styleGuide}

## 动笔前必须自问

1. 主角此刻利益最大化的选择是什么？
2. 这场冲突是谁先动手，为什么非做不可？
3. 配角/反派是否有明确诉求、恐惧和反制？
4. 反派当前掌握了哪些已知信息？哪些信息只有读者知道？
5. 本章收益能否落到具体资源、数值增量、地位变化或已回收伏笔？
6. 如果任何问题答不上来，先补逻辑链，再写正文

## 数值验算铁律（必须遵守）

写正文时涉及任何数值变动，必须当场验算：
- 期初值从账本取（不凭记忆）
- 增量逐笔列出并注明来源
- 消耗逐笔列出并注明用途
- 期末 = 期初 + 增量 - 消耗，不得跳步
- 正文中出现的系统提示（如【气血值+X】）必须与POST_SETTLEMENT一致
- 若正文写了"比A还高"这类比较句，必须数值验证后再保留
- 同质吞噬衰减规则：同一类资源连续第N次吞噬，收益 = 基础值 × max(0.3, 1 - 0.15×(N-1))

## 输出格式（严格遵守）

=== PRE_WRITE_CHECK ===
（必须输出Markdown表格）
| 检查项 | 本章记录 | 备注 |
|--------|----------|------|
| 上下文范围 | 第X章至第Y章 / 状态卡 / 设定文件 | |
| 当前锚点 | 地点 / 对手 / 收益目标 | 锚点必须具体 |
| 当前资源总量 | X | 与账本一致 |
| 本章预计增量 | +X（来源） | 无增量写+0 |
| 待回收伏笔 | Hook-A / Hook-B | 与伏笔池一致 |
| 本章冲突 | 一句话概括 | |
| 章节类型 | 战斗/布局/过渡/回收 | |
| 风险扫描 | OOC/信息越界/设定冲突/战力崩坏/节奏/词汇疲劳 | |

=== CHAPTER_TITLE ===
(章节标题，不含"第X章")

=== CHAPTER_CONTENT ===
(正文内容，${book.chapterWordCount}字左右)

=== POST_SETTLEMENT ===
（如有数值变动，必须输出Markdown表格）
| 结算项 | 本章记录 | 备注 |
|--------|----------|------|
| 资源账本 | 期初X / 增量+Y / 期末Z | 无增量写+0 |
| 重要资源 | 资源名 -> 贡献+Y（依据） | 无写"无" |
| 伏笔变动 | 新增/回收/延后 Hook | 同步更新伏笔池 |

=== UPDATED_STATE ===
(更新后的完整状态卡，Markdown表格格式)

=== UPDATED_LEDGER ===
(更新后的完整资源账本，Markdown表格格式)

=== UPDATED_HOOKS ===
(更新后的完整伏笔池，Markdown表格格式)`;
  }

  private buildUserPrompt(params: {
    readonly chapterNumber: number;
    readonly storyBible: string;
    readonly volumeOutline: string;
    readonly currentState: string;
    readonly ledger: string;
    readonly hooks: string;
    readonly recentChapters: string;
    readonly wordCount: number;
  }): string {
    return `请续写第${params.chapterNumber}章。

## 当前状态卡
${params.currentState}

## 资源账本
${params.ledger}

## 伏笔池
${params.hooks}

## 最近章节
${params.recentChapters || "(这是第一章，无前文)"}

## 世界观设定
${params.storyBible}

## 卷纲
${params.volumeOutline}

要求：
- 正文不少于${params.wordCount}字
- 写完后更新状态卡、资源账本、伏笔池
- 先输出写作自检表，再写正文`;
  }

  private async loadRecentChapters(
    bookDir: string,
    currentChapter: number,
  ): Promise<string> {
    const chaptersDir = join(bookDir, "chapters");
    try {
      const files = await readdir(chaptersDir);
      const mdFiles = files
        .filter((f) => f.endsWith(".md") && !f.startsWith("index"))
        .sort()
        .slice(-3);

      if (mdFiles.length === 0) return "";

      const contents = await Promise.all(
        mdFiles.map(async (f) => {
          const content = await readFile(join(chaptersDir, f), "utf-8");
          return content;
        }),
      );

      return contents.join("\n\n---\n\n");
    } catch {
      return "";
    }
  }

  private async readFileOrDefault(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件尚未创建)";
    }
  }

  private parseOutput(
    chapterNumber: number,
    content: string,
  ): WriteChapterOutput {
    const extract = (tag: string): string => {
      const regex = new RegExp(
        `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
      );
      const match = content.match(regex);
      return match?.[1]?.trim() ?? "";
    };

    const chapterContent = extract("CHAPTER_CONTENT");

    return {
      chapterNumber,
      title: extract("CHAPTER_TITLE") || `第${chapterNumber}章`,
      content: chapterContent,
      wordCount: chapterContent.length,
      preWriteCheck: extract("PRE_WRITE_CHECK"),
      postSettlement: extract("POST_SETTLEMENT"),
      updatedState: extract("UPDATED_STATE") || "(状态卡未更新)",
      updatedLedger: extract("UPDATED_LEDGER") || "(账本未更新)",
      updatedHooks: extract("UPDATED_HOOKS") || "(伏笔池未更新)",
    };
  }

  private sanitizeFilename(title: string): string {
    return title
      .replace(/[/\\?%*:|"<>]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 50);
  }
}
