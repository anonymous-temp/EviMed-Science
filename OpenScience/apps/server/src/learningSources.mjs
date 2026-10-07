/**
 * 「从哪里学到的」: the conversations a learned method or a capability handbook
 * came out of, as links a researcher can follow from its drawer.
 *
 * Hidden knowledge: a method or handbook stores the run that taught it, not the
 * conversation, and the run may sit in a project that was deleted since — the
 * lesson's own copy is then all that is left (`resolveLessonSourceRun`). This
 * resolves each run to its conversation within the account that owns it, keeps
 * the ones that still name a session, and says nothing about the rest: a
 * source that cannot be found is a link the drawer does not show, never a
 * reason the drawer does not open. What is returned is a label — the platform
 * never reads a conversation back through it.
 */

/** How many conversations a drawer lists at most: the newest lessons a method was amended by. */
export const LEARNING_SOURCES_LIMIT = 5;

/** @param {unknown} value @param {number} max */
function excerpt(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * @param {{ resolveRun: ((userId: string, projectId: string, runId: string) => Promise<any>) | null }} dependencies
 * @param {string} userId
 * @param {readonly { projectId?: string | null, runId?: string | null }[]} refs the runs named, newest first
 * @returns {Promise<{ projectId: string, sessionId: string, title: string, at: string | null }[]>}
 */
export async function conversationSources({ resolveRun }, userId, refs) {
  if (!resolveRun) return [];
  /** @type {{ projectId: string, sessionId: string, title: string, at: string | null }[]} */
  const found = [];
  const seen = new Set();
  for (const ref of refs) {
    if (found.length >= LEARNING_SOURCES_LIMIT) break;
    const projectId = typeof ref?.projectId === "string" ? ref.projectId : "";
    const runId = typeof ref?.runId === "string" ? ref.runId : "";
    if (!projectId || !runId || seen.has(`${projectId}\u0000${runId}`)) continue;
    seen.add(`${projectId}\u0000${runId}`);
    /** @type {any} */
    let run = null;
    try { run = await resolveRun(userId, projectId, runId); } catch { run = null; }
    const sessionId = typeof run?.sessionId === "string" ? run.sessionId : "";
    if (!sessionId || found.some((item) => item.sessionId === sessionId && item.projectId === projectId)) continue;
    found.push({
      projectId, sessionId,
      title: excerpt(run.title || run.question, 80),
      at: typeof run.finishedAt === "string" ? run.finishedAt : typeof run.startedAt === "string" ? run.startedAt : null,
    });
  }
  return found;
}
