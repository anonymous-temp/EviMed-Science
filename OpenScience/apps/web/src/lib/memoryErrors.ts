import { WebApiError } from "./apiClient";

/** A save or a forget named a version of the memory that is no longer the current one: someone (the memory itself) changed it first. */
export function isMemoryConflict(error: unknown): boolean {
  return error instanceof WebApiError && error.code === "memory_conflict";
}

/** The memory service could not be reached: the page says so in place of the list, and the conversation goes on. */
export function isMemoryServiceUnavailable(error: unknown): boolean {
  return error instanceof WebApiError && error.code === "memory_engine_unavailable";
}

/** What the page says when a save raced a change: the list is read again, so the next try starts from what the memory says now. */
export const MEMORY_CONFLICT_SENTENCE = "这条记忆刚刚被更新过，已按最新内容刷新，请再改一次。";
