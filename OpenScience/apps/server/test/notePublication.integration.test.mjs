import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { ProductJobs } from '../src/productJobs.mjs';
import { SourceService, sourceReadable } from '../src/sourceService.mjs';
import { createKnowledgeBaseEntries } from '../src/knowledgeBaseEntries.mjs';

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
test('note A to B to A preserves owned immutable history and only publishes the current source', { skip: !databaseUrl }, async t => {
  const url = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  const user = { id: `note_history_${randomUUID()}` };
  const project = { id: 'default' };
  const sources = new SourceService(new ProductDocuments(database), new ProductJobs(database));
  const files = new Map();
  t.after(async () => { await database.query('DELETE FROM evimed_control.users WHERE id=$1', [user.id]); await database.close(); });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'History','development')", [user.id]);
  for (const id of ['default', 'other']) await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,$2,1048576)", [user.id, id]);
  let webBody = 'Web body A';
  const entries = createKnowledgeBaseEntries({ sources, readWeb: async () => ({ text: webBody, receipt: { title: 'Saved web', fetchedAt: '2026-10-24T00:00:00Z' } }),
    readFile: async (_project, rel) => files.get(rel),
    write: async ({ buffer, meta }) => {
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const path = `knowledge-base/notes/.evimed-revisions/${sha256}/note.md`;
      files.set(path, buffer);
      return sources.register(user.id, { projectId: project.id, connector: { type: 'upload', id: 'notes' }, path,
        logicalPath: meta.logicalPath, title: meta.title, link: meta.link, sha256, size: buffer.length, mimeType: 'text/markdown', mtime: '2026-10-24T00:00:00Z' });
    } });
  const a = await entries.addNote({ user, project, title: 'History', body: 'Body A' });
  a.source = await sources.documents.put(user.id, 'source', a.source.id, { ...a.source.payload, status: 'complete' }, { expectedRevision: a.source.revision, projectId: project.id });
  assert.equal(sourceReadable(a.source.payload), true);
  const b = await entries.saveNote({ user, project, source: a.source, title: 'History', body: 'Body B' });
  assert.notEqual(a.source.id, b.source.id);
  assert.equal((await entries.readNote({ project, source: await sources.get(user.id, a.source.id) })).body, 'Body A');
  assert.equal((await entries.readNote({ project, source: b.source })).body, 'Body B');
  assert.equal((await sources.family(user.id, a.source.id)).currentVersion, 2);
  assert.equal((await sources.family(user.id, b.source.id)).items.length, 2);
  await assert.rejects(entries.saveNote({ user, project, source: await sources.get(user.id, a.source.id), title: 'History', body: 'Stale overwrite' }), { code: 'source_revision_conflict' });
  await assert.rejects(entries.saveNote({ user, project: { id: 'other' }, source: b.source, title: 'History', body: 'Wrong project' }), { code: 'source_revision_conflict' });
  assert.equal(sourceReadable((await sources.get(user.id, a.source.id)).payload), false);
  b.source = await sources.documents.put(user.id, 'source', b.source.id, { ...b.source.payload, status: 'complete' }, { expectedRevision: b.source.revision, projectId: project.id });
  const again = await entries.saveNote({ user, project, source: b.source, title: 'History', body: 'Body A' });
  assert.equal(again.source.id, a.source.id);
  assert.equal(again.source.payload.version, 3);
  assert.ok(again.source.payload.generation > a.source.payload.generation);
  assert.equal((await sources.family(user.id, b.source.id)).currentVersion, 3);
  assert.equal(sourceReadable((await sources.get(user.id, b.source.id)).payload), false);
  assert.equal((await entries.readNote({ project, source: await sources.get(user.id, b.source.id) })).body, 'Body B');
  assert.deepEqual((await sources.list(user.id, { projectId: 'default' })).items.map(row => row.id), [a.source.id]);
  assert.deepEqual((await sources.list(user.id, { projectId: 'other' })).items, []);
  await assert.rejects(sources.get('another-owner', a.source.id), { code: 'source_not_found' });
  const webA = await entries.addLink({ user, project, url: 'https://example.org/history' });
  webBody = 'Web body B';
  const webB = await entries.refetchLink({ user, project, source: webA.source });
  assert.notEqual(webA.source.id, webB.source.id);
  const historicalWeb = await sources.get(user.id, webA.source.id);
  assert.match(files.get(historicalWeb.payload.paths[0]).toString('utf8'), /Web body A/);
  assert.match(files.get(webB.source.payload.paths[0]).toString('utf8'), /Web body B/);
  assert.equal((await sources.family(user.id, webA.source.id)).items.length, 2);
  const liveIds = (await sources.list(user.id, { projectId: 'default' })).items.map(row => row.id);
  assert.ok(liveIds.includes(webB.source.id));
  assert.ok(!liveIds.includes(webA.source.id));
  const alias = async (logicalPath, body) => {
    const sha256 = createHash('sha256').update(body).digest('hex');
    const result = await sources.register(user.id, { projectId: project.id, connector: { type: 'upload', id: 'aliases' },
      path: `knowledge-base/.evimed-revisions/${sha256}/${logicalPath.split('/').pop()}`, logicalPath,
      sha256, size: body.length, mimeType: 'text/plain', mtime: '2026-10-24T00:00:00Z' });
    const row = result.source;
    return sources.documents.put(user.id, 'source', row.id, { ...row.payload, status: 'complete' }, { expectedRevision: row.revision, projectId: project.id });
  };
  const eligible = async () => (await sources.list(user.id, { projectId: 'default' })).items.filter(row => row.payload.connector.id === 'aliases').map(row => row.id).sort();
  const pathP = 'knowledge-base/P.txt', pathQ = 'knowledge-base/Q.txt';
  const aliasA = await alias(pathP, 'A');
  const familyP = aliasA.payload.familyId;
  assert.deepEqual(await eligible(), [aliasA.id]);
  await alias(pathQ, 'A');
  const refreshedA = await sources.get(user.id, aliasA.id);
  const familyQ = Object.keys(refreshedA.payload.publication.bindings).find(id => id !== familyP);
  assert.deepEqual(await eligible(), [aliasA.id]);
  await sources.documents.put(user.id, 'method', 'derived-alias-method', { status: 'active', sourceId: aliasA.id }, { expectedRevision: 0, projectId: project.id });
  const aliasB = await alias(pathP, 'B');
  assert.equal((await sources.documents.get(user.id, 'method', 'derived-alias-method')).payload.status, 'active');
  assert.deepEqual(await eligible(), [aliasA.id, aliasB.id].sort());
  assert.equal((await sources.get(user.id, aliasA.id)).payload.generation, aliasA.payload.generation, 'another current alias keeps source-wide generation intact');
  const aliasC = await alias(pathQ, 'C');
  assert.equal((await sources.documents.get(user.id, 'method', 'derived-alias-method')).payload.status, 'retired');
  assert.deepEqual(await eligible(), [aliasB.id, aliasC.id].sort());
  assert.ok((await sources.get(user.id, aliasA.id)).payload.generation > aliasA.payload.generation);
  const returnedA = await alias(pathP, 'A');
  assert.equal(returnedA.id, aliasA.id);
  assert.equal((await sources.documents.get(user.id, 'method', 'derived-alias-method')).payload.status, 'retired', 'republishing never revives withdrawn derived records');
  await assert.rejects(sources.beginIngestion(user.id, returnedA.id, { generation: aliasA.payload.generation }), { code: 'source_generation_stale' });
  assert.deepEqual(await eligible(), [aliasA.id, aliasC.id].sort());
  const pHistory = await sources.family(user.id, aliasA.id, { familyId: familyP });
  assert.deepEqual(pHistory.items.map(row => [row.id, row.payload.version]), [[aliasA.id, 3], [aliasB.id, 2], [aliasA.id, 1]]);
  const qHistory = await sources.family(user.id, aliasA.id, { familyId: familyQ });
  assert.deepEqual(qHistory.items.map(row => row.id), [aliasC.id, aliasA.id]);
  await assert.rejects(sources.family(user.id, aliasB.id, { familyId: familyQ }), { code: 'source_family_not_found' });
  const beforeRollback = await eligible();
  await assert.rejects(database.transaction(client => database.withTransactionClient(client, async () => {
    await alias(pathP, 'rollback');
    throw new Error('rollback');
  })), /rollback/);
  assert.deepEqual(await eligible(), beforeRollback, 'publication rollback restores both sides');
  await Promise.all([alias(pathP, 'concurrent-one'), alias(pathP, 'concurrent-two')]);
  const currentBindings = (await sources.documents.list(user.id, 'source', { projectId: project.id, limit: 100 })).items
    .filter(row => row.payload.publication?.bindings?.[familyP]?.current);
  assert.equal(currentBindings.length, 1, 'concurrent publications leave exactly one current binding');
  const current = await sources.get(user.id, a.source.id);
  await sources.remove(user.id, current.id, { expectedRevision: current.revision });
  await assert.rejects(sources.get(user.id, current.id), { code: 'source_not_found' });
});
