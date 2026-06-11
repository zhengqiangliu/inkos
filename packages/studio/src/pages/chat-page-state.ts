export interface ChatPageModelInfo {
  readonly id: string;
  readonly name?: string;
}

export interface ChatPageModelGroup {
  readonly service: string;
  readonly label: string;
  readonly models: ReadonlyArray<ChatPageModelInfo>;
}

export interface PersistedModelSelection {
  readonly service: string | null;
  readonly defaultModel: string | null;
}

export interface AssistantPreviewState {
  readonly shouldShowPreview: boolean;
  readonly previewLabel: string;
  readonly previewContent: string;
}

const BOOK_CREATE_SESSION_KEY = "inkos.book-create.session-id";

export function getBookCreateSessionId(): string | null {
  return globalThis.localStorage?.getItem(BOOK_CREATE_SESSION_KEY) ?? null;
}

export function setBookCreateSessionId(sessionId: string): void {
  globalThis.localStorage?.setItem(BOOK_CREATE_SESSION_KEY, sessionId);
}

export function clearBookCreateSessionId(): void {
  globalThis.localStorage?.removeItem(BOOK_CREATE_SESSION_KEY);
}

export function filterModelGroups(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  search: string,
): ReadonlyArray<ChatPageModelGroup> {
  const query = search.trim().toLowerCase();
  if (!query) return groupedModels;

  return groupedModels
    .map((group) => ({
      ...group,
      models: group.models.filter((model) =>
        (model.name ?? model.id).toLowerCase().includes(query)
        || group.label.toLowerCase().includes(query),
      ),
    }))
    .filter((group) => group.models.length > 0);
}

export function resolveModelSelection(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  selectedModel: string | null,
  selectedService: string | null,
): { model: string; service: string } | null {
  if (groupedModels.length === 0) return null;

  if (selectedModel && selectedService) {
    const selectedGroup = groupedModels.find((group) => group.service === selectedService);
    const exists = selectedGroup?.models.some((model) => model.id === selectedModel) ?? false;
    if (exists) {
      return { model: selectedModel, service: selectedService };
    }
  }

  const first = groupedModels[0];
  if (!first || first.models.length === 0) return null;
  return { model: first.models[0]!.id, service: first.service };
}

export function resolvePersistedModelSelection(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  persisted: PersistedModelSelection | null | undefined,
): { model: string; service: string } | null {
  if (!persisted) return null;
  const persistedModel = persisted.defaultModel?.trim() ?? "";
  const persistedService = persisted.service?.trim() ?? "";
  if (!persistedModel || !persistedService) return null;
  const group = groupedModels.find((item) => item.service === persistedService);
  if (!group) return null;
  const matched = group.models.find((model) => model.id === persistedModel);
  if (!matched) return null;
  return { model: matched.id, service: group.service };
}

export function resolveAssistantPreview(args: {
  readonly content: string;
  readonly hasAudit: boolean;
}): AssistantPreviewState {
  const hasContent = Boolean(args.content);
  const previewLabel = args.hasAudit
    ? (hasContent ? "正文流预览 / 审计结果" : "审计结果")
    : "正文流预览";
  return {
    shouldShowPreview: hasContent || args.hasAudit,
    previewLabel,
    previewContent: hasContent ? args.content : "",
  };
}
