import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentRunStore } from '../src/agentRuns.mjs';

test('actual durable dispatch captures the authoritative run before prompting, while unavailable proof remains advisory', async () => {
  for (const unavailable of [false, true]) {
    const root = await mkdtemp(path.join(tmpdir(), 'evolution-egress-dispatch-'));
    const project = { id: 'eval-paper-egress', userId: 'operator', rootDir: root, workspaceDir: path.join(root, 'workspace'), metaDir: path.join(root, '.openscience') };
    await mkdir(project.workspaceDir); await mkdir(project.metaDir);
    const session = { sessionId: 'session-egress', mode: 'open-domain', agentId: null, agentVersion: null, runtimeAgent: null }, order = [];
    const store = new AgentRunStore({ get: async () => session }, {
      model: 'deepseek/deepseek-v4-flash',
      readSessionHistory: async () => [],
      captureRuntimeEgressProof: async (ownedProject, run) => {
        assert.equal(ownedProject, project);
        assert.equal((await store.list(project)).find(row => row.id === run.id)?.dispatchId, 'actual-dispatch');
        order.push(['capture', run.id]);
        if (unavailable) throw new Error('Observed isolation is unavailable');
        return { nativeCoverageVerified: false };
      },
    });
    store.scheduleMonitor = () => {};
    try {
      const run = await store.dispatch(project, { sessionId: session.sessionId, dispatchId: 'actual-dispatch' }, async (_binding, actual) => { order.push(['prompt', actual.id]); return { accepted: true }; });
      assert.deepEqual(order, [['capture', run.id], ['prompt', run.id]]);
      await store.dispatch(project, { sessionId: session.sessionId, dispatchId: 'actual-dispatch' }, async () => { throw new Error('A preserved dispatch must never prompt twice'); });
      assert.equal(order.length, 2, 'A resumed run cannot acquire a retroactive start proof');
    } finally { await store.closeProject(project); await rm(root, { recursive: true, force: true }); }
  }
});

test('normal dispatch retains its first trusted cutoff through cumulative learning compaction and restart', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'evolution-cutoff-'));
  const project={id:'eval-paper-cutoff',userId:'operator',rootDir:root,workspaceDir:path.join(root,'workspace'),metaDir:path.join(root,'.openscience')};
  await mkdir(project.workspaceDir);await mkdir(project.metaDir);
  const session={sessionId:'session-cutoff',mode:'open-domain',agentId:null,agentVersion:null,runtimeAgent:null};
  const create=()=>new AgentRunStore({get:async()=>session},{model:'deepseek/deepseek-v4-flash',readSessionHistory:async()=>[]});
  const store=create();store.scheduleMonitor=()=>{};
  const cutoff='2026-10-05T02:00:00Z';
  try{
    const run=await store.dispatch(project,{sessionId:session.sessionId,dispatchId:'cutoff-dispatch'},async(_binding,actual)=>{
      await store.recordLearning(project,actual.id,{mountedSkills:['actual-prior-skill']});
      assert.equal(await store.recordRuntimeEgressDispatch(project,actual.id,cutoff),cutoff);
      assert.deepEqual((await store.list(project)).find(row=>row.id===actual.id).mountedSkills,['actual-prior-skill']);
      await store.recordLearning(project,actual.id,{appendCompaction:{at:cutoff,kind:'actual-compaction'}});
      return {accepted:true};
    });
    for(let index=0;index<4;index++)await store.recordLearning(project,run.id,{mountedSkills:['actual-final-skill'],promptDispatchStartedAt:'2099-01-01T00:00:00Z'});
    assert.equal(await store.recordRuntimeEgressDispatch(project,run.id,'2099-01-01T00:00:00Z'),null);
    const events=(await readFile(path.join(project.metaDir,'runs.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    const learning=events.filter(event=>event.event==='learning'&&event.id===run.id);
    assert.equal(learning.length,1,'Cumulative gauge compaction remains bounded');assert.equal(learning[0].promptDispatchStartedAt,cutoff);
    const restarted=create();
    try{const restored=(await restarted.list(project)).find(row=>row.id===run.id);assert.equal(restored.promptDispatchStartedAt,cutoff);assert.deepEqual(restored.mountedSkills,['actual-final-skill']);}finally{await restarted.closeProject(project);}
  }finally{await store.closeProject(project);await rm(root,{recursive:true,force:true});}
});
