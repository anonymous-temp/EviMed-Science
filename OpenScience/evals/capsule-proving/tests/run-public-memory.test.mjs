import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SET_LOADERS, assertCase, toIso } from '../run/sets.mjs';
import { publicPool, PUBLIC_MEMORY_SETS } from '../run/publicSets.mjs';
import { loadGold } from '../run/score.mjs';
import { parseArguments, assertResumeCompatible } from '../run/run.mjs';
import { publicOfficialPacket, judgePublicOfficial } from '../run/publicJudge.mjs';
const DATA = process.env.CAPSULE_PROVING_DATA ?? '/srv/evimed/data/memdata-data';
const skip = !existsSync(`${DATA}/public`);

test('public readers refuse non-development splits before access', async () => {
  for (const set of PUBLIC_MEMORY_SETS) await assert.rejects(SET_LOADERS[set]({ split: 'sealed', dataDir: '/does-not-exist' }), /development_only/);
});
test('public source date spellings retain original UTC times', () => {
  assert.equal(toIso('1:56 pm on 8 May, 2023'), '2023-05-08T13:56:00.000Z');
  assert.equal(toIso('Dec 15, 2025, 06:11:23'), '2025-12-15T06:11:23.000Z');
});
for (const set of PUBLIC_MEMORY_SETS) test(`${set}: real development pool, gold separation and temporal checkpoints`, { skip }, async () => {
  const cases = await SET_LOADERS[set]({ split: 'dev', dataDir: DATA });
  const gold = await loadGold(DATA, { set, split: 'dev' });
  const ids = publicPool(set, 'dev').ids;
  const qs = cases.flatMap(c => c.questions);
  assert.equal(qs.length, set === 'locomo-original' ? 94 : ids.size);
  assert.equal(gold.flatMap(g => g.gold.questions).length, qs.length);
  assert.equal(new Set(qs.map(q => q.qid)).size, qs.length);
  for (const c of cases) {
    assertCase(c);
    const g = gold.find(g => g.caseId === c.caseId);
    for (const q of c.questions) {
      assert.ok(ids.has(q.qid));
      const ref = g.gold.questions.find(g => g.qid === q.qid);
      assert.equal(q.afterSession, ref.afterSession);
      assert.equal(q.text, ref.question);
      if (set === 'realmem') assert.equal(q.afterSession, ref.official.sessionIndex, 'question precedes own session');
      if (set === 'halumem') assert.equal(q.afterSession, ref.official.sessionIndex + 1);
    }
    if (set.startsWith('locomo')) assert.equal(c.roleMapping.rule, 'speaker_a=user, speaker_b=assistant');
    if (set === 'memsyco') assert.equal(c.sessions.length, 1);
  }
  console.log(JSON.stringify({ set, cases: cases.length, sessions: cases.reduce((n,c) => n+c.sessions.length,0), questions: qs.length,
    rubrics: [...new Set(gold.flatMap(g => g.gold.questions.map(q => q.rubric)))] }));
});

test('stock engine option and resume identity', () => {
  const args = ['--set','scenarios','--split','dev','--data','/data','--out','/out','--engine-url','http://localhost:1',
    '--engine-key-file','/key','--database-url-file','/db','--ingest-only','--stock-engine'];
  assert.equal(parseArguments(args).stockEngine, true);
  assert.throws(() => assertResumeCompatible({ arm:'product',set:'x',split:'dev',engine:{templates:'stock',urls:[]} },
    { arm:'product',set:'x',split:'dev',engine:{urls:[]},stockEngine:false }), /templates/);
});
test('official judges preserve native labels and scalar scores', async () => {
  for (const [set, gold, result] of [
    ['halumem', { question:'Q',answer:'A',evidence:[{memory_content:'M'}] }, { reasoning:'missing',evaluation_result:'Omission' }],
    ['realmem', { question:'Q',reference_answer:'A',memory_used:[{content:'M'}] }, { reason:'partial',score:2 }],
  ]) {
    const packet = { id:'p',publicOfficial:publicOfficialPacket(set,gold,'reply') };
    assert.ok(packet.publicOfficial.prompt.includes('M'));
    const judged = await judgePublicOfficial([packet], { key:'fake',fetchImpl:async () => ({ ok:true,headers:new Headers(),
      json:async () => ({ model:'qwen3.8-max',choices:[{message:{content:JSON.stringify(result)}}] }) }) });
    assert.equal(judged.judgements[0].verdict, 'incorrect');
    assert.deepEqual(judged.judgements[0].officialResult, result);
  }
});

test('public scorer retains absent answers in denominator and preserves native official packets', { skip }, async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { scoreRun } = await import('../run/score.mjs');
  const dir = await mkdtemp(join(tmpdir(),'e2-public-score-'));
  try {
    for (const set of PUBLIC_MEMORY_SETS) {
      const cases = await SET_LOADERS[set]({ split:'dev',dataDir:DATA });
      const c = cases[0], root = join(dir,set), caseDir = join(root,'cases',c.caseId);
      await mkdir(caseDir,{recursive:true});
      await writeFile(join(root,'run.json'),JSON.stringify({runId:`test-${set}`,set,split:'dev',arm:'product',options:{only:c.caseId}}));
      await writeFile(join(caseDir,'answers.jsonl'),JSON.stringify({qid:c.questions[0].qid,caseId:c.caseId,answer:'A saved response',arm:'product',toolCalls:[]})+'\n');
      const result=await scoreRun({run:root,data:DATA,noJudge:true});
      assert.equal(result.rows.length,c.questions.length);
      assert.equal(result.rows.filter(r=>r.verdict==='unknown').length,c.questions.length);
      assert.equal(result.packets.length,1);
      assert.equal(Boolean(result.packets[0].publicOfficial),['realmem','halumem'].includes(set));
      assert.equal(result.summary.rubric,set.startsWith('locomo')?'approximate':'official');
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
