import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductJobs } from '../src/productJobs.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { createRsiIncidentExports } from '../src/rsiIncidentExports.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
if (url) { const parsed = new URL(url); assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)); assert.match(parsed.pathname, /^\/evimed_test[a-z0-9_]*$/); }
const options = { skip: !url && 'Disposable localhost PostgreSQL required' };

test('the verbatim body survives jsonb, never reaches a revision row, and is gone after export and withdrawal', options, async () => {
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  const owner = `rsi_body_${randomUUID().replaceAll('-', '')}`;
  const quote = 'Sorting reversed the verbatim quote';
  try {
    await migrateProductStore(database);
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'RSI body test','development')", [owner]);
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'journal-project','RSI journal',1048576)", [owner]);
    const binding = { userId: 'researcher', projectId: 'research', sourceRunId: 'run', sourceRevision: 'a'.repeat(64), authorizationId: 'agreement' };
    let valid = true, failNextPut = true;
    const objects = new Map(), uploaded = [];
    const exports = createRsiIncidentExports({ documents: new ProductDocuments(database), jobs: new ProductJobs(database), deploymentOwnerId: owner, deploymentProjectId: 'journal-project', configured: () => true,
      readAuthorizedTranscript: async () => ({ ...binding, authorized: true, valid, messages: [{ id: 'm', text: `${quote}. Expected ascending order.` }] }),
      extract: async () => Object.fromEntries(['problem', 'reproduction', 'expectedBehavior', 'actualBehavior'].map(key => [key, { text: quote, anchors: [{ messageId: 'm', quote }] }])),
      headObject: async input => objects.get(`${input.streamId}/${input.generation}`) ?? null,
      putObject: async input => {
        // The stored body went through jsonb: the transport receives exact bytes plus a reordered object.
        assert.equal(input.serializedBody.includes(quote) || input.kind === 'withdrawal', true);
        if (failNextPut) { failNextPut = false; throw new Error('connection reset before storing'); }
        objects.set(`${input.streamId}/${input.generation}`, { digest: input.digest }); uploaded.push(input.serializedBody);
        return { digest: input.digest };
      } });
    const anywhere = async () => {
      const revisions = await database.query('SELECT count(*)::integer AS n FROM evimed_product.revisions WHERE user_id=$1 AND payload::text LIKE $2', [owner, `%${quote}%`]);
      const documents = await database.query('SELECT count(*)::integer AS n FROM evimed_product.documents WHERE user_id=$1 AND payload::text LIKE $2', [owner, `%${quote}%`]);
      return { revisions: revisions.rows[0].n, documents: documents.rows[0].n };
    };
    const row = await exports.offer(binding);
    await assert.rejects(exports.processPending({ id: row.id }), /connection reset/);
    assert.deepEqual(await anywhere(), { revisions: 0, documents: 1 }, 'held in place, outside revision history, while the upload is pending');
    assert.equal((await exports.processPending({ id: row.id })).payload.status, 'exported');
    assert.equal(uploaded.length, 1);
    assert.deepEqual(await anywhere(), { revisions: 0, documents: 0 });
    valid = false;
    assert.equal((await exports.processPending({ id: row.id })).payload.status, 'withdrawn');
    assert.equal(uploaded.length, 2);
    assert.deepEqual(await anywhere(), { revisions: 0, documents: 0 });
  } finally {
    await database.query('DELETE FROM evimed_control.users WHERE id=$1', [owner]);
    await database.close();
  }
});
