import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { ProductJobs } from '../src/productJobs.mjs';
import { SourceService } from '../src/sourceService.mjs';
import { LibraryService } from '../src/libraryService.mjs';
import { CapsuleService } from '../src/capsuleService.mjs';
import { databaseUrl, signedIn } from './helpers/knowledgeBaseApp.mjs';

const options = { skip: !databaseUrl && 'OPEN_SCIENCE_TEST_POSTGRES_URL is not configured', timeout: 20_000 };
function barrier() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
async function blocked(database, pid, completed) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = await database.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid]);
    if (row.rows[0].blocked) return true;
    if (completed()) return false;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('The competing transaction reached neither its barrier nor a database lock');
}

test('source row mutation locks serialize publication against an uncommitted deletion withdrawal', options, async () => {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  const userId = `publication_barrier_${randomUUID()}`;
  const documents = new ProductDocuments(database);
  const sources = new SourceService(documents, new ProductJobs(database));
  const capsules = new CapsuleService(documents);
  const publicationRead = barrier();
  const allowPublication = barrier();
  const allowDeleteCommit = barrier();
  let publication;
  let deletion;
  try {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Barrier','development')", [userId]);
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'p','Project',1048576)", [userId]);
    const { source } = await sources.register(userId, { projectId: 'p', connector: { type: 'upload', id: 'library' },
      path: 'knowledge-base/barrier.txt', sha256: 'a'.repeat(64), size: 10, mimeType: 'text/plain', mtime: '2026-10-23T00:00:00Z' });
    sources.getUnderstanding = async () => {
      publicationRead.release();
      await allowPublication.promise;
      return { current: { generation: source.payload.generation, summary: 'An observed summary', claims: [] } };
    };
    const library = new LibraryService({ documents, sources, capsules, libraryDir: () => '/nonexistent/library' });
    publication = library.publishSourceUnderstanding(userId, source.id);
    await publicationRead.promise;
    const deletionStarted = barrier();
    let staged = false;
    deletion = database.transaction(client => database.withTransactionClient(client, async () => {
      deletionStarted.release((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await sources.remove(userId, source.id, { expectedRevision: source.revision });
      staged = true;
      await allowDeleteCommit.promise;
    }));
    void deletion.catch(() => {});
    const pid = await deletionStarted.promise;
    const deletionBlocked = await blocked(database, pid, () => staged);
    allowPublication.release();
    await publication;
    allowDeleteCommit.release();
    await deletion;
    const facts = await database.query("SELECT id FROM evimed_product.documents WHERE user_id=$1 AND kind='fact' AND deleted_at IS NULL AND payload->>'sourceId'=$2 AND payload->>'status'='approved'", [userId, source.id]);
    assert.equal(deletionBlocked, true, 'publication must own the same source row lock as deletion before reading');
    assert.equal(facts.rowCount, 0, 'no publication can commit after deletion already withdrew its facts');
  } finally {
    allowPublication.release(); allowDeleteCommit.release();
    await Promise.allSettled([publication, deletion].filter(Boolean));
    await database.query('DELETE FROM evimed_control.users WHERE id=$1', [userId]);
    await database.close();
  }
});

test('a lifecycle epoch remains locked while work awaits a library barrier', options, async () => {
  const context = await signedIn();
  const { app, user } = context;
  const database = app.sourceService.documents.database;
  const reachedWork = barrier();
  const resumeWork = barrier();
  let task;
  let replacement;
  let client;
  try {
    await app.sourceSyncWorker.close();
    const generation = (await database.query('SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1', [user.id])).rows[0].generation;
    app.libraryService.syncCopies = async () => {
      reachedWork.release();
      await resumeWork.promise;
      await app.sourceService.documents.put(user.id, 'preferences', 'epoch-barrier-effect', { recordType: 'epoch-barrier-effect' }, { expectedRevision: 0 });
      return { failed: 0 };
    };
    task = app.sourceSync.runJob({ userId: user.id, payload: { action: 'lifecycle', scope: 'library', sourceId: `src_${'b'.repeat(32)}`,
      documentId: 'library:barrier', accountCreatedAt: generation } });
    await reachedWork.promise;
    client = await database.pool.connect();
    await client.query('BEGIN');
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let replaced = false;
    replacement = (async () => {
      await client.query('DELETE FROM evimed_control.users WHERE id=$1', [user.id]);
      await client.query("INSERT INTO evimed_control.users(id,name,auth_type,created_at) VALUES($1,'Recreated','development',clock_timestamp()+interval '1 second')", [user.id]);
      await client.query('COMMIT');
      replaced = true;
    })();
    const replacementBlocked = await blocked(database, pid, () => replaced);
    resumeWork.release();
    await task;
    await replacement;
    const effect = await app.sourceService.documents.get(user.id, 'preferences', 'epoch-barrier-effect');
    assert.equal(replacementBlocked, true, 'account deletion must wait for the validated lifecycle epoch');
    assert.equal(effect, null, 'old lifecycle effects belong to the deleted epoch, never the recreated account');
  } finally {
    resumeWork.release();
    await Promise.allSettled([task, replacement].filter(Boolean));
    client?.release();
    await context.close();
  }
});
