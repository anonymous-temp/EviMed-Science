import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { GeoSharedContext } from '../src/geoSharedContext.mjs';
import { PluginService } from '../src/pluginService.mjs';
import { withSessionPromptAdmission } from '../src/runtimePromptAdmission.mjs';

const project = { userId: 'owner', id: 'project' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture({ conflict = false, poolMax = 3 } = {}) {
  const scope = new AsyncLocalStorage(), rows = new Map(), queries = [];
  let open = 0, peak = 0;
  const database = {
    transactionScope: () => scope.getStore(),
    withTransactionClient: (client, work) => scope.run({ client }, work),
    withoutTransactionClient: work => scope.run(undefined, work),
    query: (sql, values) => scope.getStore()?.client.query(sql, values),
    readFence: work => database.transaction(work),
    transaction: async work => {
      if (scope.getStore()) return work(scope.getStore().client);
      assert.ok(++open <= poolMax, 'an admission must leave a spare pool connection'); peak = Math.max(peak, open);
      let timeout = null;
      const client = { query: async (sql, values = []) => {
        queries.push({ sql, values, client });
        if (sql === "SET LOCAL lock_timeout = '3s'") timeout = '3s';
        if (sql.includes('current_setting')) return { rows: [{ lock_timeout: '0', statement_timeout: '0' }] };
        if (sql.includes('pg_try_advisory_xact_lock_shared')) return { rows: [{ acquired: true }] };
        if (sql.includes('pg_advisory_xact_lock(hashtextextended') && values[0]?.startsWith('gncp_') && conflict) {
          assert.equal(timeout, '3s', 'publication must bound lock acquisition before taking any lock');
          throw Object.assign(new Error('lock timeout'), { code: '55P03' });
        }
        if (sql.includes('FROM evimed_control.users u JOIN')) return { rows: [{ ownerId: 'owner', projectId: 'project', ownerCreatedAt: '2026-01-01 00:00:00+00', projectCreatedAt: '2026-01-01 00:00:00+00' }] };
        if (sql.includes("to_regclass('evimed_geo.projects')")) return { rows: [{ projects: true, members: true }] };
        if (sql.includes('FROM evimed_geo.projects g')) return { rows: [{ id: 'geo', live: true, shared: true }] };
        if (sql.includes('FROM evimed_control.users u')) return { rows: [{ accountCreatedAt: 'now', projectCreatedAt: 'now' }] };
        return { rows: [] };
      } };
      try { return await work(client); } finally { open--; }
    },
  };
  const documents = {
    get: async (_owner, _kind, id) => rows.get(id) ?? null,
    put: async (_owner, kind, id, payload, { projectId }) => {
      assert.ok(open >= 2, 'publication borrows a second connection while plugin admission retains the first');
      const row = { kind, id, payload, projectId, revision: 1 }; rows.set(id, row); return row;
    },
  };
  const policies = new GeoSharedContext({ database, documents, runtimeLockIsolation: true });
  const plugins = new PluginService(database, { runtimeLockIsolation: true, databasePoolMax: poolMax });
  const manager = { config: { memoryRuntimeLockIsolationEnabled: true, databasePoolMax: poolMax, runtimePromptAdmissionTimeoutMs: 2000 }, promptAdmissionDatabase: database };
  return { database, documents, policies, plugins, manager, rows, queries, peak: () => peak };
}

test('publication uses a bounded independent transaction under the real plugin and session admission chain', async () => {
  const f = fixture(), ack = deferred(), ready = deferred();
  const pending = f.plugins.withAdmission(project, () => withSessionPromptAdmission(f.manager, project, 'root', async () => {
    assert.ok(f.database.transactionScope(), 'prompt admission borrows the plugin transaction');
    const policy = await f.policies.forProject(project);
    ready.resolve(policy); await ack.promise;
  }), { prompt: true });
  try {
    const policy = await Promise.race([ready.promise, pending]);
    assert.equal(f.rows.get(policy.referenceId).revision, 1);
    assert.deepEqual(await f.policies.forProject(project), policy);
    assert.equal(f.peak(), 2);
    assert.ok(f.queries.some(row => row.sql === "SET LOCAL lock_timeout = '3s'"));
  } finally { ack.resolve(); await pending; }
});

test('publication maps lock timeout to a named retryable refusal without poisoning the caller', async () => {
  const f = fixture({ conflict: true });
  await f.plugins.withAdmission(project, async () => {
    await assert.rejects(f.policies.forProject(project), { code: 'memory_context_publication_busy', status: 409 });
    assert.ok(f.database.transactionScope());
  });
});

// SQL lock compatibility is proved by the PostgreSQL twin; this twin proves the
// admission chain does not deliberately queue different sessions on one key.
test('different sessions under separate plugin admissions both reach acknowledgement with a six-connection pool', async () => {
  const f = fixture({ poolMax: 6 }), ack = deferred(), ready = [deferred(), deferred()];
  const pending = ready.map((item, index) => f.plugins.withAdmission(project, () =>
    withSessionPromptAdmission(f.manager, project, `root${index}`, async () => {
      await f.policies.forProject(project); item.resolve(); await ack.promise;
    }), { prompt: true }));
  try { await Promise.race([Promise.all(ready.map(item => item.promise)), Promise.all(pending)]); }
  finally { ack.resolve(); await Promise.all(pending); }
});

test('a second real plugin admission cannot consume the spare connection before the session limiter runs', async () => {
  const f = fixture({ poolMax: 2 }), ready = deferred(), publish = deferred(), ack = deferred();
  let secondEntered = false;
  const first = f.plugins.withAdmission(project, async () => {
    ready.resolve(); await publish.promise;
    await f.policies.forProject(project); await ack.promise;
  }, { prompt: true });
  await ready.promise;
  const second = f.plugins.withAdmission(project, async () => { secondEntered = true; await ack.promise; }, { prompt: true });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondEntered, false, 'pool capacity is reserved before the outer plugin transaction');
    publish.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.rows.size, 1, 'first publication can use the reserved spare');
  } finally { publish.resolve(); ack.resolve(); await Promise.all([first, second]); }
});

test('capacity wait expires without a leaked slot and nested admissions reuse their already-held client', async () => {
  const f = fixture({ poolMax: 2 }), ready = deferred(), ack = deferred();
  f.plugins.admissionWaitMs = 20;
  const pending = f.plugins.withAdmission(project, async () => {
    await f.plugins.withAdmission({ ...project, id: 'another' }, async () => {
      assert.ok(f.database.transactionScope());
    });
    ready.resolve(); await ack.promise;
  });
  try {
    await ready.promise;
    await assert.rejects(f.plugins.withAdmission(project, async () => { throw new Error('expired admission ran'); }), { code: 'runtime_prompt_admission_busy' });
  } finally { ack.resolve(); await pending; }
  assert.equal(await f.plugins.withAdmission(project, async () => 'next'), 'next');
  assert.equal(f.plugins.admissionClients, 0);
});

test('a dedicated stop and a plugin start share the same pool reservation before either holds a client', async () => {
  const f = fixture({ poolMax: 2 }), ready = deferred(), ack = deferred();
  f.manager.pluginService = f.plugins;
  let stopped = false;
  const start = f.plugins.withAdmission(project, async () => { ready.resolve(); await ack.promise; });
  await ready.promise;
  const stop = withSessionPromptAdmission(f.manager, project, 'stop', async () => { stopped = true; await ack.promise; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false, 'the independent session fence must not consume the gateway spare');
    assert.equal((await f.policies.forProject(project)).kind, 'geo-project');
  } finally { ack.resolve(); await Promise.all([start, stop]); }
  assert.equal(stopped, true);
});
