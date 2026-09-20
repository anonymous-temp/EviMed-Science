/**
 * What one conversation's own state adds to its dispatch.
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
 * capsule's methods and standards, and this is where its dispatch picks them
 * up.
 *
 * @module memorySessions
 */

/**
 * The lines one conversation's own state adds to its system prompt. Best
 * effort: a state that cannot be read adds nothing rather than failing the turn.
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
