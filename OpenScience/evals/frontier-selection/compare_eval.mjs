#!/usr/bin/env node
/**
 * The comparative editor pass as an eval (c3-select S2): the candidates above a floor of the pointwise score are shuffled into batches of
 * about 20, each judged in one call ("which of these belong in 精选 today"), K times with different shuffles, and the picks are counted
 * against the labellers' on the same split. Run it beside the pointwise score and compare at the same volume.
 *
 *   node evals/frontier-selection/compare_eval.mjs --rows <finish.mjs rows> --key-file <path> [--split dev|test|all] [--floor 45]
 *       [--batch 20] [--shuffles 2] [--seed 1] [--max-cny 1] [--out <file>]
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FRONTIER_SOURCE_TYPE_LABELS_ZH } from "../../packages/domain/index.mjs";
import { FrontierEditor } from "../../apps/server/src/frontierEditor.mjs";
import { callModelForControlPlane } from "../../apps/server/src/modelGateway.mjs";
import { auc, fixed, isPick, loadGold, selectionMetrics, splitOf } from "./metrics.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PRICE = Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 });

/** A small seeded shuffle (mulberry32), so a run can be repeated. @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** @template T @param {T[]} list @param {() => number} random */
const shuffled = (list, random) => { const a = [...list]; for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

async function main() {
  const { values } = parseArgs({ options: {
    rows: { type: "string" }, "key-file": { type: "string", default: resolve(here, "../../../.evimed-local/secrets/deepseek.api-key") },
    split: { type: "string", default: "dev" }, floor: { type: "string", default: "45" }, batch: { type: "string", default: "20" },
    shuffles: { type: "string", default: "2" }, seed: { type: "string", default: "1" }, "max-cny": { type: "string", default: "1" }, out: { type: "string" },
  } });
  const apiKey = (await readFile(values["key-file"], "utf8")).trim();
  const maxCny = Number(values["max-cny"]);
  const usage = { calls: 0, cacheHit: 0, cacheMiss: 0, output: 0, cny: 0 };
  /** @type {typeof callModelForControlPlane} */
  const callModel = async (context, call) => {
    if (usage.cny >= maxCny) throw Object.assign(new Error("limit"), { code: "usage_budget_exceeded" });
    const body = await callModelForControlPlane(context, call);
    const used = body?.usage ?? {};
    const hit = Number(used.prompt_cache_hit_tokens ?? 0);
    usage.calls += 1; usage.cacheHit += hit; usage.cacheMiss += Number(used.prompt_cache_miss_tokens ?? Math.max(0, Number(used.prompt_tokens ?? 0) - hit)); usage.output += Number(used.completion_tokens ?? 0);
    usage.cny = (usage.cacheHit * PRICE.cacheHit + usage.cacheMiss * PRICE.cacheMiss + usage.output * PRICE.output) / 1_000_000;
    return body;
  };
  const editor = new FrontierEditor({ deepseekProviderEnabled: true, deepseekApiKey: apiKey, deepseekBaseUrl: "https://api.deepseek.com", frontierModel: "deepseek-flash" },
    { owner: { userId: "eval", projectId: "eval" }, callModel });
  const byN = new Map(loadGold().map((row) => [row.n, row]));
  const pre = JSON.parse(await readFile(resolve(values.rows), "utf8")).results.filter((r) => r.total != null).map((r) => ({ ...byN.get(r.n), ...r }));
  const part = splitOf(pre, /** @type {any} */ (values.split));
  const pool = part.filter((row) => row.total >= Number(values.floor));
  const size = Number(values.batch);
  const votes = new Map(pool.map((row) => [row.n, 0]));
  const reasons = new Map();
  const K = Number(values.shuffles);
  for (let k = 0; k < K; k += 1) {
    const order = shuffled(pool, rng(Number(values.seed) * 1000 + k));
    const batches = Math.max(1, Math.round(order.length / size));
    const jobs = Array.from({ length: batches }, (_, b) => order.filter((_, i) => i % batches === b));
    await Promise.all(jobs.map(async (batch) => {
      const result = await editor.compareBatch(batch.map((row) => ({ sourceName: row.source.name, authority: row.source.authority, genre: row.genre, title: row.title_zh || row.title_raw, excerpt: row.text_excerpt })));
      if (result.error) { process.stderr.write(`batch failed: ${result.error}\n`); return; }
      for (const pick of result.picks) { const row = batch[pick.index]; votes.set(row.n, (votes.get(row.n) ?? 0) + 1); reasons.set(row.n, pick.reason); }
    }));
    process.stderr.write(`shuffle ${k + 1}/${K} ¥${usage.cny.toFixed(3)}\n`);
  }
  const report = { split: values.split, floor: Number(values.floor), pool: pool.length, poolPicks: pool.filter(isPick).length, K, usage };
  for (let need = 1; need <= K; need += 1) {
    const m = selectionMetrics(part, (row) => (votes.get(row.n) ?? 0) >= need);
    report[`votes>=${need}`] = { selected: m.selected, hits: m.hits, precision: fixed(m.precision), recall: fixed(m.recall) };
  }
  // The pointwise selection of the same volume, and a vote-then-score ranking.
  const rank = part.map((row) => ({ ...row, rank: (votes.get(row.n) ?? 0) * 1000 + row.total }));
  report.auc = { pointwise: fixed(auc(part, (r) => r.total, isPick)), votesThenScore: fixed(auc(rank, (r) => r.rank, isPick)) };
  for (let need = 1; need <= K; need += 1) {
    const count = part.filter((row) => (votes.get(row.n) ?? 0) >= need).length;
    const top = [...part].sort((a, b) => b.total - a.total).slice(0, count).map((r) => r.n);
    const m = selectionMetrics(part, (row) => top.includes(row.n));
    report[`pointwise-same-volume(${count})`] = { hits: m.hits, precision: fixed(m.precision), recall: fixed(m.recall) };
  }
  const out = values.out ?? resolve(here, "results", "compare.json");
  await writeFile(out, `${JSON.stringify({ report, votes: [...votes.entries()], reasons: [...reasons.entries()] }, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
}

await main();
