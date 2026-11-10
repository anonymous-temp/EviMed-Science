/** Compact numerical handoff for the commander; raw records remain exclusively on the lab host. */
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {readFile,writeFile} from 'node:fs/promises';
const summaries={};for(const item of ['g7','g8','g12','g13'])summaries[item]=JSON.parse(await readFile(`/srv/evimed/runs/gx-${item}-1/summary.json`,'utf8'));
const {g7,g8,g12,g13}=summaries;
if(!g13.sizes.some(v=>v.size===10000)||(!g13.skipped100000&&!g13.sizes.some(v=>v.size===100000)))throw Error('scale_measurement_incomplete');
assert.equal(g7.users.reduce((n,u)=>n+u.n,0),g7.n);
assert.equal(g7.archiveReaderRecheck.mismatches,0);
assert.equal(g12.completedFiles,g12.files);
for(const area of Object.values(g12.areas)){assert.equal(area.pass,area.tests);assert.equal(area.skipped,0);assert.equal(area.infrastructureErrors,0);}
const loadedFiles=new Set();
for await(const line of createInterface({input:createReadStream('/srv/evimed/runs/gx-g13-1/packed-load.jsonl'),crlfDelay:Infinity})){
 if(!line.trim())continue;const row=JSON.parse(line);assert.equal(row.result.vector_status,'complete');loadedFiles.add(row.uri);
}
try{for(const line of (await readFile('/srv/evimed/runs/gx-g13-1/repairs.jsonl','utf8')).split('\n').filter(Boolean)){const row=JSON.parse(line);if(!row.error){assert.equal(row.result.result.vector_status,'complete');loadedFiles.add(row.uri);}}}catch(error){if(error.code!=='ENOENT')throw error;}
assert.equal(loadedFiles.size,500);
for(const size of [1000,10000]){
 const queries=new Map();
 for await(const line of createInterface({input:createReadStream(`/srv/evimed/runs/gx-g13-1/queries-${size}.jsonl`),crlfDelay:Infinity})){
  if(!line.trim())continue;const row=JSON.parse(line);assert(!queries.has(row.id));queries.set(row.id,row);
  assert.equal(row.hit,row.hits.slice(0,5).some(hit=>hit.uri===row.sourceUri));
 }
 assert.equal(queries.size,200);let checked=0;
 for await(const line of createInterface({input:createReadStream(`/srv/evimed/data/memdata-data/scale/scale-${size}.jsonl`),crlfDelay:Infinity})){
  if(!line.trim())continue;const row=JSON.parse(line),query=queries.get(row.id);if(query){assert(row.text.startsWith(query.query));assert(loadedFiles.has(query.sourceUri));checked++;}
 }
 assert.equal(checked,200);
 const row=g13.sizes.find(row=>row.size===size);assert.equal(row.hit5,[...queries.values()].filter(row=>row.hit).length);assert.equal(row.errors,[...queries.values()].filter(row=>row.error).length);
}
const report={completedAt:new Date().toISOString(),checkout:JSON.parse(await readFile(new URL('checkout.json',import.meta.url),'utf8')),
 validation:{archiveReaderAgrees:true,allExistingSuitesPassed:true,successfulIndexedFiles:loadedFiles.size,queryCountsAndUnchangedPrefixes:true},
 rawRoot:'/srv/evimed/runs',ledger:'/srv/evimed/results/ledger.jsonl',
 g7:{sourceRun:g7.sourceRun,sourceRunCommit:g7.sourceCommit,users:g7.users.length,n:g7.n,withOrigin:g7.withOrigin,originShare:g7.originShare,byType:g7.byType,sample:g7.sample,productArchiveReaderRecheck:g7.archiveReaderRecheck,
 labelledUniqueLines:g7.renderedAttribution.uniqueCounts,labelledGoldItems:Object.fromEntries(Object.entries(g7.renderedAttribution.counts).map(([k,v])=>[k,{planted:v.planted,anchorMatched:v.matchedItems,labelled:v.labelledItems}])),limit:g7.renderedAttribution.method},
 g8:{reference:58,n:90,settings:Object.fromEntries(Object.entries(g8.settings).map(([k,v])=>[k,{invented:v.summary.partial.inventedRuns,n:90,fullAllGiven:v.summary.full.allGiven,pairsRight:v.summary.pairs.bothRight,errors:v.errors,unjudged:v.summary.partial.unjudged,usage:v.usage}])),promptAudit:g8.promptAudit,comparison:g8.referenceComparison},
 g12:{areas:g12.areas,totalTests:Object.values(g12.areas).reduce((n,v)=>n+v.tests,0),totalPassed:Object.values(g12.areas).reduce((n,v)=>n+v.pass,0),files:g12.files},
 g13:{statementsPerFile:g13.statementsPerFile,writePath:g13.writePath,writeDeviation:g13.writeDeviation,sizes:g13.sizes.map(v=>({statements:v.size,files:v.files,queries:v.n,p50Ms:v.p50Ms,p95Ms:v.p95Ms,hit5:v.hit5,hitAt5:v.hitAt5,queryErrors:v.errors,loadSeconds:v.cumulativeLoadSeconds,embeddingCalls:v.embeddingProviderCalls,embeddingTokens:v.embeddingTokens,queryEmbeddingCalls:v.queryEmbeddingProviderCalls,queryEmbeddingTokens:v.queryEmbeddingTokens,containerMemoryAfterLoad:v.afterLoadMemory?.MemUsage,containerMemoryAfterQueries:v.afterQueriesMemory?.MemUsage,failedWriteAttempts:v.infrastructureFailedWrites,recoveredFiles:v.recoveredFiles,unresolvedFailedWrites:v.unresolvedFailedWrites,costCny:v.costCny,costFormulaCny:v.costFormulaCny})),skipped100000:g13.skipped100000,costLimit:g13.costLimit,memoryLimit:g13.memoryLimit},
 limitations:['G7 literal token and label checks do not establish semantic faithfulness. No-token lines are separate; missing gold anchors keep their planted denominator.',
 'G8 is the remembered-format instrument, not a full kernel run. Its Flash judge is the same model family as the answerer; the historical reference is not a concurrent control.',
 'G12 proves existing suite outcomes; it adds no new tests. PostgreSQL suites were run serially.',
 'G13 packs unrelated corpus statements 20 per notes file. It measures those 50/500 files, not 1,000/10,000 independently indexed records. It bypasses extraction and does not measure whole-product monthly cost.'],
 ledgerMetadata:'Initial G7/G8/G12 rows used the older development-run commit. Append-only correction rows reference the superseded ids; their values are unchanged.'};
await writeFile('/srv/evimed/runs/gx-g13-1/combined-summary.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({g7:report.g7.withOrigin,g8:report.g8.settings,g12:report.g12.totalPassed,g13:report.g13.sizes}));
