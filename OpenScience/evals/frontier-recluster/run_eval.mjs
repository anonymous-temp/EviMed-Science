#!/usr/bin/env node
/**
 * The re-clustering sweep's judge as an eval (c3-cluster 2026-10-25; principle 6): labelled pairs of real events (`pairs.jsonl`: same,
 * related or different, with the reason; the events of those pairs in `events.json`, from a read of the production feed of
 * 2026-10-25), each sent through the prompts that ship — the batch call (`FRONTIER_RECLUSTER_INSTRUCTIONS`) and, for each `SAME`, the
 * second look (`FRONTIER_RECLUSTER_PAIR_INSTRUCTIONS`) — on deepseek-flash through the platform's own `FrontierEditor`. Nothing here
 * is judged by a model; the labels are the file's. The labels are one person's reading of titles and sources, written before any run
 * of the model; a pair marked "(judgement)" in its reason is one a second reader could place differently.
 *
 *   node evals/frontier-recluster/run_eval.mjs --key-file <path> [--repeat 1] [--max-cny 2] [--seed 7] [--out <file>]
 *   node evals/frontier-recluster/run_eval.mjs --key-file <path> --sample <events-4d.jsonl> [--as-of 2026-10-25T12:00:00Z]
 *
 * The first form measures the judge on the labelled pairs: the confusion matrix of the batch call, and the merge decision (`SAME` in
 * the batch call and in the second look) — its precision (the costly error is a wrong merge) and recall over the `same` labels, with
 * the transitive plan (`frontierReclusterPlan`) applied. The second form runs the whole sweep's decisions over a read of the feed
 * (`events-4d.jsonl`, one JSON event with its members per line): the candidate pairs the code makes (keys and titles; the sample has no
 * vectors), every verdict, and the merges and links the plan would apply, for a person to read — it reports counts and the model
 * cost, the precision is what that person finds. Tokens and a cost at the reference price are counted and the run stops at
 * `--max-cny`. The key is read from the file inside this process and never printed; nothing is metered and nothing is written but the
 * result file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FrontierEditor } from "../../apps/server/src/frontierEditor.mjs";
import {
  FRONTIER_RECLUSTER, frontierReclusterPairs, frontierReclusterPlan, judgeReclusterPairs, reclusterPlanEntry,
} from "../../apps/server/src/frontierRecluster.mjs";
import { callModelForControlPlane } from "../../apps/server/src/modelGateway.mjs";

/** The reference price of deepseek-flash, CNY per million tokens (`@evimed/domain` metering). */
const PRICE = Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 });
const here = dirname(fileURLToPath(import.meta.url));
/** A deterministic shuffle (mulberry32), so batches are not all of one label. @template T @param {T[]} list @param {number} seed */
function shuffled(list, seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The pairs judged by the code that ships; a pair never reached (a spent budget) has no verdict. @param {any} editor @param {Array<{ a: any, b: any }>} pairs @param {any} stats */
async function judge(editor, pairs, stats) {
  const { verdicts } = await judgeReclusterPairs({ callJson: (messages, limits) => editor.callJson(messages, limits), pairs, stats });
  return verdicts.map((verdict) => verdict ?? { relation: null, confidence: 0, reason: "", second: null, secondMade: false, confirmed: false });
}

/** @param {any} raw @param {number} index */
function eventOf(raw, index) {
  return { id: String(index + 1), publicId: raw.id, title: raw.title, digest: null, firstAt: raw.firstAt, lastAt: raw.lastAt, entityKeys: raw.entityKeys ?? [],
    members: raw.members.map((member) => ({ ...member, registryIds: [] })) };
}

async function labelled(/** @type {any} */ editor, /** @type {{ seed: number }} */ options, /** @type {any} */ stats) {
  const { events } = JSON.parse(await readFile(join(here, "events.json"), "utf8"));
  const events_ = events.map(eventOf);
  const byPublic = new Map(events_.map((event) => [event.publicId, event]));
  const labels = (await readFile(join(here, "pairs.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const oriented = labels.map((label) => {
    const [x, y] = [byPublic.get(label.a), byPublic.get(label.b)];
    const older = Date.parse(x.firstAt) <= Date.parse(y.firstAt) ? [x, y] : [y, x];
    return { label, a: older[0], b: older[1] };
  });
  const order = shuffled(oriented, options.seed);
  const verdicts = await judge(editor, order, stats);
  const rows = order.map((pair, index) => ({ a: pair.a.publicId, b: pair.b.publicId, truth: pair.label.label, kind: pair.label.kind, why: pair.label.why,
    relation: verdicts[index].relation, confidence: verdicts[index].confidence ?? null, reason: verdicts[index].reason ?? null,
    second: verdicts[index].second?.relation ?? null, confirmed: verdicts[index].confirmed === true }));
  const truthOf = (/** @type {any} */ row) => ({ same: "SAME", related: "RELATED", different: "DIFFERENT" })[/** @type {"same"} */ (row.truth)];
  const matrix = {};
  for (const row of rows) {
    const key = `${truthOf(row)}→${row.relation ?? "none"}`;
    matrix[key] = (matrix[key] ?? 0) + 1;
  }
  // The plan over every judged pair (the transitive merges and the veto), and whether each merged group lies inside one true cluster.
  const plan = frontierReclusterPlan(order.map((pair, index) => reclusterPlanEntry(pair, verdicts[index])));
  const parent = new Map(events_.map((event) => [event.id, event.id]));
  const find = (/** @type {string} */ id) => { let root = id; while (parent.get(root) !== root) root = /** @type {string} */ (parent.get(root)); return root; };
  for (const pair of oriented) if (pair.label.label === "same") parent.set(find(pair.a.id), find(pair.b.id));
  const merged = plan.merges.map((merge) => {
    const ids = [merge.survivor, ...merge.absorbed];
    const names = ids.map((id) => events_.find((event) => event.id === id)?.publicId);
    return { events: names, correct: new Set(ids.map(find)).size === 1 };
  });
  const mergedPairs = (/** @type {typeof plan.merges} */ groups) => groups.flatMap((group) => {
    const ids = [group.survivor, ...group.absorbed];
    return ids.flatMap((x, i) => ids.slice(i + 1).map((y) => [x, y]));
  });
  const truePairs = oriented.filter((pair) => pair.label.label === "same").length;
  const mergedTrue = mergedPairs(plan.merges).filter(([x, y]) => find(x) === find(y)).length;
  const mergedAll = mergedPairs(plan.merges).length;
  const batchSame = rows.filter((row) => row.relation === "SAME");
  const round = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;
  return {
    pairs: rows.length, truth: { same: oriented.filter((p) => p.label.label === "same").length, related: oriented.filter((p) => p.label.label === "related").length,
      different: oriented.filter((p) => p.label.label === "different").length },
    matrix,
    batch: { sameCalls: batchSame.length, sameCorrect: batchSame.filter((row) => row.truth === "same").length,
      precision: batchSame.length ? round(batchSame.filter((row) => row.truth === "same").length / batchSame.length) : null,
      recall: round(rows.filter((row) => row.truth === "same" && row.relation === "SAME").length / Math.max(1, truePairs)) },
    merge: { confirmedPairs: rows.filter((row) => row.confirmed).length, confirmedCorrect: rows.filter((row) => row.confirmed && row.truth === "same").length,
      precision: rows.filter((row) => row.confirmed).length ? round(rows.filter((row) => row.confirmed && row.truth === "same").length / rows.filter((row) => row.confirmed).length) : null,
      recall: round(rows.filter((row) => row.confirmed && row.truth === "same").length / Math.max(1, truePairs)) },
    plan: { groups: plan.merges.length, mergedPairs: mergedAll, mergedPairsCorrect: mergedTrue, vetoed: plan.vetoed,
      precision: mergedAll ? round(mergedTrue / mergedAll) : null, recall: round(mergedTrue / Math.max(1, truePairs)), groups_: merged },
    errors: rows.filter((row) => (row.truth === "same") !== (row.confirmed)).map((row) => ({ a: row.a, b: row.b, truth: row.truth, batch: row.relation, second: row.second, why: row.why, reason: row.reason })),
    relatedFound: rows.filter((row) => row.truth === "related" && row.relation === "RELATED").length,
    rows,
  };
}

async function sample(/** @type {any} */ editor, /** @type {string} */ path, /** @type {string} */ asOf, /** @type {any} */ stats) {
  const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const PRIMARY = new Set(["paper", "preprint", "regulatory", "guideline"]);
  const events = lines.map((line, index) => ({ id: String(index + 1), publicId: line.public_id, title: line.title, digest: null,
    firstAt: line.first_at.replace(/Z$/, ":00Z"), lastAt: line.last_at.replace(/Z$/, ":00Z"),
    entityKeys: [...new Set(line.members.flatMap((member) => member.keys ?? []))],
    members: line.members.map((member) => ({ id: member.id, titleZh: member.title, titleRaw: member.title_raw, sourceName: member.source,
      primary: PRIMARY.has(member.genre), publishedAt: member.at.replace(/Z$/, ":00Z"), registryIds: [] })) }));
  const now = Date.parse(asOf);
  const anchors = events.filter((event) => Date.parse(event.lastAt) >= now - FRONTIER_RECLUSTER.recentMs);
  const { pairs, candidates } = frontierReclusterPairs({ anchors, pool: events, max: 100_000 });
  const verdicts = await judge(editor, pairs, stats);
  const rows = pairs.map((pair, index) => ({ a: pair.a.publicId, b: pair.b.publicId, titleA: pair.a.title, titleB: pair.b.title, score: pair.score,
    signals: pair.signals, relation: verdicts[index].relation, reason: verdicts[index].reason ?? null, second: verdicts[index].second?.relation ?? null,
    secondReason: verdicts[index].second?.reason ?? null, confirmed: verdicts[index].confirmed === true }));
  const plan = frontierReclusterPlan(pairs.map((pair, index) => reclusterPlanEntry(pair, verdicts[index])));
  const count = (/** @type {string} */ relation) => rows.filter((row) => row.relation === relation).length;
  return { events: events.length, anchors: anchors.length, candidates, judged: rows.length, same: count("SAME"), related: count("RELATED"), different: count("DIFFERENT"),
    unjudged: rows.filter((row) => !row.relation).length, confirmedSame: rows.filter((row) => row.confirmed).length,
    plan: { groups: plan.merges.length, vetoed: plan.vetoed, capped: plan.capped, links: plan.links.length },
    merges: plan.merges.map((merge) => [merge.survivor, ...merge.absorbed].map((id) => {
      const event = events.find((e) => e.id === id);
      return { id: event?.publicId, title: event?.title };
    })), rows };
}

async function main() {
  const { values } = parseArgs({ options: {
    "key-file": { type: "string", default: resolve(here, "../../../.evimed-local/secrets/deepseek.api-key") },
    repeat: { type: "string", default: "1" }, "max-cny": { type: "string", default: "2" }, seed: { type: "string", default: "7" }, out: { type: "string" },
    sample: { type: "string" }, "as-of": { type: "string", default: "2026-10-25T12:00:00Z" },
  } });
  const apiKey = (await readFile(values["key-file"], "utf8")).trim();
  if (!apiKey) throw new Error("The DeepSeek key file is empty.");
  const maxCny = Number(values["max-cny"]) || 2;
  const usage = { calls: 0, cacheHit: 0, cacheMiss: 0, output: 0, cny: 0 };
  const stats = { calls: 0, failures: 0, secondLooks: 0, secondAgreed: 0 };
  /** @type {typeof callModelForControlPlane} */
  const callModel = async (context, call) => {
    if (usage.cny >= maxCny) throw Object.assign(new Error("The eval's spending limit is reached."), { code: "usage_budget_exceeded" });
    const body = await callModelForControlPlane(context, call);
    const used = body?.usage ?? {};
    const hit = Number(used.prompt_cache_hit_tokens ?? 0);
    const miss = Number(used.prompt_cache_miss_tokens ?? Math.max(0, Number(used.prompt_tokens ?? 0) - hit));
    usage.calls += 1; usage.cacheHit += hit; usage.cacheMiss += miss; usage.output += Number(used.completion_tokens ?? 0);
    usage.cny = (usage.cacheHit * PRICE.cacheHit + usage.cacheMiss * PRICE.cacheMiss + usage.output * PRICE.output) / 1_000_000;
    return body;
  };
  const editor = new FrontierEditor({ deepseekProviderEnabled: true, deepseekApiKey: apiKey, deepseekBaseUrl: "https://api.deepseek.com",
    frontierModel: "deepseek-flash" }, { owner: { userId: "eval", projectId: "eval" }, callModel });
  const runs = [];
  for (let repeat = 0; repeat < Math.max(1, Number(values.repeat) || 1); repeat += 1) {
    try {
      runs.push(values.sample
        ? { repeat: repeat + 1, ...(await sample(editor, resolve(values.sample), values["as-of"], stats)) }
        : { repeat: repeat + 1, ...(await labelled(editor, { seed: Number(values.seed) + repeat }, stats)) });
    } catch (error) {
      runs.push({ repeat: repeat + 1, error: /** @type {any} */ (error)?.code ?? String(error) });
    }
    process.stderr.write(`frontier-recluster: run ${repeat + 1} ¥${usage.cny.toFixed(3)} (${usage.calls} calls)\n`);
  }
  const out = values.out ?? join(here, "results", `${values.sample ? "sample" : "run"}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({ model: "deepseek-flash", ranAt: new Date().toISOString(), usage, failures: stats.failures, runs }, null, 1)}\n`);
  const brief = runs.map((run) => (run.error ? run : Object.fromEntries(Object.entries(run).filter(([key]) => !["rows", "errors", "merges"].includes(key)))));
  process.stdout.write(`${JSON.stringify({ out, usage, failures: stats.failures, runs: brief }, null, 1)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
