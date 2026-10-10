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

import { HttpError } from "./security.mjs";
import { CTGOV_STUDY_URL, CTIS_STUDY_URL } from "./trialRegistryClient.mjs";
import { VCR_MATCHING_VOCABULARY_VERSION, assessSubject, frozenAsOf, languageKeysOf, matchingInputDigest } from "./vcrMatching.mjs";
import { matchingVariablesOf, subjectTableFacts } from "./vcrMatchingTable.mjs";

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
    recordHash: text(record?.hash) || text(source.recordHash) || null,
    retrievedAt: text(precedent?.fetchedAt) || text(source.retrievedAt) || null,
    eligibilityText,
  };
}

/**
 * Where a criterion's original wording stands in the record's eligibility text: a list marker in front is
 * the list's and not the wording's, runs of whitespace are one space on both sides, and the answer is the
 * span in the record's own characters. `null` when the words are not there.
 * @param {string} sourceText @param {string} eligibilityText @returns {{ start: number, end: number } | null}
 */
export function locateSourceText(sourceText, eligibilityText) {
  const record = String(eligibilityText ?? "");
  if (!record.trim()) return null;
  /** The record with whitespace runs folded to one space, and for each folded character where it came from. */
  const folded = [];
  const origin = [];
  let gap = false;
  for (let at = 0; at < record.length; at += 1) {
    if (/\s/.test(record[at])) { gap = folded.length > 0; continue; }
    if (gap) { folded.push(" "); origin.push(at); gap = false; }
    folded.push(record[at]);
    origin.push(at);
  }
  const haystack = folded.join("");
  const fold = (/** @type {string} */ value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const wording = fold(sourceText);
  for (const candidate of [wording, wording.replace(/^(?:[*\-•]|\d{1,3}[.)])\s+/, "")]) {
    if (!candidate) continue;
    const found = haystack.indexOf(candidate);
    if (found < 0) continue;
    return { start: origin[found], end: origin[found + candidate.length - 1] + 1 };
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
  { rank: 0, label: "招募中", words: ["recruiting", "authorisedrecruiting", "ongoingrecruiting"] },
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
  const word = text(status).toLowerCase().replace(/[^a-z]/g, "");
  return word ? STATUS_TABLE.find((entry) => entry.words.includes(word)) ?? null : null;
};

/** How soon a patient could join a trial in this status: lower is sooner. @param {unknown} status */
export function registryStatusRank(status) {
  return statusEntry(status)?.rank ?? STATUS_OTHER_RANK;
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

/**
 * A patient's trials in the order they are listed: every criterion met first, then by the fewest criteria still to settle (unknown
 * and waiting-for-a-date together), the ones the patient is excluded from after those, and a trial not yet evaluated last; ties by
 * where the trial stands in its registry (recruiting first), then its title, then its id. Arithmetic over the evaluator's counts and
 * nothing a model said, so the same verdicts are the same list in any order they arrive.
 * @template {{ id: string, title?: string, status?: string, summary: string | null, counts?: Record<string, number> | null }} T
 * @param {readonly T[]} entries @returns {Array<T & { rank: number }>}
 */
export function rankPatientTrials(entries) {
  const tier = (/** @type {T} */ row) => (row.summary === "eligible" ? 0 : row.summary === "ineligible" ? 2 : row.summary ? 1 : 3);
  const open = (/** @type {T} */ row) => Number(row.counts?.unknown ?? 0) + Number(row.counts?.pending_recheck ?? 0);
  const fold = (/** @type {unknown} */ value) => text(value).toLowerCase();
  return [...entries]
    .sort((a, b) => tier(a) - tier(b) || open(a) - open(b) || registryStatusRank(a.status) - registryStatusRank(b.status)
      || order(fold(a.title), fold(b.title)) || order(String(a.id), String(b.id)))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

/** Trials one runtime read lists at most (the module's page size for a read). */
const READ_PAGE = 50;

/** The word for a study's own protocol version in a list of trials. @param {{ title?: string, version?: number }} protocol */
const protocolTitle = (protocol) => text(protocol.title) || `方案版本 ${protocol.version}`;

/**
 * A candidate trial as the run reads it: what it is and what it asks, never where a site's people are.
 * @param {any} trial @param {readonly any[]} criteria @param {{ withCriteria?: boolean }} [options]
 */
function trialForRun(trial, criteria, { withCriteria = false } = {}) {
  return {
    id: trial.id, registry: trial.registry, registryId: trial.registryId, title: trial.title, phase: trial.phase, status: trial.status,
    conditions: trial.conditions, locations: { total: trial.locations?.total ?? null, countries: trial.locations?.countries ?? [] },
    url: trial.url, recordHash: trial.recordHash, retrievedAt: trial.retrievedAt, updatedAt: trial.updatedAt,
    criteria: withCriteria
      ? criteria.map((criterion) => ({
        id: criterion.id, ordinal: criterion.ordinal, kind: criterion.kind, criterionType: criterion.criterionType,
        sourceText: criterion.sourceText, requirement: criterion.requirement, applicability: criterion.applicability,
        languageKeys: languageKeysOf(criterion.requirement, criterion.id),
      }))
      : criteria.length,
  };
}

/**
 * One line of a patient's list: a registry trial, or a version of the study's own protocol, with the verdict about this patient (`null`
 * until one has been made).
 * @param {{ kind: "registry" | "protocol", id: string, title: string, status?: string, phase?: string, registry?: string | null, registryId?: string | null,
 *   url?: string, conditions?: readonly string[], locations?: any }} about @param {any} assessment
 */
function listed(about, assessment) {
  return {
    kind: about.kind, id: about.id, title: about.title, status: about.status ?? "", phase: about.phase ?? "",
    registry: about.registry ?? null, registryId: about.registryId ?? null, url: about.url ?? "",
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
  const counters = { written: 0, updated: 0, refused: 0, capReached: 0, evaluated: 0, evaluationFailed: 0, searches: 0 };
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
              studyId: study.id, protocolVersionId: null, subjectKey, asOf: at, direction: "patient_to_trial", criteria, facts,
              documents: await documentsOf(documentIds), modelJudgments: language,
              provenance: { vocabularyVersion: VCR_MATCHING_VOCABULARY_VERSION, inputSnapshotId },
            });
            const saved = await candidateStore.saveAssessment({
              userId: study.userId,
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
      const who = [...new Set([...subjectKeys, ...(saved.criteriaChanged ? saved.reassess : [])])];
      const evaluation = who.length ? await self.evaluate(study, { subjectKeys: who, trialIds: [saved.trial.id] }) : { evaluated: [], unavailable: [], notes: [] };
      return { ...saved, evaluation };
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
     * A patient's trials in order: every candidate trial of the study and the study's own protocol — its newest version always, an older one
     * once it has judged this patient — each with the verdict about this patient (or `null`), ranked by `rankPatientTrials`.
     * @param {any} study @param {{ subjectKey: string }} input
     */
    async ranked(study, { subjectKey }) {
      const [trials, verdicts] = await Promise.all([
        candidateStore.listCandidateTrials({ studyId: study.id, limit: 1000 }),
        candidateStore.latestAssessments({ studyId: study.id, subjectKey }),
      ]);
      const entries = trials.map((trial) => listed({
        kind: "registry", id: trial.id, title: trial.title, status: trial.status, phase: trial.phase, registry: trial.registry,
        registryId: trial.registryId, url: trial.url, conditions: trial.conditions, locations: trial.locations,
      }, verdicts.get(trial.id) ?? null));
      const protocols = matchStore ? await matchStore.protocols(study.id) : [];
      for (const [index, protocol] of protocols.entries()) {
        const verdict = await matchStore.latestAssessment({ studyId: study.id, subjectKey, protocolVersionId: protocol.id });
        if (index === 0 || verdict) entries.push(listed({ kind: "protocol", id: protocol.id, title: protocolTitle(protocol) }, verdict));
      }
      return rankPatientTrials(entries);
    },

    /**
     * One line of a patient's list with the criteria it was judged on and the per-criterion judgments: what a page's criterion table
     * is made of. `null` when the study has no such trial or protocol version.
     * @param {any} study @param {{ subjectKey: string, id: string }} input
     */
    async detail(study, { subjectKey, id }) {
      const entry = (await self.ranked(study, { subjectKey })).find((row) => row.id === id);
      if (!entry) return null;
      if (entry.kind === "registry") {
        const criteria = await candidateStore.listCriteria(entry.id);
        const assessment = entry.assessmentId ? await candidateStore.getAssessment(entry.assessmentId, study.id) : null;
        return { entry, criteria, judgments: assessment?.judgments ?? [], assessment };
      }
      const criteria = await matchStore.listCriteria({ studyId: study.id, protocolVersionId: entry.id });
      const assessment = entry.assessmentId ? await matchStore.getAssessment(entry.assessmentId, study.id) : null;
      return { entry, criteria, judgments: assessment?.judgments ?? [], assessment };
    },

    /**
     * `vcr_read what: "candidate_trials"`: the study's candidate trials (a page), or one — by `filter.id`, or `filter.registryId` — with its
     * criteria and the language keys a run may still owe an answer for; with `filter.subjectKey`, this patient's trials in order with the
     * verdict about each (counts and states, never a quotation of the chart) and the language answers still owed.
     * @param {any} study @param {Record<string, any>} [filter]
     */
    async runtimeRead(study, filter = {}) {
      const subjectKey = filter.subjectKey ? String(filter.subjectKey) : null;
      const wanted = filter.id || filter.registryId;
      if (wanted) {
        const trial = await candidateStore.getCandidateTrial({
          studyId: study.id, id: filter.id ? String(filter.id) : null, registry: filter.registry ? String(filter.registry) : null,
          registryId: filter.registryId ? String(filter.registryId) : null,
        });
        if (!trial) return { trials: [], more: false };
        const criteria = await candidateStore.listCriteria(trial.id);
        const answer = { trials: [trialForRun(trial, criteria, { withCriteria: true })], more: false };
        if (!subjectKey) return answer;
        const verdict = (await candidateStore.latestAssessments({ studyId: study.id, subjectKey })).get(trial.id) ?? null;
        const full = verdict ? await candidateStore.getAssessment(verdict.id, study.id) : null;
        return { ...answer, subjectKey, assessment: full ? {
          summary: full.summary, asOf: full.asOf, counts: full.counts, evidenceGaps: full.evidenceGaps,
          judgments: full.judgments.map((judgment) => ({ criterionId: judgment.criterionId, state: judgment.state, applicable: judgment.applicable,
            decidedBy: judgment.decidedBy, recheckAt: judgment.recheckAt })),
        } : null };
      }
      if (subjectKey) {
        const ranking = await self.ranked(study, { subjectKey });
        /** @type {Array<{ trialId: string, criterionKey: string, criterionId: string }>} */
        const requests = [];
        for (const row of ranking.filter((entry) => entry.kind === "registry")) {
          const answered = new Set(Object.keys(await candidateStore.latestLanguageJudgments({ studyId: study.id, candidateTrialId: row.id, subjectKey })));
          for (const criterion of await candidateStore.listCriteria(row.id)) {
            for (const key of languageKeysOf(criterion.requirement, criterion.id)) {
              if (!answered.has(key)) requests.push({ trialId: row.id, criterionKey: key, criterionId: criterion.id });
            }
          }
        }
        return {
          subjectKey,
          ranking: ranking.map((row) => ({
            rank: row.rank, kind: row.kind, id: row.id, registry: row.registry, registryId: row.registryId, title: row.title, phase: row.phase, status: row.status,
            eligibility: row.summary, counts: row.counts, evidenceGaps: row.evidenceGaps, asOf: row.asOf,
          })),
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
