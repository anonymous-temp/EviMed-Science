/**
 * 「给患者找试验」's first step: the list of registry trials that might take one patient (`vcr_read what: "candidates"`, M1).
 *
 * The run writes the search — a condition, a few phrases in English and Chinese — and says what it knows of the patient (age, sex, country).
 * Everything after that is code and none of it is a judgement about the patient: the three registries are asked together, the answers are
 * merged, the same trial listed twice is one candidate, the ones the registry's own fields rule out (closed, outside the age bounds the
 * record states, for the other sex, in other countries) are left out and counted, and the list is cut to a size a reader can go through.
 * Whether the patient fits a trial is the evaluator's, later, against the trial's eligibility text; this only finds trials to read.
 *
 * Hidden knowledge:
 *
 * - **A field the record does not state is unknown, and the candidate stays.** A listing that says nothing of sites, sex or age bounds
 *   (ChiCTR gives none of the three) is not a trial that fails the filter; the candidate carries the names of the filters it could not be
 *   held to (`unknown`) so the run reads them as open questions.
 * - **A registry that failed is named with its reason, and the others' results stand.** The answer says, per registry, what was asked, what
 *   failed and what came back, and says plainly what is not covered at all (CDE and ICTRP are not wired — owner ruling 2026-09-29).
 *   「没查」 and 「查到零条」 are different findings.
 * - **The order is a retrieval order, not a verdict.** Each registry's answers to the run's phrases are fused (TrialGPT's reciprocal-rank
 *   fusion: a trial the earlier phrases find high comes first) and the registries' lists are interleaved so no one registry fills the list;
 *   when the run gave a summary of the patient, a reranker puts the list in the order of how well each trial reads against that summary
 *   (`vcrCandidateRerank.mjs`). Neither says a trial suits the patient or that the patient fits it. 「符合」 is not a recommendation, and a
 *   list is not a verdict either.
 * - **Depth is bounded by the clock, not by a count of phrases.** A search asks each registry for every phrase, a page at a time, in the
 *   run's order of priority, within the deployment's deadline (`vcrCandidateRetrieve.mjs`); a phrase the deadline did not reach is said so.
 * - **The status, age and sex readings are closed tables over structured registry fields** (`registryStatusOpen`, `ageBands`, `sexOf`),
 *   not readings of prose; a word these tables do not know is unknown, never closed or excluded.
 * - **A retrieval hint is never a verdict.** Nothing in this file decides eligibility, and a trial this list left out is left out for a
 *   stated field only.
 *
 * @module vcrCandidateSearch
 */

/** The registries a candidate list asks, in the order their results are kept first (the record with eligibility text wins a duplicate). */
export const CANDIDATE_REGISTRIES = Object.freeze([
  Object.freeze({ id: "clinicaltrials.gov", name: "ClinicalTrials.gov" }),
  Object.freeze({ id: "ctis", name: "欧盟临床试验信息系统（CTIS）" }),
  Object.freeze({ id: "chictr", name: "中国临床试验注册中心（ChiCTR）" }),
]);

/**
 * What no search here reaches. Said in every answer, because a list of trials that leaves out the Chinese industry-sponsored trials of a
 * registry nobody queried reads as a list of the trials there are. CDE and ICTRP were ruled out of the platform on 2026-09-29 and are not
 * reopened (the cost is stated in the answer, not hidden).
 */
export const CANDIDATES_NOT_COVERED = Object.freeze([
  Object.freeze({ id: "cde", name: "药物临床试验登记与信息公示平台（CDE）", reason: "没有接入" }),
  Object.freeze({ id: "ictrp", name: "WHO 国际临床试验注册平台（ICTRP）", reason: "该库的使用条款不允许商业使用，没有接入" }),
]);

/**
 * The most phrases besides the condition one list is searched with: each is a request, a page at a time, to each registry. The run writes
 * them as TrialGPT's keyword step does — the patient's problems summarised, then up to 32 conditions ranked by priority.
 */
export const CANDIDATE_TERMS_MAX = 32;
/** The most candidates one search keeps for one patient, and the most a frozen collection's list holds. */
export const CANDIDATE_RETRIEVE_MAX = 500;
export const FROZEN_CANDIDATE_LIMIT = CANDIDATE_RETRIEVE_MAX;
/** The most characters of the patient summary a reranker reads (the run writes it; it is not the note). */
export const CANDIDATE_SUMMARY_MAX = 2_000;
/** The constant of the reciprocal-rank fusion TrialGPT recommends (its README: 20). */
export const CANDIDATE_FUSION_K = 20;
/** The rows of one answer a frozen collection or a stored list returns at a time. */
export const CANDIDATE_PAGE_SIZE = 50;

/** ClinicalTrials.gov's statuses of a trial that is open or about to be, and CTIS's public status codes for the same (`CTIS_PUBLIC_STATUS`). */
const CTGOV_OPEN_STATUSES = Object.freeze(["RECRUITING", "NOT_YET_RECRUITING", "ENROLLING_BY_INVITATION"]);
const CTIS_OPEN_STATUSES = Object.freeze([2, 3, 4]);

/** @param {unknown} value */
const text = (value) => String(value ?? "").trim();

/**
 * A registry's words for where a trial stands, as one closed table: whether it is open (the rank — lower is sooner, up to 2 is open),
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
/** @param {unknown} status */
const statusEntry = (status) => {
  const given = text(status);
  const word = given.toLowerCase().replace(/[^a-z]/g, "");
  return STATUS_TABLE.find((entry) => (word && entry.words.includes(word)) || (/** @type {{ zh?: string[] }} */ (entry).zh ?? []).includes(given)) ?? null;
};

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
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
/** An id as two registrations of one trial would agree on it: case and spacing folded. @param {unknown} value */
const idKey = (value) => text(value).replace(/\s+/g, "").toUpperCase();
/** @param {unknown} value */
const fold = (value) => text(value).normalize("NFKC").replace(/\s+/g, " ").toLowerCase();

/**
 * @typedef {{ condition: string, terms: string[], summary: string | null, age: number | null, sex: "male" | "female" | null,
 *   region: string | null, scope: "open" | "any", limit: number }} CandidateRequest
 */

/**
 * The request as the platform runs it: validated and bounded here as well as at the gateway, because the service is also reached by code.
 * `condition` is required; `terms` are other ways to ask for the same trials (a synonym, the Chinese name, a biomarker) and each is a
 * search of its own, not a narrowing of the condition.
 * @param {Record<string, any>} filter @param {{ limitMax?: number, frozen?: boolean }} [options]
 * @returns {{ ok: true, request: CandidateRequest } | { ok: false, message: string }}
 */
export function candidateRequest(filter, { limitMax = 20, frozen = false } = {}) {
  const condition = text(filter?.condition).replace(/\s+/g, " ");
  if (!condition || [...condition].length > 200) return { ok: false, message: "filter.condition 是要找的病情，1 到 200 个字：例如 non-small cell lung cancer。" };
  const given = filter?.terms === undefined || filter?.terms === null ? [] : filter.terms;
  if (!Array.isArray(given) || given.some((term) => typeof term !== "string")) return { ok: false, message: "filter.terms 是检索词的数组，每个是一段文字（中英文都可以，再多一种问法）。" };
  /** @type {string[]} */
  const terms = [];
  for (const term of given.map((entry) => text(entry).replace(/\s+/g, " ")).filter(Boolean)) {
    if ([...term].length > 200) return { ok: false, message: "filter.terms 里每个检索词最长 200 个字。" };
    if (fold(term) !== fold(condition) && !terms.some((held) => fold(held) === fold(term))) terms.push(term);
  }
  if (terms.length > CANDIDATE_TERMS_MAX) return { ok: false, message: `filter.terms 最多 ${CANDIDATE_TERMS_MAX} 个：按重要性排在前面，靠后的在时间用完时可能没查到。` };
  let summary = null;
  if (filter?.summary !== undefined && filter?.summary !== null) {
    if (typeof filter.summary !== "string") return { ok: false, message: `filter.summary 是你写的患者问题摘要（不是病历原文，不含姓名和证件号），最多 ${CANDIDATE_SUMMARY_MAX} 个字。` };
    summary = text(filter.summary).replace(/\s+/g, " ") || null;
    if (summary && [...summary].length > CANDIDATE_SUMMARY_MAX) return { ok: false, message: `filter.summary 最多 ${CANDIDATE_SUMMARY_MAX} 个字：写患者的主要问题、分期和用过的治疗，不要贴病历。` };
  }
  let age = null;
  if (filter?.age !== undefined && filter?.age !== null) {
    age = Number(filter.age);
    if (!Number.isFinite(age) || age < 0 || age > 130) return { ok: false, message: "filter.age 是患者的年龄（岁），0 到 130 的数；不知道就不写。" };
  }
  let sex = null;
  if (filter?.sex !== undefined && filter?.sex !== null) {
    sex = fold(filter.sex);
    if (sex !== "male" && sex !== "female") return { ok: false, message: "filter.sex 写 male 或 female；病历没写就不写。" };
  }
  let region = null;
  if (filter?.region !== undefined && filter?.region !== null) {
    region = text(filter.region).replace(/\s+/g, " ");
    if (!region || [...region].length > 80) return { ok: false, message: "filter.region 是国家名，照登记库的英文写法（China, United States）；不知道就不写。" };
  }
  const scope = filter?.status === undefined || filter?.status === null ? (frozen ? "any" : "open") : text(filter.status);
  if (scope !== "open" && scope !== "any") return { ok: false, message: "filter.status 写 open（正在或即将招募，默认）或 any（不看状态）。" };
  if (frozen && filter.limit != null && (!Number.isSafeInteger(filter.limit) || filter.limit < 1 || filter.limit > FROZEN_CANDIDATE_LIMIT)) {
    return { ok: false, message: `filter.limit 是 1 到 ${FROZEN_CANDIDATE_LIMIT} 的整数。` };
  }
  if (frozen) limitMax = FROZEN_CANDIDATE_LIMIT;
  const limit = Math.max(1, Math.min(limitMax, Number.isSafeInteger(filter?.limit) ? filter.limit : limitMax));
  return { ok: true, request: { condition, terms, summary, age, sex: /** @type {any} */ (sex), region, scope: /** @type {any} */ (scope), limit } };
}

/**
 * A page of a search already made (`filter.searchId`, with `offset` and `limit`): the stored list read again, no registry asked.
 * @param {Record<string, any>} filter @param {{ limitMax?: number }} [options]
 * @returns {{ ok: true, page: { searchId: string, offset: number, limit: number } } | { ok: false, message: string }}
 */
export function candidatePageRequest(filter, { limitMax = 20 } = {}) {
  const searchId = text(filter?.searchId);
  if (!/^[A-Za-z0-9_.:@-]{1,160}$/.test(searchId)) return { ok: false, message: "filter.searchId 是上一次检索返回的 searchId。" };
  const offset = filter?.offset === undefined || filter?.offset === null ? 0 : filter.offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > CANDIDATE_RETRIEVE_MAX) return { ok: false, message: `filter.offset 是 0 到 ${CANDIDATE_RETRIEVE_MAX} 的整数。` };
  const limit = Math.max(1, Math.min(limitMax, Number.isSafeInteger(filter?.limit) ? filter.limit : limitMax));
  return { ok: true, page: { searchId, offset, limit } };
}

/**
 * TrialGPT's weight of a hit: the trial at rank `rank` (from 0) of the list the phrase at `queryIndex` (from 0) found. A hit on an earlier phrase
 * counts for more, and a trial several phrases find rises above one that a single phrase put first.
 * @param {number} rank @param {number} queryIndex
 */
export const fusionScore = (rank, queryIndex) => (1 / (rank + CANDIDATE_FUSION_K)) * (1 / (queryIndex + 1));

/**
 * Fuse the lists one registry gave to the run's phrases, in the run's order of priority, into one list. Within the list of a phrase the order is
 * the registry's own; a trial in several lists counts in each. Equal scores keep the order in which the trials were first met.
 * @template {{ registryId: string }} T
 * @param {T[][]} lists
 * @returns {T[]}
 */
export function fuseRanked(lists) {
  /** @type {Map<string, { candidate: T, score: number, first: number }>} */
  const held = new Map();
  lists.forEach((items, queryIndex) => {
    items.forEach((candidate, rank) => {
      const key = idKey(candidate.registryId);
      if (!key) return;
      const entry = held.get(key) ?? { candidate, score: 0, first: held.size };
      entry.score += fusionScore(rank, queryIndex);
      held.set(key, entry);
    });
  });
  return [...held.values()].sort((a, b) => b.score - a.score || a.first - b.first).map((entry) => entry.candidate);
}

// ---------------------------------------------------------------------------
// What a record states: age bands, sex, countries — closed readings of structured fields
// ---------------------------------------------------------------------------

const AGE_UNITS = Object.freeze(/** @type {Record<string, number>} */ ({ year: 1, month: 1 / 12, week: 7 / 365.25, day: 1 / 365.25, hour: 1 / 8766, minute: 1 / 525960 }));

/**
 * ClinicalTrials.gov's age bound — `18 Years`, `6 Months`, `N/A` — in years. `null` is no bound (`N/A`) and `undefined` is a bound this
 * reading does not know, which is not a bound.
 * @param {unknown} value @returns {number | null | undefined}
 */
function ageBound(value) {
  const word = text(value);
  if (!word) return undefined;
  if (/^n\/?a$/i.test(word)) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(year|month|week|day|hour|minute)s?$/i.exec(word);
  return match ? Number(match[1]) * AGE_UNITS[match[2].toLowerCase()] : undefined;
}

/** CTIS's age groups as its portal spells them (`CTIS_AGE_RANGES`): the bands, the lower bound inclusive and the upper exclusive. */
const CTIS_AGE_BANDS = Object.freeze([
  Object.freeze({ label: "in utero", min: 0, max: 0 }), Object.freeze({ label: "0-17 years", min: 0, max: 18 }),
  Object.freeze({ label: "18-64 years", min: 18, max: 65 }), Object.freeze({ label: "65+ years", min: 65, max: null }),
]);

/**
 * The age bands a candidate states — each `{ min, max, inclusive }` in years, `max: null` open — or `null` when the record states none. One
 * band for ClinicalTrials.gov (its bounds are inclusive); the groups CTIS lists for CTIS.
 * @param {{ registry: string, minimumAge?: unknown, maximumAge?: unknown, ageGroup?: unknown }} item
 * @returns {Array<{ min: number, max: number | null, inclusive: boolean }> | null}
 */
export function ageBands(item) {
  if (item.registry === "ctis") {
    const words = fold(item.ageGroup);
    const found = CTIS_AGE_BANDS.filter((band) => words.includes(band.label));
    return found.length ? found.map((band) => ({ min: band.min, max: band.max, inclusive: false })) : null;
  }
  const min = ageBound(item.minimumAge);
  const max = ageBound(item.maximumAge);
  // Neither bound was stated (the record has no eligibility module in the list): nothing to hold the patient's age to.
  if (min === undefined && max === undefined) return null;
  return [{ min: min ?? 0, max: max ?? null, inclusive: true }];
}

/**
 * Whether an age is inside a candidate's stated bands.
 * @param {Array<{ min: number, max: number | null, inclusive: boolean }> | null} bands @param {number} age @returns {"ok" | "outside" | "unknown"}
 */
export function ageFit(bands, age) {
  if (!bands) return "unknown";
  return bands.some((band) => age >= band.min && (band.max === null || (band.inclusive ? age <= band.max : age < band.max))) ? "ok" : "outside";
}

/**
 * The sex a candidate takes, in ClinicalTrials.gov's three words, from a field a registry states — CT.gov's `sex` or CTIS's `gender` (a
 * list of the two words) — or `null`. Nothing else is read as a sex.
 * @param {unknown} value @returns {"ALL" | "MALE" | "FEMALE" | null}
 */
export function sexOf(value) {
  const word = fold(value);
  if (!word) return null;
  if (word === "all") return "ALL";
  const female = /\bfemale\b/.test(word);
  const male = /\bmale\b/.test(word);
  return female && male ? "ALL" : female ? "FEMALE" : male ? "MALE" : null;
}

/** @param {"ALL" | "MALE" | "FEMALE" | null} stated @param {"male" | "female"} sex @returns {"ok" | "outside" | "unknown"} */
export function sexFit(stated, sex) {
  if (!stated) return "unknown";
  return stated === "ALL" || stated === sex.toUpperCase() ? "ok" : "outside";
}

/** @param {readonly string[] | null} countries @param {string} region @returns {"ok" | "outside" | "unknown"} */
export function regionFit(countries, region) {
  if (!countries || !countries.length) return "unknown";
  const wanted = fold(region);
  return countries.some((country) => fold(country) === wanted) ? "ok" : "outside";
}

// ---------------------------------------------------------------------------
// One shape for the three registries
// ---------------------------------------------------------------------------

/** @param {unknown} words @param {number} max */
const shortList = (words, max) => list(words).map(text).filter(Boolean).slice(0, max);

/** What the list says of one candidate, whichever registry it came from. @param {Record<string, any>} item */
function candidateOf(item) {
  return {
    registry: String(item.registry), registryId: text(item.registryId), title: text(item.title), status: text(item.status),
    phase: item.phase ?? "", conditions: shortList(item.conditions, 4), interventions: shortList(item.interventions, 4), url: text(item.url),
    sexStated: item.sexStated ?? null, ageStated: item.ageStated ?? null, ageBands: item.ageBands ?? null, countries: item.countries ?? null,
    eligibilityText: item.eligibilityText === "in_record" ? "in_record" : "not_in_listing",
    // The head of the eligibility text, kept only to be read by the reranker (never presented): a list item is not the record.
    eligibilityHead: text(item.eligibilityHead).slice(0, 1_500),
    ids: shortList(item.ids, 12), alsoRegisteredAs: /** @type {Array<{ registry: string, registryId: string }>} */ ([]),
  };
}

/** @param {any} item a ClinicalTrials.gov list item (`search({ forPatient: true })`) */
export function ctgovCandidate(item) {
  const bands = ageBands({ registry: "clinicaltrials.gov", minimumAge: item.minimumAge, maximumAge: item.maximumAge });
  return candidateOf({
    ...item, registry: "clinicaltrials.gov", status: item.overallStatus, phase: list(item.phases).map(text).filter(Boolean).join("/"),
    sexStated: sexOf(item.sex), ageStated: bands ? [text(item.minimumAge) || "N/A", text(item.maximumAge) || "N/A"].join(" – ") : null, ageBands: bands,
    countries: Array.isArray(item.countries) && item.countries.length ? item.countries : null, eligibilityText: "in_record", ids: item.secondaryIds,
  });
}

/** @param {any} item a CTIS list item (`ctisListItem`) */
export function ctisCandidate(item) {
  const bands = ageBands({ registry: "ctis", ageGroup: item.ageGroup });
  return candidateOf({
    ...item, registry: "ctis", status: item.overallStatus, phase: list(item.phases).map(text).filter(Boolean).join("/"),
    sexStated: sexOf(item.gender), ageStated: bands ? text(item.ageGroup) : null, ageBands: bands,
    countries: Array.isArray(item.countries) && item.countries.length ? item.countries : null, eligibilityText: "in_record",
  });
}

/** @param {any} built a ChiCTR list item as the registry client builds it (`{ precedent, record }`): a listing, with no eligibility text and no sites */
export function chictrCandidate(built) {
  const precedent = built?.precedent ?? {};
  return candidateOf({
    registry: "chictr", registryId: precedent.registryId, title: precedent.title, status: precedent.design?.overallStatus,
    phase: list(precedent.design?.phases).map(text).filter(Boolean).join("/"), conditions: precedent.pico?.conditions,
    interventions: list(precedent.pico?.interventions).map((entry) => (typeof entry === "string" ? entry : entry?.name)), url: built?.record?.url,
    eligibilityText: "not_in_listing",
  });
}

// ---------------------------------------------------------------------------
// Merge, filter, cut
// ---------------------------------------------------------------------------

/**
 * One trial listed more than once is one candidate: by registry id within a registry, and across registries by an id the record states
 * for another registration (a ClinicalTrials.gov record that names its EU CT number or ChiCTR number). The first kept is the one the
 * input lists first — the caller puts the registry whose record has eligibility text first — and the others are named on it.
 * @param {ReturnType<typeof candidateOf>[]} ordered
 */
export function mergeCandidates(ordered) {
  /** @type {Map<string, ReturnType<typeof candidateOf>>} */
  const held = new Map();
  /** @type {ReturnType<typeof candidateOf>[]} */
  const kept = [];
  for (const candidate of ordered) {
    const keys = [...new Set([candidate.registryId, ...candidate.ids].map(idKey).filter(Boolean))];
    const same = keys.map((key) => held.get(key)).find(Boolean);
    if (same) {
      if (same.registry !== candidate.registry || same.registryId !== candidate.registryId) {
        if (!same.alsoRegisteredAs.some((entry) => entry.registry === candidate.registry && entry.registryId === candidate.registryId)) {
          same.alsoRegisteredAs.push({ registry: candidate.registry, registryId: candidate.registryId });
        }
      }
      for (const key of keys) held.set(key, same);
      continue;
    }
    kept.push(candidate);
    for (const key of keys) held.set(key, candidate);
  }
  return kept;
}

/**
 * Hold the candidates to the filters the request carries, by what each record states. A candidate the registry's own field rules out is
 * counted under the first filter that did (status, age, sex, region) and left out; one that states nothing about a filter stays and
 * carries the filter's name in `unknown`.
 * @param {ReturnType<typeof candidateOf>[]} candidates
 * @param {{ age: number | null, sex: "male" | "female" | null, region: string | null, scope: "open" | "any" }} request
 */
export function filterCandidates(candidates, request) {
  const dropped = { status: 0, age: 0, sex: 0, region: 0 };
  /** @type {Array<ReturnType<typeof candidateOf> & { unknown: string[] }>} */
  const kept = [];
  for (const candidate of candidates) {
    /** @type {string[]} */
    const unknown = [];
    if (request.scope === "open") {
      const open = registryStatusOpen(candidate.status);
      if (open === false) { dropped.status += 1; continue; }
      if (open === null) unknown.push("status");
    }
    if (request.age !== null) {
      const fit = ageFit(candidate.ageBands, request.age);
      if (fit === "outside") { dropped.age += 1; continue; }
      if (fit === "unknown") unknown.push("age");
    }
    if (request.sex) {
      const fit = sexFit(candidate.sexStated, request.sex);
      if (fit === "outside") { dropped.sex += 1; continue; }
      if (fit === "unknown") unknown.push("sex");
    }
    if (request.region) {
      const fit = regionFit(candidate.countries, request.region);
      if (fit === "outside") { dropped.region += 1; continue; }
      if (fit === "unknown") unknown.push("region");
    }
    kept.push({ ...candidate, unknown });
  }
  return { kept, dropped };
}

/**
 * Cut the list to `limit` taking the registries in turn, each in its own relevance order, so no registry fills the list. This is not a
 * ranking of how well a trial suits the patient — there is none here.
 * @template {{ registry: string }} T
 * @param {T[]} candidates @param {number} limit @returns {{ list: T[], more: boolean }}
 */
export function interleave(candidates, limit) {
  const queues = CANDIDATE_REGISTRIES.map((registry) => candidates.filter((candidate) => candidate.registry === registry.id));
  /** @type {T[]} */
  const out = [];
  for (let round = 0; out.length < limit; round += 1) {
    let any = false;
    for (const queue of queues) {
      if (round < queue.length) { any = true; if (out.length < limit) out.push(queue[round]); }
    }
    if (!any) break;
  }
  return { list: out, more: candidates.length > out.length };
}

/**
 * What a registry's searches came to: every query asked of it with what came back, and the state — `searched` (all answered),
 * `partial` (some failed or were not reached, the rest's results stand), `failed` (none answered) or `not_configured` (this deployment, or this
 * researcher, has no way to ask it). `pages` is how many pages of the query were read; a query the deadline did not reach is `not_reached`.
 * @param {Array<{ query: string, status: string, reason?: string | null, total?: number | null, found: number, pages?: number }>} answers
 */
export function registryOutcome(answers) {
  const ok = answers.filter((answer) => answer.status === "ok");
  const failed = answers.filter((answer) => answer.status !== "ok");
  const state = !failed.length ? "searched" : ok.length ? "partial"
    : failed.every((answer) => answer.reason === "registry_not_configured") ? "not_configured" : "failed";
  return {
    state,
    searched: ok.map((answer) => ({ query: answer.query, found: answer.found, total: answer.total ?? null, pages: answer.pages ?? 1 })),
    failed: failed.map((answer) => ({ query: answer.query, reason: answer.reason ?? "registry_unavailable" })),
  };
}

/**
 * The sentence the run says in its reply about what was searched: copied, not retyped — which registries answered, which failed and why,
 * what is not covered, whether the list was reordered against the patient summary, and the day.
 * @param {Array<{ registry: string, name: string, state: string, failed: Array<{ reason: string }> }>} registries @param {string} asOf
 * @param {{ state?: string } | null} [rerank]
 */
export function coverageSentence(registries, asOf, rerank = null) {
  const day = asOf.slice(0, 10);
  const answered = registries.filter((entry) => entry.state === "searched" || entry.state === "partial");
  const parts = [];
  parts.push(answered.length ? `已查（${day}）：${answered.map((entry) => `${entry.name}${entry.state === "partial" ? "（部分检索词失败或没来得及查）" : ""}`).join("、")}` : `${day} 没有一个登记库查通`);
  for (const entry of registries.filter((item) => item.state === "failed" || item.state === "not_configured")) {
    const reason = entry.state === "not_configured" ? "本部署或本账户没有接入" : [...new Set(entry.failed.map((failure) => failure.reason))].join("、");
    parts.push(`${entry.name}没查到：${reason}`);
  }
  parts.push(`没有覆盖：${CANDIDATES_NOT_COVERED.map((entry) => entry.name).join("、")}`);
  const chictr = registries.find((entry) => entry.registry === "chictr" && (entry.state === "searched" || entry.state === "partial"));
  if (chictr) parts.push("ChiCTR 经证据接口只有清单，没有入排条件原文");
  if (rerank?.state === "ranked") parts.push("已按与患者摘要的相关程度重排");
  else if (rerank?.state === "partial") parts.push("按与患者摘要的相关程度重排了其中一部分，其余保持检索顺序");
  else if (rerank?.state === "failed") parts.push("重排没有成功，保持检索顺序");
  return `${parts.join("；")}。`;
}

/**
 * A candidate as the run reads it: the registry's words and the reader's, what the record states of who it takes and where it runs, what
 * could not be held to the filters, and the other registrations of the same trial. No score and no verdict.
 * @param {ReturnType<typeof filterCandidates>["kept"][number] & { rank?: number, relevance?: number }} candidate
 */
export function presentCandidate(candidate) {
  return {
    registry: candidate.registry, registryId: candidate.registryId, title: candidate.title,
    status: candidate.status, statusLabel: registryStatusLabel(candidate.status), phase: phaseLabel(candidate.phase),
    conditions: candidate.conditions, interventions: candidate.interventions,
    // What the record states, or null when it states nothing: the run is not told a sex or an age the registry did not give.
    sex: candidate.sexStated, age: candidate.ageStated, countries: candidate.countries ? candidate.countries.slice(0, 8) : null,
    url: candidate.url, eligibilityText: candidate.eligibilityText, unknown: candidate.unknown,
    ...(candidate.alsoRegisteredAs.length ? { alsoRegisteredAs: candidate.alsoRegisteredAs } : {}),
    // Where the trial stands in the list the search kept, and — only when a reranker read it — how closely it reads against the summary (0–1).
    // Neither is a verdict about the patient.
    ...(Number.isInteger(candidate.rank) ? { rank: candidate.rank } : {}),
    ...(typeof candidate.relevance === "number" ? { relevance: candidate.relevance } : {}),
  };
}

/** The queries one list asks of each registry, in order: the condition first. @param {{ condition: string, terms: readonly string[] }} request */
export function candidateQueries(request) {
  return [{ kind: "condition", text: request.condition }, ...request.terms.map((term) => ({ kind: "term", text: term }))];
}

export { CTGOV_OPEN_STATUSES, CTIS_OPEN_STATUSES };
