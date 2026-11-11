/** Convert the engine's account-scoped observer tables to exact load/query embedding counters. */
import {readFile,writeFile} from 'node:fs/promises';
const path='/srv/evimed/runs/gx-g13-1/summary.json',summary=JSON.parse(await readFile(path,'utf8'));
function usage(snapshot){
 const text=snapshot?.result?.status??'';
 const line=text.split('\n').find(s=>s.includes('qwen3.7-text-embedding')&&s.includes('dashscope'));
 if(!line)throw Error('embedding_observer_row_missing');
 const cells=line.split('|').map(s=>s.trim()).filter(Boolean);
 const calls=Number(cells[2]),tokens=Number(cells[5]);
 if(!Number.isFinite(calls)||!Number.isFinite(tokens))throw Error('embedding_observer_row_invalid');
 return {calls,tokens};
}
const repairs=[];try{for(const line of (await readFile('/srv/evimed/runs/gx-g13-1/repairs.jsonl','utf8')).split('\n').filter(Boolean))repairs.push(JSON.parse(line));}catch{}
summary.infrastructureRepairs={attempts:repairs.length,recoveredFiles:new Set(repairs.filter(r=>!r.error).map(r=>r.uri)).size,wallSeconds:repairs.reduce((n,r)=>n+r.ms,0)/1000};
let calls=0,tokens=0,previous=null;
for(const row of summary.sizes){
 const before=usage(previous?.afterQueriesModels??row.initialModels),after=usage(row.afterLoadModels),queries=usage(row.afterQueriesModels);
 row.stageEmbeddingProviderCalls=after.calls-before.calls;row.stageEmbeddingTokens=after.tokens-before.tokens;
 calls+=row.stageEmbeddingProviderCalls;tokens+=row.stageEmbeddingTokens;
 row.embeddingProviderCalls=calls;row.embeddingTokens=tokens;
 row.queryEmbeddingProviderCalls=queries.calls-after.calls;row.queryEmbeddingTokens=queries.tokens-after.tokens;
 row.repairEmbeddingQueueProcessed=repairs.filter(r=>!r.error&&r.index<=row.size).reduce((n,r)=>n+(r.result?.result?.queue_status?.Embedding?.processed??0),0);row.totalAcknowledgedEmbeddingQueueProcessed=row.cumulativeEmbeddingQueueProcessed+row.repairEmbeddingQueueProcessed;
 row.infrastructureFailedWrites=row.loadErrors;row.recoveredFiles=repairs.filter(r=>!r.error&&r.index<=row.size).length;row.unresolvedFailedWrites=Math.max(0,row.loadErrors-row.recoveredFiles);
 row.costFormulaCny={load:`${tokens} * embeddingCnyPerMillion / 1000000`,per200Queries:`${row.queryEmbeddingTokens} * embeddingCnyPerMillion / 1000000`,monthly:'load / amortizationMonths + queriesPerDay * 30 * per200Queries / 200; excludes answering, extraction and hosting'};
 previous=row;
}
summary.costLimit='Exact account-scoped observer deltas, including the engine embedding wrapper Calls counter and tokens, are recorded. No independent provider HTTP-request attestation or billing rate is available; CNY and per-active-user monthly totals remain unknown without a price and workload. Only GX uses engine account evlab-gx-g13-1.';
summary.memoryLimit='docker stats reports the whole shared engine container, not a per-user allocation or continuous peak.';
await writeFile(path,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary.sizes.map(r=>({size:r.size,embeddingCalls:r.embeddingProviderCalls,embeddingTokens:r.embeddingTokens,queryCalls:r.queryEmbeddingProviderCalls,queryTokens:r.queryEmbeddingTokens}))));
