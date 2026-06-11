export type ArtifactReaderMode = "chapter" | "design" | "outline" | "truth" | "wizard";

export interface BookArtifactMenuItem {
  readonly file: string;
  readonly title: string;
  readonly subtitle: string;
  readonly source: string;
  readonly mode: ArtifactReaderMode;
}

export interface BookArtifactLabel {
  readonly title: string;
  readonly subtitle: string;
}

const ARTIFACT_FILE_ALIASES: Readonly<Record<string, string>> = {
  "story/outline/story_frame.md": "story_bible.md",
  "story/outline/volume_map.md": "story/outline/volume_map.md",
};

const FILE_LABELS: Record<string, BookArtifactLabel> = {
  "story_bible.md": { title: "世界观设定", subtitle: "story_bible.md" },
  "novel_outline.md": { title: "小说大纲", subtitle: "novel_outline.md" },
  "volume_outline.md": { title: "卷纲规划", subtitle: "volume_outline.md" },
  "story/outline/story_frame.md": { title: "世界观设定", subtitle: "story/outline/story_frame.md" },
  "story/outline/volume_map.md": { title: "卷纲规划", subtitle: "story/outline/volume_map.md" },
  "book_rules.md": { title: "叙事规则", subtitle: "book_rules.md" },
  "current_state.md": { title: "世界状态", subtitle: "current_state.md" },
  "particle_ledger.md": { title: "资源账本", subtitle: "particle_ledger.md" },
  "pending_hooks.md": { title: "未闭合伏笔", subtitle: "pending_hooks.md" },
  "chapter_summaries.md": { title: "各章摘要", subtitle: "chapter_summaries.md" },
  "subplot_board.md": { title: "支线进度板", subtitle: "subplot_board.md" },
  "emotional_arcs.md": { title: "情感弧线", subtitle: "emotional_arcs.md" },
  "character_matrix.md": { title: "角色交互矩阵", subtitle: "character_matrix.md" },
  "character_arc.md": { title: "人物弧光", subtitle: "character_arc.md" },
  "relationship_map.md": { title: "人物关系", subtitle: "relationship_map.md" },
  "author_intent.md": { title: "长期作者意图", subtitle: "author_intent.md" },
  "current_focus.md": { title: "当前阶段的关注点", subtitle: "current_focus.md" },
  "foundation_brief.md": { title: "创作基础简报", subtitle: "foundation_brief.md" },
  "story/author_intent.md": { title: "长期作者意图", subtitle: "story/author_intent.md" },
  "story/current_focus.md": { title: "当前阶段的关注点", subtitle: "story/current_focus.md" },
};

export function normalizeArtifactFile(file: string): string {
  const aliased = ARTIFACT_FILE_ALIASES[file] ?? file;
  return aliased.replace(/^story\//, "");
}

export function getArtifactLabel(file: string): BookArtifactLabel {
  const normalized = normalizeArtifactFile(file);
  return FILE_LABELS[file] ?? FILE_LABELS[normalized] ?? { title: normalized, subtitle: normalized };
}

export function resolveArtifactStoragePath(file: string): string {
  switch (file) {
    case "story_bible.md":
      return "story/outline/story_frame.md";
    case "volume_outline.md":
      return "story/outline/volume_map.md";
    case "story/outline/volume_map.md":
      return "story/outline/volume_map.md";
    default:
      return file;
  }
}

export function createArtifactMenuItem(
  file: string,
  source: string,
  mode: ArtifactReaderMode,
): BookArtifactMenuItem {
  const label = getArtifactLabel(file);
  return {
    file,
    title: label.title,
    subtitle: label.subtitle,
    source,
    mode,
  };
}

export const ASSET_MENU_ITEMS: ReadonlyArray<BookArtifactMenuItem> = [
  createArtifactMenuItem("story_bible.md", "资产列表", "truth"),
  createArtifactMenuItem("story/outline/volume_map.md", "资产列表", "outline"),
  createArtifactMenuItem("book_rules.md", "资产列表", "truth"),
  createArtifactMenuItem("current_state.md", "资产列表", "truth"),
  createArtifactMenuItem("pending_hooks.md", "资产列表", "truth"),
  createArtifactMenuItem("subplot_board.md", "资产列表", "truth"),
  createArtifactMenuItem("emotional_arcs.md", "资产列表", "truth"),
  createArtifactMenuItem("character_matrix.md", "资产列表", "truth"),
];

export const GUIDE_MENU_ITEMS: ReadonlyArray<BookArtifactMenuItem> = [
  createArtifactMenuItem("foundation_brief.md", "向导资料", "truth"),
  createArtifactMenuItem("story_bible.md", "向导资料", "truth"),
  createArtifactMenuItem("novel_outline.md", "向导资料", "truth"),
  createArtifactMenuItem("story/outline/volume_map.md", "向导资料", "outline"),
  createArtifactMenuItem("character_matrix.md", "向导资料", "truth"),
  createArtifactMenuItem("character_arc.md", "向导资料", "truth"),
  createArtifactMenuItem("relationship_map.md", "向导资料", "truth"),
  createArtifactMenuItem("author_intent.md", "向导资料", "truth"),
];

export const TRUTH_MENU_ITEMS: ReadonlyArray<BookArtifactMenuItem> = [
  createArtifactMenuItem("current_state.md", "小说真相", "truth"),
  createArtifactMenuItem("particle_ledger.md", "小说真相", "truth"),
  createArtifactMenuItem("pending_hooks.md", "小说真相", "truth"),
  createArtifactMenuItem("chapter_summaries.md", "小说真相", "truth"),
  createArtifactMenuItem("subplot_board.md", "小说真相", "truth"),
  createArtifactMenuItem("emotional_arcs.md", "小说真相", "truth"),
  createArtifactMenuItem("character_matrix.md", "小说真相", "truth"),
  createArtifactMenuItem("story/author_intent.md", "小说真相", "truth"),
  createArtifactMenuItem("story/current_focus.md", "小说真相", "truth"),
];
