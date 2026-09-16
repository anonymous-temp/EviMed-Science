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
