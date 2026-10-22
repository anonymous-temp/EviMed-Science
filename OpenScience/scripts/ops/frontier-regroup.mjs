#!/usr/bin/env node
/**
 * Group the frontier feed's last fourteen days again with the event layer's recall and grouping call (fr-events 2026-10-22).
 *
 * Until 2026-10-22 an earlier item was a candidate only when the two shared a drug, a trial or an organisation, and the model
 * answered yes / related / no: on production 2–4% of a day's events held two reports and no `follows` link was ever written.
 * This command walks the clustered items published in the feed in the window, oldest first, recalls each against the items
 * published before it the way a new item is recalled now, and — with `--apply` — asks the grouping call and places it again
 * (`FrontierEvents.regroupRecent`): an item alone in its event that is the same occurrence as an earlier one moves there and
 * its old event folds in (the old public id answers 308 for good); a development writes a `follows` link; a report that adds
 * nothing to its event's selected report leaves the selected feed and names it.
 *
 *   node scripts/ops/frontier-regroup.mjs                 report: items with candidates, the calls, what they would cost
 *   node scripts/ops/frontier-regroup.mjs --apply         ask and place again
 *   options: --days N (1–14, default 14), --since ISO (instead of --days: where a stopped run resumes),
 *            --concurrency N (1–8, default 4), --limit N (default 100000)
 *
 * Hidden knowledge:
 *
 * - The report asks nothing and writes nothing. Its cost is an estimate from the calls' measured size on production data
 *   (`GROUP_CALL_TOKENS`, the 2026-10-20 sample) at the reference price list's `deepseek-flash` row.
 * - The run is metered like every frontier call: purpose `frontier`, the operator account's internal project, the module's
 *   day budget (`OPEN_SCIENCE_FRONTIER_DAILY_BUDGET_CNY`) beside the feed's own work. When the day's budget is no longer `ok`
 *   it stops with `stopped: "budget"` and `resumeFrom`; `--since <resumeFrom>` the next day asks nothing twice. An item it
 *   placed is placed the same way if asked again, so a run repeated over the same days changes nothing.
 * - One run at a time (a session advisory lock): two would pay for every call twice.
 * - It needs the configuration the server runs with — the database, the DeepSeek key, the operator account
 *   (`OPEN_SCIENCE_OPERATOR_USERS`) — and the module switched on. It prints counts and codes, never a key.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DAY_MS = 24 * 3_600_000;
const REGROUP_LOCK = "evimed-frontier-regroup";
/**
 * What one grouping call measured on the 2026-10-20 production day (1,528 items, deepseek-flash): prompt tokens for the
 * instructions (served from the provider's cache after the first call), for the new report, and for each candidate event;
 * output tokens before the decisions and for each decision. A merge below 0.85 cosine adds a second look of about `pair`.
 */
export const GROUP_CALL_TOKENS = Object.freeze({ cached: 1_790, report: 520, perCandidate: 210, output: 120, outputPerCandidate: 60, pair: 1_400 });

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { apply: false, days: 14, since: /** @type {Date | null} */ (null), concurrency: 4, limit: 100_000 };
  const number = (/** @type {string} */ name, /** @type {string | undefined} */ value, /** @type {number} */ min, /** @type {number} */ max) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return parsed;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--days") options.days = number("--days", argv[++index], 1, 14);
    else if (argument === "--concurrency") options.concurrency = number("--concurrency", argv[++index], 1, 8);
    else if (argument === "--limit") options.limit = number("--limit", argv[++index], 1, 1_000_000);
    else if (argument === "--since") {
      const since = new Date(String(argv[++index] ?? ""));
      if (!Number.isFinite(since.getTime())) throw new Error("--since must be an ISO time");
      options.since = since;
    } else throw new Error(`unknown argument ${argument}; the options are --apply, --days N, --since ISO, --concurrency N, --limit N`);
  }
  return options;
}

/**
 * What asking would cost: one grouping call per item with candidates, its size by candidates, at a price row in CNY per
 * million tokens. Second looks are not counted (they need the answers); `pairCnyPerThousand` prices a thousand of them for scale.
 * @param {{ withCandidates: number, candidateEvents: number }} report
 * @param {{ cacheHit: number, cacheMiss: number, output: number }} price
 */
export function estimateRegroupCost({ withCandidates, candidateEvents }, price) {
  const cached = withCandidates * GROUP_CALL_TOKENS.cached;
  const prompt = withCandidates * GROUP_CALL_TOKENS.report + candidateEvents * GROUP_CALL_TOKENS.perCandidate;
  const output = withCandidates * GROUP_CALL_TOKENS.output + candidateEvents * GROUP_CALL_TOKENS.outputPerCandidate;
  const cny = (cached * price.cacheHit + prompt * price.cacheMiss + output * price.output) / 1_000_000;
  return { calls: withCandidates, promptTokens: cached + prompt, outputTokens: output, cny: Math.round(cny * 100) / 100,
    pairCnyPerThousand: Math.round((GROUP_CALL_TOKENS.pair * price.cacheMiss + 150 * price.output) / 10) / 100 };
}

/** @param {unknown} error */
function codeOf(error) {
  const code = /** @type {any} */ (error)?.code;
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : "frontier_regroup_failed";
}

/** @param {Record<string, unknown>} summary */
function report(summary) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) process.exitCode = 1;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { REFERENCE_PRICE_LIST }, { FrontierEditor }, { FrontierEvents }, { FrontierPipeline },
    { KnowledgePluginClient }, { KbEmbedder }, { UsageLedger }, { ensureFrontierProject }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("@evimed/domain"),
    import("../../apps/server/src/frontierEditor.mjs"),
    import("../../apps/server/src/frontierEvents.mjs"),
    import("../../apps/server/src/frontierPipeline.mjs"),
    import("../../apps/server/src/knowledgePluginClient.mjs"),
    import("../../apps/server/src/kbEmbedding.mjs"),
    import("../../apps/server/src/usageLedger.mjs"),
    import("../../apps/server/src/frontierWorker.mjs"),
  ]);
  const config = loadConfig();
  if (!config.frontierEnabled) {
    report({ ok: false, reason: "OPEN_SCIENCE_FRONTIER_ENABLED is false; there is no feed to group" });
    return;
  }
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) {
      report({ ok: false, reason: "no control-plane database" });
      return;
    }
    // The server's own composition: the embedder names the vectors compared (no embedding call is made), the editor makes the
    // calls under the module's budget, the pipeline reads that budget.
    const embedder = new KbEmbedder({ apiKey: config.dashscopeApiKey, model: config.kbEmbeddingModel, dimension: config.kbEmbeddingDimension,
      apiBase: config.kbEmbeddingApiBase, timeoutMs: config.kbEmbeddingTimeoutMs });
    const usageLedger = new UsageLedger(database);
    const editor = new FrontierEditor(config, { usageLedger });
    if (options.apply) editor.owner = await ensureFrontierProject({ store, config });
    const plugin = new KnowledgePluginClient({ baseUrl: config.knowledgePluginUrl, tokenFile: config.knowledgePluginTokenFile,
      timeoutMs: config.knowledgePluginTimeoutMs, minContract: config.knowledgePluginMinContract });
    const pipeline = new FrontierPipeline({ database, editor, plugin, embedder, config });
    const events = new FrontierEvents({ database, editor, embedder, config, budget: () => pipeline.budget(new Date()) });
    if (options.apply && !editor.available) {
      report({ ok: false, reason: "the frontier editor is not configured (DeepSeek key or operator account); nothing can be asked" });
      return;
    }
    const until = new Date();
    const since = options.since ?? new Date(until.getTime() - options.days * DAY_MS);
    await database.withClient(async (/** @type {any} */ lock) => {
      const acquired = await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [REGROUP_LOCK]);
      if (!acquired.rows[0]?.acquired) {
        report({ ok: false, reason: "another regroup of the frontier feed is running" });
        return;
      }
      try {
        const started = Date.now();
        const summary = await events.regroupRecent({ since, until, apply: options.apply, concurrency: options.concurrency, limit: options.limit,
          onProgress: (progress) => process.stderr.write(`frontier-regroup: ${progress.scanned}/${progress.items}\n`) });
        const estimate = options.apply ? null : estimateRegroupCost(summary, REFERENCE_PRICE_LIST.model["deepseek-flash"]);
        const budget = await pipeline.budget(new Date()).catch((/** @type {unknown} */ error) => ({ error: codeOf(error) }));
        report({ ok: summary.failed === 0 && (options.apply ? summary.stopped === null : true), since: since.toISOString(), until: until.toISOString(),
          ...summary, ...(estimate ? { estimate } : {}), counters: options.apply ? events.counters : undefined, budget, ms: Date.now() - started });
      } finally {
        await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [REGROUP_LOCK]);
      }
    });
  } finally {
    await store.close?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${codeOf(error)}: ${/** @type {any} */ (error)?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
