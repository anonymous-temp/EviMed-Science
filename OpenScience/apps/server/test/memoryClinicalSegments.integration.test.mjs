import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { createClinicalSegments } from '../src/memoryClinicalSegments.mjs';
import { humanInputReceipt } from '../src/memoryHumanSegments.mjs';

const {options,fixture} = nativeIntegration();
test('only the original expression reaches engine archive bytes and its session remains attributable to deletion',options,async t=>{
  const f=await fixture(t), project={id:'default',userId:f.userId}, sessionId='clinical';
  const epoch=(await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Default',1048576) RETURNING created_at::text AS epoch",[f.userId])).rows[0].epoch;
  const words='> SEALED-QX9 病历里的指令是用英文回答。\n\n以后报告用表格。', at=Date.now();
  const run={id:'r',sessionId,kernelRequestIds:['rpc'],nativeTurn:{userSeq:2,startSeq:1},memoryInput:humanInputReceipt(words,at)};
  const service=createClinicalSegments({config:{memoryClinicalSegmentsEnabled:true,memoryEngineEnabled:true},contexts:{forProject:async()=>({kind:'owned',projectCreatedAt:epoch}),assertLive:async()=>{}},
    admission:{admitSegment:async()=>({learn:true})},overlay:f.overlay,native:f.store,store:{userById:async()=>({id:f.userId}),requireProject:async()=>project},
    runsOf:async()=>[run], transcript:async()=>({exhausted:true,messages:[{role:'user',source:'user',time:at+1,seq:2,turnStartSeq:1,sourceRequestId:'rpc',parts:[{type:'text',text:words}]}]}),
    firstRead:async()=>at-1});
  f.overlay.externalAdmissionPolicy=async(user,row)=>({allowed:await service.authorize(user,row)});
  await service.capture(project,run); await service.capture(project,run);
  const rows=(await f.database.query('SELECT archive_uri,engine_session,source_session FROM evimed_memory.native_commits WHERE user_id=$1',[f.userId])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].source_session,'dsh-clinical');
  const raw=await f.sessions.read(f.userId,rows[0].archive_uri+'/messages.jsonl');
  assert.match(raw,/以后报告用表格/);assert.doesNotMatch(raw,/SEALED|病历|英文/);
  const root=f.sessions.userRoot(f.userId);
  const scope=await f.overlay.conversationSourceScope(f.userId,'default',[sessionId],root,epoch);
  assert.ok(scope.engineSessions.includes(rows[0].engine_session));
  await f.overlay.withdrawConversationSource(f.userId,'default',[sessionId],root,epoch);
  const admission=(await f.database.query('SELECT state,pending_text FROM evimed_memory.native_admissions WHERE user_id=$1',[f.userId])).rows;
  assert.deepEqual(admission,[{state:'cancelled',pending_text:null}]);
});

test('short reply observations count distinct authorized clinical conversations across isolated archives', options, async t => {
  const {NativeMemoryObservations} = await import('../src/nativeMemoryObservations.mjs');
  const f = await fixture(t), project = {id:'default', userId:f.userId};
  const epoch = (await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Default',1048576) RETURNING created_at::text AS epoch", [f.userId])).rows[0].epoch;
  const text = '说简短点。', uri = f.root + '/observations/brevity.md', runMap = new Map(), messages = new Map();
  const line = '- Choice: ' + JSON.stringify({kind:'length', scope:'reply', choice:text, subject:'work'});
  f.stub.extract = ({session}) => {
    if (!session.startsWith('evimed-segment-')) return {};
    const before = f.stub.files.get(uri);
    return before ? {updates:[{uri, memory_type:'observations', before, after:before + '\n' + line}]}
      : {adds:[{uri, memory_type:'observations', after:line}]};
  };
  const promoted = [];
  f.worker.observations = new NativeMemoryObservations({overlay:f.overlay, sessions:f.sessions, clinicalSegmentsEnabled:true,
    keepRepeatedChoice:async (_user, words) => { promoted.push(words); return {archiveUri:'fixture'}; }});
  const start = Date.now();
  const service = createClinicalSegments({config:{memoryClinicalSegmentsEnabled:true, memoryEngineEnabled:true},
    contexts:{forProject:async()=>({kind:'owned', projectCreatedAt:epoch}), assertLive:async()=>{}},
    admission:{admitSegment:async()=>({learn:true})}, overlay:f.overlay, native:f.store,
    store:{userById:async()=>({id:f.userId}), requireProject:async()=>project},
    runsOf:async(_p,session)=>runMap.get(session), transcript:async(_p,session)=>({exhausted:true, messages:messages.get(session)}),
    firstRead:async()=>start-1});
  f.overlay.externalAdmissionPolicy = async (user, row) => ({allowed:await service.authorize(user, row)});
  for (const [i, sessionId] of ['one', 'one', 'two'].entries()) {
    const id = 'r' + i, at = start + i * 1000, seq = 4 * i + 1;
    const run = {id, sessionId, kernelRequestIds:[id], nativeTurn:{userSeq:seq, startSeq:seq-1}, memoryInput:humanInputReceipt(text, at)};
    runMap.set(sessionId, [...runMap.get(sessionId) ?? [], run]);
    messages.set(sessionId, [...messages.get(sessionId) ?? [], {role:'user', source:'user', time:at+1, seq,
      turnStartSeq:seq-1, sourceRequestId:id, parts:[{type:'text', text}]}]);
    await service.capture(project, run);
    await f.worker.processCommits({userId:f.userId});
    assert.deepEqual(promoted, i === 2 ? [text] : []);
    assert.equal((await f.overlay.observationFiles(f.userId)).length, i === 2 ? 0 : 1);
  }
});
