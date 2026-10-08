/**
 * 信源's three numbers and the answers behind them — one reading, three readers.
 *
 * A source row says how many answers of the latest round cited the site, how many of those misstated us and how many named us. The
 * counter that used to be kept on the row (`sources.cited`, `mentions_ours`, `wrong_ours`) was written once, at the end of a round, by
 * one tally; the source's detail would have been a second tally over the same answers, and the two could disagree for as long as a
 * round was finished and not yet counted. So there is one function that reads a round's answers (`roundAnswers`) and one that counts
 * them per cited domain (`tallySources`): the end-of-round refresh writes its result, the sources page shows its result, and the
 * detail lists the very answers it counted — a number on the row and the list it opens cannot differ.
 *
 * Hidden knowledge:
 *
 * - An answer cites a site once however many of its links point there, and `www.` is the same site as the bare domain; any other
 *   subdomain is a site of its own (the rule the counter always had).
 * - "Misstates us" is the answer-level failure mode the parser set (`wrong_ours`), not a count of sentences: one answer with three
 *   wrong sentences is one misstated answer.
 * - This is co-occurrence, not attribution: the answer cited the site and the answer misstated us. Which cited site a wrong sentence
 *   came from is a separate, narrower fact (`sentenceSource`): the inline marker beside the sentence, the same reading
 *   `geoErrors.traceError` records for the diagnosis.
 *
 * @module geoSourceAnswers
 */

import { citedFor } from "./geoErrors.mjs";

const list = (/** @type {unknown} */ value) => (Array.isArray(value) ? value : []);

/** The site a cited link belongs to: lower case, `www.` folded. @param {any} citation */
export function citedDomain(citation) {
  return String(citation?.domain ?? "").toLowerCase().replace(/^www\./u, "");
}

/** The distinct sites one answer cites. @param {unknown} citations @returns {Set<string>} */
export function citedDomains(citations) {
  return new Set(list(citations).map(citedDomain).filter(Boolean));
}

/**
 * @typedef {object} RoundAnswer
 * @property {string} id
 * @property {string} engine
 * @property {string} pool
 * @property {string | null} questionId
 * @property {Date | string | null} askedAt
 * @property {any[]} citations
 * @property {boolean} mentionsOurs
 * @property {boolean} wrongOurs  the answer misstates us (failure mode `wrong_ours`)
 */

/**
 * The answers of one round that count: judged ones that were answered or refused, one row each.
 * @param {{ query: (sql: string, values?: any[]) => Promise<{ rows: any[] }> }} db @param {string} roundId
 * @returns {Promise<RoundAnswer[]>}
 */
export async function roundAnswers(db, roundId) {
  const result = await db.query(`SELECT s.id, s.engine, s.question_id, s.asked_at, s.citations, coalesce(q.pool, g.pool) AS pool,
      f.mentions_ours, f.failure_mode
    FROM evimed_geo.snapshots s JOIN evimed_geo.facts f ON f.snapshot_id = s.id
      LEFT JOIN evimed_geo.questions q ON q.id = s.question_id LEFT JOIN evimed_geo.question_groups g ON g.id = q.group_id
    WHERE s.round_id = $1 AND s.status IN ('valid', 'refusal')`, [roundId]);
  return result.rows.map((row) => ({
    id: String(row.id),
    engine: String(row.engine),
    pool: String(row.pool ?? "none"),
    questionId: row.question_id == null ? null : String(row.question_id),
    askedAt: row.asked_at ?? null,
    citations: list(row.citations),
    mentionsOurs: Boolean(row.mentions_ours),
    wrongOurs: row.failure_mode === "wrong_ours",
  }));
}

/**
 * @typedef {object} SourceTally
 * @property {Record<string, Record<string, number>>} cited  answers citing the site, per engine and per question pool
 * @property {number} mentionsOurs
 * @property {number} wrongOurs
 * @property {Record<string, { cited: number, mentionsOurs: number, wrongOurs: number }>} byEngine
 */

/**
 * What each cited site stands for in these answers.
 * @param {readonly RoundAnswer[]} answers @returns {Map<string, SourceTally>}
 */
export function tallySources(answers) {
  /** @type {Map<string, SourceTally>} */
  const byDomain = new Map();
  for (const answer of answers) {
    for (const domain of citedDomains(answer.citations)) {
      const entry = byDomain.get(domain) ?? { cited: {}, mentionsOurs: 0, wrongOurs: 0, byEngine: {} };
      entry.cited[answer.engine] ??= {};
      entry.cited[answer.engine][answer.pool] = (entry.cited[answer.engine][answer.pool] ?? 0) + 1;
      const engine = entry.byEngine[answer.engine] ?? { cited: 0, mentionsOurs: 0, wrongOurs: 0 };
      engine.cited += 1;
      if (answer.mentionsOurs) { entry.mentionsOurs += 1; engine.mentionsOurs += 1; }
      if (answer.wrongOurs) { entry.wrongOurs += 1; engine.wrongOurs += 1; }
      entry.byEngine[answer.engine] = engine;
      byDomain.set(domain, entry);
    }
  }
  return byDomain;
}

/**
 * The answers that cite a site, optionally one engine's.
 * @param {readonly RoundAnswer[]} answers @param {string} domain @param {string | null} [engine]
 */
export function answersCiting(answers, domain, engine = null) {
  const wanted = String(domain).toLowerCase().replace(/^www\./u, "");
  return answers.filter((answer) => (!engine || answer.engine === engine) && citedDomains(answer.citations).has(wanted));
}

/**
 * Whether a wrong sentence came from this site: the engine put its inline marker beside the sentence and the marker points here.
 * The same reading `traceError` records for the diagnosis, applied to this answer.
 * @param {{ answerText: string | null, citations: any[] }} answer @param {string} sentence @param {string} domain
 */
export function sentenceSource(answer, sentence, domain) {
  const cited = citedFor(String(answer.answerText ?? ""), sentence, list(answer.citations));
  return cited != null && citedDomain(cited) === String(domain).toLowerCase().replace(/^www\./u, "");
}
