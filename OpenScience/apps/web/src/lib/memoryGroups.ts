import type { WebStructuredMemory } from "./apiClient";
import type { OwnCapsuleEntry } from "./memoryClient";

/**
 * Where a fact belongs on the capsule page: 关于你 or a project (2026-10-07
 * plan §3.2). Each is one tab, one list; 做法 is the third tab and holds the
 * learned methods and capability handbooks, which are not facts at all, and 成长
 * the fourth.
 *
 * Two stores answer one question here. A structured memory files itself by
 * kind and scope; a capsule entry by its fact kind and the project it was
 * noted in. Habits — how the researcher works and writes — are about them, so
 * they sit in 关于你 under their own small header; they used to be filed as
 * 做法, which is now the name of what the platform learned.
 */
export type MemoryGroup = "self" | "project";

/** The kinds that are a project's facts rather than the researcher's. */
const PROJECT_KINDS: ReadonlySet<string> = new Set(["project_fact", "analysis", "decision", "follow_up", "run_summary"]);

export function recordGroup(record: Pick<WebStructuredMemory, "scope" | "kind">): MemoryGroup {
  return record.scope === "project" || PROJECT_KINDS.has(record.kind) ? "project" : "self";
}

export function entryGroup(entry: Pick<OwnCapsuleEntry, "projectId" | "payload">): MemoryGroup {
  return entry.projectId || PROJECT_KINDS.has(entry.payload.factKind) ? "project" : "self";
}

/** The project a row belongs to, when it names one. */
export function recordProjectId(record: Pick<WebStructuredMemory, "scope" | "scopeId">): string | null {
  return record.scope === "project" && record.scopeId ? record.scopeId : null;
}

/**
 * The small headers inside 关于你, in the order they are read: who they are,
 * what they prefer, how they work and write, what they corrected. One word for
 * the same thing whichever store a row comes from.
 */
export type SelfSection = "background" | "preference" | "habit" | "correction" | "other";

export const SELF_SECTIONS: readonly { key: SelfSection; label: string }[] = [
  { key: "background", label: "背景" },
  { key: "preference", label: "偏好" },
  { key: "habit", label: "工作与写作习惯" },
  { key: "correction", label: "纠正过的" },
  { key: "other", label: "其他" },
];

const SECTION_OF_KIND: Readonly<Record<string, SelfSection>> = {
  profile: "background", expertise: "background", stance: "background",
  preference: "preference",
  behavior: "habit", writing_style: "habit", method_preference: "habit", tooling: "habit",
  correction: "correction",
};

/** The header a row of 关于你 sits under: its kind, in either store's vocabulary. */
export function selfSection(kind: string): SelfSection {
  return SECTION_OF_KIND[kind] ?? "other";
}

/** What a memory kind is called as a drawer's title, for a project's facts as for a person's. */
const KIND_TITLES: Readonly<Record<string, string>> = {
  profile: "背景", expertise: "背景", stance: "背景", preference: "偏好", behavior: "工作习惯", writing_style: "写作习惯", method_preference: "工作习惯", tooling: "工作习惯",
  correction: "纠正过的", project_fact: "项目事实", analysis: "分析口径", decision: "已定的决策", follow_up: "待跟进", tension: "两难之处",
};

export function kindTitle(kind: string): string {
  return KIND_TITLES[kind] ?? "记忆";
}
