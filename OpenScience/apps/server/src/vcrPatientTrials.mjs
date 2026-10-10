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
import { languageKeysOf } from "./vcrMatching.mjs";

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

/** Trials one runtime read lists at most (the module's page size for a read). */
const READ_PAGE = 50;

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
 * The seam the gateway, the service and the orchestrator reach 「给患者找试验」 through: writing a candidate trial, and what a
 * run may read of them. Built from the store and the configuration, so the module composes one object and the readers hold no store.
 *
 * @param {{ candidateStore: import("./vcrCandidateTrialStore.mjs").VcrCandidateTrialStore, config?: Record<string, any>,
 *   report?: (code: string) => void }} parts
 */
export function createPatientTrials({ candidateStore, config = {}, report = () => {} }) {
  /** What the seam did since this process started (`open_science_vcr_patient_trials_total`). */
  const counters = { written: 0, refused: 0, capReached: 0, updated: 0 };
  /** The most candidate trials one study holds: each costs an evaluation per patient. */
  const max = () => (Number(config.vcrCandidateTrialsMax) > 0 ? Number(config.vcrCandidateTrialsMax) : 60);

  return {
    counters,

    /** Whether the study already holds this registry trial. @param {any} study @param {{ registry: string, registryId: string }} key */
    async holds(study, { registry, registryId }) {
      return Boolean(await candidateStore.getCandidateTrial({ studyId: study.id, registry, registryId }));
    },

    /**
     * Write one candidate trial with its criteria (`criteria: null` keeps what it has).
     * @param {any} study @param {{ trial: Record<string, any>, criteria: readonly any[] | null, subjectKeys?: readonly string[] }} input
     */
    async writeTrial(study, { trial, criteria }) {
      try {
        const saved = await candidateStore.saveCandidateTrial({ studyId: study.id, userId: study.userId, trial, criteria, max: max() });
        if (saved.created) counters.written += 1; else counters.updated += 1;
        return { ...saved, evaluation: null };
      } catch (error) {
        counters.refused += 1;
        if (error instanceof HttpError && error.status === 409) counters.capReached += 1;
        else report(String(/** @type {any} */ (error)?.code ?? "vcr_write_refused"));
        throw error;
      }
    },

    /**
     * `vcr_read what: "candidate_trials"`: the study's candidate trials (a page), or one — by `filter.id`, or `filter.registryId` —
     * with its criteria, each with the language keys a run may still owe an answer for.
     * @param {any} study @param {Record<string, any>} [filter]
     */
    async runtimeRead(study, filter = {}) {
      const wanted = filter.id || filter.registryId;
      if (wanted) {
        const trial = await candidateStore.getCandidateTrial({
          studyId: study.id, id: filter.id ? String(filter.id) : null, registry: filter.registry ? String(filter.registry) : null,
          registryId: filter.registryId ? String(filter.registryId) : null,
        });
        if (!trial) return { trials: [], more: false };
        return { trials: [trialForRun(trial, await candidateStore.listCriteria(trial.id), { withCriteria: true })], more: false };
      }
      const limit = Math.min(READ_PAGE, Math.max(1, Number(filter.limit ?? 20)));
      const offset = Math.max(0, Number(filter.offset ?? 0));
      const all = await candidateStore.listCandidateTrials({ studyId: study.id, limit: 1000 });
      const page = all.slice(offset, offset + limit);
      const criteria = await candidateStore.criteriaOfTrials(study.id, page.map((trial) => trial.id));
      return { trials: page.map((trial) => trialForRun(trial, criteria.get(trial.id) ?? [])), more: all.length > offset + limit };
    },
  };
}
