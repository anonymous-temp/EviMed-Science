/** Write external rows, then use the canonical append-only ledger CLI requested by the owner. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {wilson as wilsonInterval} from '../run/ledger.mjs';
const item=process.argv[2];if(!['g7','g8','g12','g13'].includes(item))throw Error('expected g7/g8/g12/g13');
const path=`/srv/evimed/runs/gx-${item}-1`,summary=JSON.parse(await readFile(`${path}/summary.json`,'utf8'));
let existing=null;try{existing=await readFile(`${path}/ledger-rows.json`,'utf8');}catch{}
if(existing){const result=execFileSync(process.execPath,['evals/capsule-proving/run/ledger.mjs','add','--json',`${path}/ledger-rows.json`,'--ledger','/srv/evimed/results/ledger.jsonl'],{cwd:'/srv/evimed/repo/OpenScience',encoding:'utf8'});console.log(result.trim());process.exit(0);}
if(item==='g8'&&Object.keys(summary.settings).length!==2)throw Error('g8_incomplete');
if(item==='g13'&&!summary.skipped100000&&!summary.sizes.some(v=>v.size===100000))throw Error('g13_incomplete');
const source=JSON.parse(await readFile('/srv/evimed/runs/v3-synthetic-users-dev-product-1/run.json','utf8'));
const digest=createHash('sha256');
for(const name of ['g7.mjs','g7-attribution.mjs','g8.py','g12.py','g13.mjs','prompt-audit.mjs'])digest.update(await readFile(new URL(name,import.meta.url)));
const checkout=JSON.parse(await readFile(new URL('checkout.json',import.meta.url),'utf8'));
const base={runId:`gx-${item}-1`,commit:checkout.commit,engine:{version:source.engine.version,templatesDigest:source.engine.templatesDigest},arm:'product',flags:{automated:true,lane:'GX',sourceRunCommit:source.commit,sourceDigest:digest.digest('hex'),...(item==='g13'?{statementsPerFile:20,writePath:'engine-content-write',extraction:false}:{})},set:item,split:'dev',tokens:{prompt:0,completion:0,cached:0,extractionPrompt:0,extractionCompletion:0},costCny:null,wallSeconds:summary.wallSeconds??0,scorer:'gx-20261110-v1',rawPath:path};
const rows=[];
function add(metric,n,value,notes='',extra={}){rows.push({...base,metric,n,value,ci95:null,judged:{code:n,judge:0,unknown:0,error:0},notes,...extra});}
function proportion(metric,pass,n,notes='',extra={}){add(metric,n,n?pass/n:0,notes,{ci95:n?wilsonInterval(pass,n):null,...extra});}
if(item==='g7'){
 proportion('line_origin_coverage',summary.withOrigin,summary.n,'uri + product lineFingerprint; all 17 final development snapshots');
 for(const [type,v]of Object.entries(summary.byType))proportion(`line_origin_coverage_${type}`,v.withOrigin,v.n);
 proportion('hard_tokens_all_present',summary.sample.allTokensPresent,summary.sample.n,'Includes no-token lines as vacuous matches; archive failures retained');
 proportion('hard_tokens_supported_nonempty',summary.sample.supported,summary.sample.supported+summary.sample.missingTokens,'102 sampled lines have no hard tokens; literal support is not semantic correctness');
 add('sample_no_hard_tokens',summary.sample.n,summary.sample.noHardTokens);
 for(const [category,v]of Object.entries(summary.renderedAttribution.counts)){
  proportion(`provenance_labelled_lines_${category}`,v.labelledLines,v.matchedLines,summary.renderedAttribution.method);
  proportion(`provenance_labelled_items_${category}`,v.labelledItems,v.planted,'All planted gold items retained; missing anchors are not silently removed');
  add(`gold_anchor_matched_items_${category}`,v.planted,v.matchedItems);
 }
}
if(item==='g12'){
 for(const [area,v]of Object.entries(summary.areas))proportion(`suite_pass_${area}`,v.pass,v.tests,'Existing tests; serial files through lab-test.sh int; no new tests', {judged:{code:v.pass+v.fail,judge:0,unknown:v.skipped,error:v.cancelled}});
 const n=Object.values(summary.areas).reduce((s,v)=>s+v.tests,0),p=Object.values(summary.areas).reduce((s,v)=>s+v.pass,0);proportion('suite_pass_all',p,n,'38 suites; disjoint file-level totals');
}
if(item==='g8'){
 for(const [mode,v]of Object.entries(summary.settings)){
  const common={arm:`thinking-${mode}`,wallSeconds:v.wallSeconds,tokens:{...base.tokens,...v.usage}};
  proportion('fabricating_partial_replies',v.summary.partial.inventedRuns,90,'Own remembered-format scorer; 30 pairs x3; DeepSeek Flash judge fixed thinking off. Reference 58/90.',{...common,judged:{code:0,judge:90-v.summary.partial.unjudged,unknown:v.summary.partial.unjudged,error:v.errors}});
  proportion('full_all_given',v.summary.full.allGiven,90,'Own paired instrument full-side retention',common);
  proportion('pairs_both_right',v.summary.pairs.bothRight,90,'Own paired instrument full + partial',common);
 }
}
if(item==='g13'){
 for(const v of summary.sizes){
  const extra={arm:`packed-${v.size}`,flags:{...base.flags,statements:v.size,files:v.files}};
  proportion('source_statement_hit_at_5',v.hit5,200,'Source file in top 5; 20 statements/file. Queries/errors keep denominator 200.',{...extra,judged:{code:200-v.errors,judge:0,unknown:0,error:v.errors}});
  add('search_p50_ms',200,v.p50Ms,'Sequential product gateway calls, including errors',extra);
  add('search_p95_ms',200,v.p95Ms,'Nearest-rank quantile, including errors',extra);
  add('load_seconds',v.size,v.cumulativeLoadSeconds,'Cumulative write time; fresh account; bypassed extraction',extra);
  add('embedding_queue_jobs',v.size,v.totalAcknowledgedEmbeddingQueueProcessed??v.cumulativeEmbeddingQueueProcessed,'Acknowledged engine queue jobs including repairs; not provider HTTP calls',extra);
  if(v.embeddingProviderCalls!==null)add('embedding_provider_calls_load',v.size,v.embeddingProviderCalls,'Account-scoped observer counter delta; account used only by GX',extra);
  if(v.embeddingTokens!==null&&v.embeddingTokens!==undefined)add('embedding_tokens_load',v.size,v.embeddingTokens,'Account-scoped observer token delta',extra);
  if(v.queryEmbeddingProviderCalls!==undefined)add('embedding_provider_calls_queries',200,v.queryEmbeddingProviderCalls,'Account-scoped engine embedding wrapper call counter',extra);
  if(v.queryEmbeddingTokens!==undefined)add('embedding_tokens_queries',200,v.queryEmbeddingTokens,'Account-scoped engine embedding token counter',extra);
  const mem=String(v.afterLoadMemory?.MemUsage??'').match(/^([0-9.]+)([KMG]iB)/);
  if(mem)add('engine_memory_mib_after_load',1,Number(mem[1])*({KiB:1/1024,MiB:1,GiB:1024}[mem[2]]),'Whole shared engine container docker stats; not a per-user allocation or continuous peak',extra);
  add('infrastructure_failed_write_attempts',v.size,v.infrastructureFailedWrites??v.loadErrors,'Failed writes kept in raw log; repairs separate',extra);
  add('infrastructure_recovered_files',v.size,v.recoveredFiles??0,'Identical corpus content retried only after an indexing infrastructure failure',extra);
 }
}
await writeFile(`${path}/ledger-rows.json`,JSON.stringify(rows,null,2)+'\n');
const result=execFileSync(process.execPath,['evals/capsule-proving/run/ledger.mjs','add','--json',`${path}/ledger-rows.json`,'--ledger','/srv/evimed/results/ledger.jsonl'],{cwd:'/srv/evimed/repo/OpenScience',encoding:'utf8'});
console.log(result.trim());
