import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createEvolutionTemporalGoldCuration } from '../src/evolutionTemporalGoldCuration.mjs';
const temporalId = `evolution-temporal-${'a'.repeat(64)}`;
const prospectiveId = `evolution-prospective-${'b'.repeat(64)}`;
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'temporal-curation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = { writes: 0, reviews: 0, urls: [] };
  const source = '<article><p>Participants received intervention. The estimate was 2.5.</p></article>';
  const study = { protocolSection: { identificationModule: { nctId: 'NCT12345678', briefTitle: 'Exact registry target' }, statusModule: { resultsFirstPostDateStruct: { date: '2026-10-04' } } }, hasResults: true, resultsSection: { estimate: 2.5 } };
  const observation = { id: temporalId, payload: { paperId: 'doi:10.1234/new', toolId: 'tool', artifactDigest: 'sha256:fixed', firstPublicAt: '2026-10-04T00:00:00Z', firstPublicEvidenceId: 'official-public-proof' } };
  const tool = { id: 'tool', payload: { status: 'active', artifactDigest: 'sha256:fixed', capabilityIds: ['statistical-analysis'], frozenAt: '2026-10-01T00:00:00Z', modelReleasedAt: '2026-09-01T00:00:00Z', modelReleaseEvidenceId: 'release-proof' } };
  const registration = { id: prospectiveId, payload: { ...observation.payload, ...tool.payload, targetIdentity: 'clinicaltrials.gov:NCT12345678:results', registrationEligible: true, actualPinnedToolUse: true, prediction: 'DO NOT SEND PREDICTION TO GOLD CURATOR', predictionHash: 'immutable-prediction', question: 'Estimate the intervention effect', preRegisteredProtocol: { primaryOutcome: 'effect' } } };
  const curator = createEvolutionTemporalGoldCuration({ config: { dataDir: root },
    canonicalize: async () => ({ verified: true, canonicalId: 'doi:10.1234/new', aliases: ['doi:10.1234/new', 'PMC123'] }),
    fetchImpl: async url => {
      calls.urls.push(String(url));
      if (String(url).startsWith('https://clinicaltrials.gov/')) return new Response(JSON.stringify(study));
      if (String(url).startsWith('https://api.crossref.org/')) return Response.json({ message: { DOI: '10.1234/new' } });
      if (String(url).includes('/search?')) return Response.json({ resultList: { result: [{ doi: '10.1234/new', pmcid: 'PMC123', title: 'Target paper', firstPublicationDate: '2026-10-04' }] } });
      return new Response(source);
    },
    write: async input => { calls.writes++; assert.equal(JSON.stringify(input).includes(registration.payload.prediction), false);
      return { writerModel: 'deepseek-v4-flash', writerModelReported: true, question: 'Write a report assessing reproducibility of this intervention estimate', variants: ['Prepare an independent reproducibility report', 'Assess whether exact intervention analysis can be reproduced', 'Write a methods and reproducibility assessment'], sourceQuotes: [input.kind === 'prospective' ? '"estimate":2.5' : 'The estimate was 2.5.'], numeric: { effect: { value: 2.5, absoluteTolerance: 0, quote: input.kind === 'prospective' ? '"estimate":2.5' : 'The estimate was 2.5.' } }, ...options.proposal }; },
    review: async input => { calls.reviews++; return { passed: true, model: 'qwen3.8-max', modelReported: true, provider: 'dashscope', evidenceIds: [input.sourceHash], ...options.review }; },
  });
  return { root, curator, calls, observation, tool, registration };
}
test('new eligible primary paper automatically freezes control-only question gold; retry reuses original bytes', async t => {
  const f = await fixture(t); const result = await f.curator.prepareHoldout({ observation: f.observation, tool: f.tool });
  assert.equal(result.ok, true); assert.equal(result.access, 'evaluation-only'); assert.equal('numeric' in result, false);
  const bytes = await readFile(result.goldPath, 'utf8'), gold = JSON.parse(bytes);
  const { validateRewrite } = await import('../../../evals/paper-gold/evaluator.mjs');
  assert.equal(validateRewrite(gold.definition.cases[0].rewrite, { identifiers: gold.definition.cases[0].policy.aliases }), true);
  assert.equal(gold.observationId, temporalId); assert.equal(gold.definition.cases[0].gold.benchmarkScope, 'question-only');
  assert.equal(gold.definition.cases[0].gold.inputAvailable, false); assert.deepEqual(gold.definition.cases[0].gold.numeric, {});
  assert.deepEqual(gold.definition.cases[0].dois, ['10.1234/new']);
  assert.ok(gold.definition.cases[0].rewrite.variants.every(text => text.includes('No hash-verified same-version research input asset is supplied')));
  assert.ok(gold.sourceProvenance.length >= 2);
  assert.equal(gold.preservedEvidence[0].sha256, gold.sourceHash); assert.equal(gold.qa.modelReported, true);
  assert.deepEqual(await f.curator.prepareHoldout({ observation: f.observation, tool: f.tool }), result);
  assert.deepEqual({ writes: f.calls.writes, reviews: f.calls.reviews }, { writes: 1, reviews: 1 });
  assert.equal(await readFile(result.goldPath, 'utf8'), bytes);
  f.observation.payload.firstPublicEvidenceId = 'changed';
  await assert.rejects(f.curator.prepareHoldout({ observation: f.observation, tool: f.tool }), /changed/);
});
test('actual posted registry results generate independent prospective numeric gold, never exposing the frozen prediction', async t => {
  const f = await fixture(t); const result = await f.curator.prepareProspective({ registration: f.registration });
  assert.equal(result.ok, true); const gold = JSON.parse(await readFile(result.goldPath, 'utf8'));
  assert.equal(gold.targetIdentity, f.registration.payload.targetIdentity); assert.equal(gold.numeric.effect.value, 2.5);
  assert.equal(gold.inputAvailable, false); assert.equal(gold.benchmarkScope, 'numeric-prospective-prediction');
  assert.deepEqual(f.calls.urls, ['https://clinicaltrials.gov/api/v2/studies/NCT12345678']);
});
test('unknown chronology, unsupported target and unreported/non-Qwen QA cannot produce temporal gold', async t => {
  const f = await fixture(t); f.tool.payload.frozenAt = '2026-10-05T00:00:00Z';
  assert.equal((await f.curator.prepareHoldout({ observation: f.observation, tool: f.tool })).ok, false);
  assert.equal(f.calls.writes, 0); assert.equal(f.calls.urls.length, 0);
  f.registration.payload.targetIdentity = 'unsupported:paper';
  assert.equal((await f.curator.prepareProspective({ registration: f.registration })).resourceCode, 'prospective_primary_type_unsupported');
  for (const review of [{ modelReported: false }, { model: 'deepseek-flash' }, { provider: 'deepseek' }, { evidenceIds: ['invented-source'] }]) {
    const rejected = await fixture(t, { review });
    assert.equal((await rejected.curator.prepareHoldout({ observation: rejected.observation, tool: rejected.tool })).resourceCode, 'temporal_independent_qa_unconfirmed');
  }
});
test('invented numeric/quotation values fail before independent review or file publication', async t => {
  const f = await fixture(t, { proposal: { numeric: { effect: { value: 21, absoluteTolerance: 0, quote: 'The estimate was 2.5.' } } } });
  assert.equal((await f.curator.prepareHoldout({ observation: f.observation, tool: f.tool })).resourceCode, 'temporal_numeric_quote_bond_failed');
  assert.equal(f.calls.reviews, 0);
  await assert.rejects(readFile(path.join(f.root, 'evaluation-control/paper-gold/time-holdout', `${temporalId}.json`)), { code: 'ENOENT' });
});

test('prospective score invokes the production curator when gold is absent, then scores only the immutable prediction', async t => {
  const { createEvolutionProspectiveScore } = await import('../src/evolutionProspectiveScore.mjs');
  const { createHash } = await import('node:crypto');
  const f = await fixture(t); const record = f.registration.payload;
  record.prediction = 'The intervention effect is 2.5.';
  record.predictionHash = createHash('sha256').update(JSON.stringify(record.prediction)).digest('hex');
  record.transcriptHash = 'frozen-transcript';
  const saved = [];
  const service = { get: async () => f.registration, now: () => new Date('2026-10-05'), ingestEvent: async () => {}, save: async (...args) => { saved.push(args); return { id: args[1], payload: args[2] }; } };
  const score = createEvolutionProspectiveScore({ service, config: { dataDir: f.root }, prepareGold: f.curator.prepareProspective,
    verifyPinnedRun: async () => ({ ok: true, modelFamily: 'deepseek', predictionHash: record.predictionHash, transcriptHash: record.transcriptHash, toolId: record.toolId, digest: record.artifactDigest }),
    extractPrediction: async input => { assert.equal(input.text, record.prediction); assert.equal('gold' in input, false); return { independent: true, modelFamily: 'qwen', numeric: { effect: { value: 2.5, quote: '2.5' } } }; },
  });
  const result = await score.score({ registrationId: f.registration.id });
  assert.equal(result.status, 'scored'); assert.equal(result.passed, true); assert.equal(f.calls.writes, 1); assert.equal(f.calls.reviews, 1);
  assert.equal(saved[0][2].units[0].eligibleForMainMetric, false); assert.equal(saved[0][2].units[0].allStagesValid, false);
  const composition = await readFile(new URL('../src/evolutionComposition.mjs', import.meta.url), 'utf8');
  assert.ok(composition.includes('prepareGold: temporalGold.prepareProspective')); assert.ok(composition.includes('prepareGold: temporalGold.prepareHoldout'));
});


test('the actual evaluator rewrite contract rejects incomplete variants and leaked target aliases before gold freeze', async t => {
 for(const proposal of [{variants:['Only one question']},{question:'Report doi:10.1234/new',variants:['First neutral question','Second neutral question','Third neutral question']},{writerModelReported:false}]) {
  const f=await fixture(t,{proposal});
  assert.equal((await f.curator.prepareHoldout({observation:f.observation,tool:f.tool})).ok,false);
  await assert.rejects(readFile(path.join(f.root,'evaluation-control/paper-gold/time-holdout',`${temporalId}.json`)),{code:'ENOENT'});
 }
});


test('date-only official provenance cannot establish an intraday post-freeze publication', async t => {
 const f=await fixture(t);
 f.observation.payload.firstPublicAt='2026-10-04T14:00:00Z';f.tool.payload.frozenAt='2026-10-04T12:00:00Z';
 assert.equal((await f.curator.prepareHoldout({observation:f.observation,tool:f.tool})).resourceCode,'temporal_earliest_public_chronology_unconfirmed');
 assert.equal(f.calls.writes,0);
});

test('weekly production consumer prepares absent gold, validates frozen rewrite, and attributes exact successful tool use', async t => {
 const { prepareWeekly } = await import('../src/evolutionTimeHoldout.mjs');
 const { validateRewrite } = await import('../../../evals/paper-gold/evaluator.mjs');
 const f=await fixture(t),saved=[];
 Object.assign(f.observation.payload,{kind:'temporal-evaluation-candidate',status:'awaiting-gold'});f.tool.payload.track='M';
 const service={list:async kind=>kind==='observation'?[f.observation]:kind==='use'?[{payload:{projectId:'eval-paper-temporal',runId:'actual-test-run',toolId:f.tool.id,digest:f.tool.payload.artifactDigest,result:{ok:true}}}]:[],
  get:async id=>id===f.tool.id?f.tool:null,owner:async()=> 'operator',now:()=>new Date('2026-10-05'),ingestEvent:async()=>{},save:async(...args)=>{saved.push(args);return{id:args[1],payload:args[2]};}};
 const result=await prepareWeekly({service,config:{dataDir:f.root},day:'2026-10-05',jobId:'durable-weekly-job',prepareGold:f.curator.prepareHoldout,canonicalize:async()=>({verified:true,canonicalId:'doi:10.1234/new'}),
  paperGold:{run:async input=>{assert.equal(input.jobId,'durable-weekly-job');const testCase=input.definition.cases[0];assert.equal(validateRewrite(testCase.rewrite,{identifiers:testCase.policy.aliases}),true);assert.ok(testCase.rewrite.variants.every(text=>text.includes('No hash-verified same-version research input asset is supplied')&&text.includes('exact toolId')));return{units:[{id:'actual-test-run',type:'question',producerProjectId:'eval-paper-temporal',producerRunId:'actual-test-run',benchmarkScope:'question-only',allStagesValid:false,fullResearchReproductionValid:false}]};}}});
 assert.equal(result.status,'observed');assert.equal(result.observed,1);assert.equal(f.calls.writes,1);assert.equal(f.calls.reviews,1);
 assert.equal(saved.find(args=>args[0]==='evaluation')[2].units[0].actualPinnedToolAttribution,true);
 assert.equal(saved.find(args=>args[0]==='observation')[2].status,'scored');
});
test('prospective gold carries a tolerance derived from the printed number, whatever the writer supplied', async t => {
  // The writer asks for +/- 2 around a registry estimate printed as 2.5: that would accept 0.6 and 4.4.
  const f = await fixture(t, { proposal: { numeric: { effect: { value: 2.5, absoluteTolerance: 2, quote: '"estimate":2.5', quantity: 'difference' } } } });
  const result = await f.curator.prepareProspective({ registration: f.registration });
  assert.equal(result.ok, true);
  const gold = JSON.parse(await readFile(result.goldPath, 'utf8'));
  assert.deepEqual({ printed: gold.numeric.effect.printed, basis: gold.numeric.effect.toleranceBasis, quantity: gold.numeric.effect.quantity }, { printed: '2.5', basis: 'printed-precision', quantity: 'difference' });
  assert.ok(Math.abs(gold.numeric.effect.absoluteTolerance - 0.05) < 1e-9);
});
