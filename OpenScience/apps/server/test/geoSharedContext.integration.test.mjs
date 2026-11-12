import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PostgresStore } from '../src/store.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { withSessionPromptAdmission } from '../src/runtimePromptAdmission.mjs';
import { PluginService } from '../src/pluginService.mjs';
import { GeoSharedContext } from '../src/geoSharedContext.mjs';
import { loadConfig } from '../src/config.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };
// A shared project: one with a member. A one-person GEO project keeps its owner's own context (owner ruling 2026-10-25).
async function setup(t, { shared = true, runtimeLockIsolation = false, poolMax = 4 } = {}) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'geocontext');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geo-context-'));
  const accounts = new PostgresStore(loadConfig({ memoryRuntimeLockIsolationEnabled: runtimeLockIsolation, dataDir, databaseUrl: isolated.url, stateStore: 'postgres', databasePoolMax: runtimeLockIsolation ? poolMax : 1 }));
  t.after(async () => { await accounts.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  for (const id of ['owner', 'editor']) await accounts.createUser(id, 'local-fixture-password', id);
  const owner = await accounts.userById('owner'), editor = await accounts.userById('editor');
  const project = await accounts.requireProject(owner, 'default'), personal = await accounts.requireProject(editor, 'default');
  const geoStore = new GeoStore({ database: accounts.database }); await geoStore.ready();
  const geo = await geoStore.createProject({ userId: owner.id, projectId: project.id, engines: ['deepseek'], coverageDays: 30 });
  const documents = new ProductDocuments(accounts.database), policies = new GeoSharedContext({ database: accounts.database, documents, runtimeLockIsolation });
  if (shared) await geoStore.addMember({ geoId: geo.id, userId: editor.id, role: 'editor', invitedBy: owner.id });
  return { accounts, documents, policies, geoStore, owner, editor, project, personal, geo };
}

test('a one-person GEO project keeps the owner\'s own context; the first member registers the project floor and the last one leaving returns it', options, async t => {
  const f = await setup(t, { shared: false });
  const owned = { kind: 'owned', ownerId: f.owner.id, controlProjectId: f.project.id };
  const policies = () => f.documents.list(f.owner.id, 'geo-plan-context', { filter: { recordType: 'geo-native-context-policy' } });
  assert.deepEqual(await f.policies.forProject(f.project), owned, 'a GEO project nobody else is in is its owner\'s project');
  assert.deepEqual(await f.policies.forWorkload({ userId: f.owner.id, projectId: f.project.id }), owned);
  assert.deepEqual(await f.policies.namespacesForOwner(f.owner.id), []);
  assert.equal((await policies()).items.length, 0, 'no project namespace is registered while nobody shares the project');
  await f.geoStore.addMember({ geoId: f.geo.id, userId: f.editor.id, role: 'editor', invitedBy: f.owner.id });
  const [first, parallel] = await Promise.all([f.policies.forProject(f.project), f.policies.forWorkload({ userId: f.owner.id, projectId: f.project.id })]);
  assert.deepEqual(first, parallel);
  assert.equal(first.kind, 'geo-project'); assert.equal(first.geoProjectId, f.geo.id);
  assert.equal(first.namespace.ownerId, f.owner.id);
  assert.deepEqual(await f.policies.namespacesForOwner(f.owner.id), [first.namespace]);
  const normal = await f.policies.forProject(f.personal);
  assert.deepEqual(normal, { kind: 'owned', ownerId: f.editor.id, controlProjectId: f.personal.id });
  assert.equal((await policies()).items.length, 1);
  await f.geoStore.removeMember({ geoId: f.geo.id, userId: f.editor.id, role: 'editor' });
  assert.deepEqual(await f.policies.forProject(f.project), owned, 'the last member leaving gives the project back to its owner');
  assert.deepEqual(await f.policies.namespacesForOwner(f.owner.id), [first.namespace], 'what the shared project kept stays enumerable for export and cleanup');
  assert.equal((await policies()).items.length, 1);
  await f.geoStore.addMember({ geoId: f.geo.id, userId: f.editor.id, role: 'editor', invitedBy: f.owner.id });
  assert.deepEqual(await f.policies.forProject(f.project), first, 'sharing again reopens the same project namespace');
  await f.accounts.database.query('UPDATE evimed_geo.projects SET deleted_at=clock_timestamp() WHERE id=$1', [f.geo.id]);
  assert.deepEqual(await f.policies.forProject(f.project), owned, 'a deleted GEO project is reachable by its owner only');
});

test('invalid durable project policy fails closed and cannot be treated as an ordinary owner project', options, async t => {
  const f = await setup(t); const policy = await f.policies.forProject(f.project);
  const saved = await f.documents.get(f.owner.id, 'geo-plan-context', policy.referenceId);
  await f.documents.put(f.owner.id, 'geo-plan-context', saved.id, { ...saved.payload, namespace: { ...saved.payload.namespace, engineUser: 'foreign' } }, { expectedRevision: saved.revision, projectId: f.project.id });
  await assert.rejects(f.policies.forProject(f.project), error => error.code === 'memory_scope_denied');
  await assert.rejects(f.policies.namespacesForOwner(f.owner.id), error => error.code === 'memory_scope_denied');
});

test('namespace selection uses exact current database incarnations and supports a single connection admission', options, async t => {
  const f = await setup(t); const first = await f.policies.forProject(f.project);
  await f.accounts.database.transaction(client => f.accounts.database.withTransactionClient(client, async () => {
    assert.deepEqual(await f.policies.forWorkload({ userId: f.owner.id, projectId: f.project.id }), first);
  }));
  await f.accounts.database.query("UPDATE evimed_control.projects SET created_at=created_at+interval '1 second' WHERE user_id=$1 AND id=$2", [f.owner.id, f.project.id]);
  const replacement = await f.policies.forProject(f.project);
  assert.notEqual(replacement.namespace.id, first.namespace.id);
  assert.notEqual(replacement.referenceId, first.referenceId);
  const namespaces = await f.policies.namespacesForOwner(f.owner.id);
  assert.equal(namespaces.length, 2, 'historical namespaces remain enumerable for owner export and lifecycle cleanup');
  await assert.rejects(f.policies.forWorkload({ userId: 'unknown', projectId: f.project.id }), error => error.code === 'memory_scope_denied');
});

test('a removed policy cannot silently restore personal context, and account reuse cannot enumerate previous memory', options, async t => {
  const f = await setup(t); const first = await f.policies.forProject(f.project);
  await f.documents.remove(f.owner.id, 'geo-plan-context', first.referenceId, first.revision);
  await f.accounts.database.query('DELETE FROM evimed_geo.projects WHERE id=$1', [f.geo.id]);
  await assert.rejects(f.policies.forProject(f.project), error => error.code === 'memory_scope_denied');
  await f.documents.restore(f.owner.id, 'geo-plan-context', first.referenceId, first.revision + 1);
  await f.accounts.database.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 second' WHERE id=$1", [f.owner.id]);
  assert.deepEqual(await f.policies.namespacesForOwner(f.owner.id), []);
});


test('isolated policy creation serializes writers and commits before an outer admission finishes', options, async t => {
  const f = await setup(t, { runtimeLockIsolation: true });
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { entered = resolve; });
  const put = f.documents.put.bind(f.documents);
  let writes = 0;
  f.documents.put = async (...args) => {
    writes++;
    entered();
    await held;
    return put(...args);
  };
  const first = f.policies.forProject(f.project);
  await writing;
  const second = f.policies.forProject(f.project);
  try {
    let waiting = false;
    const deadline = Date.now() + 3000;
    while (!waiting && writes === 1 && Date.now() < deadline) {
      waiting = (await f.accounts.database.query(`SELECT EXISTS (SELECT 1 FROM pg_locks
        WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`)).rows[0].waiting;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(writes, 1, 'a second publisher cannot enter the protected write');
    assert.equal(waiting, true, 'the second writer has reached the lock before the first is released');
  } finally { release(); }
  assert.deepEqual(await first, await second);
  assert.equal(writes, 1);
  await f.accounts.createProject(f.owner, 'new-shared', 'New shared');
  const fresh = await f.accounts.requireProject(f.owner, 'new-shared');
  const geo = await f.geoStore.createProject({ userId: f.owner.id, projectId: fresh.id, engines: ['deepseek'], coverageDays: 30 });
  await f.geoStore.addMember({ geoId: geo.id, userId: f.editor.id, role: 'editor', invitedBy: f.owner.id });
  await assert.rejects(f.accounts.database.transaction(client => f.accounts.database.withTransactionClient(client, async () => {
    const initialized = await f.policies.forProject(fresh);
    const visible = await f.accounts.database.withoutTransactionClient(() => f.documents.get(f.owner.id, 'geo-plan-context', initialized.referenceId));
    assert.equal(visible.revision, 1, 'publication is already committed before the outer operation can wait on a kernel');
    throw new Error('outer admission refused');
  })), /outer admission refused/);
  assert.equal((await f.policies.forProject(fresh)).revision, 1, 'an admission rollback retains the namespace floor');
  await f.accounts.database.transaction(client => f.accounts.database.withTransactionClient(client, async () => {
    const policy = await f.policies.forProject(f.project);
    const contender = await f.accounts.database.withoutTransactionClient(() => f.accounts.database.transaction(async other =>
      (await other.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [policy.referenceId])).rows[0].acquired));
    assert.equal(contender, true, 'read policy selection retains no creation lock in its caller');
  }));
});


test('first floor publication inside real plugin admission uses the spare connection and is durable before acknowledgement', options, async t => {
  const f = await setup(t, { runtimeLockIsolation: true }), database = f.accounts.database;
  const plugins = new PluginService(database);
  let release, entered;
  const ack = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  let policy;
  assert.equal((await f.documents.list(f.owner.id, 'geo-plan-context')).items.length, 0);
  const pending = plugins.withAdmission(f.project, async () => {
    assert.ok(database.transactionScope(), 'the real plugin caller lends its transaction');
    policy = await f.policies.forProject(f.project);
    entered(); await ack;
  }, { prompt: true });
  try {
    await Promise.race([ready, pending.then(() => { throw new Error('admission ended early'); })]);
    const saved = await f.documents.get(f.owner.id, 'geo-plan-context', policy.referenceId);
    assert.equal(saved.revision, 1);
    assert.deepEqual(await f.policies.forProject(f.project), policy);
  } finally { release(); await pending; }
});

test('publication refuses a lock retained by its own outer transaction within the three second lease convention', options, async t => {
  const f = await setup(t, { runtimeLockIsolation: true }), database = f.accounts.database;
  // Discover the deterministic key without publishing a floor.
  let key;
  f.documents.get = async (_owner, _kind, id) => { key = id; return null; };
  assert.equal(await f.policies.resolveProject(f.project, { readOnly: true }), null);
  const started = Date.now();
  await new PluginService(database).withAdmission(f.project, async () => {
    await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    await assert.rejects(f.policies.forProject(f.project), { status: 409, code: 'memory_context_publication_busy' });
    assert.equal((await database.query('SELECT 1 AS alive')).rows[0].alive, 1, 'the outer transaction remains usable');
  });
  assert.ok(Date.now() - started < 8000, 'publication does not wait for the 120 second idle transaction bound');
});


test('two outer plugin callers on a four-connection pool leave room for first publication', options, async t => {
  const f = await setup(t, { runtimeLockIsolation: true, poolMax: 4 }), database = f.accounts.database;
  const plugins = new PluginService(database, { runtimeLockIsolation: true, databasePoolMax: 4 });
  let enter, publish, release, published, secondEntered = false;
  const ready = new Promise(resolve => { enter = resolve; }), start = new Promise(resolve => { publish = resolve; });
  const ack = new Promise(resolve => { release = resolve; }), done = new Promise(resolve => { published = resolve; });
  const first = plugins.withAdmission(f.project, async () => {
    enter(); await start; published(await f.policies.forProject(f.project)); await ack;
  }, { prompt: true });
  await ready;
  const second = plugins.withAdmission(f.project, async () => { secondEntered = true; await ack; }, { prompt: true });
  let stopped = false;
  const manager = { config: { memoryRuntimeLockIsolationEnabled: true, databasePoolMax: 4, runtimePromptAdmissionTimeoutMs: 10000 }, promptAdmissionDatabase: database, pluginService: plugins };
  const stop = withSessionPromptAdmission(manager, f.project, 'root', async () => { stopped = true; }, { stop: true });
  try {
    publish();
    const policy = await Promise.race([done, first.then(() => { throw new Error('first admission ended early'); })]);
    assert.equal(policy.kind, 'geo-project'); assert.equal(secondEntered, false); assert.equal(stopped, true);
    assert.deepEqual(await f.policies.forProject(f.project), policy);
  } finally { release(); await Promise.all([first, second, stop]); }
  assert.equal(stopped, true);
  assert.equal(secondEntered, true, 'the queued caller proceeds after the first acknowledgement');
});
