import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAnswerFork } from '../run/forkAnswers.mjs';
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'answer-fork-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source'),out=join(root,'out'),dir=join(source,'cases','u');await mkdir(join(dir,'snapshots'),{recursive:true});
  const c={caseId:'u',userKey:'u',sessions:[{sessionId:'s001'},{sessionId:'s002'}],questions:[
    {qid:'past',text:'Past?',asOf:'2026-01-01',afterSession:1},{qid:'last',text:'Last?',asOf:'2026-01-02',afterSession:2}]};
  const sourceRun={runId:'source',split:'dev',arm:'product',flags:{maintain:'none',plantCorruptionsAfter:null,config:{}}};
  const status=['u/ingest/s001','u/snapshot/1','u/answer/past','u/ingest/s002','u/snapshot/2'].map(k=>'2026-01-01T00:00:00Z DONE '+k+' ok').join('\n');
  await writeFile(join(source,'STATUS'),status+'\n');
  await writeFile(join(dir,'ingest.jsonl'),[1,2].map(i=>JSON.stringify({sessionId:`s00${i}`,commit:{status:'completed'},settle:{open:0}})+'\n').join(''));
  await writeFile(join(dir,'snapshots','1.json'),'{}');await writeFile(join(dir,'snapshots','2.json'),'{}');
  await writeFile(join(dir,'answers.jsonl'),JSON.stringify({qid:'past',question:'Past?',asOf:'2026-01-01',arm:'product',answer:'saved'})+'\n');
  return {source,out,cases:[c],sourceCases:[structuredClone(c)],sourceRun,set:'synthetic-users',split:'dev',dir};
}
test('fork refuses incomplete ingestion before creating an output',async t=>{
  const f=await fixture(t);await writeFile(join(f.source,'STATUS'),'');
  await assert.rejects(prepareAnswerFork(f),/ingestion_incomplete/);await assert.rejects(access(f.out));
});
test('fork refuses changed history and missing earlier answers',async t=>{
  const f=await fixture(t);f.sourceCases[0].sessions[0].sessionId='changed';
  await assert.rejects(prepareAnswerFork(f),/history_changed/);
  f.sourceCases=structuredClone(f.cases);await writeFile(join(f.dir,'answers.jsonl'),'');
  await assert.rejects(prepareAnswerFork(f),/past_answer_missing/);await assert.rejects(access(f.out));
});
test('fork freezes the first prefix, leaves source untouched and does not import variants',async t=>{
  const f=await fixture(t),before=await readFile(join(f.dir,'answers.jsonl'),'utf8');
  await writeFile(join(f.dir,'answers.both.jsonl'),'variant is not a primary answer\n');
  const r=await prepareAnswerFork(f);assert.equal(r.cases[0].copiedAnswers,1);assert.equal(r.readOnly,true);
  assert.equal(await readFile(join(f.dir,'answers.jsonl'),'utf8'),before);
  await assert.rejects(access(join(f.out,'cases','u','answers.both.jsonl')));
  await writeFile(join(f.dir,'answers.jsonl'),before+JSON.stringify({qid:'last',question:'Last?',asOf:'2026-01-02',arm:'product',answer:'later'})+'\n');
  assert.deepEqual(await prepareAnswerFork(f),r);
  assert.equal(await readFile(join(f.out,'cases','u','answers.jsonl'),'utf8'),before,'resume never replaces the frozen prefix with later source answers');
});

test('fork refuses unsettled final state and changed questions on resume',async t=>{
  const f=await fixture(t);
  await writeFile(join(f.dir,'ingest.jsonl'),[1,2].map(i=>JSON.stringify({sessionId:`s00${i}`,commit:{status:'completed'},settle:{open:i===2?1:0}})+'\n').join(''));
  await assert.rejects(prepareAnswerFork(f),/unsettled/);
  await writeFile(join(f.dir,'ingest.jsonl'),[1,2].map(i=>JSON.stringify({sessionId:`s00${i}`,commit:{status:'completed'},settle:{open:0}})+'\n').join(''));
  await prepareAnswerFork(f);f.cases[0].questions[1].text='Changed?';
  await assert.rejects(prepareAnswerFork(f),/resume_identity_changed/);
});

test('live fact proof includes readable facts and excludes the derived index',async()=>{
  const {visibleForkFiles}=await import('../run/forkAnswers.mjs');
  assert.deepEqual(visibleForkFiles({files:{'profile.md':'person','preferences/tea.md':'mint','evimed/index.md':'derived','observations/x.md':'not a fact'}}),
    {'profile.md':'person','preferences/tea.md':'mint'});
});

test('fork preserves a final-checkpoint error as a finished attempt instead of retrying it',async t=>{
  const f=await fixture(t),before=await readFile(join(f.dir,'answers.jsonl'),'utf8');
  await writeFile(join(f.dir,'answers.jsonl'),before+JSON.stringify({qid:'last',question:'Last?',asOf:'2026-01-02',arm:'product',answer:'',error:'max_rounds'})+'\n');
  const r=await prepareAnswerFork(f);
  assert.deepEqual(r.cases[0].preservedErrors,['last']);
  const answers=(await readFile(join(f.out,'cases','u','answers.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(answers.at(-1).error,'max_rounds');
  assert.match(await readFile(join(f.out,'STATUS'),'utf8'),/DONE u\/answer\/last source-record-frozen: error retained/);
});
