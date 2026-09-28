/**
 * What one conversation's own state adds to it.
 *
 * Hidden knowledge: this module used to be a subsystem. It served
 * 「本次用到的背景」 — a panel listing every memory, note, capsule fact and
 * mounted method a conversation had been handed, read out of the run ledger —
 * plus 「本次不用」, which set one of them aside for the rest of the
 * conversation, plus the 无痕 switch. All three were reached from one grey bar
 * above the conversation, and all three were deleted on 2026-09-20: the bar
 * was three controls the researcher had to operate over a thing the platform
 * is supposed to handle itself, and 无痕 in particular duplicated the
 * account-level recall pause at a cost of ten server call sites (owner ruling:
 * 「无痕、本次用到的背景都不要」).
 *
 * What is left is the one thing that was never about withholding memory: a
 * conversation trying a capsule someone shared (「试用一次」) is handed that
 * capsule's methods and standards, and is listed under a title that says so.
 *
 * The capsule plugin asks for the first through the capsule gateway at the
 * conversation's first step (`session` in `capsuleGateway.mjs`). It used to be
 * added only to a dispatch from the shell, and a trial is opened in the
 * kernel's own conversation surface, whose prompts never pass through one: a
 * trial was a conversation that wrote no memory and had never seen the pack
 * (2026-09-28).
 *
 * @module memorySessions
 */

/**
 * The lines one conversation's own state adds to its context. Best effort: a
 * state that cannot be read adds nothing rather than failing the turn.
 *
 * @param {{ researchMemory: any, capsules?: any }} services
 * @param {string} userId @param {string} projectId @param {string} sessionId
 * @returns {Promise<string[]>}
 */
export async function sessionDispatchNotes({ researchMemory, capsules = null }, userId, projectId, sessionId) {
  if (!researchMemory?.configured) return [];
  let state;
  try {
    state = await researchMemory.sessionState(userId, projectId, sessionId);
  } catch {
    return [];
  }
  if (!state?.trialCapsuleId || !capsules) return [];
  const trial = await capsules.trialContext(userId, state.trialCapsuleId).catch(() => "");
  return trial ? [trial] : [];
}

/** What a trial conversation's title starts with (build spec §9.4 #8). */
export const TRIAL_TITLE_PREFIX = "试用 · ";

/**
 * A trial conversation's title as the lists show it. Applied where the runs
 * are read, never stored: an automatic title and the researcher's own rename
 * both arrive without it, and a rename that kept it is not prefixed twice.
 * @param {unknown} title @returns {string}
 */
export function trialTitle(title) {
  const text = String(title ?? "").trim();
  if (text.startsWith(TRIAL_TITLE_PREFIX.trim())) return text;
  return text ? `${TRIAL_TITLE_PREFIX}${text}` : TRIAL_TITLE_PREFIX.trim();
}

/**
 * The runs of a project with each trial conversation's title marked.
 * @template {{ sessionId?: string | null, title?: string | null }} T
 * @param {readonly T[]} runs @param {ReadonlySet<string>} trialSessions
 * @returns {T[]}
 */
export function withTrialTitles(runs, trialSessions) {
  if (!trialSessions.size) return [...runs];
  return runs.map((run) => (run.sessionId && trialSessions.has(run.sessionId) ? { ...run, title: trialTitle(run.title) } : run));
}
