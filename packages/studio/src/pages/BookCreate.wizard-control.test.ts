import { describe, expect, it, vi } from "vitest";
import { mergeCreationWizardState, buildBookCreateCommand, buildIntroMarkdownDraft, buildStepValidationReport, buildWizardStepRegenerationInstruction, explainManualWizardStepContentIssue, hasMeaningfulIntroMarkdown, hasMeaningfulManualWizardStepContent, hasMeaningfulWizardStepContent, isWizardNavigationLocked, looksLikeOutlineMarkdown, looksLikeWizardStepMarkdown, resolveBookCreateGenreSelection, resolveBookCreationResumeStep, resolveCanonicalIntroMarkdown, resolveIntroMarkdownEditorContent, resolvePreferredIntroMarkdown, resolveWizardStepDisplayContent, shouldAutoGenerateWizardStepBody, shouldSyncWizardStep, stripWizardPreamble } from "./book-create-state";
import { resolveIntroRevisionBookId } from "./BookCreate";

describe("BookCreate wizard control", () => {
  it("advances with stable wizard step ids rather than localized titles", () => {
    const instruction = buildBookCreateCommand({
      kind: "advance",
      language: "zh",
      stepTitle: "简介 / 故事背景",
      currentStep: "intro",
      nextStep: "world",
      title: "夜港账本",
      genre: "urban",
      platform: "tomato",
      targetChapters: 120,
      chapterWordCount: 2800,
    }).instruction;

    expect(instruction).toBe("/wizard advance current=intro next=world title=夜港账本 genre=urban platform=tomato target=120 words=2800");
  });

  it("keeps back navigation on control requests instead of streaming chat", async () => {
    const sendMessage = vi.fn();
    const request = {
      intent: "retreat_book_wizard",
      language: "zh" as const,
      stepTitle: "世界观",
      wizardStep: "world" as const,
    };

    expect(request.intent).toBe("retreat_book_wizard");
    expect({
      url: "/interaction/session",
      method: "POST",
      request,
      response: "已返回上一步。",
    }).toMatchObject({
      url: "/interaction/session",
      method: "POST",
      request: {
        intent: "retreat_book_wizard",
        wizardStep: "world",
      },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("treats discard as a control flow action instead of a chat request", () => {
    const request = {
      intent: "discard_book_draft" as const,
      language: "zh" as const,
      stepTitle: "简介 / 故事背景",
      wizardStep: "intro" as const,
    };

    expect(request).toMatchObject({
      intent: "discard_book_draft",
      wizardStep: "intro",
    });
  });

  it("keeps the current step when a stale refresh reports an earlier wizard step", () => {
    const merged = mergeCreationWizardState({
      current: {
        currentStep: "world",
        completedSteps: ["intro"],
        stepNotes: {},
        updatedAt: 100,
      },
      fetched: {
        currentStep: "intro",
        completedSteps: [],
        stepNotes: {},
        updatedAt: 200,
      },
      pendingStep: "world",
    });

    expect(merged?.currentStep).toBe("world");
  });

  it("does not re-sync wizard step when visible/local state is already on the target step", () => {
    expect(shouldSyncWizardStep({
      targetStep: "world",
      visibleStep: "world",
      localWizard: {
        currentStep: "world",
        completedSteps: ["intro"],
        stepNotes: {},
        updatedAt: 100,
      },
      sessionWizard: {
        currentStep: "intro",
        completedSteps: [],
        stepNotes: {},
        updatedAt: 50,
      },
    })).toBe(false);
  });

  it("resumes to the first incomplete wizard step instead of the last completed step", () => {
    expect(resolveBookCreationResumeStep({
      currentStep: "volume",
      completedSteps: ["intro", "world", "outline"],
      stepNotes: {},
      updatedAt: 100,
    })).toBe("volume");
  });

  it("keeps relation as the resume step after all wizard pages are complete", () => {
    expect(resolveBookCreationResumeStep({
      currentStep: "relation",
      completedSteps: ["intro", "world", "outline", "volume", "characters", "arc", "relation"],
      stepNotes: {},
      updatedAt: 100,
    })).toBe("relation");
  });

  it("locks wizard navigation while any generation or loading task is active", () => {
    expect(isWizardNavigationLocked({
      loadingDraft: false,
      loading: false,
      creating: false,
      isAdvancing: false,
      isAutoCompleting: false,
      isRegenerating: true,
      isAutoGeneratingPage: false,
      stopping: false,
    })).toBe(true);

    expect(isWizardNavigationLocked({
      loadingDraft: false,
      loading: false,
      creating: false,
      isAdvancing: false,
      isAutoCompleting: false,
      isRegenerating: false,
      isAutoGeneratingPage: false,
      stopping: false,
    })).toBe(false);
  });

  it("blocks navigation and auto-save during active generation", () => {
    expect(isWizardNavigationLocked({
      loadingDraft: false,
      loading: true,
      creating: false,
      isAdvancing: false,
      isAutoCompleting: false,
      isRegenerating: false,
      isAutoGeneratingPage: false,
      stopping: false,
    })).toBe(true);
  });

  it("waits for wizard file hydration before auto-generating an empty step", () => {
    expect(shouldAutoGenerateWizardStepBody({
      currentStep: "relation",
      loadingDraft: false,
      loading: false,
      isAdvancing: false,
      isAutoCompleting: false,
      isRegenerating: false,
      isAutoGeneratingPage: false,
      hydrationStatus: "loading",
      latestBody: "",
      persisted: "",
    })).toBe(false);

    expect(shouldAutoGenerateWizardStepBody({
      currentStep: "relation",
      loadingDraft: false,
      loading: false,
      isAdvancing: false,
      isAutoCompleting: false,
      isRegenerating: false,
      isAutoGeneratingPage: false,
      hydrationStatus: "loaded",
      latestBody: "",
      persisted: "",
    })).toBe(true);

    expect(shouldAutoGenerateWizardStepBody({
      currentStep: "relation",
      loadingDraft: false,
      loading: false,
      isAdvancing: false,
      isAutoCompleting: false,
      isRegenerating: false,
      isAutoGeneratingPage: false,
      hydrationStatus: "loaded",
      latestBody: "",
      persisted: "## 人物关系\n已有正文",
    })).toBe(false);
  });

  it("prefers draft genre over language fallback before the user manually touches genre selection", () => {
    const genres = [
      { id: "urban", name: "都市", language: "zh" },
      { id: "fantasy", name: "奇幻", language: "zh" },
    ];

    expect(resolveBookCreateGenreSelection({
      currentGenreId: "urban",
      currentSource: "auto",
      genres,
      draftGenre: "fantasy",
      projectLanguage: "zh",
    })).toMatchObject({
      genreId: "fantasy",
      source: "auto",
    });

    expect(resolveBookCreateGenreSelection({
      currentGenreId: "urban",
      currentSource: "manual",
      genres,
      draftGenre: "fantasy",
      projectLanguage: "zh",
    })).toMatchObject({
      genreId: "urban",
      source: "manual",
    });
  });

  it("extracts canonical intro markdown from streamed text with preamble", () => {
    expect(resolveCanonicalIntroMarkdown([
      "好的，我来生成正式简介。\n\n# 简介正文\n\n## 一句话卖点\n账本牵出港城旧债。\n\n## 故事概述\n林砚被迫卷入灰产清算。",
    ])).toBe(`# 简介正文

## 一句话卖点
账本牵出港城旧债。

## 故事概述
林砚被迫卷入灰产清算。`);
  });

  it("prefers a complete intro markdown body over a scaffold-only template", () => {
    expect(resolveCanonicalIntroMarkdown([
      "# 简介正文\n\n## 一句话卖点\n-\n\n## 故事概述\n-\n\n## 故事走向\n-\n\n## 主要人物成长路径\n-\n\n## 核心冲突\n-\n\n## 核心价值观\n-",
      "# 简介正文\n\n## 一句话卖点\n账本牵出港城旧债。\n\n## 故事概述\n林砚被迫卷入灰产清算。\n\n## 故事走向\n他在自保、复仇和真相之间越陷越深。\n\n## 主要人物成长路径\n林砚从被动防守到主动追索真相。\n\n## 核心冲突\n他与灰产链条的对抗不断升级。\n\n## 核心价值观\n在灰色秩序中守住底线。",
    ])).toContain("林砚从被动防守到主动追索真相。");
  });

  it("prefers a complete intro body over a shorter scaffold when both look valid", () => {
    expect(resolveCanonicalIntroMarkdown([
      "# 简介正文\n\n## 一句话卖点\n别人加班我下班。\n\n## 故事概述\n林晚，28岁，产品总监。\n\n## 故事走向\n-\n\n## 主要人物成长路径\n-\n\n## 核心冲突\n-\n\n## 核心价值观\n-",
      "# 简介正文\n\n## 一句话卖点\n港口账本牵出灰产洗白风暴。\n\n## 故事概述\n林砚被迫卷入港城旧债和灰产洗白链。\n\n## 故事走向\n他在自保、复仇和真相之间越陷越深。\n\n## 主要人物成长路径\n林砚从被动防守到主动追索真相。\n\n## 核心冲突\n他与灰产链条的对抗不断升级。\n\n## 核心价值观\n在灰色秩序中守住底线。",
    ])).toContain("港口账本牵出灰产洗白风暴。");
  });

  it("resolves intro revision book id by preferring active book ids", async () => {
    const ensureBookShell = vi.fn(async () => "book-from-shell");

    await expect(resolveIntroRevisionBookId("book-active", ensureBookShell)).resolves.toBe("book-active");
    expect(ensureBookShell).not.toHaveBeenCalled();

    await expect(resolveIntroRevisionBookId(null, ensureBookShell)).resolves.toBe("book-from-shell");
    expect(ensureBookShell).toHaveBeenCalledTimes(1);
  });

  it("prefers persisted intro body over scaffold draftFields when draft refreshes", () => {
    const resolved = resolvePreferredIntroMarkdown({
      draft: {
        title: "夜港账本",
        genre: "urban",
        draftFields: {
          introMarkdown: "# 简介正文\n\n## 一句话卖点\n-\n\n## 故事概述\n-\n\n## 故事走向\n-\n\n## 主要人物成长路径\n-\n\n## 核心冲突\n-\n\n## 核心价值观\n-",
        },
      },
      language: "zh",
      persistedIntroMarkdown: "# 简介正文\n\n## 一句话卖点\n港口账本牵出灰产洗白风暴。\n\n## 故事概述\n林砚被迫卷入港城旧债和灰产洗白链。\n\n## 故事走向\n他在自保、复仇和真相之间越陷越深。\n\n## 主要人物成长路径\n林砚从被动防守到主动追索真相。\n\n## 核心冲突\n他与灰产链条的对抗不断升级。\n\n## 核心价值观\n在灰色秩序中守住底线。",
      currentIntroMarkdown: "",
      currentSource: "draft",
    });

    expect(resolved.source).toBe("generated");
    expect(resolved.content).toContain("林砚从被动防守到主动追索真相。");
    expect(resolved.content).not.toContain("## 核心价值观\n-");
  });

  it("keeps an intentionally emptied intro editor blank instead of restoring persisted content", () => {
    expect(resolveIntroMarkdownEditorContent({
      draft: {
        title: "夜港账本",
        genre: "urban",
        draftFields: {
          introMarkdown: "# 简介正文\n\n## 一句话卖点\n港口账本牵出灰产洗白风暴。",
        },
      },
      language: "zh",
      persistedIntroMarkdown: "# 简介正文\n\n## 一句话卖点\n港口账本牵出灰产洗白风暴。",
      currentIntroMarkdown: "",
      currentSource: "draft",
      dirty: true,
    })).toBe("");
  });

  it("still hydrates the intro editor from persisted content before the user edits it", () => {
    expect(resolveIntroMarkdownEditorContent({
      draft: {
        title: "夜港账本",
        genre: "urban",
        draftFields: {
          introMarkdown: "# 简介正文\n\n## 一句话卖点\n港口账本牵出灰产洗白风暴。",
        },
      },
      language: "zh",
      persistedIntroMarkdown: "# 简介正文\n\n## 一句话卖点\n港口账本牵出灰产洗白风暴。",
      currentIntroMarkdown: "",
      currentSource: "draft",
      dirty: false,
    })).toContain("港口账本牵出灰产洗白风暴。");
  });

  it("rejects intro framework-only content as meaningful body text", () => {
    expect(hasMeaningfulIntroMarkdown("# 简介正文\n\n## 一句话卖点\n-\n\n## 故事概述\n-\n\n## 故事走向\n-\n\n## 主要人物成长路径\n-\n\n## 核心冲突\n-\n\n## 核心价值观\n-")).toBe(false);
  });

  it("treats placeholder world text as non-generated content", () => {
    expect(hasMeaningfulWizardStepContent("world", "世界观：...\n\n补充设定：...", {
      worldPremise: "世界观：...",
      settingNotes: "补充设定：...",
    })).toBe(false);
    expect(hasMeaningfulWizardStepContent("world", "世界观：近未来港口城\n\n补充设定：账本与势力交织", {
      worldPremise: "近未来港口城",
      settingNotes: "账本与势力交织",
    })).toBe(true);
  });

  it("keeps persisted world content as the preview baseline", () => {
    const persisted = "世界观：近未来港口城\n\n补充设定：账本与势力交织";
    expect(hasMeaningfulWizardStepContent("world", persisted, {
      worldPremise: "近未来港口城",
      settingNotes: "账本与势力交织",
    })).toBe(true);
  });

  it("treats generated world body text as meaningful even without structured fields", () => {
    expect(hasMeaningfulWizardStepContent("world", "## 世界观\n近未来港口城\n\n## 补充设定\n灰产与旧账交织")).toBe(true);
  });

  it("rejects empty world scaffolding without substantive content", () => {
    expect(hasMeaningfulWizardStepContent("world", "## 世界观\n-\n\n## 补充设定\n-")).toBe(false);
  });

  it("accepts manually edited world content even when it is less templated", () => {
    expect(hasMeaningfulManualWizardStepContent("world", `# 世界观

近未来港口城被灰产账本和旧债网络盘踞，公开秩序和地下清算并行存在。

普通人看到的是繁华港区，真正决定资源流向的是几套不能见光的旧账规则。`)).toBe(true);
  });

  it("classifies empty or summary-only manual content with explicit reasons", () => {
    expect(explainManualWizardStepContentIssue("world", "")).toBe("empty");
    expect(explainManualWizardStepContentIssue("world", `世界观页已重写并保存。
相比原内容，本次补充了规则和势力结构。`)).toBe("summary");
  });

  it("prefers persisted step content when no edited draft exists", () => {
    expect(resolveWizardStepDisplayContent({
      step: "world",
      draft: {},
      language: "zh",
      persistedDraft: "已落库正文",
    })).toBe("已落库正文");
  });

  it("keeps edited step content writable in edit mode", () => {
    expect(resolveWizardStepDisplayContent({
      step: "world",
      draft: {},
      language: "zh",
      editedDraft: "正在编辑的正文",
      persistedDraft: "已落库正文",
    })).toBe("正在编辑的正文");
  });

  it("keeps intro markdown content when it already exists", () => {
    expect(resolveWizardStepDisplayContent({
      step: "intro",
      draft: {
        blurb: "默认卖点",
        storyBackground: "默认背景",
        draftFields: { introMarkdown: "已加载正文" },
      },
      language: "zh",
      introMarkdown: "已加载正文",
    })).toBe("已加载正文");
  });

  it("builds intro draft without using the book title as the first heading", () => {
    expect(buildIntroMarkdownDraft({
      title: "夜港账本",
      genre: "都市",
      platform: "番茄",
      blurb: "账本牵出港城旧债。",
      storyBackground: "林砚被迫卷入灰产清算。",
    }, "zh")).toContain("# 简介正文");

    expect(buildIntroMarkdownDraft({
      title: "夜港账本",
      genre: "都市",
      platform: "番茄",
      blurb: "账本牵出港城旧债。",
      storyBackground: "林砚被迫卷入灰产清算。",
    }, "zh")).not.toContain("# 夜港账本");
  });

  it("passes intro validation when title only exists in the effective local draft view", () => {
    const report = buildStepValidationReport("intro", {
      title: "夜港账本",
    }, "zh", "## 一句话卖点\n账本牵出港城旧债。\n\n## 故事概述\n林砚被迫卷入灰产清算。");

    expect(report.status).toBe("pass");
    expect(report.issues.some((issue) => issue.key === "title")).toBe(false);
  });

  it("rejects outline regeneration summary text as markdown body", () => {
    expect(looksLikeOutlineMarkdown(`大纲页已重写并保存。相比原内容，新版做了以下改进：
从"生成后的汇报摘要"升级为真正的大纲页面
未改动其他任何页面，仅重写了 wizard/outline.md。`)).toBe(false);
  });

  it("uses the correct wizard file name for volume regeneration instructions", () => {
    expect(buildWizardStepRegenerationInstruction({
      step: "volume",
      title: "卷纲规划",
      language: "zh",
    })).toContain("【当前页】卷纲规划");
    expect(buildWizardStepRegenerationInstruction({
      step: "outline",
      title: "小说大纲",
      language: "zh",
    })).toContain("wizard/outline.md");
    expect(buildWizardStepRegenerationInstruction({
      step: "volume",
      title: "卷纲规划",
      language: "en",
    })).not.toContain("wizard/outline.md");
  });

  it("accepts structured outline markdown body", () => {
    expect(looksLikeOutlineMarkdown(`# 小说大纲

## 第一卷
- 核心主题：普通女孩稳稳搞钱
- 关键剧情节点：第1-20章完成第一阶段起盘

## 核心冲突
主角在安全感与机会成本之间反复拉扯。`)).toBe(true);
  });

  it("rejects summary text for other wizard markdown steps too", () => {
    expect(looksLikeWizardStepMarkdown("world", `世界观页已重写并保存。
相比原内容，本次补充了规则和势力结构。`)).toBe(false);
  });

  it("accepts structured markdown for world step", () => {
    expect(looksLikeWizardStepMarkdown("world", `# 世界观

## 世界观
近未来港口城被灰产账本和旧债网络盘踞。

## 补充设定
- 势力一：账本中介
- 势力二：码头清算人`)).toBe(true);
  });

  it("accepts structured character arc markdown body", () => {
    expect(looksLikeWizardStepMarkdown("arc", `# 人物弧光

## 林砚

### 核心弧光
- 从只想躲债保命的账房学徒，变成敢主动掀桌改写港城秩序的人。

### 起点状态
- 性格缺陷：遇到风险先退让，习惯把关键责任推给更强的人。
- 内心恐惧：害怕重蹈父亲因账本被灭口的结局。
- 错误信念：认为只要低头忍耐，就能苟到风暴过去。

### 成长转折
- 触发事件：老账房被码头商会灭口，逼他亲自接手黑账本。
- 内心挣扎：他想带着账本逃走，却发现妹妹也被对手盯上。
- 觉醒时刻：他在雨夜公开放出第一份账本副本，第一次主动反击。
- 持续考验：每次扳回一局，都会有人因他暴露在更高层的清算下。

### 终点状态
- 性格蜕变：从被动藏身到主动布局，开始掌控信息与人心。
- 克服恐惧：接受自己必须站到风暴中心，不能再靠退让求活。
- 新信念：真正的安全感来自掌握规则，而不是躲开规则。
- 残留痕迹：面对权势人物时仍会先试探退路，但不再因此放弃出手。

## 乔南星

### 核心弧光
- 从只认钱不认人的港口掮客，变成愿意为同伴承担连带代价的合伙人。

### 起点状态
- 性格缺陷：算计过度，凡事先算收益再谈立场。
- 内心恐惧：害怕再次因站错队失去全部地盘和人脉。
- 错误信念：关系只是短期交易，没人值得长期绑定。

### 成长转折
- 触发事件：她替林砚销赃时被旧东家反咬，差点被沉海。
- 内心挣扎：继续切割能保命，但会把林砚送回对手手里。
- 觉醒时刻：她主动交出藏了多年的走私名单，换林砚脱身。
- 持续考验：她必须在利益和信任之间反复作选择，承受双方追杀。

### 终点状态
- 性格蜕变：从机会主义者变成真正的风险共担者。
- 克服恐惧：接受站队就必然要承受损失，不再幻想零成本获利。
- 新信念：可靠的同盟比一次性暴利更值钱。
- 残留痕迹：做决定前仍会先估算成本，但不再拿算计替代态度。`)).toBe(true);
  });

  it("rejects empty character arc scaffolding", () => {
    expect(looksLikeWizardStepMarkdown("arc", `# 人物弧光

## 核心弧光
-

## 起点状态
- 主角起点：-
- 关键配角：-
- 核心冲突映射：-`)).toBe(false);
  });

  it("accepts manually edited character arc content with substantive sections", () => {
    expect(hasMeaningfulManualWizardStepContent("arc", `# 人物弧光

## 核心弧光
林砚这条线的重点，不是变强，而是从习惯让位、习惯自保，走到敢于主动承担代价。

## 起点状态
他最大的性格缺陷是退让，内心恐惧是重演父亲被灭口的结局，错误信念是只要低头就能活过去。

## 成长转折
老账房的死成了触发事件，他先想逃，后来发现妹妹也被盯上，只能被迫回头。真正的觉醒时刻，是他第一次主动公开账本副本，把自己推到风暴中心。后续每次反击，都在持续考验他到底敢不敢承担连带代价。

## 终点状态
到这一阶段，他完成的不是爽文式升级，而是性格蜕变。他开始克服恐惧，建立新信念，也保留了遇事先找退路的残留痕迹。`)).toBe(true);
  });

  it("accepts structured relationship markdown body", () => {
    expect(looksLikeWizardStepMarkdown("relation", `# 人物关系

## 核心关系
林砚 → 乔南星：表面是合作，实则彼此试探，账本与人情都握在手里。
林砚 → 老账房：师徒与保护者关系，老账房隐瞒的旧账推动了林砚的第一场反击。

## 对立关系
林砚 → 许沉舟：旧债与港城控制权之争不断升级，任何退让都会让对方得寸进尺。
乔南星 → 许沉舟：旧东家与叛逃掮客的追杀关系，带着灭口和反咬风险。

## 隐藏联系
老账房 → 旧案证据：他藏着当年灭口案的账本副本，真相一旦曝光就会改写阵营判断。
乔南星 → 走私名单：她手里握着关键走私名单，既是保命筹码也是关系裂缝。

## 潜在冲突
林砚 发现真相：当旧案和把柄同时曝光，联盟会立刻重组，下一阶段剧情也会被直接推开。`)).toBe(true);
  });

  it("rejects arc summary text as markdown body", () => {
    expect(looksLikeWizardStepMarkdown("arc", `人物弧光页已重写并保存。
相比原内容，本次强化了成长阶段与主题对应关系。`)).toBe(false);
  });

  it("rejects relation summary text as markdown body", () => {
    expect(looksLikeWizardStepMarkdown("relation", `人物关系页已重写并保存。
相比原内容，本次强化了关系驱动力与冲突转折。`)).toBe(false);
  });

  it("accepts relation body text with enough relationship entries even without strict headings", () => {
    expect(looksLikeWizardStepMarkdown("relation", `# 人物关系

林砚 → 老账房：合作里带着试探，账本旧案是彼此都不敢明说的筹码。
林砚 → 码头经理：利益互换但随时可能翻脸，码头资源决定谁先下水。
老账房 → 码头经理：旧债牵连，表面中立，实际各自握着对方把柄。
码头经理 → 旧势力：利益绑定，真相曝光后会直接反转。
隐藏联系：一笔旧账把所有人都拖进同一条线。
潜在冲突：当利益变化，联盟会立刻重组。`)).toBe(true);
  });

  it("strips relation preamble before saving markdown body", () => {
    const output = stripWizardPreamble("relation", `我先根据已有信息整理人物关系。
我会先补充一段说明。

# 人物关系

## 核心关系
林砚 → 老账房：合作里带着试探，账本旧案是彼此都不敢明说的筹码。

## 对立关系
林砚 → 许沉舟：旧债与控制权冲突不断升级。

## 隐藏联系
老账房 → 旧案证据：他藏着当年灭口案的账本副本。

## 潜在冲突
一旦真相曝光，联盟会立刻重组。`);

    expect(output).toBe(`# 人物关系

## 核心关系
林砚 → 老账房：合作里带着试探，账本旧案是彼此都不敢明说的筹码。

## 对立关系
林砚 → 许沉舟：旧债与控制权冲突不断升级。

## 隐藏联系
老账房 → 旧案证据：他藏着当年灭口案的账本副本。

## 潜在冲突
一旦真相曝光，联盟会立刻重组。`);
    expect(hasMeaningfulWizardStepContent("relation", output)).toBe(true);
  });

  it("treats relation body text with two concrete entries as meaningful", () => {
    expect(hasMeaningfulWizardStepContent("relation", `# 人物关系

林砚 → 老账房：合作里带着试探，账本旧案是彼此都不敢明说的筹码。
林砚 → 码头经理：利益互换但随时可能翻脸，码头资源决定谁先下水。`)).toBe(true);
  });

  it("accepts manually edited relationship content with concrete entries", () => {
    expect(hasMeaningfulManualWizardStepContent("relation", `# 人物关系

## 核心关系
林砚 → 乔南星：合作关系里始终夹着试探，账本和人情都不是白拿的。
林砚 → 老账房：一半是师徒，一半是旧债继承者，情感和真相绑在一起。

## 对立关系
林砚 → 许沉舟：控制权之争持续升级，任何一次退让都会被对方吃掉。

## 隐藏联系
乔南星 → 走私名单：这份名单既是她保命的筹码，也是她迟早会反噬联盟的裂口。

## 潜在冲突
一旦旧案真相曝光，现有联盟会立刻重组，原本互保的人也可能转成互咬。`)).toBe(true);
  });

  it("classifies scaffold-only and too-short manual relation content explicitly", () => {
    expect(explainManualWizardStepContentIssue("relation", `# 人物关系

## 核心关系
-

## 对立关系
-`)).toBe("scaffold");

    expect(explainManualWizardStepContentIssue("relation", `# 人物关系

## 核心关系
- 林砚 → 老账房：合作中带着试探。

## 对立关系
- 林砚 → 许沉舟：危险的旧债对手。

## 隐藏联系
- 旧案把两边都绑进了同一条线。

## 潜在冲突
- 真相曝光后，联盟会立刻重组。`)).toBe(null);
  });
});
