/** A task id the shell is willing to put in an address (`agenda-` plus a random suffix). */
const ADDRESSABLE_TASK = /^[A-Za-z0-9_-]{1,160}$/;

/** The scheduled-tasks page, and one task of it. One route, with or without the id (`autopilot/:taskId?`). */
export const TASKS_PATH = "/app/autopilot";

/**
 * Where a task lives, with the list state that travels with it: the search text and the execution the researcher chose (the task
 * bar's 「第 N 次」). Both ride in the address so Back, Forward and a shared link restore what was on screen.
 */
export function taskPath(taskId?: string | null, state: { search?: string; execution?: string | null } = {}): string {
  const base = taskId && ADDRESSABLE_TASK.test(taskId) ? `${TASKS_PATH}/${encodeURIComponent(taskId)}` : TASKS_PATH;
  const query = new URLSearchParams();
  if (state.search?.trim()) query.set("q", state.search);
  if (taskId && state.execution && ADDRESSABLE_TASK.test(state.execution)) query.set("execution", state.execution);
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}

/**
 * Whether an address is one task's page. The kernel's conversation frame is placed over this page's pane
 * (`SessionFrameHost`), so — as for the chat surface — this is read on every navigation, from the address alone.
 * It matches exactly the shape `autopilot/:taskId` matches.
 */
export function isTaskPath(pathname: string): boolean {
  return /^\/app\/autopilot\/[^/]+\/?$/.test(pathname);
}

/** The task an address names, or null for the list. */
export function taskIdFromPath(pathname: string): string | null {
  if (!isTaskPath(pathname)) return null;
  const raw = pathname.slice(`${TASKS_PATH}/`.length).replace(/\/$/, "");
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  return ADDRESSABLE_TASK.test(decoded) ? decoded : null;
}
