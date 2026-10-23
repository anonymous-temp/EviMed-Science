import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeQueueMetricFamilies } from '../src/knowledgeQueueMetrics.mjs';
import { databaseUrl, signedIn } from './helpers/knowledgeBaseApp.mjs';

test('durable knowledge queue metrics distinguish queued, retrying and failed work after restart', { skip: !databaseUrl }, async () => {
  const ctx = await signedIn();
  try {
    const db = ctx.app.sourceService.documents.database;
    const jobs = ctx.app.sourceService.jobs;
    await ctx.app.sourceSyncWorker?.close();
    const pending = await jobs.enqueue(ctx.user.id, 'ov-resource-sync', { sourceId: 'fixture' }, { idempotencyKey: 'queue-metric', maxAttempts: 5 });
    await db.query("UPDATE evimed_product.jobs SET created_at=clock_timestamp()-interval '2 minutes',attempts=2,error=$2::jsonb WHERE id=$1", [pending.id, JSON.stringify({ code: 'source_runtime_replica_pending' })]);
    const families = await knowledgeQueueMetricFamilies(db);
    const metric = name => families.find(item => item.name === name);
    assert.equal(metric('open_science_knowledge_queue_observed').series[0].value, 1);
    const sync = name => metric(name).series.filter(item => item.labels.workload === 'source_sync');
    assert.ok(sync('open_science_knowledge_queue_items').some(item => item.labels.state === 'queued' && item.value >= 1));
    assert.ok(sync('open_science_knowledge_queue_retries').some(item => item.value >= 2));
    assert.ok(sync('open_science_knowledge_queue_oldest_seconds').some(item => item.value >= 119));
    assert.ok(!JSON.stringify(families).includes(ctx.user.id), 'no account, source or content in operator metric labels');
    const unavailable = await knowledgeQueueMetricFamilies({ query: async () => { throw new Error('down'); } });
    assert.equal(unavailable.length, 1, 'an unreadable ledger never emits empty queues as observed facts');
    assert.equal(unavailable[0].series[0].value, 0);
  } finally { await ctx.close(); }
});
