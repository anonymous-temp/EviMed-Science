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
// the rest.
export const DURABLE_RECALL_BUDGET_SHARE = 0.5;

/**
 * Take ranked candidates, highest first, and return the memories that fit.
 *
 * @param {Array<{ memo: { content: string, kind?: string } }>} ranked
 * @param {{ contextLimit: number, contextMaxChars: number }} budget
 */
export function selectWithinBudget(ranked, { contextLimit, contextMaxChars }) {
  const durableSlots = Math.max(1, Math.floor(contextLimit * DURABLE_RECALL_BUDGET_SHARE));
  const durableChars = Math.floor(contextMaxChars * DURABLE_RECALL_BUDGET_SHARE);

  const selected = [];
  let total = 0;
  let durableCount = 0;
  let durableTotal = 0;
  for (const row of ranked) {
    if (selected.length >= contextLimit) break;
    const durable = DURABLE_RECALL_KINDS.has(row.memo.kind);
    // Cap the profile's share so a question-specific memory still fits.
    if (durable && (durableCount >= durableSlots || durableTotal >= durableChars)) continue;
    const remaining = Math.min(
      contextMaxChars - total,
      durable ? durableChars - durableTotal : contextMaxChars,
    );
    if (remaining <= 0) continue;
    const content = row.memo.content.slice(0, remaining);
    if (!content) continue;
    selected.push({ ...row.memo, content });
    total += content.length;
    if (durable) {
      durableCount += 1;
      durableTotal += content.length;
    }
  }
  return selected;
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
