export function resolveChapterRevisionContent(response: unknown): string | null {
  const draftRaw = (response as { details?: { draftRaw?: unknown } } | null | undefined)?.details?.draftRaw;
  if (typeof draftRaw === "string" && draftRaw.trim()) {
    return draftRaw;
  }
  const directResponse = (response as { response?: unknown } | null | undefined)?.response;
  if (typeof directResponse === "string" && directResponse.trim()) {
    return directResponse;
  }
  return null;
}
