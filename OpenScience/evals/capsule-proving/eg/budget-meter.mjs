// Read-only lane accounting. Keep costs after throwaway accounts are deleted; never inspect another lane's users or database.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadConfig } from '../../../apps/server/src/config.mjs';
import { OpenVikingClient } from '../../../apps/server/src/openVikingClient.mjs';
import { OpenVikingSessions } from '../../../apps/server/src/openVikingSessions.mjs';
import { priceUsage, REFERENCE_PRICE_LIST } from '../../../packages/domain/index.mjs';
import { taskUsage } from '../run/lab.mjs';
import { read, save, sleep } from './common.mjs';
const require = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
const { Client } = require('pg');
const root = '/srv/evimed/runs';
const file = `${root}/eg-spend-20261111.json`;
const sessions = new OpenVikingSessions(new OpenVikingClient(loadConfig()), { timeoutMs: 10_000 });
const state = await read(file, { accounts: {}, tasks: {}, judgements: {} });
state.directJudgements ??= {};
for (;;) {
  const errors = [], missing = [];
  const dirs = (await fs.readdir(root, { withFileTypes: true })).filter(d => d.isDirectory() && /^(g1pp-eg-|g10-eg-|g3-eg-)/.test(d.name));
  for (const dir of dirs) {
    const out = `${root}/${dir.name}`, p = await read(`${out}/provenance.json`);
    if (!p) continue;
    const database = `evimed_test_${dir.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 60);
    const db = new Client({ host: '127.0.0.1', port: p.args.pgPort, user: 'coder', database, connectionTimeoutMillis: 5000 });
    try {
      await db.connect();
      const accounts = (await db.query("SELECT user_id,coalesce(sum(actual_cost),0)::float8 AS cost,coalesce(sum(reserved_cost) FILTER (WHERE status IN ('reserved','uncertain')),0)::float8 AS open FROM evimed_usage.model_requests GROUP BY user_id")).rows;
      for (const a of accounts) {
        const key = `${database}:${a.user_id}`, old = state.accounts[key] ?? {};
        state.accounts[key] = { cost: Math.max(old.cost ?? 0, a.cost), open: a.open };
      }
      const commits = (await db.query('SELECT user_id,engine_session,task_id FROM evimed_memory.native_commits WHERE task_id IS NOT NULL ORDER BY created_at')).rows;
      for (let i = 0; i < commits.length; i += 4) await Promise.all(commits.slice(i, i + 4).map(async c => {
        const key = `${database}:${c.user_id}:${c.task_id}`;
        if (state.tasks[key]?.terminal) return;
        try {
          const task = await sessions.task(c.user_id, c.task_id);
          if (!task) { missing.push(key); return; }
          state.tasks[key] = { session: `${database}:${c.user_id}:${c.engine_session}`, usage: taskUsage(task), terminal: ['completed', 'failed'].includes(task.status) };
        } catch (e) { errors.push(`task:${e.code ?? e.name}`); }
      }));
    } catch (e) { errors.push(`${database}:${e.code ?? e.name}`); }
    finally { await db.end().catch(() => {}); }
    const walk = async folder => {
      for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
        if (/sealed/i.test(entry.name)) continue;
        const full = `${folder}/${entry.name}`;
        if (entry.isDirectory()) await walk(full);
        else if (/^(usage|usage-.+)\.json$/.test(entry.name)) {
          const a = (await read(full))?.account;
          if (!a) continue;
          // G1/G10 receipt owner is in the neighbouring account file; G3 receipt names carry it.
          const owner = (await read(`${folder}/account.json`))?.userId ?? entry.name.replace(/^usage-/, '').replace(/\.json$/, '');
          const key = `${database}:${owner}`, old = state.accounts[key] ?? {};
          state.accounts[key] = { cost: Math.max(old.cost ?? 0, a.actualCost ?? 0), open: Math.max(old.open ?? 0, a.reservedCost ?? 0) };
        }
      }
    };
    for (const child of ['cases', 'units', 'browser']) await walk(`${out}/${child}`);
    for (const j of await read(`${out}/scores/actual-judge-results.json`, [])) if (j.requestId && j.usage) {
      const u = j.usage, cached = Number(u.prompt_tokens_details?.cached_tokens ?? 0);
      state.judgements[j.requestId] = priceUsage({ resourceType: 'model', model: j.model, cacheHit: cached,
        cacheMiss: Math.max(0, Number(u.prompt_tokens ?? 0) - cached), output: Number(u.completion_tokens ?? 0), peak: true }).cost;
    }
    for (const line of (await fs.readFile(`${out}/judge-usage.jsonl`, 'utf8').catch(() => '')).split('\n').filter(Boolean)) {
      let j; try { j = JSON.parse(line); } catch { errors.push('direct_judge_usage_partial'); continue; }
      const u = j.usage, cached = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);
      if (!Number.isFinite(Number(u.prompt_tokens)) || !Number.isFinite(Number(u.completion_tokens))) { errors.push('direct_judge_usage_missing'); continue; }
      const priced = priceUsage({ resourceType: 'model', model: j.model, cacheHit: cached,
        cacheMiss: Number(u.prompt_cache_miss_tokens ?? Math.max(0, Number(u.prompt_tokens ?? 0) - cached)), output: Number(u.completion_tokens ?? 0), peak: true });
      if (priced.priced) state.directJudgements[j.id] = priced.cost; else errors.push('direct_judge_model_unpriced');
    }
  }
  const perSession = new Map();
  for (const task of Object.values(state.tasks)) {
    const old = perSession.get(task.session) ?? { promptTokens: 0, completionTokens: 0 };
    perSession.set(task.session, { promptTokens: Math.max(old.promptTokens, task.usage.promptTokens), completionTokens: Math.max(old.completionTokens, task.usage.completionTokens) });
  }
  const engineTokens = [...perSession.values()].reduce((a, b) => ({ promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens }), { promptTokens: 0, completionTokens: 0 });
  const controlPlaneCny = Object.values(state.accounts).reduce((n, a) => n + a.cost, 0);
  const openCny = Object.values(state.accounts).reduce((n, a) => n + a.open, 0);
  const engineUncachedPeakCny = priceUsage({ resourceType: 'model', model: 'deepseek-flash', cacheMiss: engineTokens.promptTokens, output: engineTokens.completionTokens, peak: true }).cost;
  const judgeCny = [...Object.values(state.judgements), ...Object.values(state.directJudgements)].reduce((n, c) => n + c, 0);
  Object.assign(state, { at: new Date().toISOString(), pricingVersion: REFERENCE_PRICE_LIST.version, controlPlaneCny, openCny, engineTokens, engineUncachedPeakCny, judgeCny,
    estimatedUpperCny: controlPlaneCny + openCny + engineUncachedPeakCny + judgeCny, errors, missing,
    note: 'Observed control-plane and Qwen costs plus conservative uncached peak-price engine tokens; reserve CNY 20 for unobserved setup, embeddings and failed vendor requests. Shared balance change includes other lanes.' });
  await save(file, state);
  process.stdout.write(`${state.at} EG cost controlPlane=${controlPlaneCny.toFixed(3)} engineUncachedPeak=${engineUncachedPeakCny.toFixed(3)} judge=${judgeCny.toFixed(3)} open=${openCny.toFixed(3)} errors=${errors.length} missing=${missing.length}\n`);
  await sleep(60_000);
}
