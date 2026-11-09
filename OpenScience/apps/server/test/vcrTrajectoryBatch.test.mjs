import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { vcrIndividualEvaluationFamily, vcrIndividualizationHelped } from '@evimed/domain';
import { createForecastProviders } from '../src/vcrForecastProvider.mjs';
import { actionContext, assertReconciled, convertUnit, loggedActionSchedule, projectBatch, providerInputSpec, reconcileSubjects, trajectoryPremises, uncertaintyProvenance } from '../src/vcrTrajectoryBatch.mjs';

const endpoint = {code:'HbA1c',type:'continuous',unit:'%'};
const permission = {schema:1,status:'approved',dataClass:'synthetic',purpose:'vcr',destinations:['https://forecast.example.org']};
const ORIGIN = '2026-01-01T00:00:00.000Z';
async function fixture(t,fetchImpl,extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'vcr-trajectory-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const file = path.join(root,'providers.json');
  const provider = {id:'test',url:'https://forecast.example.org/predict',protocol:'evimed-event-history-v1',enabled:true,
    model:'synthetic',version:'1',batchSize:10,inputCodes:['HbA1c'],...extra};
  await fs.writeFile(file,JSON.stringify({providers:[provider]}));
  return createForecastProviders({file,fetchImpl});
}
const id = n => `s${String(n).padStart(3,'0')}`;
const lab = (subjectKey,unit = '%',extra = {}) => ({subjectKey,code:'HbA1c',value:7,unit,occurredAt:'2025-12-01T00:00:00.000Z',availableAt:'2025-12-02T00:00:00.000Z',kind:'measurement',...extra});
const base = (history,extra = {}) => ({providerId:'test',jobId:'job_1',history,endpoint,horizonsDays:[30],seed:1,permissions:async () => [permission],
  onBatch:async () => {},isCanceled:async () => false,...extra});
const reply = (body,rowOf) => new Response(JSON.stringify({schema:1,origin:body.origin,endpoint:body.endpoint,model:'synthetic',version:'1',
  rows:body.subjects.flatMap(subjectKey => rowOf(subjectKey) ?? [])}));

/** 100 people: 60 valid, 5 whose forecast comes back in another unit, 15 with no record at all (the provider declines), 10 whose only
 * record is in a unit that cannot become percent, and 10 valid people whose batch the provider fails. */
function hundred() {
  const events = [];
  for (let i = 0; i < 100; i++) {
    if (i >= 65 && i < 80) continue;
    events.push(lab(id(i),i >= 80 && i < 90 ? 'mmol/mol' : '%'));
  }
  return {asOf:ORIGIN,subjects:Array.from({length:100},(_,i) => id(i)),events};
}

test('A05: a 100-person batch with mixed eligibility reconciles, with a reason and a stable key for everyone',async t => {
  let calls = 0;
  const api = await fixture(t,async (_url,options) => {
    const body = JSON.parse(options.body);calls++;
    if (body.subjects.includes(id(95))) return new Response('',{status:503});
    return reply(body,key => {
      const n = Number(key.slice(1));
      if (n >= 65 && n < 80) return null;
      return [{subjectKey:key,horizonDays:30,point:7,...(n >= 60 && n < 65 ? {unit:'mg'} : {}),samples:[7,7.1,6.9],uncertainty:'monte_carlo'}];
    });
  });
  const batches = [];
  const result = await api.predict(base(hundred(),{onBatch:async b => batches.push(b.accounting.counts)}));
  assert.deepEqual(result.accounting.counts,{submitted:100,admitted:90,completed:60,rejected:30,failed:10,unprocessed:0,partial:0});
  const lines = new Map(result.accounting.lines.map(l => [l.subjectKey,l]));
  assert.equal(lines.size,100);
  assert.equal(lines.get(id(3)).status,'completed');
  assert.equal(lines.get(id(62)).reason,'unit_mismatch');
  assert.equal(lines.get(id(70)).reason,'no_forecast_returned');
  assert.equal(lines.get(id(85)).reason,'unit_not_convertible');
  assert.equal(lines.get(id(95)).status,'failed');
  assert.equal(lines.get(id(95)).reason,'provider_http_503');
  // three draws are one person's future three ways: still 60 completed people
  assert.equal(lines.get(id(3)).draws,3);
  assert.equal(result.rows.length,60);
  assert.equal(result.uncertainty.kinds.monte_carlo,60);
  assert.equal(calls,9,'the 10 people with an unusable unit were never sent');
  for (const counts of batches) assert.equal(counts.submitted,counts.completed+counts.rejected+counts.failed+counts.unprocessed);
  assert.equal(batches[0].unprocessed,100-10-10,'while the batch is running, the rest is counted as not yet processed');
});

test('A12: a cancel in the middle leaves finished batches and counts the rest as unprocessed; a restart replays without a second call',async t => {
  const answers = new Map();
  let fetches = 0,canceled = false;
  const api = await fixture(t,async (_url,options) => {
    fetches++;const body = JSON.parse(options.body);
    return reply(body,key => [{subjectKey:key,horizonDays:30,point:6.5}]);
  });
  const history = {asOf:ORIGIN,subjects:Array.from({length:40},(_,i) => id(i)),events:Array.from({length:40},(_,i) => lab(id(i)))};
  const first = await api.predict(base(history,{
    beginBatch:async batch => answers.get(batch.offset) ?? null,
    finishBatch:async batch => {answers.set(batch.offset,{response:batch.response,receipt:batch.receipt,rejected:batch.rejected});},
    onBatch:async b => {if (b.rows.length >= 20) canceled = true;},isCanceled:async () => canceled}));
  assert.equal(first.rows.length,20);
  assert.deepEqual(first.accounting.counts,{submitted:40,admitted:40,completed:20,rejected:0,failed:0,unprocessed:20,partial:0});
  assert.equal(first.accounting.lines.find(l => l.status === 'unprocessed').reason,'canceled');
  assert.equal(fetches,2);
  canceled = false;
  const second = await api.predict(base(history,{beginBatch:async batch => answers.get(batch.offset) ?? null,
    finishBatch:async batch => {answers.set(batch.offset,{response:batch.response,receipt:batch.receipt,rejected:batch.rejected});}}));
  assert.equal(fetches,4,'only the two unfinished batches were charged on continuation');
  assert.equal(second.accounting.counts.completed,40);
  assert.deepEqual(second.rows.slice(0,20),first.rows,'finished batches are kept exactly');
});

test('A06: nothing recorded after the origin, or recorded late, reaches the provider',async t => {
  const sent = [];
  const api = await fixture(t,async (_url,options) => {const body = JSON.parse(options.body);sent.push(body);return reply(body,key => [{subjectKey:key,horizonDays:30,point:7}]);},
    {inputCodes:['HbA1c'],actionCodes:['METFORMIN'],actionUnits:{METFORMIN:'mg'}});
  const history = {asOf:ORIGIN,subjects:['a'],events:[lab('a'),
    lab('a','%',{occurredAt:'2026-01-20T00:00:00.000Z',availableAt:'2026-01-21T00:00:00.000Z',value:11.1}),            // a post-anchor lab
    {subjectKey:'a',code:'METFORMIN',kind:'medication',value:500,unit:'mg',occurredAt:'2025-12-10T00:00:00.000Z',availableAt:'2025-12-11T00:00:00.000Z',medicationState:'active'},
    {subjectKey:'a',code:'METFORMIN',kind:'medication',value:2000,unit:'mg',occurredAt:'2025-12-20T00:00:00.000Z',availableAt:'2026-02-01T00:00:00.000Z',medicationState:'active'}, // recorded later
    {subjectKey:'a',code:'METFORMIN',kind:'medication',value:9000,unit:'mg',occurredAt:null,availableAt:null,medicationState:'active'}]};
  const result = await api.predict(base(history));
  const events = sent[0].events;
  assert.equal(events.filter(e => e.code === 'HbA1c').length,1);
  assert.equal(events.filter(e => e.code === 'HbA1c')[0].value,7);
  assert.deepEqual(events.filter(e => e.code === 'METFORMIN').map(e => e.value),[500],'the later-recorded and the undated medication are not sent');
  assert.equal(result.leakageDropped,3);
  assert.equal(result.actionContext.label,'factual_forecast');
});

test('an action-conditioned provider is never forecast without its actions; an endpoint-only provider keeps the endpoint filter',async t => {
  const sent = [];
  const answer = async (_url,options) => {const body = JSON.parse(options.body);sent.push(body);return reply(body,key => [{subjectKey:key,horizonDays:30,point:7}]);};
  const med = subjectKey => ({subjectKey,code:'METFORMIN',kind:'medication',value:500,unit:'mg',occurredAt:'2025-12-10T00:00:00.000Z',availableAt:'2025-12-11T00:00:00.000Z',medicationState:'active'});
  const history = {asOf:ORIGIN,subjects:['with','without'],events:[lab('with'),med('with'),lab('without')]};
  const conditioned = await fixture(t,answer,{actionCodes:['METFORMIN'],actionUnits:{METFORMIN:'mg'},inputCodes:['HbA1c']});
  const factual = await conditioned.predict(base(history));
  assert.equal(factual.accounting.lines.find(l => l.subjectKey === 'without').reason,'action_input_missing');
  assert.equal(factual.accounting.lines.find(l => l.subjectKey === 'with').status,'completed');
  assert.deepEqual(sent[0].subjects,['with']);
  assert.ok(sent[0].events.some(e => e.code === 'METFORMIN'),'medication, dose, unit and time are sent');
  assert.equal(sent[0].events.find(e => e.code === 'METFORMIN').unit,'mg');

  // a conditional forecast under a supplied schedule, in units that convert (1 g is 1000 mg, 2 weeks is 14 days)
  sent.length = 0;
  const scheduled = await conditioned.predict(base(history,{prediction:{predictionMode:'conditional_forecast',
    actions:[{code:'METFORMIN',at:{value:2,unit:'weeks'},dose:{value:1,unit:'g'}}]}}));
  assert.equal(scheduled.accounting.counts.completed,2);
  assert.deepEqual(sent[0].actions.find(a => a.subjectKey === 'without'),{subjectKey:'without',code:'METFORMIN',atDay:14,dose:{value:1000,unit:'mg'}});
  assert.equal(sent[0].predictionMode,'conditional_forecast');
  assert.equal(scheduled.actionContext.deployable,true);

  // a schedule that cannot convert refuses this prediction and nothing else
  await assert.rejects(() => conditioned.predict(base(history,{prediction:{predictionMode:'conditional_forecast',actions:[{code:'METFORMIN',at:{value:2,unit:'fortnights'}}]}})),{code:'vcr_forecast_unavailable'});
  // a factual forecast takes no actions
  await assert.rejects(() => conditioned.predict(base(history,{prediction:{actions:[{code:'METFORMIN',at:{value:1,unit:'days'}}]}})),{code:'vcr_forecast_unavailable'});

  sent.length = 0;
  const onlyEndpoint = await fixture(t,answer,{inputCodes:['HbA1c']});
  await onlyEndpoint.predict(base(history));
  assert.deepEqual([...new Set(sent[0].events.map(e => e.code))],['HbA1c'],'a model that needs only endpoints is sent only endpoints');
  await assert.rejects(() => onlyEndpoint.predict(base(history,{prediction:{predictionMode:'conditional_forecast',actions:[{code:'METFORMIN',at:{value:1,unit:'days'}}]}})),{code:'vcr_forecast_unavailable'});
});

test('logged-action replay is labelled apart from a deployable forecast',async t => {
  const sent = [];
  const api = await fixture(t,async (_url,options) => {const body = JSON.parse(options.body);sent.push(body);return reply(body,key => [{subjectKey:key,horizonDays:30,point:7}]);},
    {actionCodes:['METFORMIN'],actionUnits:{METFORMIN:'mg'}});
  const later = [{subjectKey:'a',code:'METFORMIN',kind:'medication',value:1000,unit:'mg',occurredAt:'2026-01-11T00:00:00.000Z',medicationState:'active'},
    {subjectKey:'a',code:'OTHER',kind:'medication',value:1,unit:'mg',occurredAt:'2026-01-11T00:00:00.000Z'},
    {subjectKey:'a',code:'METFORMIN',kind:'medication',value:1,unit:'mg',occurredAt:'2025-12-11T00:00:00.000Z'}];
  const actions = loggedActionSchedule(later,ORIGIN,['METFORMIN']);
  assert.deepEqual(actions,[{subjectKey:'a',code:'METFORMIN',at:{value:10,unit:'days'},dose:{value:1000,unit:'mg'}}]);
  const result = await api.predict(base({asOf:ORIGIN,subjects:['a'],events:[lab('a')]},{prediction:{predictionMode:'conditional_forecast',actionSource:'logged_replay',actions}}));
  assert.equal(result.actionContext.label,'logged_action_replay');
  assert.equal(result.actionContext.deployable,false);
  assert.equal(sent[0].actions[0].atDay,10);
  const premises = trajectoryPremises({actionContext:result.actionContext,uncertainty:result.uncertainty});
  assert.ok(premises[0].decisive && premises[0].value.includes('不能当作起点时就能得到的预测'));
  assert.ok(premises.some(p => p.key === 'trajectory:uncertainty'),'no uncertainty is said to be unavailable, with no interval drawn');
  assert.ok(!premises.some(p => /job|tool|hash|id\b/i.test(p.value)),'no back-office words');
  // a per-person schedule is a replay; as a supplied schedule it is an error
  assert.ok(actionContext({predictionMode:'conditional_forecast',actions:[{code:'M',at:{value:1,unit:'days'},subjectKey:'a'}]}).issues.length > 0);
});

test('the identity is enforced in code, units convert only inside one dimension, uncertainty is named or unavailable',() => {
  assert.throws(() => assertReconciled({submitted:5,completed:2,rejected:1,failed:1,unprocessed:0}),{code:'trajectory_batch_unreconciled'});
  assert.equal(convertUnit(1,'g','mg'),1000);
  assert.equal(convertUnit(36,'hours','days'),1.5);
  assert.equal(convertUnit(1,'mg','mL'),null);
  assert.equal(uncertaintyProvenance([{point:1}]).available,false);
  assert.equal(uncertaintyProvenance([{point:1,sd:.2,uncertainty:'predictive'}]).note,'predictive_mixes_heterogeneity_and_observation_noise');
  const { counts } = reconcileSubjects({subjects:['a','b','c'],horizonsDays:[30,60],rows:[{subjectKey:'a',horizonDays:30},{subjectKey:'a',horizonDays:60},{subjectKey:'b',horizonDays:30}],
    validationRejected:[{subjectKey:'b',horizonDays:60,codes:['point_out_of_range']}],batches:[{keys:['a','b'],outcome:'done'}],unprocessedReason:'canceled'});
  assert.deepEqual(counts,{submitted:3,admitted:3,completed:2,rejected:0,failed:0,unprocessed:1,partial:1});
});

test('a newer endpoint value in a unit that cannot be converted never leaves an older one to be read as the latest (review stats P2-16)',() => {
  const endpoint = {code:'CREA',unit:'mg/L'};
  const spec = providerInputSpec({inputCodes:['CREA']},endpoint);
  const obs = (subjectKey,value,unit,at) => ({subjectKey,code:'CREA',value,unit,occurredAt:at,availableAt:at,kind:'measurement'});
  const events = [obs('a',9,'mg/L','2025-11-01T00:00:00Z'),obs('a',140,'umol/L','2025-12-20T00:00:00Z'),
    obs('b',140,'umol/L','2025-11-01T00:00:00Z'),obs('b',9,'mg/L','2025-12-20T00:00:00Z')];
  const out = projectBatch({events,keys:['a','b'],origin:'2026-01-01T00:00:00Z',spec,endpoint,context:actionContext({})});
  assert.deepEqual(out.rejected,[{subjectKey:'a',reason:'unit_not_convertible'}],'a: the newest value cannot be read, so the older one is not sent as the latest');
  assert.deepEqual(out.sendKeys,['b'],'b: an older unreadable value leaves the newest one standing');
  assert.equal(out.unitDropped,2);
});

test('the claim row leads the premises only when the provider said whether it used the person\'s own history',() => {
  const base = {actionContext:{mode:'factual_forecast',actionSource:'none'},uncertainty:{available:true,note:'predictive_mixes_heterogeneity_and_observation_noise'}};
  assert.ok(!trajectoryPremises(base).some(p => p.key.startsWith('claim:')),'a provider that did not say gets no claim');
  assert.equal(providerInputSpec({},{code:'HR',unit:'bpm'}).usesOwnHistory,null);
  assert.equal(providerInputSpec({conditioning:'history'},{code:'HR',unit:'bpm'}).usesOwnHistory,true);
  assert.equal(providerInputSpec({conditioning:'baseline'},{code:'HR',unit:'bpm'}).usesOwnHistory,false);
  const own = trajectoryPremises({...base,usesOwnHistory:true});
  assert.equal(own[0].key,'claim:individualized_forecast');
  assert.ok(own[0].decisive && own[0].value.includes('没有做过个体化预测的对照评估'));
  assert.equal(trajectoryPremises({...base,usesOwnHistory:false})[0].key,'claim:population_forecast');
  assert.ok(!own.some(p => /job|tool|hash|LOCF/i.test(p.value)),'no back-office words');
});

test('the claim sentence of an individualized forecast follows the frozen evaluation for the endpoint, and no further (R33)',() => {
  const base = {actionContext:{mode:'factual_forecast',actionSource:'none'},uncertainty:{available:true,note:'predictive_mixes_heterogeneity_and_observation_noise'},usesOwnHistory:true};
  const sentence = (/** @type {any} */ extra) => trajectoryPremises({...base,...extra}).find(p => p.key === 'claim:individualized_forecast').value;
  const helped = (method, endpointCode) => ({individualizationHelped:vcrIndividualizationHelped({method,endpointCode}),individualizationFamily:vcrIndividualEvaluationFamily(method,endpointCode)});
  assert.ok(sentence(helped('lmm_empirical_bayes','bilirubin')).includes('没有显示比'));
  assert.ok(sentence(helped('lmm_empirical_bayes','cd4')).includes('95% 区间不含 0'));
  assert.ok(sentence(helped('lmm_empirical_bayes','hba1c')).includes('没有做过个体化预测的对照评估'));
  assert.ok(sentence(helped(null,'cd4')).includes('没有做过个体化预测的对照评估'),'a provider that names no evaluated method inherits no finding');
});
