import assert from 'node:assert/strict';
import test from 'node:test';
import { historyTokens, historyPeriods, historyLexicalScorer, diverseHistoryCandidates, compactHistoryMessages } from '../src/memoryHistoryRetrieval.mjs';
import { OpenVikingResources } from '../src/openVikingResources.mjs';
import { MemoryHistory } from '../src/memoryHistory.mjs';
import { createHash } from 'node:crypto';

const message = (text,index=0,sourceRole='user',date='2025-08-01T10:00:00Z')=>({text,index,sourceRole,date});
test('history V2 fast check: BM25 finds rare terms, preserves numbers/CJK, and scores exchanges without adjacent dilution',()=>{
  assert.deepEqual(historyTokens('A17 42 患者过敏'),['a17','42','患者','者过','过敏']);
  const records=[{messages:[message('I like tea and coffee')]},{messages:[message('I used the A17 sensor with 42 samples'),message('Unrelated '.repeat(150),1,'assistant'),message('next exchange',2)]}];
  const scorer=historyLexicalScorer(records,'What sensor A17 had 42 samples?');
  assert.ok(scorer.best(records[1].messages).score>scorer.best(records[0].messages).score);
  assert.ok(scorer.rarity('A17'.toLowerCase())>scorer.rarity('i'));
  assert.deepEqual(historyPeriods('August 2025 and 2025-09-02 or 2024年2月3日'),['2025-09-02','2025-08','2024-02-03']);
  const dates=historyLexicalScorer([{messages:[message('same fact')]}],'fact August 2025');
  assert.ok(dates.score([message('same fact')])>dates.score([message('same fact',0,'user','2024-08-01')]));
});

test('history diversity admits two per conversation before exhausting others and removes duplicate candidate URIs',()=>{
  const input=['a/1','a/2','a/3','b/1','a/4','b/2','b/1','c/1'].map(uri=>({uri}));
  assert.deepEqual(diverseHistoryCandidates(input).map(h=>h.uri),['a/1','a/2','b/1','b/2','c/1','a/3','a/4']);
});

test('history compact windows preserve matching exchange, eliminate repeated carried messages and stay bounded',()=>{
  const messages=[message('Old assistant text',0,'assistant'),message('Tell me about sensor A17',1),message('A17 measured 42 samples. '+ 'More details. '.repeat(100),2,'assistant')];
  const scorer=historyLexicalScorer([{messages}],'A17 samples'),seen=new Set();
  const first=compactHistoryMessages(messages,'A17 samples',scorer,600,seen);
  assert.deepEqual(first.map(m=>m.index),[1,2]);
  assert.match(first[1].text,/42 samples/);
  assert.ok(first.reduce((sum,m)=>sum+m.text.length+80,0)<=600);
  const second=compactHistoryMessages(messages,'A17 samples',scorer,600,seen);
  assert.deepEqual(second.map(m=>m.index),[0]);
  assert.deepEqual(compactHistoryMessages(messages,'A17 samples',scorer,600,seen),[]);
});

test('V2 lexical engine path escapes query terms, ranks actual text, fuses vectors and never reads a different root',async()=>{
  const root=`viking://user/u-111111111111111111111111/resources/history/${'a'.repeat(24)}`;
  const rare=`${root}/${'b'.repeat(24)}/${'c'.repeat(24)}-1.md`,common=`${root}/${'d'.repeat(24)}/${'e'.repeat(24)}-1.md`;
  const calls=[];
  const resources=new OpenVikingResources({client:{async request(input){
    calls.push(input);
    if(input.path.endsWith('/find'))return {result:{resources:[{uri:common}]}};
    return {result:{matches:[{uri:common,content:JSON.stringify({messages:[message('what did I tell you about my work')]})},
      {uri:rare,content:JSON.stringify({messages:[message('A17 sensor had 42 samples')]})},
      {uri:'viking://user/other/forged',content:JSON.stringify({messages:[message('A17')]})}]}};
  }}});
  const hits=await resources.searchHistory('u',root,'A17 with 42 samples? [x+]',{retrievalV2:true});
  assert.equal(hits[0].uri,rare);assert.equal(hits.length,2);
  assert.equal(calls.length,2);assert.equal(calls[1].body.node_limit,500);
  assert.match(calls[1].body.pattern,/a17/);assert.ok(!calls[1].body.pattern.includes('?'));
  assert.equal(calls[0].body.target_uri,root);assert.equal(calls[1].body.uri,root);
});

test('V2 rescues rare terms on a saturated grep page and tolerates one failed channel',async()=>{
  const root=`viking://user/u-111111111111111111111111/resources/history/${'a'.repeat(24)}`;
  const common=`${root}/${'b'.repeat(24)}/${'c'.repeat(24)}-1.md`,rare=`${root}/${'d'.repeat(24)}/${'e'.repeat(24)}-1.md`;
  let calls=0;
  const resources=new OpenVikingResources({client:{async request(input){
    calls++;
    if(input.path.endsWith('/find'))throw new Error('vector unavailable');
    if(input.body.node_limit===500)return {result:{matches:Array.from({length:500},()=>({uri:common,content:JSON.stringify({messages:[message('common topic')]})}))}};
    return {result:{matches:[{uri:rare,content:JSON.stringify({messages:[message('ZX99 sensor')]})}]}};
  }}});
  assert.equal((await resources.searchHistory('u',root,'common ZX99 sensor',{retrievalV2:true}))[0].uri,rare);
  assert.equal(calls,5);
});

test('V2 overlaps at most four validations and returns its proven prefix before a slow tail consumes the gateway deadline',async()=>{
  const hash=text=>createHash('sha256').update(text).digest('hex');
  const context={ownerId:'u',ownerCreatedAt:'2026-01-01',namespaceId:'personal',kind:'owned',userRoot:`viking://user/u-${'a'.repeat(24)}`};
  const root=`${context.userRoot}/resources/history/${hash(context.ownerCreatedAt).slice(0,24)}`;
  const body=JSON.stringify({messages:[message('trial fact')]}),raw=JSON.stringify({role:'user',content:'trial fact',created_at:'2025-08-01T10:00:00Z'});
  const metas=new Map(Array.from({length:20},(_,i)=>{
    const session=`session${i}`,uri=`${root}/${hash('default').slice(0,24)}/${hash(session).slice(0,24)}/${'b'.repeat(24)}-0.md`;
    return [uri,{session_id:session,project_id:'default',project_created_at:'2026-01-01',archive_uri:`${context.userRoot}/sessions/dsh-${session}/history/archive_001`,digest:hash(body)}];
  }));
  let reads=0,active=0,maxActive=0,release;
  const gate=new Promise(resolve=>{release=resolve;}),pending=[];
  const resources={searchHistory:async()=>[...metas.keys()].map(uri=>({uri})),readHistory:async()=>{
    active++;maxActive=Math.max(maxActive,active);reads++;
    const task=reads>4?gate:Promise.resolve();pending.push(task);await task;active--;return body;
  }};
  const service=new MemoryHistory({config:{memoryHistorySearchEnabled:true,memoryHistoryRetrievalV2Enabled:true,memoryGatewayTimeoutMs:800},
    contexts:{forProject:async()=>context},ledger:{lookup:async(_u,_o,_n,_p,_pc,uri)=>metas.get(uri),rejected:async()=>false,archiveSourceHash:async()=>hash(raw)},
    resourcesFor:()=>resources,eligible:async()=>true,admitMessage:async()=>true,
    resolveSource:async c=>({projectId:'default',projectCreatedAt:'2026-01-01',sessionId:c.engineSession?.slice(4),conversationTitle:'Trial',conversationUrl:'/app/chat/trial'})});
  context.sessions={read:async()=>raw};
  try{
    const hits=await service.search({user:{id:'u'},project:{id:'default'},query:'trial',limit:20});
    assert.equal(hits.length,4);assert.equal(maxActive,4);assert.equal(reads,8);
  }finally{release();await Promise.all(pending);await new Promise(resolve=>setImmediate(resolve));}
});
