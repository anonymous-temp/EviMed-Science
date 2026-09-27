import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLUGIN_ID, PLUGIN_SUPPORT_SNAPSHOT, pluginRegistryFrom } from '../src/pluginService.mjs';
import { HttpError } from '../src/security.mjs';
import { PluginApplyWorker, applyPluginCandidate, jobPluginId, pluginFailure } from '../src/pluginApplyWorker.mjs';
const candidate={revision:2,enabled:false,settings:{timeoutMs:5000}};
const previous={revision:1,enabled:true,settings:{timeoutMs:4000}};
test('candidate failure restores and independently verifies the previous configuration',async()=>{
  const calls=[];
  const runtime={replacePluginRuntime:async(_p,config)=>{calls.push(['start',config.revision]);return {generation:String(config.revision)};},
    probePlugin:async(_p,config)=>{calls.push(['probe',config.revision]);if(config.revision===2)throw new Error('candidate');return {generation:'1'};},
    stop:async()=>calls.push(['stop'])};
  const result=await applyPluginCandidate(runtime,{},candidate,previous,async()=>{});
  assert.equal(result.phase,'rolled_back');assert.deepEqual(result.effective,previous);
  assert.deepEqual(calls,[['start',2],['probe',2],['start',1],['probe',1]]);
});
test('failed rollback reports unavailable and never labels unverified config effective',async()=>{
  const runtime={replacePluginRuntime:async()=>{},probePlugin:async()=>{throw new Error('failed');},stop:async()=>{}};
  const result=await applyPluginCandidate(runtime,{},candidate,previous,async()=>{});
  assert.equal(result.phase,'unavailable');assert.equal(result.effective,null);
});
test('lost authority does not start rollback or publish a result',async()=>{
  let starts=0;
  const runtime={replacePluginRuntime:async()=>{starts++;},probePlugin:async()=>{throw new Error('failed');},stop:async()=>{}};
  let checks=0;const guard=async()=>{if(++checks>1)throw Object.assign(new Error('lost'),{code:'product_job_lease_lost'});};
  await assert.rejects(applyPluginCandidate(runtime,{},candidate,previous,guard),{code:'product_job_lease_lost'});
  assert.equal(starts,1);
});

// --- why an apply ended where it did (production, 2026-09-27) --------------
// The first production apply of a project configuration ended `unavailable` /
// `plugin_rollback_failed` with every error discarded, and with no rollback
// attempted: a first configuration has nothing proven to roll back to, and the
// runtime was simply stopped.
const defaults={revision:0,enabled:true,settings:{timeoutMs:15000}};
const kernelRefusal=()=>new HttpError(502,'runtime_session_error','citation_probe_gateway_failed: cite_health: Crossref API HTTP 429');

test('a failed rollback records both failures and is the only outcome called plugin_rollback_failed',async()=>{
  const runtime={replacePluginRuntime:async()=>{},stop:async()=>{},
    probePlugin:async(_p,config)=>{throw config.revision===2?kernelRefusal():new HttpError(502,'plugin_probe_invalid','revision 0, expected 1');}};
  const result=await applyPluginCandidate(runtime,{},candidate,previous,async()=>{},PLUGIN_ID,defaults);
  assert.equal(result.phase,'unavailable');assert.equal(result.error,'plugin_rollback_failed');
  assert.deepEqual(result.detail,{
    apply:{code:'runtime_session_error',message:'citation_probe_gateway_failed: cite_health: Crossref API HTTP 429'},
    restored:'previous',
    rollback:{code:'plugin_probe_invalid',message:'revision 0, expected 1'},
  });
});

test('a first configuration that fails is not a failed rollback: the runtime restarts on the defaults, which are probed',async()=>{
  /** @type {any[]} */ const calls=[];
  const runtime={replacePluginRuntime:async(_p,config)=>{calls.push(['start',config.revision]);},
    probePlugin:async(_p,config)=>{calls.push(['probe',config.revision]);if(config.revision===2)throw kernelRefusal();return {generation:'defaults'};},
    stop:async()=>calls.push(['stop'])};
  const result=await applyPluginCandidate(runtime,{},candidate,null,async()=>{},PLUGIN_ID,defaults);
  assert.deepEqual(calls,[['start',2],['probe',2],['start',0],['probe',0]],'restarted on the defaults, never stopped');
  assert.equal(result.phase,'rolled_back');assert.equal(result.error,'plugin_apply_failed');
  assert.deepEqual(result.effective,defaults);assert.equal(result.generation,'defaults');
  assert.deepEqual(result.detail,{apply:{code:'runtime_session_error',message:'citation_probe_gateway_failed: cite_health: Crossref API HTTP 429'},restored:'default'});
});

test('defaults that start but do not prove are left running and reported failed, with both reasons',async()=>{
  /** @type {any[]} */ const calls=[];
  const runtime={replacePluginRuntime:async(_p,config)=>{calls.push(['start',config.revision]);},
    probePlugin:async()=>{throw kernelRefusal();},stop:async()=>calls.push(['stop'])};
  const result=await applyPluginCandidate(runtime,{},candidate,null,async()=>{},PLUGIN_ID,defaults);
  assert.equal(result.phase,'failed');assert.equal(result.error,'plugin_apply_failed');assert.equal(result.effective,null);
  assert.equal(calls.some(([step])=>step==='stop'),false,'the runtime every unconfigured project runs is not stopped for failing a probe');
  assert.deepEqual(Object.keys(result.detail),['apply','restored','restore']);
  assert.equal(result.detail.restore.code,'runtime_session_error');
});

test('defaults that cannot start leave the runtime stopped and say so',async()=>{
  /** @type {any[]} */ const calls=[];
  const runtime={replacePluginRuntime:async(_p,config)=>{calls.push(['start',config.revision]);if(config.revision===0)throw new HttpError(429,'runtime_limit_exceeded','Too many running runtimes.');},
    probePlugin:async()=>{throw kernelRefusal();},stop:async()=>calls.push(['stop'])};
  const result=await applyPluginCandidate(runtime,{},candidate,null,async()=>{},PLUGIN_ID,defaults);
  assert.equal(result.phase,'unavailable');assert.equal(result.error,'plugin_apply_failed');
  assert.deepEqual(result.detail.restore,{code:'runtime_limit_exceeded',message:'Too many running runtimes.'});
  assert.deepEqual(calls.at(-1),['stop']);
});

test('a step failure keeps its code and a bounded one-line message, whatever was thrown',()=>{
  assert.deepEqual(pluginFailure(new HttpError(502,'plugin_probe_invalid','tools [], expected\n["cite_health"]')),{code:'plugin_probe_invalid',message:'tools [], expected ["cite_health"]'});
  assert.deepEqual(pluginFailure(new TypeError('x is undefined')),{code:'plugin_step_failed',message:'x is undefined'});
  assert.deepEqual(pluginFailure(Object.assign(new Error('connect ECONNREFUSED'),{code:'ECONNREFUSED'})),{code:'ECONNREFUSED',message:'connect ECONNREFUSED'});
  assert.equal(pluginFailure(new Error('m'.repeat(1000))).message.length,300);
  assert.deepEqual(pluginFailure('plain'),{code:'plugin_step_failed',message:'plain'});
});

// --- the plugin a job is about -------------------------------------------
// Everything below exists because three modules downstream of the plugin
// registry addressed exactly one document per project by the default id. A
// second registered bundle would have been discoverable, configurable, saved
// and enqueued, and then applied out of dsh-cite's document. The bar is that
// dsh-cite's path is byte-identical: the same document id in every statement,
// the same plugin named to the probe.
const citeDocument = 'project:one:dsh-cite';
const notesRegistry = pluginRegistryFrom(
  { communityToolBundles: [...PLUGIN_SUPPORT_SNAPSHOT.communityToolBundles, { name: 'dsh-notes', version: '1.0.0', status: 'installed' }] },
  new Set([PLUGIN_ID, 'dsh-notes']),
);

test('a job without a plugin id still means dsh-cite, and a job with one means that plugin', () => {
  assert.equal(jobPluginId({ payload: { revision: 1 } }), PLUGIN_ID);
  assert.equal(jobPluginId({ payload: {} }), PLUGIN_ID);
  assert.equal(jobPluginId({}), PLUGIN_ID);
  assert.equal(jobPluginId({ payload: { pluginId: 'dsh-notes' } }), 'dsh-notes');
  // Only an absent field means the default. A present one that is not a usable
  // name is corruption -- enqueue writes a validated registry id -- and reading
  // it as dsh-cite would apply dsh-cite's document for a job that named
  // something else, which is the failure this function exists to prevent.
  for (const declared of ['', 0, 123, null, {}, ['dsh-notes']]) {
    assert.throws(() => jobPluginId({ payload: { pluginId: declared } }), { code: 'plugin_not_supported' },
      `${JSON.stringify(declared)} must not resolve to a plugin`);
  }
});

test('the plugin being applied is named to every probe, including the rollback probe', async () => {
  /** @type {any[]} */ const probed = [];
  const runtime = {
    replacePluginRuntime: async () => {},
    probePlugin: async (/** @type {any} */ _p, /** @type {any} */ config, /** @type {any} */ pluginId) => {
      probed.push([config.revision, pluginId]);
      if (config.revision === 2) throw new Error('candidate');
      return { generation: '1' };
    },
    stop: async () => {},
  };
  await applyPluginCandidate(runtime, {}, candidate, previous, async () => {}, 'dsh-notes');
  assert.deepEqual(probed, [[2, 'dsh-notes'], [1, 'dsh-notes']]);
  probed.length = 0;
  // The default is what every existing caller passes by passing nothing.
  await applyPluginCandidate(runtime, {}, candidate, previous, async () => {});
  assert.deepEqual(probed, [[2, PLUGIN_ID], [1, PLUGIN_ID]]);
});

/**
 * A `PluginApplyWorker` exercised without PostgreSQL.
 *
 * Enough job, document and lease shape for `run()` to reach a finish, plus a
 * transcript of every statement and the parameters it carried. What the
 * assertions read out of that transcript is the document id, because that is
 * the value the worker used to derive from the project alone.
 *
 * @param {{pluginId?:string,registry?:Map<string,any>,busy?:boolean,runtimeThrows?:boolean,
 *   baseline?:any, probe?:(config:any)=>Promise<any>}} options
 */
function workerHarness({ pluginId, registry, busy = false, runtimeThrows = false, baseline = null, probe = null } = {}) {
  const project = { id: 'one', userId: 'owner' };
  const scope = { userId: 'owner', accountCreatedAt: '2026-01-01T00:00:00Z', projectCreatedAt: '2026-01-02T00:00:00Z' };
  const payload = { revision: 3, accountCreatedAt: scope.accountCreatedAt, projectCreatedAt: scope.projectCreatedAt, ...(pluginId ? { pluginId } : {}) };
  const job = { userId: 'owner', id: 'job-1', projectId: project.id, leaseToken: 'lease-1', payload };
  const document = {
    revision: 3, last_good: null,
    payload: { schemaVersion: 1, pluginId: pluginId ?? PLUGIN_ID, binaryVersion: (registry ?? new Map()).get(pluginId ?? PLUGIN_ID)?.version ?? '0.3.2', enabled: true, settings: pluginId ? {} : { timeoutMs: 4000 } },
  };
  /** @type {{text:string,values:any[]}[]} */ const statements = [];
  /** @type {any[]} */ const probed = [];
  /** @type {any[]} */ const finished = [];
  /** @type {any[]} */ const failures = [];
  /** @type {any[]} */ const audits = [];
  /** @type {any[]} */ const starts = [];
  const client = {
    /** @param {string} text @param {any[]} values */
    query: async (text, values = []) => {
      statements.push({ text, values });
      if (text.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
      if (text.includes('SELECT d.revision')) return { rows: [document] };
      if (text.includes('FOR UPDATE')) return { rows: [{ revision: document.revision }] };
      return { rows: [], rowCount: 0 };
    },
  };
  const database = { /** @param {(client:any)=>Promise<any>} operation */ transaction: (operation) => operation(client) };
  let claimed = false;
  const jobs = {
    claim: async () => (claimed ? null : ((claimed = true), job)),
    renew: async () => true,
    /** @param {any} _u @param {any} _i @param {any} _t @param {(client:any)=>Promise<any>} run */
    withLease: async (_u, _i, _t, run) => run(client),
    /** @param {any} _u @param {any} _i @param {any} _t @param {any} result @param {(client:any)=>Promise<any>} run */
    finishWithLease: async (_u, _i, _t, result, run) => { await run(client); finished.push(result); return result; },
    /** @param {any} _u @param {any} _i @param {any} _t @param {any} result */
    finish: async (_u, _i, _t, result) => { finished.push(result); return result; },
    /** @param {any} _u @param {any} _i @param {any} _t @param {any} error @param {any} options */
    fail: async (_u, _i, _t, error, options) => { finished.push({ failed: error.code, ...options }); failures.push(error); },
  };
  const service = {
    jobs, database, registry,
    scope: async () => scope,
    hasPendingPrompts: async () => busy,
  };
  const runtime = {
    runtimeGeneration: () => 'gen-1',
    runtimePluginConfig: () => baseline,
    pluginRuntimeBusy: async () => { if (runtimeThrows) throw new HttpError(500, 'runtime_unreachable', 'no'); return false; },
    /** @param {any} _p @param {any} config */
    replacePluginRuntime: async (_p, config) => { starts.push(config); },
    /** @param {any} _p @param {any} config @param {any} named */
    probePlugin: async (_p, config, named) => { probed.push(named); return probe ? probe(config) : { generation: 'gen-1' }; },
    stop: async () => { starts.push('stop'); },
  };
  const worker = new PluginApplyWorker({ service, runtime, resolveProject: async () => project, ledgerBusy: async () => false,
    audit: (/** @type {string} */ event, /** @type {string} */ status, /** @type {any} */ details) => { audits.push({ event, status, ...details }); } });
  /** Every document id any statement carried, in order, deduplicated. */
  const documentIds = () => [...new Set(statements.flatMap(({ values }) => values.filter(value => typeof value === 'string' && value.startsWith('project:'))))];
  /** The parameters of the statement that recorded the outcome. */
  const outcome = () => statements.find(({ text }) => text.includes('SET phase=$3,effective=$4::jsonb'))?.values ?? null;
  return { worker, statements, documentIds, probed, finished, failures, audits, starts, outcome };
}

test('an apply job addresses the document of the plugin it names, and dsh-cite is addressed exactly as before', async () => {
  const cite = workerHarness();
  await cite.worker.run();
  assert.deepEqual(cite.documentIds(), [citeDocument], 'a job with no plugin id must still apply dsh-cite');
  assert.deepEqual(cite.probed, [PLUGIN_ID]);
  assert.deepEqual(cite.finished, [{ phase: 'effective', error: null, detail: null }]);

  const notes = workerHarness({ pluginId: 'dsh-notes', registry: notesRegistry });
  await notes.worker.run();
  assert.deepEqual(notes.documentIds(), ['project:one:dsh-notes'],
    'a second bundle\'s job must not be applied out of dsh-cite\'s document');
  assert.equal(notes.documentIds().includes(citeDocument), false);
  assert.deepEqual(notes.probed, ['dsh-notes']);
  assert.deepEqual(notes.finished, [{ phase: 'effective', error: null, detail: null }]);
});

test('deferral and failure record against the same document the apply would have written', async () => {
  for (const [label, options, expected] of [
    ['dsh-cite', {}, citeDocument],
    ['a second bundle', { pluginId: 'dsh-notes', registry: notesRegistry }, 'project:one:dsh-notes'],
  ]) {
    // Deferred: the run is waiting on user work, and the wait is recorded on
    // the plugin's own application state.
    const deferred = workerHarness({ ...options, busy: true });
    await deferred.worker.run();
    assert.deepEqual(deferred.documentIds(), [expected], `${label} deferred against the wrong document`);
    assert.deepEqual(deferred.probed, [], 'a deferred job probes nothing');

    // Failed: the same, on the path that runs after the transaction threw.
    const failed = workerHarness({ ...options, runtimeThrows: true });
    await assert.rejects(failed.worker.run(), { code: 'runtime_unreachable' });
    assert.deepEqual(failed.documentIds(), [expected], `${label} failed against the wrong document`);
    assert.ok(failed.statements.some(({ text, values }) => text.includes("phase='failed'") && values.includes(expected)),
      `${label} must mark its own plugin failed`);
  }
});

test('a job naming a plugin this image no longer registers is failed once, not retried forever', async () => {
  // Reachable only because the worker now reads the job's own plugin id: a
  // bundle can leave the recorded installed set between the save and the
  // apply, and no number of attempts will find a document for it.
  const orphan = workerHarness({ pluginId: 'dsh-notes' });
  await assert.rejects(orphan.worker.run(), { code: 'plugin_not_supported' });
  assert.deepEqual(orphan.finished, [{ failed: 'plugin_apply_failed', retry: false }]);
  // And the row the browser reads does not stay `pending` for an apply that is
  // never coming. The failure is recorded against the orphan's own document,
  // which the registry-checked id could not name -- resolving it threw, and the
  // throw was swallowed, so nothing was written at all.
  assert.ok(orphan.statements.some(({ text, values }) => text.includes("phase='failed'") && values.includes('project:one:dsh-notes')),
    'an orphan job must mark its own application state failed');
  assert.equal(orphan.statements.some(({ values }) => values.includes(citeDocument)), false,
    'and it must never mark dsh-cite\'s row failed instead');

  // The one job with no row to name: a payload whose plugin id is not a name at
  // all. It is still failed once, and no other plugin's row is touched.
  const corrupt = workerHarness({ pluginId: /** @type {any} */ (7) });
  await assert.rejects(corrupt.worker.run(), { code: 'plugin_not_supported' });
  assert.deepEqual(corrupt.finished, [{ failed: 'plugin_apply_failed', retry: false }]);
  assert.equal(corrupt.statements.some(({ text }) => text.includes("phase='failed'")), false,
    'no row can be marked failed honestly for a job that names no plugin');
  // ...but it is not silent: the row that could not be written says so in the ledger.
  assert.deepEqual(corrupt.audits.map(({ status, code }) => [status, code]),
    [['failed', 'plugin_apply_state_unwritten'], ['failed', 'plugin_apply_failed']]);
});

test('the production incident: a first configuration whose probes all fail says why, and keeps a runtime', async () => {
  // Reproduced shape of 2026-09-27: no last-known-good, the running
  // configuration's own probe fails, the candidate's fails, and so does the
  // defaults'. Every one of those used to be a bare `catch {}`; the runtime was
  // then stopped and the row said `plugin_rollback_failed`.
  const running = { revision: 0, enabled: true, settings: { timeoutMs: 15000 } };
  const harness = workerHarness({
    baseline: running,
    probe: async (config) => { throw new HttpError(502, 'runtime_session_error', `citation_probe_runtime_busy: revision ${config.revision}`); },
  });
  await harness.worker.run();
  assert.deepEqual(harness.starts, [
    { revision: 3, enabled: true, settings: { timeoutMs: 4000 } },
    { revision: 0, enabled: true, settings: { timeoutMs: 15000 } },
  ], 'the candidate, then the defaults; the runtime is not stopped');
  const [, , phase, effective, generation, error, detail] = harness.outcome() ?? [];
  assert.equal(phase, 'failed');
  assert.equal(error, 'plugin_apply_failed', 'no rollback was attempted, so none is reported as failed');
  assert.equal(effective, null, 'SQL NULL, not the JSON null that overwrote last_good');
  assert.equal(generation, null);
  assert.deepEqual(JSON.parse(detail), {
    apply: { code: 'runtime_session_error', message: 'citation_probe_runtime_busy: revision 3' },
    restored: 'default',
    restore: { code: 'runtime_session_error', message: 'citation_probe_runtime_busy: revision 0' },
    baseline: { code: 'runtime_session_error', message: 'citation_probe_runtime_busy: revision 0' },
  });
  assert.deepEqual(harness.finished, [{ phase: 'failed', error: 'plugin_apply_failed', detail: JSON.parse(detail) }]);
  assert.equal(harness.audits.length, 1);
  const [line] = harness.audits;
  assert.deepEqual([line.event, line.status, line.userId, line.code], ['plugin.apply', 'failed', 'owner', 'plugin_apply_failed']);
  assert.match(line.detail, /^project=one plugin=dsh-cite revision=3 restored=default apply=runtime_session_error: citation_probe_runtime_busy: revision 3 restore=runtime_session_error/);
});

test('an effective apply is a ledger line too, and records no error', async () => {
  const harness = workerHarness();
  await harness.worker.run();
  const [, , phase, effective, , error, detail] = harness.outcome() ?? [];
  assert.equal(phase, 'effective');
  assert.deepEqual(JSON.parse(effective), { revision: 3, enabled: true, settings: { timeoutMs: 4000 } });
  assert.equal(error, null);
  assert.equal(detail, null);
  assert.deepEqual(harness.audits.map(({ event, status, code }) => [event, status, code]), [['plugin.apply', 'effective', null]]);
});

test('an apply that throws past its own handling records the cause on the row, the job and the ledger', async () => {
  const harness = workerHarness({ runtimeThrows: true });
  await assert.rejects(harness.worker.run(), { code: 'runtime_unreachable' });
  const failed = harness.statements.find(({ text }) => text.includes("phase='failed'"));
  assert.deepEqual(JSON.parse(failed?.values.at(-1)), { apply: { code: 'runtime_unreachable', message: 'no' } });
  assert.deepEqual(harness.failures, [{ code: 'plugin_apply_failed', message: 'runtime_unreachable: no' }]);
  assert.deepEqual(harness.audits.map(({ status, code, detail }) => [status, code, detail]),
    [['failed', 'plugin_apply_failed', 'project=one plugin=dsh-cite revision=3 apply=runtime_unreachable: no']]);
});
