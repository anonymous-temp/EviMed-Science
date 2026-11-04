import assert from 'node:assert/strict';
import test from 'node:test';
import { lockVcrLanguageStudyBasis } from '../src/vcrLanguageFence.mjs';

test('study basis lock takes the shared advisory lock before the study row', async () => {
  const queries = [];
  const client = { async query(sql, values) { queries.push([sql, values]); return { rows: [{ id: 'std_1' }] }; } };
  await lockVcrLanguageStudyBasis(client, 'std_1');
  assert.match(queries[0][0], /pg_advisory_xact_lock/);
  assert.match(queries[1][0], /FOR UPDATE/);
  assert.deepEqual(queries.map(row => row[1]), [['std_1'], ['std_1']]);
  await assert.rejects(lockVcrLanguageStudyBasis(client, 'bad study'), /Invalid study/);
  await assert.rejects(lockVcrLanguageStudyBasis({ query: async () => ({ rows: [] }) }, 'std_1'), error => error.code === 'vcr_study_not_found');
});

test('language lease is checked and locked against the owner, generation, deadline and cancel state', async () => {
  const { lockVcrLanguageLease } = await import('../src/vcrLanguageFence.mjs');
  let query;
  const client = { async query(sql, values) { query = { sql, values }; return { rows: [{ id: 'job1' }] }; } };
  await lockVcrLanguageLease(client, { studyId:'s1',jobId:'job1',userId:'u1',owner:'worker1',attempt:2,unitHash:'a'.repeat(64) });
  assert.match(query.sql, /cancel_requested=false/); assert.match(query.sql, /lease_until>clock_timestamp\(\)/); assert.match(query.sql, /FOR UPDATE/);
  assert.deepEqual(query.values, ['s1','job1','worker1',2,'u1','a'.repeat(64)]);
  await assert.rejects(lockVcrLanguageLease({ query: async () => ({ rows: [] }) }, { studyId:'s1',jobId:'job1',userId:'u1',owner:'worker1',attempt:2,unitHash:'a'.repeat(64) }), error => error.code === 'vcr_language_lease_changed');
});

test('source locks are deduplicated and acquired in deterministic order', async () => {
  const { lockVcrLanguageSources } = await import('../src/vcrLanguageFence.mjs');
  const ids=[];await lockVcrLanguageSources({query:async (_sql,values)=>{ids.push(values[0]);return {rows:[]};}},['src_b','src_a','src_b']);
  assert.deepEqual(ids,['src_a','src_b']);
  await assert.rejects(lockVcrLanguageSources({query:async()=>({rows:[]})},['bad id']),/Invalid source/);
});
