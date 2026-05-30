import { describe, it, expect } from "vitest";
import {
  detectDuplicateTitle,
  detectParagraphLengthDrift,
  detectParagraphShapeWarnings,
  resolveDuplicateTitle,
  validatePreWriteCommitments,
  validatePostWrite,
  type PostWriteViolation,
} from "../agents/post-write-validator.js";
import type { GenreProfile } from "../models/genre-profile.js";

const baseProfile: GenreProfile = {
  id: "test",
  name: "测试",
  language: "zh",
  chapterTypes: [],
  fatigueWords: [],
  pacingRule: "",
  numericalSystem: false,
  powerScaling: false,
  eraResearch: false,
  auditDimensions: [],
  satisfactionTypes: [],
};

function findRule(violations: ReadonlyArray<PostWriteViolation>, rule: string): PostWriteViolation | undefined {
  return violations.find(v => v.rule === rule);
}

describe("validatePostWrite", () => {
  it("returns no violations for clean content", () => {
    const content = "他走过去，端起杯子，灌了一口。外面的雨越下越大。\n\n她站在窗前，看着街上的行人匆匆走过。";
    const result = validatePostWrite(content, baseProfile, null);
    expect(result).toHaveLength(0);
  });

  it("detects '不是…而是…' pattern", () => {
    const content = "这不是勇气，而是愚蠢。他知道这一点。";
    const result = validatePostWrite(content, baseProfile, null);
    expect(findRule(result, "禁止句式")).toBeDefined();
    expect(findRule(result, "禁止句式")!.severity).toBe("warning");
  });

  it("detects dash '——'", () => {
    const content = "他走了过去——然后停下来。";
    const result = validatePostWrite(content, baseProfile, null);
    const violation = findRule(result, "禁止破折号");
    expect(violation).toBeDefined();
    expect(violation!.severity).toBe("warning");
    expect(violation!.issueId).toBe("PW-002");
    expect(violation!.dimensionId).toBe("postwrite.syntax.dash");
  });

  it("skips Chinese-only rules when the book language override is English", () => {
    const content = "He stepped forward——then stopped at the door.";
    const validateWithLanguage = validatePostWrite as (
      content: string,
      genreProfile: GenreProfile,
      bookRules: null,
      languageOverride?: "zh" | "en",
    ) => ReadonlyArray<PostWriteViolation>;

    const result = validateWithLanguage(content, baseProfile, null, "en");

    expect(findRule(result, "禁止破折号")).toBeUndefined();
  });

  it("detects surprise marker density exceeding threshold", () => {
    // ~100 chars total, threshold = max(1, floor(100/3000)) = 1, but we put 3 markers
    const content = "他忽然站起来。仿佛听到了什么声音。竟然是那个人回来了。";
    const result = validatePostWrite(content, baseProfile, null);
    expect(findRule(result, "转折词密度")).toBeDefined();
  });

  it("allows markers within threshold", () => {
    // 3000+ chars with only 1 marker
    const filler = "这是一段很长的正文内容，描述了角色的行动和场景的变化。".repeat(60);
    const content = `${filler}他忽然站起来。${filler}`;
    const result = validatePostWrite(content, baseProfile, null);
    expect(findRule(result, "转折词密度")).toBeUndefined();
  });

  it("detects fatigue words from genre profile", () => {
    const profile = { ...baseProfile, fatigueWords: ["一道目光"] };
    const content = "一道目光扫过来，又一道目光从侧面射来，第三道目光也来了。";
    const result = validatePostWrite(content, profile, null);
    expect(findRule(result, "高疲劳词")).toBeDefined();
  });

  it("detects meta-narration patterns", () => {
    const content = "故事发展到了这里，主角终于做出了选择。他站起来走向门口。";
    const result = validatePostWrite(content, baseProfile, null);
    expect(findRule(result, "元叙事")).toBeDefined();
  });

  it("detects report-style terms in prose", () => {
    const content = "他的核心动机其实很简单，就是想活下去。信息边界在此刻变得模糊。";
    const result = validatePostWrite(content, baseProfile, null);
    const v = findRule(result, "报告术语");
    expect(v).toBeDefined();
    expect(v!.severity).toBe("warning");
    expect(v!.description).toContain("核心动机");
    expect(v!.description).toContain("信息边界");
  });

  it("detects sermon words", () => {
    const content = "显然，对方低估了他的实力。毋庸置疑，这将是一场硬仗。";
    const result = validatePostWrite(content, baseProfile, null);
    const v = findRule(result, "作者说教");
    expect(v).toBeDefined();
    expect(v!.description).toContain("显然");
    expect(v!.description).toContain("毋庸置疑");
  });

  it("detects collective shock patterns", () => {
    const content = "众人齐齐震惊，没有人想到他居然能赢。";
    const result = validatePostWrite(content, baseProfile, null);
    expect(findRule(result, "集体反应")).toBeDefined();
  });

  it("detects consecutive '了' sentences", () => {
    const content = "他走了过去。他拿了杯子。他喝了一口。他放了下来。他转了身。他叹了口气。他摇了摇头。";
    const result = validatePostWrite(content, baseProfile, null);
    const v = findRule(result, "连续了字");
    expect(v).toBeDefined();
    expect(v!.severity).toBe("warning");
  });

  it("detects overly long paragraphs", () => {
    const longPara = "这是一段非常长的段落。".repeat(30); // ~300+ chars
    const content = `${longPara}\n\n${longPara}\n\n短段落。`;
    const result = validatePostWrite(content, baseProfile, null);
    expect(findRule(result, "段落过长")).toBeDefined();
  });

  it("detects fragmented short paragraphs in Chinese prose", () => {
    const content = [
      "门开了。",
      "他没进去。",
      "先听了一下。",
      "里面没有声响。",
      "他才把手按上去。",
      "冷意顺着门缝钻出来。",
    ].join("\n\n");

    const result = validatePostWrite(content, baseProfile, null);
    expect(findRule(result, "段落过碎")).toBeDefined();
    expect(findRule(result, "段落过碎")?.severity).toBe("warning");
  });

  it("warns when Chinese dialogue quote styles are mixed in one chapter", () => {
    const content = [
      "「先走。」男人把门拉开。",
      "“你别回头。”女人低声说。",
      "「楼梯口有人。」他又补了一句。",
      "“我知道。”她点头。",
    ].join("\n\n");

    const result = validatePostWrite(content, baseProfile, null);
    expect(findRule(result, "对话引号风格混用")).toBeDefined();
  });

  it("enforces force_double dialogue policy as error when corner quotes appear", () => {
    const bookRules = {
      version: "1",
      protagonist: { name: "张三", personalityLock: [], behavioralConstraints: [] },
      prohibitions: [],
      genreLock: { primary: "xuanhuan" as const, forbidden: [] },
      chapterTypesOverride: [],
      fatigueWordsOverride: [],
      additionalAuditDimensions: [],
      enableFullCastTracking: false,
      allowedDeviations: [],
      dialogueQuotePolicy: {
        mode: "force_double" as const,
        strict: false,
        autoNormalize: false,
      },
    };
    const content = [
      "「先走。」男人把门拉开。",
      "“你别回头。”女人低声说。",
    ].join("\n\n");

    const result = validatePostWrite(content, baseProfile, bookRules);
    const v = findRule(result, "对话引号强约束");
    expect(v).toBeDefined();
    expect(v?.severity).toBe("error");
  });

  it("enforces strict force_double policy against unquoted speaker-colon dialogue", () => {
    const bookRules = {
      version: "1",
      protagonist: { name: "张三", personalityLock: [], behavioralConstraints: [] },
      prohibitions: [],
      genreLock: { primary: "xuanhuan" as const, forbidden: [] },
      chapterTypesOverride: [],
      fatigueWordsOverride: [],
      additionalAuditDimensions: [],
      enableFullCastTracking: false,
      allowedDeviations: [],
      dialogueQuotePolicy: {
        mode: "force_double" as const,
        strict: true,
        autoNormalize: false,
      },
    };
    const content = [
      "男人：先走。",
      "女人：后门锁了。",
      "男人：不要停。",
      "女人：楼下有人。",
      "男人：跟紧我。",
      "女人：别回头。",
    ].join("\n");

    const result = validatePostWrite(content, baseProfile, bookRules);
    const v = findRule(result, "对话引号强约束");
    expect(v).toBeDefined();
    expect(v?.severity).toBe("error");
  });

  it("treats auto policy as strict double-quote enforcement when autoNormalize is enabled", () => {
    const bookRules = {
      version: "1",
      protagonist: { name: "张三", personalityLock: [], behavioralConstraints: [] },
      prohibitions: [],
      genreLock: { primary: "xuanhuan" as const, forbidden: [] },
      chapterTypesOverride: [],
      fatigueWordsOverride: [],
      additionalAuditDimensions: [],
      enableFullCastTracking: false,
      allowedDeviations: [],
      dialogueQuotePolicy: {
        mode: "auto" as const,
        strict: true,
        autoNormalize: true,
      },
    };
    const content = [
      "「先走。」男人把门拉开。",
      "“你别回头。”女人低声说。",
    ].join("\n\n");

    const result = validatePostWrite(content, baseProfile, bookRules);
    const v = findRule(result, "对话引号强约束");
    expect(v).toBeDefined();
    expect(v?.severity).toBe("error");
  });

  it("warns when most speaker-colon dialogue lines are unquoted", () => {
    const content = [
      "男人：先走。",
      "女人：后门锁了。",
      "男人：不要停。",
      "女人：楼下有人。",
      "男人：跟紧我。",
      "女人：别回头。",
    ].join("\n");

    const result = validatePostWrite(content, baseProfile, null);
    expect(findRule(result, "对话未标引号")).toBeDefined();
  });

  it("detects runs of consecutive short paragraphs", () => {
    const content = [
      "他绕过柜台，把灯挪到门边，先看了一眼地上的水印，确认脚印是新的。",
      "门虚掩着。",
      "风从外面钻进来。",
      "他没有立刻追出去。",
      "他先低头，看见门槛上沾了一点灰黑色的泥。",
    ].join("\n\n");

    const result = validatePostWrite(content, baseProfile, null);
    expect(findRule(result, "连续短段")).toBeDefined();
    expect(findRule(result, "连续短段")?.severity).toBe("warning");
  });

  it("detects book-level prohibitions", () => {
    const bookRules = {
      version: "1",
      protagonist: { name: "张三", personalityLock: [], behavioralConstraints: [] },
      prohibitions: ["跪舔"],
      genreLock: { primary: "xuanhuan" as const, forbidden: [] },
      chapterTypesOverride: [],
      fatigueWordsOverride: [],
      additionalAuditDimensions: [],
      enableFullCastTracking: false,
      allowedDeviations: [],
    };
    const content = "他一脸跪舔的样子让人恶心。";
    const result = validatePostWrite(content, baseProfile, bookRules);
    expect(findRule(result, "本书禁忌")).toBeDefined();
  });

  it("does not flag allowed content", () => {
    // Content that is clean across all rules
    const content = `他站起来，环顾四周。窗外的月光洒在地板上，像一层薄薄的霜。\n\n\u201c走吧。\u201d她转身推开门。冷风从缝隙里钻进来，她裹紧了衣服。`;
    const result = validatePostWrite(content, baseProfile, null);
    expect(result).toHaveLength(0);
  });

  it("warns when an English multi-character scene has almost no direct exchange", () => {
    const content = [
      "Mara cornered Taryn in the archive and kept the ledger between them.",
      "Mara demanded a clear answer about the missing page while Taryn refused to meet her eyes.",
      "Taryn stepped back toward the window and Mara followed without letting the pressure break.",
    ].join(" ");

    const result = validatePostWrite(content, baseProfile, null, "en");
    expect(findRule(result, "Dialogue pressure")).toBeDefined();
    expect(findRule(result, "Dialogue pressure")?.severity).toBe("warning");
  });

  it("detects paragraph density drift against recent chapters", () => {
    const recent = [
      "他把伞挂在门边，又低头看了一眼鞋底带进来的泥。柜台后的热水壶正轻轻作响，白气沿着玻璃慢慢爬上去。林越没有急着开口，只先把屋里的灯都扫了一遍，确认少了一盏。",
      "",
      "姜敏把账本推过来时，手指还压在封皮边上，没有立刻松开。她先问他是不是又去找过旧港的人，然后才把下午听到的消息一点点拆开说，连谁在门口停过脚都没漏掉。",
      "",
      "---",
      "",
      "他靠着墙站了半分钟，才把那张折过三次的纸重新摊开。纸上的字不多，但每一行都像故意留了半截，逼着他把前后几天听到的话重新拼回去。",
      "",
      "外面的雨势已经压下来，棚顶被打得一阵紧一阵。林越没有马上下楼，而是先把窗推开一条缝，让冷风吹进来，把刚才在屋里积住的闷气慢慢散掉。",
    ].join("\n\n");
    const current = [
      "他停下。",
      "先看门。",
      "又看窗。",
      "没人说话。",
      "他这才进去。",
      "屋里很冷。",
    ].join("\n\n");

    const result = detectParagraphLengthDrift(current, recent, "zh");
    expect(findRule(result, "段落密度漂移")).toBeDefined();
    expect(findRule(result, "段落密度漂移")?.severity).toBe("warning");
    expect(findRule(result, "段落密度漂移")?.issueId).toBe("PW-019");
  });

  it("exposes paragraph shape warnings for final-stage reuse", () => {
    const current = [
      "他停下。",
      "先看门。",
      "又看窗。",
      "没人说话。",
      "他这才进去。",
      "屋里很冷。",
    ].join("\n\n");

    const result = detectParagraphShapeWarnings(current, "zh");
    expect(findRule(result, "段落过碎")).toBeDefined();
    expect(findRule(result, "连续短段")).toBeDefined();
  });

  it("detects duplicate chapter titles", () => {
    const result = detectDuplicateTitle("回声", ["旧路", "回声"]);
    expect(findRule(result, "duplicate-title")).toBeDefined();
  });

  it("detects near-duplicate chapter titles", () => {
    const result = detectDuplicateTitle("Echo-2", ["Echo 2"]);
    expect(findRule(result, "near-duplicate-title")).toBeDefined();
  });

  it("prefers regenerating a duplicate title from chapter content before numeric suffix fallback", () => {
    const result = resolveDuplicateTitle(
      "回声",
      ["旧路", "回声"],
      "zh",
      {
        content: "塔楼里的铜铃只响了一声，风从缺口灌进来，守夜人没有回头。",
      },
    );

    expect(result.title).toContain("塔楼");
    expect(result.title).not.toBe("回声（2）");
  });

  it("regenerates a title when it continues a collapsed recent title shell", () => {
    const result = resolveDuplicateTitle(
      "名单未落",
      ["名单之前", "名单之后", "名单还在"],
      "zh",
      {
        content: "塔楼里的铜铃只响了一声，守夜人没有回头，风从缺口灌进来。",
      },
    );

    expect(result.issues.some((issue) => issue.rule === "title-collapse")).toBe(true);
    expect(result.title).not.toContain("名单");
    expect(result.title).toContain("塔楼");
  });
});

describe("validatePreWriteCommitments", () => {
  it("accepts real hook ids from the pending hook pool", () => {
    const preWriteCheck = [
      "=== PRE_WRITE_CHECK ===",
      "| 检查项 | 本章记录 | 备注 |",
      "|--------|----------|------|",
      "| 待回收伏笔 | 001-旧怀表, relationship-病弱少年的身份与命运-名字被遗忘 | ok |",
    ].join("\n");

    const pendingHooks = [
      "# Pending Hooks",
      "",
      "| hook_id | start_chapter | type | status | last_advanced | expected_payoff | notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| 001-旧怀表 | 1 | mystery | open | 1 | 旧怀表的线索继续回响 | 旧怀表会牵出更大的真相 |",
      "| relationship-病弱少年的身份与命运-名字被遗忘 | 3 | relationship | open | 3 | 名字被遗忘的身份线继续推进 | 身份与命运继续拉扯 |",
    ].join("\n");

    const violations = validatePreWriteCommitments(
      preWriteCheck,
      "正文只写情节，不写 hook_id。",
      "zh",
      pendingHooks,
    );

    expect(violations).toEqual([]);
  });

  it("flags rows that contain descriptions or ids outside the pending hook pool", () => {
    const preWriteCheck = [
      "=== PRE_WRITE_CHECK ===",
      "| 检查项 | 本章记录 | 备注 |",
      "|--------|----------|------|",
      "| 待回收伏笔 | 001-旧怀表, 父亲之死真相, 019-黑风老怪约见 | ok |",
    ].join("\n");

    const pendingHooks = [
      "# Pending Hooks",
      "",
      "| hook_id | start_chapter | type | status | last_advanced | expected_payoff | notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| 001-旧怀表 | 1 | mystery | open | 1 | 旧怀表的线索继续回响 | 旧怀表会牵出更大的真相 |",
    ].join("\n");

    const violations = validatePreWriteCommitments(
      preWriteCheck,
      "正文只写情节，不写 hook_id。",
      "zh",
      pendingHooks,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("prewrite-hook-missing");
    expect(violations[0]!.description).toContain("父亲之死真相");
    expect(violations[0]!.description).toContain("019-黑风老怪约见");
  });

  it("flags rows without any real hook ids", () => {
    const preWriteCheck = [
      "=== PRE_WRITE_CHECK ===",
      "| 检查项 | 本章记录 | 备注 |",
      "|--------|----------|------|",
      "| 待回收伏笔 | 父亲之死真相 | ok |",
    ].join("\n");

    const pendingHooks = [
      "# Pending Hooks",
      "",
      "| hook_id | start_chapter | type | status | last_advanced | expected_payoff | notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| 001-旧怀表 | 1 | mystery | open | 1 | 旧怀表的线索继续回响 | 旧怀表会牵出更大的真相 |",
    ].join("\n");

    const violations = validatePreWriteCommitments(
      preWriteCheck,
      "正文只写情节，不写 hook_id。",
      "zh",
      pendingHooks,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("prewrite-hook-ids");
  });
});
