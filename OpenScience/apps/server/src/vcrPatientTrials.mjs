/**
 * 「给患者找试验」 — the patient → trials direction of 虚拟临床研究's matching.
 *
 * The study's own matching asks which patients fit one trial (its protocol). This is the other end of
 * the same evaluation: one patient, and the trials a registry lists that might take them. The run
 * (the vcr-matching capability) finds the trials and structures each one's eligibility text; the
 * platform stores them, evaluates the patient against each with the evaluator the other direction
 * uses, and ranks them. This file holds the parts of that which are exact operations.
 *
 * Hidden knowledge:
 *
 * - **What identifies a candidate trial is read from the registry's record, in code.** The run names a
 *   registry and an id; the title, phase, status, conditions, sites, link and the hash of the preserved
 *   record come from the record the registry client fetched, so a trial cannot be given a status or a
 *   site it does not have. The run's own work is the language: the criteria it makes of the eligibility
 *   text.
 * - **A site's people are not read.** A registry lists the staff to call at each site; a candidate keeps
 *   where a site is and whether it is recruiting, never who answers.
 * - **A candidate trial is not a version of the study's protocol.** It lives in its own tables, so the
 *   protocol list, the funnel, the referral ledger and every count of the study's own trial know nothing
 *   of it; the study's own protocol versions join a patient's ranked list at the read, not in storage.
 * - **The original wording stays findable.** A criterion keeps the sentence it was made from, and the
 *   platform looks that sentence up in the record's eligibility text (whitespace folded the way a record
 *   folds it) and keeps where it stands. A sentence that is not in the record is kept as it was written
 *   and is simply not located: nothing is refused for being a paraphrase, and nothing is guessed from a
 *   near match.
 *
 * @module vcrPatientTrials
 */

import { candidateCriteriaHash } from "./vcrCandidateTrialStore.mjs";
import { HttpError } from "./security.mjs";
import { CTGOV_STUDY_URL, CTIS_STUDY_URL } from "./trialRegistryClient.mjs";
import { VCR_MATCHING_GAP_REASON_LABELS_ZH } from "@evimed/domain";
import { VCR_MATCHING_VOCABULARY_VERSION, assessSubject, eligibilityCounts, summarizeEligibility, decidedShare, frozenAsOf, languageKeysOf, matchingInputDigest, statedRequirement } from "./vcrMatching.mjs";
import { matchingVariablesOf, subjectTableFacts } from "./vcrMatchingTable.mjs";
import { matchingAssessmentEvidence } from "./vcrMatchingEvidence.mjs";

/**
 * Sites kept on a candidate trial. A registry record can list hundreds; a patient's reader needs where
 * the trial runs and whether it is recruiting there, and the record's own total stays beside the list.
 */
export const CANDIDATE_TRIAL_LOCATIONS_MAX = 100;

/** The longest eligibility text kept with a trial (the registry client's own ceiling on a record). */
export const CANDIDATE_TRIAL_ELIGIBILITY_MAX = 100_000;

/** @param {unknown} value */
const text = (value) => String(value ?? "").trim();
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * The page of a trial on its registry, for a link a reader can open. Only an https address is a link:
 * what a registry sends in a `url` field is data from outside, and a `javascript:` address in an
 * anchor is not a link.
 * @param {string} registry @param {string} registryId @param {string} given what the registry's record said
 */
export function candidateTrialUrl(registry, registryId, given = "") {
  const id = text(registryId);
  if (registry === "clinicaltrials.gov" && id) return `${CTGOV_STUDY_URL}${encodeURIComponent(id)}`;
  if (registry === "ctis" && id) return `${CTIS_STUDY_URL}${encodeURIComponent(id)}`;
  const own = text(given);
  return /^https:\/\/[^\s]+$/i.test(own) ? own : "";
}

/**
 * A candidate trial's identity, from the record the registry client fetched (`{ precedent, record }`,
 * the registry client's own answer for ClinicalTrials.gov, ChiCTR and CTIS alike).
 * @param {{ precedent: any, record?: any }} built
 */
export function candidateTrialFromRecord({ precedent, record = null }) {
  const registry = text(precedent?.registry);
  const registryId = text(precedent?.registryId);
  const design = precedent?.design ?? {};
  const source = list(precedent?.sources)[0] ?? {};
  const raw = list(record?.reduced?.protocolSection?.contactsLocationsModule?.locations);
  const total = Number.isFinite(Number(precedent?.sites?.count)) && precedent?.sites?.count !== null ? Number(precedent.sites.count) : (raw.length || null);
  const eligibilityText = text(precedent?.eligibilityText).slice(0, CANDIDATE_TRIAL_ELIGIBILITY_MAX);
  return {
    registry,
    registryId,
    title: text(precedent?.title) || registryId,
    phase: list(design.phases).map(text).filter(Boolean).join("/"),
    status: text(design.overallStatus),
    conditions: list(precedent?.pico?.conditions).map(text).filter(Boolean).slice(0, 20),
    locations: {
      total,
      countries: list(precedent?.sites?.countries).map(text).filter(Boolean),
      // Where and whether recruiting; the contacts a record lists beside each site are never copied.
      sites: raw.slice(0, CANDIDATE_TRIAL_LOCATIONS_MAX).map((site) => ({
        facility: text(site?.facility), city: text(site?.city), state: text(site?.state), country: text(site?.country), status: text(site?.status),
      })),
    },
    url: candidateTrialUrl(registry, registryId, text(record?.url) || text(source.url)),
    collection: record?.collection ?? null,
    recordHash: text(record?.hash) || text(source.recordHash) || null,
    retrievedAt: text(precedent?.fetchedAt) || text(source.retrievedAt) || null,
    eligibilityText,
  };
}

/** Spellings of one character that the comparison of a quotation with its record treats as the same (each maps to its first key). */
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/u;
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u00B4`]/u;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033]/u;
const GREATER_EQUAL = /[\u2267\u2A7E]/u;
const LESS_EQUAL = /[\u2266\u2A7D]/u;

/**
 * A text in the form two spellings of the same words agree in, and for each character of that form the span of the original it
 * came from. Case, runs of whitespace (a no-break space is whitespace), width variants (NFKC), `>=` / `<=` against `≥` / `≤`, and the
 * dash and quotation-mark variants are folded; nothing else is, so this compares and never guesses.
 * @param {string} value
 * @returns {{ text: string, start: number[], end: number[] }}
 */
function foldedSourceText(value) {
  const source = String(value ?? "");
  /** @type {string[]} */
  const out = [];
  /** @type {number[]} */
  const start = [];
  /** @type {number[]} */
  const end = [];
  /** @param {string} piece @param {number} from @param {number} to */
  const emit = (piece, from, to) => { for (const char of piece) { out.push(char); start.push(from); end.push(to); } };
  let gap = null;
  let at = 0;
  while (at < source.length) {
    const code = source.codePointAt(at) ?? 0;
    const char = String.fromCodePoint(code);
    let next = at + char.length;
    if (/\s/u.test(char)) {
      while (next < source.length && /\s/u.test(source[next])) next += 1;
      if (out.length) gap = { from: at, to: next };
      at = next;
      continue;
    }
    if (gap) { emit(" ", gap.from, gap.to); gap = null; }
    if ((char === ">" || char === "<") && source[next] === "=") {
      next += 1;
      emit(char === ">" ? "\u2265" : "\u2264", at, next);
    } else if (GREATER_EQUAL.test(char)) emit("\u2265", at, next);
    else if (LESS_EQUAL.test(char)) emit("\u2264", at, next);
    else if (DASHES.test(char)) emit("-", at, next);
    else if (SINGLE_QUOTES.test(char)) emit("'", at, next);
    else if (DOUBLE_QUOTES.test(char)) emit("\"", at, next);
    else emit(char.normalize("NFKC").toLowerCase(), at, next);
    at = next;
  }
  return { text: out.join(""), start, end };
}

/** The list marker in front of a criterion's wording, which is the list's and not the wording's. */
const LIST_MARKER = /^(?:[*\-\u2022]|\d{1,3}[.)])\s+/u;

/**
 * Wording shorter than this is boilerplate that any two trials share ("Written informed consent", "Age >= 18 years"): finding it in
 * another trial's record says nothing about where the run took it from, so only wording of at least this many characters (in the
 * folded form of `foldedSourceText`) is ever attributed to another trial.
 */
export const OTHER_TRIAL_MIN_SOURCE_CHARS = 30;

/**
 * How many characters a criterion's wording is, as the comparison reads it.
 * @param {string} sourceText
 */
export function sourceTextLength(sourceText) {
  const folded = foldedSourceText(sourceText).text;
  return [...folded.replace(LIST_MARKER, "")].length;
}

/**
 * Where a criterion's original wording stands in the record's eligibility text: a list marker in front is
 * the list's and not the wording's, and the two sides are compared in the form `foldedSourceText` gives (case, whitespace, `>=`
 * against `≥`, dash and quotation-mark variants are the same), the answer being the span in the record's own characters.
 * `null` when the words are not there; a near match is not a match.
 * @param {string} sourceText @param {string} eligibilityText @returns {{ start: number, end: number } | null}
 */
export function locateSourceText(sourceText, eligibilityText) {
  const record = foldedSourceText(eligibilityText);
  if (!record.text) return null;
  const wording = foldedSourceText(sourceText).text;
  for (const candidate of [wording, wording.replace(LIST_MARKER, "")]) {
    if (!candidate) continue;
    const found = record.text.indexOf(candidate);
    if (found < 0) continue;
    return { start: record.start[found], end: record.end[found + candidate.length - 1] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Where a trial stands, and the order a patient's trials are listed in
// ---------------------------------------------------------------------------

/**
 * A registry's words for where a trial stands, as one closed table: how soon a patient could join (the rank — lower is sooner),
 * and the reader's word. ClinicalTrials.gov spells them `NOT_YET_RECRUITING`, ChiCTR `Not yet recruiting`, EU CTIS
 * `Authorised, recruitment pending`; a word is compared with its case and punctuation folded. A word this table does not know is
 * kept as the registry wrote it and ranked after what is open and before what is closed — it is not read as closed.
 */
const STATUS_TABLE = Object.freeze([
  // `zh` is a status the evidence API sends for ChiCTR as ChiCTR writes it: only the word its documented example shows. Any other Chinese
  // status is unknown to this table and is shown as it was written.
  { rank: 0, label: "招募中", words: ["recruiting", "authorisedrecruiting", "ongoingrecruiting"], zh: ["招募中"] },
  { rank: 1, label: "尚未开始招募", words: ["notyetrecruiting", "authorisedrecruitmentpending", "recruitmentpending"] },
  { rank: 2, label: "邀请入组", words: ["enrollingbyinvitation"] },
  { rank: 3, label: "进行中，不再招募", words: ["activenotrecruiting", "ongoingrecruitmentended", "ongoingnotrecruiting"] },
  { rank: 4, label: "状态未知", words: ["unknown", "unknownstatus"] },
  { rank: 6, label: "已暂停", words: ["suspended", "halted", "temporarilyhalted"] },
  { rank: 7, label: "已完成", words: ["completed", "ended"] },
  { rank: 8, label: "已终止", words: ["terminated", "prematurelyended", "earlyterminated"] },
  { rank: 9, label: "已撤回", words: ["withdrawn", "notauthorised", "revoked"] },
]);
/** The rank of a status the table does not know, and of a trial with none (the study's own protocol): after the open ones. */
const STATUS_OTHER_RANK = 4;

/** @param {unknown} status */
const statusEntry = (status) => {
  const given = text(status);
  const word = given.toLowerCase().replace(/[^a-z]/g, "");
  return STATUS_TABLE.find((entry) => (word && entry.words.includes(word)) || (/** @type {{ zh?: string[] }} */ (entry).zh ?? []).includes(given)) ?? null;
};

/** How soon a patient could join a trial in this status: lower is sooner. @param {unknown} status */
export function registryStatusRank(status) {
  return statusEntry(status)?.rank ?? STATUS_OTHER_RANK;
}

/**
 * Whether a registry status is one of a trial that is open or about to be (recruiting, not yet recruiting, by invitation): `true`, `false`
 * for the closed ones the table knows (not recruiting any more, suspended, completed, terminated, withdrawn), and `null` for a word it does
 * not know or an unstated status — which is unknown, not closed.
 * @param {unknown} status @returns {boolean | null}
 */
export function registryStatusOpen(status) {
  const entry = statusEntry(status);
  if (!entry || entry.label === "状态未知") return null;
  return entry.rank <= 2;
}

/** The reader's word for a registry status; a word the table does not know is shown as the registry wrote it. @param {unknown} status */
export function registryStatusLabel(status) {
  return statusEntry(status)?.label ?? text(status);
}

const PHASE_NUMERALS = Object.freeze(/** @type {Record<string, string>} */ ({ 1: "I", 2: "II", 3: "III", 4: "IV" }));

/**
 * A trial's phase in the reader's numerals: `PHASE2` is 「II 期」, `PHASE1/PHASE2` 「I/II 期」. A phase that is not
 * ClinicalTrials.gov's is shown as it was registered.
 * @param {unknown} phase
 */
export function phaseLabel(phase) {
  const raw = text(phase);
  if (!raw) return "";
  if (raw === "NA") return "不适用";
  if (raw === "EARLY_PHASE1") return "早期 I 期";
  const numbers = raw.split("/").map((part) => /^PHASE([1-4])$/.exec(text(part))?.[1] ?? null);
  return numbers.every(Boolean) ? `${numbers.map((number) => PHASE_NUMERALS[/** @type {string} */ (number)]).join("/")} 期` : raw;
}

/** @param {string} a @param {string} b */
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Rebuild eligibility from the full current criterion set. @param {any} assessment @param {any[]} criteria @param {any[]} judgments */
function effectiveAssessment(assessment, criteria, judgments) {
  if (!assessment) return null;
  const byId = new Map(judgments.map(j => [j.criterionId, j]));
  const complete = criteria.map(c => ({ ...(byId.get(c.id) ?? { state: "unknown", applicable: true }), kind: c.kind }));
  return { ...assessment, storedSummary: assessment.summary, summary: summarizeEligibility(complete), counts: eligibilityCounts(complete), judgments };
}

/** Score persisted normalized judgments; missing judgments remain unknown.
 * @param {readonly any[]} criteria @param {readonly any[]} judgments
 */
export function criterionRanking(criteria, judgments) {
  const byId = new Map(judgments.map(j => [String(j.criterionId), j]));
  const components = { inclusionSatisfied: 0, exclusionSatisfied: 0, decisiveFailures: 0, unknown: 0, pending: 0, notApplicable: 0, applicable: 0 };
  for (const criterion of criteria) {
    const judgment = byId.get(String(criterion.id));
    if (judgment?.applicable === false) { components.notApplicable++; continue; }
    components.applicable++;
    if (judgment?.state === "satisfied") {
      if (criterion.kind === "exclusion") components.exclusionSatisfied++;
      else components.inclusionSatisfied++;
    } else if (judgment?.state === "not_satisfied") components.decisiveFailures++;
    else if (judgment?.state === "pending_recheck") components.pending++;
    else components.unknown++;
  }
  const positive = components.inclusionSatisfied + components.exclusionSatisfied;
  return { version: "criterion-proportion-v1", ...components,
    score: components.applicable ? (positive - components.decisiveFailures) / components.applicable : 0 };
}

/**
 * A patient's trials in the order they are listed: every criterion met first; then the trials the patient is not excluded from, by the
 * versioned criterion score and then the share of their criteria that are decided (satisfied or not — an unknown or a date to wait for is undecided and stays in the
 * denominator), then by how many criteria that is, then by the fewest still to settle; the ones the patient is excluded from after those,
 * the same way; and a trial not yet evaluated last. Ties by where the trial stands in its registry (recruiting first), then its title,
 * then its id. Arithmetic over the evaluator's counts and nothing a model said, so the same verdicts are the same list in any order they
 * arrive.
 *
 * The score uses normalized criterion states, with unknowns in the denominator. It is not a probability. The share is why a trial with two parsed criteria and no answer does not stand above one with ten and seven answered (it used to,
 * on "the fewest still open"): how much of a trial was read is part of how far its verdict can be trusted. It does not make the list a
 * recommendation — 符合 says the stated criteria are met, not that the trial is worth the patient's time (M5).
 * @template {{ id: string, title?: string, status?: string, summary: string | null, counts?: Record<string, number> | null, ranking?: { score: number, unknown: number, pending: number, applicable: number, decisiveFailures: number } }} T
 * @param {readonly T[]} entries @returns {Array<T & { rank: number }>}
 */
export function rankPatientTrials(entries) {
  const tier = (/** @type {T} */ row) => (row.ranking?.decisiveFailures ? 2 : row.summary === "eligible" ? (row.ranking && (!row.ranking.applicable || row.ranking.unknown || row.ranking.pending) ? 1 : 0) : row.summary === "ineligible" ? 2 : row.summary ? 1 : 3);
  const open = (/** @type {T} */ row) => Number(row.counts?.unknown ?? 0) + Number(row.counts?.pending_recheck ?? 0);
  const settled = (/** @type {T} */ row) => decidedShare(row.counts);
  const ratio = (/** @type {T} */ row) => { const { decided, applicable } = settled(row); return applicable ? decided / applicable : 0; };
  const fold = (/** @type {unknown} */ value) => text(value).toLowerCase();
  return [...entries]
    .sort((a, b) => tier(a) - tier(b) || ((b.ranking?.score ?? 0) - (a.ranking?.score ?? 0)) || ratio(b) - ratio(a) || settled(b).decided - settled(a).decided || open(a) - open(b)
      || registryStatusRank(a.status) - registryStatusRank(b.status) || order(fold(a.title), fold(b.title)) || order(String(a.id), String(b.id)))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

/** Trials one runtime read lists at most (the module's page size for a read). */
const READ_PAGE = 50;

/** The reader's word for why a criterion is unknown (`VCR_MATCHING_GAP_REASON_LABELS_ZH`); a reason it has no word for is shown as its code. */
const GAP_LABELS = /** @type {Record<string, string>} */ (VCR_MATCHING_GAP_REASON_LABELS_ZH);

/** A criterion's wording cut for a list, whole characters. @param {unknown} sourceText @param {number} [max] */
const shortText = (sourceText, max = 80) => {
  const characters = [...text(sourceText).replace(/\s+/g, " ")];
  return characters.length > max ? `${characters.slice(0, max).join("")}…` : characters.join("");
};

/**
 * The criteria a verdict leaves unknown or waiting, each with the reason in the reader's words: what a delivered table needs beside the
 * counts, from the assessment's own gaps (which name the criteria they came from) and the trial's criteria. No patient text is in it.
 * @param {readonly any[]} gaps @param {readonly any[]} criteria
 */
function undecidedCriteria(gaps, criteria) {
  const byId = new Map(criteria.map((criterion) => [String(criterion.id), criterion]));
  /** @type {Map<string, { criterionId: string, ordinal: number, kind: string, text: string, reason: string, label: string }>} */
  const out = new Map();
  for (const gap of gaps ?? []) {
    for (const id of list(gap?.criterionIds).map(String)) {
      const criterion = byId.get(id);
      if (!criterion || out.has(id)) continue;
      const reason = text(gap.reason) || "not_recorded";
      out.set(id, { criterionId: id, ordinal: Number(criterion.ordinal), kind: String(criterion.kind), text: shortText(criterion.sourceText),
        reason, label: GAP_LABELS[reason] ?? reason });
    }
  }
  return [...out.values()].sort((a, b) => a.ordinal - b.ordinal);
}

/** The word for a study's own protocol version in a list of trials. @param {{ title?: string, version?: number }} protocol */
const protocolTitle = (protocol) => text(protocol.title) || `方案版本 ${protocol.version}`;

/**
 * A candidate trial as the run reads it: what it is and what it asks, never where a site's people are.
 * @param {any} trial @param {readonly any[]} criteria @param {{ withCriteria?: boolean }} [options]
 */
function trialForRun(trial, criteria, { withCriteria = false } = {}) {
  const located = criteria.filter(criterion => locateSourceText(criterion.sourceText, trial.eligibilityText)).length;
  return {
    id: trial.id, registry: trial.registry, registryId: trial.registryId, title: trial.title, phase: trial.phase, status: trial.status,
    conditions: trial.conditions, locations: { total: trial.locations?.total ?? null, countries: trial.locations?.countries ?? [] },
    url: trial.url, collection: trial.collection ?? null, recordHash: trial.recordHash, retrievedAt: trial.retrievedAt, updatedAt: trial.updatedAt,
    eligibilityCoverage: { status: !text(trial.eligibilityText) ? "unavailable" : located < criteria.length ? "partial" : "located",
      providedCriteria: criteria.length, locatedCriteria: located, criterionExtractionCompleteness: "unknown",
      // A record with no original wording (ChiCTR through the evidence API is a listing) gives a criterion nothing to rest on (M6).
      ...(text(trial.eligibilityText) ? {} : { note: `登记记录没有入排条件原文：这个试验的条件一律按未知算，原因是“${GAP_LABELS.criterion_source_unavailable}”，不会判成满足或不满足。` }) },
    criteria: withCriteria
      ? criteria.map((criterion) => ({
        id: criterion.id, ordinal: criterion.ordinal, kind: criterion.kind, criterionType: criterion.criterionType,
        // An exclusion reads back as written: the condition that excludes (`statedRequirement`).
        sourceText: criterion.sourceText, requirement: statedRequirement(criterion), applicability: criterion.applicability,
        sourceLocator: criterion.sourceLocator, sourceVerified: Boolean(locateSourceText(criterion.sourceText, trial.eligibilityText)),
        languageKeys: languageKeysOf(criterion.requirement, criterion.id),
      }))
      : criteria.length,
  };
}

/**
 * One line of a patient's list: a registry trial, or a version of the study's own protocol, with the verdict about this patient (`null`
 * until one has been made).
 * @param {{ kind: "registry" | "protocol", id: string, title: string, status?: string, phase?: string, registry?: string | null, registryId?: string | null,
 *   url?: string, conditions?: readonly string[], locations?: any, collection?: any, retrievedAt?:string|null }} about @param {any} assessment
 */
function listed(about, assessment) {
  return {
    kind: about.kind, id: about.id, title: about.title, status: about.status ?? "", phase: about.phase ?? "",
    registry: about.registry ?? null, registryId: about.registryId ?? null, url: about.url ?? "",
    retrievedAt: about.retrievedAt ?? null, collection: about.collection ?? null,
    conditions: [...(about.conditions ?? [])], locations: about.locations ?? null,
    summary: assessment ? String(assessment.summary) : null,
    counts: assessment ? assessment.counts ?? {} : null,
    evidenceGaps: assessment ? assessment.evidenceGaps ?? [] : [],
    assessmentId: assessment ? String(assessment.id) : null,
    asOf: assessment?.asOf ? new Date(assessment.asOf).toISOString() : null,
  };
}

/**
 * The seam the gateway, the service and the orchestrator reach 「给患者找试验」 through: writing a candidate trial, judging a patient against
 * the trials, listing a patient's trials in order, and what a run may read of them. Built from the stores and the configuration, so the
 * module composes one object and the readers hold no store.
 *
 * The judging is the one the other direction runs — `assessSubject`, the same three-valued evaluator — over the facts the study holds
 * about the patient (a run's located facts, and the cells of the study's subject table), the answers a run gave to the trial's language
 * criteria, and the trial's criteria. It is exact and cheap, so it is done when its inputs are written rather than queued: a trial is
 * judged for the patients it is written for, and a trial whose criteria changed is judged again for every patient who had a verdict.
 *
 * @param {{ candidateStore: import("./vcrCandidateTrialStore.mjs").VcrCandidateTrialStore, matchStore?: any,
 *   documents?: { read: (study: any, input: { subjectKey: string, documentId: string }) => Promise<{ text: string } | null> } | null,
 *   subjectTable?: { read: (study: any) => Promise<any> } | null, config?: Record<string, any>, report?: (code: string) => void,
 *   now?: () => Date }} parts
 */
export function createPatientTrials({ candidateStore, matchStore = null, documents = null, subjectTable = null, config = {}, report = () => {}, now = () => new Date() }) {
  /** What the seam did since this process started (`open_science_vcr_patient_trials_total`). */
  const counters = { written: 0, updated: 0, refused: 0, capReached: 0, evaluated: 0, evaluationFailed: 0, searches: 0, parsedReused: 0, parsedKept: 0 };
  /** The most candidate trials one study holds: each costs an evaluation per patient. */
  const max = () => (Number(config.vcrCandidateTrialsMax) > 0 ? Number(config.vcrCandidateTrialsMax) : 60);

  /**
   * The table of the study's patients, once for a whole evaluation. A table that cannot be read is a note on the answer and nothing else:
   * the criteria that needed it read as unknown.
   * @param {any} study @param {Array<{ code: string }>} notes
   */
  async function readTable(study, notes) {
    if (!subjectTable) return null;
    try {
      const table = await subjectTable.read(study);
      if (table?.available) return table;
      notes.push({ code: String(table?.reason ?? "vcr_subject_table_unreadable") });
    } catch (error) {
      notes.push({ code: String(/** @type {any} */ (error)?.code ?? "vcr_subject_table_unreadable") });
    }
    return null;
  }

  const self = {
    counters,

    /** Whether the study already holds this trial, by its registry and registry id or by its own id. @param {any} study @param {{ id?: string, registry?: string, registryId?: string }} key */
    async holds(study, { id, registry, registryId }) {
      return Boolean(await candidateStore.getCandidateTrial({ studyId: study.id, ...(id ? { id } : { registry: registry ?? null, registryId: registryId ?? null }) }));
    },

    /**
     * The study's other candidate trials with the eligibility text each was saved from: where a criterion that is not in this trial's
     * record may have been taken from (`candidate_trial` refuses a trial whose criterion stands word for word in one of these).
     * @param {any} study @param {{ registry?: string | null, registryId: string }} key the trial being written, which is not its own other
     * @returns {Promise<Array<{ id: string, registry: string, registryId: string, title: string, eligibilityText: string }>>}
     */
    async otherTrials(study, { registry = null, registryId }) {
      const held = await candidateStore.listCandidateTrials({ studyId: study.id, limit: 1000 });
      return held.filter((trial) => !(trial.registryId === registryId && (!registry || trial.registry === registry)))
        .map((trial) => ({ id: trial.id, registry: trial.registry, registryId: trial.registryId, title: trial.title, eligibilityText: trial.eligibilityText }));
    },

    /**
     * Judge patients against the study's candidate trials (every one, or the `trialIds` named) as of one instant. A pair that cannot be
     * judged is named in `unavailable` with its code and the others stand (principle 19); a table that cannot be read is a `note`.
     * @param {any} study @param {{ subjectKeys: readonly string[], trialIds?: readonly string[] | null, asOf?: string | null }} input
     * @returns {Promise<{ evaluated: Array<Record<string, any>>, unavailable: Array<Record<string, any>>, notes: Array<{ code: string }> }>}
     */
    async evaluate(study, { subjectKeys, trialIds = null, asOf = null }) {
      /** @type {Array<Record<string, any>>} */
      const evaluated = [];
      /** @type {Array<Record<string, any>>} */
      const unavailable = [];
      /** @type {Array<{ code: string }>} */
      const notes = [];
      const subjects = [...new Set(subjectKeys.map(String))];
      const held = (await candidateStore.listCandidateTrials({ studyId: study.id, limit: 1000 })).filter((trial) => !trialIds || trialIds.includes(trial.id));
      const criteriaOf = await candidateStore.criteriaOfTrials(study.id, held.map((trial) => trial.id));
      // A trial with no criteria has nothing to judge a patient against.
      const trials = held.filter((trial) => (criteriaOf.get(trial.id) ?? []).length > 0);
      if (!subjects.length || !trials.length) return { evaluated, unavailable, notes };
      const at = frozenAsOf(asOf ?? now().toISOString());
      const table = await readTable(study, notes);
      const variables = matchingVariablesOf(trials.flatMap((trial) => criteriaOf.get(trial.id) ?? []));
      const keyAt = table ? table.header.indexOf("USUBJID") : -1;

      for (const subjectKey of subjects) {
        /** @type {any[]} */
        let facts;
        try {
          facts = [...(await matchStore.listFacts({ studyId: study.id, subjectKey, visibleBy: at }))];
          if (table && keyAt >= 0) {
            const mine = subjectTableFacts({ ...table, rows: table.rows.filter((/** @type {string[]} */ row) => String(row[keyAt] ?? "").trim() === subjectKey), variables })
              .subjects[0]?.facts ?? [];
            facts.push(...mine);
          }
        } catch (error) {
          for (const trial of trials) {
            counters.evaluationFailed += 1;
            unavailable.push({ trialId: trial.id, registryId: trial.registryId, subjectKey, code: String(/** @type {any} */ (error)?.code ?? "vcr_evaluation_failed") });
          }
          report(String(/** @type {any} */ (error)?.code ?? "vcr_evaluation_failed"));
          continue;
        }
        /** The patient's documents as the evaluator re-reads them, loaded once for all the trials. @type {Map<string, { text: string } | null>} */
        const loaded = new Map();
        /** @param {Iterable<string>} ids */
        const documentsOf = async (ids) => {
          /** @type {Record<string, { text: string }>} */
          const found = {};
          for (const documentId of ids) {
            if (!documents || !documentId) continue;
            if (!loaded.has(documentId)) loaded.set(documentId, await documents.read(study, { subjectKey, documentId }).catch(() => null));
            const document = loaded.get(documentId);
            if (document) found[documentId] = { text: document.text };
          }
          return found;
        };
        for (const trial of trials) {
          try {
            const criteria = criteriaOf.get(trial.id) ?? [];
            if (candidateCriteriaHash(criteria) !== trial.criteriaHash) throw new HttpError(409, "vcr_write_refused", "Trial criteria changed during evaluation; evaluate again.");
            const unlocated = new Set(criteria.filter(criterion => !locateSourceText(criterion.sourceText, trial.eligibilityText)).map(criterion => criterion.id));
            const checkedCriteria = criteria.map(criterion => unlocated.has(criterion.id) ? { ...criterion, applicability: null,
              requirement: { op: "language", key: `unavailable-source:${criterion.id}`, text: "Original trial criterion text is unavailable." } } : criterion);
            const language = await candidateStore.latestLanguageJudgments({ studyId: study.id, candidateTrialId: trial.id, subjectKey, visibleBy: at });
            const documentIds = new Set([
              ...facts.map((fact) => String(fact.source?.documentId ?? "")),
              ...Object.values(language).flatMap((entry) => list(entry?.evidence).map((item) => String(item?.documentId ?? ""))),
            ].filter(Boolean));
            const inputSnapshotId = matchingInputDigest({
              kind: "candidate_trial", candidateTrialId: trial.id, criteriaHash: trial.criteriaHash, recordHash: trial.recordHash, subjectKey,
              facts: facts.map((fact) => [fact.id, matchingInputDigest(fact)]).sort(), languages: Object.values(language).map((entry) => entry.id).sort(),
            });
            const assessment = assessSubject({
              studyId: study.id, protocolVersionId: null, subjectKey, asOf: at, direction: "patient_to_trial", criteria: checkedCriteria, facts,
              documents: await documentsOf(documentIds), modelJudgments: language,
              provenance: { vocabularyVersion: VCR_MATCHING_VOCABULARY_VERSION, inputSnapshotId },
            });
            for (const judgment of assessment.judgments) if (unlocated.has(judgment.criterionId)) {
              judgment.decidedBy = "code";
              judgment.missing = [{ variable: judgment.criterionId, reason: "criterion_source_unavailable" }];
            }
            assessment.evidenceGaps = [...assessment.evidenceGaps.filter(gap => !gap.criterionIds.some(id => unlocated.has(id))),
              ...[...unlocated].map(id => ({ variable: id, reason: "criterion_source_unavailable", criterionIds: [id] }))];
            const saved = await candidateStore.saveAssessment({
              userId: study.userId, expectedRecordHash: trial.recordHash, expectedCriteriaHash: trial.criteriaHash,
              assessment: {
                studyId: study.id, candidateTrialId: trial.id, subjectKey, asOf: assessment.asOf, summary: assessment.summary,
                counts: { ...assessment.counts, voidedFacts: assessment.voidedFacts.length }, evidenceGaps: assessment.evidenceGaps,
                judgments: assessment.judgments,
                provenance: { ...assessment.provenance, direction: "patient_to_trial", candidateTrialId: trial.id, recordHash: trial.recordHash },
              },
            });
            counters.evaluated += 1;
            evaluated.push({ trialId: trial.id, registryId: trial.registryId, subjectKey, summary: assessment.summary, counts: assessment.counts, assessmentId: saved.id });
          } catch (error) {
            counters.evaluationFailed += 1;
            const code = String(/** @type {any} */ (error)?.code ?? "vcr_evaluation_failed");
            report(code);
            unavailable.push({ trialId: trial.id, registryId: trial.registryId, subjectKey, code });
          }
        }
      }
      return { evaluated, unavailable, notes };
    },

    /**
     * Write one candidate trial with its criteria (`criteria: null` keeps what it has) and judge the patients named — and, when the criteria
     * changed, every patient who had a verdict about the old ones, whose verdicts the store has just removed.
     * @param {any} study @param {{ trial: Record<string, any>, criteria: readonly any[] | null, subjectKeys?: readonly string[] }} input
     */
    async writeTrial(study, { trial, criteria, subjectKeys = [] }) {
      let saved;
      try {
        saved = await candidateStore.saveCandidateTrial({ studyId: study.id, userId: study.userId, trial, criteria, max: max() });
      } catch (error) {
        counters.refused += 1;
        if (error instanceof HttpError && error.status === 409) counters.capReached += 1;
        else report(String(/** @type {any} */ (error)?.code ?? "vcr_write_refused"));
        throw error;
      }
      if (saved.created) counters.written += 1; else counters.updated += 1;
      // The parse is kept for the account against the record it was made from, so the next study that meets this record reads it. A parse
      // that cannot be kept costs the next study a parse and this one nothing.
      if (criteria !== null && trial.recordHash) {
        try {
          if (await candidateStore.saveParsedCriteria({ userId: study.userId, registry: trial.registry, registryId: trial.registryId, recordHash: trial.recordHash, criteria })) counters.parsedKept += 1;
        } catch (error) { report(String(/** @type {any} */ (error)?.code ?? "vcr_parsed_criteria_unsaved")); }
      }
      const who = [...new Set([...subjectKeys, ...(saved.criteriaChanged ? saved.reassess : [])])];
      const evaluation = who.length ? await self.evaluate(study, { subjectKeys: who, trialIds: [saved.trial.id] }) : { evaluated: [], unavailable: [], notes: [] };
      return { ...saved, evaluation };
    },

    /** A criterion of one of the study's candidate trials, by id (the words a long record is searched for it with, M4). @param {any} study @param {string} id */
    async criterionById(study, id) {
      return candidateStore.getCriterion({ studyId: study.id, id });
    },

    /**
     * The account's earlier parse of this trial, made from this very record (same registry id, same record hash): what a second study
     * of the same account reads instead of asking for the parse again. `null` when there is none or the record has changed since — the
     * run then structures the text again. Never another account's.
     * @param {any} study @param {{ registry: string, registryId: string, recordHash: string | null }} key
     * @returns {Promise<any[] | null>}
     */
    async parsedCriteria(study, { registry, registryId, recordHash }) {
      if (!recordHash) return null;
      try {
        const held = await candidateStore.parsedCriteriaFor({ userId: study.userId, registry, registryId, recordHash });
        if (held) counters.parsedReused += 1;
        return held?.criteria ?? null;
      } catch (error) {
        report(String(/** @type {any} */ (error)?.code ?? "vcr_parsed_criteria_unreadable"));
        return null;
      }
    },

    /**
     * Which of these registry trials the account has already parsed, whatever record the parse came from: a candidate list says so and the
     * write finds out whether the record is still the same one.
     * @param {any} study @param {ReadonlyArray<{ registry: string, registryId: string }>} trials @returns {Promise<Set<string>>}
     */
    async parsedHeld(study, trials) {
      try { return await candidateStore.parsedCriteriaHeld({ userId: study.userId, trials }); }
      catch { return new Set(); }
    },

    /** The language keys of a candidate trial's criteria. @param {any} study @param {string} candidateTrialId */
    async languageKeys(study, candidateTrialId) {
      const trial = await candidateStore.getCandidateTrial({ studyId: study.id, id: candidateTrialId });
      if (!trial) return [];
      const criteria = await candidateStore.listCriteria(trial.id);
      return [...new Set(criteria.flatMap((criterion) => languageKeysOf(criterion.requirement, criterion.id)))];
    },

    /**
     * A run's answer to one language criterion of a candidate trial.
     * @param {any} study @param {{ subjectKey: string, candidateTrialId: string, criterionKey: string, state: string, evidence: readonly any[], provenance?: any }} input
     */
    async saveLanguageJudgment(study, input) {
      return candidateStore.saveLanguageJudgment({ studyId: study.id, userId: study.userId, ...input });
    },

    /**
     * A patient's trials in order: every candidate trial of the study and every version of the study's own protocol that has judged this
     * patient, each with its verdict, ranked by `rankPatientTrials`. A trial that has not judged this patient is not in it — it is not a
     * result about them — and is named by `unjudged`.
     * @param {any} study @param {{ subjectKey: string }} input @returns {Promise<any[]>}
     */
    async ranked(study, { subjectKey }) {
      const snapshot = await candidateStore.rankingSnapshot(study.id, subjectKey);
      const verdicts = new Map(snapshot.assessments.map(a => [a.candidateTrialId, a]));
      const entries = snapshot.trials.filter(trial => verdicts.has(trial.id)).map(trial => listed({
        kind: "registry", id: trial.id, title: trial.title, status: trial.status, phase: trial.phase, registry: trial.registry,
        registryId: trial.registryId, url: trial.url, conditions: trial.conditions, locations: trial.locations,
        retrievedAt: trial.retrievedAt, collection: trial.collection,
      }, verdicts.get(trial.id)));
      const protocols = matchStore ? await matchStore.protocols(study.id) : [];
      const [criteriaByTrial, candidateJudgments, protocolVerdicts, protocolCriteria] = await Promise.all([
        new Map(snapshot.trials.map(trial => [trial.id, snapshot.criteria.filter(c => c.candidateTrialId === trial.id)])),
        snapshot.judgments,
        matchStore ? matchStore.latestAssessmentsByProtocol(study.id, subjectKey) : new Map(),
        matchStore ? matchStore.criteriaOfProtocols(study.id, protocols.map(protocol => protocol.id)) : [],
      ]);
      const protocolEntries = protocols.flatMap(protocol => {
        const verdict = protocolVerdicts.get(protocol.id);
        return verdict ? [listed({ kind: "protocol", id: protocol.id, title: protocolTitle(protocol) }, verdict)] : [];
      });
      const protocolJudgments = matchStore ? await matchStore.judgmentsForAssessments(study.id, protocolEntries.map(row => row.assessmentId).filter(Boolean)) : [];
      /** @param {any[]} judgments */
      const groupJudgments = (judgments) => {
        const grouped = new Map();
        for (const judgment of judgments) {
          if (!judgment) continue;
          const group = grouped.get(judgment.assessmentId) ?? [];
          group.push(judgment); grouped.set(judgment.assessmentId, group);
        }
        return grouped;
      };
      const candidateGroups = groupJudgments(candidateJudgments);
      const protocolGroups = groupJudgments(protocolJudgments);
      /** @param {any} row @param {any[]} criteria @param {any[]} judgments */
      const applyJudgments = (row, criteria, judgments) => {
        const effective = effectiveAssessment(row, criteria, judgments);
        row.storedSummary = effective.storedSummary;
        row.summary = effective.summary;
        row.counts = effective.counts;
        row.ranking = criterionRanking(criteria, judgments);
      };
      for (const row of entries) {
        const criteria = criteriaByTrial.get(row.id) ?? [];
        const judgments = candidateGroups.get(row.assessmentId) ?? [];
        applyJudgments(row, criteria, judgments);
        row.snapshotHash = matchingInputDigest({ criteria, judgments: judgments.map(j => [j.criterionId, j.state, j.applicable]).sort() });
      }
      for (const row of protocolEntries) applyJudgments(row, protocolCriteria.filter(c => c?.protocolVersionId === row.id), protocolGroups.get(row.assessmentId) ?? []);
      entries.push(...protocolEntries);
      return rankPatientTrials(entries);
    },

    /**
     * The candidate trials of the study that have not judged this patient and could: what a run (or the page's next press) still owes
     * them. A trial with no criteria cannot judge anybody and is not here.
     * @param {any} study @param {{ subjectKey: string }} input
     */
    async unjudged(study, { subjectKey }) {
      const [trials, verdicts] = await Promise.all([
        candidateStore.listCandidateTrials({ studyId: study.id, limit: 1000 }),
        candidateStore.latestAssessments({ studyId: study.id, subjectKey }),
      ]);
      const criteria = await candidateStore.criteriaOfTrials(study.id, trials.filter((trial) => !verdicts.has(trial.id)).map((trial) => trial.id));
      return trials.filter((trial) => !verdicts.has(trial.id) && (criteria.get(trial.id) ?? []).length > 0)
        .map((trial) => ({ id: trial.id, registry: trial.registry, registryId: trial.registryId, title: trial.title }));
    },

    /**
     * One line of a patient's list with the criteria it was judged on and the per-criterion judgments: what a page's criterion table
     * is made of. `null` when this patient has no verdict from that trial or protocol version. `ranked` is the list the caller already read.
     * @param {any} study @param {{ subjectKey: string, id: string, ranked?: any[] | null, viewer?:{id:string} }} input
     */
    async detail(study, { subjectKey, id, ranked = null, viewer = null }) {
      if ((await matchStore?.withdrawnSubjects?.(study.id) ?? new Set()).has(subjectKey)) return null;
      const entry = (ranked ?? await self.ranked(study, { subjectKey })).find((row) => row.id === id);
      if (!entry) return null;
      if (entry.kind === "registry") {
        const snapshot = await candidateStore.rankingSnapshot(study.id, subjectKey, { id: entry.id, full: true });
        const assessment = snapshot.assessments[0] ?? null;
        if (!assessment || assessment.id !== entry.assessmentId || matchingInputDigest({ criteria: snapshot.criteria, judgments: snapshot.judgments.map(j => [j.criterionId, j.state, j.applicable]).sort() }) !== entry.snapshotHash) return null;
        const effective = effectiveAssessment(assessment, snapshot.criteria, snapshot.judgments);
        const projected = viewer ? await matchingAssessmentEvidence({ documents, study, assessment: effective, subjectKey, viewer }) : effective;
        const currentEntry = { ...entry, summary: effective.summary, counts: effective.counts };
        return { entry: currentEntry, criteria: snapshot.criteria, judgments: projected?.judgments ?? [], assessment: projected };
      }
      const criteria = await matchStore.listCriteria({ studyId: study.id, protocolVersionId: entry.id });
      const assessment = entry.assessmentId ? await matchStore.getAssessment(entry.assessmentId, study.id) : null;
      const effective = effectiveAssessment(assessment, criteria, assessment?.judgments ?? []);
      const projected = viewer ? await matchingAssessmentEvidence({ documents, study, assessment: effective, subjectKey, viewer }) : effective;
      return { entry: { ...entry, summary: effective?.summary, counts: effective?.counts }, criteria, judgments: projected?.judgments ?? [], assessment: projected };
    },

    /**
     * `vcr_read what: "candidate_trials"`: the study's candidate trials (a page), or one — by `filter.id`, or `filter.registryId` — with its
     * criteria and the language keys a run may still owe an answer for; with `filter.subjectKey`, this patient's trials in order with the
     * verdict about each (counts and states, never a quotation of the chart) and the language answers still owed.
     * @param {any} study @param {Record<string, any>} [filter]
     */
    async runtimeRead(study, filter = {}) {
      const subjectKey = filter.subjectKey ? String(filter.subjectKey) : null;
      if (subjectKey && (await matchStore?.withdrawnSubjects?.(study.id) ?? new Set()).has(subjectKey)) {
        return { subjectKey, withdrawn: true, trials: [], ranking: [], assessment: null, requests: [], more: false };
      }
      const wanted = filter.id || filter.registryId;
      if (wanted) {
        if (subjectKey) {
          const snapshot = await candidateStore.rankingSnapshot(study.id, subjectKey, { id: filter.id ? String(filter.id) : undefined, registry: filter.registry ? String(filter.registry) : undefined, registryId: filter.registryId ? String(filter.registryId) : undefined, full: true });
          const trial = snapshot.trials[0];
          if (!trial) return { trials: [], more: false };
          const assessment = effectiveAssessment(snapshot.assessments.find(a => a.candidateTrialId === trial.id) ?? null, snapshot.criteria.filter(c => c.candidateTrialId === trial.id), snapshot.judgments);
          return { trials: [trialForRun(trial, snapshot.criteria, { withCriteria: true })], more: false, subjectKey, assessment: await matchingAssessmentEvidence({ documents, study, assessment, subjectKey }) };
        }
        const trial = await candidateStore.getCandidateTrial({ studyId: study.id, id: filter.id ? String(filter.id) : null, registry: filter.registry ? String(filter.registry) : null, registryId: filter.registryId ? String(filter.registryId) : null });
        if (!trial) return { trials: [], more: false };
        const criteria = await candidateStore.listCriteria(trial.id);
        return { trials: [trialForRun(trial, criteria, { withCriteria: true })], more: false };
      }
      if (subjectKey) {
        const ranking = await self.ranked(study, { subjectKey });
        const offset = Number.isSafeInteger(filter.offset) ? Math.max(0, filter.offset) : 0;
        const page = ranking.slice(offset, offset + READ_PAGE);
        const candidateIds = page.filter(entry => entry.kind === "registry").map(entry => entry.id);
        const current = await candidateStore.rankingSnapshot(study.id, subjectKey);
        const currentAssessments = new Map(current.assessments.map(a => [a.candidateTrialId, a.id]));
        if (page.some(row => row.kind === "registry" && (currentAssessments.get(row.id) !== row.assessmentId || matchingInputDigest({
          criteria: current.criteria.filter(c => c.candidateTrialId === row.id),
          judgments: current.judgments.filter(j => j.assessmentId === row.assessmentId).map(j => [j.criterionId, j.state, j.applicable]).sort(),
        }) !== row.snapshotHash))) {
          throw new HttpError(409, "vcr_read_changed", "Trial assessments changed while reading; retry the list.");
        }
        const criteriaOf = new Map(candidateIds.map(id => [id, current.criteria.filter(c => c.candidateTrialId === id)]));
        const answeredByTrial = await candidateStore.languageAnswersForTrials(study.id, subjectKey, candidateIds, criteriaOf);
        const protocolCriteria = matchStore ? await matchStore.criteriaOfProtocols(study.id, page.filter(entry => entry.kind === "protocol").map(entry => entry.id)) : [];
        /** @type {Array<{ trialId: string, criterionKey: string, criterionId: string }>} */
        const requests = [];
        for (const row of page.filter(entry => entry.kind === "registry")) {
          const answered = answeredByTrial.get(row.id) ?? new Set();
          for (const criterion of criteriaOf.get(row.id) ?? []) for (const key of languageKeysOf(criterion.requirement, criterion.id)) {
            if (!answered.has(key)) requests.push({ trialId: row.id, criterionKey: key, criterionId: criterion.id });
          }
        }
        return {
          subjectKey,
          unjudged: await self.unjudged(study, { subjectKey }),
          total: ranking.length, offset, more: offset + page.length < ranking.length,
          ranking: await Promise.all(page.map(async (row) => ({
            rank: row.rank, kind: row.kind, id: row.id, registry: row.registry, registryId: row.registryId, title: row.title, phase: row.phase, status: row.status,
            // The registry's word is as of the day its record was read; it says nothing of a site's places today.
            statusAsOf: row.retrievedAt, collection: row.collection,
            eligibility: row.summary, criteriaCounts: row.counts, ranking: row.ranking,
            // How much of the trial is settled for this patient, unknowns in the denominator: 7 of 10 is a different verdict from 1 of 1.
            decided: row.counts ? decidedShare(row.counts) : null,
            evidenceGaps: list(row.evidenceGaps).map((gap) => ({ ...gap, label: GAP_LABELS[text(gap.reason)] ?? null })),
            undecided: undecidedCriteria(row.evidenceGaps, row.kind === "registry" ? criteriaOf.get(row.id) ?? [] : protocolCriteria.filter(c => c?.protocolVersionId === row.id)),
            asOf: row.asOf, retrievedAt: row.retrievedAt,
          }))),
          requests,
        };
      }
      const limit = Math.min(READ_PAGE, Math.max(1, Number(filter.limit ?? 20)));
      const offset = Math.max(0, Number(filter.offset ?? 0));
      const all = await candidateStore.listCandidateTrials({ studyId: study.id, limit: 1000 });
      const page = all.slice(offset, offset + limit);
      const criteria = await candidateStore.criteriaOfTrials(study.id, page.map((trial) => trial.id));
      return { trials: page.map((trial) => trialForRun(trial, criteria.get(trial.id) ?? [])), more: all.length > offset + limit };
    },
  };
  return self;
}
