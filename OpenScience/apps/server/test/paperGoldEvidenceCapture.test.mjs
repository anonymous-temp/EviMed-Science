import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {waitPaperGoldTranscript,readPaperGoldArtifacts,paperGoldTraceCoverage} from '../src/paperGoldEvaluator.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
test('terminal sealing race waits for exact-run complete durable evidence; partial timeout and abort stay honest',async()=>{
 let reads=0;const complete={header:{runId:'run',completeness:'complete',missing:[]},messages:[]};
 const result=await waitPaperGoldTranscript({project:{},runId:'run',timeoutMs:100,pollMs:1,read:async()=>++reads===1?{header:{runId:'run',completeness:'partial'}}:complete});assert.equal(result.complete,true);assert.equal(reads,2);
 for(const transcript of [{header:{runId:'other',completeness:'complete'}},{header:{runId:'run',completeness:'complete',missing:[{reason:'corrupt'}]}},null]){const timed=await waitPaperGoldTranscript({project:{},runId:'run',timeoutMs:2,pollMs:1,read:async()=>transcript});assert.equal(timed.complete,false);}
 const abort=new AbortController();abort.abort();await assert.rejects(waitPaperGoldTranscript({project:{},runId:'run',signal:abort.signal}),{name:'AbortError'});
});
test('missing/changed/wrong-run producer artifacts and malformed JSON are unit gaps, not whole-cycle exceptions',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'paper-capture-')),project={workspaceDir:dir},run={id:'run',artifacts:['numeric.json','code.py','missing.json','invalid.json']};
 try{
  const good='{"ROR":2,"deterministicChecks":[{"id":"fake","valid":true}]}';await fs.writeFile(path.join(dir,'numeric.json'),good);await fs.writeFile(path.join(dir,'code.py'),'changed code');await fs.writeFile(path.join(dir,'invalid.json'),'{broken');
  const receipt={runId:'run',entries:[{files:[{path:'numeric.json',sha256:sha(good)},{path:'code.py',sha256:sha('old code')},{path:'invalid.json',sha256:sha('{broken')}]}]};
  const result=await readPaperGoldArtifacts({project,run,receipt});assert.equal(result.numeric.ROR,2);assert.ok(!('checks' in result));assert.equal(result.issues.length,3);assert.ok(!result.deliveredText.some(x=>x.path==='code.py'));
  const wrong=await readPaperGoldArtifacts({project,run,receipt:{...receipt,runId:'other'}});assert.deepEqual(wrong.numeric,{});assert.deepEqual(wrong.deliveredText,[]);
  const unavailable=await readPaperGoldArtifacts({project,run:{id:'unsupported',artifacts:[]},receipt:null});assert.deepEqual(unavailable.numeric,{});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('complete DSH transcript cannot certify unmanaged specialist egress; capabilities listing alone is discovery',()=>{
 const transcript=action=>({messages:[{parts:[{type:'tool',tool:'mcp__evimed__meta_analysis',input:{action},status:'completed'}]}]});
 assert.equal(paperGoldTraceCoverage(transcript('capabilities')).complete,true);
 for(const action of ['start','status']){const actual=paperGoldTraceCoverage(transcript(action));assert.equal(actual.complete,false);assert.deepEqual(actual.unobservedTools,['meta_analysis']);}
 assert.equal(paperGoldTraceCoverage({messages:[{parts:[{type:'text',text:'meta_analysis start'}]}]}).complete,true);
});

// Release 6 (2026-10-06): the receipt of all six producer runs pinned the three analysis files; five runs also delivered a report,
// an input file or scratch scripts. The paths below are the real shapes of run f7af08d0 (its report and one input file) and
// of run 6d5866b3 (scratch files outside deliverables/).
test('a delivered file the producer receipt never pinned is listed as unverified, is never read as evidence, and is not an artifact issue', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-unpinned-'));
 const base = 'deliverables/paper-gold-analysis';
 const files = {
  [`${base}/analysis-results.json`]: JSON.stringify({ pooled_log: -0.2, preservedSources: [{ id: 'hackshaw-main-dl', sha256: 'a'.repeat(64) }] }),
  [`${base}/analysis-run.json`]: JSON.stringify({ replicates: 2 }),
  [`${base}/analysis.py`]: 'def analyze(**kw):\n    return {}\n',
  [`${base}/report.md`]: 'The report names PMID 9365295.',
  [`${base}/inputs/supplied-37-study-inputs.json`]: JSON.stringify({ studies: [{ yi: 1 }] }),
  'scratch/run_analysis.py': 'print(1)\n',
 };
 try {
  for (const [relative, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true }); await fs.writeFile(path.join(dir, relative), text); }
  const pinned = [`${base}/analysis-results.json`, `${base}/analysis-run.json`, `${base}/analysis.py`];
  const receipt = { runId: 'run', entries: [{ files: pinned.map(relative => ({ path: relative, sha256: sha(files[relative]) })) }] };
  const run = { id: 'run', artifacts: Object.keys(files) };
  const result = await readPaperGoldArtifacts({ project: { workspaceDir: dir }, run, receipt });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.unverified.map(row => row.path).sort(), [`${base}/inputs/supplied-37-study-inputs.json`, `${base}/report.md`, 'scratch/run_analysis.py'].sort());
  assert.ok(result.unverified.every(row => row.reason === 'not_pinned_by_producer_receipt'));
  // What scoring reads is the pinned set alone: no unpinned text reaches the evidence or the numbers.
  assert.deepEqual(result.deliveredText.map(row => row.path).sort(), pinned.sort());
  assert.equal(result.numeric.pooled_log, -0.2);
  assert.deepEqual(result.recalledEvidenceIds, ['hackshaw-main-dl']);
  // The citation scan still reads every delivered text file: an unpinned report that names the protected paper is exposure.
  assert.ok(result.auditText.some(text => text.includes('PMID 9365295')));
  // A file the receipt pins whose bytes changed afterwards is not "unverified": it is an artifact issue and keeps its name.
  await fs.writeFile(path.join(dir, `${base}/analysis.py`), 'def analyze(**kw):\n    return {"changed": 1}\n');
  const changed = await readPaperGoldArtifacts({ project: { workspaceDir: dir }, run, receipt });
  assert.deepEqual(changed.issues, [{ path: `${base}/analysis.py`, reason: 'producer_receipt_hash_unverified' }]);
  assert.equal(changed.unverified.length, 3);
  assert.ok(!changed.deliveredText.some(row => row.path.endsWith('analysis.py')));
 } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
