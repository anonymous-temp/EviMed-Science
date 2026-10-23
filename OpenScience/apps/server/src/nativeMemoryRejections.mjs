import { callModelForControlPlane } from "./modelGateway.mjs";
import { recordRejectionJudge, recordRejectionLines } from "./nativeMemoryMetrics.mjs";

/**
 * Recognising a line the person removed when the engine writes it again in other words (2026-10-23, rectification T1.9 / D8).
 *
 * Until then the rejection list met only a verbatim repeat: the line's fingerprint. The engine's extraction words things its own way,
 * so "I prefer tables" removed on Monday was back on Tuesday as "Prefers tables for comparisons" — the owner's rule that a deletion is
 * obeyed held only as far as the engine's habit of copying. Two steps, cheapest first, each on the lines a commit *brought* and
 * nothing else:
 *
 *  1. **Containment, in code.** A written line that contains the removed line's words (after the same normalisation the fingerprint
 *     uses, and without spacing or punctuation) is that line with something added. Decidable, so it is code. A removed line shorter than
 *     `MIN_CONTAINED` characters (compact) is too common a phrase to forbid every line that holds it, and is met only by exact repeat.
 *  2. **Similarity, by the model.** A line that shares enough of a removed line's character pairs (`SIMILAR`) is put to one Flash call:
 *     does it say the same thing as one the person removed? Whether two wordings mean the same is language (principle 1), so it is
 *     the model's, and the code verifies what comes back: JSON of the one shape, indexes that exist, a pair that was offered. Anything
 *     else is dropped. A model that cannot be reached, answers badly or has spent the account's day keeps the line — the person is not
 *     made to wait on, or lose a memory to, a judge that failed — and is counted (`open_science_native_memory_rejection_judge_total` for
 *     the calls, `open_science_native_memory_rejection_lines_total` for the lines).
 *
 * The same call is asked which of the candidates the person said themselves in the conversation the commit came from: their words win
 * over their earlier deletion, as they do word for word (`nativeMemoryWorker.#statedByThePerson`), and a restatement in other words
 * than the engine's is no different.
 *
 * Budgeted: one call per commit, at most `maxCandidates` lines in it, and `dailyCalls` of them per account per UTC day (a counter here:
 * a restart gives the account its day again, which is the bound's own tolerance). Charged to the account as memory extraction.
 *
 * Deletable when the engine's extraction takes a "never keep" list of its own (it has none in v0.5.1.1) — then the list and this go.
 *
 * @module nativeMemoryRejections
 */

/** The fewest compact characters a removed line must have to forbid every line that contains it. */
export const MIN_CONTAINED = 8;
/** The share of character pairs two statements hold in common (Dice) from which a model is asked. Low on purpose: the model decides. */
export const SIMILAR = 0.3;
/** The most lines one call carries, and the most removed lines offered for one of them. */
const MAX_CANDIDATES = 8;
const MAX_REMOVED_PER_CANDIDATE = 3;
const MAX_SAID = 6;

/** A statement with no spacing, punctuation or symbols: what two renderings of one wording share. @param {unknown} text */
export function compact(text) {
  return String(text ?? "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** @param {string} text */
function pairs(text) {
  const characters = [...text];
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (let index = 0; index + 1 < characters.length; index += 1) {
    const pair = `${characters[index]}${characters[index + 1]}`;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/**
 * The share of character pairs two statements hold in common, 0 to 1 (Sørensen–Dice over the multiset of adjacent pairs), on their
 * compact forms. A cheap prefilter, not a verdict.
 * @param {string} left @param {string} right
 */
export function similarity(left, right) {
  const a = compact(left);
  const b = compact(right);
  if ([...a].length < 4 || [...b].length < 4) return 0;
  const first = pairs(a);
  const second = pairs(b);
  let shared = 0;
  for (const [pair, count] of first) shared += Math.min(count, second.get(pair) ?? 0);
  const total = [...a].length - 1 + [...b].length - 1;
  return total ? (2 * shared) / total : 0;
}

/**
 * Whether a written line contains a removed line's words: that line with something around it.
 * @param {string} written @param {string} removed the removed line's normalised text
 */
export function containsRemoved(written, removed) {
  const needle = compact(removed);
  return [...needle].length >= MIN_CONTAINED && compact(written).includes(needle);
}

/**
 * Which removed lines a written line is near enough to be put to the model for, best first.
 * @param {string} written @param {readonly { fingerprint: string, text: string | null }[]} removed
 */
export function nearRemoved(written, removed) {
  return removed
    .filter((line) => line.text)
    .map((line) => ({ line, score: similarity(written, /** @type {string} */ (line.text)) }))
    .filter((entry) => entry.score >= SIMILAR)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_REMOVED_PER_CANDIDATE)
    .map((entry) => entry.line);
}

const INSTRUCTIONS = [
  "A research platform keeps short notes about one person. The person asked it to forget some of them (`removed`).",
  "`candidates` are lines the platform has just written. For each candidate that says the same thing as one of its own `options` — the same fact, preference or instruction in other words, or the removed one with something added that does not change it — say which.",
  "A candidate that is only about the same subject, or says something more specific that the removed line did not, is not the same.",
  "`said` is what the person themselves wrote in the conversation the lines came from. A candidate the person said in those words themselves (not the platform's wording of something else) is `stated`: the person chose it again, whatever they removed before.",
  "Return JSON only: {\"same\":[{\"candidate\":<index>,\"removed\":<index>}],\"stated\":[<candidate index>]}. List only the pairs that are the same; use only the indexes given.",
].join(" ");

/**
 * The one request of a judgement. @param {string} model @param {{ candidates: { text: string, options: number[] }[], removed: string[], said: string[] }} input
 */
export function judgeRequestBody(model, { candidates, removed, said }) {
  return {
    model, thinking: { type: "disabled" }, temperature: 0, max_tokens: 600, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: JSON.stringify({
        candidates: candidates.map((candidate, index) => ({ candidate: index, text: candidate.text, options: candidate.options })),
        removed: removed.map((text, index) => ({ removed: index, text })),
        said,
      }) },
    ],
  };
}

/**
 * What the model said, as far as it stands: pairs that were offered and indexes that exist. Everything else is dropped, not softened.
 * @param {unknown} content @param {{ options: number[] }[]} candidates @param {number} removedCount
 * @returns {{ same: Map<number, number>, stated: Set<number> } | null} null when it was not the one shape
 */
export function parseJudgement(content, candidates, removedCount) {
  let value;
  try { value = JSON.parse(String(content ?? "")); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.same)) return null;
  /** @type {Map<number, number>} */
  const same = new Map();
  for (const pair of value.same) {
    const candidate = pair?.candidate;
    const removed = pair?.removed;
    if (!Number.isInteger(candidate) || !Number.isInteger(removed)) continue;
    if (candidate < 0 || candidate >= candidates.length || removed < 0 || removed >= removedCount) continue;
    // A pair the code did not offer is not a pair: the model is judging near lines, not searching the list.
    if (!candidates[candidate].options.includes(removed) || same.has(candidate)) continue;
    same.set(candidate, removed);
  }
  const stated = new Set(Array.isArray(value.stated) ? value.stated.filter((/** @type {unknown} */ index) => Number.isInteger(index) && /** @type {number} */ (index) >= 0 && /** @type {number} */ (index) < candidates.length) : []);
  return { same, stated };
}

/**
 * The judge the worker asks: one call for a commit's near lines.
 * @param {{ config: any, usageLedger?: any, fetchImpl?: typeof fetch, now?: () => Date, callModel?: typeof callModelForControlPlane }} dependencies
 */
export function createRejectionJudge({ config, usageLedger = null, fetchImpl = globalThis.fetch, now = () => new Date(), callModel = callModelForControlPlane }) {
  const model = String(config.memoryExtractionModel || config.deepseekModel || "");
  const timeoutMs = Math.max(1_000, Math.min(120_000, Number(config.memoryExtractionTimeoutMs ?? 30_000)));
  const dailyCalls = Math.max(0, Math.trunc(Number(config.nativeMemoryRejectionJudgeDailyCalls ?? 40)));
  /** @type {Map<string, { day: string, calls: number }>} */
  const spent = new Map();
  const enabled = config.nativeMemoryRejectionJudgeEnabled !== false;

  return {
    /** Whether a judgement can be asked at all here: the lever, a model, and a provider. */
    get available() { return enabled && Boolean(model) && Boolean(config.deepseekProviderEnabled !== false && config.deepseekApiKey); },

    /**
     * @param {{ userId: string, projectId?: string | null, runId?: string | null, candidates: { text: string, removed: { fingerprint: string, text: string }[] }[], said?: readonly string[] }} request
     * @returns {Promise<{ same: Map<number, string>, stated: Set<number> }>} for each candidate index judged the same, the fingerprint of the removed line it repeats; and the candidates the person said themselves. Empty whenever the judge could not be asked or did not answer in the one shape: the lines are kept.
     */
    async same({ userId, projectId = null, runId = null, candidates, said = [] }) {
      const nothing = { same: /** @type {Map<number, string>} */ (new Map()), stated: /** @type {Set<number>} */ (new Set()) };
      const shown = candidates.slice(0, MAX_CANDIDATES);
      if (!shown.length) return nothing;
      if (!this.available) { recordRejectionJudge("unavailable"); recordRejectionLines("judge_failed", shown.length); return nothing; }
      const day = now().toISOString().slice(0, 10);
      const held = spent.get(userId);
      const calls = held && held.day === day ? held.calls : 0;
      if (calls >= dailyCalls) { recordRejectionJudge("over_budget"); recordRejectionLines("judge_failed", shown.length); return nothing; }
      // Counted before the call: a model that keeps failing is asked a bounded number of times a day, not without end.
      spent.set(userId, { day, calls: calls + 1 });
      // The removed lines the call is shown, once each, and each candidate's own shortlist as indexes into them.
      /** @type {string[]} */
      const removedTexts = [];
      /** @type {string[]} */
      const removedPrints = [];
      const offered = shown.map((candidate) => ({
        text: candidate.text.slice(0, 300),
        options: candidate.removed.map((line) => {
          let index = removedPrints.indexOf(line.fingerprint);
          if (index < 0) { removedPrints.push(line.fingerprint); removedTexts.push(line.text.slice(0, 300)); index = removedPrints.length - 1; }
          return index;
        }),
      }));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        recordRejectionJudge("asked");
        const body = await callModel({ config, usageLedger, fetchImpl }, {
          userId, projectId: projectId || "default", runId, purpose: "memory-extraction", signal: controller.signal,
          body: judgeRequestBody(model, { candidates: offered, removed: removedTexts, said: said.slice(0, MAX_SAID).map((text) => String(text).slice(0, 300)) }),
        });
        const judged = parseJudgement(body?.choices?.[0]?.message?.content, offered, removedTexts.length);
        if (!judged) { recordRejectionJudge("failed"); recordRejectionLines("judge_failed", shown.length); return nothing; }
        const result = { same: /** @type {Map<number, string>} */ (new Map()), stated: judged.stated };
        for (const [candidate, removed] of judged.same) result.same.set(candidate, removedPrints[removed]);
        recordRejectionLines("judged_same", result.same.size);
        recordRejectionLines("judged_kept", shown.length - result.same.size);
        return result;
      } catch {
        recordRejectionJudge("failed");
        recordRejectionLines("judge_failed", shown.length);
        return nothing;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export { MAX_CANDIDATES as REJECTION_JUDGE_MAX_CANDIDATES };
