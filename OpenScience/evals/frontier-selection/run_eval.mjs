#!/usr/bin/env node
/**
 * The 精选 score as an eval (c3-select S8; principle 6): the gold set's 248 items (two labellers, kappa 0.87, adjudicated; `gold.jsonl`) are scored
 * with the editor's own prompts on deepseek-flash, and `metrics.mjs` reads the result against the labels, overall and per genre, on the
 * dev split (odd `n`, where anything is fitted) and the test split (even `n`, reported only).
 *
 *   node evals/frontier-selection/run_eval.mjs --key-file <path> [--mode edit|score] [--split dev|test|all] [--only <n,n,...>]
 *       [--concurrency 6] [--max-cny 3] [--label <name>] [--out <file>]
 *
 * Modes:
 * - `edit` (default): the whole edit call as the pipeline makes it (`FrontierEditor#edit`, `FRONTIER_EDIT_INSTRUCTIONS`); the scores are the edit's.
 * - `score`: the standalone scoring call (`FrontierEditor#scoreItem`), the same rubric without the writing — what a rescore after a release uses.
 *
 * The model's raw parts are stored, never the clamped ones, and the code ceilings (`frontierScoreCeilings`) and the practice label's admission
 * are applied to them afterwards by `finish.mjs`, so a ceiling can be fitted on dev without another model call.
 * The key is read from the file inside this process and never printed; nothing is metered (no usage ledger); the run stops at --max-cny.
 * The input is what the pipeline shows the model, with the gold set's text (at most 1,200 characters) in place of the stored abstract or body.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FRONTIER_LANES, FRONTIER_SOURCE_TYPE_LABELS_ZH, frontierEvidenceFromPublicationTypes } from "../../packages/domain/index.mjs";
import { FRONTIER_EDITOR_VERSION, FrontierEditor, isChineseTitle } from "../../apps/server/src/frontierEditor.mjs";
import { callModelForControlPlane } from "../../apps/server/src/modelGateway.mjs";
import { loadGold, splitOf } from "./metrics.mjs";

/** The reference price of deepseek-flash, CNY per million tokens (`@evimed/domain` metering). */
const PRICE = Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 });
const here = dirname(fileURLToPath(import.meta.url));

/**
 * A gold item as the editor is given it (`FrontierPipeline#editItem`): a journal's text is an abstract, any other text the page's excerpt.
 * @param {any} row
 */
export function editItemOf(row) {
  const journal = row.source.type === "journal" || row.source.type === "preprint";
  const fixed = frontierEvidenceFromPublicationTypes(row.publication_types ?? []);
  return {
    titleRaw: row.title_raw, sourceName: row.source.name,
    sourceTypeLabel: /** @type {Record<string, string>} */ (FRONTIER_SOURCE_TYPE_LABELS_ZH)[row.source.type] ?? undefined,
    publishedAt: row.published ? `${row.published}T08:00:00Z` : null, datePrecision: "day", isChinese: isChineseTitle(row.title_raw),
    allowedLanes: FRONTIER_LANES.filter((lane) => lane !== "mixed"), evidenceFixed: fixed.evidenceType ? { type: fixed.evidenceType, basis: "pubmed-types" } : null,
    abstract: journal ? row.text_excerpt || null : null, summary: null, bodyExcerpt: journal ? null : row.text_excerpt || null,
    journal: row.journal ?? null, publicationTypes: row.publication_types ?? [], glossary: [], defaults: { lane: null, specialties: [] },
    genreFixed: ["safety", "social", "trial", "preprint", "roundup"].includes(row.genre) ? row.genre : null,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "key-file": { type: "string", default: resolve(here, "../../../.evimed-local/secrets/deepseek.api-key") },
      mode: { type: "string", default: "edit" }, split: { type: "string", default: "all" }, only: { type: "string" },
      concurrency: { type: "string", default: "6" }, "max-cny": { type: "string", default: "3" }, label: { type: "string", default: "run" }, out: { type: "string" },
    },
  });
  const apiKey = (await readFile(values["key-file"], "utf8")).trim();
  if (!apiKey) throw new Error("The DeepSeek key file is empty.");
  const maxCny = Number(values["max-cny"]) || 3;
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
  const only = values.only ? new Set(values.only.split(",").map(Number)) : null;
  const wanted = splitOf(loadGold(), /** @type {any} */ (values.split)).filter((row) => !only || only.has(row.n));
  /** @type {any[]} */
  const results = [];
  const queue = [...wanted];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try { results.push(await runCase(editor, row, values.mode)); }
      catch (error) { results.push({ n: row.n, id: row.id, error: /** @type {any} */ (error)?.code ?? String(error) }); }
      process.stderr.write(`frontier-selection: ${results.length}/${wanted.length} ¥${usage.cny.toFixed(3)}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, Number(values.concurrency) || 6)) }, worker));
  results.sort((a, b) => a.n - b.n);
  const out = values.out ?? join(here, "results", `${values.label}.json`);
  await mkdir(dirname(out), { recursive: true });
  const cost = { ...usage, cny: Math.round(usage.cny * 1000) / 1000 };
  await writeFile(out, `${JSON.stringify({ at: new Date().toISOString(), label: values.label, mode: values.mode, model: "deepseek-flash", editorVersion: FRONTIER_EDITOR_VERSION, usage: cost, results }, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify({ out, usage: cost, errors: results.filter((r) => r.error).length })}\n`);
}

/** @param {FrontierEditor} editor @param {any} row @param {string} mode */
async function runCase(editor, row, mode) {
  const item = editItemOf(row);
  if (mode === "score") {
    const scored = await /** @type {any} */ (editor).scoreItem(item, { genre: row.genre });
    return { n: row.n, id: row.id, mode, ...scored };
  }
  const edited = await editor.edit(item, { singleAttempt: false });
  const output = edited.output;
  return { n: row.n, id: row.id, mode, verification: edited.verification, scoresRaw: output?.scoresRaw ?? null, scores: output?.scores ?? null,
    evidenceType: output?.evidenceType ?? null, genre: output?.genre ?? null, flags: output?.flags ?? [], practice: output?.practice ?? null };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
