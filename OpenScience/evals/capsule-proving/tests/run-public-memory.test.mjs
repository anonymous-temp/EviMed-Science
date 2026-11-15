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

test('runner bounds database pools independently from ingestion concurrency', () => {
  const args=['--set','scenarios','--split','dev','--data','/data','--out','/out','--engine-url','http://localhost:1',
    '--engine-key-file','/key','--database-url-file','/db','--ingest-only','--concurrency','8'];
  assert.equal(parseArguments(args).databasePoolMax,2);
  assert.equal(parseArguments([...args,'--database-pool-max','1']).concurrency,8);
  assert.throws(()=>parseArguments([...args,'--database-pool-max','0']),/pool-max/);
});

test('case selection reaches the public reader before adapting unused people', { skip }, async () => {
  const { loadCases } = await import('../run/cases.mjs');
  const cases = await loadCases({set:'realmem',split:'dev',dataDir:DATA,only:'Liam_O_Connor'});
  assert.equal(cases.length,1);
  assert.equal(cases[0].caseId,'Liam_O_Connor');
  assert.equal(cases[0].questions.length,11);
});

test('LoCoMo preserves named speakers and original shared captions like the pinned QA reader', { skip }, async () => {
  const { readPublicMemory } = await import('../run/publicSets.mjs');
  for (const set of ['locomo','locomo-original']) {
    const source=await readPublicMemory({set,split:'dev',dataDir:DATA,only:['conv-26']});
    const cases=await SET_LOADERS[set]({split:'dev',dataDir:DATA,only:['conv-26']});
    const original=source[0].inputs[0].histories.flatMap(h=>h.messages), adapted=cases[0].sessions.flatMap(s=>s.messages);
    assert.equal(adapted.length,original.length);
    assert.ok(original.some(m=>m.imageCaption),'real source includes shared image captions');
    original.forEach((m,i)=>{
      assert.equal(adapted[i].role,m.role);
      assert.equal(adapted[i].text,`${m.speaker} said, "${m.text}"\n${m.imageCaption?` and shared ${m.imageCaption}.`:''}`);
    });
  }
});

test('HaluMem partial-source hallucination verdict retains its official score and carries a separate audit through row merging', async () => {
  const { buildJudgePacket, mergeJudgeResults } = await import('../run/judgePackets.mjs');
  // Reduced recorded case: 8ece194a-885c-8e0c-359e-93a97220252c:s15:q2.
  const gold = { question: 'How did Johnson Joseph plan to maintain his presence in the hospitality industry during his layoff?',
    answer: 'Using AI-generated content for social media.', evidence: [{ memory_content: 'Johnson Joseph plans to use AI-generated content to maintain his social media presence and signal his commitment to the hospitality industry during his career transition.' }] };
  const raw = { runId: 'e0-halumem-dev-product-1', set: 'halumem', split: 'dev', caseId: '8ece194a-885c-8e0c-359e-93a97220252c',
    kind: 'answer', id: '8ece194a-885c-8e0c-359e-93a97220252c:s15:q2', verdict: 'needs-judge', checks: [] };
  const packet = buildJudgePacket(raw, { publicSet: 'halumem', gold, answer: { answer: "During his layoff, Johnson's plan for staying visible in the industry centred on **using AI-generated content to keep up a social media presence** — explicitly as a signal of his ongoing commitment to hospitality rather than as a revenue stream (he settled on this around September 2027)." }, rubric: ['Official rubric'] });
  const officialResult = { evaluation_result: 'Hallucination', reasoning: 'The response introduces unsupported details not present in the Key Memory Points, including around September 2027.' };
  const judged = await judgePublicOfficial([packet], { key: 'fake', fetchImpl: async (_url, init) => {
    const sent = JSON.parse(init.body);
    assert.equal(sent.messages[0].content, packet.publicOfficial.prompt, 'official request stays unchanged');
    return { ok: true, headers: new Headers(), json: async () => ({ model: 'qwen3.8-max', choices: [{ message: { content: JSON.stringify(officialResult) } }] }) };
  } });
  const result = judged.judgements[0];
  assert.equal(result.verdict, 'incorrect');
  assert.equal(result.failureStep, 'fabricated');
  assert.deepEqual(result.officialResult, officialResult);
  assert.deepEqual(result.audit, { sourceStatus: 'judge_partial_source', fullSourceSeen: false, fabricationEvidenceEligible: false });
  const merged = mergeJudgeResults([raw], [packet], [{ ...result, hash: packet.hash }])[0];
  assert.deepEqual(merged.judge.audit, result.audit);
  assert.deepEqual(merged.judge.officialResult, officialResult);
});
