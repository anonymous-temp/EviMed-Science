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

/** Why the automatic scan dropped an entry of a shared pack, in the reader's words. */
export const CAPSULE_SCAN_REASONS: Record<string, string> = {
  names_platform_tool: "提到了平台自己的工具或路径",
  unsafe_link_scheme: "含有会自己执行的链接",
  auto_loading_image: "含有一打开就会加载的图片链接",
  credential_in_link: "链接里带着账号和口令",
  instructs_agent: "在指挥助手做研究方法以外的事",
};

/** How far the language half of the scan got. What it did not judge stays in
 *  force as context but is never loaded into a run as a method until a later
 *  scan (the next trial or enable) has judged it. */
export const CAPSULE_SCAN_MODEL_STATUS: Record<string, string> = {
  ok: "签名、格式和内容检查都已完成",
  partial: "签名和格式检查已完成；内容检查只完成了一部分（没检查到的方法先只作参考、不载入运行，下次试用或启用时再检查）",
  unavailable: "签名和格式检查已完成；内容检查暂时不可用（其中的方法先只作参考、不载入运行，下次试用或启用时再检查）",
};
