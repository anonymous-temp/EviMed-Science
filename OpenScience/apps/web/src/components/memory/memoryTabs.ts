/** The memory page's three lists: what is about the person (the memories of a project among them), what was learned, what was received. */
export type MemoryTab = "self" | "methods" | "received";
/**
 * The sidebar's directory also holds 总览, which is a page of its own (`/app/memory/overview`) read as the first section of this one: the
 * capsule as one data page, and the lists are what each of its numbers opens. The map that was a tab of its own until 2026-10-27 is part of it now.
 * 项目 was a section until 2026-10-28: a person has one capsule and a project is a label on a memory, so a project's memories are a group
 * of 关于你, each row naming its project.
 */
export type MemoryPageTab = MemoryTab | "overview";

export const MEMORY_TAB_NAMES: Record<MemoryPageTab, string> = { overview: "总览", self: "关于你", methods: "做法", received: "收到的" };

/** Where 记忆胶囊 opens: the overview — the capsule as one data page, from the first day. */
export const MEMORY_OVERVIEW_ADDRESS = "/app/memory/overview";

/** Where a section goes: the lists are one page that reads `?tab=`, the overview is its own address. */
export function memoryTabAddress(tab: MemoryPageTab): string {
  return tab === "overview" ? MEMORY_OVERVIEW_ADDRESS : `/app/memory?tab=${tab}`;
}
