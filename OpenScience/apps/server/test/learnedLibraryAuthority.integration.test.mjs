import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { METHOD_SKILL_SCHEMA } from '@evimed/domain';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { LearningService } from '../src/learningService.mjs';
import { withLearnedLibrary } from '../src/learnedLibraryAuthority.mjs';

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !databaseUrl && 'A loopback test PostgreSQL is required.', timeout: 20000 };
if (databaseUrl) { const url = new URL(databaseUrl); assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)); assert.match(url.pathname, /^\/evimed_test/); }
const body = '## Purpose\nRetain original evidence.\n## When to Use\nWhen summarizing sources.\n## Inputs\nPreserved sources.\n## Workflow\n1. Read each source.\n## Verification\n- Quotes match.\n## Constraints\n- Do not invent evidence.\n## Output\nAn attributed summary.';
const front = name => ({ name, description: 'Retain every source quotation before writing an attributed summary.', whenToUse: 'When summarizing original evidence.',
  metadata: { role: 'functional', applies_when: 'Sources are available.', not_when: 'No sources exist.', derived_from: 'run:synthetic', evimed_schema: METHOD_SKILL_SCHEMA } });
async function fixture(t) {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  const otherDatabase = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  t.after(async () => { await otherDatabase.close(); await database.close(); });
  for (const db of [database, otherDatabase]) { await db.migrate(); await migrateProductStore(db); }
  const userId = `library-${randomUUID()}`; await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Synthetic library authority','development')", [userId]);
  const documents = new ProductDocuments(database), otherDocuments = new ProductDocuments(otherDatabase);
  const learning = new LearningService({ documents }), other = new LearningService({ documents: otherDocuments });
  const make = name => learning.createCandidate(userId, { frontmatter: front(name), body, provenance: { origin: 'inferred', runId: 'synthetic' } });
  return { database, otherDatabase, documents, otherDocuments, learning, other, userId, make };
}
async function blocked(database) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await database.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n) return;
    await delay(10);
  }
  assert.fail('The concurrent library writer did not reach the row lock.');
}
async function pair(f) {
  const left = await f.make('left'), right = await f.make('right');
  for (const [a, b] of [[left, right], [right, left]]) await f.learning.recordRelations(f.userId, a.id, [{ type: 'conflicts_with', target: b.id, evidence: 'Opposite procedures.', proposedBy: 'consolidate:synthetic' }], () => true);
  return [left.id, right.id];
}
test('different database clients cannot approve both conflicting amendments', options, async t => {
  const f = await fixture(t), ids = await pair(f);
  for (let round = 0; round < 2; round++) {
    const [a, b] = await Promise.all(ids.map(id => f.learning.getMethod(f.userId, id)));
    const result = await Promise.all([f.learning.amendMethod(f.userId, a.id, { expectedRevision: a.revision, frontmatter: a.payload.frontmatter, body: `${body}\nLeft ${round}.` }),
      f.other.amendMethod(f.userId, b.id, { expectedRevision: b.revision, frontmatter: b.payload.frontmatter, body: `${body}\nRight ${round}.` })]);
    assert.equal(result.filter(row => row.payload.status === 'approved').length, 1);
  }
});
test('parallel nested writes use one owned library and still serialize their conflict decisions', options, async t => {
  const f = await fixture(t), ids = await pair(f);
  for (const id of ids) { const row = await f.learning.getMethod(f.userId, id); await f.documents.put(f.userId, 'method', id, { ...row.payload, status: 'candidate' }, { expectedRevision: row.revision }); }
  const result = await withLearnedLibrary(f.documents, f.userId, () => Promise.allSettled(ids.map(async id => {
    const row = await f.learning.getMethod(f.userId, id); return f.learning.approve(f.userId, id, { expectedRevision: row.revision });
  })));
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
  assert.ok(result.some(row => row.status === 'rejected' && row.reason.code === 'method_not_promotable'));
});
test('notifications observe the outer commit and are discarded when the outer transaction rolls back', options, async t => {
  const f = await fixture(t), told = [];
  f.learning.onMountChange = async () => { assert.equal(f.database.transactionScope(), null); told.push('committed'); };
  await assert.rejects(f.database.transaction(client => f.database.withTransactionClient(client, async () => { await f.make('rolled-back'); assert.deepEqual(told, []); throw new Error('rollback'); })));
  assert.deepEqual(told, []);
  await f.database.transaction(client => f.database.withTransactionClient(client, async () => { await f.make('kept'); assert.deepEqual(told, []); }));
  assert.deepEqual(told, ['committed']);
});
test('a caller already holding rows refuses an inverse library wait and releases its transaction', options, async t => {
  const f = await fixture(t), original = await f.make('contended'); let writer;
  await f.database.transaction(client => f.database.withTransactionClient(client, async () => {
    await client.query("SELECT id FROM evimed_product.documents WHERE user_id=$1 AND kind='method' AND id=$2 FOR UPDATE", [f.userId, original.id]);
    writer = f.other.amendMethod(f.userId, original.id, { expectedRevision: original.revision, frontmatter: original.payload.frontmatter, body: `${body}\nIndependent writer.` });
    await blocked(f.otherDatabase);
    await assert.rejects(f.learning.amendMethod(f.userId, original.id, { expectedRevision: original.revision, frontmatter: original.payload.frontmatter, body: `${body}\nMust not be written.` }), { code: 'product_revision_conflict' });
  }));
  assert.match((await writer).payload.body, /Independent writer/);
});
