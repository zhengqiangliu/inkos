/**
 * Extract the tail portion of a chapter for衔接 context.
 * Takes from the end, respecting paragraph boundaries, up to maxChars.
 */

export function extractChapterTail(content: string, maxChars = 300): string {
  if (!content || content.length <= maxChars) return content ?? "";

  // Split into paragraphs (double newline separated)
  const paragraphs = content.split(/\n\n+/);
  const reversed: string[] = [];

  let total = 0;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i];
    if (total + p.length > maxChars && reversed.length > 0) break;
    reversed.unshift(p);
    total += p.length;
  }

  return reversed.join("\n\n");
}