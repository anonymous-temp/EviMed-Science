import assert from 'node:assert/strict';
import test from 'node:test';
import { planFileFor, runStateFileForSession, briefFileForSession } from '@evimed/domain';
import { readRunHandles } from '../plugins/compaction.mjs';

test('scope paths reject traversal and compaction keeps current parent run across concurrent sessions', async () => {
  for (const value of ['../other','a/b','a\\b','', 'x'.repeat(257)]) {
    for (const fn of [planFileFor,runStateFileForSession,briefFileForSession]) assert.throws(()=>fn(value));
  }
  /** @type {Record<string, string>[]} */
  const runs=[{runId:'run_a',sessionId:'session_a',status:'running'},{runId:'run_b',sessionId:'session_b',status:'running'},{runId:'stale_a',sessionId:'session_a',status:'completed'}];
  const tables={runIdForSession:(/** @type {string} */ s)=>s==='session_a'?'run_a':s==='session_b'?'run_b':'',runMirror:{select:async (/** @type {Record<string,string>} */ q)=>runs.filter(r=>Object.entries(q).every(([k,v])=>r[k]===v))},planIndex:{select:async()=>[]},evidence:{select:async()=>[]}};
  const [a,b]=await Promise.all([readRunHandles(tables,{session:{id:'session_a'}}),readRunHandles(tables,{session:{id:'session_b'}})]);
  assert.ok(a.some(h=>h.id===planFileFor('run_a')));assert.ok(!a.some(h=>h.id.includes('run_b')||h.id.includes('stale_a')));
  assert.ok(b.some(h=>h.id===planFileFor('run_b')));
  const child=await readRunHandles(tables,{session:{id:'child_a',header:{parentSession:'session_a'}}});
  assert.ok(child.some(h=>h.id===planFileFor('run_a')),'child must inherit the active parent run rather than its newest historical row');
});
