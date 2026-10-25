#!/usr/bin/env node
/**
 * The faithfulness check as an eval (c3-faith, 2026-10-25; principle 6): does the check beyond numbers (`frontierFaith.mjs`) find the
 * categorical errors LLM summaries of studies make — a design upgraded, the direction of the main result turned over, another
 * comparator, another population, a stronger certainty — and leave a faithful 导读 alone? `faith_cases.json` holds real study items,
 * for each one or more drafts with ONE error injected into the published 导读 by a model (`kind`, the words it changed), and the
 * published 导读 as the negative of the same source. Nothing here gates anything: it is a notice metric.
 *
 *   node evals/frontier-writing/faith_eval.mjs --key-file <path> [--max-cny 1.5] [--concurrency 4] [--repair] [--kind design] [--limit N] [--out file]
 *
 * Measured: per kind, the drafts the check flagged (any rule, and the right kind of rule); on the negatives, the drafts it flagged
 * (a false alarm); the share of flagged drafts that were seeded (precision against this set); with `--repair`, the loop's outcomes
 * (repaired, trimmed, emptied) and whether the injected words are gone from the draft it leaves; calls and cost at the reference
 * price of deepseek-flash. The study facts are extracted once per source, in this run. The key is read from the file inside this
 * process and never printed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FrontierEditor } from "../../apps/server/src/frontierEditor.mjs";
import { FRONTIER_FAITH_VERSION, frontierFaithCheck, frontierSentences } from "../../apps/server/src/frontierFaith.mjs";
import { faithSource, frontierFaithCheckLead } from "../../apps/server/src/frontierFaithStep.mjs";
import { FRONTIER_STUDY_FACTS_VERSION, frontierStudyFactsView, frontierWriteStudyFacts } from "../../apps/server/src/frontierStudyFacts.mjs";
import { callModelForControlPlane } from "../../apps/server/src/modelGateway.mjs";

const PRICE = Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 });
const here = dirname(fileURLToPath(import.meta.url));

/** The rule names that answer to each seeded kind. */
const RULE_KIND = Object.freeze({ design: "design", direction: "direction", comparator: "comparator", population: "population", certainty: "certainty" });

/**
 * What a set of results measures (pure, so a saved run is measured again without a model call).
 * @param {Array<{ kind: string | null, clean: boolean, flagged: boolean, rightKind: boolean, outcome?: string, wordsGone?: boolean | null }>} rows
 */
export function summarizeFaith(rows) {
  const seeded = rows.filter((row) => !row.clean);
  const negatives = rows.filter((row) => row.clean);
  /** @type {Record<string, { n: number, flagged: number, rightKind: number }>} */
  const byKind = {};
  for (const row of seeded) {
    const entry = (byKind[/** @type {string} */ (row.kind)] ??= { n: 0, flagged: 0, rightKind: 0 });
    entry.n += 1; entry.flagged += row.flagged ? 1 : 0; entry.rightKind += row.rightKind ? 1 : 0;
  }
  const truePositives = seeded.filter((row) => row.flagged).length;
  const falseAlarms = negatives.filter((row) => row.flagged).length;
  const repairs = seeded.filter((row) => row.outcome);
  return {
    seeded: seeded.length, negatives: negatives.length, byKind,
    recall: seeded.length ? Math.round((truePositives / seeded.length) * 1000) / 1000 : null,
    recallRightKind: seeded.length ? Math.round((seeded.filter((row) => row.rightKind).length / seeded.length) * 1000) / 1000 : null,
    falseAlarms, falseAlarmRate: negatives.length ? Math.round((falseAlarms / negatives.length) * 1000) / 1000 : null,
    precisionAgainstSeeded: truePositives + falseAlarms ? Math.round((truePositives / (truePositives + falseAlarms)) * 1000) / 1000 : null,
    repair: repairs.length ? { outcomes: repairs.reduce((/** @type {Record<string, number>} */ sum, row) => ({ ...sum, [/** @type {string} */ (row.outcome)]: (sum[/** @type {string} */ (row.outcome)] ?? 0) + 1 }), {}),
      wordsGoneAfterRepair: `${repairs.filter((row) => row.outcome === "repaired" && row.wordsGone).length}/${repairs.filter((row) => row.outcome === "repaired").length}` } : null,
  };
}

async function main() {
  const { values } = parseArgs({ options: { "key-file": { type: "string", default: resolve(here, "../../../.evimed-local/secrets/deepseek.api-key") },
    "max-cny": { type: "string", default: "1.5" }, concurrency: { type: "string", default: "4" }, repair: { type: "boolean", default: false },
    kind: { type: "string" }, limit: { type: "string" }, out: { type: "string" } } });
  const apiKey = (await readFile(values["key-file"], "utf8")).trim();
  if (!apiKey) throw new Error("The DeepSeek key file is empty.");
  const maxCny = Number(values["max-cny"]) || 1.5;
  const usage = { calls: 0, cacheHit: 0, cacheMiss: 0, output: 0, cny: 0 };
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
  const editor = new FrontierEditor({ deepseekProviderEnabled: true, deepseekApiKey: apiKey, deepseekBaseUrl: "https://api.deepseek.com", frontierModel: "deepseek-flash" },
    { owner: { userId: "eval", projectId: "eval" }, callModel });
  const file = JSON.parse(await readFile(join(here, "faith_cases.json"), "utf8"));
  const sources = new Map(file.sources.map((/** @type {any} */ source) => [source.id, source]));
  const drafts = file.drafts.filter((/** @type {any} */ draft) => (!values.kind || draft.clean || draft.kind === values.kind)).slice(0, values.limit ? Number(values.limit) : undefined);
  /** @type {Map<string, Promise<any>>} */
  const facts = new Map();
  const factsOf = (/** @type {any} */ source) => {
    if (!facts.has(source.id)) facts.set(source.id, frontierWriteStudyFacts(editor, { sourceName: source.sourceName, titleRaw: source.titleRaw, text: source.text, kind: source.textKind })
      .then((result) => ({ view: frontierStudyFactsView(result.facts), error: result.error })));
    return facts.get(source.id);
  };
  /** @type {any[]} */
  const results = [];
  const queue = [...drafts];
  const lane = async () => {
    for (let draft = queue.shift(); draft; draft = queue.shift()) {
      const source = /** @type {any} */ (sources.get(draft.source));
      const input = { sourceName: source.sourceName, titleRaw: source.titleRaw, text: source.text, kind: source.textKind, genre: source.genre };
      try {
        const { view, error } = await factsOf(source);
        if (error || !view) { results.push({ id: draft.id, kind: draft.kind, clean: draft.clean, flagged: false, rightKind: false, error: error ?? "no-facts" }); continue; }
        const text = faithSource(input);
        if (values.repair) {
          const run = await frontierFaithCheckLead(editor, { facts: view, lead: draft.draft, previous: null, input, source: text });
          const flagged = run.result.first.length > 0;
          results.push({ id: draft.id, kind: draft.kind, clean: draft.clean, flagged, rightKind: run.result.first.some((m) => m.kind === RULE_KIND[/** @type {keyof typeof RULE_KIND} */ (draft.kind)]),
            outcome: run.result.outcome, wordsGone: draft.changed ? !String(run.lead ?? "").includes(draft.changed) : null, rules: run.result.first.map((m) => m.rule) });
        } else {
          const units = frontierSentences(draft.draft).map((sentence, index) => ({ id: `s${index}`, text: sentence }));
          const check = await frontierFaithCheck(editor, { facts: view, units, source: text });
          results.push({ id: draft.id, kind: draft.kind, clean: draft.clean, flagged: check.mismatches.length > 0,
            rightKind: check.mismatches.some((m) => m.kind === RULE_KIND[/** @type {keyof typeof RULE_KIND} */ (draft.kind)]), rules: check.mismatches.map((m) => m.rule), candidates: check.candidates.length, error: check.error });
        }
      } catch (error) { results.push({ id: draft.id, kind: draft.kind, clean: draft.clean, flagged: false, rightKind: false, error: /** @type {any} */ (error)?.code ?? String(error) }); }
      process.stderr.write(`faith-eval: ${results.length}/${drafts.length} ¥${usage.cny.toFixed(3)}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, Number(values.concurrency) || 4)) }, lane));
  const scored = results.filter((row) => !row.error);
  const out = values.out ?? join(here, "results", `faith-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z.json`);
  const summary = { ...summarizeFaith(scored), errors: results.length - scored.length };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({ at: new Date().toISOString(), model: "deepseek-flash", versions: { faith: FRONTIER_FAITH_VERSION, studyFacts: FRONTIER_STUDY_FACTS_VERSION },
    repair: values.repair, usage: { ...usage, cny: Math.round(usage.cny * 1000) / 1000 }, summary, results }, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify({ out, usage: { ...usage, cny: Math.round(usage.cny * 1000) / 1000 }, summary }, null, 1)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
