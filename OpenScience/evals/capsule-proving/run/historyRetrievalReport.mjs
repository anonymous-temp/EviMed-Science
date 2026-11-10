#!/usr/bin/env node
/** Aggregate the read-only probes with paired, question-cluster bootstrap CIs.
 * Reconstruct V1 fusion for rank/diversity counterfactuals, never for answers. */
import { readFile, writeFile } from 'node:fs/promises';
import { ControlPlaneDatabase } from '../../../apps/server/src/controlPlaneDatabase.mjs';
import { diverseHistoryCandidates, historyLexicalScorer, historyTokens } from '../../../apps/server/src/memoryHistoryRetrieval.mjs';
import { OpenVikingClient } from '../../../apps/server/src/openVikingClient.mjs';
import { OpenVikingResources, escapeGrepPattern } from '../../../apps/server/src/openVikingResources.mjs';
import { controlUserId } from './lab.mjs';
import { loadCases } from './cases.mjs';
import { loadGold } from './score.mjs';
import { sessionMapping } from './retrieval.mjs';

const root='/srv/evimed/runs',data='/srv/evimed/data/memdata-data';
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const before=[],after=[],details=[],chunks=[];
const cases=await loadCases({set:'longmemeval-s',split:'dev',dataDir:data});
const gold=new Map((await loadGold(data,{set:'longmemeval-s',split:'dev'})).map(e=>[e.caseId,e]));
const database=new ControlPlaneDatabase({databaseUrl:(await readFile('/srv/evimed/ovlab/database.url','utf8')).trim(),databasePoolMax:1,databaseConnectionTimeoutMs:10_000});
const engineKey=(await readFile('/srv/evimed/ovlab/root.key','utf8')).trim();
try {
  const registry=(await database.query('SELECT uri,session_id FROM evimed_memory.history_chunks WHERE owner_id LIKE $1 AND state=\'ready\'',['evlab_e0-longmemeval-s-dev-product-1-shard%'])).rows;
  const byUri=new Map(registry.map(r=>[r.uri,r.session_id]));
  for(let shard=0;shard<4;shard++){
    const runId=`e0-longmemeval-s-dev-product-1-shard${shard}`;
    const resources=new OpenVikingResources({client:new OpenVikingClient({openVikingUrl:`http://127.0.0.1:${19342+shard}`,openVikingApiKey:engineKey,openVikingAccount:`evlab-${runId}`})});
    const v1=await json(`${root}/p11-retrieval-v1-shard${shard}.json`),v2=await json(`${root}/p11-retrieval-v2-shard${shard}.json`);
    before.push(...v1.report.rows);after.push(...v2.report.rows);
    for(const detail of v1.details){
      const item=cases.find(c=>c.caseId===detail.caseId);
      const mapping=sessionMapping(gold.get(item.caseId),item,`e0-longmemeval-s-dev-product-1-shard${shard}`);
      const sessionOf=new Map(mapping.map(m=>[m.engineSession.slice(4),m.sourceSessionId]));
      const getSession=uri=>sessionOf.get(byUri.get(uri));
      const channel=kind=>detail.calls.filter(c=>c.path.endsWith(kind)).at(-1)?.candidates??[];
      const found=new Map();
      for(const hits of [channel('/find'),channel('/grep')])for(const [rank,uri]of hits.entries())found.set(uri,(found.get(uri)??0)+1/(60+rank));
      const fused=[...found].sort((a,b)=>b[1]-a[1]).slice(0,80).map(([uri])=>({uri,sessionId:getSession(uri)}));
      const matched=hits=>[...new Set(detail.gold)].filter(g=>hits.some(h=>h.sessionId===g)).length;
      const detailRoot=fused[0]?.uri.split('/').slice(0,7).join('/');
      const lexicalRows=detailRoot ? (await resources.grep(controlUserId(runId,item.userKey),detailRoot,[...new Set(historyTokens(item.questions[0].text))].slice(0,64).map(escapeGrepPattern).join('|'),{limit:500,caseInsensitive:true})).matches : [];
      const corpus=[];
      for(const row of lexicalRows)try{const messages=JSON.parse(row.content).messages;if(Array.isArray(messages))corpus.push({uri:row.uri,messages});}catch{/* unusable rendition is no candidate */}
      const whole=corpus.map(c=>({...c,messages:[{...c.messages[0],text:c.messages.map(m=>m.text).join('\n')}]}));
      const rank=records=>{const scorer=historyLexicalScorer(records,item.questions[0].text);return records.map(c=>({uri:c.uri,sessionId:getSession(c.uri),score:scorer.best(c.messages)?.score??0})).filter(c=>c.score>0).sort((a,b)=>b.score-a.score||a.uri.localeCompare(b.uri));};
      const chunkRank=rank(whole),exchangeRank=rank(corpus);
      details.push({...detail,fusedOrder:undefined,calls:undefined,
        wholeChunk8:matched(chunkRank.slice(0,8)),wholeChunk20:matched(chunkRank.slice(0,20)),
        bestExchange8:matched(exchangeRank.slice(0,8)),bestExchange20:matched(exchangeRank.slice(0,20)),
        diverse8:matched(diverseHistoryCandidates(fused).slice(0,8)),diverse20:matched(diverseHistoryCandidates(fused).slice(0,20)),
        rank8:matched(fused.slice(0,8)),rank20:matched(fused.slice(0,20)),
        first8Conversations:new Set(fused.slice(0,8).map(h=>h.sessionId)).size,
        first8MaxChunks:Math.max(0,...[...new Set(fused.slice(0,8).map(h=>h.sessionId))].map(id=>fused.slice(0,8).filter(h=>h.sessionId===id).length))});
    }
    for(const detail of v2.details)for(const call of detail.calls)chunks.push(...(call.chunks??[]));
  }
}finally{await database.close();}
before.sort((a,b)=>a.qid.localeCompare(b.qid));after.sort((a,b)=>a.qid.localeCompare(b.qid));
if(before.length!==120||after.length!==120||before.some((b,i)=>b.qid!==after[i].qid))throw new Error('incomplete paired probe');
const quantile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(q*values.length))]??null;
const percentiles=values=>({p50:quantile(values,.5),p95:quantile(values,.95)});
let seed=22022;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
const measured=rows=>[0,1].map(index=>{
  const results=rows.map(r=>r.results[index]);
  const goldCount=results.reduce((n,r)=>n+r.goldSessions,0),matched=results.reduce((n,r)=>n+r.history.matched,0);
  const samples=[];
  for(let k=0;k<4000;k++){
    let n=0,h=0;
    for(let j=0;j<results.length;j++){const r=results[Math.floor(random()*results.length)];n+=r.goldSessions;h+=r.history.matched;}
    samples.push(h/n);
  }
  return {limit:results[0].limit,matched,gold:goldCount,recall:matched/goldCount,ci95:[quantile(samples,.025),quantile(samples,.975)],
    latencyMs:percentiles(results.map(r=>r.ms)),emptyBlocks:results.filter(r=>!r.history.returnedExcerpts).length,
    returnedExcerpts:percentiles(results.map(r=>r.history.returnedExcerpts)),
    historyChars:percentiles(results.map(r=>r.blocks.filter(b=>b.startsWith('Original conversation excerpts (')).join('\n').length))};
});
const loss={questions:120,goldSessions:details.reduce((n,d)=>n+d.gold.length,0)};
for(const channel of ['vector','grep','fused','fused8','fused20','keyword8','keyword20'])loss[channel]=details.reduce((n,d)=>n+new Set(d.gold.filter(id=>d[channel].includes(id))).size,0);
for(const key of ['diverse8','diverse20','rank8','rank20','wholeChunk8','wholeChunk20','bestExchange8','bestExchange20'])loss[key]=details.reduce((n,d)=>n+d[key],0);
loss.meanFirst8Conversations=details.reduce((n,d)=>n+d.first8Conversations,0)/details.length;
loss.first8CrowdedQuestions=details.filter(d=>d.first8MaxChunks>2).length;
loss.candidateChunkChars=percentiles(chunks.map(c=>c.chars));loss.candidateChunkMessages=percentiles(chunks.map(c=>c.messages));
const cost={};
for(const variant of ['v1','v2']){
  const calls=[];
  for(let shard=0;shard<4;shard++)for(const d of (await json(`${root}/p11-retrieval-${variant}-shard${shard}.json`)).details)calls.push(d.calls);
  cost[variant]={engineCallsPerSearch:calls.reduce((n,c)=>n+c.length,0)/240,
    retrievalCallsPerSearch:calls.reduce((n,c)=>n+c.filter(r=>r.path==='/api/v1/search/find'||r.path==='/api/v1/search/grep').length,0)/240};
}
const report={at:new Date().toISOString(),before:measured(before),after:measured(after),loss,cost,
  notes:['120 development questions, 220 unique-per-question gold sessions; existing ingested memory, no answer model.',
    'Recall CIs resample questions (4000 replicates); candidate rank/diversity counterfactuals have no content/provenance hydration.',
    'Grep uses the first eight whitespace words as literal OR alternatives in V1, not the whole question as one literal.',
    'Chunk size summaries weight returned grep candidates across requests. Session presence cannot establish answer-span retention.',
    'Engine calls include gateway native-memory search and reads; limits 8 and 20 are pooled for cost.'],details};
await writeFile(`${root}/p11-retrieval-report.json`,JSON.stringify(report,null,2));
process.stdout.write(JSON.stringify({...report,details:undefined},null,2)+'\n');
