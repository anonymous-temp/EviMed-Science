#!/usr/bin/env node
/**
 * Metrics of the 精选 gold set (c3-select S8). Pure functions plus a small CLI that reads a run file (`run_eval.mjs`) or the live scores
 * stored with the gold set, and reports precision, recall and AUC for telling the editors' picks (`label.worth === "pick"`) from the
 * rest, overall and per genre, on the dev split (odd `n`, where anything is fitted) and the test split (even `n`, reported only).
 *
 *   node evals/frontier-selection/metrics.mjs [--run <run.json>] [--threshold N] [--split dev|test|all] [--by-genre]
 *
 * Without --run it reads the live scores and the live selection stored in gold.jsonl (what production did).
 * A model never judges here: the labels are the two labellers' (kappa 0.87), adjudicated.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));

/** The gold set, one item per line. */
export function loadGold(file = join(here, "gold.jsonl")) {
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

/** The dev split is the odd `n`, the test split the even. @param {{ n: number }[]} rows @param {"dev" | "test" | "all"} split */
export function splitOf(rows, split) {
  return split === "all" ? rows : rows.filter((row) => (split === "dev" ? row.n % 2 === 1 : row.n % 2 === 0));
}

/** Rank-sum AUC of `score` for positives against the rest, ties half; NaN when a side is empty. @param {any[]} rows @param {(r: any) => number} score @param {(r: any) => boolean} positive */
export function auc(rows, score, positive) {
  const pos = rows.filter(positive).map(score);
  const neg = rows.filter((row) => !positive(row)).map(score);
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Whether the labellers call the item a pick. @param {any} row */
export const isPick = (row) => row.label.worth === "pick";

/**
 * Precision and recall of a selection. @param {any[]} rows @param {(r: any) => boolean} selected
 */
export function selectionMetrics(rows, selected) {
  const chosen = rows.filter(selected);
  const hits = chosen.filter(isPick).length;
  const picks = rows.filter(isPick).length;
  return { n: rows.length, picks, selected: chosen.length, hits, precision: chosen.length ? hits / chosen.length : NaN, recall: picks ? hits / picks : NaN };
}

/** The practice label against the gold's `practice`: hits, misses and false positives. @param {any[]} rows @param {(r: any) => boolean} labelled */
export function practiceMetrics(rows, labelled) {
  const gold = rows.filter((row) => row.label.practice);
  const given = rows.filter(labelled);
  return { gold: gold.length, given: given.length, hits: given.filter((row) => row.label.practice).length,
    missed: gold.filter((row) => !labelled(row)).map((row) => row.n), falsePositives: given.filter((row) => !row.label.practice).map((row) => row.n) };
}

/** @param {number} value @param {number} [digits] */
export const fixed = (value, digits = 3) => (Number.isFinite(value) ? value.toFixed(digits) : "n/a");

/**
 * The highest threshold on `score` at which recall on `rows` is at least `minRecall` (the shipping rule fits it on dev and reports
 * it on test). @param {any[]} rows @param {(r: any) => number} score @param {number} minRecall
 */
export function thresholdForRecall(rows, score, minRecall) {
  const values = [...new Set(rows.map(score))].sort((a, b) => b - a);
  for (const threshold of values) {
    if (selectionMetrics(rows, (row) => score(row) >= threshold).recall >= minRecall) return threshold;
  }
  return values[values.length - 1];
}

/** The live scores as a run: what production stored. @param {any[]} gold */
export function liveRun(gold) {
  return gold.map((row) => ({ n: row.n, total: row.live.total, parts: { authority: row.live.authority, impact: row.live.impact, novelty: row.live.novelty, relevance: row.live.relevance },
    selected: row.live.selected, practice: false }));
}

async function main() {
  const { values } = parseArgs({ options: { run: { type: "string" }, threshold: { type: "string" }, split: { type: "string", default: "all" }, "by-genre": { type: "boolean", default: false } } });
  const gold = loadGold();
  const byN = new Map(gold.map((row) => [row.n, row]));
  const run = values.run ? JSON.parse(readFileSync(resolve(values.run), "utf8")).results.map((r) => ({ ...r })) : liveRun(gold);
  const rows = run.filter((r) => byN.has(r.n) && r.total != null).map((r) => ({ ...byN.get(r.n), ...r }));
  const threshold = values.threshold == null ? null : Number(values.threshold);
  for (const split of values.split === "all" ? ["dev", "test"] : [values.split]) {
    const part = splitOf(rows, /** @type {any} */ (split));
    const chosen = threshold == null ? (r) => r.selected === true : (r) => r.total >= threshold;
    const m = selectionMetrics(part, chosen);
    console.log(`${split}: n=${m.n} picks=${m.picks} selected=${m.selected} precision=${fixed(m.precision)} recall=${fixed(m.recall)} AUC(total)=${fixed(auc(part, (r) => r.total, isPick))}`);
    if (part[0]?.parts) console.log("  AUC parts: " + ["authority", "impact", "novelty", "relevance"].map((k) => `${k}=${fixed(auc(part, (r) => r.parts?.[k] ?? NaN, isPick))}`).join(" "));
    if (values["by-genre"]) {
      for (const genre of [...new Set(part.map((r) => r.genre))].sort()) {
        const g = part.filter((r) => r.genre === genre);
        const gm = selectionMetrics(g, chosen);
        console.log(`    ${genre.padEnd(11)} n=${g.length} picks=${gm.picks} sel=${gm.selected} hit=${gm.hits} AUC=${fixed(auc(g, (r) => r.total, isPick))}`);
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
