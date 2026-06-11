import type { InteractionRequest } from "./intents.js";

export interface NaturalLanguageRoutingContext {
  readonly activeBookId?: string;
  readonly hasCreationDraft?: boolean;
  readonly hasFailed?: boolean;
}

interface HardParamDraft {
  title?: string;
  platform?: string;
  language?: "zh" | "en";
  targetChapters?: number;
  chapterWordCount?: number;
  genre?: string;
}

function normalizePlatformValue(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (/^番茄|tomato/.test(normalized)) return "tomato";
  if (/^起点|qidian/.test(normalized)) return "qidian";
  if (/^飞卢|feilu/.test(normalized)) return "feilu";
  if (/^其他|other/.test(normalized)) return "other";
  return value.trim();
}

function parsePositiveInteger(value: string): number | undefined {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.trunc(parsed);
}

function extractHardParams(input: string): HardParamDraft | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const params: HardParamDraft = {};
  let matched = false;
  const trailingFieldPattern = /\s*(?:平台|发布平台|语言|语种|目标章数|总章数|章数|每章字数|字数|单章字数).*$/
;

  function cleanFieldValue(value: string): string {
    return value.replace(trailingFieldPattern, "").trim();
  }

  const titleMatch = trimmed.match(/(?:^|[，,；;\n\s])(?:书名|标题)\s*(?:改成|改为|设为|定为|叫做|叫|是)?\s*[：:=]?\s*([^\n，,；;]+)/);
  if (titleMatch?.[1]) {
    params.title = cleanFieldValue(titleMatch[1]!);
    matched = true;
  }

  const platformMatch = trimmed.match(/(?:^|[，,；;\n\s])(?:平台|发布平台)\s*[：:=]?\s*([^\n，,；;]+)/);
  if (platformMatch?.[1]) {
    params.platform = normalizePlatformValue(cleanFieldValue(platformMatch[1]!));
    matched = true;
  }

  const languageMatch = trimmed.match(/(?:^|[，,；;\n\s])(?:语言|语种)\s*[：:=]?\s*(中文|zh|英文|en)/i);
  if (languageMatch?.[1]) {
    params.language = /en|英文/i.test(languageMatch[1]) ? "en" : "zh";
    matched = true;
  }

  const targetMatch = trimmed.match(/(?:^|[，,；;\n\s])(?:目标章数|总章数|章数)\s*[：:=]?\s*(\d+)/);
  if (targetMatch?.[1]) {
    const value = parsePositiveInteger(targetMatch[1]);
    if (value !== undefined) {
      params.targetChapters = value;
      matched = true;
    }
  } else {
    const compactTargetMatch = trimmed.match(/\b(\d+)\s*章\b/);
    if (compactTargetMatch?.[1]) {
      const value = parsePositiveInteger(compactTargetMatch[1]);
      if (value !== undefined) {
        params.targetChapters = value;
        matched = true;
      }
    }
  }

  const chapterWordMatch = trimmed.match(/(?:^|[，,；;\n\s])(?:每章字数|字数|单章字数)\s*[：:=]?\s*(\d+)/);
  if (chapterWordMatch?.[1]) {
    const value = parsePositiveInteger(chapterWordMatch[1]);
    if (value !== undefined) {
      params.chapterWordCount = value;
      matched = true;
    }
  } else {
    const compactWordMatch = trimmed.match(/(?:每章|单章)?\s*(\d+)\s*字/);
    if (compactWordMatch?.[1]) {
      const value = parsePositiveInteger(compactWordMatch[1]);
      if (value !== undefined) {
        params.chapterWordCount = value;
        matched = true;
      }
    }
  }

  if (!matched) {
    const explicitHardParamWords = /(书名|标题|平台|发布平台|语言|语种|章数|每章|每章字数|总章数)/.test(trimmed);
    if (!explicitHardParamWords) {
      return null;
    }
  }

  if (Object.keys(params).length === 0) {
    return null;
  }

  return params;
}

export function routeNaturalLanguageIntent(
  input: string,
  context: NaturalLanguageRoutingContext = {},
): InteractionRequest {
  const trimmed = input.trim();
  const bookId = context.activeBookId;
  const readParam = (payload: string, key: string): string | undefined => {
    const match = payload.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`, "i"));
    if (!match?.[1]) return undefined;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  };

  if (/^(hi|hello|hey|你好|嗨|哈喽)$/i.test(trimmed)) {
    return {
      intent: "chat",
      ...(bookId ? { bookId } : {}),
      instruction: trimmed,
    };
  }

  if (/^(continue|继续|继续写|写下一章|write next)$/i.test(trimmed)) {
    return {
      intent: "write_next",
      ...(bookId ? { bookId } : {}),
    };
  }

  if (/^\/write$/i.test(trimmed)) {
    return {
      intent: "write_next",
      ...(bookId ? { bookId } : {}),
    };
  }

  if (/^\/books$/i.test(trimmed)) {
    return {
      intent: "list_books",
    };
  }

  const newCommand = trimmed.match(/^\/new\s+(.+)$/i);
  if (newCommand) {
    return {
      intent: "develop_book",
      instruction: newCommand[1]!.trim(),
    };
  }

  if (/^\/create$/i.test(trimmed)) {
    return {
      intent: "create_book",
      ...(bookId ? { bookId } : {}),
    };
  }

  if (/^\/params(?:\s+|$)/i.test(trimmed)) {
    const params = extractHardParams(trimmed.slice("/params".length));
    if (params) {
      return {
        intent: "set_book_draft_params",
        ...(bookId ? { bookId } : {}),
        ...params,
      };
    }
  }

  const saveCommand = trimmed.match(/^\/save(?:\s+([\s\S]+))?$/i);
  if (saveCommand) {
    const payload = saveCommand[1]?.trim() ?? "";
    const stepMatch = payload.match(/(?:^|\s)step=([^\s]+)/i);
    const titleMatch = payload.match(/(?:^|\s)title=([^\s]+)/i);
    const genreMatch = payload.match(/(?:^|\s)genre=([^\s]+)/i);
    const platformMatch = payload.match(/(?:^|\s)platform=([^\s]+)/i);
    const targetMatch = payload.match(/(?:^|\s)target=([^\s]+)/i);
    const wordsMatch = payload.match(/(?:^|\s)words=([^\s]+)/i);
    return {
      intent: "save_wizard_step",
      ...(bookId ? { bookId } : {}),
      instruction: trimmed,
      ...(stepMatch?.[1] ? { wizardStep: stepMatch[1].toLowerCase() as InteractionRequest["wizardStep"] } : {}),
      ...(titleMatch?.[1] ? { title: titleMatch[1] } : {}),
      ...(genreMatch?.[1] ? { genre: genreMatch[1] } : {}),
      ...(platformMatch?.[1] ? { platform: platformMatch[1] } : {}),
      ...(targetMatch?.[1] ? { targetChapters: parsePositiveInteger(targetMatch[1]) } : {}),
      ...(wordsMatch?.[1] ? { chapterWordCount: parsePositiveInteger(wordsMatch[1]) } : {}),
    };
  }

  const introCommand = trimmed.match(/^\/intro(?:\s+([\s\S]+))?$/i);
  if (introCommand) {
    const payload = introCommand[1]?.trim() ?? "";
    return {
      intent: "revise_book_intro",
      ...(bookId ? { bookId } : {}),
      instruction: trimmed,
      revisionKind: (readParam(payload, "mode") as "generate" | "revise" | "polish" | undefined) ?? "generate",
      ...(readParam(payload, "theme") ? { themeGenre: readParam(payload, "theme") } : {}),
      ...(readParam(payload, "genre") ? { genre: readParam(payload, "genre") } : {}),
      ...(readParam(payload, "genreName") ? { genreName: readParam(payload, "genreName") } : {}),
      ...(readParam(payload, "genreAlias") ? { genreAlias: readParam(payload, "genreAlias") } : {}),
      ...(readParam(payload, "genreSource") ? { genreSource: readParam(payload, "genreSource") as "builtin" | "project" | "custom" } : {}),
      ...(readParam(payload, "title") ? { title: readParam(payload, "title") } : {}),
      ...(readParam(payload, "platform") ? { platform: readParam(payload, "platform") } : {}),
      ...(readParam(payload, "blurb") ? { blurb: readParam(payload, "blurb") } : {}),
      ...(readParam(payload, "storyBackground") ? { storyBackground: readParam(payload, "storyBackground") } : {}),
    };
  }

  const introCandidatesCommand = trimmed.match(/^\/intro-candidates(?:\s+([\s\S]+))?$/i);
  if (introCandidatesCommand) {
    const payload = introCandidatesCommand[1]?.trim() ?? "";
    return {
      intent: "chat",
      ...(bookId ? { bookId } : {}),
      instruction: payload || trimmed,
    };
  }

  const gotoCommand = trimmed.match(/^\/goto\s+(intro|world|outline|volume|characters|arc|relation)$/i);
  if (gotoCommand) {
    return {
      intent: "goto_book_wizard",
      ...(bookId ? { bookId } : {}),
      wizardStep: gotoCommand[1]!.toLowerCase() as InteractionRequest["wizardStep"],
    };
  }

  const wizardAdvanceCommand = trimmed.match(/^\/wizard\s+advance\s+current=([^\s]+)\s+next=([^\s]+)\s+title=([\s\S]+?)\s+genre=([\s\S]+?)\s+platform=([\s\S]+?)\s+target=([^\s]*)\s+words=([^\s]*)$/i);
  if (wizardAdvanceCommand) {
    const targetChapters = parsePositiveInteger(wizardAdvanceCommand[6] ?? "");
    const chapterWordCount = parsePositiveInteger(wizardAdvanceCommand[7] ?? "");
    return {
      intent: "advance_book_wizard",
      ...(bookId ? { bookId } : {}),
      instruction: trimmed,
      // `current` is the step being saved now; the runtime uses it to verify we did not
      // accidentally race onto the next page before persisting the current draft.
      wizardStep: wizardAdvanceCommand[1]!.toLowerCase() as InteractionRequest["wizardStep"],
      title: wizardAdvanceCommand[3]!.trim(),
      genre: wizardAdvanceCommand[4]!.trim(),
      platform: wizardAdvanceCommand[5]!.trim(),
      ...(targetChapters !== undefined ? { targetChapters } : {}),
      ...(chapterWordCount !== undefined ? { chapterWordCount } : {}),
    };
  }

  const candidateCommand = trimmed.match(/^\/candidate\s+(\d+)(?:\s+(select|revise|create))?(?:\s+([\s\S]+))?$/i);
  if (candidateCommand) {
    return {
      intent: "select_intro_candidate",
      ...(bookId ? { bookId } : {}),
      candidateIndex: parseInt(candidateCommand[1]!, 10),
      candidateAction: (candidateCommand[2]?.toLowerCase() as "select" | "revise" | "create" | undefined) ?? "select",
      ...(candidateCommand[3]?.trim() ? { instruction: candidateCommand[3].trim() } : {}),
    };
  }

  if (/^\/draft$/i.test(trimmed)) {
    return {
      intent: "show_book_draft",
    };
  }

  if (/^\/discard$/i.test(trimmed)) {
    return {
      intent: "discard_book_draft",
    };
  }

  const openCommand = trimmed.match(/^\/open\s+(.+)$/i);
  if (openCommand) {
    return {
      intent: "select_book",
      bookId: openCommand[1]!.trim(),
    };
  }

  if (/^(pause|pause this book|暂停|暂停这本书)$/i.test(trimmed)) {
    return {
      intent: "pause_book",
      ...(bookId ? { bookId } : {}),
    };
  }

  const modeCommand = trimmed.match(/^\/mode\s+(auto|semi|manual)$/i);
  if (modeCommand) {
    return {
      intent: "switch_mode",
      mode: modeCommand[1]!.toLowerCase() as "auto" | "semi" | "manual",
    };
  }

  if (/(全自动|auto mode|switch to auto|切换到全自动)/i.test(trimmed)) {
    return {
      intent: "switch_mode",
      mode: "auto",
    };
  }

  if (/(半自动|semi mode|switch to semi)/i.test(trimmed)) {
    return {
      intent: "switch_mode",
      mode: "semi",
    };
  }

  if (/(全自主|手动模式|manual mode|switch to manual)/i.test(trimmed)) {
    return {
      intent: "switch_mode",
      mode: "manual",
    };
  }

  const slashRewrite = trimmed.match(/^\/rewrite\s+(\d+)$/i);
  if (slashRewrite) {
    return {
      intent: "rewrite_chapter",
      ...(bookId ? { bookId } : {}),
      chapterNumber: parseInt(slashRewrite[1]!, 10),
    };
  }

  const slashFocus = trimmed.match(/^\/focus\s+(.+)$/i);
  if (slashFocus) {
    return {
      intent: "update_focus",
      ...(bookId ? { bookId } : {}),
      instruction: slashFocus[1]!.trim(),
    };
  }

  const slashTruth = trimmed.match(/^\/truth\s+([^\s]+)\s+([\s\S]+)$/i);
  if (slashTruth) {
    return {
      intent: "edit_truth",
      ...(bookId ? { bookId } : {}),
      fileName: slashTruth[1]!.trim(),
      instruction: slashTruth[2]!.trim(),
    };
  }

  const slashRename = trimmed.match(/^\/rename\s+(.+?)\s*=>\s*(.+)$/i);
  if (slashRename) {
    return {
      intent: "rename_entity",
      ...(bookId ? { bookId } : {}),
      oldValue: slashRename[1]!.trim(),
      newValue: slashRename[2]!.trim(),
    };
  }

  const slashReplace = trimmed.match(/^\/replace\s+(\d+)\s+(.+?)\s*=>\s*(.+)$/i);
  if (slashReplace) {
    return {
      intent: "patch_chapter_text",
      ...(bookId ? { bookId } : {}),
      chapterNumber: parseInt(slashReplace[1]!, 10),
      targetText: slashReplace[2]!.trim(),
      replacementText: slashReplace[3]!.trim(),
    };
  }

  const slashExport = trimmed.match(/^\/export(?:\s+(txt|md|epub))?$/i);
  if (slashExport) {
    return {
      intent: "export_book",
      ...(bookId ? { bookId } : {}),
      format: (slashExport[1]?.toLowerCase() as "txt" | "md" | "epub" | undefined) ?? "txt",
    };
  }

  const rewriteMatch = trimmed.match(/(?:rewrite chapter|重写(?:第)?)\s*(\d+)\s*(?:章)?/i);
  if (rewriteMatch) {
    return {
      intent: "rewrite_chapter",
      ...(bookId ? { bookId } : {}),
      chapterNumber: parseInt(rewriteMatch[1]!, 10),
    };
  }

  const zhReviseMatch = trimmed.match(/(?:修订|重订|修改|改写|润色|精修)\s*(?:第)?\s*(\d+)\s*章(?:\s*(.*))?/);
  if (zhReviseMatch) {
    const trailing = zhReviseMatch[2]?.trim();
    return {
      intent: "revise_chapter",
      ...(bookId ? { bookId } : {}),
      chapterNumber: parseInt(zhReviseMatch[1]!, 10),
      ...(trailing ? { instruction: trailing } : {}),
    };
  }

  const reviseMatch = trimmed.match(/revise chapter\s*(\d+)\s*(.*)$/i);
  if (reviseMatch) {
    const trailing = reviseMatch[2]?.trim();
    return {
      intent: "revise_chapter",
      ...(bookId ? { bookId } : {}),
      chapterNumber: parseInt(reviseMatch[1]!, 10),
      ...(trailing ? { instruction: trailing } : {}),
    };
  }

  const zhRenameMatch = trimmed.match(/^把(.+?)改成(.+)$/);
  if (zhRenameMatch) {
    return {
      intent: "rename_entity",
      ...(bookId ? { bookId } : {}),
      oldValue: zhRenameMatch[1]!.trim(),
      newValue: zhRenameMatch[2]!.trim(),
    };
  }

  const enRenameMatch = trimmed.match(/^rename\s+(.+?)\s+to\s+(.+)$/i);
  if (enRenameMatch) {
    return {
      intent: "rename_entity",
      ...(bookId ? { bookId } : {}),
      oldValue: enRenameMatch[1]!.trim(),
      newValue: enRenameMatch[2]!.trim(),
    };
  }

  const openMatch = trimmed.match(/^open\s+(.+)$/i);
  if (openMatch) {
    return {
      intent: "select_book",
      bookId: openMatch[1]!.trim(),
    };
  }

  if (/(focus|聚焦|主线|旧案线)/i.test(trimmed)) {
    return {
      intent: "update_focus",
      ...(bookId ? { bookId } : {}),
      instruction: trimmed,
    };
  }

  if (/(为什么|why)/i.test(trimmed) && context.hasFailed) {
    return {
      intent: "explain_failure",
      ...(bookId ? { bookId } : {}),
      instruction: trimmed,
    };
  }

  if (/^(导出全书(?:为\s*(epub|md|txt))?|export book(?: as)?\s*(epub|md|txt)?)$/i.test(trimmed)) {
    const matchedFormat = trimmed.match(/(epub|md|txt)/i)?.[1]?.toLowerCase() as "txt" | "md" | "epub" | undefined;
    return {
      intent: "export_book",
      ...(bookId ? { bookId } : {}),
      format: matchedFormat ?? "txt",
    };
  }

  if (/(我想写|我要写|想写|建书|创建一本|创建书|新建一本|新建书)/i.test(trimmed)) {
    return {
      intent: "develop_book",
      instruction: trimmed,
    };
  }

  const hardParams = extractHardParams(trimmed);
  if (hardParams) {
    return {
      intent: "set_book_draft_params",
      ...(bookId ? { bookId } : {}),
      ...hardParams,
    };
  }

  if (!bookId || context.hasCreationDraft) {
    return {
      intent: "develop_book",
      instruction: trimmed,
    };
  }

  return {
    intent: "chat",
    ...(bookId ? { bookId } : {}),
    instruction: trimmed,
  };
}
