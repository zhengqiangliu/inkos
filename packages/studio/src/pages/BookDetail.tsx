import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import { fetchJson, postApi, putApi, useApi } from "../hooks/use-api";
import { useChatStore } from "../store/chat";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ArtifactView } from "../components/chat/BookSidebar";
import { BookDetailChatDock } from "../components/chat/BookDetailChatDock";
import { dispatchWriteNextInstruction } from "../utils/write-next";
import { ChaptersSection } from "../components/sidebar/ChaptersSection";
import { ChapterAuditHistoryModal } from "../components/sidebar/ChapterAuditHistoryModal";
import { ChapterPlansSection, EditPlanModal } from "../components/sidebar/ChapterPlansSection";
import { ChapterPlanReader } from "../components/sidebar/ChapterPlanReader";
import { AssetLibraryHistoryModal } from "../components/sidebar/AssetLibraryHistoryModal";
import { DirectorPlanHistoryModal } from "../components/sidebar/DirectorPlanHistoryModal";
import { ScriptWorkspaceHistoryModal } from "../components/sidebar/ScriptWorkspaceHistoryModal";
import { VersionHistoryModal } from "../components/sidebar/VersionHistoryModal";
import { ASSET_MENU_ITEMS, GUIDE_MENU_ITEMS, TRUTH_MENU_ITEMS, getArtifactLabel } from "../utils/book-artifacts";
import type { ArtifactReaderMode } from "../utils/book-artifacts";
import type { ChapterAuditReport, TaskChecklistItem, TaskChecklistResponse, TaskChecklistTemplateSummary } from "../shared/contracts";
import { resolveLatestChapterAuditReport } from "../utils/chapter-audit";
import { shouldRedirectBookDetailToWizard } from "../utils/book-creation-routing";
import { buildScriptWorkspaceChecklistTemplate } from "../utils/script-workspace-checklist";
import {
  buildEpisodeVideoPromptExportText,
  buildScriptWorkspaceExportFileName,
  buildWorkspaceVideoPromptExportText,
  downloadTextFile,
} from "../utils/script-workspace-export";
import { consumeScriptWorkspaceAutoOpenFlag } from "../utils/script-workspace-routing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { ChevronLeft, ChevronDown, FileText, Zap, Sparkles, Database, BarChart2, Trash2, BookOpen } from "lucide-react";
import type {
  AssetLibrary,
  AssetLibraryItemStatus,
  AssetLibraryResponse,
  AssetLibraryUploadResponse,
  DirectorPlan,
  DirectorPlanResponse,
  ProductionDialogueType,
  ProductionEpisode,
  ProductionShot,
  ProductionWorkspace,
  ProductionWorkspaceResponse,
  ScriptWorkspace,
  ScriptWorkspaceConfig,
  ScriptWorkspaceEntity,
  ScriptWorkspaceEpisode,
  ScriptWorkspaceResponse,
  ScriptWorkspaceScene,
  ScriptWorkspaceSegment,
} from "../shared/contracts";

interface Nav {
  toDashboard: () => void;
  toServices: () => void;
  toTruth: (bookId: string) => void;
  toAnalytics: (bookId: string) => void;
  toBookCreate?: (bookId?: string) => void;
}

interface BookData {
  readonly book: {
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly status: string;
    readonly creationState?: "wizard" | "ready";
    readonly chapterWordCount: number;
    readonly targetChapters?: number;
    readonly language?: string;
    readonly fanficMode?: string;
  };
  readonly creation?: {
    readonly wizardCompleted: boolean;
    readonly resumeStep: string;
    readonly completedCount: number;
    readonly totalSteps: number;
  };
  readonly chapters: ReadonlyArray<{
    readonly number: number;
    readonly title: string;
    readonly status: string;
    readonly wordCount: number;
    readonly auditHistory?: ReadonlyArray<ChapterAuditReport>;
  }>;
  readonly nextChapter?: number;
}

interface TruthFile {
  readonly name: string;
  readonly size: number;
  readonly preview: string;
}

interface TruthFilesResponse {
  readonly files: ReadonlyArray<TruthFile>;
}

interface ChapterPlan {
  readonly chapterNumber: number;
  readonly chapterName: string;
  readonly highlight: string;
  readonly coreConflict: string;
  readonly plotAndConflict: string;
  readonly emotionalTone: string;
  readonly endingHook: string;
  readonly status: string;
  readonly source: string;
  readonly version: number;
  readonly needsReview?: boolean;
  readonly lockedFields?: ReadonlyArray<string>;
  readonly driftFlags?: ReadonlyArray<{ readonly code: string; readonly message: string }>;
  readonly maxNewHooks?: number;
  readonly maxRecoveryPerChapter?: number;
}

interface ChapterPlansResponse {
  readonly count: number;
  readonly plans: ReadonlyArray<ChapterPlan>;
}

export function resolveDisplayedChapterPlans(
  chapterPlansData: ChapterPlansResponse | null,
  chapterPlansSnapshot: ReadonlyArray<ChapterPlan> | null,
): ReadonlyArray<ChapterPlan> {
  return chapterPlansSnapshot ?? chapterPlansData?.plans ?? [];
}

type ReaderMode = "chapter" | "design" | "outline" | "truth" | "script" | "production";

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
  readonly auditHistory?: ReadonlyArray<ChapterAuditReport>;
}

interface BookDetailProps {
  readonly bookId: string;
  readonly nav: Nav;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly sse: { messages: ReadonlyArray<SSEMessage>; stateMessages: ReadonlyArray<SSEMessage>; connected: boolean };
}

const DETAIL_LEFT_WIDTH_KEY = "studio.book-detail.left-width";
const DETAIL_RIGHT_WIDTH_KEY = "studio.book-detail.right-width";
const DETAIL_LEFT_MIN = 280;
const DETAIL_LEFT_MAX = 640;
const DETAIL_RIGHT_MIN = 360;
const DETAIL_RIGHT_MAX = 1020;
const DETAIL_LEFT_DEFAULT = 360;
const DETAIL_RIGHT_DEFAULT = 750;
const DETAIL_MIDDLE_MIN = 320;
const DETAIL_HANDLE_WIDTH = 8;

function readStoredWidth(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = Number(window.localStorage.getItem(key));
  if (!Number.isFinite(raw)) return fallback;
  return Math.round(raw);
}

function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeDetailWidths(left: number, right: number, viewportWidth: number): { left: number; right: number } {
  let nextLeft = clampWidth(left, DETAIL_LEFT_MIN, DETAIL_LEFT_MAX);
  let nextRight = clampWidth(right, DETAIL_RIGHT_MIN, DETAIL_RIGHT_MAX);
  const maxSides = Math.max(DETAIL_LEFT_MIN + DETAIL_RIGHT_MIN, viewportWidth - DETAIL_MIDDLE_MIN - DETAIL_HANDLE_WIDTH * 2);
  const total = nextLeft + nextRight;
  if (total > maxSides) {
    const overflow = total - maxSides;
    const rightRoom = nextRight - DETAIL_RIGHT_MIN;
    const shrinkRight = Math.min(overflow, rightRoom);
    nextRight -= shrinkRight;
    const remaining = overflow - shrinkRight;
    if (remaining > 0) nextLeft = Math.max(DETAIL_LEFT_MIN, nextLeft - remaining);
  }
  return { left: nextLeft, right: nextRight };
}

export function shouldAutoOpenFirstChapter(
  chapters: ReadonlyArray<Pick<ChapterMeta, "number" | "title" | "status" | "wordCount">>,
  activeChapter: number | null,
): boolean {
  return activeChapter === null && chapters.length > 0;
}

export function normalizeEditableStringList(value: string): string[] {
  return value
    .split(/[\n,，、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function formatEditableStringList(values: ReadonlyArray<string> | undefined): string {
  return (values ?? []).join("、");
}

function uniqEditableStrings(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function updateProductionWorkspaceEpisode(
  workspace: ProductionWorkspace,
  episodeNumber: number,
  updater: (episode: ProductionEpisode) => ProductionEpisode,
): ProductionWorkspace {
  return {
    ...workspace,
    episodes: workspace.episodes.map((episode) => (
      episode.episodeNumber === episodeNumber ? updater(episode) : episode
    )),
    updatedAt: new Date().toISOString(),
  };
}

export function updateProductionWorkspaceShot(
  workspace: ProductionWorkspace,
  shotId: string,
  updater: (shot: ProductionShot) => ProductionShot,
): ProductionWorkspace {
  return {
    ...workspace,
    episodes: workspace.episodes.map((episode) => ({
      ...episode,
      shots: episode.shots.map((shot) => (shot.id === shotId ? updater(shot) : shot)),
    })),
    updatedAt: new Date().toISOString(),
  };
}

export type ProductionShotSortMode = "shot-number" | "duration-desc" | "duration-asc" | "scene" | "dialogue-first";

export interface ProductionShotViewOptions {
  readonly search: string;
  readonly dialogueType: "all" | ProductionDialogueType;
  readonly imageFilter: "all" | "generate-only" | "skip-image";
  readonly sortMode: ProductionShotSortMode;
}

export interface ProductionShotBulkPatch {
  readonly shouldGenerateImage?: boolean;
  readonly dialogueType?: ProductionDialogueType;
  readonly addCharacters?: ReadonlyArray<string>;
  readonly removeCharacters?: ReadonlyArray<string>;
  readonly addProps?: ReadonlyArray<string>;
  readonly removeProps?: ReadonlyArray<string>;
  readonly addAssets?: ReadonlyArray<string>;
  readonly removeAssets?: ReadonlyArray<string>;
}

export function applyBulkUpdateToProductionShots(
  workspace: ProductionWorkspace,
  shotIds: ReadonlyArray<string>,
  patch: ProductionShotBulkPatch,
): ProductionWorkspace {
  const shotIdSet = new Set(shotIds);
  const removeCharacters = new Set(patch.removeCharacters ?? []);
  const removeProps = new Set(patch.removeProps ?? []);
  const removeAssets = new Set(patch.removeAssets ?? []);
  return {
    ...workspace,
    episodes: workspace.episodes.map((episode) => ({
      ...episode,
      shots: episode.shots.map((shot) => {
        if (!shotIdSet.has(shot.id)) return shot;
        return {
          ...shot,
          ...(typeof patch.shouldGenerateImage === "boolean" ? { shouldGenerateImage: patch.shouldGenerateImage } : {}),
          ...(patch.dialogueType ? { dialogueType: patch.dialogueType } : {}),
          characters: uniqEditableStrings([
            ...shot.characters.filter((item) => !removeCharacters.has(item)),
            ...(patch.addCharacters ?? []),
          ]),
          props: uniqEditableStrings([
            ...shot.props.filter((item) => !removeProps.has(item)),
            ...(patch.addProps ?? []),
          ]),
          assets: uniqEditableStrings([
            ...shot.assets.filter((item) => !removeAssets.has(item)),
            ...(patch.addAssets ?? []),
          ]),
        };
      }),
    })),
    updatedAt: new Date().toISOString(),
  };
}

export type ProductionShotMoveDirection = "up" | "down";

export function reorderProductionEpisodeShots(
  workspace: ProductionWorkspace,
  episodeNumber: number,
  shotId: string,
  direction: ProductionShotMoveDirection,
): ProductionWorkspace {
  return {
    ...workspace,
    episodes: workspace.episodes.map((episode) => {
      if (episode.episodeNumber !== episodeNumber) return episode;
      const currentIndex = episode.shots.findIndex((shot) => shot.id === shotId);
      if (currentIndex < 0) return episode;
      const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
      if (targetIndex < 0 || targetIndex >= episode.shots.length) return episode;
      const reordered = [...episode.shots];
      const [moved] = reordered.splice(currentIndex, 1);
      if (!moved) return episode;
      reordered.splice(targetIndex, 0, moved);
      return {
        ...episode,
        shots: reordered.map((shot, index) => ({
          ...shot,
          shotNumber: index + 1,
        })),
      };
    }),
    updatedAt: new Date().toISOString(),
  };
}

export function filterAndSortProductionShots(
  shots: ReadonlyArray<ProductionShot>,
  options: ProductionShotViewOptions,
): ProductionShot[] {
  const search = options.search.trim().toLowerCase();
  const filtered = shots.filter((shot) => {
    if (options.dialogueType !== "all" && shot.dialogueType !== options.dialogueType) return false;
    if (options.imageFilter === "generate-only" && !shot.shouldGenerateImage) return false;
    if (options.imageFilter === "skip-image" && shot.shouldGenerateImage) return false;
    if (!search) return true;
    const haystack = [
      shot.title,
      shot.scene,
      shot.shotType,
      shot.cameraMovement,
      shot.dialogue,
      shot.scriptText,
      ...shot.characters,
      ...shot.props,
      ...shot.assets,
    ].join(" ").toLowerCase();
    return haystack.includes(search);
  });
  const sorted = [...filtered];
  sorted.sort((left, right) => {
    switch (options.sortMode) {
      case "duration-desc":
        return right.durationSec - left.durationSec || left.shotNumber - right.shotNumber;
      case "duration-asc":
        return left.durationSec - right.durationSec || left.shotNumber - right.shotNumber;
      case "scene":
        return left.scene.localeCompare(right.scene, "zh-CN") || left.shotNumber - right.shotNumber;
      case "dialogue-first":
        return Number(right.dialogueType !== "none") - Number(left.dialogueType !== "none")
          || left.shotNumber - right.shotNumber;
      case "shot-number":
      default:
        return left.shotNumber - right.shotNumber;
    }
  });
  return sorted;
}

function renderMenuEntry(item: { title: string; subtitle: string; source: string }) {
  return (
    <div className="flex min-w-0 flex-col items-start">
      <span className="truncate text-left">{item.title}</span>
      <span className="text-[10px] text-muted-foreground">{item.subtitle} / {item.source}</span>
    </div>
  );
}

function renderMenuEmpty(label: string, subtitle: string) {
  return (
    <div className="flex min-w-0 flex-col items-start">
      <span className="truncate text-left">{label}</span>
      <span className="text-[10px] text-muted-foreground">{subtitle}</span>
    </div>
  );
}

function uniqueSortedNumbers(values: ReadonlyArray<number>): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0).map((value) => Math.trunc(value)))]
    .sort((left, right) => left - right);
}

function formatChapterNumbers(chapterNumbers: ReadonlyArray<number>): string {
  return chapterNumbers.length > 0 ? chapterNumbers.map((number) => `第${number}章`).join("、") : "未指定章节";
}

function formatExtractionSourceLabel(sourceChapterNumbers: ReadonlyArray<number>, mode: "chapter" | "episode"): string {
  if (sourceChapterNumbers.length === 0) return "未标注来源";
  const prefix = mode === "episode" ? "来源章节" : "来源";
  return `${prefix} ${formatChapterNumbers(sourceChapterNumbers)}`;
}

function intersectsNumbers(left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function resolveItemSourceChapterNumbers(
  item: { readonly sourceChapterNumbers?: ReadonlyArray<number>; readonly chapterNumber?: number },
): number[] {
  if (item.sourceChapterNumbers?.length) return uniqueSortedNumbers(item.sourceChapterNumbers);
  if (typeof item.chapterNumber === "number" && Number.isFinite(item.chapterNumber)) {
    return uniqueSortedNumbers([item.chapterNumber]);
  }
  return [];
}

type ScriptExtractionViewMode = "chapter" | "episode";
type ScriptWorkflowStepId = "chapters" | "config" | "checklist" | "review";

interface ScriptExtractionGroup {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  readonly sourceChapterNumbers: ReadonlyArray<number>;
  readonly scenes: ReadonlyArray<ScriptWorkspaceScene>;
  readonly characters: ReadonlyArray<ScriptWorkspaceEntity>;
  readonly props: ReadonlyArray<ScriptWorkspaceEntity>;
  readonly assets: ReadonlyArray<ScriptWorkspaceEntity>;
}

interface ExtractionEntityRowProps {
  readonly label: string;
  readonly items: ReadonlyArray<string>;
}

function ExtractionEntityRow({ label, items }: ExtractionEntityRowProps) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex flex-wrap gap-2">
        {items.length > 0 ? items.map((item) => (
          <span key={`${label}-${item}`} className="rounded-full border border-border/30 bg-background/50 px-2 py-1 text-xs">
            {item}
          </span>
        )) : (
          <span className="text-xs text-muted-foreground">暂无</span>
        )}
      </div>
    </div>
  );
}

function formatExtractionGroupStats(group: ScriptExtractionGroup): string {
  return `场景 ${group.scenes.length} / 角色 ${group.characters.length} / 道具 ${group.props.length} / 素材 ${group.assets.length}`;
}

function defaultExpandedExtractionGroupKeys(groups: ReadonlyArray<ScriptExtractionGroup>): string[] {
  return groups.length > 0 ? [groups[0]!.key] : [];
}

interface WorkflowStep {
  readonly id: ScriptWorkflowStepId;
  readonly title: string;
  readonly hint: string;
}

const SCRIPT_WORKFLOW_STEPS: ReadonlyArray<WorkflowStep> = [
  { id: "chapters", title: "选章", hint: "先确定小说范围，再生成内容。" },
  { id: "config", title: "配置", hint: "设置生成策略、风格和时长。" },
  { id: "checklist", title: "任务", hint: "管理人工审核、补充和确认。" },
  { id: "review", title: "结果", hint: "查看按章/按集提取结果与剧本。" },
];

function getAdjacentWorkflowStep(stepId: ScriptWorkflowStepId, direction: "prev" | "next"): ScriptWorkflowStepId {
  const index = SCRIPT_WORKFLOW_STEPS.findIndex((step) => step.id === stepId);
  const nextIndex = direction === "next" ? index + 1 : index - 1;
  if (nextIndex < 0 || nextIndex >= SCRIPT_WORKFLOW_STEPS.length) return stepId;
  return SCRIPT_WORKFLOW_STEPS[nextIndex]!.id;
}

export function buildScriptWorkspaceExtractionGroups(
  workspace: ScriptWorkspace,
  chapters: BookData["chapters"],
  mode: ScriptExtractionViewMode,
): ReadonlyArray<ScriptExtractionGroup> {
  const chapterMap = new Map(chapters.map((chapter) => [chapter.number, chapter]));
  if (mode === "episode") {
    return workspace.episodes.map((episode) => {
      const sourceChapterNumbers = resolveItemSourceChapterNumbers(episode);
      return {
        key: `episode-${episode.episodeNumber}`,
        title: episode.title,
        subtitle: `${formatChapterNumbers(sourceChapterNumbers)} · ${episode.durationSec} 秒`,
        sourceChapterNumbers,
        scenes: workspace.extraction.scenes.filter((scene) => scene.episodeNumber === episode.episodeNumber),
        characters: workspace.extraction.characters.filter((item) => intersectsNumbers(resolveItemSourceChapterNumbers(item), sourceChapterNumbers)),
        props: workspace.extraction.props.filter((item) => intersectsNumbers(resolveItemSourceChapterNumbers(item), sourceChapterNumbers)),
        assets: workspace.extraction.assets.filter((item) => intersectsNumbers(resolveItemSourceChapterNumbers(item), sourceChapterNumbers)),
      };
    });
  }

  const selectedChapterNumbers = workspace.selectedChapterNumbers.length > 0
    ? uniqueSortedNumbers(workspace.selectedChapterNumbers)
    : chapters.map((chapter) => chapter.number);

  return selectedChapterNumbers.map((chapterNumber) => {
    const chapter = chapterMap.get(chapterNumber);
    const sourceChapterNumbers = [chapterNumber];
    return {
      key: `chapter-${chapterNumber}`,
      title: chapter ? `第${chapterNumber}章 ${chapter.title}` : `第${chapterNumber}章`,
      subtitle: formatExtractionSourceLabel(sourceChapterNumbers, mode),
      sourceChapterNumbers,
      scenes: workspace.extraction.scenes.filter((scene) => intersectsNumbers(resolveItemSourceChapterNumbers(scene), sourceChapterNumbers)),
      characters: workspace.extraction.characters.filter((item) => intersectsNumbers(resolveItemSourceChapterNumbers(item), sourceChapterNumbers)),
      props: workspace.extraction.props.filter((item) => intersectsNumbers(resolveItemSourceChapterNumbers(item), sourceChapterNumbers)),
      assets: workspace.extraction.assets.filter((item) => intersectsNumbers(resolveItemSourceChapterNumbers(item), sourceChapterNumbers)),
    };
  });
}

interface ChapterSelectionGridProps {
  readonly chapters: BookData["chapters"];
  readonly selectedChapterNumbers: ReadonlyArray<number>;
  readonly onToggleChapter: (chapterNumber: number) => void;
  readonly onSelectAll: () => void;
  readonly onClearAll: () => void;
}

function ChapterSelectionGrid({
  chapters,
  selectedChapterNumbers,
  onToggleChapter,
  onSelectAll,
  onClearAll,
}: ChapterSelectionGridProps) {
  const selectedSet = new Set(selectedChapterNumbers);
  const allSelected = chapters.length > 0 && selectedSet.size === chapters.length;

  return (
    <section className="rounded-2xl border border-border/40 bg-card/50 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">章节选择</div>
          <div className="text-xs text-muted-foreground">
            已选 {selectedSet.size} / {chapters.length}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onSelectAll}
            disabled={allSelected || chapters.length === 0}
            className="rounded-lg border border-border/40 bg-background/60 px-3 py-1.5 text-xs hover:bg-background/80 disabled:opacity-50"
          >
            全选
          </button>
          <button
            type="button"
            onClick={onClearAll}
            disabled={selectedSet.size === 0}
            className="rounded-lg border border-border/40 bg-background/60 px-3 py-1.5 text-xs hover:bg-background/80 disabled:opacity-50"
          >
            取消全选
          </button>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {chapters.map((chapter) => {
          const checked = selectedSet.has(chapter.number);
          return (
            <label
              key={chapter.number}
              className={`flex items-start gap-3 rounded-xl border px-3 py-2 text-sm transition-colors ${
                checked ? "border-primary/30 bg-primary/5" : "border-border/30 bg-background/40"
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggleChapter(chapter.number)}
                className="mt-1"
              />
              <span className="min-w-0 flex-1 truncate">
                第{chapter.number}章 {chapter.title}
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

interface ScriptWorkspacePanelProps {
  readonly bookTitle: string;
  readonly chapters: BookData["chapters"];
  readonly workspace: ScriptWorkspace | null;
  readonly saving: boolean;
  readonly generating: boolean;
  readonly checklistItems: ReadonlyArray<TaskChecklistItem>;
  readonly checklistTemplates: ReadonlyArray<TaskChecklistTemplateSummary>;
  readonly checklistTemplateId: string;
  readonly checklistProgress: { readonly done: number; readonly total: number };
  readonly checklistInput: string;
  readonly checklistNote: string;
  readonly checklistSaving: boolean;
  readonly onChange: (workspace: ScriptWorkspace) => void;
  readonly onSave: () => void;
  readonly onGenerate: () => void;
  readonly onOpenHistory: () => void;
  readonly onChecklistInputChange: (value: string) => void;
  readonly onChecklistNoteChange: (value: string) => void;
  readonly onChecklistAdd: () => void;
  readonly onChecklistTemplateChange: (templateId: string) => void;
  readonly onChecklistToggle: (itemId: string, done: boolean) => void;
  readonly onChecklistRemove: (itemId: string) => void;
  readonly onChecklistGenerate: () => void;
  readonly onChecklistSave: () => void;
}

interface ProductionWorkspacePanelProps {
  readonly bookId: string;
  readonly workspace: ProductionWorkspace | null;
  readonly directorPlan: DirectorPlan | null;
  readonly assetLibrary: AssetLibrary | null;
  readonly generating: boolean;
  readonly saving: boolean;
  readonly directorPlanGenerating: boolean;
  readonly directorPlanSaving: boolean;
  readonly assetLibraryGenerating: boolean;
  readonly assetLibrarySaving: boolean;
  readonly onChange: (workspace: ProductionWorkspace) => void;
  readonly onDirectorPlanChange: (plan: DirectorPlan) => void;
  readonly onAssetLibraryChange: (library: AssetLibrary) => void;
  readonly onGenerate: () => void;
  readonly onSave: () => void;
  readonly onOpenDirectorPlanHistory: () => void;
  readonly onOpenAssetLibraryHistory: () => void;
  readonly onGenerateDirectorPlan: () => void;
  readonly onSaveDirectorPlan: () => void;
  readonly onGenerateAssetLibrary: () => void;
  readonly onSaveAssetLibrary: () => void;
  readonly onUploadAssetLibraryFile: (itemId: string, kind: "thumbnail" | "file", file: File) => Promise<void>;
}

function ScriptWorkspacePanel({
  bookTitle,
  chapters,
  workspace,
  saving,
  generating,
  checklistItems,
  checklistTemplates,
  checklistTemplateId,
  checklistProgress,
  checklistInput,
  checklistNote,
  checklistSaving,
  onChange,
  onSave,
  onGenerate,
  onOpenHistory,
  onChecklistInputChange,
  onChecklistNoteChange,
  onChecklistAdd,
  onChecklistTemplateChange,
  onChecklistToggle,
  onChecklistRemove,
  onChecklistGenerate,
  onChecklistSave,
}: ScriptWorkspacePanelProps) {
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [extractionViewMode, setExtractionViewMode] = useState<ScriptExtractionViewMode>("episode");
  const [expandedExtractionGroupKeys, setExpandedExtractionGroupKeys] = useState<ReadonlyArray<string>>([]);
  const [workflowStep, setWorkflowStep] = useState<ScriptWorkflowStepId>("chapters");

  if (!workspace) {
    return (
      <div className="rounded-2xl border border-border/40 bg-card/40 p-6 text-sm text-muted-foreground">
        剧本工作区加载中...
      </div>
    );
  }

  const patchWorkspace = (updater: (current: ScriptWorkspace) => ScriptWorkspace) => {
    onChange(updater(workspace));
  };
  const toggleChapter = (chapterNumber: number) => {
    patchWorkspace((current) => {
      const selectedSet = new Set(current.selectedChapterNumbers);
      const nextSelected = selectedSet.has(chapterNumber)
        ? current.selectedChapterNumbers.filter((num) => num !== chapterNumber)
        : [...current.selectedChapterNumbers, chapterNumber].sort((left, right) => left - right);
      return {
        ...current,
        selectedChapterNumbers: nextSelected,
        updatedAt: new Date().toISOString(),
      };
    });
  };
  const updateConfig = (patch: Partial<ScriptWorkspaceConfig>) => {
    patchWorkspace((current) => ({
      ...current,
      config: {
        ...current.config,
        ...patch,
      },
      updatedAt: new Date().toISOString(),
    }));
  };
  const updatePrompt = (key: keyof ScriptWorkspaceConfig["scriptPrompts"], value: string) => {
    patchWorkspace((current) => ({
      ...current,
      config: {
        ...current.config,
        scriptPrompts: {
          ...current.config.scriptPrompts,
          [key]: value,
        },
      },
      updatedAt: new Date().toISOString(),
    }));
  };

  const sceneCount = workspace.extraction.scenes.length;
  const episodeCount = workspace.episodes.length;
  const segmentCount = workspace.episodes.reduce((sum, episode) => sum + episode.segments.length, 0);
  const selectedSet = new Set(workspace.selectedChapterNumbers);
  const selectionSummary = workspace.selectedChapterNumbers.length > 0
    ? formatChapterNumbers(uniqueSortedNumbers(workspace.selectedChapterNumbers))
    : "未选择章节";
  const extractionGroups = useMemo(
    () => buildScriptWorkspaceExtractionGroups(workspace, chapters, extractionViewMode),
    [chapters, extractionViewMode, workspace],
  );
  const stepIndex = Math.max(0, SCRIPT_WORKFLOW_STEPS.findIndex((step) => step.id === workflowStep));
  const currentStep = SCRIPT_WORKFLOW_STEPS[stepIndex] ?? SCRIPT_WORKFLOW_STEPS[0]!;
  const isFirstStep = workflowStep === SCRIPT_WORKFLOW_STEPS[0]?.id;
  const isLastStep = workflowStep === SCRIPT_WORKFLOW_STEPS[SCRIPT_WORKFLOW_STEPS.length - 1]?.id;
  useEffect(() => {
    setExpandedExtractionGroupKeys(defaultExpandedExtractionGroupKeys(extractionGroups));
  }, [extractionGroups, extractionViewMode]);
  const handleCopyText = async (text: string, successMessage: string) => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("当前环境不支持剪贴板复制");
      }
      await navigator.clipboard.writeText(text);
      setActionMessage(successMessage);
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "复制失败");
    }
  };
  const handleExportText = (filename: string, content: string, successMessage: string) => {
    try {
      downloadTextFile(filename, content);
      setActionMessage(successMessage);
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "导出失败");
    }
  };
  const selectAllChapters = () => {
    patchWorkspace((current) => ({
      ...current,
      selectedChapterNumbers: chapters.map((chapter) => chapter.number),
      updatedAt: new Date().toISOString(),
    }));
  };
  const clearAllChapters = () => {
    patchWorkspace((current) => ({
      ...current,
      selectedChapterNumbers: [],
      updatedAt: new Date().toISOString(),
    }));
  };
  const toggleExtractionGroupExpanded = (groupKey: string) => {
    setExpandedExtractionGroupKeys((current) => (
      current.includes(groupKey)
        ? current.filter((key) => key !== groupKey)
        : [...current, groupKey]
    ));
  };

  return (
    <div className="h-full space-y-4 overflow-y-auto pr-1">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/40 bg-card/60 p-4">
        <div>
          <div className="text-lg font-semibold">小说转剧本</div>
          <div className="text-xs text-muted-foreground">主流程：选章 &gt; 配置 &gt; 任务 &gt; 结果</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {selectionSummary} / 场景 {sceneCount} / 集 {episodeCount} / 段 {segmentCount}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onOpenHistory}
            className="rounded-xl border border-border/40 bg-background/60 px-4 py-2 text-sm font-medium hover:bg-background/80"
          >
            版本历史
          </button>
          {workflowStep === "chapters" ? (
            <>
              <button
                type="button"
                onClick={selectAllChapters}
                disabled={chapters.length === 0 || selectedSet.size === chapters.length}
                className="rounded-xl border border-border/40 bg-background/60 px-4 py-2 text-sm font-medium hover:bg-background/80 disabled:opacity-50"
              >
                全选章节
              </button>
              <button
                type="button"
                onClick={clearAllChapters}
                disabled={selectedSet.size === 0}
                className="rounded-xl border border-border/40 bg-background/60 px-4 py-2 text-sm font-medium hover:bg-background/80 disabled:opacity-50"
              >
                清空章节
              </button>
              <button
                type="button"
                onClick={() => setWorkflowStep("config")}
                className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/15"
              >
                下一步：配置
              </button>
            </>
          ) : null}
          {workflowStep === "config" ? (
            <>
              <button
                type="button"
                onClick={onGenerate}
                disabled={generating}
                className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/15 disabled:opacity-50"
              >
                {generating ? "生成中..." : "生成剧本"}
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={saving}
                className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {saving ? "保存中..." : "保存剧本"}
              </button>
              <button
                type="button"
                onClick={() => setWorkflowStep("checklist")}
                className="rounded-xl border border-border/40 bg-background/60 px-4 py-2 text-sm font-medium hover:bg-background/80"
              >
                下一步：任务
              </button>
            </>
          ) : null}
          {workflowStep === "checklist" ? (
            <>
              <button
                type="button"
                onClick={onChecklistGenerate}
                disabled={checklistSaving}
                className="rounded-xl border border-border/40 bg-background/60 px-4 py-2 text-sm font-medium hover:bg-background/80 disabled:opacity-50"
              >
                生成基础模板
              </button>
              <button
                type="button"
                onClick={onChecklistSave}
                disabled={checklistSaving}
                className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {checklistSaving ? "保存中..." : "保存清单"}
              </button>
              <button
                type="button"
                onClick={() => setWorkflowStep("review")}
                className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/15"
              >
                下一步：结果
              </button>
            </>
          ) : null}
          {workflowStep === "review" ? (
            <>
              <button
                type="button"
                onClick={() => handleExportText(
                  buildScriptWorkspaceExportFileName(bookTitle, "全部视频提示词"),
                  buildWorkspaceVideoPromptExportText(workspace),
                  "已导出全部图生视频提示词",
                )}
                className="rounded-xl border border-border/40 bg-background/60 px-4 py-2 text-sm font-medium hover:bg-background/80"
              >
                导出全部提示词
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={saving}
                className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {saving ? "保存中..." : "保存剧本"}
              </button>
              <button
                type="button"
                onClick={() => setWorkflowStep("config")}
                className="rounded-xl border border-border/40 bg-background/60 px-4 py-2 text-sm font-medium hover:bg-background/80"
              >
                回到配置
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div className="rounded-xl border border-dashed border-border/40 bg-background/40 px-4 py-3 text-xs text-muted-foreground">
        {workflowStep === "chapters" ? "先确定选章范围，再进入配置。" : null}
        {workflowStep === "config" ? "配置完成后可以直接生成剧本。生成和保存是两件事。" : null}
        {workflowStep === "checklist" ? "任务清单用于人工补充和复核，不参与生成。" : null}
        {workflowStep === "review" ? "这里查看提取结果，并按集/按章导出提示词。" : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        {SCRIPT_WORKFLOW_STEPS.map((step, index) => {
          const active = workflowStep === step.id;
          const done = index < stepIndex;
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => setWorkflowStep(step.id)}
              className={`rounded-2xl border p-3 text-left transition-colors ${
                active ? "border-primary/30 bg-primary/5" : "border-border/40 bg-card/50 hover:bg-background/70"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className={`text-sm font-medium ${active ? "text-primary" : ""}`}>
                  {index + 1}. {step.title}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {done ? "已完成" : active ? "进行中" : "待处理"}
                </div>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{step.hint}</div>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border/40 bg-background/50 px-4 py-3 text-xs text-muted-foreground">
        <span>当前步骤：{currentStep.title}</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setWorkflowStep(getAdjacentWorkflowStep(workflowStep, "prev"))}
            disabled={isFirstStep}
            className="rounded-lg border border-border/40 bg-background/60 px-3 py-1.5 disabled:opacity-50"
          >
            上一步
          </button>
          <button
            type="button"
            onClick={() => setWorkflowStep(getAdjacentWorkflowStep(workflowStep, "next"))}
            disabled={isLastStep}
            className="rounded-lg border border-border/40 bg-background/60 px-3 py-1.5 disabled:opacity-50"
          >
            下一步
          </button>
        </div>
      </div>
      {actionMessage ? (
        <div className="rounded-xl border border-border/40 bg-background/50 px-4 py-2 text-xs text-muted-foreground">
          {actionMessage}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)]">
        <div className="space-y-4">
          {workflowStep === "chapters" ? (
            <ChapterSelectionGrid
              chapters={chapters}
              selectedChapterNumbers={workspace.selectedChapterNumbers}
              onToggleChapter={toggleChapter}
              onSelectAll={selectAllChapters}
              onClearAll={clearAllChapters}
            />
          ) : null}

          {workflowStep === "config" ? (
            <section className="rounded-2xl border border-border/40 bg-card/50 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">生成配置</div>
                  <div className="text-xs text-muted-foreground">这是生成参数，不是任务清单。</div>
                </div>
                <div className="rounded-full border border-border/30 bg-background/50 px-3 py-1 text-xs text-muted-foreground">
                  向导步骤 2 / 4
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1 text-xs">
                  <div className="text-muted-foreground">生成策略</div>
                  <select
                    value={workspace.config.generationStrategy ?? "chapter"}
                    onChange={(event) => updateConfig({ generationStrategy: event.target.value === "episode" ? "episode" : "chapter" })}
                    className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                  >
                    <option value="chapter">按章生成</option>
                    <option value="episode">按集生成</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs">
                  <div className="text-muted-foreground">每集合并章节数</div>
                  <input
                    type="number"
                    min={1}
                    value={workspace.config.chaptersPerEpisode ?? 2}
                    onChange={(event) => updateConfig({ chaptersPerEpisode: Number(event.target.value) })}
                    className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <div className="text-muted-foreground">视觉风格</div>
                  <textarea
                    value={workspace.config.visualStyle}
                    onChange={(event) => updateConfig({ visualStyle: event.target.value })}
                    rows={3}
                    className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <div className="text-muted-foreground">导演手法</div>
                  <textarea
                    value={workspace.config.directorMethod}
                    onChange={(event) => updateConfig({ directorMethod: event.target.value })}
                    rows={3}
                    className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <div className="text-muted-foreground">AI 工具</div>
                  <input
                    value={workspace.config.aiTool}
                    onChange={(event) => updateConfig({ aiTool: event.target.value })}
                    className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <div className="text-muted-foreground">AI 模型</div>
                  <input
                    value={workspace.config.aiModel}
                    onChange={(event) => updateConfig({ aiModel: event.target.value })}
                    className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <div className="text-muted-foreground">每集时长（秒）</div>
                  <input
                    type="number"
                    min={30}
                    value={workspace.config.episodeDurationSec}
                    onChange={(event) => updateConfig({ episodeDurationSec: Number(event.target.value) })}
                    className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <div className="text-muted-foreground">每段目标时长（秒）</div>
                  <input
                    type="number"
                    min={5}
                    value={workspace.config.segmentDurationSec}
                    onChange={(event) => updateConfig({ segmentDurationSec: Number(event.target.value) })}
                    className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <div className="text-muted-foreground">每段最小时长</div>
                  <input
                    type="number"
                    min={1}
                    value={workspace.config.segmentDurationMinSec}
                    onChange={(event) => updateConfig({ segmentDurationMinSec: Number(event.target.value) })}
                    className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <div className="text-muted-foreground">每段最大时长</div>
                  <input
                    type="number"
                    min={1}
                    value={workspace.config.segmentDurationMaxSec}
                    onChange={(event) => updateConfig({ segmentDurationMaxSec: Number(event.target.value) })}
                    className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                </label>
              </div>
              <div className="grid gap-3">
                <label className="space-y-1 text-xs">
                  <div className="text-muted-foreground">剧本生成提示词</div>
                  <textarea
                    value={workspace.config.scriptPrompts.script}
                    onChange={(event) => updatePrompt("script", event.target.value)}
                    rows={3}
                    className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <div className="text-muted-foreground">文生图提示词</div>
                  <textarea
                    value={workspace.config.scriptPrompts.image}
                    onChange={(event) => updatePrompt("image", event.target.value)}
                    rows={3}
                    className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <div className="text-muted-foreground">图生视频提示词</div>
                  <textarea
                    value={workspace.config.scriptPrompts.video}
                    onChange={(event) => updatePrompt("video", event.target.value)}
                    rows={3}
                    className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setWorkflowStep("checklist")}
                  className="rounded-xl border border-border/40 bg-background/60 px-4 py-2 text-sm hover:bg-background/80"
                >
                  下一步：任务
                </button>
              </div>
            </section>
          ) : null}
        </div>

        <div className="space-y-4">
          {workflowStep === "checklist" ? (
            <section className="rounded-2xl border border-border/40 bg-card/50 p-4 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">任务清单</div>
                  <div className="text-xs text-muted-foreground">这里管理待办与执行状态，不负责生成结果。</div>
                </div>
                <div className="text-xs text-muted-foreground">
                  进度 {checklistProgress.done}/{checklistProgress.total}
                </div>
              </div>
            <div className="space-y-2">
              <label className="space-y-1 text-xs">
                <div className="text-muted-foreground">模板</div>
                <select
                  value={checklistTemplateId}
                  onChange={(event) => onChecklistTemplateChange(event.target.value)}
                  className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                >
                  {checklistTemplates.map((template) => (
                    <option key={template.id} value={template.id}>{template.label}</option>
                  ))}
                </select>
                {checklistTemplates.find((template) => template.id === checklistTemplateId)?.description ? (
                  <div className="text-[11px] text-muted-foreground">
                    {checklistTemplates.find((template) => template.id === checklistTemplateId)?.description}
                  </div>
                ) : null}
              </label>
              {checklistItems.map((item) => (
                <div key={item.id} className="rounded-xl border border-border/30 bg-background/45 p-3">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={item.done}
                      onChange={(event) => onChecklistToggle(item.id, event.target.checked)}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm ${item.done ? "text-muted-foreground line-through" : "font-medium"}`}>{item.text}</div>
                      {item.note ? <div className="mt-1 text-xs text-muted-foreground">{item.note}</div> : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => onChecklistRemove(item.id)}
                      className="text-xs text-destructive hover:underline"
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
              {checklistItems.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/40 px-4 py-6 text-center text-sm text-muted-foreground">
                  还没有任务条目，先生成模板或手动添加。
                </div>
              ) : null}
            </div>
            <div className="grid gap-2">
              <label className="space-y-1 text-xs">
                <div className="text-muted-foreground">新增任务</div>
                <input
                  value={checklistInput}
                  onChange={(event) => onChecklistInputChange(event.target.value)}
                  placeholder="例如：校对图生视频提示词"
                  className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                />
              </label>
              <label className="space-y-1 text-xs">
                <div className="text-muted-foreground">备注</div>
                <input
                  value={checklistNote}
                  onChange={(event) => onChecklistNoteChange(event.target.value)}
                  placeholder="可选备注"
                  className="w-full rounded-xl border border-border/40 bg-background/60 px-3 py-2 text-sm outline-none"
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onChecklistAdd}
                disabled={checklistSaving || !checklistInput.trim()}
                className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                添加任务
              </button>
              <button
                type="button"
                onClick={onChecklistGenerate}
                disabled={checklistSaving}
                className="rounded-xl border border-border/40 bg-background/60 px-4 py-2 text-sm hover:bg-background/80 disabled:opacity-50"
              >
                生成基础模板
              </button>
              <button
                type="button"
                onClick={onChecklistSave}
                disabled={checklistSaving}
                className="rounded-xl border border-border/40 bg-background/60 px-4 py-2 text-sm hover:bg-background/80 disabled:opacity-50"
              >
                {checklistSaving ? "保存中..." : "保存清单"}
              </button>
            </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setWorkflowStep("review")}
                  className="rounded-xl border border-border/40 bg-background/60 px-4 py-2 text-sm hover:bg-background/80"
                >
                  下一步：结果
                </button>
              </div>
            </section>
          ) : null}

          {workflowStep === "review" ? (
            <section className="rounded-2xl border border-border/40 bg-card/50 p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">提取结果</div>
                  <div className="text-xs text-muted-foreground">按章节 / 按集查看场景、角色、道具、素材。</div>
                </div>
                <div className="flex items-center gap-2 rounded-full border border-border/30 bg-background/50 p-1 text-xs">
                  <button
                    type="button"
                    onClick={() => setExtractionViewMode("episode")}
                    className={`rounded-full px-3 py-1 ${extractionViewMode === "episode" ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}
                  >
                    按集
                  </button>
                  <button
                    type="button"
                    onClick={() => setExtractionViewMode("chapter")}
                    className={`rounded-full px-3 py-1 ${extractionViewMode === "chapter" ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}
                  >
                    按章
                  </button>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                {extractionGroups.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border/40 px-4 py-6 text-center text-sm text-muted-foreground">
                    还没有提取结果，先生成剧本。
                  </div>
                ) : extractionGroups.map((group) => (
                  <div key={group.key} className="rounded-xl border border-border/30 bg-background/45 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium">{group.title}</div>
                        <div className="text-[11px] text-muted-foreground">{group.subtitle}</div>
                        <div className="mt-1 text-[11px] text-muted-foreground">{formatExtractionGroupStats(group)}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-[11px] text-muted-foreground">
                          来源：{formatChapterNumbers(group.sourceChapterNumbers)}
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleExtractionGroupExpanded(group.key)}
                          className="rounded-lg border border-border/30 bg-background/60 px-3 py-1 text-[11px] hover:bg-background/80"
                        >
                          {expandedExtractionGroupKeys.includes(group.key) ? "收起" : "展开"}
                        </button>
                      </div>
                    </div>
                    {expandedExtractionGroupKeys.includes(group.key) ? (
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <ExtractionEntityRow label="场景" items={group.scenes.map((scene) => scene.title)} />
                        <ExtractionEntityRow label="角色" items={group.characters.map((item) => item.name)} />
                        <ExtractionEntityRow label="道具" items={group.props.map((item) => item.name)} />
                        <ExtractionEntityRow label="素材" items={group.assets.map((item) => item.name)} />
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="space-y-3">
            {workspace.episodes.map((episode) => (
              <div key={episode.episodeNumber} className="rounded-2xl border border-border/40 bg-card/50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">{episode.title}</div>
                    <div className="text-xs text-muted-foreground">第{episode.chapterNumber}章 · {episode.durationSec} 秒</div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <div className="text-xs text-muted-foreground">{episode.segments.length} 段</div>
                    <button
                      type="button"
                      onClick={() => void handleCopyText(
                        buildEpisodeVideoPromptExportText(episode),
                        `已复制 ${episode.title} 图生视频提示词`,
                      )}
                      className="rounded-lg border border-border/40 bg-background/60 px-3 py-1.5 text-xs hover:bg-background/80"
                    >
                      复制本集提示词
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportText(
                        buildScriptWorkspaceExportFileName(bookTitle, `${episode.title}-视频提示词`),
                        buildEpisodeVideoPromptExportText(episode),
                        `已导出 ${episode.title} 图生视频提示词`,
                      )}
                      className="rounded-lg border border-border/40 bg-background/60 px-3 py-1.5 text-xs hover:bg-background/80"
                    >
                      导出本集提示词
                    </button>
                  </div>
                </div>
                <div className="mt-3 space-y-3">
                  {episode.segments.map((segment) => (
                    <div key={segment.id} className="rounded-xl border border-border/30 bg-background/45 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium">{segment.title}</div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <div className="text-xs text-muted-foreground">{segment.durationSec} 秒</div>
                          <button
                            type="button"
                            onClick={() => void handleCopyText(segment.textToImagePrompt, `已复制 ${segment.title} 文生图提示词`)}
                            className="rounded-lg border border-border/40 bg-background/60 px-3 py-1.5 text-xs hover:bg-background/80"
                          >
                            复制文生图
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleCopyText(segment.imageToVideoPrompt, `已复制 ${segment.title} 图生视频提示词`)}
                            className="rounded-lg border border-border/40 bg-background/60 px-3 py-1.5 text-xs hover:bg-background/80"
                          >
                            复制图生视频
                          </button>
                        </div>
                      </div>
                      <div className="mt-2 grid gap-2">
                        <textarea readOnly value={segment.scriptText} rows={3} className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-xs" />
                        <textarea readOnly value={segment.textToImagePrompt} rows={3} className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-xs" />
                        <textarea readOnly value={segment.imageToVideoPrompt} rows={3} className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-xs" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

export function ProductionWorkspacePanel({
  bookId,
  workspace,
  directorPlan,
  assetLibrary,
  generating,
  saving,
  directorPlanGenerating,
  directorPlanSaving,
  assetLibraryGenerating,
  assetLibrarySaving,
  onChange,
  onDirectorPlanChange,
  onAssetLibraryChange,
  onGenerate,
  onSave,
  onOpenDirectorPlanHistory,
  onOpenAssetLibraryHistory,
  onGenerateDirectorPlan,
  onSaveDirectorPlan,
  onGenerateAssetLibrary,
  onSaveAssetLibrary,
  onUploadAssetLibraryFile,
}: ProductionWorkspacePanelProps) {
  if (!workspace) {
    return (
      <div className="rounded-2xl border border-border/40 bg-card/40 p-6 text-sm text-muted-foreground">
        生产工作区加载中...
      </div>
    );
  }

  const shotCount = workspace.episodes.reduce((sum, episode) => sum + episode.shots.length, 0);
  const patchWorkspace = (updater: (current: ProductionWorkspace) => ProductionWorkspace) => {
    onChange(updater(workspace));
  };
  const updateEpisode = (episodeNumber: number, patch: Partial<ProductionEpisode>) => {
    patchWorkspace((current) => updateProductionWorkspaceEpisode(current, episodeNumber, (episode) => ({
      ...episode,
      ...patch,
    })));
  };
  const updateShot = (shotId: string, patch: Partial<ProductionShot>) => {
    patchWorkspace((current) => updateProductionWorkspaceShot(current, shotId, (shot) => ({
      ...shot,
      ...patch,
    })));
  };
  const updateShotList = (
    shotId: string,
    field: "characters" | "props" | "assets",
    rawValue: string,
  ) => {
    const nextValue = normalizeEditableStringList(rawValue);
    if (field === "characters") {
      updateShot(shotId, { characters: nextValue });
      return;
    }
    if (field === "props") {
      updateShot(shotId, { props: nextValue });
      return;
    }
    updateShot(shotId, { assets: nextValue });
  };
  const dialogueOptions: ReadonlyArray<{ value: ProductionDialogueType; label: string }> = [
    { value: "none", label: "无对白" },
    { value: "dialogue", label: "对白" },
    { value: "inner_monologue", label: "内心独白" },
    { value: "voiceover", label: "画外音" },
  ];
  const [shotSearch, setShotSearch] = useState("");
  const [shotDialogueFilter, setShotDialogueFilter] = useState<ProductionShotViewOptions["dialogueType"]>("all");
  const [shotImageFilter, setShotImageFilter] = useState<ProductionShotViewOptions["imageFilter"]>("all");
  const [shotSortMode, setShotSortMode] = useState<ProductionShotSortMode>("shot-number");
  const [bulkDialogueType, setBulkDialogueType] = useState<ProductionDialogueType>("dialogue");
  const [bulkShouldGenerateImage, setBulkShouldGenerateImage] = useState<"enable" | "disable">("enable");
  const [bulkAddCharacters, setBulkAddCharacters] = useState("");
  const [bulkRemoveCharacters, setBulkRemoveCharacters] = useState("");
  const [bulkAddProps, setBulkAddProps] = useState("");
  const [bulkRemoveProps, setBulkRemoveProps] = useState("");
  const [bulkAddAssets, setBulkAddAssets] = useState("");
  const [bulkRemoveAssets, setBulkRemoveAssets] = useState("");
  const visibleEpisodes = useMemo(() => (
    workspace.episodes.map((episode) => ({
      ...episode,
      shots: filterAndSortProductionShots(episode.shots, {
        search: shotSearch,
        dialogueType: shotDialogueFilter,
        imageFilter: shotImageFilter,
        sortMode: shotSortMode,
      }),
    }))
  ), [shotDialogueFilter, shotImageFilter, shotSearch, shotSortMode, workspace.episodes]);
  const visibleShotCount = visibleEpisodes.reduce((sum, episode) => sum + episode.shots.length, 0);
  const visibleShotIds = useMemo(() => visibleEpisodes.flatMap((episode) => episode.shots.map((shot) => shot.id)), [visibleEpisodes]);
  const handleBulkApply = (patch: ProductionShotBulkPatch) => {
    if (visibleShotIds.length === 0) return;
    patchWorkspace((current) => applyBulkUpdateToProductionShots(current, visibleShotIds, patch));
  };
  const handleMoveShot = (episodeNumber: number, shotId: string, direction: ProductionShotMoveDirection) => {
    patchWorkspace((current) => reorderProductionEpisodeShots(current, episodeNumber, shotId, direction));
  };
  const patchDirectorPlan = (updater: (current: DirectorPlan) => DirectorPlan) => {
    if (!directorPlan) return;
    onDirectorPlanChange({
      ...updater(directorPlan),
      updatedAt: new Date().toISOString(),
    });
  };
  const patchAssetLibrary = (updater: (current: AssetLibrary) => AssetLibrary) => {
    if (!assetLibrary) return;
    onAssetLibraryChange({
      ...updater(assetLibrary),
      updatedAt: new Date().toISOString(),
    });
  };
  const assetStatusOptions: ReadonlyArray<{ value: AssetLibraryItemStatus; label: string }> = [
    { value: "draft", label: "draft" },
    { value: "prompt_ready", label: "prompt_ready" },
    { value: "image_generating", label: "image_generating" },
    { value: "image_ready", label: "image_ready" },
    { value: "video_generating", label: "video_generating" },
    { value: "video_ready", label: "video_ready" },
    { value: "rejected", label: "rejected" },
  ];
  const resolveAssetLibraryFileUrl = (path: string): string => (
    `/api/v1/books/${encodeURIComponent(bookId)}/asset-library/file?path=${encodeURIComponent(path)}`
  );
  return (
    <div className="h-full space-y-4 overflow-y-auto pr-1">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/40 bg-card/60 p-4">
        <div>
          <div className="text-lg font-semibold">生产工作台</div>
          <div className="text-xs text-muted-foreground">
            章节 {workspace.selectedChapterNumbers.length} / 集 {workspace.episodes.length} / 镜头 {visibleShotCount}/{shotCount}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onGenerate}
            disabled={generating}
            className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/15 disabled:opacity-50"
          >
            {generating ? "生成中..." : "生成分镜表"}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "保存中..." : "保存分镜表"}
          </button>
        </div>
      </div>

      <section className="rounded-2xl border border-border/40 bg-card/50 p-4">
        <div className="mb-4 grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_repeat(3,minmax(0,0.45fr))]">
          <label className="space-y-1 text-xs">
            <div className="text-muted-foreground">搜索镜头</div>
            <input
              value={shotSearch}
              onChange={(event) => setShotSearch(event.target.value)}
              placeholder="标题 / 场景 / 角色 / 道具 / 提示词"
              className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
            />
          </label>
          <label className="space-y-1 text-xs">
            <div className="text-muted-foreground">对白筛选</div>
            <select
              value={shotDialogueFilter}
              onChange={(event) => setShotDialogueFilter(event.target.value as ProductionShotViewOptions["dialogueType"])}
              className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
            >
              <option value="all">全部</option>
              {dialogueOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <div className="text-muted-foreground">出图筛选</div>
            <select
              value={shotImageFilter}
              onChange={(event) => setShotImageFilter(event.target.value as ProductionShotViewOptions["imageFilter"])}
              className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
            >
              <option value="all">全部</option>
              <option value="generate-only">仅出图镜头</option>
              <option value="skip-image">仅跳过出图</option>
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <div className="text-muted-foreground">排序</div>
            <select
              value={shotSortMode}
              onChange={(event) => setShotSortMode(event.target.value as ProductionShotSortMode)}
              className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
            >
              <option value="shot-number">按镜头号</option>
              <option value="duration-desc">按时长降序</option>
              <option value="duration-asc">按时长升序</option>
              <option value="scene">按场景</option>
              <option value="dialogue-first">对白优先</option>
            </select>
            <div className="text-[11px] text-muted-foreground">
              镜头重排仅在“按镜头号”排序下可用
            </div>
          </label>
        </div>
        <div className="mb-4 rounded-xl border border-border/30 bg-background/35 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">批量操作当前筛选结果</div>
            <div className="text-xs text-muted-foreground">命中 {visibleShotIds.length} 个镜头</div>
          </div>
          <div className="grid gap-3 xl:grid-cols-4">
            <label className="space-y-1 text-xs">
              <div className="text-muted-foreground">批量对白类型</div>
              <select
                value={bulkDialogueType}
                onChange={(event) => setBulkDialogueType(event.target.value as ProductionDialogueType)}
                className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
              >
                {dialogueOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => handleBulkApply({ dialogueType: bulkDialogueType })}
                disabled={visibleShotIds.length === 0}
                className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-xs hover:bg-background/80 disabled:opacity-50"
              >
                应用对白类型
              </button>
            </label>
            <label className="space-y-1 text-xs">
              <div className="text-muted-foreground">批量出图状态</div>
              <select
                value={bulkShouldGenerateImage}
                onChange={(event) => setBulkShouldGenerateImage(event.target.value as "enable" | "disable")}
                className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
              >
                <option value="enable">设为参与出图</option>
                <option value="disable">设为跳过出图</option>
              </select>
              <button
                type="button"
                onClick={() => handleBulkApply({ shouldGenerateImage: bulkShouldGenerateImage === "enable" })}
                disabled={visibleShotIds.length === 0}
                className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-xs hover:bg-background/80 disabled:opacity-50"
              >
                应用出图状态
              </button>
            </label>
            <label className="space-y-1 text-xs">
              <div className="text-muted-foreground">角色标签</div>
              <input
                value={bulkAddCharacters}
                onChange={(event) => setBulkAddCharacters(event.target.value)}
                placeholder="新增角色"
                className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
              />
              <input
                value={bulkRemoveCharacters}
                onChange={(event) => setBulkRemoveCharacters(event.target.value)}
                placeholder="移除角色"
                className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
              />
              <button
                type="button"
                onClick={() => handleBulkApply({
                  addCharacters: normalizeEditableStringList(bulkAddCharacters),
                  removeCharacters: normalizeEditableStringList(bulkRemoveCharacters),
                })}
                disabled={visibleShotIds.length === 0}
                className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-xs hover:bg-background/80 disabled:opacity-50"
              >
                应用角色标签
              </button>
            </label>
            <div className="space-y-3">
              <label className="space-y-1 text-xs">
                <div className="text-muted-foreground">道具标签</div>
                <input
                  value={bulkAddProps}
                  onChange={(event) => setBulkAddProps(event.target.value)}
                  placeholder="新增道具"
                  className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                />
                <input
                  value={bulkRemoveProps}
                  onChange={(event) => setBulkRemoveProps(event.target.value)}
                  placeholder="移除道具"
                  className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                />
                <button
                  type="button"
                  onClick={() => handleBulkApply({
                    addProps: normalizeEditableStringList(bulkAddProps),
                    removeProps: normalizeEditableStringList(bulkRemoveProps),
                  })}
                  disabled={visibleShotIds.length === 0}
                  className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-xs hover:bg-background/80 disabled:opacity-50"
                >
                  应用道具标签
                </button>
              </label>
              <label className="space-y-1 text-xs">
                <div className="text-muted-foreground">素材标签</div>
                <input
                  value={bulkAddAssets}
                  onChange={(event) => setBulkAddAssets(event.target.value)}
                  placeholder="新增素材"
                  className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                />
                <input
                  value={bulkRemoveAssets}
                  onChange={(event) => setBulkRemoveAssets(event.target.value)}
                  placeholder="移除素材"
                  className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                />
                <button
                  type="button"
                  onClick={() => handleBulkApply({
                    addAssets: normalizeEditableStringList(bulkAddAssets),
                    removeAssets: normalizeEditableStringList(bulkRemoveAssets),
                  })}
                  disabled={visibleShotIds.length === 0}
                  className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-xs hover:bg-background/80 disabled:opacity-50"
                >
                  应用素材标签
                </button>
              </label>
            </div>
          </div>
        </div>
        <div className="mb-3 text-sm font-semibold">Storyboards</div>
        <div className="space-y-4">
          {visibleEpisodes.map((episode) => (
            <div key={episode.episodeNumber} className="rounded-xl border border-border/30 bg-background/35 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <input
                    value={episode.title}
                    onChange={(event) => updateEpisode(episode.episodeNumber, { title: event.target.value })}
                    className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm font-medium outline-none"
                  />
                  <input
                    value={episode.summary}
                    onChange={(event) => updateEpisode(episode.episodeNumber, { summary: event.target.value })}
                    className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-xs text-muted-foreground outline-none"
                  />
                  <div className="text-xs text-muted-foreground">
                    {episode.chapterTitle} · {episode.shots.length} 镜头
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="space-y-1 text-xs">
                    <div className="text-muted-foreground">集时长</div>
                    <input
                      type="number"
                      min={1}
                      value={episode.durationSec}
                      onChange={(event) => {
                        const nextValue = event.target.valueAsNumber;
                        updateEpisode(episode.episodeNumber, { durationSec: Number.isFinite(nextValue) ? nextValue : episode.durationSec });
                      }}
                      className="w-28 rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <div className="text-muted-foreground">轨道数</div>
                    <input
                      type="number"
                      min={1}
                      value={episode.trackCount}
                      onChange={(event) => {
                        const nextValue = event.target.valueAsNumber;
                        updateEpisode(episode.episodeNumber, { trackCount: Number.isFinite(nextValue) ? nextValue : episode.trackCount });
                      }}
                      className="w-28 rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                    />
                  </label>
                </div>
              </div>
              {episode.shots.length > 0 ? (
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-left text-xs">
                    <thead className="text-muted-foreground">
                      <tr className="border-b border-border/30">
                        <th className="px-2 py-2 font-medium">镜头</th>
                        <th className="px-2 py-2 font-medium">景别</th>
                        <th className="px-2 py-2 font-medium">运镜</th>
                        <th className="px-2 py-2 font-medium">场景</th>
                        <th className="px-2 py-2 font-medium">角色</th>
                        <th className="px-2 py-2 font-medium">时长</th>
                        <th className="px-2 py-2 font-medium">对白</th>
                      </tr>
                    </thead>
                    <tbody>
                      {episode.shots.map((shot) => (
                        <tr key={shot.id} className="border-b border-border/20 align-top last:border-b-0">
                          <td className="px-2 py-2">
                            <div className="font-medium">{shot.title}</div>
                            <div className="mt-1 text-[11px] text-muted-foreground">{shot.scriptText}</div>
                          </td>
                          <td className="px-2 py-2">{shot.shotType}</td>
                          <td className="px-2 py-2">{shot.cameraMovement}</td>
                          <td className="px-2 py-2">{shot.scene}</td>
                          <td className="px-2 py-2">{shot.characters.join("、") || "无"}</td>
                          <td className="px-2 py-2">{shot.durationSec}s</td>
                          <td className="px-2 py-2">
                            <div>{shot.dialogue || "无"}</div>
                            <div className="mt-1 text-[11px] text-muted-foreground">{shot.dialogueType}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="mt-3 rounded-xl border border-dashed border-border/40 px-4 py-6 text-center text-sm text-muted-foreground">
                  当前筛选条件下暂无镜头。
                </div>
              )}
              <div className="mt-4 space-y-3">
                {episode.shots.map((shot) => (
                  <div key={`${episode.episodeNumber}:${shot.id}`} className="rounded-xl border border-border/30 bg-card/55 p-3">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs text-muted-foreground">
                        顺序 #{shot.shotNumber}
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleMoveShot(episode.episodeNumber, shot.id, "up")}
                          disabled={shotSortMode !== "shot-number" || shot.shotNumber <= 1}
                          className="rounded-lg border border-border/30 bg-background/60 px-3 py-1.5 text-xs hover:bg-background/80 disabled:opacity-50"
                        >
                          上移
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveShot(episode.episodeNumber, shot.id, "down")}
                          disabled={shotSortMode !== "shot-number" || shot.shotNumber >= episode.shots.length}
                          className="rounded-lg border border-border/30 bg-background/60 px-3 py-1.5 text-xs hover:bg-background/80 disabled:opacity-50"
                        >
                          下移
                        </button>
                      </div>
                    </div>
                    <div className="grid gap-3 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                      <div className="space-y-3">
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="space-y-1 text-xs md:col-span-2">
                            <div className="text-muted-foreground">镜头标题</div>
                            <input
                              value={shot.title}
                              onChange={(event) => updateShot(shot.id, { title: event.target.value })}
                              className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                            />
                          </label>
                          <label className="space-y-1 text-xs">
                            <div className="text-muted-foreground">景别</div>
                            <input
                              value={shot.shotType}
                              onChange={(event) => updateShot(shot.id, { shotType: event.target.value })}
                              className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                            />
                          </label>
                          <label className="space-y-1 text-xs">
                            <div className="text-muted-foreground">运镜</div>
                            <input
                              value={shot.cameraMovement}
                              onChange={(event) => updateShot(shot.id, { cameraMovement: event.target.value })}
                              className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                            />
                          </label>
                          <label className="space-y-1 text-xs md:col-span-2">
                            <div className="text-muted-foreground">场景</div>
                            <input
                              value={shot.scene}
                              onChange={(event) => updateShot(shot.id, { scene: event.target.value })}
                              className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                            />
                          </label>
                          <label className="space-y-1 text-xs">
                            <div className="text-muted-foreground">镜头时长</div>
                            <input
                              type="number"
                              min={1}
                              value={shot.durationSec}
                              onChange={(event) => {
                                const nextValue = event.target.valueAsNumber;
                                updateShot(shot.id, { durationSec: Number.isFinite(nextValue) ? nextValue : shot.durationSec });
                              }}
                              className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                            />
                          </label>
                          <label className="space-y-1 text-xs">
                            <div className="text-muted-foreground">轨道</div>
                            <input
                              value={shot.track}
                              onChange={(event) => updateShot(shot.id, { track: event.target.value })}
                              className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                            />
                          </label>
                          <label className="space-y-1 text-xs">
                            <div className="text-muted-foreground">情绪</div>
                            <input
                              value={shot.mood}
                              onChange={(event) => updateShot(shot.id, { mood: event.target.value })}
                              className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                            />
                          </label>
                          <label className="space-y-1 text-xs">
                            <div className="text-muted-foreground">光效</div>
                            <input
                              value={shot.lighting}
                              onChange={(event) => updateShot(shot.id, { lighting: event.target.value })}
                              className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                            />
                          </label>
                          <label className="space-y-1 text-xs">
                            <div className="text-muted-foreground">对白类型</div>
                            <select
                              value={shot.dialogueType}
                              onChange={(event) => updateShot(shot.id, { dialogueType: event.target.value as ProductionDialogueType })}
                              className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                            >
                              {dialogueOptions.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                          </label>
                          <label className="flex items-center gap-2 rounded-lg border border-border/30 bg-background/50 px-3 py-2 text-xs">
                            <input
                              type="checkbox"
                              checked={shot.shouldGenerateImage}
                              onChange={(event) => updateShot(shot.id, { shouldGenerateImage: event.target.checked })}
                            />
                            <span>参与出图</span>
                          </label>
                        </div>
                        <label className="space-y-1 text-xs">
                          <div className="text-muted-foreground">对白内容</div>
                          <textarea
                            value={shot.dialogue}
                            onChange={(event) => updateShot(shot.id, { dialogue: event.target.value })}
                            rows={2}
                            className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                          />
                        </label>
                        <label className="space-y-1 text-xs">
                          <div className="text-muted-foreground">角色（用 `、` / `,` 分隔）</div>
                          <input
                            value={formatEditableStringList(shot.characters)}
                            onChange={(event) => updateShotList(shot.id, "characters", event.target.value)}
                            className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                          />
                        </label>
                        <label className="space-y-1 text-xs">
                          <div className="text-muted-foreground">道具（用 `、` / `,` 分隔）</div>
                          <input
                            value={formatEditableStringList(shot.props)}
                            onChange={(event) => updateShotList(shot.id, "props", event.target.value)}
                            className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                          />
                        </label>
                        <label className="space-y-1 text-xs">
                          <div className="text-muted-foreground">素材（用 `、` / `,` 分隔）</div>
                          <input
                            value={formatEditableStringList(shot.assets)}
                            onChange={(event) => updateShotList(shot.id, "assets", event.target.value)}
                            className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                          />
                        </label>
                      </div>
                      <div className="space-y-3">
                        <label className="space-y-1 text-xs">
                          <div className="text-muted-foreground">镜头脚本</div>
                          <textarea
                            value={shot.scriptText}
                            onChange={(event) => updateShot(shot.id, { scriptText: event.target.value })}
                            rows={4}
                            className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                          />
                        </label>
                        <label className="space-y-1 text-xs">
                          <div className="text-muted-foreground">文生图提示词</div>
                          <textarea
                            value={shot.textToImagePrompt}
                            onChange={(event) => updateShot(shot.id, { textToImagePrompt: event.target.value })}
                            rows={4}
                            className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                          />
                        </label>
                        <label className="space-y-1 text-xs">
                          <div className="text-muted-foreground">图生视频提示词</div>
                          <textarea
                            value={shot.imageToVideoPrompt}
                            onChange={(event) => updateShot(shot.id, { imageToVideoPrompt: event.target.value })}
                            rows={4}
                            className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {workspace.episodes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/40 px-4 py-6 text-center text-sm text-muted-foreground">
              暂无分镜数据，先从剧本工作台生成生产分镜表。
            </div>
          ) : null}
        </div>
      </section>

      <section className="rounded-2xl border border-border/40 bg-card/50 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">导演规划</div>
            <div className="text-xs text-muted-foreground">将视觉风格与导演手法沉淀为独立产物</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onOpenDirectorPlanHistory}
              disabled={!directorPlan}
              className="rounded-xl border border-border/40 bg-background/60 px-4 py-2 text-sm font-medium hover:bg-background/80 disabled:opacity-50"
            >
              版本历史
            </button>
            <button
              type="button"
              onClick={onGenerateDirectorPlan}
              disabled={directorPlanGenerating}
              className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/15 disabled:opacity-50"
            >
              {directorPlanGenerating ? "生成中..." : "生成导演规划"}
            </button>
            <button
              type="button"
              onClick={onSaveDirectorPlan}
              disabled={directorPlanSaving || !directorPlan}
              className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {directorPlanSaving ? "保存中..." : "保存导演规划"}
            </button>
          </div>
        </div>
        {directorPlan ? (
          <div className="space-y-3">
            <label className="space-y-1 text-xs">
              <div className="text-muted-foreground">视觉声明</div>
              <textarea
                value={directorPlan.visualStatement}
                onChange={(event) => patchDirectorPlan((current) => ({ ...current, visualStatement: event.target.value }))}
                rows={3}
                className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
              />
            </label>
            <label className="space-y-1 text-xs">
              <div className="text-muted-foreground">导演意图</div>
              <textarea
                value={directorPlan.directorIntent}
                onChange={(event) => patchDirectorPlan((current) => ({ ...current, directorIntent: event.target.value }))}
                rows={3}
                className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
              />
            </label>
            <div className="grid gap-3 xl:grid-cols-3">
              <label className="space-y-1 text-xs">
                <div className="text-muted-foreground">视觉规则</div>
                <textarea
                  value={directorPlan.visualRules.join("\n")}
                  onChange={(event) => patchDirectorPlan((current) => ({ ...current, visualRules: normalizeEditableStringList(event.target.value) }))}
                  rows={5}
                  className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                />
              </label>
              <label className="space-y-1 text-xs">
                <div className="text-muted-foreground">运镜规则</div>
                <textarea
                  value={directorPlan.cameraRules.join("\n")}
                  onChange={(event) => patchDirectorPlan((current) => ({ ...current, cameraRules: normalizeEditableStringList(event.target.value) }))}
                  rows={5}
                  className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                />
              </label>
              <label className="space-y-1 text-xs">
                <div className="text-muted-foreground">色彩脚本</div>
                <textarea
                  value={directorPlan.colorScript.join("\n")}
                  onChange={(event) => patchDirectorPlan((current) => ({ ...current, colorScript: normalizeEditableStringList(event.target.value) }))}
                  rows={5}
                  className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                />
              </label>
            </div>
            <div className="space-y-3">
              {directorPlan.episodePlans.map((episodePlan, index) => (
                <div key={`director-${episodePlan.episodeNumber}`} className="rounded-xl border border-border/30 bg-background/40 p-3">
                  <div className="mb-2 text-sm font-medium">{episodePlan.title}</div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="space-y-1 text-xs">
                      <div className="text-muted-foreground">故事目标</div>
                      <textarea
                        value={episodePlan.storyGoal}
                        onChange={(event) => patchDirectorPlan((current) => ({
                          ...current,
                          episodePlans: current.episodePlans.map((item, itemIndex) => itemIndex === index ? { ...item, storyGoal: event.target.value } : item),
                        }))}
                        rows={3}
                        className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                      />
                    </label>
                    <label className="space-y-1 text-xs">
                      <div className="text-muted-foreground">情绪节拍</div>
                      <textarea
                        value={episodePlan.emotionalBeat}
                        onChange={(event) => patchDirectorPlan((current) => ({
                          ...current,
                          episodePlans: current.episodePlans.map((item, itemIndex) => itemIndex === index ? { ...item, emotionalBeat: event.target.value } : item),
                        }))}
                        rows={3}
                        className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                      />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border/40 px-4 py-6 text-center text-sm text-muted-foreground">
            暂无导演规划，先从生产工作台生成。
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border/40 bg-card/50 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">资产库</div>
            <div className="text-xs text-muted-foreground">按角色 / 道具 / 场景 / 参考资产沉淀复用素材</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onOpenAssetLibraryHistory}
              disabled={!assetLibrary}
              className="rounded-xl border border-border/40 bg-background/60 px-4 py-2 text-sm font-medium hover:bg-background/80 disabled:opacity-50"
            >
              版本历史
            </button>
            <button
              type="button"
              onClick={onGenerateAssetLibrary}
              disabled={assetLibraryGenerating}
              className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/15 disabled:opacity-50"
            >
              {assetLibraryGenerating ? "生成中..." : "生成资产库"}
            </button>
            <button
              type="button"
              onClick={onSaveAssetLibrary}
              disabled={assetLibrarySaving || !assetLibrary}
              className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {assetLibrarySaving ? "保存中..." : "保存资产库"}
            </button>
          </div>
        </div>
        {assetLibrary ? (
          <div className="space-y-3">
            {assetLibrary.items.map((item, index) => (
              <div key={item.id} className="rounded-xl border border-border/30 bg-background/40 p-3">
                {item.thumbnailPath ? (
                  <div className="mb-3">
                    <img
                      src={resolveAssetLibraryFileUrl(item.thumbnailPath)}
                      alt={item.name}
                      className="h-28 w-28 rounded-lg border border-border/30 object-cover"
                    />
                  </div>
                ) : null}
                <div className="grid gap-3 xl:grid-cols-[140px_minmax(0,1fr)_180px]">
                  <select
                    value={item.type}
                    onChange={(event) => patchAssetLibrary((current) => ({
                      ...current,
                      items: current.items.map((asset, assetIndex) => assetIndex === index ? { ...asset, type: event.target.value as AssetLibrary["items"][number]["type"] } : asset),
                    }))}
                    className="rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                  >
                    <option value="character">角色</option>
                    <option value="prop">道具</option>
                    <option value="scene">场景</option>
                    <option value="reference">参考</option>
                  </select>
                  <input
                    value={item.name}
                    onChange={(event) => patchAssetLibrary((current) => ({
                      ...current,
                      items: current.items.map((asset, assetIndex) => assetIndex === index ? { ...asset, name: event.target.value } : asset),
                    }))}
                    className="rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                  <select
                    value={item.status}
                    onChange={(event) => patchAssetLibrary((current) => ({
                      ...current,
                      items: current.items.map((asset, assetIndex) => assetIndex === index ? { ...asset, status: event.target.value as AssetLibraryItemStatus } : asset),
                    }))}
                    className="rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                  >
                    {assetStatusOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-4">
                  <div className="rounded-lg border border-border/30 bg-background/50 px-3 py-2 text-xs">
                    <div className="text-muted-foreground">引用镜头数</div>
                    <div className="mt-1 font-medium text-foreground">{item.referenceCount}</div>
                  </div>
                  <div className="rounded-lg border border-border/30 bg-background/50 px-3 py-2 text-xs">
                    <div className="text-muted-foreground">图片状态</div>
                    <div className="mt-1 font-medium text-foreground">{item.generation.imageStatus}</div>
                  </div>
                  <div className="rounded-lg border border-border/30 bg-background/50 px-3 py-2 text-xs">
                    <div className="text-muted-foreground">视频状态</div>
                    <div className="mt-1 font-medium text-foreground">{item.generation.videoStatus}</div>
                  </div>
                  <label className="flex items-center gap-2 rounded-lg border border-border/30 bg-background/50 px-3 py-2 text-xs">
                    <input
                      type="checkbox"
                      checked={item.generation.needsRegeneration}
                      onChange={(event) => patchAssetLibrary((current) => ({
                        ...current,
                        items: current.items.map((asset, assetIndex) => assetIndex === index
                          ? { ...asset, generation: { ...asset.generation, needsRegeneration: event.target.checked } }
                          : asset),
                      }))}
                    />
                    <span>需要重生成</span>
                  </label>
                </div>
                <textarea
                  value={item.description}
                  onChange={(event) => patchAssetLibrary((current) => ({
                    ...current,
                    items: current.items.map((asset, assetIndex) => assetIndex === index ? { ...asset, description: event.target.value } : asset),
                  }))}
                  rows={2}
                  className="mt-3 w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                />
                <textarea
                  value={item.prompt}
                  onChange={(event) => patchAssetLibrary((current) => ({
                    ...current,
                    items: current.items.map((asset, assetIndex) => assetIndex === index ? { ...asset, prompt: event.target.value } : asset),
                  }))}
                  rows={3}
                  className="mt-3 w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                />
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <input
                    value={item.thumbnailPath}
                    onChange={(event) => patchAssetLibrary((current) => ({
                      ...current,
                      items: current.items.map((asset, assetIndex) => assetIndex === index ? { ...asset, thumbnailPath: event.target.value } : asset),
                    }))}
                    placeholder="缩略图路径"
                    className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                  <input
                    value={item.filePath}
                    onChange={(event) => patchAssetLibrary((current) => ({
                      ...current,
                      items: current.items.map((asset, assetIndex) => assetIndex === index ? { ...asset, filePath: event.target.value } : asset),
                    }))}
                    placeholder="素材文件路径"
                    className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                  />
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <label className="space-y-1 text-xs">
                    <div className="text-muted-foreground">上传缩略图</div>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.currentTarget.value = "";
                        if (!file) return;
                        void onUploadAssetLibraryFile(item.id, "thumbnail", file);
                      }}
                      className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-2 file:py-1"
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <div className="text-muted-foreground">上传素材文件</div>
                    <input
                      type="file"
                      accept="image/*,video/*,.json,.txt"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.currentTarget.value = "";
                        if (!file) return;
                        void onUploadAssetLibraryFile(item.id, "file", file);
                      }}
                      className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-2 file:py-1"
                    />
                  </label>
                </div>
                {item.filePath ? (
                  <div className="mt-2 text-xs">
                    <a
                      href={resolveAssetLibraryFileUrl(item.filePath)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      打开已绑定素材
                    </a>
                  </div>
                ) : null}
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <select
                    value={item.generation.imageStatus}
                    onChange={(event) => patchAssetLibrary((current) => ({
                      ...current,
                      items: current.items.map((asset, assetIndex) => assetIndex === index
                        ? { ...asset, generation: { ...asset.generation, imageStatus: event.target.value as typeof asset.generation.imageStatus } }
                        : asset),
                    }))}
                    className="rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                  >
                    <option value="pending">pending</option>
                    <option value="queued">queued</option>
                    <option value="generating">generating</option>
                    <option value="ready">ready</option>
                    <option value="failed">failed</option>
                    <option value="rejected">rejected</option>
                  </select>
                  <select
                    value={item.generation.videoStatus}
                    onChange={(event) => patchAssetLibrary((current) => ({
                      ...current,
                      items: current.items.map((asset, assetIndex) => assetIndex === index
                        ? { ...asset, generation: { ...asset.generation, videoStatus: event.target.value as typeof asset.generation.videoStatus } }
                        : asset),
                    }))}
                    className="rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                  >
                    <option value="pending">pending</option>
                    <option value="queued">queued</option>
                    <option value="generating">generating</option>
                    <option value="ready">ready</option>
                    <option value="failed">failed</option>
                    <option value="rejected">rejected</option>
                  </select>
                </div>
                <textarea
                  value={item.generation.lastError}
                  onChange={(event) => patchAssetLibrary((current) => ({
                    ...current,
                    items: current.items.map((asset, assetIndex) => assetIndex === index
                      ? { ...asset, generation: { ...asset.generation, lastError: event.target.value } }
                      : asset),
                  }))}
                  rows={2}
                  placeholder="失败原因 / 错误信息"
                  className="mt-3 w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                />
                <textarea
                  value={item.generation.notes}
                  onChange={(event) => patchAssetLibrary((current) => ({
                    ...current,
                    items: current.items.map((asset, assetIndex) => assetIndex === index
                      ? { ...asset, generation: { ...asset.generation, notes: event.target.value } }
                      : asset),
                  }))}
                  rows={2}
                  placeholder="制作备注"
                  className="mt-3 w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                />
                <div className="mt-3 text-xs text-muted-foreground">
                  关联镜头：{item.shotIds.join("、") || "无"}
                </div>
                <input
                  value={item.tags.join("、")}
                  onChange={(event) => patchAssetLibrary((current) => ({
                    ...current,
                    items: current.items.map((asset, assetIndex) => assetIndex === index ? { ...asset, tags: normalizeEditableStringList(event.target.value) } : asset),
                  }))}
                  placeholder="标签"
                  className="mt-3 w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-sm outline-none"
                />
              </div>
            ))}
            {assetLibrary.items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/40 px-4 py-6 text-center text-sm text-muted-foreground">
                当前资产库为空，先生成资产库。
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border/40 px-4 py-6 text-center text-sm text-muted-foreground">
            暂无资产库，先从生产工作台生成。
          </div>
        )}
      </section>
    </div>
  );
}

export function BookDetail({ bookId, nav, theme, t, sse }: BookDetailProps) {
  const { data, loading, error } = useApi<BookData>(`/books/${bookId}`);
  const { data: truthData } = useApi<TruthFilesResponse>(`/books/${bookId}/truth`);
  const { data: chapterPlansData, refetch: refetchChapterPlans } = useApi<ChapterPlansResponse>(`/books/${bookId}/chapter-plans`);
  const { data: scriptWorkspaceData, refetch: refetchScriptWorkspace } = useApi<ScriptWorkspaceResponse>(`/books/${bookId}/script-workspace`);
  const { data: productionWorkspaceData, refetch: refetchProductionWorkspace } = useApi<ProductionWorkspaceResponse>(`/books/${bookId}/production-workspace`);
  const { data: directorPlanData, refetch: refetchDirectorPlan } = useApi<DirectorPlanResponse>(`/books/${bookId}/director-plan`);
  const { data: assetLibraryData, refetch: refetchAssetLibrary } = useApi<AssetLibraryResponse>(`/books/${bookId}/asset-library`);
  const { data: taskChecklistData, refetch: refetchTaskChecklist } = useApi<TaskChecklistResponse>(`/books/${bookId}/task-checklist`);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [readerMode, setReaderMode] = useState<ReaderMode>("chapter");
  const [selectedPlanChapter, setSelectedPlanChapter] = useState<number | null>(null);
  const [historyChapter, setHistoryChapter] = useState<number | null>(null);
  const [scriptHistoryOpen, setScriptHistoryOpen] = useState(false);
  const [directorPlanHistoryOpen, setDirectorPlanHistoryOpen] = useState(false);
  const [assetLibraryHistoryOpen, setAssetLibraryHistoryOpen] = useState(false);
  const [auditHistoryChapter, setAuditHistoryChapter] = useState<number | null>(null);
  const [planEditorChapter, setPlanEditorChapter] = useState<number | null>(null);
  const [planEditorSource, setPlanEditorSource] = useState<"manual" | "ai">("manual");
  const [chapterPlansSnapshot, setChapterPlansSnapshot] = useState<ReadonlyArray<ChapterPlan> | null>(null);
  const [chapterPlansRefreshKey, setChapterPlansRefreshKey] = useState(0);
  const [scriptSaving, setScriptSaving] = useState(false);
  const [scriptGenerating, setScriptGenerating] = useState(false);
  const [productionSaving, setProductionSaving] = useState(false);
  const [productionGenerating, setProductionGenerating] = useState(false);
  const [directorPlanSaving, setDirectorPlanSaving] = useState(false);
  const [directorPlanGenerating, setDirectorPlanGenerating] = useState(false);
  const [assetLibrarySaving, setAssetLibrarySaving] = useState(false);
  const [assetLibraryGenerating, setAssetLibraryGenerating] = useState(false);
  const [checklistSaving, setChecklistSaving] = useState(false);
  const [scriptWorkspaceDraft, setScriptWorkspaceDraft] = useState<ScriptWorkspace | null>(null);
  const [productionWorkspaceDraft, setProductionWorkspaceDraft] = useState<ProductionWorkspace | null>(null);
  const [directorPlanDraft, setDirectorPlanDraft] = useState<DirectorPlan | null>(null);
  const [assetLibraryDraft, setAssetLibraryDraft] = useState<AssetLibrary | null>(null);
  const [checklistItems, setChecklistItems] = useState<ReadonlyArray<TaskChecklistItem>>([]);
  const [checklistTemplateId, setChecklistTemplateId] = useState("short-video");
  const [checklistInput, setChecklistInput] = useState("");
  const [checklistNote, setChecklistNote] = useState("");
  const openChapterArtifact = useChatStore((s) => s.openChapterArtifact);
  const artifactChapter = useChatStore((s) => s.artifactChapter);
  const artifactFile = useChatStore((s) => s.artifactFile);
  const artifactSource = useChatStore((s) => s.artifactSource);
  const openArtifact = useChatStore((s) => s.openArtifact);
  const truthFilesToShow = truthData?.files ?? [];
  const [leftWidth, setLeftWidth] = useState(() => clampWidth(readStoredWidth(DETAIL_LEFT_WIDTH_KEY, DETAIL_LEFT_DEFAULT), DETAIL_LEFT_MIN, DETAIL_LEFT_MAX));
  const [rightWidth, setRightWidth] = useState(() => clampWidth(readStoredWidth(DETAIL_RIGHT_WIDTH_KEY, DETAIL_RIGHT_DEFAULT), DETAIL_RIGHT_MIN, DETAIL_RIGHT_MAX));
  const [draggingSide, setDraggingSide] = useState<"left" | "right" | null>(null);
  const dragStateRef = useRef<{
    type: "left" | "right";
    startX: number;
    startLeft: number;
    startRight: number;
  } | null>(null);
  const leftWidthRef = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);

  useEffect(() => {
    if (!shouldRedirectBookDetailToWizard(data ? { creationState: data.book.creationState, creation: data.creation } : null)) return;
    nav.toBookCreate?.(bookId);
  }, [bookId, data?.creation, nav]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (consumeScriptWorkspaceAutoOpenFlag(window.localStorage, Boolean(data))) {
      setReaderMode("script");
    }
  }, [data]);

  useEffect(() => {
    if (!scriptWorkspaceData?.workspace) return;
    setScriptWorkspaceDraft(scriptWorkspaceData.workspace);
  }, [scriptWorkspaceData?.workspace]);

  useEffect(() => {
    if (!productionWorkspaceData?.workspace) return;
    setProductionWorkspaceDraft(productionWorkspaceData.workspace);
  }, [productionWorkspaceData?.workspace]);

  useEffect(() => {
    if (!directorPlanData?.plan) return;
    setDirectorPlanDraft(directorPlanData.plan);
  }, [directorPlanData?.plan]);

  useEffect(() => {
    if (!assetLibraryData?.library) return;
    setAssetLibraryDraft(assetLibraryData.library);
  }, [assetLibraryData?.library]);

  useEffect(() => {
    setChecklistItems(taskChecklistData?.checklist.items ?? []);
  }, [taskChecklistData?.checklist.items]);

  useEffect(() => {
    setChecklistTemplateId(taskChecklistData?.checklist.templateId ?? "short-video");
  }, [taskChecklistData?.checklist.templateId]);

  useEffect(() => {
    leftWidthRef.current = leftWidth;
  }, [leftWidth]);

  useEffect(() => {
    rightWidthRef.current = rightWidth;
  }, [rightWidth]);

  useEffect(() => {
    if (readerMode !== "chapter") return;
    if (!data) return;
    if (!shouldAutoOpenFirstChapter(data.chapters, artifactChapter)) return;
    const firstChapter = data.chapters[0];
    if (!firstChapter) return;
    openChapterArtifact(firstChapter.number, {
      edit: false,
      meta: {
        number: firstChapter.number,
        title: firstChapter.title,
        status: firstChapter.status,
        wordCount: firstChapter.wordCount,
        ...(Array.isArray(firstChapter.auditHistory) ? { auditHistory: firstChapter.auditHistory } : {}),
      },
    });
  }, [artifactChapter, data, openChapterArtifact, readerMode]);

  useEffect(() => {
    setChapterPlansSnapshot(chapterPlansData?.plans ?? null);
  }, [chapterPlansData]);

  const chapterPlans = resolveDisplayedChapterPlans(chapterPlansData ?? null, chapterPlansSnapshot);
  const selectedPlan = useMemo(() => {
    if (chapterPlans.length === 0) return null;
    if (selectedPlanChapter === null) return chapterPlans[0] ?? null;
    return chapterPlans.find((plan) => plan.chapterNumber === selectedPlanChapter) ?? chapterPlans[0] ?? null;
  }, [chapterPlans, selectedPlanChapter]);
  const historyPlan = useMemo(() => {
    if (historyChapter === null) return null;
    return chapterPlans.find((plan) => plan.chapterNumber === historyChapter) ?? null;
  }, [chapterPlans, historyChapter]);
  const planEditorPlan = useMemo(() => {
    if (planEditorChapter === null) return null;
    return chapterPlans.find((plan) => plan.chapterNumber === planEditorChapter) ?? null;
  }, [chapterPlans, planEditorChapter]);
  const handleOpenAuditHistory = useCallback((chapterNumber: number) => {
    setAuditHistoryChapter(chapterNumber);
  }, []);

  const scriptWorkspace = scriptWorkspaceDraft ?? scriptWorkspaceData?.workspace ?? null;
  const productionWorkspace = productionWorkspaceDraft ?? productionWorkspaceData?.workspace ?? null;
  const directorPlan = directorPlanDraft ?? directorPlanData?.plan ?? null;
  const assetLibrary = assetLibraryDraft ?? assetLibraryData?.library ?? null;
  const checklistProgress = useMemo(() => {
    const total = checklistItems.length;
    const done = checklistItems.filter((item) => item.done).length;
    return { total, done };
  }, [checklistItems]);

  const persistChecklist = useCallback(async (nextItems: ReadonlyArray<TaskChecklistItem>) => {
    setChecklistSaving(true);
    try {
      const response = await putApi<TaskChecklistResponse>(`/books/${bookId}/task-checklist`, {
        templateId: checklistTemplateId,
        items: nextItems,
      });
      setChecklistItems(response.checklist.items);
      setChecklistTemplateId(response.checklist.templateId ?? checklistTemplateId);
      await refetchTaskChecklist();
    } finally {
      setChecklistSaving(false);
    }
  }, [bookId, checklistTemplateId, refetchTaskChecklist]);

  const handleChecklistAdd = useCallback(async () => {
    const text = checklistInput.trim();
    if (!text) return;
    const nextItems = [
      ...checklistItems,
      {
        id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        done: false,
        order: checklistItems.length,
        ...(checklistNote.trim() ? { note: checklistNote.trim() } : {}),
      },
    ] satisfies ReadonlyArray<TaskChecklistItem>;
    setChecklistInput("");
    setChecklistNote("");
    setChecklistItems(nextItems);
    await persistChecklist(nextItems);
  }, [checklistInput, checklistItems, checklistNote, persistChecklist]);

  const handleChecklistToggle = useCallback(async (itemId: string, done: boolean) => {
    const nextItems = checklistItems.map((item) => (item.id === itemId ? { ...item, done } : item));
    setChecklistItems(nextItems);
    await persistChecklist(nextItems);
  }, [checklistItems, persistChecklist]);

  const handleChecklistRemove = useCallback(async (itemId: string) => {
    const nextItems = checklistItems
      .filter((item) => item.id !== itemId)
      .map((item, index) => ({ ...item, order: index }));
    setChecklistItems(nextItems);
    await persistChecklist(nextItems);
  }, [checklistItems, persistChecklist]);

  const handleChecklistGenerate = useCallback(async () => {
    const nextItems = buildScriptWorkspaceChecklistTemplate(checklistTemplateId);
    setChecklistItems(nextItems);
    await persistChecklist(nextItems);
  }, [checklistTemplateId, persistChecklist]);

  const handleChecklistTemplateChange = useCallback((templateId: string) => {
    setChecklistTemplateId(templateId);
  }, []);

  const handleChecklistSave = useCallback(async () => {
    await persistChecklist(checklistItems);
  }, [checklistItems, persistChecklist]);

  const handleChangeScriptWorkspace = useCallback((next: ScriptWorkspace) => {
    setScriptWorkspaceDraft(next);
  }, []);
  const handleSaveScriptWorkspace = useCallback(async () => {
    if (!scriptWorkspace) return;
    setScriptSaving(true);
    try {
      const response = await putApi<ScriptWorkspaceResponse>(`/books/${bookId}/script-workspace`, { workspace: scriptWorkspace });
      setScriptWorkspaceDraft(response.workspace);
      await refetchScriptWorkspace();
    } finally {
      setScriptSaving(false);
    }
  }, [bookId, refetchScriptWorkspace, scriptWorkspace]);
  const handleGenerateScriptWorkspace = useCallback(async () => {
    setScriptGenerating(true);
    try {
      const selectedChapterNumbers = scriptWorkspace?.selectedChapterNumbers ?? (data?.chapters ?? []).map((chapter) => chapter.number);
      const response = await postApi<ScriptWorkspaceResponse>(`/books/${bookId}/script-workspace/generate`, {
        selectedChapterNumbers,
        config: scriptWorkspace?.config,
      });
      setScriptWorkspaceDraft(response.workspace);
      await refetchScriptWorkspace();
    } finally {
      setScriptGenerating(false);
    }
  }, [bookId, data?.chapters, refetchScriptWorkspace, scriptWorkspace]);
  const handleChangeProductionWorkspace = useCallback((next: ProductionWorkspace) => {
    setProductionWorkspaceDraft(next);
  }, []);
  const handleChangeDirectorPlan = useCallback((next: DirectorPlan) => {
    setDirectorPlanDraft(next);
  }, []);
  const handleChangeAssetLibrary = useCallback((next: AssetLibrary) => {
    setAssetLibraryDraft(next);
  }, []);

  const handleSaveProductionWorkspace = useCallback(async () => {
    if (!productionWorkspace) return;
    setProductionSaving(true);
    try {
      const response = await putApi<ProductionWorkspaceResponse>(`/books/${bookId}/production-workspace`, {
        workspace: productionWorkspace,
      });
      setProductionWorkspaceDraft(response.workspace);
      await refetchProductionWorkspace();
    } finally {
      setProductionSaving(false);
    }
  }, [bookId, productionWorkspace, refetchProductionWorkspace]);

  const handleGenerateProductionWorkspace = useCallback(async () => {
    setProductionGenerating(true);
    try {
      const response = await postApi<ProductionWorkspaceResponse>(`/books/${bookId}/production-workspace/generate`, {
        ...(scriptWorkspace ? { scriptWorkspace } : {}),
      });
      setProductionWorkspaceDraft(response.workspace);
      await refetchProductionWorkspace();
    } finally {
      setProductionGenerating(false);
    }
  }, [bookId, refetchProductionWorkspace, scriptWorkspace]);

  const handleSaveDirectorPlan = useCallback(async () => {
    if (!directorPlan) return;
    setDirectorPlanSaving(true);
    try {
      const response = await putApi<DirectorPlanResponse>(`/books/${bookId}/director-plan`, { plan: directorPlan });
      setDirectorPlanDraft(response.plan);
      await refetchDirectorPlan();
    } finally {
      setDirectorPlanSaving(false);
    }
  }, [bookId, directorPlan, refetchDirectorPlan]);

  const handleGenerateDirectorPlan = useCallback(async () => {
    setDirectorPlanGenerating(true);
    try {
      const response = await postApi<DirectorPlanResponse>(`/books/${bookId}/director-plan/generate`, {
        ...(productionWorkspace ? { productionWorkspace } : {}),
      });
      setDirectorPlanDraft(response.plan);
      await refetchDirectorPlan();
    } finally {
      setDirectorPlanGenerating(false);
    }
  }, [bookId, productionWorkspace, refetchDirectorPlan]);

  const handleSaveAssetLibrary = useCallback(async () => {
    if (!assetLibrary) return;
    setAssetLibrarySaving(true);
    try {
      const response = await putApi<AssetLibraryResponse>(`/books/${bookId}/asset-library`, { library: assetLibrary });
      setAssetLibraryDraft(response.library);
      await refetchAssetLibrary();
    } finally {
      setAssetLibrarySaving(false);
    }
  }, [assetLibrary, bookId, refetchAssetLibrary]);

  const handleGenerateAssetLibrary = useCallback(async () => {
    setAssetLibraryGenerating(true);
    try {
      const response = await postApi<AssetLibraryResponse>(`/books/${bookId}/asset-library/generate`, {
        ...(productionWorkspace ? { productionWorkspace } : {}),
      });
      setAssetLibraryDraft(response.library);
      await refetchAssetLibrary();
    } finally {
      setAssetLibraryGenerating(false);
    }
  }, [bookId, productionWorkspace, refetchAssetLibrary]);

  const handleUploadAssetLibraryFile = useCallback(async (itemId: string, kind: "thumbnail" | "file", file: File) => {
    if (!assetLibrary) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
    const response = await postApi<AssetLibraryUploadResponse>(`/books/${bookId}/asset-library/upload`, {
      itemId,
      kind,
      fileName: file.name,
      dataUrl,
    });
    setAssetLibraryDraft(response.library);
    await refetchAssetLibrary();
  }, [assetLibrary, bookId, refetchAssetLibrary]);

  useEffect(() => {
    if (readerMode !== "design") return;
    if (chapterPlans.length === 0) return;
    if (selectedPlanChapter !== null && chapterPlans.some((plan) => plan.chapterNumber === selectedPlanChapter)) return;
    setSelectedPlanChapter(chapterPlans[0]?.chapterNumber ?? null);
  }, [chapterPlans, readerMode, selectedPlanChapter]);

  useEffect(() => {
    if (readerMode !== "design") return;
    if (selectedPlanChapter !== null) return;
    const firstPlan = chapterPlans[0];
    if (!firstPlan) return;
    setSelectedPlanChapter(firstPlan.chapterNumber);
  }, [chapterPlans, readerMode, selectedPlanChapter]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(DETAIL_LEFT_WIDTH_KEY, String(leftWidth));
  }, [leftWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(DETAIL_RIGHT_WIDTH_KEY, String(rightWidth));
  }, [rightWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const clampToViewport = () => {
      const viewportWidth = window.innerWidth || 0;
      const next = normalizeDetailWidths(leftWidth, rightWidth, viewportWidth);
      if (next.left !== leftWidth) setLeftWidth(next.left);
      if (next.right !== rightWidth) setRightWidth(next.right);
    };
    clampToViewport();
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [leftWidth, rightWidth]);

  useEffect(() => {
    if (!draggingSide) return;

    const onMove = (event: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const delta = event.clientX - drag.startX;
      if (drag.type === "left") {
        const next = normalizeDetailWidths(drag.startLeft + delta, rightWidthRef.current, window.innerWidth || 0);
        setLeftWidth(next.left);
        return;
      }
      const next = normalizeDetailWidths(leftWidthRef.current, drag.startRight - delta, window.innerWidth || 0);
      setRightWidth(next.right);
    };

    const endDrag = () => {
      dragStateRef.current = null;
      setDraggingSide(null);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("blur", endDrag);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("blur", endDrag);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("blur", endDrag);
    };
  }, [draggingSide]);

  const startDrag = useCallback((type: "left" | "right", event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      type,
      startX: event.clientX,
      startLeft: leftWidth,
      startRight: rightWidth,
    };
    setDraggingSide(type);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }, [leftWidth, rightWidth]);


  const openReaderFile = useCallback((file: string, mode: ArtifactReaderMode, source: "truth" | "wizard" = "truth") => {
    const nextMode: ReaderMode = mode === "chapter" || mode === "design" || mode === "outline" || mode === "truth"
      ? mode
      : "truth";
    setReaderMode(nextMode);
    if (nextMode === "chapter" || nextMode === "design") return;
    if (artifactFile !== file || artifactSource !== source) openArtifact(file, source);
  }, [artifactFile, artifactSource, openArtifact]);

  const handleSelectReaderMode = useCallback((nextMode: ReaderMode) => {
    setReaderMode(nextMode);
    if (nextMode === "script" || nextMode === "production") return;
    if (nextMode === "design") {
      setSelectedPlanChapter(chapterPlans[0]?.chapterNumber ?? null);
      return;
    }
    if (nextMode === "truth") {
      const firstTruth = truthFilesToShow[0]?.name ?? "story_bible.md";
      if (artifactFile !== firstTruth) openArtifact(firstTruth);
      return;
    }
    if (nextMode === "outline") {
      if (artifactFile !== "story/outline/volume_map.md") openArtifact("story/outline/volume_map.md");
      return;
    }
    if (data?.chapters[0]) {
      const firstChapter = data.chapters[0];
      openChapterArtifact(firstChapter.number, {
        edit: false,
        meta: {
          number: firstChapter.number,
          title: firstChapter.title,
          status: firstChapter.status,
          wordCount: firstChapter.wordCount,
          ...(Array.isArray(firstChapter.auditHistory) ? { auditHistory: firstChapter.auditHistory } : {}),
        },
      });
    }
  }, [artifactFile, chapterPlans, data, openArtifact, openChapterArtifact, truthFilesToShow]);

  const handleDeleteBook = useCallback(async () => {
    setConfirmDeleteOpen(false);
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/books/${bookId}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `${res.status}`);
      }
      nav.toDashboard();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }, [bookId, nav]);

  const handleApprovePlan = useCallback(async () => {
    if (!selectedPlan) return;
    const chapterNumber = selectedPlan.chapterNumber;
    await fetchJson(`/books/${bookId}/chapter-plans/${chapterNumber}/approve`, {
      method: "POST",
    });
    await refetchChapterPlans();
    setChapterPlansRefreshKey((value) => value + 1);
    setPlanEditorChapter(null);
  }, [bookId, refetchChapterPlans, selectedPlan]);

  const handleSavePlan = useCallback(async (updated: Partial<ChapterPlan>, source: "manual" | "ai") => {
    if (planEditorChapter === null) return;
    const savedChapter = planEditorChapter;
    await fetchJson(`/books/${bookId}/chapter-plans/${planEditorChapter}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...updated,
        source,
        status: "planned",
        needsReview: true,
      }),
    });
    await refetchChapterPlans();
    setChapterPlansRefreshKey((value) => value + 1);
    setSelectedPlanChapter(savedChapter);
    setPlanEditorChapter(null);
  }, [bookId, planEditorChapter, refetchChapterPlans]);

  if (loading && !data) return <div className="flex flex-1 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" /></div>;
  if (error && !data) return <div className="p-6 text-destructive">{error}</div>;
  if (!data) return null;

  const { book, chapters } = data;
  const nextChapter = Math.max(1, Number(data.nextChapter ?? chapters.length + 1));
  const latestChapterNumber = chapters[chapters.length - 1]?.number ?? null;
  const latestChapterAuditReport = resolveLatestChapterAuditReport(chapters[chapters.length - 1] ?? null);
  const targetChapters = Math.max(1, Number(book.targetChapters ?? 1));
  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);
  const designSelected = readerMode === "design";
  const selectedPlanHasContent = selectedPlan ? chapters.some((chapter) => chapter.number === selectedPlan.chapterNumber) : false;
  const auditHistoryChapterMeta = auditHistoryChapter === null
    ? null
    : chapters.find((chapter) => chapter.number === auditHistoryChapter) ?? null;

  const handleOpenReview = () => {
    if (!selectedPlan) return;
    setPlanEditorChapter(selectedPlan.chapterNumber);
    setPlanEditorSource(selectedPlan.source === "ai" ? "ai" : "manual");
  };

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden bg-background/30">
      <aside
        className="shrink-0 border-r border-border/30 bg-card/40 backdrop-blur-md flex flex-col min-h-0 overflow-hidden"
        style={{ width: `${leftWidth}px` }}
      >
        <div className="shrink-0 border-b border-border/20 px-4 py-3">
          <button onClick={nav.toDashboard} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft size={14} />{t("bread.books")}</button>
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-serif">{book.title}</h1>
              {book.language === "en" && <span className="rounded border border-primary/20 px-1.5 py-0.5 text-[10px] text-primary">EN</span>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><FileText size={12} />{chapters.length}</span>
              <span className="inline-flex items-center gap-1"><BookOpen size={12} />{targetChapters}</span>
              <span className="inline-flex items-center gap-1"><Zap size={12} />{totalWords.toLocaleString()}</span>
              {book.fanficMode && <span className="inline-flex items-center gap-1"><Sparkles size={12} />{book.fanficMode}</span>}
            </div>
          </div>
        </div>
        <div className="shrink-0 border-b border-border/20 px-3 py-2">
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => handleSelectReaderMode("chapter")}
              aria-pressed={readerMode === "chapter"}
              className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                readerMode === "chapter"
                  ? "bg-primary/15 text-primary"
                  : "border border-border/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              <BookOpen size={12} />正文
            </button>
              <button
              type="button"
              onClick={() => handleSelectReaderMode("design")}
              aria-pressed={readerMode === "design"}
              className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                readerMode === "design"
                  ? "bg-primary/15 text-primary"
                  : "border border-border/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              <BookOpen size={12} />分章设计
            </button>
            <button
              type="button"
              onClick={() => handleSelectReaderMode("script")}
              aria-pressed={readerMode === "script"}
              className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                readerMode === "script"
                  ? "bg-primary/15 text-primary"
                  : "border border-border/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              <Sparkles size={12} />转剧本
            </button>
            <button
              type="button"
              onClick={() => handleSelectReaderMode("production")}
              aria-pressed={readerMode === "production"}
              className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                readerMode === "production"
                  ? "bg-primary/15 text-primary"
                  : "border border-border/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              <Database size={12} />生产工作台
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
          <div className={designSelected ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
            <ChaptersSection
              bookId={bookId}
              t={t}
              sse={sse}
              className="flex min-h-0 flex-1 flex-col"
              listClassName="h-full min-h-0"
              onOpenAuditHistory={handleOpenAuditHistory}
              hidePassedAuditSummary
            />
          </div>
          <div className={designSelected ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
              <ChapterPlansSection
                bookId={bookId}
                nextChapter={nextChapter}
                targetChapters={targetChapters}
                refreshToken={chapterPlansRefreshKey}
                onRefresh={() => setChapterPlansRefreshKey((value) => value + 1)}
                onPlansChange={setChapterPlansSnapshot}
                onSelectChapter={setSelectedPlanChapter}
                selectedChapter={selectedPlanChapter ?? chapterPlans[0]?.chapterNumber ?? null}
                chapterNumbers={chapters.map((chapter) => chapter.number)}
                onOpenHistory={setHistoryChapter}
              />
          </div>
        </div>
      </aside>

      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={(e) => startDrag("left", e)}
        className={["group relative z-10 w-2 shrink-0 cursor-col-resize select-none bg-transparent touch-none", draggingSide === "left" ? "bg-primary/20" : "hover:bg-primary/10"].join(" ")}
        title="拖拽调整左侧宽度"
      >
        <div className={["absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors", draggingSide === "left" ? "bg-primary/60" : "bg-border/30 group-hover:bg-primary/40"].join(" ")} />
      </div>

      <main className="min-w-0 flex-1 overflow-hidden flex flex-col min-h-0">
        <div className="shrink-0 border-b border-border/30 px-4 py-3 flex items-center justify-between gap-3 overflow-x-auto">
          <div className="flex min-w-0 flex-nowrap items-center gap-2 text-xs text-muted-foreground">
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 hover:text-foreground">
                <Database size={12} />资产列表 <ChevronDown size={12} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-80">
                <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">核心文件</div>
                <DropdownMenuGroup>
                  {ASSET_MENU_ITEMS.map((item) => (
                    <DropdownMenuItem key={item.file} onClick={() => openReaderFile(item.file, item.mode, "truth")}>
                      {renderMenuEntry(item)}
                    </DropdownMenuItem>
                  ))}
                  {ASSET_MENU_ITEMS.length === 0 && (
                    <DropdownMenuItem onClick={() => nav.toTruth(bookId)}>
                      {renderMenuEmpty("暂无核心文件", "请先生成基础资料")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">向导资料</div>
                <DropdownMenuGroup>
                  {["story/author_intent.md", "story/current_focus.md"].map((file) => (
                    <DropdownMenuItem key={file} onClick={() => openReaderFile(file, "truth", "truth")}>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate">{getArtifactLabel(file).title}</span>
                        <span className="text-[10px] text-muted-foreground">{getArtifactLabel(file).subtitle} / 向导资料</span>
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 hover:text-foreground">
                <Database size={12} />小说真相 <ChevronDown size={12} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-80">
                <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">真相文件</div>
                <DropdownMenuGroup>
                  {TRUTH_MENU_ITEMS.map((item) => {
                    const label = getArtifactLabel(item.file);
                    return (
                      <DropdownMenuItem key={item.file} onClick={() => openReaderFile(item.file, "truth", "truth")}>
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate">{label.title}</span>
                          <span className="text-[10px] text-muted-foreground">{label.subtitle}</span>
                        </div>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 hover:text-foreground">
                <BookOpen size={12} />向导资料 <ChevronDown size={12} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">8 步向导</div>
                <DropdownMenuGroup>
                  {GUIDE_MENU_ITEMS.map((item) => (
                    <DropdownMenuItem
                      key={`${item.file}:${item.title}`}
                      onClick={() => openReaderFile(item.file, item.mode === "wizard" ? "truth" : item.mode, item.mode === "wizard" ? "wizard" : "truth")}
                    >
                      {renderMenuEntry(item)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <button onClick={() => nav.toAnalytics(bookId)} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/50 px-2 py-1 hover:text-foreground"><BarChart2 size={12} />分析</button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { void dispatchWriteNextInstruction(bookId); }}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 hover:text-primary"
              title={t("book.writeNext")}
            >
              <Zap size={12} />{t("book.writeNext")}
            </button>
            <button onClick={() => setConfirmDeleteOpen(true)} disabled={deleting} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/20 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"><Trash2 size={12} />删除</button>
          </div>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden flex">
          <section className={`min-h-0 min-w-0 flex-1 overflow-x-hidden p-4 ${designSelected || readerMode === "script" || readerMode === "production" ? "overflow-y-auto" : "overflow-hidden"}`}>
            <div className="mx-auto h-full w-full max-w-none min-h-0">
              {designSelected ? (
                <ChapterPlanReader
                  plan={selectedPlan}
                  canEdit={Boolean(selectedPlan && !selectedPlanHasContent)}
                  onEditReview={selectedPlan ? handleOpenReview : undefined}
                  onApprove={selectedPlan ? handleApprovePlan : undefined}
                  onOpenHistory={selectedPlan ? () => setHistoryChapter(selectedPlan.chapterNumber) : undefined}
                />
              ) : readerMode === "script" ? (
                <ScriptWorkspacePanel
                  bookTitle={book.title}
                  chapters={chapters}
                  workspace={scriptWorkspace}
                  saving={scriptSaving}
                  generating={scriptGenerating}
                  checklistItems={checklistItems}
                  checklistTemplates={taskChecklistData?.templates ?? []}
                  checklistTemplateId={checklistTemplateId}
                  checklistProgress={checklistProgress}
                  checklistInput={checklistInput}
                  checklistNote={checklistNote}
                  checklistSaving={checklistSaving}
                  onChange={handleChangeScriptWorkspace}
                  onSave={() => void handleSaveScriptWorkspace()}
                  onGenerate={() => void handleGenerateScriptWorkspace()}
                  onOpenHistory={() => setScriptHistoryOpen(true)}
                  onChecklistInputChange={setChecklistInput}
                  onChecklistNoteChange={setChecklistNote}
                  onChecklistAdd={() => void handleChecklistAdd()}
                  onChecklistTemplateChange={handleChecklistTemplateChange}
                  onChecklistToggle={(itemId, done) => void handleChecklistToggle(itemId, done)}
                  onChecklistRemove={(itemId) => void handleChecklistRemove(itemId)}
                  onChecklistGenerate={() => void handleChecklistGenerate()}
                  onChecklistSave={() => void handleChecklistSave()}
                />
              ) : readerMode === "production" ? (
                <ProductionWorkspacePanel
                  bookId={bookId}
                  workspace={productionWorkspace}
                  directorPlan={directorPlan}
                  assetLibrary={assetLibrary}
                  generating={productionGenerating}
                  saving={productionSaving}
                  directorPlanGenerating={directorPlanGenerating}
                  directorPlanSaving={directorPlanSaving}
                  assetLibraryGenerating={assetLibraryGenerating}
                  assetLibrarySaving={assetLibrarySaving}
                  onChange={handleChangeProductionWorkspace}
                  onDirectorPlanChange={handleChangeDirectorPlan}
                  onAssetLibraryChange={handleChangeAssetLibrary}
                  onGenerate={() => void handleGenerateProductionWorkspace()}
                  onSave={() => void handleSaveProductionWorkspace()}
                  onOpenDirectorPlanHistory={() => setDirectorPlanHistoryOpen(true)}
                  onOpenAssetLibraryHistory={() => setAssetLibraryHistoryOpen(true)}
                  onGenerateDirectorPlan={() => void handleGenerateDirectorPlan()}
                  onSaveDirectorPlan={() => void handleSaveDirectorPlan()}
                  onGenerateAssetLibrary={() => void handleGenerateAssetLibrary()}
                  onSaveAssetLibrary={() => void handleSaveAssetLibrary()}
                  onUploadAssetLibraryFile={handleUploadAssetLibraryFile}
                />
              ) : (
                <ArtifactView bookId={bookId} t={t} />
              )}
            </div>
          </section>

          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={(e) => startDrag("right", e)}
            className={["group relative z-10 w-2 shrink-0 cursor-col-resize select-none bg-transparent touch-none", draggingSide === "right" ? "bg-primary/20" : "hover:bg-primary/10"].join(" ")}
            title="拖拽调整右侧宽度"
          >
            <div className={["absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors", draggingSide === "right" ? "bg-primary/60" : "bg-border/30 group-hover:bg-primary/40"].join(" ")} />
          </div>

          <BookDetailChatDock
            bookId={bookId}
            nav={nav}
            theme={theme}
            t={t}
            sse={sse}
            width={rightWidth}
            latestChapterNumber={latestChapterNumber}
            latestChapterAuditReport={latestChapterAuditReport}
            nextChapter={nextChapter}
            targetChapters={targetChapters}
            chapterWordCount={book.chapterWordCount}
          />
        </div>
      </main>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t("book.deleteBook")}
        message={t("book.confirmDelete")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={handleDeleteBook}
        onCancel={() => setConfirmDeleteOpen(false)}
      />

      {planEditorChapter !== null && planEditorPlan && (
        <EditPlanModal
          bookId={bookId}
          chapterNumber={planEditorChapter}
          plan={planEditorPlan}
          canEdit={!selectedPlanHasContent}
          needsReview={planEditorPlan.needsReview ?? false}
          initialSource={planEditorSource}
          onApprove={async () => {
            await handleApprovePlan();
            setPlanEditorChapter(null);
          }}
          onClose={() => setPlanEditorChapter(null)}
          onSave={handleSavePlan}
        />
      )}

      {historyChapter !== null && historyPlan && (
        <VersionHistoryModal
          bookId={bookId}
          chapterNumber={historyChapter}
          currentPlan={historyPlan}
          onClose={() => setHistoryChapter(null)}
          onRestore={async (restoredPlan) => {
            setHistoryChapter(null);
            await refetchChapterPlans();
            setChapterPlansRefreshKey((value) => value + 1);
            setSelectedPlanChapter(restoredPlan.chapterNumber);
          }}
        />
      )}

      {scriptHistoryOpen && scriptWorkspace && (
        <ScriptWorkspaceHistoryModal
          bookId={bookId}
          currentWorkspace={scriptWorkspace}
          onClose={() => setScriptHistoryOpen(false)}
          onRestore={(workspace) => {
            setScriptWorkspaceDraft(workspace);
            setScriptHistoryOpen(false);
            void refetchScriptWorkspace();
          }}
        />
      )}

      {directorPlanHistoryOpen && directorPlan && (
        <DirectorPlanHistoryModal
          bookId={bookId}
          currentPlan={directorPlan}
          onClose={() => setDirectorPlanHistoryOpen(false)}
          onRestore={(plan) => {
            setDirectorPlanDraft(plan);
            setDirectorPlanHistoryOpen(false);
            void refetchDirectorPlan();
          }}
        />
      )}

      {assetLibraryHistoryOpen && assetLibrary && (
        <AssetLibraryHistoryModal
          bookId={bookId}
          currentLibrary={assetLibrary}
          onClose={() => setAssetLibraryHistoryOpen(false)}
          onRestore={(library) => {
            setAssetLibraryDraft(library);
            setAssetLibraryHistoryOpen(false);
            void refetchAssetLibrary();
          }}
        />
      )}

      {auditHistoryChapter !== null && auditHistoryChapterMeta && (
        <ChapterAuditHistoryModal
          chapterNumber={auditHistoryChapter}
          chapterTitle={auditHistoryChapterMeta.title}
          history={Array.isArray(auditHistoryChapterMeta.auditHistory) ? auditHistoryChapterMeta.auditHistory : []}
          onClose={() => setAuditHistoryChapter(null)}
        />
      )}
    </div>
  );
}






