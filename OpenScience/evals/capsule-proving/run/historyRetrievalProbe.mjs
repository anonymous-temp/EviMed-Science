#!/usr/bin/env node
/** Read-only development probe. Gold stays here, outside every product request.
 * Usage: node historyRetrievalProbe.mjs SHARD [v1|v2] [MAX_CASES]
 * Reuses ingested accounts; never invokes extraction or writes history resources. */
import { readFile, writeFile } from 'node:fs/promises';
import { openLab } from './lab.mjs';
import { loadCases } from './cases.mjs';
import { loadGold } from './score.mjs';
import { diagnoseQuestion, sessionMapping, retrievalReport } from './retrieval.mjs';
import { createTranscriptIndex } from './baselines.mjs';

const shard = Number(process.argv[2]), variant = process.argv[3] ?? 'v1';
if (![0,1,2,3].includes(shard) || !['v1','v2'].includes(variant)) throw new Error('invalid probe arguments');
const runId = `e0-longmemeval-s-dev-product-1-shard${shard}`;
const data = '/srv/evimed/data/memdata-data';
const only = (await readFile(`/srv/evimed/runs/lme-shard-${shard}.txt`, 'utf8')).trim();
let cases = await loadCases({ set: 'longmemeval-s', split: 'dev', dataDir: data, only });
const selected=process.env.P11_PROBE_ONLY?.split(',');
if(selected)cases=cases.filter(item=>selected.includes(item.caseId));
if (process.argv[4]) cases = cases.slice(0, Number(process.argv[4]));
const gold = new Map((await loadGold(data, { set: 'longmemeval-s', split: 'dev' })).map(e => [e.caseId,e]));
let lab;
for (let attempt=0;;attempt++) try {
  lab = await openLab({ runId, account: `evlab-${runId}`, engineUrl: `http://127.0.0.1:${19342+shard}`,
  engineKeyFile: '/srv/evimed/ovlab/root.key', databaseUrlFile: '/srv/evimed/ovlab/database.url',
  configOverrides: { memoryHistoryRetrievalV2Enabled: variant === 'v2' }, rejectionJudge: false, databasePoolMax: 2 });
  break;
} catch (error) {
  if (attempt>=4 || !String(error.message).includes('40P01')) throw error;
  await new Promise(resolve=>setTimeout(resolve,2000*(attempt+1)));
}
const rows = [], details = [];
const historySearch=lab.parts.history.search.bind(lab.parts.history);
lab.parts.history.search=async(...args)=>{
  try{return await historySearch(...args);}catch(error){
    const code=/^memory_history_[a-z_]+$/.test(error.message)?error.message:error.code??error.name;
    process.stderr.write(`history_search_failed: ${code}\n`);throw error;
  }
};
let calls = [];
const request = lab.parts.client.request.bind(lab.parts.client);
lab.parts.client.request = async args => {
  const start = Date.now();
  const result = await request(args);
  calls.push({ path: args.path, ms: Date.now()-start,
    ...(args.path === '/api/v1/search/find' ? { candidates: result?.result?.resources?.map(h=>h.uri) ?? [] } : {}),
    ...(args.path === '/api/v1/search/grep' ? { pattern: args.body.pattern, candidates: result?.result?.matches?.map(h=>h.uri) ?? [],
      chunks:result?.result?.matches?.map(h=>{try{const m=JSON.parse(h.content).messages;return {chars:m.reduce((n,r)=>n+r.text.length,0),messages:m.length};}catch{return null;}}).filter(Boolean)??[] } : {}) });
  return result;
};
try {
  for (const item of cases) {
    const user = await lab.user(item.userKey);
    for (const session of item.sessions) lab.noteConversation(user, session);
    const entry = gold.get(item.caseId), mapping = sessionMapping(entry,item,runId);
    const bySession = new Map(mapping.map(m=>[m.engineSession.slice(4),m.sourceSessionId]));
    const registry = (await lab.parts.database.query('SELECT uri,session_id FROM evimed_memory.history_chunks WHERE owner_id=$1 AND state=\'ready\'', [user.userId])).rows;
    const sessionOf = new Map(registry.map(r=>[r.uri,bySession.get(r.session_id)]));
    const history = lab.parts.history, resourcesFor = history.resourcesFor;
    let fused = [];
    history.resourcesFor = context => {
      const resources = resourcesFor(context), search = resources.searchHistory.bind(resources);
      resources.searchHistory = async (...args) => { const result = await search(...args); fused = result.map(h=>h.uri); return result; };
      return resources;
    };
    calls = [];
    const row = await diagnoseQuestion({ entry,item,question:item.questions[0],memory:lab.memoryFor(user),lab,user });
    history.resourcesFor = resourcesFor;
    const channels = calls.filter(c=>c.candidates);
    const mapped = uris => [...new Set(uris.map(uri=>sessionOf.get(uri)).filter(Boolean))];
    const index = createTranscriptIndex(item.sessions);
    details.push({ caseId:item.caseId, gold:row.goldSessionIds, calls, registryChunks:registry.length,
      vector:mapped(channels.filter(c=>c.path.endsWith('/find')).flatMap(c=>c.candidates)),
      grep:mapped(channels.filter(c=>c.path.endsWith('/grep')).flatMap(c=>c.candidates)),
      fused:mapped(fused), fused8:mapped(fused.slice(0,8)), fused20:mapped(fused.slice(0,20)),
      fusedOrder:fused.map(uri=>({uri,sessionId:sessionOf.get(uri)??null})),
      fusedChunkCount:fused.length, fusedSessionCount:mapped(fused).length,
      keyword8:index.search(item.questions[0].text,8).map(h=>mapping[Number(h.sessionId.slice(1))-1]?.sourceSessionId),
      keyword20:index.search(item.questions[0].text,20).map(h=>mapping[Number(h.sessionId.slice(1))-1]?.sourceSessionId) });
    rows.push(row);
    await writeFile(`/srv/evimed/runs/p11-retrieval-${variant}${selected?'-selected':''}-shard${shard}.json`, JSON.stringify({ report:retrievalReport(rows,{runId,historyExcerptCap:variant==='v2'?20:8}),details },null,2));
    process.stdout.write(`${variant} shard${shard} ${rows.length}/${cases.length} ${item.caseId}\n`);
  }
} finally { await lab.close(); }
