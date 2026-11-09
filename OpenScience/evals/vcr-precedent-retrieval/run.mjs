#!/usr/bin/env node
/**
 * Does the precedent ranking beat the word overlap it replaced? (algorithm round E5)
 *
 * For a set of conditions, the ClinicalTrials.gov list a search for the condition returns is the candidate list; a random sample of its trials are the
 * questions (each asks with the condition and the drug names its record states, as a run would write them); every other trial in the list is labelled
 * by the registry's own MeSH indexing (`score.mjs`: 2 the same drug, 1 the same narrow family, 0 otherwise) and the list is ranked by:
 *
 *   registry     the order the registry returned it in (what you get with no ranking at all)
 *   overlap_old  the word overlap of `precedentSimilarity` as it was, with "has results" worth 0.15
 *   overlap_new  the same overlap without "has results"
 *   bm25         BM25 alone (`rankPrecedentCandidates` with no embedder)
 *   embedding    the knowledge base's embedder alone
 *   hybrid       the shipped ranking: 0.4 BM25 + 0.6 embedder
 *   hybrid_equal the two channels at equal weight (not shipped; shown because the weights were fixed before this was run, not tuned on it)
 *
 * Beside nDCG@10, P@5, MAP and MRR, "name-blind recall@10" is the share of the relevant trials whose intervention names share no word with the
 * question's drug names (a brand and a generic, a drug and its class mate) that are in the first ten: the part of the task the words cannot see.
 *
 * THE LABELS ARE STRUCTURAL, NOT EXPERT (see score.mjs and the README). Nothing here says which precedent a pharmacist would pick.
 *
 *   node evals/vcr-precedent-retrieval/run.mjs [--embed-key-file <path>] [--conditions 25] [--queries 8] [--seed 20261103] [--out results/<name>.json]
 *
 * The embedder is the knowledge base's own (`KbEmbedder`, the pin in deps-version.json). Its key is read from --embed-key-file (or
 * OPEN_SCIENCE_DASHSCOPE_API_KEY_FILE, the name the server's configuration reads), held in memory, and never printed or written. Without a key the
 * embedding rows are not computed and the output says so. No model other than the embedder is called.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bootstrapMean, genericTerms, labelOf, metricsOf, pairedDifference, recordOf, seeded } from "./score.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = (/** @type {string} */ file) => pathToFileURL(path.resolve(here, "../../apps/server/src", file)).href;

/** English condition strings across the specialties; a search for each is one candidate list. */
export const CONDITIONS = Object.freeze([
  "breast cancer", "non-small cell lung cancer", "type 2 diabetes", "heart failure", "rheumatoid arthritis", "asthma", "COPD", "ulcerative colitis",
  "Crohn's disease", "hypertension", "migraine", "multiple sclerosis", "psoriasis", "major depressive disorder", "schizophrenia", "HIV infection",
  "hepatitis C", "colorectal cancer", "prostate cancer", "multiple myeloma", "chronic kidney disease", "osteoporosis", "atrial fibrillation", "stroke", "epilepsy",
]);
const FIELDS = "NCTId,BriefTitle,Condition,InterventionName,InterventionType,ConditionMeshTerm,InterventionMeshTerm,InterventionAncestorTerm,Phase,DesignAllocation,HasResults";
const METHODS = ["registry", "overlap_old", "overlap_new", "bm25", "embedding", "hybrid", "hybrid_equal"];

/** @param {string[]} argv */
export function parseArguments(argv) {
  /** @type {Record<string, any>} */
  const options = { conditions: CONDITIONS.length, queries: 8, seed: 20261103, delayMs: 1200 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => { const next = argv[index + 1]; if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`); index += 1; return next; };
    if (flag === "--embed-key-file") options.embedKeyFile = value();
    else if (flag === "--conditions") options.conditions = Math.max(1, Math.min(CONDITIONS.length, Number(value()) || CONDITIONS.length));
    else if (flag === "--queries") options.queries = Math.max(1, Math.min(40, Number(value()) || 8));
    else if (flag === "--seed") options.seed = Number(value()) || 1;
    else if (flag === "--delay-ms") options.delayMs = Math.max(0, Number(value()) || 0);
    else if (flag === "--out") options.out = value();
    else throw new Error(`unknown argument ${flag}`);
  }
  return options;
}

/** One condition's list, as the registry answers a search for it. @param {string} condition */
async function fetchList(condition) {
  const url = `https://clinicaltrials.gov/api/v2/studies?query.cond=${encodeURIComponent(condition)}&pageSize=100&fields=${FIELDS}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return /** @type {any[]} */ ((await response.json()).studies ?? []);
    } catch (error) {
      if (attempt >= 4) throw new Error(`the registry did not answer for "${condition}": ${/** @type {any} */ (error)?.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

/** The knowledge base's embedder from a key file and the pin in deps-version.json; the key is held in memory. @param {string} keyFile */
async function embedderFrom(keyFile) {
  const { KbEmbedder } = await import(server("kbEmbedding.mjs"));
  const pin = JSON.parse(await readFile(path.resolve(here, "../../deps-version.json"), "utf8")).openviking?.embedding ?? {};
  return new KbEmbedder({ apiKey: (await readFile(keyFile, "utf8")).trim(), model: String(pin.model ?? ""), dimension: Number(pin.dimension ?? 1024), apiBase: String(pin.apiBase ?? ""), timeoutMs: 30_000 });
}

/** @template T @param {readonly T[]} list @param {() => number} random @returns {T[]} */
function shuffled(list, random) {
  const out = [...list];
  for (let at = out.length - 1; at > 0; at -= 1) { const to = Math.floor(random() * (at + 1)); [out[at], out[to]] = [out[to], out[at]]; }
  return out;
}

/** @param {ReturnType<typeof recordOf>} record the shape `registry.search` hands over */
const candidateOf = (record) => ({
  registry: "clinicaltrials.gov", registryId: record?.id ?? "", title: record?.title ?? "", conditions: record?.conditions ?? [], interventions: record?.interventions ?? [],
  phases: record?.phases ?? [], allocation: record?.allocation ?? "", hasResults: record?.hasResults === true,
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { precedentSimilarity } = await import(server("vcrEvidence.mjs"));
  const { rankPrecedentCandidates, PRECEDENT_FUSION } = await import(server("vcrPrecedentRanking.mjs"));
  const embedKeyFile = options.embedKeyFile ?? process.env.OPEN_SCIENCE_DASHSCOPE_API_KEY_FILE ?? "";
  const embedder = embedKeyFile ? await embedderFrom(embedKeyFile) : null;
  const random = seeded(options.seed);

  // 1. The candidate lists, as the registry answers them.
  /** @type {Map<string, NonNullable<ReturnType<typeof recordOf>>[]>} */
  const lists = new Map();
  for (const condition of CONDITIONS.slice(0, options.conditions)) {
    const records = (await fetchList(condition)).map(recordOf).filter((/** @type {any} */ record) => record);
    lists.set(condition, /** @type {any} */ (records));
    process.stderr.write(`fetched ${records.length} labelled records for "${condition}"\n`);
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }
  const corpus = [...new Map([...lists.values()].flat().map((record) => [record.id, record])).values()];
  const generic = genericTerms(corpus);

  // 2. The questions: trials of the list with a named drug and at least two other trials in the list to find.
  /** @type {Array<{ condition: string, question: NonNullable<ReturnType<typeof recordOf>>, others: NonNullable<ReturnType<typeof recordOf>>[], gains: Map<string, number> }>} */
  const queries = [];
  for (const [condition, records] of lists) {
    let taken = 0;
    for (const question of shuffled(records.filter((record) => record.drugNames.length), random)) {
      if (taken >= options.queries) break;
      const others = records.filter((record) => record.id !== question.id);
      const gains = new Map(others.map((record) => [record.id, labelOf(question, record, generic)]));
      if ([...gains.values()].filter((gain) => gain > 0).length < 2) continue;
      queries.push({ condition, question, others, gains });
      taken += 1;
    }
  }

  // 3. Every ranker over every question's list.
  /** @type {Record<string, Array<ReturnType<typeof metricsOf> & { blind10?: number }>>} */
  const byMethod = Object.fromEntries(METHODS.map((method) => [method, []]));
  let positives = 0;
  let listed = 0;
  for (const query of queries) {
    const target = { condition: query.question.conditions[0] ?? query.condition, intervention: query.question.drugNames.slice(0, 3).join(", ") };
    const candidates = query.others.map((record) => {
      const item = candidateOf(record);
      return { ...item, similarity: precedentSimilarity({ pico: { conditions: item.conditions, interventions: item.interventions.map((/** @type {string} */ name) => ({ name })) },
        design: { phases: item.phases, allocation: item.allocation, hasResults: item.hasResults } }, target) };
    });
    const gainOf = (/** @type {{ registryId: string }} */ candidate) => query.gains.get(candidate.registryId) ?? 0;
    positives += [...query.gains.values()].filter((gain) => gain > 0).length;
    listed += query.gains.size;
    // The positives that share no word of their intervention names with the question's drug names: what the words cannot see, and the meaning is for.
    const questionWords = new Set(query.question.drugNames.flatMap((name) => name.toLowerCase().match(/[a-z0-9]+/g) ?? []));
    const blind = new Set(query.others.filter((record) => (query.gains.get(record.id) ?? 0) > 0
      && !record.interventions.some((name) => (name.toLowerCase().match(/[a-z0-9]+/g) ?? []).some((word) => questionWords.has(word)))).map((record) => record.id));
    /** @param {readonly any[]} ordered */
    const record = (method, ordered) => {
      byMethod[method].push({ ...metricsOf(ordered.map(gainOf)),
        ...(blind.size ? { blind10: ordered.slice(0, 10).filter((/** @type {any} */ candidate) => blind.has(candidate.registryId)).length / Math.min(10, blind.size) } : {}) });
    };
    /** Stable: ties keep the order the registry answered in. */
    const sortedBy = (/** @type {(candidate: any) => number} */ score) => [...candidates].sort((a, b) => score(b) - score(a));
    record("registry", candidates);
    record("overlap_old", sortedBy((candidate) => 0.35 * candidate.similarity.parts.condition + 0.3 * candidate.similarity.parts.intervention
      + 0.1 * candidate.similarity.parts.phase + 0.1 * candidate.similarity.parts.design + 0.15 * (candidate.hasResults ? 1 : 0)));
    record("overlap_new", sortedBy((candidate) => candidate.similarity.score));
    record("bm25", (await rankPrecedentCandidates({ candidates, target, embedder: null })).candidates);
    if (embedder) {
      const { candidates: ranked, ranking } = await rankPrecedentCandidates({ candidates, target, embedder });
      // The shipped ranking falls back to the words when the embedder does not answer; a comparison must not report that as the hybrid.
      if (ranking.mode !== "hybrid") throw new Error(`the embedder did not answer (${ranking.fallback ?? ranking.mode}): the hybrid was not measured`);
      record("hybrid", ranked);
      const cosines = ranked.map((candidate) => candidate.similarity.parts.embedding);
      const [low, high] = [Math.min(...cosines), Math.max(...cosines)];
      const stretched = (/** @type {any} */ candidate) => (high > low ? (candidate.similarity.parts.embedding - low) / (high - low) : 0);
      record("embedding", [...ranked].sort((a, b) => b.similarity.parts.embedding - a.similarity.parts.embedding));
      record("hybrid_equal", [...ranked].sort((a, b) => (0.5 * b.similarity.parts.bm25 + 0.5 * stretched(b)) - (0.5 * a.similarity.parts.bm25 + 0.5 * stretched(a))));
    }
  }

  // 4. The numbers.
  const measured = METHODS.filter((method) => byMethod[method].length);
  const column = (/** @type {string} */ method, /** @type {string} */ metric) => byMethod[method].map((/** @type {any} */ each) => each[metric]).filter((value) => value !== undefined);
  const METRICS = ["ndcg10", "p5", "map", "mrr", "blind10"];
  const summary = Object.fromEntries(measured.map((method) => [method, Object.fromEntries(METRICS.map((metric) => [metric, bootstrapMean(column(method, metric), { seed: options.seed })]))]));
  const against = (/** @type {string} */ base) => Object.fromEntries(measured.filter((method) => method !== base).map((method) => [method,
    Object.fromEntries(["ndcg10", "map", "blind10"].map((metric) => [metric, pairedDifference(column(method, metric), column(base, metric), { seed: options.seed })]))]));
  const result = {
    at: new Date().toISOString(), seed: options.seed, labels: "structural (MeSH indexing of ClinicalTrials.gov), not expert",
    embedder: embedder ? { model: embedder.model, dimension: embedder.dimension } : null,
    fusion: PRECEDENT_FUSION,
    conditions: [...lists.keys()], records: corpus.length, genericTerms: generic.size, queries: queries.length, queriesWithNameBlindPositives: column("registry", "blind10").length,
    positiveShare: listed ? Math.round(positives / listed * 1000) / 1000 : 0, meanListSize: queries.length ? Math.round(listed / queries.length * 10) / 10 : 0,
    summary, pairedAgainstOverlapOld: against("overlap_old"), pairedAgainstBm25: against("bm25"), pairedAgainstRegistryOrder: against("registry"),
    pool: Object.fromEntries([...lists].map(([condition, records]) => [condition, records.map((record) => record.id)])),
  };
  const out = path.resolve(here, options.out ?? `results/${result.at.slice(0, 10)}${embedder ? "" : "-lexical-only"}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  const fmt = (/** @type {{ mean: number, low: number, high: number }} */ each) => `${each.mean.toFixed(3)} [${each.low.toFixed(3)}, ${each.high.toFixed(3)}]`;
  process.stdout.write(`${queries.length} questions over ${lists.size} conditions, ${corpus.length} labelled records, mean list ${result.meanListSize}, ${(result.positiveShare * 100).toFixed(1)}% of a list is relevant`
    + `${embedder ? "" : "; NO EMBEDDER: embedding, hybrid and hybrid_equal not computed"}\n`);
  process.stdout.write(`${"method".padEnd(14)}${"nDCG@10".padEnd(24)}${"P@5".padEnd(24)}${"MAP".padEnd(24)}${"MRR".padEnd(24)}name-blind recall@10 (${result.queriesWithNameBlindPositives} questions)\n`);
  for (const method of measured) process.stdout.write(`${method.padEnd(14)}${METRICS.map((metric) => fmt(/** @type {any} */ (summary)[method][metric]).padEnd(24)).join("")}\n`);
  process.stdout.write(`written ${path.relative(process.cwd(), out)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1; });
}
