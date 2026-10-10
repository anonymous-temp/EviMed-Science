import { AsyncLocalStorage } from 'node:async_hooks';
import { isPeak, priceUsage } from '@evimed/domain';
import { ChannelIntentClassifier } from '../../apps/server/src/channels/intent.mjs';
import { FrontierEditor } from '../../apps/server/src/frontierEditor.mjs';
import { legacyRegisterPattern } from '../../apps/server/src/reportRegisterJudge.mjs';

/**
 * The paths Jev sites replace, run as production runs them, for `run.mjs --incumbent`.
 *
 * "As production runs them" is the point: each arm is the production class or
 * pattern itself (`ChannelIntentClassifier.classifyWithModel`, the frozen
 * register comparator, ...), reached through the production model call with a
 * `fetch` that only measures. No prompt is restated here, so the arm cannot
 * drift from the path it stands for.
 */

/** DeepSeek is billed by token, so the incumbent's cost is the provider's own count priced on the reference list. */
const reference = { resourceType: 'model' };

/**
 * A `fetch` that times each model call, reads the provider's own token counts and prices them, and attributes them to the
 * arm call that made them (`measure`). A 429 or a 5xx is retried after a pause, and the pause is taken out of the arm's latency:
 * the arms are not being tested for how they behave under a rate limit, and a measuring run must not be the thing that hammers a provider.
 * @param {{ inner?: typeof fetch, retries?: number, sleep?: (ms: number) => Promise<void> }} [options]
 */
export function createMeter({ inner = globalThis.fetch, retries = 3, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  /** @type {AsyncLocalStorage<{ calls: any[], paused: number }>} */
  const storage = new AsyncLocalStorage();
  const totals = { calls: 0, retried: 0, billedCny: 0, tokens: { cacheHit: 0, cacheMiss: 0, output: 0 } };
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    let attempt = 0;
    for (;;) {
      const started = Date.now();
      const response = await inner(url, init);
      const text = await response.text();
      const ms = Date.now() - started;
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        attempt += 1;
        totals.retried += 1;
        const pause = 1500 * 2 ** attempt;
        await sleep(pause);
        const store = storage.getStore();
        if (store) store.paused += pause + ms;
        continue;
      }
      /** @type {any} */
      let usage = null;
      let model = '';
      try { usage = JSON.parse(text)?.usage ?? null; model = String(JSON.parse(String(init?.body ?? '{}')).model ?? ''); } catch { /* A body that is not JSON has no usage. */ }
      const hit = Number(usage?.prompt_cache_hit_tokens) || 0;
      const miss = Number.isFinite(Number(usage?.prompt_cache_miss_tokens)) ? Number(usage.prompt_cache_miss_tokens) : Math.max(0, (Number(usage?.prompt_tokens) || 0) - hit);
      const output = Number(usage?.completion_tokens) || 0;
      // The list price (no night discount) is what the arms are compared on; what was billed today is what the budget is kept against.
      const listed = priceUsage({ ...reference, model, cacheHit: hit, cacheMiss: miss, output, peak: true });
      const billed = priceUsage({ ...reference, model, cacheHit: hit, cacheMiss: miss, output, peak: isPeak(new Date()) });
      const call = { ms, status: response.status, model, tokens: { cacheHit: hit, cacheMiss: miss, output }, costCny: listed.cost, billedCny: billed.cost, attempts: attempt + 1 };
      totals.calls += 1;
      totals.billedCny += billed.cost;
      totals.tokens.cacheHit += hit; totals.tokens.cacheMiss += miss; totals.tokens.output += output;
      storage.getStore()?.calls.push(call);
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
  };
  /**
   * Run one arm call and return what it answered with what its model calls took.
   * @template T @param {() => Promise<T>} work
   */
  const measure = async (work) => {
    const store = { calls: /** @type {any[]} */ ([]), paused: 0 };
    const started = Date.now();
    const result = await storage.run(store, work);
    const ms = Date.now() - started - store.paused;
    return { result, ms, cost: store.calls.reduce((sum, call) => sum + call.costCny, 0), billedCny: store.calls.reduce((sum, call) => sum + call.billedCny, 0), calls: store.calls.length };
  };
  return { fetchImpl, measure, totals };
}

/**
 * @param {{ config: Record<string, any>, meter: ReturnType<typeof createMeter> }} deps
 * @returns {Record<string, (example: any) => Promise<{ value: any, ms: number, cost: number, billedCny: number, failure: string | null }>>}
 */
export function createIncumbents({ config, meter }) {
  const channel = new ChannelIntentClassifier(config, { fetchImpl: meter.fetchImpl });
  // The frontier editor as the feed runs it, with Jev left out: its own prompts, its own validation, one thinking-off Flash call.
  // The cases keep what Jev is shown (title, summary, dates, identifiers), not the source's name the editor's prompt adds, so the
  // editor here reads a little less than it does in the feed.
  const editor = new FrontierEditor(config, { owner: { userId: 'judge-calibration', projectId: 'judge-calibration' }, fetchImpl: meter.fetchImpl });
  return {
    J5: async (example) => {
      const batch = example.input.items.map((/** @type {any} */ item, /** @type {number} */ index) => ({
        key: String(index + 1), title: item.title, sourceName: '', excerpt: item.summary ?? '', allowedLanes: item.allowedCategories }));
      const { result, ms, cost, billedCny } = await meter.measure(() => editor.screen(batch));
      const items = batch.flatMap((/** @type {any} */ entry, /** @type {number} */ index) => {
        const verdict = result.verdicts.get(entry.key);
        return verdict ? [{ id: String(index + 1), isMedical: verdict.medical, isNews: verdict.news, category: verdict.lane, specialties: verdict.specialties, roundup: verdict.digest }] : [];
      });
      const failed = batch.length - items.length;
      return { value: { items }, ms, cost, billedCny, failure: failed ? `${failed}_of_${batch.length}_without_a_verdict` : null };
    },
    J6: async (example) => {
      const report = (/** @type {any} */ side) => ({ sourceName: '', titleRaw: side.title, titleZh: side.title, summaryZh: side.summary ?? '', publishedAt: side.publishedAt,
        doi: side.doi, pmid: side.pmid, registryIds: side.registryIds });
      const { result, ms, cost, billedCny } = await meter.measure(() => editor.judgeSameEvent({ report: report(example.input.left), candidates: [report(example.input.right)] }, false));
      const verdict = result.verdicts?.[0];
      return { value: verdict ? { relation: verdict === 'yes' ? 'same' : verdict === 'related' ? 'related' : 'different' } : null,
        ms, cost, billedCny, failure: verdict ? null : result.error ?? 'frontier_same_event_invalid' };
    },
    // The Feishu triage as production runs it without Jev: one thinking-off Flash call. A model that cannot be reached answers with the
    // safe default intent (`source: 'fallback'`), which is what a researcher would get, so it is scored as such.
    J2: async (example) => {
      const input = example.input;
      const { result: old, ms, cost, billedCny } = await meter.measure(() => channel.classifyWithModel({
        userId: 'judge-calibration', projectId: input.currentProjectId, text: input.message, projects: input.projects,
        runningTask: input.currentTask ? { question: input.currentTask } : null,
      }));
      return { value: { switch_to: old.switchTo, has_request: old.hasRequest, continues_running_task: old.continuesRunningTask },
        ms, cost, billedCny, failure: old.source === 'model' ? null : old.failure ?? 'unavailable' };
    },
    // The topic-selection engine's relevance gate has no second pass without Jev: every record that passed the literal gate is kept
    // (科研选题 task_service.py `_filter_relevant_records`). Scored as the verdict "related" for every record.
    J15: async () => ({ value: { relation: 'related' }, ms: 0, cost: 0, billedCny: 0, failure: null }),
    // Same-trial duplicates are found today only by DOI, PMID or an identical title (Meta engine multi_search.py), and the cases carry
    // titles that differ, so the original path flags none of them: the verdict "different" for every pair.
    J18: async () => ({ value: { relation: 'different' }, ms: 0, cost: 0, billedCny: 0, failure: null }),
    // The report-register notice before Jev was no notice. The frozen pattern that stood beside it as a drift comparator is the
    // nearest thing to an incumbent verdict, and it is scored as one; it costs nothing and takes no time.
    J4: async (example) => {
      const started = Date.now();
      const value = { leakage: legacyRegisterPattern.test(example.input.line) };
      return { value, ms: Date.now() - started, cost: 0, billedCny: 0, failure: null };
    },
  };
}
