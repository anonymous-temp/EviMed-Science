import test from 'node:test';
import assert from 'node:assert/strict';
import { humanInputReceipt, provenArchiveInput, provenTranscriptInput } from '../src/memoryHumanSegments.mjs';

const stamp = seconds => new Date(1_700_000_000_000 + seconds * 1000).toISOString();
const text = 'Please show the decisions first.';
const run = { id: 'human', startedAt: stamp(1), finishedAt: stamp(4), kernelRequestIds: ['req'],
  nativeTurn: { startSeq: 4, userSeq: 5 }, memoryInput: humanInputReceipt(text, Date.parse(stamp(0))) };
const machine = { ...run, id: 'auto', automated: true, startedAt: stamp(5), finishedAt: stamp(8) };
const spoken = { role: 'user', content: text, created_at: stamp(2) };

test('mixed history requires an exact owner receipt and a unique dated run', () => {
  assert.equal(provenArchiveInput([machine, run], spoken).text, text);
  for (const message of [{ ...spoken, role: 'assistant' }, { ...spoken, content: 'scheduled brief' },
    { ...spoken, created_at: undefined }, { ...spoken, created_at: stamp(6) }]) {
    assert.equal(provenArchiveInput([machine, run], message), null);
  }
  for (const runs of [[{ ...run, memoryInput: null }], [run, { ...machine, startedAt: stamp(2) }], [{ ...run, deleted: true }]]) {
    assert.equal(provenArchiveInput(runs, spoken), null);
  }
});

test('kernel input requires its digest, request, user seq and root turn', () => {
  const msg = { role: 'user', source: 'user', content: text, sourceRequestId: 'req', seq: 5, time: Date.parse(stamp(2)), turnStartSeq: 4 };
  assert.equal(provenTranscriptInput(run, [msg]).seq, 5);
  for (const patch of [{ role: 'assistant' }, { source: 'plugin' }, { seq: 7 }, { turnStartSeq: 1 },
    { sourceRequestId: 'other' }, { content: text + ' injected' }]) {
    assert.equal(provenTranscriptInput(run, [{ ...msg, ...patch }]), null);
  }
});

test('both indexed windows and a previously mixed cached window rebuild their titles and text from the dated owner input', async()=>{
  const {createMemoryHistorySources}=await import('../src/memoryHistorySources.mjs');
  const {MemoryHistory,historyChunks}=await import('../src/memoryHistory.mjs');
  const {inputDigest}=await import('../src/memoryHumanSegments.mjs');
  const root='viking://user/u', project={id:'default',userId:'u'}, context={userRoot:root,ownerId:'u',ownerCreatedAt:stamp(0),kind:'owned',namespaceId:'u'};
  const archive=root+'/sessions/dsh-session/history/archive_001', config={memoryHumanSegmentsEnabled:true,memoryHistorySearchEnabled:true};
  const messages=[spoken,{...spoken,role:'assistant',content:'PRIVATE_RESPONSE'}, {...spoken,content:'AUTOMATIC_ONLY',created_at:stamp(6)}];
  const raw=messages.map(JSON.stringify).join('\n'), files=new Map();
  context.sessions={read:async()=>raw};
  const sources=createMemoryHistorySources({config,store:{userById:async()=>({id:'u'}),requireProject:async()=>project},
    productDatabase:{query:async()=>({rows:[{stamp:stamp(0)}]})},nativeMemoryContexts:{assertLive:async()=>{}},
    nativeMemoryOverlay:{projectOfSession:async()=>'default'},agentRuns:{conversationRuns:async()=>[{...machine,title:'AUTOMATIC_ONLY'},run]},
    memorySettings:{sessionState:async()=>({})},agentRegistry:new Map(),memoryAdmission:{admit:async()=>({learn:true})}});
  const resources={writeHistory:async(_u,uri,body)=>files.set(uri,body),readHistory:async(_u,uri)=>files.get(uri),
    searchHistory:async()=>[...files.keys()].map(uri=>({uri}))};
  const history=new MemoryHistory({config,...sources,contexts:{forProject:async()=>context},resourcesFor:()=>resources,
    ledger:{bindArchive:async()=>true,overlay:{removals:async()=>[]},rejected:async()=>false,alreadyIndexed:async()=>false,reserve:async()=>true,ready:async()=>true,
      lookup:async(_u,_epoch,_ns,_p,_pe,uri)=>({project_id:'default',project_created_at:stamp(0),session_id:'session',archive_uri:archive,digest:inputDigest(files.get(uri))}),
      archiveSourceHash:async()=>inputDigest(raw)}});
  const outcome=await history.indexArchive({userId:'u',projectId:'default',engineSession:'dsh-session',archiveUri:archive},context,raw);
  assert.equal(outcome.state,'complete'); assert.equal(outcome.messages,1);
  const [uri,body]=[...files.entries()][0];assert.doesNotMatch(body,/PRIVATE|AUTOMATIC/);
  const search=query=>history.search({user:{id:'u'},project,query});
  const [hit]=await search('decisions');assert.equal(hit.conversationTitle,text);assert.deepEqual(hit.messages.map(m=>m.text),[text]);
  files.set(uri,JSON.stringify({messages:historyChunks(messages)[0].messages}));
  const [legacy]=await search('decisions');assert.equal(legacy.conversationTitle,text);assert.doesNotMatch(JSON.stringify(legacy),/PRIVATE|AUTOMATIC/);
  assert.deepEqual([...(await search('AUTOMATIC_ONLY'))],[]);
});
