import { describe, expect, it } from "vitest";
import { routeNaturalLanguageIntent } from "../interaction/nl-router.js";

describe("interaction natural-language router", () => {
  it("maps continue-style requests to write_next", () => {
    expect(routeNaturalLanguageIntent("continue", { activeBookId: "harbor" })).toEqual({
      intent: "write_next",
      bookId: "harbor",
    });
    expect(routeNaturalLanguageIntent("继续写", { activeBookId: "harbor" })).toEqual({
      intent: "write_next",
      bookId: "harbor",
    });
  });

  it("maps pause requests to pause_book", () => {
    expect(routeNaturalLanguageIntent("pause this book", { activeBookId: "harbor" })).toEqual({
      intent: "pause_book",
      bookId: "harbor",
    });
  });

  it("maps rewrite chapter requests with chapter numbers", () => {
    expect(routeNaturalLanguageIntent("rewrite chapter 3", { activeBookId: "harbor" })).toEqual({
      intent: "rewrite_chapter",
      bookId: "harbor",
      chapterNumber: 3,
    });
    expect(routeNaturalLanguageIntent("重写第3章", { activeBookId: "harbor" })).toEqual({
      intent: "rewrite_chapter",
      bookId: "harbor",
      chapterNumber: 3,
    });
    expect(routeNaturalLanguageIntent("重写3章", { activeBookId: "harbor" })).toEqual({
      intent: "rewrite_chapter",
      bookId: "harbor",
      chapterNumber: 3,
    });
  });

  it("maps chinese revise aliases like 重订 to revise_chapter", () => {
    expect(routeNaturalLanguageIntent("重订13章", { activeBookId: "harbor" })).toEqual({
      intent: "revise_chapter",
      bookId: "harbor",
      chapterNumber: 13,
    });
  });

  it("maps revise chapter requests with freeform instructions", () => {
    expect(routeNaturalLanguageIntent("revise chapter 5 ending only", { activeBookId: "harbor" })).toEqual({
      intent: "revise_chapter",
      bookId: "harbor",
      chapterNumber: 5,
      instruction: "ending only",
    });
  });

  it("maps focus updates to update_focus", () => {
    expect(routeNaturalLanguageIntent("把 focus 拉回旧案线", { activeBookId: "harbor" })).toEqual({
      intent: "update_focus",
      bookId: "harbor",
      instruction: "把 focus 拉回旧案线",
    });
  });

  it("maps explanation requests to explain_failure", () => {
    expect(routeNaturalLanguageIntent("为什么主角名字没按设定走", { activeBookId: "harbor", hasFailed: true })).toEqual({
      intent: "explain_failure",
      bookId: "harbor",
      instruction: "为什么主角名字没按设定走",
    });
  });

  it("maps export-style natural language requests to export_book", () => {
    expect(routeNaturalLanguageIntent("导出全书", { activeBookId: "harbor" })).toEqual({
      intent: "export_book",
      bookId: "harbor",
      format: "txt",
    });
    expect(routeNaturalLanguageIntent("导出全书为 epub", { activeBookId: "harbor" })).toEqual({
      intent: "export_book",
      bookId: "harbor",
      format: "epub",
    });
    expect(routeNaturalLanguageIntent("export book as epub", { activeBookId: "harbor" })).toEqual({
      intent: "export_book",
      bookId: "harbor",
      format: "epub",
    });
  });

  it("maps greetings to chat instead of status explanation", () => {
    expect(routeNaturalLanguageIntent("hi", { activeBookId: "harbor" })).toEqual({
      intent: "chat",
      bookId: "harbor",
      instruction: "hi",
    });
    expect(routeNaturalLanguageIntent("你好", { activeBookId: "harbor" })).toEqual({
      intent: "chat",
      bookId: "harbor",
      instruction: "你好",
    });
  });

  it("routes freeform input into book-development when no active book is bound", () => {
    expect(routeNaturalLanguageIntent("我想写个港风商战悬疑")).toEqual({
      intent: "develop_book",
      instruction: "我想写个港风商战悬疑",
    });
    expect(routeNaturalLanguageIntent("先不要开书，我想想名字", {
      hasCreationDraft: true,
    })).toEqual({
      intent: "develop_book",
      instruction: "先不要开书，我想想名字",
    });
    expect(routeNaturalLanguageIntent("名字再狠一点", {
      activeBookId: "harbor",
      hasCreationDraft: true,
    })).toEqual({
      intent: "develop_book",
      instruction: "名字再狠一点",
    });
  });

  it("maps mode switch requests to switch_mode", () => {
    expect(routeNaturalLanguageIntent("切换到全自动", { activeBookId: "harbor" })).toEqual({
      intent: "switch_mode",
      mode: "auto",
    });
    expect(routeNaturalLanguageIntent("半自动", { activeBookId: "harbor" })).toEqual({
      intent: "switch_mode",
      mode: "semi",
    });
    expect(routeNaturalLanguageIntent("切到全自主", { activeBookId: "harbor" })).toEqual({
      intent: "switch_mode",
      mode: "manual",
    });
  });

  it("maps slash commands for direct control", () => {
    expect(routeNaturalLanguageIntent("/books", { activeBookId: "harbor" })).toEqual({
      intent: "list_books",
    });
    expect(routeNaturalLanguageIntent("/new Night Harbor", { activeBookId: "harbor" })).toEqual({
      intent: "develop_book",
      instruction: "Night Harbor",
    });
    expect(routeNaturalLanguageIntent("/create", { hasCreationDraft: true })).toEqual({
      intent: "create_book",
    });
    expect(routeNaturalLanguageIntent("/draft", { hasCreationDraft: true })).toEqual({
      intent: "show_book_draft",
    });
    expect(routeNaturalLanguageIntent("/discard", { hasCreationDraft: true })).toEqual({
      intent: "discard_book_draft",
    });
    expect(routeNaturalLanguageIntent("/open beta", { activeBookId: "harbor" })).toEqual({
      intent: "select_book",
      bookId: "beta",
    });
    expect(routeNaturalLanguageIntent("/write", { activeBookId: "harbor" })).toEqual({
      intent: "write_next",
      bookId: "harbor",
    });
    expect(routeNaturalLanguageIntent("/mode auto", { activeBookId: "harbor" })).toEqual({
      intent: "switch_mode",
      mode: "auto",
    });
    expect(routeNaturalLanguageIntent("/rewrite 3", { activeBookId: "harbor" })).toEqual({
      intent: "rewrite_chapter",
      bookId: "harbor",
      chapterNumber: 3,
    });
    expect(routeNaturalLanguageIntent("/focus bring it back to the old case", { activeBookId: "harbor" })).toEqual({
      intent: "update_focus",
      bookId: "harbor",
      instruction: "bring it back to the old case",
    });
    expect(routeNaturalLanguageIntent("/truth current_focus.md Bring it back", { activeBookId: "harbor" })).toEqual({
      intent: "edit_truth",
      bookId: "harbor",
      fileName: "current_focus.md",
      instruction: "Bring it back",
    });
    expect(routeNaturalLanguageIntent("/rename 陆尘 => 林砚", { activeBookId: "harbor" })).toEqual({
      intent: "rename_entity",
      bookId: "harbor",
      oldValue: "陆尘",
      newValue: "林砚",
    });
    expect(routeNaturalLanguageIntent("/replace 3 旧名字 => 新名字", { activeBookId: "harbor" })).toEqual({
      intent: "patch_chapter_text",
      bookId: "harbor",
      chapterNumber: 3,
      targetText: "旧名字",
      replacementText: "新名字",
    });
    expect(routeNaturalLanguageIntent("/export", { activeBookId: "harbor" })).toEqual({
      intent: "export_book",
      bookId: "harbor",
      format: "txt",
    });
    expect(routeNaturalLanguageIntent("/export md", { activeBookId: "harbor" })).toEqual({
      intent: "export_book",
      bookId: "harbor",
      format: "md",
    });
  });


  it("maps goto wizard commands to goto_book_wizard", () => {
    expect(routeNaturalLanguageIntent("/goto world", { activeBookId: "harbor" })).toEqual({
      intent: "goto_book_wizard",
      bookId: "harbor",
      wizardStep: "world",
    });
  });

  it("maps wizard advance commands to advance_book_wizard with the target step id", () => {
    expect(routeNaturalLanguageIntent("/wizard advance current=intro next=world title=夜港账本 genre=urban platform=tomato target=120 words=2800", { activeBookId: "harbor" })).toEqual({
      intent: "advance_book_wizard",
      bookId: "harbor",
      instruction: "/wizard advance current=intro next=world title=夜港账本 genre=urban platform=tomato target=120 words=2800",
      wizardStep: "intro",
      title: "夜港账本",
      genre: "urban",
      platform: "tomato",
      targetChapters: 120,
      chapterWordCount: 2800,
    });
  });

  it("maps save wizard commands to save_wizard_step", () => {
    expect(routeNaturalLanguageIntent("/save step=intro title=夜港账本", { activeBookId: "harbor" })).toEqual({
      intent: "save_wizard_step",
      bookId: "harbor",
      instruction: "/save step=intro title=夜港账本",
      wizardStep: "intro",
      title: "夜港账本",
    });
  });

  it("maps intro generation commands to revise_book_intro", () => {
    expect(routeNaturalLanguageIntent("/intro mode=generate genre=urban title=夜港账本", { activeBookId: "harbor" })).toEqual({
      intent: "revise_book_intro",
      bookId: "harbor",
      instruction: "mode=generate genre=urban title=夜港账本",
      revisionKind: "generate",
      genre: "urban",
      title: "夜港账本",
    });
  });

  it("extracts instruction parameter from /intro command", () => {
    expect(routeNaturalLanguageIntent(
      "/intro mode=generate genre=urban title=夜港账本 instruction=%E7%94%9F%E6%88%90%E4%B8%80%E4%B8%AA%E6%B8%AF%E5%9F%8E%E8%83%8C%E6%99%AF%E7%9A%84%E5%95%86%E6%88%98%E6%95%85%E4%BA%8B",
      { activeBookId: "harbor" },
    )).toEqual({
      intent: "revise_book_intro",
      bookId: "harbor",
      instruction: "生成一个港城背景的商战故事",
      revisionKind: "generate",
      genre: "urban",
      title: "夜港账本",
    });
  });

  it("maps intro-candidates command to chat intent", () => {
    expect(routeNaturalLanguageIntent("/intro-candidates 请生成3套候选", { activeBookId: "harbor" })).toEqual({
      intent: "chat",
      bookId: "harbor",
      instruction: "请生成3套候选",
    });
  });

  it("keeps /intro multi-line payload routed to revise_book_intro", () => {
    const multiLine = [
      "/intro mode=generate genre=urban title=夜港账本",
      "",
      "blurb: 港口账本牵出灰产洗白风暴。",
      "storyBackground: 港城、账本、灰产洗白。",
      "instruction: 只生成第一页正文，不要提问。",
    ].join("\n");
    const payload = multiLine.slice("/intro ".length);
    expect(routeNaturalLanguageIntent(multiLine, { activeBookId: "harbor" })).toEqual({
      intent: "revise_book_intro",
      bookId: "harbor",
      instruction: payload,
      revisionKind: "generate",
      genre: "urban",
      title: "夜港账本",
    });
  });

  it("keeps extended /intro params and decodes encoded values", () => {
    const fullCommand = "/intro mode=generate theme=%E6%B8%AF%E9%A3%8E genre=urban genreName=%E9%83%BD%E5%B8%82 genreAlias=%E6%B8%AF%E9%A3%8E%E5%95%86%E6%88%98 genreSource=custom title=%E5%A4%9C%E6%B8%AF%E8%B4%A6%E6%9C%AC platform=tomato blurb=%E6%B8%AF%E5%8F%A3%E8%B4%A6%E6%9C%AC%E7%89%B5%E5%87%BA%E7%81%B0%E4%BA%A7 storyBackground=%E6%B8%AF%E5%9F%8E%E3%80%81%E8%B4%A6%E6%9C%AC%E3%80%81%E7%81%B0%E4%BA%A7";
    const payload = fullCommand.slice("/intro ".length);
    expect(routeNaturalLanguageIntent(
      fullCommand,
      { activeBookId: "harbor" },
    )).toEqual({
      intent: "revise_book_intro",
      bookId: "harbor",
      instruction: payload,
      revisionKind: "generate",
      themeGenre: "港风",
      genre: "urban",
      genreName: "都市",
      genreAlias: "港风商战",
      genreSource: "custom",
      title: "夜港账本",
      platform: "tomato",
      blurb: "港口账本牵出灰产",
      storyBackground: "港城、账本、灰产",
    });
  });

  it("maps rename and chapter patch requests from natural language", () => {
    expect(routeNaturalLanguageIntent("open beta", { activeBookId: "harbor" })).toEqual({
      intent: "select_book",
      bookId: "beta",
    });
    expect(routeNaturalLanguageIntent("把陆尘改成林砚", { activeBookId: "harbor" })).toEqual({
      intent: "rename_entity",
      bookId: "harbor",
      oldValue: "陆尘",
      newValue: "林砚",
    });
    expect(routeNaturalLanguageIntent("rename Lu Chen to Lin Yan", { activeBookId: "harbor" })).toEqual({
      intent: "rename_entity",
      bookId: "harbor",
      oldValue: "Lu Chen",
      newValue: "Lin Yan",
    });
  });

  it("falls back to chat for unmatched freeform input", () => {
    expect(routeNaturalLanguageIntent("没有动效没有回答", { activeBookId: "harbor" })).toEqual({
      intent: "chat",
      bookId: "harbor",
      instruction: "没有动效没有回答",
    });
  });
});
