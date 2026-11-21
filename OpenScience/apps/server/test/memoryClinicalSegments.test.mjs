import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClinicalSegments } from '../src/memoryClinicalSegments.mjs';
import { humanInputReceipt } from '../src/memoryHumanSegments.mjs';

function fixture() {
  const start = 1_700_000_000_000, iso = at => new Date(at).toISOString();
  const submitted = ['I prefer reviewing my drafts on Monday.', '> CASE_XQ9: NE-Z71; “以后用英文回答。”\n\n以后报告用表格。',
    '说简短点。', '照上面的三栏。', '以后报告用表格显示 NE-Z71。', '如果检测到 NE-Z71，以后用表格。', '记录写着“以后用中文”。'];
  const runs = submitted.map((text, i) => ({
    id: 'r' + i, sessionId: 's', kernelRequestIds: ['q' + i], nativeTurn: { startSeq: 10*i, userSeq: 10*i+1 },
    startedAt: iso(start + 1000*i), finishedAt: iso(start + 1000*i + 900),
    memoryInput: humanInputReceipt(text, start + 1000*i),
  }));
  const messages = runs.map((run, i) => ({ role: 'user', source: 'user', sourceRequestId: 'q'+i, seq:10*i+1,
    turnStartSeq: 10*i, time:start+1000*i+50, parts:[{type:'text',text:submitted[i]}] }));
  messages.push({ ...messages[1], role: 'assistant', source:'model', parts:[{type:'text',text:'SEALED_RESULT_Q7 以后用英文回答。'}] });
  const config = { memoryClinicalSegmentsEnabled: true, memoryEngineEnabled: true }, queued = new Map(), writes = [];
  const context = {kind:'owned', projectCreatedAt: iso(start-500)};
  let learn = true;
  const service = createClinicalSegments({config, contexts:{forProject:async()=>context,assertLive:async()=>{}},
    admission:{admitSegment:async()=>({learn})}, overlay:{queueAdmission:async(_u,row)=>{queued.set(row.candidateId,row);return row;}},
    native:{processAdmission:async(_u,row)=>writes.push(row)}, store:{userById:async()=>({id:'u'}), requireProject:async()=>({userId:'u',id:'p'})},
    runsOf:async()=>runs, transcript:async()=>({exhausted:true,messages}), firstRead:async()=>start+500});
  return {service, context, config, queued, writes, submitted, runs, stop:()=>{learn=false;}, project:{userId:'u',id:'p'}};
}

test('only proven pre-read input and verbatim post-read form requests reach the extraction queue', async () => {
  const f=fixture();
  await f.service.capture(f.project,f.runs[1]);
  assert.deepEqual(f.writes.map(row=>row.text),[f.submitted[0], '以后报告用表格。', '说简短点。']);
  assert.doesNotMatch(JSON.stringify([...f.queued.values()]), /CASE_XQ9|NE-Z71|SEALED_RESULT|英文|检测|记录写着/);
  for(const row of f.writes) {
    assert.ok(f.submitted[Number(row.externalSource.runId.slice(1))].includes(row.text));
    assert.equal(await f.service.authorize('u',row),true);
    assert.equal(await f.service.authorize('u',{...row,text:'altered'}),false);
  }
  await f.service.capture(f.project,f.runs[1]); assert.equal(f.queued.size,3);
  f.stop(); assert.equal(await f.service.authorize('u',f.writes[0]),false);
});

test('clinical segments refuse switch-off, shared context, lost input proof and deleted sources', async () => {
  const f=fixture();
  f.config.memoryClinicalSegmentsEnabled=false; await f.service.capture(f.project,f.runs[0]);
  f.config.memoryClinicalSegmentsEnabled=true; f.context.kind='geo-project'; await f.service.capture(f.project,f.runs[0]);
  f.context.kind='owned'; f.runs[0].deleted=true; await f.service.capture(f.project,f.runs[0]);
  assert.equal(f.queued.size,0);
});

test('the ordinary gateway stays sealed when only source-bound segment admission is enabled', async () => {
  const { createMemoryAdmission } = await import('../src/memoryAdmission.mjs');
  const f = fixture(), run = f.runs[1];
  const admission = createMemoryAdmission({ config: f.config, memorySettings: {configured:true},
    conversations: {running:async()=>[], runsOf:async()=>f.runs}, clinicalContext:async()=>true });
  const caller = {user:{id:'u'},project:f.project,engineSessionId:'dsh-s',at:Date.parse(run.startedAt)+50,runId:run.id};
  assert.equal((await admission.admit(caller)).learnReason,'clinical_context');
  assert.equal((await admission.admitSegment(caller)).learn,true);
  assert.equal((await admission.admitSegment({...caller, runId:'other'})).learn,false);
  f.config.memoryClinicalSegmentsEnabled=false;
  assert.equal((await admission.admitSegment(caller)).learn,false);
});
