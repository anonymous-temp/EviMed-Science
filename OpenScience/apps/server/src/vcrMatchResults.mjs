/**
 * What the matching page and its exports read of the saved judgments of patients against trials (owner decisions of 2026-11-04).
 *
 * The judging job and a conversation write one record (`vcrMatchJudgmentStore`); this is the page's reader of it. It answers three things
 * the page asks, from saved rows alone and without a model:
 *
 * - one patient's trials: a ranked list that grows as the job judges, how many pairs are done of how many were asked, which failed and
 *   why, and the chosen trial opened into its reasons and its clause table;
 * - one protocol's people: a page of the roster, filtered by verdict, and for each clause how many people it satisfies, disqualifies,
 *   finds the record silent on, or leaves open;
 * - the same rows as a file, all of them, a few at a time.
 *
 * Hidden knowledge:
 *
 * - **Counts come out of the database, not out of the answers.** A protocol's page may hold five thousand people and each answer holds
 *   a clause table with sentences; the list is built from per-row counts computed in one statement (`COUNTS`) and the verdict is the
 *   domain's `trialVerdict` over rows synthesised from those counts, so it is the same function the tool's read applies to the whole
 *   answer. A test holds the two equal on every combination. Whole answers are loaded for the one pair a reader opens, and for an
 *   export a few pairs at a time.
 * - **A stance is the page's, a label is the model's.** The model's label of a clause and whether a sentence backs it give one of five
 *   stances (`stanceOf`): a clause the note is silent on is `silent` when it was read in the patient's favour (「未见记载，按未排除」) and
 *   `open` when it was read against them or needs confirming, which is also how the verdict counts it. Only a stated conflict
 *   disqualifies.
 * - **Evidence is shown to the reader under the reader's own grant.** A sentence is an id the code resolved at judging time; here it is
 *   re-read from the record under the viewer, and one that no longer matches what the record says is not shown, said as a count.
 *   An export is of the saved sentences themselves, by an account that may export and may read patient-level data; a withdrawn person is
 *   in none of it, because their rows are gone.
 * - **A failed read is a failed read.** Nothing here turns an error into an empty list: an empty list is the page saying nothing was
 *   judged, and that sentence must be true.
 *
 * @module vcrMatchResults
 */

import {
  criterionDisplay, rankJudgments, trialVerdict, VCR_MATCH_FIT_LEVEL_LABELS_ZH, VCR_MATCH_CONFIDENCE_LABELS_ZH, VCR_MATCH_NO_ELIGIBILITY_ZH,
  VCR_MATCH_STANCE_LABELS_ZH, VCR_TRIAL_VERDICT_LABELS_ZH, vcrMatchConfidenceLevel, vcrMatchFailureReason, vcrMatchFitLevel,
} from "@evimed/domain";

import { presentJudgment } from "./vcrMatchJudge.mjs";
import { phaseLabel, registryStatusLabel } from "./vcrPatientTrials.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase } from "./vcrStoreBase.mjs";

const S = VCR_SCHEMA;

/** A page of five thousand people is one statement over their saved answers; the module's five seconds are for a lookup. */
const READ_TIMEOUT_MS = 30_000;
/** The most pairs one read lists; the store's own ceiling. */
const MOST_PAIRS = 20_000;
/** People per page of the protocol table. */
export const MATCH_PAGE = Object.freeze({ default: 25, most: 100 });
/** Pairs whose whole answers an export holds at a time. */
const EXPORT_CHUNK = 100;
const VERDICTS = Object.freeze(["eligible", "possible", "insufficient", "ineligible"]);
const OPEN_JOB_STATES = Object.freeze(["queued", "running", "awaiting_budget"]);
/** Jobs whose plans make up "how many were asked". */
const JOBS_READ = 30;
/** Failed pairs a page lists by name; the rest are counted. */
const FAILED_LISTED = 50;
const TEXT_MAX = 600;

const object = (/** @type {unknown} */ value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
const list = (/** @type {unknown} */ value) => (Array.isArray(value) ? value : []);
const text = (/** @type {unknown} */ value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const iso = (/** @type {unknown} */ value) => (value ? new Date(/** @type {any} */ (value)).toISOString() : null);
/** @param {Record<string, any>} source @param {readonly string[]} keys */
const pick = (source, keys) => Object.fromEntries(keys.filter((key) => source[key] !== undefined && source[key] !== null).map((key) => [key, source[key]]));
const clip = (/** @type {string | null} */ value, max = TEXT_MAX) => (value && value.length > max ? `${value.slice(0, max - 1)}…` : value);
/** @param {unknown} value @returns {string} The day, as the page prints one. */
const day = (value) => (value ? new Date(/** @type {any} */ (value)).toISOString().slice(0, 10) : "");

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

/**
 * Where a clause stands for a person. See the module note: only a stated conflict disqualifies, and a silence read against the
 * patient is open because the verdict leaves it open too.
 * @param {{ label?: string | null, basis?: string | null }} row
 * @returns {'support' | 'against' | 'silent' | 'open' | 'not_applicable'}
 */
export function stanceOf(row) {
  if (row.label === "not_applicable") return "not_applicable";
  if (row.label === "not_enough_information") return "open";
  const stated = row.basis === "stated";
  const favours = row.label === "included" || row.label === "not_excluded";
  if (stated) return favours ? "support" : "against";
  return favours ? "silent" : "open";
}

/**
 * The verdict of a pair from the counts of its clause rows: the domain's `trialVerdict` over rows that carry the label and basis it reads, so
 * a list of five thousand never loads their answers and still agrees with the page of one.
 * @param {{ fit: number | null, counts: { against: number, open: number, answered: number, unanswered: number } | null, missingReasons?: number }} input
 */
export function verdictOfCounts({ fit, counts, missingReasons = 0 }) {
  if (!counts || counts.answered + counts.unanswered === 0) return trialVerdict({ fit, missingReasons: Array.from({ length: missingReasons }) });
  const rows = [
    ...Array.from({ length: counts.against }, () => ({ label: "excluded", basis: "stated" })),
    ...Array.from({ length: counts.open }, () => ({ label: "not_enough_information", basis: "silent" })),
    ...Array.from({ length: Math.max(0, counts.answered - counts.against - counts.open) }, () => ({ label: "included", basis: "stated" })),
  ];
  return trialVerdict({ fit, criteria: counts.answered ? rows : null, missing: Array.from({ length: counts.unanswered }), missingReasons: Array.from({ length: missingReasons }) });
}

/** A cell of a CSV that Excel will not run: a text that begins with a character it reads as a formula is prefixed so it stays text. @param {unknown} value */
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "是" : "否";
  // Decided on the text as it came, before line ends are made one: a cell that starts with a carriage return starts with it.
  const raw = String(value);
  const cell = (/^[=+\-@\t\r\n]/u.test(raw) ? `'${raw}` : raw).replace(/\r\n?/gu, "\n");
  return /[",\n]/u.test(cell) ? `"${cell.replace(/"/gu, '""')}"` : cell;
}
/** @param {readonly unknown[]} cells */
export const csvLine = (cells) => `${cells.map(csvCell).join(",")}\r\n`;

/** The clause rows of a pair in the shape the page and the files read. @param {any} presented a `presentJudgment` answer */
function clauseRows(presented) {
  const answered = list(presented.criteria).map((/** @type {any} */ row) => {
    const evidence = list(row.evidence).map((/** @type {any} */ item) => ({
      sentenceId: Number(item.sentenceId), text: String(item.text ?? ""), documentId: item.documentId ?? null,
      start: Number.isFinite(item.start) ? Number(item.start) : null, end: Number.isFinite(item.end) ? Number(item.end) : null,
      ...(item.source?.field ? { field: String(item.source.field) } : {}),
    }));
    return {
      number: Number(row.number), kind: row.kind === "exclusion" ? "exclusion" : "inclusion", clause: String(row.clause ?? ""), ...(row.lead ? { lead: String(row.lead) } : {}),
      label: String(row.label), basis: row.basis === "stated" ? "stated" : "silent", display: row.display ?? criterionDisplay(row), stance: stanceOf(row),
      reason: clip(text(row.reason)) ?? "", evidence, ...(row.evidenceWithheld ? { evidenceHidden: Number(row.evidenceWithheld) } : {}),
    };
  });
  const unanswered = list(presented.missingClauses).map((/** @type {any} */ clause) => ({
    number: Number(clause.number), kind: clause.kind === "exclusion" ? "exclusion" : "inclusion", clause: String(clause.text ?? ""),
    label: "not_enough_information", basis: "silent", display: "模型没有判断这一条", stance: /** @type {const} */ ("open"), reason: "", evidence: [], unanswered: true,
  }));
  return [...answered, ...unanswered].sort((a, b) => a.number - b.number);
}

/**
 * The three groups a pair opens with. The model's own reasons when it gave any; otherwise what the clauses say, each clause's reason or,
 * failing that, its words. A group with nothing in it is not there.
 * @param {any} presented @param {ReturnType<typeof clauseRows>} clauses
 */
function reasonGroups(presented, clauses) {
  const given = object(presented.reasons);
  const own = { support: list(given.eligible), against: list(given.ineligible), open: list(given.missing) };
  const clean = (/** @type {unknown[]} */ items) => items.map((item) => clip(text(item), 400)).filter(Boolean).slice(0, 12);
  /** @type {Record<'support' | 'against' | 'open', string[]>} */
  let groups = { support: /** @type {string[]} */ (clean(own.support)), against: /** @type {string[]} */ (clean(own.against)), open: /** @type {string[]} */ (clean(own.open)) };
  if (!groups.support.length && !groups.against.length && !groups.open.length) {
    const of = (/** @type {string[]} */ stances) => /** @type {string[]} */ (clean(clauses.filter((clause) => stances.includes(clause.stance)).map((clause) => clause.reason || clause.clause)));
    groups = { support: of(["support"]), against: of(["against"]), open: of(["open", "silent"]) };
  }
  return Object.fromEntries(Object.entries(groups).filter(([, items]) => items.length));
}

/** @param {any} row a light row of the newest query */
function countsOf(row) {
  if (row.answered === null || row.answered === undefined) return null;
  const answered = Number(row.answered), unanswered = Number(row.unanswered ?? 0);
  const against = Number(row.against), openInRows = Number(row.nei) + Number(row.silent_against);
  return {
    answered, unanswered, support: Number(row.support), against, silent: Number(row.silent), notApplicable: Number(row.not_applicable),
    open: openInRows + unanswered,
  };
}

/**
 * The one line that says why a pair stands where it does: the stated conflict for a "no", the first open item for the ones still to settle,
 * the first supporting reason for a "yes". Counts when the model gave no words.
 * @param {string} verdict @param {any} row @param {NonNullable<ReturnType<typeof countsOf>> | null} counts
 */
function whyOf(verdict, row, counts) {
  const first = {
    against: text(row.against_reason) ?? text(row.first_ineligible), support: text(row.support_reason) ?? text(row.first_eligible),
    open: text(row.first_missing) ?? text(row.open_reason),
  };
  const rationale = text(row.rationale);
  const picked = verdict === "ineligible" ? first.against ?? rationale
    : verdict === "eligible" ? first.support ?? rationale
      : first.open ?? first.support ?? rationale;
  if (picked) return clip(picked, 200) ?? "";
  return counts ? `满足 ${counts.support} 条，待查 ${counts.open} 条` : "";
}

/** The columns of a newest-rows query that the page needs, named once. */
const COLUMNS = `j.id, j.subject_key, j.target_kind, j.target_id, j.mode, j.status, j.error_code, j.fit, j.confidence, j.producer, j.model, j.thinking, j.basis_changed, j.job_id,
  j.created_at, j.updated_at, j.answer -> 'target' AS target, j.answer ->> 'eligibilitySource' AS eligibility_source,
  j.answer #>> '{reasons,eligible,0}' AS first_eligible, j.answer #>> '{reasons,ineligible,0}' AS first_ineligible, j.answer #>> '{reasons,missing,0}' AS first_missing, j.answer #>> '{reasons,rationale}' AS rationale,
  CASE WHEN jsonb_typeof(j.answer #> '{reasons,missing}') = 'array' THEN jsonb_array_length(j.answer #> '{reasons,missing}') ELSE 0 END AS missing_reasons`;

/**
 * The per-clause counts of a row, computed where the rows are. Labels and bases are the ones `parseCriteriaAnswer` writes; the definitions
 * of the five stances are `stanceOf`'s, written once more here in SQL, and a test holds the two equal.
 */
const COUNTS = `LEFT JOIN LATERAL (
    SELECT
      count(*)::int AS answered,
      count(*) FILTER (WHERE c ->> 'basis' = 'stated' AND c ->> 'label' IN ('included', 'not_excluded'))::int AS support,
      count(*) FILTER (WHERE c ->> 'basis' = 'stated' AND c ->> 'label' IN ('excluded', 'not_included'))::int AS against,
      count(*) FILTER (WHERE c ->> 'label' = 'not_applicable')::int AS not_applicable,
      count(*) FILTER (WHERE c ->> 'basis' IS DISTINCT FROM 'stated' AND c ->> 'label' IN ('included', 'not_excluded'))::int AS silent,
      count(*) FILTER (WHERE c ->> 'label' = 'not_enough_information')::int AS nei,
      count(*) FILTER (WHERE c ->> 'basis' IS DISTINCT FROM 'stated' AND c ->> 'label' IN ('excluded', 'not_included'))::int AS silent_against,
      (array_agg(c ->> 'reason' ORDER BY (c ->> 'number')::int) FILTER (WHERE c ->> 'basis' = 'stated' AND c ->> 'label' IN ('excluded', 'not_included') AND length(c ->> 'reason') > 0))[1] AS against_reason,
      (array_agg(c ->> 'reason' ORDER BY (c ->> 'number')::int) FILTER (WHERE c ->> 'basis' = 'stated' AND c ->> 'label' IN ('included', 'not_excluded') AND length(c ->> 'reason') > 0))[1] AS support_reason,
      (array_agg(c ->> 'reason' ORDER BY (c ->> 'number')::int) FILTER (WHERE (c ->> 'label' = 'not_enough_information' OR (c ->> 'basis' IS DISTINCT FROM 'stated' AND c ->> 'label' IN ('excluded', 'not_included'))) AND length(c ->> 'reason') > 0))[1] AS open_reason
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.answer -> 'rows') = 'array' THEN j.answer -> 'rows' ELSE '[]'::jsonb END) c
  ) k ON j.mode = 'criteria' AND j.status = 'done'
  LEFT JOIN LATERAL (
    SELECT CASE WHEN jsonb_typeof(j.answer -> 'missing') = 'array' THEN jsonb_array_length(j.answer -> 'missing') ELSE 0 END AS unanswered
  ) u ON j.mode = 'criteria' AND j.status = 'done'`;

const NOT_WITHDRAWN = `NOT EXISTS (SELECT 1 FROM ${S}.subject_withdrawals w WHERE w.study_id = j.study_id AND w.subject_key = j.subject_key)`;

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/**
 * The matching page's reader. It extends the module's store base for the connection discipline only; it writes nothing.
 *
 * @extends VcrStoreBase
 */
export class VcrMatchResults extends VcrStoreBase {
  /**
   * @param {{ database: any, judgments: any, documents?: any, matchStore?: any, statementTimeoutMs?: number }} deps
   * `judgments` is the judgment store (whole rows by id), `documents` the seam that re-reads a sentence under the viewer's grant.
   */
  constructor({ database, judgments, documents = null, matchStore = null, statementTimeoutMs = READ_TIMEOUT_MS }) {
    super({ database, statementTimeoutMs });
    this.judgments = judgments;
    this.documents = documents;
    this.matchStore = matchStore;
  }

  /**
   * The newest row of every pair and mode in a scope, light, with its clause counts. A pair's row is its newest finished one or, failing that,
   * its newest failure — the choice the tool's read makes — and nobody who withdrew is in it.
   * @param {string} studyId @param {{ subjectKey?: string | null, targetKind?: string | null, targetId?: string | null }} scope
   */
  async #newest(studyId, { subjectKey = null, targetKind = null, targetId = null }) {
    return this.rows(`WITH newest AS (
        SELECT DISTINCT ON (j.subject_key, j.target_kind, j.target_id, j.mode) j.id
        FROM ${S}.match_judgments j
        WHERE j.study_id = $1 AND ($2::text IS NULL OR j.subject_key = $2) AND ($3::text IS NULL OR j.target_kind = $3) AND ($4::text IS NULL OR j.target_id = $4) AND ${NOT_WITHDRAWN}
        ORDER BY j.subject_key, j.target_kind, j.target_id, j.mode, (j.status = 'done') DESC, j.updated_at DESC, j.id
        LIMIT ${MOST_PAIRS * 2})
      SELECT ${COLUMNS}, k.answered, k.support, k.against, k.not_applicable, k.silent, k.nei, k.silent_against, k.against_reason, k.support_reason, k.open_reason, u.unanswered
      FROM newest nw JOIN ${S}.match_judgments j ON j.id = nw.id ${COUNTS}`, [studyId, subjectKey, targetKind, targetId]);
  }

  /**
   * The rows of a scope as pairs: the finished ones with their verdict, and the ones that failed with the reason.
   * @param {string} studyId @param {{ subjectKey?: string | null, targetKind?: string | null, targetId?: string | null }} scope
   */
  async #pairs(studyId, scope) {
    const rows = await this.#newest(studyId, scope);
    /** @type {Map<string, { fit: any, criteria: any }>} */
    const grouped = new Map();
    for (const row of rows) {
      const key = `${row.subject_key}\u0000${row.target_kind}\u0000${row.target_id}`;
      const entry = grouped.get(key) ?? { fit: null, criteria: null };
      entry[/** @type {'fit' | 'criteria'} */ (row.mode)] = row;
      grouped.set(key, entry);
    }
    /** @type {any[]} */ const done = [];
    /** @type {any[]} */ const failed = [];
    for (const { fit, criteria } of grouped.values()) {
      const scored = fit?.status === "done" ? fit : null, clauses = criteria?.status === "done" ? criteria : null;
      if (!scored && !clauses) {
        const row = fit ?? criteria;
        failed.push({ subjectKey: String(row.subject_key), targetKind: String(row.target_kind), targetId: String(row.target_id), target: object(row.target), code: row.error_code ?? null, at: iso(row.updated_at) });
        continue;
      }
      const anchor = clauses && scored ? (clauses.updated_at >= scored.updated_at ? clauses : scored) : clauses ?? scored;
      const counts = clauses ? countsOf(clauses) : null;
      const score = scored?.fit ?? clauses?.fit ?? null;
      const verdict = verdictOfCounts({ fit: score, counts, missingReasons: Number(scored?.missing_reasons ?? 0) });
      const identity = scored ?? clauses;
      done.push({
        subjectKey: String(identity.subject_key), targetKind: String(identity.target_kind), targetId: String(identity.target_id), target: object(scored?.target ?? clauses?.target),
        fitRowId: scored?.id ?? null, criteriaRowId: clauses?.id ?? null, fit: score === null ? null : Number(score),
        confidence: (scored?.confidence ?? clauses?.confidence) === null || (scored?.confidence ?? clauses?.confidence) === undefined ? null : Number(scored?.confidence ?? clauses?.confidence),
        verdict: verdict.verdict, counts, producer: String(anchor.producer), judgedAt: iso(anchor.updated_at), basisChanged: scored?.basis_changed ?? clauses?.basis_changed ?? null,
        eligibilitySource: anchor.eligibility_source ?? scored?.eligibility_source ?? null, judgedByClauses: Boolean(clauses),
        why: whyOf(verdict.verdict, { first_eligible: scored?.first_eligible, first_ineligible: scored?.first_ineligible, first_missing: scored?.first_missing, rationale: scored?.rationale,
          against_reason: clauses?.against_reason, support_reason: clauses?.support_reason, open_reason: clauses?.open_reason }, counts),
      });
    }
    return { done, failed };
  }

  /** What a pair is called in a list, a file and a sentence. @param {any} pair */
  #name(pair) {
    const target = object(pair.target);
    const protocol = pair.targetKind === "protocol_version";
    return {
      kind: protocol ? "protocol" : "registry", id: pair.targetId, registry: protocol ? null : text(target.registry), registryId: protocol ? null : text(target.registryId) ?? pair.targetId,
      title: text(target.title) ?? (protocol ? (target.version ? `方案第 ${target.version} 版` : "本研究方案") : String(target.registryId ?? pair.targetId)),
      url: !protocol && typeof target.url === "string" && /^https?:\/\//u.test(target.url) ? target.url : null,
      phase: protocol ? "" : phaseLabel(target.phase), status: protocol ? "" : registryStatusLabel(target.status), statusAsOf: protocol || !target.status ? null : day(pair.judgedAt),
    };
  }

  /** The words and figures of a pair in a list. @param {any} pair */
  #listed(pair) {
    const level = vcrMatchFitLevel(pair.fit), confidence = vcrMatchConfidenceLevel(pair.confidence);
    return {
      ...this.#name(pair), subjectKey: pair.subjectKey, verdict: pair.verdict, verdictLabel: VCR_TRIAL_VERDICT_LABELS_ZH[/** @type {keyof typeof VCR_TRIAL_VERDICT_LABELS_ZH} */ (pair.verdict)],
      fit: pair.fit, fitLevel: level, fitLabel: level ? VCR_MATCH_FIT_LEVEL_LABELS_ZH[level] : null,
      confidence: pair.confidence, confidenceLabel: confidence ? VCR_MATCH_CONFIDENCE_LABELS_ZH[confidence] : null,
      why: pair.why, counts: pair.counts ? { support: pair.counts.support, against: pair.counts.against, silent: pair.counts.silent, open: pair.counts.open, notApplicable: pair.counts.notApplicable } : null,
      judgedAt: pair.judgedAt, producer: pair.producer === "conversation" ? "conversation" : "job", ...(pair.basisChanged ? { basisChanged: true } : {}),
      ...(pair.eligibilitySource === "none" ? { eligibilityNote: VCR_MATCH_NO_ELIGIBILITY_ZH } : {}),
    };
  }

  /** @param {any} entry a failed pair */
  #failure(entry) {
    const protocol = entry.targetKind === "protocol_version";
    return { subjectKey: entry.subjectKey, kind: protocol ? "protocol" : "registry", id: entry.targetId, registryId: protocol ? null : text(entry.target.registryId) ?? entry.targetId,
      title: text(entry.target.title), reason: vcrMatchFailureReason(entry.code), at: entry.at };
  }

  /**
   * What was asked, what is done and what it cost, from the study's judging jobs and the rows they left.
   * @param {string} studyId @param {{ direction: 'patient_to_trial' | 'trial_to_patient', subjectKey?: string | null, protocolVersionId?: string | null }} scope
   * @param {{ done: any[], failed: any[] }} pairs
   */
  async #progress(studyId, { direction, subjectKey = null, protocolVersionId = null }, { done, failed }) {
    const jobs = direction === "patient_to_trial"
      ? await this.rows(`SELECT id, state, scenario, created_at, updated_at, finished_at FROM ${S}.jobs WHERE study_id = $1 AND kind = 'match_judge' AND scenario ->> 'direction' = 'patient_to_trial'
          AND scenario -> 'subjects' @> to_jsonb($2::text) ORDER BY created_at DESC LIMIT ${JOBS_READ}`, [studyId, subjectKey])
      : await this.rows(`SELECT id, state, scenario, created_at, updated_at, finished_at FROM ${S}.jobs WHERE study_id = $1 AND kind = 'match_judge' AND scenario ->> 'direction' = 'trial_to_patient'
          AND scenario ->> 'protocolVersionId' = $2 ORDER BY created_at DESC LIMIT ${JOBS_READ}`, [studyId, protocolVersionId]);
    const withdrawn = direction === "trial_to_patient" ? new Set((await this.rows(`SELECT subject_key FROM ${S}.subject_withdrawals WHERE study_id = $1`, [studyId])).map((row) => String(row.subject_key))) : new Set();
    /** What every job of this scope asked for, by the id of the thing judged (a registry number, a person). @type {Set<string>} */
    const asked = new Set();
    for (const job of jobs) {
      const scenario = object(job.scenario);
      if (direction === "patient_to_trial") for (const trial of list(scenario.trials)) { if (trial?.registryId) asked.add(String(trial.registryId)); }
      else for (const key of list(scenario.subjects)) { if (!withdrawn.has(String(key))) asked.add(String(key)); }
    }
    const idOf = (/** @type {any} */ pair) => (direction === "patient_to_trial" ? pair.targetId : pair.subjectKey);
    const finished = new Set(done.map(idOf));
    const lost = new Set(failed.map(idOf));
    for (const id of finished) asked.add(id);
    for (const id of lost) asked.add(id);
    const failedOnly = [...lost].filter((id) => !finished.has(id));
    const total = asked.size;
    const waiting = [...asked].filter((id) => !finished.has(id) && !lost.has(id));
    const latest = jobs[0] ?? null;
    const running = latest ? OPEN_JOB_STATES.includes(String(latest.state)) : false;
    const spent = latest ? await this.one(`SELECT sum(NULLIF(usage ->> 'cost', '')::numeric)::float AS cost
        FROM ${S}.match_judgments WHERE study_id = $1 AND job_id = $2`, [studyId, String(latest.id)]) : null;
    const estimate = object(object(latest?.scenario).estimate);
    return {
      total, finished: finished.size, failed: failedOnly.length, waiting: waiting.length,
      state: running ? (String(latest.state) === "awaiting_budget" ? "waiting_budget" : "running") : total === 0 ? "idle" : waiting.length || failedOnly.length ? "stopped" : "done",
      jobId: latest ? String(latest.id) : null, startedAt: latest ? iso(latest.created_at) : null,
      cost: latest ? { ceiling: estimate.cost == null || !Number.isFinite(Number(estimate.cost)) ? null : Number(estimate.cost), spent: spent?.cost == null ? null : Number(spent.cost), currency: String(estimate.currency ?? "CNY") } : null,
      // What is still to do — the ones that never ran and the ones that failed — and how the latest job was set; the continue action starts exactly these.
      left: [...waiting, ...failedOnly],
      settings: latest ? pick(object(latest.scenario), ["fit", "topK", "thinking", "collection", "collectionRevision"]) : {},
    };
  }

  /**
   * The failures of a scope grouped by their plain reason, and the first few by name.
   * @param {Array<{ reason: string }>} failures
   */
  #failureSummary(failures) {
    /** @type {Map<string, number>} */
    const byReason = new Map();
    for (const failure of failures) byReason.set(failure.reason, (byReason.get(failure.reason) ?? 0) + 1);
    return { count: failures.length, reasons: [...byReason].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count), listed: failures.slice(0, FAILED_LISTED) };
  }

  /**
   * What "continue the rest" starts: the ids still to judge in a scope, with the settings the latest job was run under, so that the pairs already judged are the
   * same pairs the new job finds in the ledger.
   * @param {any} study @param {{ direction: 'patient_to_trial' | 'trial_to_patient', subjectKey?: string | null, protocolVersionId?: string | null }} scope
   */
  async resumeSelection(study, scope) {
    const pairs = await this.#pairs(study.id, scope.direction === "patient_to_trial" ? { subjectKey: scope.subjectKey } : { targetKind: "protocol_version", targetId: scope.protocolVersionId });
    const { left, settings } = await this.#progress(study.id, scope, pairs);
    return { ids: left, settings };
  }

  /** Where the page should open when it is asked for nothing in particular: the newest thing worked on. @param {string} studyId */
  async latest(studyId) {
    const row = await this.one(`SELECT * FROM (
        SELECT j.subject_key, j.target_kind, j.target_id, j.updated_at FROM ${S}.match_judgments j WHERE j.study_id = $1 AND ${NOT_WITHDRAWN}
        UNION ALL
        SELECT CASE WHEN scenario ->> 'direction' = 'patient_to_trial' THEN scenario -> 'subjects' ->> 0 END, CASE WHEN scenario ->> 'direction' = 'patient_to_trial' THEN 'candidate_trial' ELSE 'protocol_version' END,
          scenario ->> 'protocolVersionId', created_at FROM ${S}.jobs WHERE study_id = $1 AND kind = 'match_judge') newest
      ORDER BY updated_at DESC LIMIT 1`, [studyId]);
    if (!row) return null;
    return row.target_kind === "candidate_trial" ? { direction: "patient_to_trial", subjectKey: String(row.subject_key) } : { direction: "trial_to_patient", protocolVersionId: String(row.target_id) };
  }

  /**
   * One person's trials: the list in the platform's order, what is done of what was asked, the failures and the chosen trial opened.
   * @param {any} study @param {string} subjectKey @param {{ target?: string | null, viewer?: { id: string } | null }} [options]
   */
  async forPatient(study, subjectKey, { target = null, viewer = null } = {}) {
    const pairs = await this.#pairs(study.id, { subjectKey });
    const { left: _left, settings: _settings, ...progress } = await this.#progress(study.id, { direction: "patient_to_trial", subjectKey }, pairs);
    const ranked = rankJudgments(pairs.done.map((pair) => ({ ...pair, id: pair.targetId, criteria: pair.counts && pair.counts.against > 0 ? [{ label: "excluded", basis: "stated" }] : [] })));
    const trials = ranked.map((pair, index) => ({ rank: index + 1, ...this.#listed(pair) }));
    const failures = pairs.failed.map((entry) => this.#failure(entry));
    const chosen = ranked.find((pair) => pair.targetId === target) ?? ranked[0] ?? null;
    return {
      direction: "patient_to_trial", subjectKey, held: pairs.done.length > 0 || pairs.failed.length > 0 || progress.total > 0, progress,
      trials, failed: this.#failureSummary(failures), selected: chosen ? await this.#open(study, chosen, viewer) : null,
    };
  }

  /**
   * One protocol version's people: the tallies by verdict, a filtered and paged list, the clause funnel and the opened person.
   * @param {any} study @param {string} protocolVersionId
   * @param {{ verdict?: string | null, offset?: number, limit?: number, subjectKey?: string | null, viewer?: { id: string } | null }} [options]
   */
  async forProtocol(study, protocolVersionId, { verdict = null, offset = 0, limit = MATCH_PAGE.default, subjectKey = null, viewer = null } = {}) {
    const scope = { targetKind: "protocol_version", targetId: protocolVersionId };
    const pairs = await this.#pairs(study.id, scope);
    const { left: _left, settings: _settings, ...progress } = await this.#progress(study.id, { direction: "trial_to_patient", protocolVersionId }, pairs);
    /** @type {Record<string, number>} */
    const tallies = Object.fromEntries(VERDICTS.map((name) => [name, 0]));
    for (const pair of pairs.done) tallies[pair.verdict] += 1;
    const fitOf = (/** @type {any} */ pair) => (Number.isFinite(pair.fit) ? Number(pair.fit) : -1);
    const ordered = pairs.done.filter((pair) => !verdict || pair.verdict === verdict).sort((a, b) =>
      VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict) || fitOf(b) - fitOf(a) || (b.confidence ?? -1) - (a.confidence ?? -1) || (a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : 0));
    const start = Math.max(0, Math.floor(offset));
    const size = Math.max(1, Math.min(MATCH_PAGE.most, Math.floor(limit)));
    const chosen = subjectKey ? pairs.done.find((pair) => pair.subjectKey === subjectKey) ?? null : null;
    const failures = pairs.failed.map((entry) => this.#failure(entry));
    return {
      direction: "trial_to_patient", protocolVersionId, held: pairs.done.length > 0 || pairs.failed.length > 0 || progress.total > 0, progress, tallies,
      people: ordered.slice(start, start + size).map((pair) => this.#listed(pair)), total: ordered.length, offset: start, limit: size, more: ordered.length > start + size,
      clauses: await this.#funnel(study.id, protocolVersionId), failed: this.#failureSummary(failures),
      changed: pairs.done.filter((pair) => pair.basisChanged).length,
      selected: chosen ? await this.#open(study, chosen, viewer) : null,
    };
  }

  /**
   * For each clause of a protocol version, how many of the people judged against it it satisfies, disqualifies, finds the record silent on or leaves open. Disqualified first.
   * @param {string} studyId @param {string} protocolVersionId
   */
  async #funnel(studyId, protocolVersionId) {
    const newest = `WITH newest AS (
        SELECT DISTINCT ON (j.subject_key) j.id FROM ${S}.match_judgments j
        WHERE j.study_id = $1 AND j.target_kind = 'protocol_version' AND j.target_id = $2 AND j.mode = 'criteria' AND ${NOT_WITHDRAWN}
        ORDER BY j.subject_key, (j.status = 'done') DESC, j.updated_at DESC, j.id)`;
    const [answered, unanswered, people] = await Promise.all([
      this.rows(`${newest}
        SELECT (c ->> 'number')::int AS number, max(c ->> 'kind') AS kind, max(c ->> 'clause') AS clause,
          count(*) FILTER (WHERE c ->> 'basis' = 'stated' AND c ->> 'label' IN ('included', 'not_excluded'))::int AS support,
          count(*) FILTER (WHERE c ->> 'basis' = 'stated' AND c ->> 'label' IN ('excluded', 'not_included'))::int AS against,
          count(*) FILTER (WHERE c ->> 'basis' IS DISTINCT FROM 'stated' AND c ->> 'label' IN ('included', 'not_excluded'))::int AS silent,
          count(*) FILTER (WHERE c ->> 'label' = 'not_enough_information' OR (c ->> 'basis' IS DISTINCT FROM 'stated' AND c ->> 'label' IN ('excluded', 'not_included')))::int AS open,
          count(*) FILTER (WHERE c ->> 'label' = 'not_applicable')::int AS not_applicable
        FROM newest nw JOIN ${S}.match_judgments j ON j.id = nw.id AND j.status = 'done'
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(j.answer -> 'rows') = 'array' THEN j.answer -> 'rows' ELSE '[]'::jsonb END) c
        GROUP BY 1 ORDER BY 1`, [studyId, protocolVersionId]),
      this.rows(`${newest}
        SELECT (m ->> 'number')::int AS number, max(m ->> 'kind') AS kind, max(m ->> 'text') AS clause, count(*)::int AS open
        FROM newest nw JOIN ${S}.match_judgments j ON j.id = nw.id AND j.status = 'done'
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(j.answer -> 'missing') = 'array' THEN j.answer -> 'missing' ELSE '[]'::jsonb END) m
        GROUP BY 1`, [studyId, protocolVersionId]),
      this.one(`${newest} SELECT count(*)::int AS people FROM newest nw JOIN ${S}.match_judgments j ON j.id = nw.id AND j.status = 'done'`, [studyId, protocolVersionId]),
    ]);
    /** @type {Map<number, any>} */
    const byNumber = new Map(answered.map((row) => [Number(row.number), {
      number: Number(row.number), kind: row.kind === "exclusion" ? "exclusion" : "inclusion", clause: String(row.clause ?? ""),
      support: Number(row.support), against: Number(row.against), silent: Number(row.silent), open: Number(row.open), notApplicable: Number(row.not_applicable),
    }]));
    for (const row of unanswered) {
      const entry = byNumber.get(Number(row.number)) ?? { number: Number(row.number), kind: row.kind === "exclusion" ? "exclusion" : "inclusion", clause: String(row.clause ?? ""), support: 0, against: 0, silent: 0, open: 0, notApplicable: 0 };
      entry.open += Number(row.open);
      byNumber.set(entry.number, entry);
    }
    const rows = [...byNumber.values()].sort((a, b) => b.against - a.against || (b.open + b.silent) - (a.open + a.silent) || a.number - b.number);
    return { judgedPeople: Number(people?.people ?? 0), rows };
  }

  /**
   * One pair opened: the reasons in three groups, the clause table with each clause's sentences, and the note on a trial without eligibility text.
   * @param {any} study @param {any} pair @param {{ id: string } | null} viewer
   */
  async #open(study, pair, viewer) {
    const ids = [pair.fitRowId, pair.criteriaRowId].filter(Boolean);
    const rows = await this.judgments.byIds(study.id, ids);
    const fit = rows.find((/** @type {any} */ row) => row.id === pair.fitRowId) ?? null, criteria = rows.find((/** @type {any} */ row) => row.id === pair.criteriaRowId) ?? null;
    if (!fit && !criteria) return null;
    const presented = await this.#viewed(study, presentJudgment(fit, criteria), viewer);
    const clauses = clauseRows(presented);
    return {
      ...this.#listed(pair), subjectKey: pair.subjectKey, groups: reasonGroups(presented, clauses), summary: clip(text(presented.reasons?.rationale)),
      clauses, withheld: clauses.reduce((sum, clause) => sum + Number(/** @type {any} */ (clause).evidenceHidden ?? 0), 0),
    };
  }

  /**
   * A presented pair with each sentence re-read under the viewer's grant. A sentence the record no longer says, or the viewer may not read, is
   * dropped from its clause and counted there.
   * @param {any} study @param {any} presented @param {{ id: string } | null} viewer
   */
  async #viewed(study, presented, viewer) {
    const entries = presented.criteria.flatMap((/** @type {any} */ row) => list(row.evidence).map((/** @type {any} */ item) => ({ ...item, quote: item.text, key: `${row.number}:${item.sentenceId}` })));
    if (!entries.length) return presented;
    const kept = viewer && this.documents?.viewEvidence ? await this.documents.viewEvidence(study, entries, presented.subjectKey, viewer).catch(() => []) : [];
    const stands = new Set(list(kept).map((item) => item.key));
    return { ...presented, criteria: presented.criteria.map((/** @type {any} */ row) => {
      const evidence = list(row.evidence).filter((/** @type {any} */ item) => stands.has(`${row.number}:${item.sentenceId}`));
      return evidence.length === list(row.evidence).length ? row : { ...row, evidence, evidenceWithheld: list(row.evidence).length - evidence.length };
    }) };
  }

  // -------------------------------------------------------------------------
  // The files
  // -------------------------------------------------------------------------

  /**
   * What a download of a scope will be: its name and type, and a function that writes it to a sink a few pairs at a time. Everything that can
   * refuse is decided here, before the first byte, so a refusal is still an answer and not a cut-off file.
   * @param {any} study @param {{ format: 'csv' | 'json', kind: 'pairs' | 'clauses', direction: 'patient_to_trial' | 'trial_to_patient', subjectKey?: string | null, protocolVersionId?: string | null }} request
   * @param {() => Date} [now]
   */
  async exporter(study, { format, kind, direction, subjectKey = null, protocolVersionId = null }, now = () => new Date()) {
    const scope = direction === "patient_to_trial" ? { subjectKey } : { targetKind: "protocol_version", targetId: protocolVersionId };
    const pairs = await this.#pairs(study.id, scope);
    const ordered = [...pairs.done].sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0));
    const exportedAt = now().toISOString();
    const stamp = exportedAt.slice(0, 10);
    const filename = `matching-${direction === "patient_to_trial" ? "patient" : "protocol"}-${kind}-${stamp}.${format}`;
    const header = ["患者", "对象", "登记号", "标题", "结论", "匹配度（0-100）", "匹配等级", "把握度", "满足", "不满足", "未见记载", "待查", "不适用", "理由", "判定方式", "判定时间", "依据已更新"];
    const clauseHeader = ["患者", "对象", "登记号", "标题", "结论", "条款编号", "类型", "条款原文", "判定", "有无原文依据", "理由", "依据句号", "依据原文"];
    const chunks = (/** @type {any[]} */ items) => { const out = []; for (let at = 0; at < items.length; at += EXPORT_CHUNK) out.push(items.slice(at, at + EXPORT_CHUNK)); return out; };
    const pairLine = (/** @type {any} */ pair) => {
      const listed = this.#listed(pair);
      return { listed, cells: [listed.subjectKey, listed.kind === "protocol" ? "本研究方案" : "登记试验", listed.registryId, listed.title, listed.verdictLabel, listed.fit, listed.fitLabel, listed.confidenceLabel,
        listed.counts?.support ?? null, listed.counts?.against ?? null, listed.counts?.silent ?? null, listed.counts?.open ?? null, listed.counts?.notApplicable ?? null, listed.why,
        listed.producer === "conversation" ? "对话" : "判定作业", listed.judgedAt, listed.basisChanged ? "是" : "否"] };
    };
    /** @param {{ write: (chunk: string) => Promise<void> }} sink */
    const run = async (sink) => {
      if (format === "csv") await sink.write(`\uFEFF${csvLine(kind === "pairs" ? header : clauseHeader)}`);
      else await sink.write(`{"schema":"evimed-matching-export/1","direction":${JSON.stringify(direction)},"kind":${JSON.stringify(kind)},"exportedAt":${JSON.stringify(exportedAt)},"rows":[`);
      let first = true;
      for (const group of chunks(ordered)) {
        const rows = new Map((await this.judgments.byIds(study.id, group.flatMap((pair) => [pair.fitRowId, pair.criteriaRowId].filter(Boolean)))).map((/** @type {any} */ row) => [row.id, row]));
        for (const pair of group) {
          const { listed, cells } = pairLine(pair);
          const fitRow = pair.fitRowId ? rows.get(pair.fitRowId) ?? null : null, criteriaRow = pair.criteriaRowId ? rows.get(pair.criteriaRowId) ?? null : null;
          if (!fitRow && !criteriaRow) continue;
          if (kind === "pairs") {
            if (format === "csv") await sink.write(csvLine(cells));
            else { await sink.write(`${first ? "" : ","}${JSON.stringify({ subjectKey: listed.subjectKey, target: { kind: listed.kind, id: listed.id, registryId: listed.registryId, title: listed.title }, verdict: listed.verdict, fit: listed.fit, fitLevel: listed.fitLevel,
              confidence: listed.confidence, counts: listed.counts, reason: listed.why, producer: listed.producer, judgedAt: listed.judgedAt, basisChanged: Boolean(listed.basisChanged) })}`); first = false; }
            continue;
          }
          const clauses = clauseRows(presentJudgment(fitRow, criteriaRow));
          for (const clause of clauses) {
            const sentences = clause.evidence;
            if (format === "csv") {
              await sink.write(csvLine([cells[0], cells[1], cells[2], cells[3], cells[4], clause.number, clause.kind === "exclusion" ? "排除" : "入选", clause.clause, clause.display, sentences.length ? "有" : "无", clause.reason,
                sentences.map((item) => item.sentenceId).join("、"), sentences.map((item) => item.text).join(" | ")]));
            } else {
              await sink.write(`${first ? "" : ","}${JSON.stringify({ subjectKey: listed.subjectKey, target: { kind: listed.kind, id: listed.id, registryId: listed.registryId, title: listed.title }, verdict: listed.verdict,
                clause: { number: clause.number, kind: clause.kind, text: clause.clause, label: clause.label, basis: clause.basis, stance: clause.stance, display: clause.display, reason: clause.reason,
                  sentences: sentences.map((item) => ({ id: item.sentenceId, text: item.text })) } })}`); first = false;
            }
          }
        }
      }
      if (format === "json") await sink.write("]}");
    };
    return { filename, contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8", rows: ordered.length, run };
  }
}

/** The stance words, for a caller that draws a funnel without importing the domain. */
export const STANCE_WORDS = VCR_MATCH_STANCE_LABELS_ZH;
