import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { withdrawDerivedMemory } from '../src/derivedMemory.mjs';
import { databaseUrl, signedIn, ingestCorpus, fixture } from './helpers/knowledgeBaseApp.mjs';
const skip = !databaseUrl && 'OPEN_SCIENCE_TEST_POSTGRES_URL is not configured';
test('source and library revisions atomically enqueue distinct retryable lifecycle events', { skip }, async () => {
  const context = await signedIn();
  try {
    const { app, user } = context;
    await app.sourceSyncWorker?.close();
    const [source] = await ingestCorpus(context, { names: [fixture.documents[0].name] });
    const documents = app.sourceService.documents;
    const db = documents.database;
    const events = async () => (await db.query("SELECT payload FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'action'='lifecycle' ORDER BY created_at,id", [user.id])).rows.map(row => row.payload);
    const before = (await events()).length;
    await documents.put(user.id, 'source', `src_${'f'.repeat(32)}`, { connector: { type: 'internal' },
      logicalPath: 'knowledge-base/kg/entities.json', paths: ['.evimed/immutable/graph.json'], generation: 1 },
      { expectedRevision: 0, projectId: source.projectId });
    assert.equal((await events()).length, before, 'compiled graph mirrors never feed their own compilation');

    await assert.rejects(db.transaction(async client => {
      await documents.put(user.id, 'source', source.id, { ...source.payload, testMutation: true }, { expectedRevision: source.revision, transactionClient: client });
      throw new Error('rollback');
    }), /rollback/);
    assert.equal((await events()).length, before);
    await app.libraryService.add(user.id, source.id);
    const copyPath = path.join(app.libraryService.libraryDir(user.id), source.id, 'index.md');
    const copiedText = await readFile(copyPath, 'utf8');
    const reader = 'library-reader';
    await app.store.createProject(await app.store.userById(user.id), reader, 'Reader');
    const pagePath = 'index.md';
    const pageId = projectId => `wiki:page:${projectId}:wiki:${createHash('sha256').update(pagePath).digest('hex').slice(0, 32)}`;
    for (const projectId of [reader, source.projectId]) await documents.put(user.id, 'knowledge', pageId(projectId),
      { recordType: 'wiki-page', projectId, tree: 'wiki', path: pagePath, dependsOn: [source.id], retired: false, stale: null },
      { expectedRevision: 0, projectId });
    await app.libraryService.remove(user.id, source.id);
    // Simulate a failed physical cleanup: the live membership is gone, but replica bytes survive.
    await mkdir(path.dirname(copyPath), { recursive: true });
    await writeFile(copyPath, copiedText);
    assert.equal((await app.knowledgePages.browseEligibility(user.id, reader, 'wiki', pagePath)).allowed, false,
      'orphaned library bytes must not authorize compiled context after withdrawal');
    const removedEvent = (await events()).findLast(event => event.scope === 'library' && event.deleted);
    await app.sourceSync.runJob({ userId: user.id, payload: removedEvent });
    const dependent = await documents.get(user.id, 'knowledge', pageId(reader));
    assert.equal(dependent.payload.stale.sources[0].reason, 'removed');
    const ownPage = await documents.get(user.id, 'knowledge', pageId(source.projectId));
    assert.equal(ownPage.payload.stale, null, 'library removal does not revoke the valid project source');
    const sourceEvent = (await events()).findLast(event => event.scope === 'source' && event.sourceId === source.id);
    await app.sourceSync.runJob({ userId: user.id, payload: sourceEvent });
    const ready = app.knowledgePages.noteSourceReady;
    app.knowledgePages.noteSourceReady = async (_user, _project, _source, options) => {
      assert.equal(options.strict, true);
      throw Object.assign(new Error('page invalidation unavailable'), { code: 'page_write_failed' });
    };
    await assert.rejects(app.sourceSync.runJob({ userId: user.id, payload: sourceEvent }), { code: 'page_write_failed' });
    app.knowledgePages.noteSourceReady = ready;


    await app.libraryService.add(user.id, source.id);
    const library = (await events()).filter(event => event.scope === 'library');
    assert.ok(library.length >= 3);
    assert.equal(new Set(library.map(event => event.mutationId)).size, library.length);
    assert.ok(library.some(event => event.deleted));
    assert.ok(library.every(event => event.accountCreatedAt));
    const newest = await documents.get(user.id, 'source', source.id);
    const n = (await events()).length;
    await documents.put(user.id, 'source', source.id, { ...newest.payload, progress: { calls: 42 } }, { expectedRevision: newest.revision, projectId: newest.projectId, telemetry: true });
    assert.equal((await events()).length, n);
    const capsules = app.libraryService.capsules;
    const capsule = await capsules.ownCapsule(user.id, { create: true });
    const input = { factKind: 'project_fact', layer: 'sources', content: 'An observed statement', origin: 'inferred',
      derivedFrom: { sourceId: source.id, projectId: source.projectId } };
    const platform = await capsules.addEntry(user.id, capsule.id, input, { publicationKey: 'platform' });
    await capsules.updateEntry(user.id, capsule.id, platform.id, { status: 'approved', expectedRevision: platform.revision });
    const forgotten = await capsules.addEntry(user.id, capsule.id, input, { publicationKey: 'forgotten' });
    await capsules.updateEntry(user.id, capsule.id, forgotten.id, { status: 'retired', expectedRevision: forgotten.revision });
    await db.transaction(client => withdrawDerivedMemory(client, user.id, { sourceIds: [source.id], reason: 'source_deleted' }));
    const restored = await capsules.addEntry(user.id, capsule.id, input, { publicationKey: 'platform' });
    assert.equal(restored.id, platform.id);
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.payload.status, 'approved');
    const keptForgotten = await capsules.addEntry(user.id, capsule.id, input, { publicationKey: 'forgotten' });
    assert.equal(keptForgotten.id, forgotten.id);
    assert.ok(keptForgotten.deletedAt);
    assert.equal(keptForgotten.payload.status, 'retired');

  } finally { await context.close(); }
});
