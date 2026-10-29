import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PostgresStore } from '../src/store.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoSharedContext } from '../src/geoSharedContext.mjs';
import { GeoNativeMemoryContext } from '../src/geoNativeMemoryContext.mjs';
import { OpenVikingSessions } from '../src/openVikingSessions.mjs';
import { loadConfig } from '../src/config.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };
const refused = error => error.code === 'memory_scope_denied';
async function setup(t) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'geomemorycontext');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geo-memory-context-'));
  const accounts = new PostgresStore(loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: 'postgres', databasePoolMax: 1 }));
  t.after(async () => { await accounts.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  await accounts.createUser('owner', 'local-fixture-password', 'Owner');
  const owner = await accounts.userById('owner');
  await accounts.createProject(owner, 'other', 'Other'); await accounts.createProject(owner, 'ordinary', 'Ordinary');
  const a = await accounts.requireProject(owner, 'default'), b = await accounts.requireProject(owner, 'other');
  const normal = await accounts.requireProject(owner, 'ordinary');
  const geoStore = new GeoStore({ database: accounts.database }); await geoStore.ready();
  // A shared GEO project: one with a member (a one-person GEO project is an owned project, owner ruling 2026-10-25).
  for (const project of [a, b]) await geoStore.addMember({ geoId: (await geoStore.createProject({ userId: owner.id, projectId: project.id, engines: ['deepseek'], coverageDays: 30 })).id, userId: 'member', role: 'editor', invitedBy: owner.id });
  const documents = new ProductDocuments(accounts.database), policies = new GeoSharedContext({ database: accounts.database, documents });
  const requests = [];
  const sessions = new OpenVikingSessions({ configured: true, account: 'fixture', request: async input => { requests.push(input); return { status: 'ok' }; } });
  let proof = { rootSessionId: 'root', rootProofRefs: ['primary-fixture'], runtimeGeneration: 'generation-1' };
  const contexts = new GeoNativeMemoryContext({ database: accounts.database, documents, policies, sessions,
    proveCapture: async (_context, session) => ['dsh-root', 'dsh-child'].includes(session) ? proof : null });
  return { accounts, documents, policies, contexts, sessions, requests, owner, a, b, normal, setProof: value => { proof = value; } };
}

test('one owner has independent immutable project views even with equal native session identifiers', options, async t => {
  const f = await setup(t);
  const [a, b, ordinary] = await Promise.all([f.contexts.forProject(f.a), f.contexts.forProject(f.b), f.contexts.forProject(f.normal)]);
  assert.notEqual(a.namespaceId, b.namespaceId); assert.notEqual(a.namespaceId, ordinary.namespaceId);
  assert.equal(a.sessions.userRoot(f.owner.id), a.userRoot);
  assert.equal(ordinary.sessions, f.sessions);
  await Promise.all([a.sessions.createSession(f.owner.id, 'dsh-root'), b.sessions.createSession(f.owner.id, 'dsh-root')]);
  assert.deepEqual(new Set(f.requests.map(row => row.openVikingUser)), new Set([a.namespaceId, b.namespaceId]));
  const [pa, pb] = await Promise.all([f.contexts.noteCapture(a, 'dsh-root'), f.contexts.noteCapture(b, 'dsh-root')]);
  assert.notEqual(pa.id, pb.id); assert.equal(pa.payload.namespaceId, a.namespaceId);
  assert.equal((await f.contexts.session(b, 'dsh-root')).payload.namespaceId, b.namespaceId);
  assert.equal(await f.contexts.noteCapture(a, 'unknown'), null);
  assert.equal(await f.contexts.session(a, 'unknown'), null);
  assert.deepEqual(await f.contexts.noteCapture(a, 'dsh-root'), pa, 'idempotent capture retains its original proof');
});

test('exact registered roots resolve historical memory without accepting a URI alias or another namespace', options, async t => {
  const f = await setup(t), a = await f.contexts.forProject(f.a), b = await f.contexts.forProject(f.b);
  assert.equal((await f.contexts.forUri(f.owner.id, `${a.userRoot}/sessions/dsh-root/history/archive_2`)).namespaceId, a.namespaceId);
  for (const uri of ['viking://~', `${a.userRoot}-extra/memories/x.md`, `${a.userRoot}/../${b.namespaceId}/memories/x.md`, `${a.userRoot}/%2e%2e/a`, `${a.userRoot}/memories//x.md`, `${a.userRoot}/memories/x.md?other=1`, 'viking://user/unknown/memories/x.md']) {
    await assert.rejects(f.contexts.forUri(f.owner.id, uri), refused, uri);
  }
  await f.accounts.database.query("UPDATE evimed_control.projects SET created_at=created_at+interval '1 second' WHERE user_id=$1 AND id=$2", [f.owner.id, f.a.id]);
  const replacement = await f.contexts.forProject(f.a);
  assert.notEqual(replacement.namespaceId, a.namespaceId);
  assert.equal((await f.contexts.forUri(f.owner.id, `${a.userRoot}/memories/projects/old.md`)).namespaceId, a.namespaceId);
  await assert.rejects(f.contexts.assertLive(a), refused);
  await assert.rejects(f.contexts.noteCapture(a, 'dsh-root'), refused);
  await assert.rejects(f.contexts.noteInternal(a, 'evimed-page-new', { kind: 'page', operationRef: 'new-page' }), refused);
  const archive = `${a.userRoot}/sessions/dsh-root/history/archive_2`;
  const historical = await f.contexts.forUri(f.owner.id, archive);
  const replay = await f.contexts.noteInternal(historical, 'evimed-replay-old', { kind: 'replay', sourceArchiveUri: archive });
  assert.equal(replay.payload.namespaceId, a.namespaceId);
  assert.equal(replay.payload.source.sourceArchiveUri, archive);
  assert.equal((await f.contexts.all(f.owner.id)).length, 4);
});

test('a persisted session association cannot be changed or used as new capture permission', options, async t => {
  const f = await setup(t), context = await f.contexts.forProject(f.a);
  const binding = await f.contexts.noteCapture(context, 'dsh-root');
  f.setProof(null);
  assert.equal(await f.contexts.noteCapture(context, 'dsh-root'), null, 'history is not live capture authorization');
  assert.deepEqual(await f.contexts.session(context, 'dsh-root'), binding);
  f.setProof({ rootSessionId: 'other', rootProofRefs: ['different'], runtimeGeneration: 'generation-2' });
  await assert.rejects(f.contexts.noteCapture(context, 'dsh-root'), refused);
  const saved = await f.documents.get(f.owner.id, 'geo-plan-context', binding.id);
  await f.documents.put(f.owner.id, 'geo-plan-context', saved.id, { ...saved.payload, namespaceId: 'wrong' }, { projectId: f.a.id, expectedRevision: saved.revision });
  await assert.rejects(f.contexts.session(context, 'dsh-root'), refused);
});

test('server-created page and replay bindings retain the namespace and original source without a DSH grant', options, async t => {
  const f = await setup(t), a = await f.contexts.forProject(f.a), b = await f.contexts.forProject(f.b);
  const page = await f.contexts.noteInternal(a, 'evimed-page-one', { kind: 'page', operationRef: 'page-operation-one' });
  assert.equal(page.payload.source.kind, 'page');
  const archive = `${a.userRoot}/sessions/dsh-root/history/archive_7`;
  const replay = await f.contexts.noteInternal(a, 'evimed-replay-one', { kind: 'replay', sourceArchiveUri: archive });
  assert.equal(replay.payload.source.sourceArchiveUri, archive);
  await assert.rejects(f.contexts.noteInternal(b, 'evimed-replay-one', { kind: 'replay', sourceArchiveUri: archive }), refused);
  await assert.rejects(f.contexts.noteInternal(a, 'mcp-store-one', { kind: 'tool', operationRef: 'guessed' }), refused);
  assert.equal(await f.contexts.noteCapture(a, 'evimed-page-one'), null);
});

test('verified child addresses preserve the actual root relationship and concurrent registration creates one binding', options, async t => {
  const f = await setup(t), context = await f.contexts.forProject(f.a);
  const proof = { rootSessionId: 'root', rootProofRefs: ['primary-fixture'], runtimeGeneration: 'generation-1',
    childAddress: { kind: 'subagent', parentSessionId: 'root', childSessionId: 'child', mode: 'continuable' } };
  f.setProof(proof);
  const [left, right] = await Promise.all([f.contexts.noteCapture(context, 'dsh-child'), f.contexts.noteCapture(context, 'dsh-child')]);
  assert.deepEqual(left, right); assert.deepEqual(left.payload.source.childAddress, proof.childAddress);
  assert.equal((await f.documents.list(f.owner.id, 'geo-plan-context', { filter: { recordType: 'geo-native-memory-session' } })).items.length, 1);
  f.setProof({ ...proof, childAddress: { ...proof.childAddress, parentSessionId: 'different' } });
  await assert.rejects(f.contexts.noteCapture(context, 'dsh-child'), refused);
  f.setProof({ ...proof, childAddress: { ...proof.childAddress, mode: 'invented' } });
  await assert.rejects(f.contexts.noteCapture(context, 'dsh-child'), refused);
  f.setProof({ ...proof, childAddress: { ...proof.childAddress, childSessionId: 'different' } });
  await assert.rejects(f.contexts.noteCapture(context, 'dsh-child'), refused);
});

test('account replacement cannot enumerate or reuse old project memory context', options, async t => {
  const f = await setup(t), a = await f.contexts.forProject(f.a);
  await f.accounts.database.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 second' WHERE id=$1", [f.owner.id]);
  await assert.rejects(f.contexts.forUri(f.owner.id, `${a.userRoot}/memories/projects/old.md`), refused);
  await assert.rejects(f.contexts.session(a, 'dsh-root'), refused);
  await assert.rejects(f.contexts.noteInternal(a, 'evimed-page-one', { kind: 'page', operationRef: 'page-one' }), refused);
});
