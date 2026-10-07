/**
 * The platform's own medication-question bank (evidence-flywheel plan §5.6, F22, 2026-10-06): about sixty common medication questions
 * by drug class, no brand, asked of the consumer AI assistants once a month, judged against the platform's published cards, and what
 * that finds fed back — the common errors to the topic selector, the per-class accuracy to the public metrics page.
 *
 * Hidden knowledge:
 *
 * - **An ordinary GEO project, held by the platform publisher.** The bank is one `evimed_geo.projects` row of the publisher account
 *   (`evimed-evidence-center`, which cannot sign in) in the publisher's internal evidence project, marked `internal`: the probe asks
 *   its questions, the judge judges the answers and the errors table records what was wrong exactly as for a customer's project —
 *   and the orchestrator never advances it (no step, no export, no schedule). Nothing of the bank is shown to any account.
 * - **The questions come from the data file and are written once per version.** `@evimed/domain`'s question bank is the source;
 *   a new version of it is a new locked set of the project, so a month is always compared with itself.
 * - **The claims the judge holds an answer to are the platform's published cards'.** A question about a drug class has no single claim
 *   to be held to, so the bank's claim table is a copy of the verified claims of the published cards of the official zones (the card's
 *   own ruler decides ✓), each carrying the card and revision it was copied from; a statement no card speaks to is `unverifiable` and
 *   is left out of every rate. Until the platform has published cards on a class, the class has no rate — never a zero.
 * - **One monthly round per engine, kept in marks.** The module's own daily loop asks, for the current month, each engine once:
 *   a mark `bank:<month>:<engine>` says asked, done or skipped. An engine the probe has paused (or that cannot be asked here) is
 *   skipped and the mark says why; the next day's tick asks it again once it answers, up to three rounds a month. A month with an
 *   engine still missing is published with that engine absent from its coverage, not padded.
 * - **Two outputs, both counted from the tables.** `observedErrors()` is what the topic selector reads: the open errors of the bank,
 *   grouped by the entity keys of the shared vocabulary (a drug, a disease), as `{ entityKeys, count }`. `questionBankSummary` is what
 *   the metrics page reads: per-class accuracy over the specified information and the share of answers citing an EviMed page, by
 *   host (`summarizeQuestionBank`).
 * - **Off unless both switches are on** (`OPEN_SCIENCE_GEO_ENABLED` and `OPEN_SCIENCE_GEO_QUESTION_BANK_ENABLED`): the tick answers
 *   `disabled` before it reads a table, and no route exists.
 *
 * @module geoQuestionBank
 */

import { createHash } from "node:crypto";
import {
  GEO_QUESTION_BANK, GEO_QUESTION_BANK_CLASSES, GEO_QUESTION_BANK_CLASS_LABELS_ZH, GEO_QUESTION_BANK_VERSION, PLATFORM_PUBLISHER_USER_ID,
  geoQuestionBankClassOf, geoQuestionBankMonth, summarizeQuestionBank, verifyEvidenceCardClaims,
} from "@evimed/domain";
import { EVIDENCE_PROJECT_ID } from "./internalProjects.mjs";
import { enqueueRound, measurableEngines } from "./geoProbeQueue.mjs";

/** The rounds one engine may be asked in one month: the first and two makeups. */
export const GEO_QUESTION_BANK_MAX_ROUNDS_PER_ENGINE = 3;
/** The official cards' claims the bank's judge is shown at most (the judge's own context bound is 400). */
const CLAIMS_MAX = 300;
/** Errors read for the topic selector at most. */
const ERRORS_MAX = 300;
/** The round kind the bank's rounds carry: they are no customer's weekly or baseline measurement. */
const ROUND_KIND = "single_step";

/** @param {string} value */
const sha = (value) => createHash("sha256").update(value).digest("hex");

/**
 * The bank's answers of one month, one row each, in the shape `summarizeQuestionBank` reads.
 * @param {{ query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> }} database
 * @param {{ month?: string | null, publicUrl?: string | null, timeZone?: string, now?: () => Date }} [options]
 */
export async function questionBankSummary(database, { month = null, publicUrl = "", timeZone = "Asia/Shanghai", now = () => new Date() } = {}) {
  const wanted = month ?? geoQuestionBankMonth(now(), timeZone);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(wanted)) throw Object.assign(new Error("A month is YYYY-MM."), { code: "geo_question_bank_month_invalid" });
  const project = (await database.query(`SELECT id FROM evimed_geo.projects WHERE user_id = $1 AND project_id = $2 AND internal AND deleted_at IS NULL`,
    [PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID]).catch(() => ({ rows: [] }))).rows[0];
  if (!project) return { month: wanted, available: false, ...summarizeQuestionBank({ answers: [], publicHost: null }) };
  const rows = (await database.query(`SELECT s.engine, s.status, s.citations, q.text AS question, f.snapshot_id IS NOT NULL AND f.judged_at IS NOT NULL AS judged, f.statements,
      r.id AS round_id
    FROM evimed_geo.rounds r JOIN evimed_geo.snapshots s ON s.round_id = r.id AND s.status IN ('valid', 'refusal')
      LEFT JOIN evimed_geo.questions q ON q.id = s.question_id LEFT JOIN evimed_geo.facts f ON f.snapshot_id = s.id
    WHERE r.geo_project_id = $1 AND r.ref ->> 'questionBank' = $2 ORDER BY s.asked_at, s.id LIMIT 20000`, [project.id, wanted])).rows;
  let publicHost = null;
  try { publicHost = publicUrl ? new URL(publicUrl).hostname : null; } catch { publicHost = null; }
  const summary = summarizeQuestionBank({
    publicHost,
    answers: rows.map((/** @type {any} */ row) => ({
      class: geoQuestionBankClassOf(row.question), engine: row.engine ?? null, status: row.status, judged: row.judged === true,
      statements: Array.isArray(row.statements) ? row.statements : [], citations: Array.isArray(row.citations) ? row.citations : [],
    })),
  });
  const marks = (await database.query(`SELECT key, state, detail FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND starts_with(key, $2) ORDER BY key`,
    [project.id, `bank:${wanted}:`]).catch(() => ({ rows: [] }))).rows;
  return {
    month: wanted, available: true,
    // Which assistants were asked this month and which were not, so a rate is never read as covering one that was skipped.
    coverage: Object.fromEntries(marks.filter((/** @type {any} */ mark) => !mark.key.includes(":summary")).map((/** @type {any} */ mark) => [String(mark.key).split(":")[2], { state: String(mark.state), rounds: Number(mark.detail?.rounds ?? 0), ...(mark.detail?.reason ? { reason: String(mark.detail.reason) } : {}) }])),
    ...summary,
  };
}

/**
 * @param {{ store: import("./geoStore.mjs").GeoStore, measureDeps: any, database: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> },
 *   config: Record<string, any>, entityVocabulary?: { keysForText: (input: { texts: string[] }) => Promise<string[]> } | null,
 *   now?: () => Date, report?: (code: string) => void }} options
 */
export function createGeoQuestionBank({ store, measureDeps, database, config, entityVocabulary = null, now = () => new Date(), report = () => {} }) {
  const timeZone = String(config.geoTimeZone || "Asia/Shanghai");
  const counters = { ticks: 0, rounds: 0, enginesDone: 0, enginesSkipped: 0, claimsSynced: 0, errorsRead: 0 };
  const enabled = () => config.geoEnabled === true && config.geoQuestionBankEnabled === true;

  /** The bank's project, made when first needed. */
  async function ensureProject() {
    let project = await store.projectByControlProject(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID);
    if (!project) {
      project = await store.createProject({ userId: PLATFORM_PUBLISHER_USER_ID, projectId: EVIDENCE_PROJECT_ID, engines: config.geoEngines, coverageDays: 30,
        product: { genericName: "常见用药问题" }, internal: true });
    } else if (!project.internal) {
      await store.query(`UPDATE evimed_geo.projects SET internal = true WHERE id = $1`, [project.id]);
      project = { ...project, internal: true };
    }
    return project;
  }

  /** The bank's questions as the project's locked set, written once per version of the bank. @param {{ id: string }} project */
  async function syncQuestions(project) {
    const note = `bank:v${GEO_QUESTION_BANK_VERSION}`;
    const sets = await store.questionSets(project.id);
    if (sets.some((entry) => entry.note === note && entry.lockedAt)) return { written: false };
    const groups = GEO_QUESTION_BANK_CLASSES.map((key) => ({
      pool: "P3", name: /** @type {Record<string, string>} */ (GEO_QUESTION_BANK_CLASS_LABELS_ZH)[key], typicalQuestion: GEO_QUESTION_BANK.find((question) => question.class === key)?.text ?? null,
      audience: "patient", weight: 1, isControl: false, signal: "client",
      questions: GEO_QUESTION_BANK.filter((question) => question.class === key).map((question) => ({ text: question.text, kind: "typical", pool: "P3", isMeasured: true })),
    }));
    const written = await store.writeQuestionSet(PLATFORM_PUBLISHER_USER_ID, project.id, { groups, note });
    await store.lockQuestionSet(project.id, written.version, GEO_QUESTION_BANK.length);
    return { written: true, version: written.version };
  }

  /**
   * The verified claims of the published cards of the official zones, as the bank's claim table: what an answer is held to. A card that
   * is taken back or no longer published drops its claims.
   * @param {{ id: string }} project
   */
  async function syncClaims(project) {
    /** @type {any[]} */
    let cards = [];
    try {
      cards = (await database.query(`SELECT c.id, c.revision, c.title, c.claims, c.sources FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id = c.zone_id
        WHERE z.kind = 'official' AND z.state = 'published' AND c.state = 'published' AND c.withdrawn IS NULL ORDER BY c.updated_at DESC, c.id LIMIT 100`)).rows;
    } catch { cards = []; }
    /** @type {any[]} */
    const items = [];
    /** @type {Array<{ key: string, cardId: string, cardClaimId: string, cardRevision: number }>} */
    const origin = [];
    for (const card of cards) {
      const verdict = verifyEvidenceCardClaims({ claims: card.claims ?? [], sources: card.sources ?? [] });
      const verified = new Set(verdict.claims.filter((entry) => entry.status === "verified").map((entry) => entry.claimId));
      for (const claim of card.claims ?? []) {
        if (!verified.has(claim.claimId) || items.length >= CLAIMS_MAX) continue;
        const quote = claim.supportQuote ?? claim.supportingSources?.find((/** @type {any} */ bond) => bond.supportQuote)?.supportQuote;
        if (!quote) continue;
        const source = card.sources?.[(claim.sourceIndexes?.[0] ?? 1) - 1];
        const key = `official:${sha(`${card.id}\0${claim.claimId}`).slice(0, 40)}`;
        items.push({ claimKey: key, statement: String(claim.claim).slice(0, 1000), quote: String(quote).slice(0, 4000), sourceRef: String(source?.url ?? card.title).slice(0, 500),
          sourceLabel: String(source?.title ?? card.title).slice(0, 300), sourceKind: "other", status: "active" });
        origin.push({ key, cardId: String(card.id), cardClaimId: String(claim.claimId), cardRevision: Number(card.revision) });
      }
    }
    if (items.length) {
      const written = await store.upsertClaims(PLATFORM_PUBLISHER_USER_ID, project.id, items);
      const byKey = new Map(written.map((entry) => [entry.claimKey, entry.id]));
      await store.markClaimsCarded(project.id, origin.filter((entry) => byKey.has(entry.key)).map((entry) => ({ id: /** @type {string} */ (byKey.get(entry.key)),
        cardId: entry.cardId, cardClaimId: entry.cardClaimId, cardRevision: entry.cardRevision })));
    }
    await store.query(`UPDATE evimed_geo.claims SET status = 'retired' WHERE geo_project_id = $1 AND claim_key LIKE 'official:%' AND status = 'active' AND NOT (claim_key = ANY($2::text[]))`,
      [project.id, items.map((item) => item.claimKey)]);
    counters.claimsSynced += items.length;
    return { claims: items.length };
  }

  /** @param {string} geoId @param {string} key */
  const markOf = async (geoId, key) => (await store.query(`SELECT * FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND key = $2`, [geoId, key])).rows[0] ?? null;

  /**
   * Whether the probe can ask an engine now: the deployment has a channel for it and the probe's breaker has not paused it.
   * @param {string} engine
   */
  function askable(engine) {
    if (!measurableEngines(measureDeps).includes(engine)) return false;
    return measureDeps.state?.breaker?.engines?.get(engine)?.pausedAt == null;
  }

  /**
   * One day's work: the project, the questions and the claims in place, then each engine asked once this month — or again, once it
   * answers, if the round before it found it down.
   */
  async function tick() {
    if (!enabled()) return { skipped: "disabled" };
    counters.ticks += 1;
    const project = await ensureProject();
    await syncQuestions(project);
    await syncClaims(project);
    const month = geoQuestionBankMonth(now(), timeZone);
    const counts = { month, asked: 0, done: 0, skipped: 0, waiting: 0 };
    for (const engine of config.geoEngines) {
      const key = `bank:${month}:${engine}`;
      const mark = await markOf(project.id, key);
      if (mark?.state === "done") { counts.done += 1; continue; }
      const rounds = Number(mark?.detail?.rounds ?? 0);
      if (mark?.state === "running" && mark.round_id) {
        const round = (await store.query(`SELECT status, finished_at FROM evimed_geo.rounds WHERE id = $1`, [mark.round_id])).rows[0];
        if (round && ["queued", "running"].includes(String(round.status))) { counts.waiting += 1; continue; }
        // The round ended: the engine answered if any answer of it is valid; a round that found it down left skipped jobs and no answer.
        const answered = Number((await store.query(`SELECT count(*)::integer AS n FROM evimed_geo.snapshots WHERE round_id = $1 AND engine = $2 AND status IN ('valid', 'refusal')`,
          [mark.round_id, engine])).rows[0]?.n ?? 0);
        if (answered > 0) {
          await store.query(`UPDATE evimed_geo.schedule_marks SET state = 'done', done_at = now(), updated_at = now(), detail = detail || $3::jsonb WHERE geo_project_id = $1 AND key = $2`,
            [project.id, key, JSON.stringify({ answered })]);
          counters.enginesDone += 1;
          counts.done += 1;
          continue;
        }
      }
      if (rounds >= GEO_QUESTION_BANK_MAX_ROUNDS_PER_ENGINE) { counts.skipped += 1; continue; }
      if (!askable(engine)) {
        // Down, or no channel for it here: skipped, and asked again on the day it answers.
        await store.query(`INSERT INTO evimed_geo.schedule_marks (geo_project_id, key, user_id, kind, state, detail) VALUES ($1, $2, $3, 'round', 'skipped', $4::jsonb)
          ON CONFLICT (geo_project_id, key) DO UPDATE SET state = CASE WHEN schedule_marks.state = 'done' THEN 'done' ELSE 'skipped' END, updated_at = now(),
            detail = schedule_marks.detail || EXCLUDED.detail`, [project.id, key, PLATFORM_PUBLISHER_USER_ID, JSON.stringify({ month, engine, rounds, reason: "engine_down" })]);
        counters.enginesSkipped += 1;
        counts.skipped += 1;
        continue;
      }
      const round = await enqueueRound(measureDeps, { geoProjectId: project.id, kind: ROUND_KIND, engines: [engine], ref: { questionBank: month, engine } });
      await store.query(`INSERT INTO evimed_geo.schedule_marks (geo_project_id, key, user_id, kind, state, round_id, detail) VALUES ($1, $2, $3, 'round', 'running', $4, $5::jsonb)
        ON CONFLICT (geo_project_id, key) DO UPDATE SET state = 'running', round_id = EXCLUDED.round_id, updated_at = now(), detail = EXCLUDED.detail`,
      [project.id, key, PLATFORM_PUBLISHER_USER_ID, round.roundId, JSON.stringify({ month, engine, rounds: rounds + 1, planned: round.planned })]);
      counters.rounds += 1;
      counts.asked += 1;
    }
    return counts;
  }

  /**
   * What the topic selector reads (`useSignals({ observedErrors })`): the bank's open errors — an assistant said something a published
   * card contradicts — grouped by the entity keys of the shared vocabulary, as `{ entityKeys, count }`. An error the vocabulary
   * recognises nothing in is counted without keys.
   * @returns {Promise<Array<{ entityKeys?: string[], count: number }>>}
   */
  async function observedErrors() {
    if (!enabled()) return [];
    const project = await store.projectByControlProject(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID);
    if (!project?.internal) return [];
    const rows = (await store.query(`SELECT e.statement, q.text AS question, c.statement AS claim FROM evimed_geo.errors e
        LEFT JOIN evimed_geo.questions q ON q.id = e.question_id LEFT JOIN evimed_geo.claims c ON c.id = e.claim_id
      WHERE e.geo_project_id = $1 AND e.status <> 'closed' ORDER BY e.updated_at DESC LIMIT $2`, [project.id, ERRORS_MAX])).rows;
    counters.errorsRead += rows.length;
    /** @type {Map<string, { entityKeys: string[], count: number }>} */
    const groups = new Map();
    for (const row of rows) {
      const texts = [row.question, row.statement, row.claim].filter((text) => typeof text === "string" && text.trim()).map(String);
      const keys = entityVocabulary ? [...new Set(await entityVocabulary.keysForText({ texts }).catch(() => []))].sort() : [];
      const id = keys.join("\0");
      const group = groups.get(id) ?? { entityKeys: keys, count: 0 };
      group.count += 1;
      groups.set(id, group);
    }
    return [...groups.values()].map((group) => (group.entityKeys.length ? { entityKeys: group.entityKeys, count: group.count } : { count: group.count }));
  }

  return {
    tick, observedErrors, ensureProject, syncQuestions, syncClaims,
    summary: (/** @type {{ month?: string | null }} */ options = {}) => questionBankSummary(database, { ...options, publicUrl: config.publicUrl, timeZone, now }),
    metrics: () => ({ ...counters }),
    report,
  };
}
