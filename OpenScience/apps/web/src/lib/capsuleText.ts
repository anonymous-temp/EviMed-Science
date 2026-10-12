/**
 * What a capsule entry is, in the researcher's words. One table for the page
 * that writes entries and the import preview that reads them: the preview used
 * to print the stored `factKind` (`method_preference`) where the page printed
 * 「研究方法」 for the same entry (2026-09-16 review, U11).
 */
export const CAPSULE_ENTRY_TYPES = [
  { value: "method_preference", label: "研究方法", layer: "methods" },
  { value: "writing_style", label: "写作偏好", layer: "profile" },
  { value: "preference", label: "一般偏好", layer: "profile" },
  { value: "expertise", label: "背景知识", layer: "knowledge" },
  { value: "project_fact", label: "项目事实", layer: "knowledge" },
  { value: "correction", label: "经验教训", layer: "episodes" },
] as const;

export function capsuleEntryLabel(factKind: string): string {
  return CAPSULE_ENTRY_TYPES.find((item) => item.value === factKind)?.label ?? "研究记录";
}

/**
 * What a preview shows of one entry: a line naming it and the text under that line. A shared method opens with its name and a paragraph
 * saying what it is for, in its sharer's words, and goes on in the text written for the model that runs it; a preview shows the name and
 * that paragraph and never the rest (design reference §14.1: no model-written body on a screen). Any other entry is its own text, whole.
 */
export function capsuleEntryPreview(entry: { factKind: string; content: string }): { summary: string; text: string } {
  const label = capsuleEntryLabel(entry.factKind);
  if (entry.factKind !== "method_preference") return { summary: label, text: entry.content };
  const [first = "", ...rest] = entry.content.trim().split(/\n\s*\n/);
  const heading = first.trim();
  if (!heading.startsWith("# ")) return { summary: label, text: heading };
  return { summary: `${label}：${heading.slice(2).trim()}`, text: (rest[0] ?? "").trim() };
}

/**
 * The entries of a previewed pack that come in. The automatic scan still decides, on the server, what is mounted; the screen shows what
 * comes in and neither lists, counts nor explains what the scan left out (owner ruling 2026-10-10: a scan result, a trust verdict and a
 * model-written reason are the back office's).
 */
export function takenEntries<T extends { id: string }>(entries: readonly T[], scan?: { dropped?: ReadonlyArray<{ id: string }> } | null): T[] {
  const left = new Set((scan?.dropped ?? []).map((item) => item.id));
  return entries.filter((entry) => !left.has(entry.id));
}

/** 「来自 …」 with a typed space only before Latin text: 「来自李主任」, 「来自 Alice」. */
export function fromSender(author: string): string {
  return /^[A-Za-z0-9]/.test(author) ? `来自 ${author}` : `来自${author}`;
}

/**
 * The longest signature (署名) the share dialog takes, in characters: the bound the control plane enforces
 * (`SIGNATURE_MAX_CHARS` in `capsuleShareLabel.mjs`; a server test holds the two equal).
 */
export const CAPSULE_SIGNATURE_MAX_CHARS = 60;
