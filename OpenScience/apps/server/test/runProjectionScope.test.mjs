import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readRunStateProjection } from '../src/agentRuns.mjs';
import { runStateFileForSession } from '@evimed/domain';

const item = { id: 'report', contractKind: 'clinical-evidence', status: 'planned' };
const run = (sessionId, kernelRunId) => ({ id: `ledger_${sessionId}`, sessionId, nativeTurn: {}, status: 'running', nativeWorkflow: { kernelRunId, plan: { written: true, revision: 1, items: [item] }, submissions: [], delegates: [] } });
const projection = (sessionId, runId) => ({ sessionId, runId, plan: { revision: 1, items: [item] } });
test('parallel native sessions read their own state and reject foreign legacy/session identities', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evimed-projection-scope-'));
  const write = async (relative, value) => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), {recursive:true}); await fs.writeFile(file,JSON.stringify(value)); };
  try {
    const a=run('session_a','native_a'),b=run('session_b','native_b');
    await Promise.all([write(runStateFileForSession(a.sessionId),projection(a.sessionId,'native_a')),write(runStateFileForSession(b.sessionId),projection(b.sessionId,'native_b'))]);
    await write('.evimed-run/state.json',projection('foreign','foreign'));
    const reads=await Promise.all([readRunStateProjection({},root,a),readRunStateProjection({},root,b)]);
    assert.deepEqual(reads.map(x=>[x.state,x.projection?.runId]),[['read','native_a'],['read','native_b']]);
    await fs.rm(path.join(root,runStateFileForSession(a.sessionId)));
    assert.equal((await readRunStateProjection({},root,a)).state,'unattributed');
    await write('.evimed-run/state.json',projection(a.sessionId,'native_a'));
    assert.equal((await readRunStateProjection({},root,a)).state,'read','identity-bound legacy state remains compatible');
    await write(runStateFileForSession(a.sessionId),projection(a.sessionId,'stale_native'));
    assert.equal((await readRunStateProjection({},root,a)).state,'unattributed','a present stale session projection cannot fall back to global');
    await fs.rm(path.join(root,runStateFileForSession(a.sessionId)));
    await write('.evimed-run/state.json',projection(a.sessionId,'wrong_run'));
    assert.equal((await readRunStateProjection({},root,a)).state,'unattributed');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

 test('ordinary dispatch legacy projections require the actual run identity', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'evimed-legacy-scope-'));
  try {
    await fs.mkdir(path.join(root,'.evimed-run'),{recursive:true});
    const current={id:'ordinary_run',sessionId:'session_a'};
    for(const [value,expected] of [[{plan:{items:[]}},'unattributed'],[{runId:'foreign_run'},'unattributed'],[{runId:'ordinary_run'},'read']]) {
      await fs.writeFile(path.join(root,'.evimed-run/state.json'),JSON.stringify(value));
      assert.equal((await readRunStateProjection({},root,current)).state,expected);
    }
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
