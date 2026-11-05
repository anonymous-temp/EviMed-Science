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
 * - **A reason and a sentence are the record's, and shown under the reader's own judgment.** A sentence is an id the code resolved at judging time; here it is re-read from the record under the
 *   viewer, and one that no longer matches what the record says is not shown, said as a count. A reason may repeat the record, so a reader who may not read what a row read (a viewer has no
 *   patient-level access; a member may hold no grant on the source) gets the verdict and the counts of the row with its reasons and sentences removed and one plain note. An export is judged the
 *   same way, row by row, and prints the same; a withdrawn person is in none of it, because their rows are gone.
 * - **Exact small counts are the owner's.** Tallies, the clause funnel and how many people a job has done speak for groups of people, so to anyone else they pass the same rule every read
 *   passes (`hiddenSet`). A viewer's list of people leaves out the groups too small to show; a member who may read patient-level data sees the people and not the counts.
 * - **A failed read is a failed read.** Nothing here turns an error into an empty list: an empty list is the page saying nothing was
 *   judged, and that sentence must be true.
 *
 * @module vcrMatchResults
 */

import {
  criterionDisplay, hiddenSet, rankJudgments, trialVerdict, VCR_MATCH_FIT_LEVEL_LABELS_ZH, VCR_MATCH_CONFIDENCE_LABELS_ZH, VCR_MATCH_NO_ELIGIBILITY_ZH, VCR_MIN_CELL_SIZE,
  VCR_MATCH_STANCE_LABELS_ZH, VCR_TRIAL_VERDICT_LABELS_ZH, vcrMatchConfidenceLevel, vcrMatchFailureReason, vcrMatchFitLevel, vcrSubjectLabel, vcrSubjectLabels,
} from "@evimed/domain";

import { presentJudgment } from "./vcrMatchJudge.mjs";
import { phaseLabel, registryStatusLabel } from "./vcrPatientTrials.mjs";
import { REGISTRY_RECORD_BASIS, REJUDGE_FAILED_NOTE_ZH, WITHDRAWN_SUBJECT_MARK, basisChangedOf, judgingProgress, recordGapOf, standingRows } from "./vcrMatchJudgmentStore.mjs";
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
 * @param {{ fit: number | null, counts: { against: number, open: number, answered: number, unanswered: number } | null, missingReasons?: number, ineligibleReasons?: number }} input
 */
export function verdictOfCounts({ fit, counts, missingReasons = 0, ineligibleReasons = 0 }) {
  if (!counts || counts.answered + counts.unanswered === 0) return trialVerdict({ fit, missingReasons: Array.from({ length: missingReasons }), ineligibleReasons: Array.from({ length: ineligibleReasons }) });
  const rows = [
    ...Array.from({ length: counts.against }, () => ({ label: "excluded", basis: "stated" })),
    ...Array.from({ length: counts.open }, () => ({ label: "not_enough_information", basis: "silent" })),
    ...Array.from({ length: Math.max(0, counts.answered - counts.against - counts.open) }, () => ({ label: "included", basis: "stated" })),
  ];
  return trialVerdict({ fit, criteria: counts.answered ? rows : null, missing: Array.from({ length: counts.unanswered }), missingReasons: Array.from({ length: missingReasons }), ineligibleReasons: Array.from({ length: ineligibleReasons }) });
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

/** The section a clause stands in; one under no section says so, and is no inclusion. @param {unknown} kind */
const kindOf = (kind) => (kind === "exclusion" || kind === "unsectioned" ? kind : "inclusion");

/** The clause rows of a pair in the shape the page and the files read. @param {any} presented a `presentJudgment` answer */
function clauseRows(presented) {
  const answered = list(presented.criteria).map((/** @type {any} */ row) => {
    const evidence = list(row.evidence).map((/** @type {any} */ item) => ({
      sentenceId: Number(item.sentenceId), text: String(item.text ?? ""), documentId: item.documentId ?? null,
      start: Number.isFinite(item.start) ? Number(item.start) : null, end: Number.isFinite(item.end) ? Number(item.end) : null,
      ...(item.source?.field ? { field: String(item.source.field) } : {}),
    }));
    return {
      number: Number(row.number), kind: kindOf(row.kind), clause: String(row.clause ?? ""), ...(row.lead ? { lead: String(row.lead) } : {}),
      label: String(row.label), basis: row.basis === "stated" ? "stated" : "silent", display: row.display ?? criterionDisplay(row), stance: stanceOf(row),
      reason: clip(text(row.reason)) ?? "", evidence, ...(row.evidenceWithheld ? { evidenceHidden: Number(row.evidenceWithheld) } : {}),
    };
  });
  const unanswered = list(presented.missingClauses).map((/** @type {any} */ clause) => ({
    number: Number(clause.number), kind: kindOf(clause.kind), clause: String(clause.text ?? ""),
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

/** A presented pair with nothing left of what it read: no reasons, and each clause with its label and no reason or sentence. @param {any} presented */
function withoutWords(presented) {
  return { ...presented, reasons: { eligible: [], ineligible: [], missing: [], rationale: "" },
    criteria: list(presented.criteria).map((row) => ({ ...row, reason: "", evidence: [], ...(list(row.evidence).length ? { evidenceWithheld: list(row.evidence).length } : {}) })) };
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
const COLUMNS = `j.document_hash, j.target_hash, j.answer -> 'unreadableDocuments' AS unreadable_documents, j.answer -> 'documentsLeftOut' AS documents_left_out, j.answer -> 'leftOut' AS left_out, j.answer -> 'tableUnread' AS table_unread,
  j.answer -> 'longUnread' AS long_unread, j.answer -> 'clausesWithoutWords' AS clauses_without_words, j.document_ids, j.answer -> 'readFrom' AS read_from, j.id, j.subject_key, j.target_kind, j.target_id, j.mode, j.status, j.error_code, j.fit, j.confidence, j.producer, j.model, j.thinking, j.basis_changed, j.job_id,
  j.created_at, j.updated_at, j.answer -> 'target' AS target, j.answer ->> 'eligibilitySource' AS eligibility_source,
  j.answer #>> '{reasons,eligible,0}' AS first_eligible, j.answer #>> '{reasons,ineligible,0}' AS first_ineligible, j.answer #>> '{reasons,missing,0}' AS first_missing, j.answer #>> '{reasons,rationale}' AS rationale,
  CASE WHEN jsonb_typeof(j.answer #> '{reasons,missing}') = 'array' THEN jsonb_array_length(j.answer #> '{reasons,missing}') ELSE 0 END AS missing_reasons,
  CASE WHEN jsonb_typeof(j.answer #> '{reasons,ineligible}') = 'array' THEN jsonb_array_length(j.answer #> '{reasons,ineligible}') ELSE 0 END AS ineligible_reasons`;

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

/** What a reader who may not read what a row read is told, in place of its reasons and sentences. */
const READER_ROLE_NOTE_ZH = "你的角色不能查看病历内容，这里只显示结论，不含理由和病历原文。";
const READER_GRANT_NOTE_ZH = "这条结论读过的病历，你没有授权或现在已读不到，理由和原文依据已隐去。";
/** What a row says when a sentence it quoted can no longer be read back. */
const evidenceNoteZh = (/** @type {number} */ count) => `有 ${count} 句原文现在读不到（病历已改动或你没有权限），已隐去。`;

/** What a saved row read: its documents, and the snapshots whose words it held. @param {any} row a light row */
const recordOf = (row) => ({ documentIds: list(row?.document_ids).map(String), snapshots: list(object(row?.read_from).snapshots).map(object).filter((entry) => entry.id).map((entry) => ({ id: String(entry.id), ...(Array.isArray(entry.fields) ? { fields: entry.fields.map(String) } : {}) })) });
/** What two rows of a pair read, together. @param {any} one @param {any} other */
const recordOfPair = (one, other) => {
  const first = recordOf(one), second = recordOf(other);
  return { documentIds: [...new Set([...first.documentIds, ...second.documentIds])], snapshots: [...new Map([...first.snapshots, ...second.snapshots].map((entry) => [`${entry.id}:${(entry.fields ?? []).join(",")}`, entry])).values()] };
};

/**
 * Sibling counts of people for anyone but the owner: what the domain's rule hides is null, and the hidden keys are named. Nothing else is touched.
 * @template {Record<string, any>} T @param {T} cells @param {readonly string[]} keys @param {number} minCell @returns {T & { suppressed?: string[] }}
 */
function hideSmall(cells, keys, minCell) {
  const counted = keys.filter((key) => Number.isFinite(cells[key]));
  const hidden = hiddenSet(counted.map((key) => Number(cells[key])), minCell);
  if (!hidden.size) return cells;
  const names = [...hidden].map((at) => counted[at]);
  return { ...cells, ...Object.fromEntries(names.map((key) => [key, null])), suppressed: names };
}
/** A count of people on its own: small is null. @param {number} count @param {number} minCell */
const hideAlone = (count, minCell) => (count >= 1 && count < minCell ? null : count);

/** What a row says of what its verdict did not read, from the columns of the newest query. @param {any} row */
const gapOfRow = (row) => recordGapOf({ unreadableDocuments: row?.unreadable_documents, documentsLeftOut: row?.documents_left_out, leftOut: row?.left_out, tableUnread: row?.table_unread, longUnread: row?.long_unread, clausesWithoutWords: row?.clauses_without_words });

/** What a pair's list row says of its second stage when it is not behind the verdict. @param {any} pair */
function clausesNoteOf(pair) {
  if (pair.rejudgeFailure) return `${REJUDGE_FAILED_NOTE_ZH}（${vcrMatchFailureReason(pair.rejudgeFailure.code)}）`;
  if (pair.clauseFailure && !pair.judgedByClauses) return `逐条判定没有完成：${vcrMatchFailureReason(pair.clauseFailure)}`;
  if (pair.older === "criteria") return "逐条判定读的是更早的内容，没有算进这个结论。";
  if (pair.older === "fit") return "匹配度读的是更早的内容，没有算进这个结论。";
  return null;
}

/** Why a registry gave nothing, in words, for the one line the page says of the last search. */
const SEARCH_FAILURE_WORDS_ZH = Object.freeze(/** @type {Record<string, string>} */ ({
  search_deadline: "没来得及查", registry_not_configured: "本部署没有接入", registry_unavailable: "登记库暂时没有回答", registry_rate_limited: "登记库限制了查询次数", registry_timeout: "登记库回答超时",
}));

/**
 * What the newest saved search for this person could not reach, in one line with the reason; nothing when every registry answered, since then there is nothing for the reader to do.
 * @param {{ createdAt: string | null, found: number, registries: any[] } | null} receipt
 */
function searchLineOf(receipt) {
  if (!receipt) return null;
  const parts = list(receipt.registries).map((entry) => {
    const name = String(entry?.name ?? entry?.registry ?? "登记库");
    if (entry?.state === "searched") return `${name} 已查`;
    if (entry?.state === "partial") return `${name} 只查到一部分检索词`;
    if (entry?.state === "not_configured") return `${name} 本部署没有接入`;
    const reasons = [...new Set(list(entry?.failed).map((failure) => SEARCH_FAILURE_WORDS_ZH[String(object(failure).reason)] ?? "登记库没有回答"))];
    return `${name} 没查到（${reasons.join("、") || "登记库没有回答"}）`;
  });
  if (!parts.length || list(receipt.registries).every((entry) => entry?.state === "searched")) return null;
  return `上次检索${receipt.createdAt ? `（${receipt.createdAt.slice(0, 10)}）` : ""}：共找到 ${receipt.found} 个试验；${parts.join("，")}。`;
}

/** What a page and a file say when a scope is larger than one read holds. @param {number} most */
const CUT_NOTE_ZH = (most) => `这里的对数超过一次能读的上限，只算到前 ${Number(most).toLocaleString("en-US")} 对左右；分批选人可以看全。`;

/** What the page says of a person's trials whose registry record has changed since they were judged. */
const REGISTRY_STALE_LABEL_ZH = "登记记录已更新，可重新判定";
/** What the page says of a judgment whose record was a document the person's chart has since changed, withdrawn or re-permitted. */
const RECORD_CHANGED_LABEL_ZH = "病历在判定之后有更新";

/**
 * The mark on a judgment whose basis moved, for a page: the registry watch's own words, or the chart's.
 * @param {unknown} stored the column as stored
 * @returns {{ kind: string, label: string } | null}
 */
function basisMarkOf(stored) {
  const mark = basisChangedOf(stored);
  if (mark == null) return null;
  if (typeof mark === "object" && /** @type {any} */ (mark).kind === REGISTRY_RECORD_BASIS) return { kind: REGISTRY_RECORD_BASIS, label: text(/** @type {any} */ (mark).label) ?? "登记记录已更新" };
  return { kind: "record", label: RECORD_CHANGED_LABEL_ZH };
}

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
   * @param {{ database: any, judgments: any, documents?: any, matchStore?: any, searches?: any, minCell?: number, statementTimeoutMs?: number, mostPairs?: number }} deps
   * `judgments` is the judgment store (whole rows by id), `documents` the seam that re-reads a sentence and judges a read under the viewer's grant.
   */
  constructor({ database, judgments, documents = null, matchStore = null, searches = null, minCell = VCR_MIN_CELL_SIZE, statementTimeoutMs = READ_TIMEOUT_MS, mostPairs = MOST_PAIRS }) {
    super({ database, statementTimeoutMs });
    this.mostPairs = mostPairs;
    this.judgments = judgments;
    this.documents = documents;
    this.matchStore = matchStore;
    this.searches = searches;
    this.minCell = minCell;
  }

  /**
   * Who may read what of these pairs: each gets `readable`, and the one note that says why a row holds no reasons. A failed judgment is an error and not an empty page, like any failed read here.
   * @param {any} study @param {{ id: string } | null} viewer @param {any[]} pairs
   */
  async #judgeReaders(study, viewer, pairs) {
    if (!pairs.length) return;
    const { patientLevel, permitted } = this.documents?.judgeReads ? await this.documents.judgeReads(study, viewer, pairs.map((pair) => pair.record)) : { patientLevel: false, permitted: pairs.map(() => false) };
    pairs.forEach((pair, index) => {
      pair.readable = permitted[index] === true;
      pair.patientLevel = patientLevel === true;
      if (!pair.readable) pair.withheldNote = patientLevel ? READER_GRANT_NOTE_ZH : READER_ROLE_NOTE_ZH;
    });
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
        LIMIT ${Math.floor(this.mostPairs) * 2})
      SELECT ${COLUMNS}, k.answered, k.support, k.against, k.not_applicable, k.silent, k.nei, k.silent_against, k.against_reason, k.support_reason, k.open_reason, u.unanswered, nf.newer_error, nf.newer_at
      FROM newest nw JOIN ${S}.match_judgments j ON j.id = nw.id ${COUNTS}
      LEFT JOIN (
        SELECT DISTINCT ON (f.subject_key, f.target_kind, f.target_id, f.mode) f.subject_key, f.target_kind, f.target_id, f.mode, f.error_code AS newer_error, f.updated_at AS newer_at
        FROM ${S}.match_judgments f
        WHERE f.study_id = $1 AND f.status = 'failed' AND ($2::text IS NULL OR f.subject_key = $2) AND ($3::text IS NULL OR f.target_kind = $3) AND ($4::text IS NULL OR f.target_id = $4)
        ORDER BY f.subject_key, f.target_kind, f.target_id, f.mode, f.updated_at DESC) nf
        ON j.status = 'done' AND nf.subject_key = j.subject_key AND nf.target_kind = j.target_kind AND nf.target_id = j.target_id AND nf.mode = j.mode AND nf.newer_at > j.updated_at`, [studyId, subjectKey, targetKind, targetId]);
  }

  /**
   * The short names of the people in view, unique among everyone the study has judged (`vcrSubjectLabels`); a read that fails names them from their own digits.
   * @param {string} studyId @param {string[]} inView
   * @returns {Promise<Map<string, string>>}
   */
  async #labels(studyId, inView) {
    try {
      const roster = await this.rows(`SELECT DISTINCT j.subject_key FROM ${S}.match_judgments j WHERE j.study_id = $1 AND ${NOT_WITHDRAWN} LIMIT 200000`, [studyId]);
      return vcrSubjectLabels([...roster.map((row) => String(row.subject_key)), ...inView]);
    } catch {
      return vcrSubjectLabels(inView);
    }
  }

  /**
   * The rows of a scope as pairs: the finished ones with their verdict, and the ones that failed with the reason.
   * @param {string} studyId @param {{ subjectKey?: string | null, targetKind?: string | null, targetId?: string | null }} scope
   */
  async #pairs(studyId, scope) {
    const rows = await this.#newest(studyId, scope);
    // A scope past what one read holds is read as far as that, and says so: a list or a file that ended silently would read as all of it.
    const cut = rows.length >= Math.floor(this.mostPairs) * 2;
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
      // The rows of a pair stand together only when they read the same words; otherwise the newer reading stands alone.
      const readingOf = (/** @type {any} */ row) => (row?.status === "done" ? { row, documentHash: row.document_hash, targetHash: row.target_hash, updatedAt: iso(row.updated_at) } : null);
      const standing = standingRows(readingOf(fit), readingOf(criteria));
      const scored = standing.fit?.row ?? null, clauses = standing.criteria?.row ?? null;
      if (!scored && !clauses) {
        const row = fit ?? criteria;
        failed.push({ subjectKey: String(row.subject_key), targetKind: String(row.target_kind), targetId: String(row.target_id), target: object(row.target), code: row.error_code ?? null, at: iso(row.updated_at) });
        continue;
      }
      const anchor = clauses && scored ? (clauses.updated_at >= scored.updated_at ? clauses : scored) : clauses ?? scored;
      // A later reading of either mode that did not finish: the last verdict stays, and the pair is owed its re-judgment.
      const later = [fit, criteria].filter((row) => row?.newer_at).sort((a, b) => String(iso(b.newer_at)).localeCompare(String(iso(a.newer_at))))[0] ?? null;
      const counts = clauses ? countsOf(clauses) : null;
      const score = scored?.fit ?? clauses?.fit ?? null;
      const verdict = verdictOfCounts({ fit: score, counts, missingReasons: Number(scored?.missing_reasons ?? 0), ineligibleReasons: Number(scored?.ineligible_reasons ?? 0) });
      const identity = scored ?? clauses;
      done.push({
        record: recordOfPair(scored, clauses),
        subjectKey: String(identity.subject_key), targetKind: String(identity.target_kind), targetId: String(identity.target_id), target: object(scored?.target ?? clauses?.target),
        documentHash: String((scored ?? clauses).document_hash ?? ""), targetHash: String((scored ?? clauses).target_hash ?? ""),
        fitRowId: scored?.id ?? null, criteriaRowId: clauses?.id ?? null, fit: score === null ? null : Number(score),
        confidence: (scored?.confidence ?? clauses?.confidence) === null || (scored?.confidence ?? clauses?.confidence) === undefined ? null : Number(scored?.confidence ?? clauses?.confidence),
        verdict: verdict.verdict, counts, producer: String(anchor.producer), judgedAt: iso(anchor.updated_at), basisChanged: basisMarkOf(scored?.basis_changed ?? clauses?.basis_changed ?? null),
        eligibilitySource: anchor.eligibility_source ?? scored?.eligibility_source ?? null, judgedByClauses: Boolean(clauses), older: standing.older, recordGap: gapOfRow(anchor),
        ...(later ? { rejudgeFailure: { code: later.newer_error ?? "vcr_match_judge_failed", at: iso(later.newer_at) } } : {}),
        ...(criteria?.status === "failed" ? { clauseFailure: criteria.error_code ?? "vcr_match_judge_failed", clauseFailedAt: iso(criteria.updated_at) } : {}),
        why: whyOf(verdict.verdict, { first_eligible: scored?.first_eligible, first_ineligible: scored?.first_ineligible, first_missing: scored?.first_missing, rationale: scored?.rationale,
          against_reason: clauses?.against_reason, support_reason: clauses?.support_reason, open_reason: clauses?.open_reason }, counts),
      });
    }
    // Whoever reads a person reads the same short name: unique within the study's roster, and never the key itself.
    const labels = await this.#labels(studyId, [...done, ...failed].map((entry) => entry.subjectKey));
    for (const entry of [...done, ...failed]) entry.label = labels.get(entry.subjectKey) ?? vcrSubjectLabel(entry.subjectKey);
    return { done, failed, cut };
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
      ...this.#name(pair), subjectKey: pair.subjectKey, label: pair.label ?? vcrSubjectLabel(pair.subjectKey), verdict: pair.verdict, verdictLabel: VCR_TRIAL_VERDICT_LABELS_ZH[/** @type {keyof typeof VCR_TRIAL_VERDICT_LABELS_ZH} */ (pair.verdict)],
      fit: pair.fit, fitLevel: level, fitLabel: level ? VCR_MATCH_FIT_LEVEL_LABELS_ZH[level] : null,
      confidence: pair.confidence, confidenceLabel: confidence ? VCR_MATCH_CONFIDENCE_LABELS_ZH[confidence] : null,
      why: pair.readable === false ? (pair.counts ? `满足 ${pair.counts.support} 条，待查 ${pair.counts.open} 条` : "") : pair.why, ...(pair.readable === false ? { reasonsWithheld: pair.withheldNote } : {}),
      counts: pair.counts ? { support: pair.counts.support, against: pair.counts.against, silent: pair.counts.silent, open: pair.counts.open, notApplicable: pair.counts.notApplicable } : null,
      judgedAt: pair.judgedAt, producer: pair.producer === "conversation" ? "conversation" : "job", ...(pair.basisChanged ? { basisChanged: pair.basisChanged } : {}),
      ...(pair.eligibilitySource === "none" ? { eligibilityNote: VCR_MATCH_NO_ELIGIBILITY_ZH } : {}), ...(pair.recordGap ? { recordGap: pair.recordGap } : {}), ...(clausesNoteOf(pair) ? { clausesNote: clausesNoteOf(pair) } : {}),
    };
  }

  /** @param {any} entry a failed pair */
  #failure(entry) {
    const protocol = entry.targetKind === "protocol_version";
    return { subjectKey: entry.subjectKey, label: entry.label ?? vcrSubjectLabel(entry.subjectKey), kind: protocol ? "protocol" : "registry", id: entry.targetId, registryId: protocol ? null : text(entry.target.registryId) ?? entry.targetId,
      title: text(entry.target.title), reason: vcrMatchFailureReason(entry.code), at: entry.at };
  }

  /**
   * Everything that failed in a scope: the pairs with nothing, then the pairs with a score whose clauses failed, which have a verdict and are still owed something.
   * @param {{ done: any[], failed: any[] }} pairs
   */
  #failures({ done, failed }) {
    const owed = done.filter((pair) => pair.clauseFailure && !pair.judgedByClauses).map((pair) => ({ ...this.#failure({ ...pair, code: pair.clauseFailure, at: pair.clauseFailedAt }), reason: `逐条判定没有完成：${vcrMatchFailureReason(pair.clauseFailure)}`, clausesOnly: true }));
    const refailed = done.filter((pair) => pair.rejudgeFailure).map((pair) => ({ ...this.#failure({ ...pair, code: pair.rejudgeFailure.code, at: pair.rejudgeFailure.at }), reason: `重新判定没有完成：${vcrMatchFailureReason(pair.rejudgeFailure.code)}；仍显示上一次的结论`, verdictKept: true }));
    return [...failed.map((entry) => this.#failure(entry)), ...owed, ...refailed];
  }

  /**
   * What was asked, what is done and what it cost, from the study's judging jobs and the rows they left.
   * @param {string} studyId @param {{ direction: 'patient_to_trial' | 'trial_to_patient', subjectKey?: string | null, protocolVersionId?: string | null }} scope
   * @param {{ done: any[], failed: any[] }} pairs
   */
  async #progress(studyId, { direction, subjectKey = null, protocolVersionId = null }, { done, failed }) {
    const jobs = await this.judgments.jobsOf({ studyId, direction, subjectKey, protocolVersionId, limit: JOBS_READ });
    const withdrawn = direction === "trial_to_patient" ? new Set((await this.rows(`SELECT subject_key FROM ${S}.subject_withdrawals WHERE study_id = $1`, [studyId])).map((row) => String(row.subject_key))) : new Set();
    const { latest, running: _running, ...standing } = judgingProgress({ direction, jobs, done, failed, withdrawn });
    // What the judging of this scope has cost, every job of it and not only the newest (a continuation is a job of its own): for each job what it says it spent — every call, the ones whose
    // row a later try replaced and the ones that wrote no row — or, when it kept no account, what its rows say. The ceiling below is the newest job's own.
    const jobIds = jobs.map((job) => String(job.id));
    const [rowCosts, accounted] = jobIds.length ? await Promise.all([
      this.rows(`SELECT job_id, sum(NULLIF(usage ->> 'cost', '')::numeric)::float AS cost FROM ${S}.match_judgments WHERE study_id = $1 AND job_id = ANY($2::text[]) GROUP BY job_id`, [studyId, jobIds]),
      this.rows(`SELECT DISTINCT ON (e.job_id) e.job_id, (r.diagnostics #>> '{used,cost}')::float AS accounted FROM ${S}.results r JOIN ${S}.executions e ON e.id = r.execution_id
        WHERE e.job_id = ANY($1::text[]) ORDER BY e.job_id, r.created_at DESC`, [jobIds]),
    ]) : [[], []];
    const fromRows = new Map(rowCosts.map((row) => [String(row.job_id), row.cost]));
    const fromAccount = new Map(accounted.map((row) => [String(row.job_id), row.accounted]));
    const perJob = jobs.map((job) => [fromAccount.get(String(job.id)), job.carried_cost, fromRows.get(String(job.id))].filter((value) => value != null && Number.isFinite(Number(value))).map(Number)).filter((amounts) => amounts.length).map((amounts) => Math.max(...amounts));
    const spentAmounts = perJob.length ? [perJob.reduce((sum, value) => sum + value, 0)] : [];
    const estimate = object(object(latest?.scenario).estimate);
    return {
      ...standing,
      jobId: latest ? String(latest.id) : null, startedAt: latest ? iso(latest.created_at) : null,
      cost: latest ? { ceiling: estimate.cost == null || !Number.isFinite(Number(estimate.cost)) ? null : Number(estimate.cost), spent: spentAmounts.length ? Math.max(...spentAmounts) : null, currency: String(estimate.currency ?? "CNY") } : null,
      // How the latest job was set; the continue action starts what `left` names under these.
      settings: latest ? pick(object(latest.scenario), ["fit", "topK", "thinking", "thinkingCriteria", "collection", "collectionRevision"]) : {},
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

  /**
   * Where the page should open when it is asked for nothing in particular: the newest thing worked on, or the newest of one direction.
   * @param {string} studyId @param {'patient_to_trial' | 'trial_to_patient' | null} [only]
   */
  async latest(studyId, only = null) {
    const kind = only === "patient_to_trial" ? "candidate_trial" : only === "trial_to_patient" ? "protocol_version" : null;
    const row = await this.one(`SELECT * FROM (
        SELECT j.subject_key, j.target_kind, j.target_id, j.updated_at FROM ${S}.match_judgments j WHERE j.study_id = $1 AND ${NOT_WITHDRAWN}
        UNION ALL
        SELECT CASE WHEN scenario ->> 'direction' = 'patient_to_trial' THEN scenario -> 'subjects' ->> 0 END, CASE WHEN scenario ->> 'direction' = 'patient_to_trial' THEN 'candidate_trial' ELSE 'protocol_version' END,
          scenario ->> 'protocolVersionId', created_at FROM ${S}.jobs WHERE study_id = $1 AND kind = 'match_judge'
          AND NOT (scenario ->> 'direction' = 'patient_to_trial' AND scenario -> 'subjects' ->> 0 = '${WITHDRAWN_SUBJECT_MARK}')) newest
      WHERE ($2::text IS NULL OR target_kind = $2) ORDER BY updated_at DESC LIMIT 1`, [studyId, kind]);
    if (!row) return null;
    return row.target_kind === "candidate_trial" ? { direction: "patient_to_trial", subjectKey: String(row.subject_key) } : { direction: "trial_to_patient", protocolVersionId: String(row.target_id) };
  }

  /**
   * One person's trials: the list in the platform's order, what is done of what was asked, the failures and the chosen trial opened.
   * @param {any} study @param {string} subjectKey @param {{ target?: string | null, viewer?: { id: string } | null }} [options]
   */
  async forPatient(study, subjectKey, { target = null, viewer = null } = {}) {
    const pairs = await this.#pairs(study.id, { subjectKey });
    const { left: _left, settings: _settings, waitingIds: _waitingIds, ...progress } = await this.#progress(study.id, { direction: "patient_to_trial", subjectKey }, pairs);
    const ranked = rankJudgments(pairs.done.map((pair) => ({ ...pair, id: pair.targetId, criteria: pair.counts && pair.counts.against > 0 ? [{ label: "excluded", basis: "stated" }] : [] })));
    await this.#judgeReaders(study, viewer, ranked);
    const trials = ranked.map((pair, index) => ({ rank: index + 1, ...this.#listed(pair) }));
    const failures = this.#failures(pairs);
    const search = searchLineOf(await this.searches?.latest?.(study, { subjectKey }).catch(() => null) ?? null);
    const chosen = ranked.find((pair) => pair.targetId === target) ?? ranked[0] ?? null;
    // The trials whose verdict rests on a registry record that has changed since: the page offers to judge those again, and says so in words.
    const stale = ranked.filter((pair) => pair.basisChanged?.kind === REGISTRY_RECORD_BASIS).map((pair) => String(pair.targetId));
    return {
      direction: "patient_to_trial", subjectKey, label: pairs.done[0]?.label ?? pairs.failed[0]?.label ?? vcrSubjectLabel(subjectKey), ...(pairs.cut ? { cutNote: CUT_NOTE_ZH(this.mostPairs) } : {}),
      ...(search ? { search } : {}),
      ...(stale.length ? { stale: { label: REGISTRY_STALE_LABEL_ZH, count: stale.length, registryIds: stale.slice(0, 50) } } : {}),
      held: pairs.done.length > 0 || pairs.failed.length > 0 || progress.total > 0, progress,
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
    const { left: _left, settings: _settings, waitingIds: _waitingIds, ...progress } = await this.#progress(study.id, { direction: "trial_to_patient", protocolVersionId }, pairs);
    /** @type {Record<string, number>} */
    const tallies = Object.fromEntries(VERDICTS.map((name) => [name, 0]));
    for (const pair of pairs.done) tallies[pair.verdict] += 1;
    const fitOf = (/** @type {any} */ pair) => (Number.isFinite(pair.fit) ? Number(pair.fit) : -1);
    const ordered = pairs.done.filter((pair) => !verdict || pair.verdict === verdict).sort((a, b) =>
      VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict) || fitOf(b) - fitOf(a) || (b.confidence ?? -1) - (a.confidence ?? -1) || (a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : 0));
    const start = Math.max(0, Math.floor(offset));
    const size = Math.max(1, Math.min(MATCH_PAGE.most, Math.floor(limit)));
    const chosen = subjectKey ? pairs.done.find((pair) => pair.subjectKey === subjectKey) ?? null : null;
    const failures = this.#failures(pairs);
    const exact = String(study.userId) === String(viewer?.id ?? "");
    const shownTallies = exact ? tallies : hideSmall(tallies, VERDICTS, this.minCell);
    // Someone with no patient-level access sees the verdicts of groups large enough to show.
    let inList = ordered;
    let opened = chosen;
    if (!exact && this.documents?.judgeReads) {
      const { patientLevel } = await this.documents.judgeReads(study, viewer, []);
      if (!patientLevel) {
        inList = ordered.filter((pair) => /** @type {any} */ (shownTallies)[pair.verdict] !== null);
        // Asking for a person by key is not a way round the rule: a person in a group too small to show is not opened.
        if (opened && /** @type {any} */ (shownTallies)[opened.verdict] === null) opened = null;
      }
    }
    const page = inList.slice(start, start + size);
    await this.#judgeReaders(study, viewer, opened && !page.includes(opened) ? [...page, opened] : page);
    const funnel = await this.#funnel(study.id, protocolVersionId);
    const failedSummary = this.#failureSummary(failures);
    return {
      direction: "trial_to_patient", protocolVersionId, ...(pairs.cut ? { cutNote: CUT_NOTE_ZH(this.mostPairs) } : {}), held: pairs.done.length > 0 || pairs.failed.length > 0 || progress.total > 0,
      progress: exact ? progress : { ...progress, total: hideAlone(progress.total, this.minCell), finished: hideAlone(progress.finished, this.minCell), failed: hideAlone(progress.failed, this.minCell), waiting: hideAlone(progress.waiting, this.minCell),
        clauses: { wanted: hideAlone(progress.clauses.wanted, this.minCell), done: hideAlone(progress.clauses.done, this.minCell), left: hideAlone(progress.clauses.left, this.minCell) } }, tallies: shownTallies,
      people: page.map((pair) => this.#listed(pair)), total: exact ? inList.length : hideAlone(inList.length, this.minCell), offset: start, limit: size, more: inList.length > start + size,
      clauses: exact ? funnel : { judgedPeople: hideAlone(funnel.judgedPeople, this.minCell), rows: funnel.rows.map((row) => hideSmall(row, ["support", "against", "silent", "open", "notApplicable"], this.minCell)) },
      failed: exact ? failedSummary : { ...failedSummary, count: hideAlone(failedSummary.count, this.minCell), reasons: failedSummary.reasons.map((entry) => ({ ...entry, count: hideAlone(entry.count, this.minCell) })), listed: [] },
      changed: exact ? pairs.done.filter((pair) => pair.basisChanged).length : hideAlone(pairs.done.filter((pair) => pair.basisChanged).length, this.minCell),
      selected: opened ? await this.#open(study, opened, viewer) : null,
    };
  }

  /**
   * For each clause of a protocol version, how many of the people judged against it it satisfies, disqualifies, finds the record silent on or leaves open. Disqualified first.
   * @param {string} studyId @param {string} protocolVersionId
   */
  async #funnel(studyId, protocolVersionId) {
    // A person's clause row stands behind their verdict only while no score of the same pair read newer words after it (`standingRows`): an older clause row is history and is not counted.
    const newest = `WITH ranked AS (
        SELECT DISTINCT ON (j.subject_key) j.id, j.study_id, j.subject_key, j.target_kind, j.target_id, j.status, j.document_hash, j.target_hash, j.updated_at FROM ${S}.match_judgments j
        WHERE j.study_id = $1 AND j.target_kind = 'protocol_version' AND j.target_id = $2 AND j.mode = 'criteria' AND ${NOT_WITHDRAWN}
        ORDER BY j.subject_key, (j.status = 'done') DESC, j.updated_at DESC, j.id),
      scores AS (
        SELECT DISTINCT ON (f.subject_key) f.subject_key, f.document_hash, f.target_hash, f.updated_at FROM ${S}.match_judgments f
        WHERE f.study_id = $1 AND f.target_kind = 'protocol_version' AND f.target_id = $2 AND f.mode = 'fit' AND f.status = 'done'
        ORDER BY f.subject_key, f.updated_at DESC, f.id),
      newest AS (
        SELECT r.id FROM ranked r LEFT JOIN scores fit ON fit.subject_key = r.subject_key AND r.status = 'done'
        WHERE NOT (fit.updated_at IS NOT NULL AND fit.updated_at >= r.updated_at AND (fit.document_hash <> r.document_hash OR fit.target_hash <> r.target_hash)))`;
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
      number: Number(row.number), kind: kindOf(row.kind), clause: String(row.clause ?? ""),
      support: Number(row.support), against: Number(row.against), silent: Number(row.silent), open: Number(row.open), notApplicable: Number(row.not_applicable),
    }]));
    for (const row of unanswered) {
      const entry = byNumber.get(Number(row.number)) ?? { number: Number(row.number), kind: kindOf(row.kind), clause: String(row.clause ?? ""), support: 0, against: 0, silent: 0, open: 0, notApplicable: 0 };
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
    const previous = await this.#previousReading(study, pair, ids);
    // A reader with no patient-level access gets the verdict of the pair and no clause of it: a clause row states a fact about one person, and the list gives such a reader groups, not people.
    if (pair.readable === false && pair.patientLevel === false) return { ...this.#listed(pair), subjectKey: pair.subjectKey, groups: {}, summary: null, clauses: [], withheld: 0 };
    if (pair.readable === false) {
      const clauses = clauseRows(withoutWords(presentJudgment(fit, criteria)));
      return { ...this.#listed(pair), subjectKey: pair.subjectKey, groups: {}, summary: null, clauses, withheld: clauses.reduce((sum, clause) => sum + Number(/** @type {any} */ (clause).evidenceHidden ?? 0), 0), ...(previous ? { previous } : {}) };
    }
    const presented = await this.#viewed(study, presentJudgment(fit, criteria), viewer);
    const clauses = clauseRows(presented);
    const withheld = clauses.reduce((sum, clause) => sum + Number(/** @type {any} */ (clause).evidenceHidden ?? 0), 0);
    return {
      ...this.#listed(pair), subjectKey: pair.subjectKey, groups: reasonGroups(presented, clauses), summary: clip(text(presented.reasons?.rationale)),
      clauses, withheld, ...(withheld ? { evidenceNote: evidenceNoteZh(withheld) } : {}), ...(previous ? { previous } : {}),
    };
  }

  /**
   * The reading before the one in use, in one line: its verdict, the day, and that it read an earlier record. Null when the pair has been judged once. A label, from the saved rows alone.
   * @param {any} study @param {any} pair @param {readonly string[]} inUse
   */
  async #previousReading(study, pair, inUse) {
    try {
      const rows = await this.judgments.earlier(study.id, { subjectKey: pair.subjectKey, targetKind: pair.targetKind, targetId: pair.targetId, except: inUse });
      const newest = rows[0];
      if (!newest) return null;
      // The rows of that reading are the ones that read the same words as the newest of them.
      const same = rows.filter((/** @type {any} */ row) => row.documentHash === newest.documentHash && row.targetHash === newest.targetHash);
      const fit = same.find((/** @type {any} */ row) => row.mode === "fit") ?? null, criteria = same.find((/** @type {any} */ row) => row.mode === "criteria") ?? null;
      const shown = presentJudgment(fit, criteria);
      const sheetDay = shown.judgedAt ? String(shown.judgedAt).slice(0, 10) : null;
      const changedPart = newest.documentHash !== pair.documentHash ? "读的是更早的病历" : newest.targetHash !== pair.targetHash ? "读的是试验更早的登记内容" : "读的是更早的内容";
      return { verdict: shown.verdict, verdictLabel: shown.verdictLabel, judgedAt: shown.judgedAt, line: `上一次判定${sheetDay ? `（${sheetDay}）` : ""}：${shown.verdictLabel}，${changedPart}。` };
    } catch {
      return null;
    }
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
   * @param {any} study @param {{ format: 'csv' | 'json', kind: 'pairs' | 'clauses', direction: 'patient_to_trial' | 'trial_to_patient', subjectKey?: string | null, protocolVersionId?: string | null, viewer?: { id: string } | null }} request
   * @param {() => Date} [now]
   */
  async exporter(study, { format, kind, direction, subjectKey = null, protocolVersionId = null, viewer = null }, now = () => new Date()) {
    const scope = direction === "patient_to_trial" ? { subjectKey } : { targetKind: "protocol_version", targetId: protocolVersionId };
    const pairs = await this.#pairs(study.id, scope);
    const { left: _left, settings: _settings, waitingIds, ...progress } = await this.#progress(study.id, { direction, subjectKey, protocolVersionId }, pairs);
    const ordered = [...pairs.done].sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0));
    const exportedAt = now().toISOString();
    const stamp = exportedAt.slice(0, 10);
    const filename = `matching-${direction === "patient_to_trial" ? "patient" : "protocol"}-${kind}-${stamp}.${format}`;
    const header = ["患者", "对象", "登记号", "标题", "结论", "匹配度（0-100）", "匹配等级", "把握度", "满足", "不满足", "未见记载", "待查", "不适用", "理由", "判定方式", "判定时间", "依据已更新", "备注"];
    const clauseHeader = ["患者", "对象", "登记号", "标题", "结论", "条款编号", "类型", "条款原文", "判定", "有无原文依据", "理由", "依据句号", "依据原文"];
    const unfinished = progress.state !== "done" && progress.state !== "idle";
    const unfinishedNote = `判定没有做完：已判 ${progress.finished} / ${progress.total}${progress.failed ? `，${progress.failed} 个没判成` : ""}${progress.waiting ? `，${progress.waiting} 个还没判` : ""}。这个文件只含已判出的部分，没判的列在文件末尾。`;
    const noteOf = (/** @type {any} */ listed) => [listed.recordGap, listed.clausesNote, listed.eligibilityNote].filter(Boolean).join("；");
    // Pairs with no verdict, named as the page names them: the ones that failed with their reason, and the ones the job never reached.
    const missing = [
      ...pairs.failed.map((entry) => this.#failure(entry)),
      ...waitingIds.map((id) => (direction === "patient_to_trial" ? { label: null, kind: "registry", id, registryId: id, title: null, subjectKey: subjectKey ?? "", reason: "还没有判定", at: null } : { label: null, kind: "protocol", id: protocolVersionId, registryId: null, title: null, subjectKey: id, reason: "还没有判定", at: null })),
    ];
    const names = missing.length ? await this.#labels(study.id, missing.map((entry) => entry.subjectKey)) : new Map();
    for (const entry of missing) if (!entry.label) entry.label = names.get(entry.subjectKey) ?? vcrSubjectLabel(entry.subjectKey);
    const chunks = (/** @type {any[]} */ items) => { const out = []; for (let at = 0; at < items.length; at += EXPORT_CHUNK) out.push(items.slice(at, at + EXPORT_CHUNK)); return out; };
    const pairLine = (/** @type {any} */ pair) => {
      const listed = this.#listed(pair);
      return { listed, cells: [listed.label, listed.kind === "protocol" ? "本研究方案" : "登记试验", listed.registryId, listed.title, listed.verdictLabel, listed.fit, listed.fitLabel, listed.confidenceLabel,
        listed.counts?.support ?? null, listed.counts?.against ?? null, listed.counts?.silent ?? null, listed.counts?.open ?? null, listed.counts?.notApplicable ?? null, listed.why,
        listed.producer === "conversation" ? "对话中判定" : "批量判定", listed.judgedAt, listed.basisChanged ? "是" : "否", noteOf(listed)] };
    };
    /** @param {{ write: (chunk: string) => Promise<void> }} sink */
    const run = async (sink) => {
      if (format === "csv") await sink.write(`\uFEFF${csvLine(kind === "pairs" ? header : clauseHeader)}`);
      else await sink.write(`{"schema":"evimed-matching-export/1","direction":${JSON.stringify(direction)},"kind":${JSON.stringify(kind)},"exportedAt":${JSON.stringify(exportedAt)},"progress":${JSON.stringify({ state: progress.state, total: progress.total, finished: progress.finished, failed: progress.failed, waiting: progress.waiting, clausesLeft: progress.clauses.left })},"rows":[`);
      let first = true;
      for (const group of chunks(ordered)) {
        await this.#judgeReaders(study, viewer, group);
        const rows = new Map((await this.judgments.byIds(study.id, group.flatMap((pair) => [pair.fitRowId, pair.criteriaRowId].filter(Boolean)))).map((/** @type {any} */ row) => [row.id, row]));
        for (const pair of group) {
          const { listed, cells } = pairLine(pair);
          const fitRow = pair.fitRowId ? rows.get(pair.fitRowId) ?? null : null, criteriaRow = pair.criteriaRowId ? rows.get(pair.criteriaRowId) ?? null : null;
          if (!fitRow && !criteriaRow) continue;
          if (kind === "pairs") {
            if (format === "csv") await sink.write(csvLine(cells));
            else { await sink.write(`${first ? "" : ","}${JSON.stringify({ subjectKey: listed.subjectKey, label: listed.label, target: { kind: listed.kind, id: listed.id, registryId: listed.registryId, title: listed.title }, verdict: listed.verdict, fit: listed.fit, fitLevel: listed.fitLevel,
              confidence: listed.confidence, counts: listed.counts, reason: listed.why, ...(noteOf(listed) ? { note: noteOf(listed), recordGap: listed.recordGap ?? null, clausesNote: listed.clausesNote ?? null, eligibilityNote: listed.eligibilityNote ?? null } : {}), ...(listed.reasonsWithheld ? { reasonsWithheld: listed.reasonsWithheld } : {}), producer: listed.producer, judgedAt: listed.judgedAt, basisChanged: Boolean(listed.basisChanged) })}`); first = false; }
            continue;
          }
          // The same judgment as the page: a sentence is read back under this reader, and a reader who may not read the record gets the row without its words and a note saying so.
          const clauses = clauseRows(pair.readable === false ? withoutWords(presentJudgment(fitRow, criteriaRow)) : await this.#viewed(study, presentJudgment(fitRow, criteriaRow), viewer));
          for (const clause of clauses) {
            const sentences = clause.evidence;
            const hidden = Number(/** @type {any} */ (clause).evidenceHidden ?? 0);
            const note = pair.readable === false ? listed.reasonsWithheld : hidden ? evidenceNoteZh(hidden) : null;
            if (format === "csv") {
              await sink.write(csvLine([cells[0], cells[1], cells[2], cells[3], cells[4], clause.number, clause.kind === "exclusion" ? "排除" : clause.kind === "unsectioned" ? "未分节" : "入选", clause.clause, clause.display, sentences.length ? "有" : "无", pair.readable === false ? note : clause.reason,
                sentences.map((item) => item.sentenceId).join("、"), sentences.length ? sentences.map((item) => item.text).join(" | ") : note ?? ""]));
            } else {
              await sink.write(`${first ? "" : ","}${JSON.stringify({ subjectKey: listed.subjectKey, label: listed.label, target: { kind: listed.kind, id: listed.id, registryId: listed.registryId, title: listed.title }, verdict: listed.verdict,
                clause: { number: clause.number, kind: clause.kind, text: clause.clause, label: clause.label, basis: clause.basis, stance: clause.stance, display: clause.display, reason: clause.reason,
                  sentences: sentences.map((item) => ({ id: item.sentenceId, text: item.text })), ...(note ? { note } : {}) } })}`); first = false;
            }
          }
        }
      }
      // The pairs with no verdict are rows of the pair file too, so a file of a stopped job does not read as the whole set; the clause file says it in one line.
      if (kind === "pairs") {
        for (const entry of missing) {
          if (format === "csv") await sink.write(csvLine([entry.label, entry.kind === "protocol" ? "本研究方案" : "登记试验", entry.registryId, entry.title, "未判定", null, null, null, null, null, null, null, null, entry.reason, "", entry.at, "", ""]));
          else { await sink.write(`${first ? "" : ","}${JSON.stringify({ subjectKey: entry.subjectKey, label: entry.label, target: { kind: entry.kind, id: entry.id, registryId: entry.registryId, title: entry.title }, verdict: null, verdictLabel: "未判定", reason: entry.reason })}`); first = false; }
        }
      }
      // A file past what one read holds, or a job that stopped, ends by saying so.
      if (format === "csv") {
        if (pairs.cut) await sink.write(csvLine([CUT_NOTE_ZH(this.mostPairs)]));
        if (unfinished) await sink.write(csvLine([unfinishedNote]));
      }
      if (format === "json") await sink.write(`]${pairs.cut ? `,"cutNote":${JSON.stringify(CUT_NOTE_ZH(this.mostPairs))}` : ""}${unfinished ? `,"unfinishedNote":${JSON.stringify(unfinishedNote)}` : ""}}`);
    };
    return { filename, contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8", rows: ordered.length + (kind === "pairs" ? missing.length : 0), run };
  }
}

/** The stance words, for a caller that draws a funnel without importing the domain. */
export const STANCE_WORDS = VCR_MATCH_STANCE_LABELS_ZH;
