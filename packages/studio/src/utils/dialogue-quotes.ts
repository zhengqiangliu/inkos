export function normalizeDialogueQuotesToDouble(content: string): string {
  return content.replace(/「/g, "“").replace(/」/g, "”");
}
