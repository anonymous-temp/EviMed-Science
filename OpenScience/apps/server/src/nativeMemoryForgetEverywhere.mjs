import { recordForgetDuplicates } from "./nativeMemoryMetrics.mjs";
import { lineFingerprint, normalisedStatement } from "./nativeMemoryOverlay.mjs";
import { REJECTION_JUDGE_MAX_CANDIDATES, containsRemoved, nearRemoved, similarity } from "./nativeMemoryRejections.mjs";

/**
 * Forget means forget everywhere (2026-10-25, found by the production baseline of `evals/capsule-longitudinal`, S4).
 *
 * A commute the person stated once was kept in two files; their 「忘记」 on one left the other, so the next conversation still said they
 * rode a bicycle to work and a reworded restatement brought the first back. The rule of the rejection list — a line the person removed
 * stays removed, in its words and in others' — covered the engine writing it again; it did not cover the engine having written it twice.
 *
 * When the person forgets a line, or a file, every other statement of their native memory that says the same thing goes with it, in the
 * same act. Finding them is the rejection list's own two steps over the lines that are already there, and no third: a line that contains
 * a removed line's words is decided in code (`containsRemoved`); a line that is only near one (`nearRemoved`, a prefilter of shared character
 * pairs) is put to the one judge the rejection list has (`createRejectionJudge`, one Flash call, the same instruction: whether a line says the
 * same thing as one of its options), whose answer the code verifies (an index that exists, a pair it offered). A judge that cannot be
 * reached, answers badly or has spent the account's day keeps the lines: a forget never fails for it, and the lines stay where they are.
 *
 * This module only finds them. The store removes each as a revision of the same act (`forgotten on the memory page … [act:<id>]`), puts
 * its words on the rejection list under the file's own type, and brings them all back when any one is restored.
 *
 * @module nativeMemoryForgetEverywhere
 */

/** The marker that ties the revisions of one act together, in a revision's reason (at most 200 characters, so the marker is last and short). */
export const ACT_PATTERN = /\[act:([a-f0-9]{12})\]/;

/** @param {string} reason @returns {string | null} the act a revision's reason names */
export function actOf(reason) {
  return ACT_PATTERN.exec(String(reason ?? ""))?.[1] ?? null;
}

/**
 * Which statements of the account's memory say what the removed ones said.
 *
 * @param {{
 *   files: readonly { uri: string, type: string, statements: readonly string[] }[],
 *   removed: readonly string[],
 *   judge?: { same: (request: any) => Promise<{ same: Map<number, string>, stated: Set<number> }> } | null,
 *   userId: string,
 * }} input `files`: every native file with its statements (the platform's label lines already left out), including the file the removed
 *   lines came from, minus those lines; `removed`: the words the person removed
 * @returns {Promise<Map<string, string[]>>} for each file with any, the statements of it that repeat a removed one, as they stand in the file
 */
export async function duplicatesOf({ files, removed, judge = null, userId }) {
  /** @type {Map<string, string[]>} */
  const found = new Map();
  const gone = [...new Map(removed.map((text) => [lineFingerprint(text), { fingerprint: lineFingerprint(text), text: normalisedStatement(text).slice(0, 400) }])).values()].filter((line) => line.text);
  if (!gone.length) return found;
  const goneFingerprints = new Set(gone.map((line) => line.fingerprint));
  /** @type {{ uri: string, line: string, score: number, near: { fingerprint: string, text: string }[] }[]} */
  const near = [];
  const keep = (/** @type {string} */ uri, /** @type {string} */ line) => found.set(uri, [...(found.get(uri) ?? []), line]);
  for (const file of files) {
    for (const line of file.statements) {
      const print = lineFingerprint(line);
      if (goneFingerprints.has(print)) continue;
      if (gone.some((entry) => containsRemoved(line, entry.text))) { keep(file.uri, line); continue; }
      const candidates = nearRemoved(line, gone).map((entry) => ({ fingerprint: entry.fingerprint, text: /** @type {string} */ (entry.text) }));
      if (candidates.length) near.push({ uri: file.uri, line, near: candidates, score: Math.max(...candidates.map((entry) => similarity(line, entry.text))) });
    }
  }
  if (!near.length) return found;
  // One call: the nearest few. The judge takes at most `REJECTION_JUDGE_MAX_CANDIDATES` lines, the best-scored ones first.
  const asked = near.sort((left, right) => right.score - left.score).slice(0, REJECTION_JUDGE_MAX_CANDIDATES);
  if (!judge) { recordForgetDuplicates("judge_failed", asked.length); return found; }
  const verdict = await judge.same({ userId, candidates: asked.map((entry) => ({ text: normalisedStatement(entry.line), removed: entry.near })), said: [] });
  let kept = 0;
  /** The lines only the judge called the same, as `uri NUL line`: a delete, which cannot be undone, takes none of them (`withoutJudged`). */
  const judged = new Set();
  asked.forEach((entry, index) => {
    if (verdict.same.has(index)) { keep(entry.uri, entry.line); judged.add(`${entry.uri}\u0000${entry.line}`); } else kept += 1;
  });
  Object.defineProperty(found, "judged", { value: judged });
  // A judge that returned nothing at all and a judge that said "different" are told apart by the rejection judge's own counters.
  recordForgetDuplicates("kept", kept);
  return found;
}

/**
 * The part of a plan that code decided (a line that contains the removed words): what a delete takes with it. A line only the judge called the
 * same is forgotten restorably by a forget and left where it is by a delete, because a model's judgement is never made irreversible.
 * @param {Map<string, string[]> & { judged?: Set<string> }} plan @returns {Map<string, string[]>}
 */
export function withoutJudged(plan) {
  const judged = plan.judged;
  if (!judged?.size) return plan;
  const certain = new Map();
  for (const [uri, lines] of plan) {
    const kept = lines.filter((line) => !judged.has(`${uri}\u0000${line}`));
    if (kept.length) certain.set(uri, kept);
  }
  return certain;
}

