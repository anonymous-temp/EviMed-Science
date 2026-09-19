/**
 * What a recall is allowed to put in front of the model.
 *
 * This is product policy, not engine policy, which is why it lives on its own:
 * there are now two ways to generate recall candidates — the research-memory
 * service's own listing, and the OpenViking index's hierarchical retrieval —
 * and the question "which of these reach the prompt, and how much of each" must
 * get the same answer from both. Kept private to one of them, the two would
 * drift, and the drift would be invisible: both paths would still return a
 * plausible-looking handful of memories.
 */

// Memories that describe the user rather than a past task: who they are, how
// they want work done, how they work, and what they have already corrected.
// Together these are the long-term profile, so they stay relevant whatever the
// question is. Every other kind is episodic and must match the query. A
// correction belongs here because repeating a mistake the user already fixed
// costs more than carrying it into an unrelated question.
export const DURABLE_RECALL_KINDS = new Set(["profile", "preference", "behavior", "correction"]);

// The profile must not crowd out memories that are relevant to this particular
// question, so it gets at most half the recall budget and episodic matches keep
// the rest. It is a **reservation**, not only a ceiling: the same half is also
// the profile's floor, claimed before any episode is considered.
//
// Hidden knowledge: it used to be a ceiling alone, and that is not symmetric.
// Ranking is score-descending, and an episodic `run_summary` of an earlier
// attempt at the same question matches many query terms while a profile record
// matches none — scoring ~1.8 against double digits. So episodes were selected
// first and the 20 000-character budget was gone before the first durable row
// was reached. Measured 2026-09-16 on production: the `cdss-access` account
// held 44 active project-scope run summaries against 5 user-scope durable
// records, and every `memory.md` written for that project contained run
// summaries only — the researcher's profile, preferences and corrections were
// unreachable, silently, and the memory ablation's two arms consequently
// delivered byte-identical context.
//
// `researchMemory.relevant()` already documents this exact failure and fixes it
// for the *fetch* (durable records get their own query). This is the same fix
// one layer down, for the *selection*.
export const DURABLE_RECALL_BUDGET_SHARE = 0.5;

/**
 * Take ranked candidates, highest first, and return the memories that fit.
 *
 * @param {Array<{ memo: { content: string, kind?: string } }>} ranked
 * @param {{ contextLimit: number, contextMaxChars: number }} budget
 */
export function selectWithinBudget(ranked, { contextLimit, contextMaxChars }) {
  // Never more than the caller asked for, and never a reservation a zero
  // budget cannot honour: `Math.max(1, ...)` exists so a budget of one still
  // admits one durable row, and the `min` keeps it from inventing a slot when
  // the caller asked for none.
  const durableSlots = Math.min(contextLimit, Math.max(1, Math.floor(contextLimit * DURABLE_RECALL_BUDGET_SHARE)));
  const durableChars = Math.floor(contextMaxChars * DURABLE_RECALL_BUDGET_SHARE);

  /** @type {Map<number, { memo: any, content: string }>} */
  const picked = new Map();
  let total = 0;

  /** One pass over the ranked list, taking only the rows this pass is for.
   * @param {boolean} wantDurable @param {number} slotCeiling @param {number} charCeiling */
  const take = (wantDurable, slotCeiling, charCeiling) => {
    let count = 0;
    let used = 0;
    for (const [index, row] of ranked.entries()) {
      if (picked.has(index)) continue;
      if (DURABLE_RECALL_KINDS.has(row.memo.kind) !== wantDurable) continue;
      if (picked.size >= contextLimit || count >= slotCeiling) break;
      const remaining = Math.min(contextMaxChars - total, charCeiling - used);
      if (remaining <= 0) break;
      const content = row.memo.content.slice(0, remaining);
      if (!content) continue;
      picked.set(index, { memo: row.memo, content });
      total += content.length;
      used += content.length;
      count += 1;
    }
  };

  // The profile first, against its reservation. Taking it first is the whole
  // point: a ceiling checked while walking one shared list can only ever be
  // reached after the episodes above it have already spent the budget.
  take(true, durableSlots, durableChars);
  // Then everything else, against what is left — including whatever the
  // profile did not use, so an account with no profile is not charged for one.
  take(false, contextLimit, contextMaxChars - total);

  // Emitted in rank order, not in selection order: the prompt numbers these
  // `index="1..n"`, and a reader should see them ranked as they were scored.
  return [...picked.keys()].sort((left, right) => left - right).map((index) => {
    const entry = /** @type {{ memo: any, content: string }} */ (picked.get(index));
    return { ...entry.memo, content: entry.content };
  });
}

/** What a recalled memory contributes to the prompt.
 *
 * A run summary stores the whole run as JSON — run and session ids, model,
 * error code, timings, and the full previous answer. That is the right record
 * to keep, and the wrong thing to paste into a prompt: the model reads internal
 * identifiers as content. Project it back to the exchange it describes. */
export function recallContent(record) {
  if (record.kind !== "run_summary") {
    return [record.summary, record.value].filter(Boolean).join("\n");
  }
  let parsed = null;
  try {
    parsed = JSON.parse(record.value);
  } catch {
    return record.summary ?? "";
  }
  const question = typeof parsed?.question === "string" ? parsed.question.trim() : "";
  const answer = typeof parsed?.answer === "string" ? parsed.answer.trim() : "";
  if (!question && !answer) return record.summary ?? "";
  return [question && `Earlier question: ${question}`, answer && `Earlier answer: ${answer}`]
    .filter(Boolean)
    .join("\n");
}

/**
 * A predicate over recall candidates: true for one the researcher set aside in
 * this conversation with 「本次不用」. Applied before the budget, so a set-aside
 * memory frees its slot for the next one instead of leaving a hole.
 *
 * Ids are matched in the form recall hands them out: a structured record as
 * `record:<id>` (set aside as `memory`), a note by its own id (`note`).
 * @param {readonly { type: string, id: string }[]} excluded
 * @returns {(memo: { id?: string }) => boolean}
 */
export function setAsideIn(excluded) {
  const keys = new Set((excluded ?? []).map((item) => `${item.type}\u0000${item.id}`));
  if (keys.size === 0) return () => false;
  return (memo) => {
    const id = String(memo?.id ?? "");
    return id.startsWith("record:") ? keys.has(`memory\u0000${id.slice("record:".length)}`) : keys.has(`note\u0000${id}`);
  };
}

/** Query terms, including CJK bigrams: a two-character Chinese term is a
 *  word, and splitting on whitespace alone would find none of them. */
export function searchTokens(value) {
  const normalized = String(value ?? "").toLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9][a-z0-9._-]{1,}|[\u3400-\u9fff]{2,}/g) ?? []);
  for (const run of normalized.match(/[\u3400-\u9fff]{3,}/g) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return [...tokens].filter((token) => token.length >= 2).slice(0, 64);
}
