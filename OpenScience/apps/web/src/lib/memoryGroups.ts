import type { WebStructuredMemory } from "./apiClient";
import type { OwnCapsuleEntry } from "./memoryClient";

/**
 * Where a memory belongs on the capsule page: 关于你, 做法, or a project
 * (2026-09-23 plan §5.6). The same word is the row's left column and the
 * filter that keeps it, so a reader who filters 做法 sees exactly the rows
 * that say 做法; a project's rows say the project's own name.
 *
 * Three stores answer one question here. A structured memory files itself by
 * kind and scope; a learned method is always 做法; a capsule entry by its fact
 * kind and the project it was noted in.
 */
export type MemoryGroup = "self" | "methods" | "project";

export const MEMORY_GROUP_ORDER: readonly MemoryGroup[] = ["self", "methods", "project"];

/** The kinds that are a project's facts rather than the researcher's. */
const PROJECT_KINDS: ReadonlySet<string> = new Set(["project_fact", "analysis", "decision", "follow_up", "run_summary"]);

/** How the researcher works — the habits a run observed. Stated preferences are about them. */
const METHOD_KINDS: ReadonlySet<string> = new Set(["behavior"]);

export function recordGroup(record: Pick<WebStructuredMemory, "scope" | "kind">): MemoryGroup {
  if (record.scope === "project" || PROJECT_KINDS.has(record.kind)) return "project";
  if (METHOD_KINDS.has(record.kind)) return "methods";
  return "self";
}

const METHOD_FACT_KINDS: ReadonlySet<string> = new Set(["method_preference", "writing_style"]);

export function entryGroup(entry: Pick<OwnCapsuleEntry, "projectId" | "payload">): MemoryGroup {
  if (METHOD_FACT_KINDS.has(entry.payload.factKind)) return "methods";
  if (entry.projectId || entry.payload.factKind === "project_fact") return "project";
  return "self";
}

/** The project a row belongs to, when it names one. */
export function recordProjectId(record: Pick<WebStructuredMemory, "scope" | "scopeId">): string | null {
  return record.scope === "project" && record.scopeId ? record.scopeId : null;
}

/** The left column's words: 关于你, 做法, or the project's name (「项目」 when it has none to show). */
export function groupLabel(group: MemoryGroup, projectName?: string | null): string {
  if (group === "self") return "关于你";
  if (group === "methods") return "做法";
  return projectName?.trim() || "项目";
}
