/**
 * The module's three libraries: reference trials, population definitions, and models with their parameters.
 *
 * They were the home page's views beside 研究 and are not any more (VCR remediation F5, 2026-11-01): they are context a study's 依据 goes to
 * for the whole library, and the old addresses (`/app/virtual-research?tab=…`) keep opening them, so a saved link and every saved
 * object stay reachable.
 */

export type VcrLibraryTab = "precedents" | "definitions" | "models";

export const VCR_LIBRARIES: ReadonlyArray<{ tab: VcrLibraryTab; label: string }> = Object.freeze([
  { tab: "precedents", label: "参考试验" },
  { tab: "definitions", label: "人群定义" },
  { tab: "models", label: "模型与参数" },
]);

/** The address of one library: the module's home, which reads `tab`. */
export function vcrLibraryPath(tab: VcrLibraryTab): string {
  return `/app/virtual-research?tab=${tab}`;
}

export function isVcrLibraryTab(value: string | null | undefined): value is VcrLibraryTab {
  return VCR_LIBRARIES.some((library) => library.tab === value);
}
