/**
 * The pure half of the precedent-retrieval comparison (algorithm round E5): the structural label of a pair of registry records, the metrics, and a
 * seeded bootstrap. No network, no model, no clock; `run.mjs` is what fetches and ranks.
 *
 * The labels are STRUCTURAL, NOT EXPERT. They are read off the MeSH terms ClinicalTrials.gov's own indexer attached to each record, never judged by
 * a person, and they are correlated with the words of the records (the indexer maps words to terms). They say which records the registry itself
 * files under the same condition and the same drug, or the same narrow chemical family: not which a pharmacist would call a good precedent.
 */

/** @param {number} seed */
export function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {unknown} value @returns {string[]} */
const terms = (value) => (Array.isArray(value) ? value : []).map((entry) => String(entry?.term ?? "").trim()).filter(Boolean);

/**
 * A ClinicalTrials.gov v2 study as the comparison reads it. `null` when it carries no MeSH term for its condition or its intervention: such a record
 * cannot be labelled, and is left out of the lists and of the queries rather than counted as a negative.
 * @param {any} study @returns {null | { id: string, title: string, conditions: string[], interventions: string[], drugNames: string[], phases: string[], allocation: string,
 *   hasResults: boolean, conditionMesh: string[], interventionMesh: string[], interventionAncestors: string[] }}
 */
export function recordOf(study) {
  const protocol = study?.protocolSection ?? {};
  const derived = study?.derivedSection ?? {};
  const id = String(protocol.identificationModule?.nctId ?? "");
  const conditionMesh = terms(derived.conditionBrowseModule?.meshes);
  const interventionMesh = terms(derived.interventionBrowseModule?.meshes);
  if (!id || !conditionMesh.length || !interventionMesh.length) return null;
  const interventions = Array.isArray(protocol.armsInterventionsModule?.interventions) ? protocol.armsInterventionsModule.interventions : [];
  return {
    id, title: String(protocol.identificationModule?.briefTitle ?? ""),
    conditions: (protocol.conditionsModule?.conditions ?? []).map(String),
    interventions: interventions.map((/** @type {any} */ entry) => String(entry?.name ?? "")).filter(Boolean),
    drugNames: interventions.filter((/** @type {any} */ entry) => ["DRUG", "BIOLOGICAL"].includes(String(entry?.type))).map((/** @type {any} */ entry) => String(entry.name)).filter(Boolean),
    phases: (protocol.designModule?.phases ?? []).map(String), allocation: String(protocol.designModule?.designInfo?.allocation ?? ""),
    hasResults: study?.hasResults === true,
    conditionMesh, interventionMesh, interventionAncestors: terms(derived.interventionBrowseModule?.ancestors),
  };
}

/**
 * The terms too common in the corpus to say anything about a drug or a family (Placebos, Organic Chemicals): held by more than `share` of its
 * records, as a descriptor or as an ancestor. Data-driven, so the cut follows the corpus it is run on.
 * @param {readonly ReturnType<typeof recordOf>[]} records @param {number} [share]
 * @returns {Set<string>}
 */
export function genericTerms(records, share = 0.03) {
  const held = new Map();
  const list = records.filter(Boolean);
  for (const record of list) {
    for (const term of new Set([...(record?.interventionMesh ?? []), ...(record?.interventionAncestors ?? [])])) held.set(term, (held.get(term) ?? 0) + 1);
  }
  return new Set([...held].filter(([, count]) => count > share * list.length).map(([term]) => term));
}

/**
 * How well a record is a precedent for a question trial, by what the registry's own indexing says. 2: the same condition and the same drug (a shared
 * intervention descriptor, however it is named in either record). 1: the same condition and the same narrow family (a shared chemical ancestor that
 * few records hold). 0: otherwise. Terms in `generic` never count.
 * @param {NonNullable<ReturnType<typeof recordOf>>} question @param {NonNullable<ReturnType<typeof recordOf>>} record @param {ReadonlySet<string>} generic
 * @returns {0 | 1 | 2}
 */
export function labelOf(question, record, generic) {
  if (question.id === record.id) return 0;
  const sameCondition = question.conditionMesh.some((term) => record.conditionMesh.includes(term));
  if (!sameCondition) return 0;
  if (question.interventionMesh.some((term) => !generic.has(term) && record.interventionMesh.includes(term))) return 2;
  const family = (/** @type {NonNullable<ReturnType<typeof recordOf>>} */ each) => [...each.interventionMesh, ...each.interventionAncestors];
  if (family(question).some((term) => !generic.has(term) && family(record).includes(term))) return 1;
  return 0;
}

/** @param {readonly number[]} gains in ranked order @param {number} k */
export function dcgAt(gains, k) {
  return gains.slice(0, k).reduce((sum, gain, at) => sum + (2 ** gain - 1) / Math.log2(at + 2), 0);
}

/** nDCG@k with the gains 0/1/2; 0 when there is nothing relevant to find. @param {readonly number[]} ranked gains in ranked order @param {number} k */
export function ndcgAt(ranked, k) {
  const ideal = dcgAt([...ranked].sort((a, b) => b - a), k);
  return ideal > 0 ? dcgAt(ranked, k) / ideal : 0;
}

/** @param {readonly number[]} ranked gains in ranked order, relevant = gain above 0 @param {number} k */
export function precisionAt(ranked, k) {
  const top = ranked.slice(0, k);
  return top.length ? top.filter((gain) => gain > 0).length / Math.min(k, ranked.length) : 0;
}

/** @param {readonly number[]} ranked */
export function averagePrecision(ranked) {
  let hits = 0;
  let sum = 0;
  ranked.forEach((gain, at) => { if (gain > 0) { hits += 1; sum += hits / (at + 1); } });
  return hits ? sum / hits : 0;
}

/** @param {readonly number[]} ranked */
export function reciprocalRank(ranked) {
  const at = ranked.findIndex((gain) => gain > 0);
  return at < 0 ? 0 : 1 / (at + 1);
}

/** The four numbers read of one ranked list. @param {readonly number[]} ranked gains in ranked order */
export function metricsOf(ranked) {
  return { ndcg10: ndcgAt(ranked, 10), p5: precisionAt(ranked, 5), map: averagePrecision(ranked), mrr: reciprocalRank(ranked) };
}

/**
 * The mean of per-query values with a percentile bootstrap interval over queries (the queries are the sample, not the records).
 * @param {readonly number[]} values @param {{ seed?: number, resamples?: number, level?: number }} [options]
 */
export function bootstrapMean(values, { seed = 1, resamples = 2000, level = 0.95 } = {}) {
  const n = values.length;
  const mean = n ? values.reduce((sum, each) => sum + each, 0) / n : 0;
  if (n < 2) return { mean, low: mean, high: mean, n };
  const random = seeded(seed);
  const means = Array.from({ length: resamples }, () => {
    let sum = 0;
    for (let at = 0; at < n; at += 1) sum += values[Math.floor(random() * n)];
    return sum / n;
  }).sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return { mean, low: means[Math.floor(tail * resamples)], high: means[Math.min(resamples - 1, Math.ceil((1 - tail) * resamples) - 1)], n };
}

/** The paired difference `a - b` over the same queries, with its bootstrap interval. @param {readonly number[]} a @param {readonly number[]} b */
export function pairedDifference(a, b, options = {}) {
  return bootstrapMean(a.map((value, at) => value - b[at]), options);
}
