/**
 * What the pipeline does with the faithfulness check (c3-faith, 2026-10-25), kept out of `frontierPipeline.mjs` so it can be tested
 * without a database: the study facts of an item (read from the row when they were made from this very text, asked for otherwise),
 * the check of a written 导读 or 要点 against them, and the closed record of what happened.
 *
 * Nothing here is shown to a reader. The record is `editor_diagnostics.faith` (closed words and counts, never the model's text) and
 * the pipeline's counters; a failed call leaves the draft as the writer produced it.
 */

import { frontierFaithBrief, frontierFaithLead, FRONTIER_FAITH_VERSION } from "./frontierFaith.mjs";
import { frontierRepairBrief } from "./frontierBrief.mjs";
import { frontierRepairLead } from "./frontierLead.mjs";
import { FRONTIER_STUDY_FACTS_VERSION, buildStudyFactsInput, frontierStudyFactsView, frontierStudyFactsWanted, frontierWriteStudyFacts } from "./frontierStudyFacts.mjs";
import { readerNumberSource } from "./frontierEditor.mjs";

/** The record kept when the facts of a text could not be had twice over: asked once for that text, not again. */
function emptyRecord(basis) {
  return { version: FRONTIER_STUDY_FACTS_VERSION, basis, empty: true };
}

/**
 * The study facts of an item for the text of hash `sha`: the stored record when it was made from that text (its `basis`), else one
 * model call. `record` is what to store (null when the call failed and nothing is to be recorded), `view` what the check reads
 * (null when there are no facts to read), `fresh` whether `record` is new.
 * @param {{ callJson: Function }} editor
 * @param {{ stored: unknown, sha: string, input: Parameters<typeof buildStudyFactsInput>[0] }} item
 * @returns {Promise<{ record: any | null, view: ReturnType<typeof frontierStudyFactsView>, fresh: boolean, error: string | null, calls: number }>}
 */
export async function frontierEnsureStudyFacts(editor, { stored, sha, input }) {
  const row = stored && typeof stored === "object" && !Array.isArray(stored) ? /** @type {any} */ (stored) : null;
  if (row && row.basis === sha) return { record: row, view: frontierStudyFactsView(row), fresh: false, error: null, calls: 0 };
  const written = await frontierWriteStudyFacts(editor, input);
  if (written.error) return { record: null, view: null, fresh: false, error: written.error, calls: written.attempts ?? 1 };
  const record = written.facts ? { ...written.facts, basis: sha } : emptyRecord(sha);
  return { record, view: frontierStudyFactsView(record), fresh: true, error: null, calls: written.attempts ?? 1 };
}

/**
 * The closed record of one check, for `editor_diagnostics.faith.<kind>`: the outcome, how many suspicions the comparison raised and
 * the source confirmed, which rules fired, how many calls it took. No text of the draft, of the source or of the model.
 * @param {Awaited<ReturnType<typeof frontierFaithLead>>} result
 */
export function faithDiagnostic(result) {
  return { outcome: result.outcome, candidates: result.candidates, confirmed: result.first.length, remaining: result.remaining.length,
    rules: [...new Set(result.first.map((mismatch) => mismatch.rule))], calls: result.calls, error: result.error ? "check_failed" : null };
}

/**
 * Check a written 导读 against an item's study facts. `lead` is the draft to store: the writer's own when nothing was found or the
 * check could not be made, the repaired one, the one without its mismatching sentences, or — when nothing would be left — the
 * item's previous accepted 导读 (`previous`, possibly null: the reader then shows the card's summary).
 * @param {{ callJson: Function }} editor
 * @param {{ facts: ReturnType<typeof frontierStudyFactsView>, lead: string, previous: string | null, input: any, source: string }} item
 */
export async function frontierFaithCheckLead(editor, { facts, lead, previous, input, source }) {
  const result = await frontierFaithLead(editor, { facts, lead, source, repair: (draft, lines) => frontierRepairLead(editor, input, draft, lines) });
  const final = result.outcome === "emptied" ? (previous ?? null) : (result.draft ?? lead);
  return { lead: final, result };
}

/**
 * The same for a written 要点: its text fields and the items of its list fields are checked; the authors' quotation is not read.
 * @param {{ callJson: Function }} editor
 * @param {{ facts: ReturnType<typeof frontierStudyFactsView>, brief: any, previous: any | null, input: any, source: string }} item
 */
export async function frontierFaithCheckBrief(editor, { facts, brief, previous, input, source }) {
  const result = await frontierFaithBrief(editor, { facts, brief, source, repair: (draft, lines) => frontierRepairBrief(editor, input, draft, lines) });
  const final = result.outcome === "emptied" ? (previous ?? null) : (result.draft ?? brief);
  return { brief: final, result };
}

/**
 * The text a check reads a draft against: the title and the settled reader text as the facts were extracted from them.
 * @param {Parameters<typeof buildStudyFactsInput>[0]} input
 */
export function faithSource(input) {
  return readerNumberSource(buildStudyFactsInput(input));
}

/**
 * Store a check's record in the write that stores the draft: the item's study facts when they were made now, and the closed outcome
 * of each text checked under `editor_diagnostics.faith.<kind>` with the version and the time of its check — merged, so the 导读's and
 * the 要点's records sit side by side, and a text written after its check (`lead_at` / `brief_at` later than the record's `at`) reads as
 * not checked (`frontier-rewrite.mjs --steps faith`).
 * @param {{ query: Function }} client @param {string | number} id
 * @param {{ facts: any | null, diagnostic: Record<string, any> | null }} faith @param {Date} at
 */
export async function frontierWriteFaith(client, id, { facts, diagnostic }, at) {
  if (facts) {
    await client.query("UPDATE evimed_frontier.items SET study_facts = $2::jsonb, study_facts_version = $3 WHERE id = $1",
      [id, JSON.stringify(facts), FRONTIER_STUDY_FACTS_VERSION]);
  }
  if (diagnostic && Object.keys(diagnostic).length) {
    const stamp = { version: FRONTIER_FAITH_VERSION, at: at.toISOString() };
    const kinds = Object.fromEntries(Object.entries(diagnostic).map(([kind, record]) => [kind, { ...record, ...stamp }]));
    await client.query(`UPDATE evimed_frontier.items SET editor_diagnostics = coalesce(editor_diagnostics, '{}'::jsonb)
      || jsonb_build_object('faith', coalesce(editor_diagnostics->'faith', '{}'::jsonb) || $2::jsonb) WHERE id = $1`,
    [id, JSON.stringify({ ...stamp, ...kinds })]);
  }
}

export { FRONTIER_FAITH_VERSION, FRONTIER_STUDY_FACTS_VERSION, frontierStudyFactsWanted };
