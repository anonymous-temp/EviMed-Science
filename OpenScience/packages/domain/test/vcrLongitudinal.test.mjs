import assert from 'node:assert/strict'
import test from 'node:test'
import {eventsFromMappedTable,replayClinicalEvents,validateForecast,evaluateForecast,compareForecasts,forecastDesignInputs,
  empiricalCrps,discrimination,ipcwBrier,metricIntervals,longitudinalNumber,evaluateTrialBenchmark} from '../index.mjs'

const origin = '2026-01-01T00:00:00.000Z'
const endpoint = {code:'HbA1c',type:'continuous',unit:'%'}
/** @param {string} subjectKey @param {number} value @param {string} [occurredAt] @param {Record<string,any>} [extra] */
const event = (subjectKey,value,occurredAt = origin,extra = {}) => ({subjectKey,value,originalValue:String(value),occurredAt,availableAt:occurredAt,
  recordedAt:occurredAt,code:'HbA1c',unit:'%',valueSource:'observed',assertion:'affirmed',experiencer:'patient',source:{inputNamespace:'one'},...extra})
/** @param {any[]} rows @param {Record<string,any>} [extra] */
const prediction = (rows,extra = {}) => ({historyId:'history_a',origin,endpoint,horizonsDays:[30],rows,...extra})

test('mapping retains missingness, original units, semantic state and source address',() => {
  const mapped = eventsFromMappedTable({header:['USUBJID','test','value','unit','at','known'],rows:[['a','HbA1c','','%','2025-01-01','2025-01-02']]},
    {subjectColumn:'USUBJID',codeColumn:'test',valueColumn:'value',unitColumn:'unit',occurredColumn:'at',availableColumn:'known'},
    {inputId:'snap:1',inputHash:'a'.repeat(64),valueSource:'observed',ingestedAt:'2026-01-01'})
  assert.equal(mapped.events[0].value,null)
  assert.equal(mapped.events[0].unit,'%')
  assert.equal(mapped.events[0].medicationState,'unknown')
  assert.equal(mapped.events[0].source.row,2)
  assert.equal(longitudinalNumber(''),null)
  assert.equal(longitudinalNumber(false),null)
})

test('late revisions and arbitrary future perturbations cannot change past input',() => {
  const old = event('a',7,'2025-12-01T00:00:00.000Z',{sourceEventId:'test1',revision:1})
  const late = {...old,value:90,originalValue:'90',revision:2,availableAt:'2026-02-01T00:00:00.000Z'}
  const past = replayClinicalEvents([old,old,late,event('a',100,'2027-01-01T00:00:00.000Z')],origin)
  assert.deepEqual(past.events,[old])
  assert.equal(past.coverage.excluded.duplicate,1)
  assert.deepEqual(replayClinicalEvents([old,{...late,value:-9000}],origin).events,[old])
  assert.equal(replayClinicalEvents([old,late],'2026-03-01').events[0].value,90)
  assert.equal(replayClinicalEvents([old,{...old,value:8,originalValue:'8'}],origin).issues[0].code,'event_revision_conflict')
  assert.equal(replayClinicalEvents([event('b',9,origin,{availableAt:null})],origin).coverage.excluded.unknown_time,1)
})

test('one malformed forecast does not discard usable rows; no probability/unit/horizon guessing',() => {
  const good = {subjectKey:'a',horizonDays:30,point:7,quantiles:[{p:.05,value:6},{p:.95,value:8}],uncertainty:'predictive'}
  const checked = validateForecast(prediction([good,{...good,subjectKey:'b',point:NaN},{...good,subjectKey:'c',unit:'mmol/mol'}]),{subjects:new Set(['a','b','c'])})
  assert.equal(checked.rows.length,1);assert.equal(checked.issues.length,2)
  assert.equal(validateForecast(prediction([{...good,point:1.1}],{endpoint:{code:'event',type:'risk',unit:'probability'}})).rows.length,0)
  assert.equal(validateForecast(prediction([{...good,absorbedAtDays:10}])).rows.length,0)
  assert.equal(validateForecast(prediction([{...good,quantiles:[{p:.05,value:9},{p:.95,value:8}]}])).rows.length,0)
})

test('rank metrics, ties, CRPS and IPCW agree with independent enumerations',() => {
  const ranks = discrimination([{point:.1,actual:0},{point:.4,actual:0},{point:.35,actual:1},{point:.8,actual:1}])
  assert.equal(ranks.auroc,.75); assert.ok(Math.abs(Number(ranks.averagePrecision)-5/6)<1e-12)
  assert.deepEqual(discrimination([{point:.5,actual:0},{point:.5,actual:1}]),{auroc:.5,averagePrecision:.5})
  assert.equal(empiricalCrps([0,2],1),.5)
  // Reverse KM resolves tied events before censoring; G(1-)=1 and G(2)=1/2.
  assert.equal(ipcwBrier([{point:.5,eventTime:1,censorTime:null},{point:.5,eventTime:null,censorTime:1},{point:.5,eventTime:null,censorTime:3}],2,'risk'),.25)
  // Two fully observed participants: one event and one survivor, no censoring weights.
  assert.ok(Math.abs(Number(ipcwBrier([{point:.8,eventTime:10,censorTime:40},{point:.2,eventTime:null,censorTime:40}],30,'risk'))-.04)<1e-12)
  // One early censor: the remaining survivor receives inverse probability 2.
  assert.ok(Math.abs(Number(ipcwBrier([{point:.9,eventTime:null,censorTime:10},{point:.2,eventTime:null,censorTime:40}],30,'risk'))-.04)<1e-12)
  assert.equal(ipcwBrier([{point:.2,eventTime:null,censorTime:30}],30,'risk'),null)
  assert.equal(ipcwBrier([{point:.2,eventTime:null,censorTime:10}],30,'risk'),null)
})

test('evaluation separates heldout subjects, missing outcomes and synthetic engineering results',() => {
  const history = {asOf:origin,dataClass:'synthetic',events:[event('a',6),event('b',5),event('c',8)],split:{assignments:{a:'test',b:'calibration',c:'test'}}}
  const pred = prediction([{subjectKey:'a',horizonDays:30,point:7,sd:.5,uncertainty:'predictive'},{subjectKey:'b',horizonDays:30,point:900},{subjectKey:'c',horizonDays:30,point:8}])
  const result = evaluateForecast(pred,history,{dataClass:'synthetic',events:[event('a',8,'2026-01-31T00:00:00.000Z'),event('b',4,'2026-01-31T00:00:00.000Z')]},{bootstrap:10})
  assert.equal(result.groups[0].metrics.mae.value,1)
  assert.equal(result.groups[0].missingOutcomes,1)
  assert.equal(result.groups[0].subjects,1)
  assert.equal(result.groups[0].baselines.persistence.metrics.mae.value,2)
  assert.equal(result.groups[0].baselines.persistence.comparisons.mae.preferred,'model')
  assert.equal(result.groups[0].baselines.persistence.comparisons.mae.modelMinusBaseline,-1)
  assert.equal(result.validationClass,'engineering_synthetic')
  assert.equal(result.trainingOverlap,'unknown')
  assert.equal(result.groups[0].distributionAvailability.predictiveRows,1)
  assert.equal(result.groups[0].distributionAvailability.sdRows,1)
  assert.equal(result.groups[0].distributionAvailability.sampleRows,0)
  assert.equal(result.groups[0].metrics.crps.value,null)
})

test('resampling is deterministic and samples patients, not forecast paths',() => {
  const rows = [{subjectKey:'a',point:1,actual:0},{subjectKey:'a',point:2,actual:0},{subjectKey:'b',point:3,actual:0}]
  assert.deepEqual(metricIntervals(rows,'continuous',{seed:1,bootstrap:25}),metricIntervals(rows,'continuous',{seed:1,bootstrap:25}))
  const one = metricIntervals(rows.slice(0,2),'continuous',{bootstrap:25})
  assert.equal(one.mae.lower,null)
})

test('paired scenarios require identical history and units; design SD uses both components',() => {
  const a = prediction([{subjectKey:'a',horizonDays:30,point:6,sd:1,uncertainty:'predictive'},{subjectKey:'b',horizonDays:30,point:8,sd:1,uncertainty:'predictive'}])
  const b = prediction(a.rows.map(r => ({...r,point:r.point+1})))
  assert.equal(compareForecasts(a,b).groups[0].meanDifference,-1)
  assert.equal(compareForecasts(a,{...b,historyId:'other'}).available,false)
  assert.equal(forecastDesignInputs(a)[0].outcomeVariance,3)
  assert.equal(forecastDesignInputs({...a,rows:a.rows.map(r => ({...r,uncertainty:'model'}))})[0].outcomeVariance,null)
})

test('correction chains are transitive and different unversioned source rows are not duplicates',()=>{
  const a = event('a',7,origin,{sourceEventId:'a',revision:1})
  const b = event('a',8,origin,{sourceEventId:'b',supersedes:'a',revision:2})
  const c = event('a',9,origin,{sourceEventId:'c',supersedes:'b',revision:3})
  assert.equal(replayClinicalEvents([c,a,b],origin).events[0].value,9)
  assert.equal(replayClinicalEvents([event('a',7,origin,{source:{hash:'x',row:1}}),event('a',7,origin,{source:{hash:'x',row:2}})],origin).events.length,2)
})

test('malformed rows are local issues and synthetic validation never becomes clinical validation',()=>{
  const file = {...prediction([null,{subjectKey:'a',horizonDays:30,point:7,quantiles:[null]}]),schema:1}
  assert.equal(validateForecast(file).issues.length,2)
  const result = evaluateForecast(prediction([{subjectKey:'a',point:7,horizonDays:30}]),
    {asOf:origin,dataClass:'synthetic',events:[event('a',6,origin,{valueSource:'synthetic'})]},
    {dataClass:'synthetic',events:[event('a',8,'2026-01-31T00:00:00.000Z',{valueSource:'synthetic'})]}, {bootstrap:0})
  assert.equal(result.validationClass,'engineering_synthetic')
  assert.equal(result.groups[0].metrics.mae.value,1)
  assert.equal(result.groups[0].metrics.mae.lower,null)
})

test('trial effects retain scales, family separation and an independent simple comparator',()=>{
  /** @param {string} id @param {string} split @param {number} actual @param {number} predicted @param {string} [scale] */
  const row=(id,split,actual,predicted,scale='difference')=>({trialId:id,familyId:id,endpoint:'HbA1c',unit:'%',horizonDays:30,scale,split,actual,predicted})
  const result=evaluateTrialBenchmark({comparisons:[row('cal','calibration',1,1),row('one','test',2,2.5),row('two','test',3,3.5),row('ratio','test',1,1.1,'ratio'),
    row('leak','test',3,3),row('leak','train',3,3)]},{bootstrap:30})
  assert.equal(result.groups.length,2)
  assert.equal(result.familyOverlap,true)
  assert.equal(result.groups[0].metrics.mae.value,.5)
  assert.equal(result.groups[0].baseline.value,1)
  assert.equal(result.groups[0].baseline.metrics?.mae.value,1.5)
  assert.equal(result.groups[0].metrics.mae.interval,'trial_family_percentile')
  assert.equal(result.causalEffectIdentified,false)
})

test('heldout denominators partition every requested subject and horizon including rejected and absent forecasts',()=>{
  const history={asOf:origin,dataClass:'synthetic',events:['a','b','c','d','e'].map(k=>event(k,6)),split:{assignments:{a:'test',b:'test',c:'test',d:'test',e:'train'}}}
  const raw=prediction([{subjectKey:'a',horizonDays:30,point:7},{subjectKey:'b',horizonDays:30,point:NaN},{subjectKey:'c',horizonDays:30,point:7},
    {subjectKey:'a',horizonDays:60,point:7}],{horizonsDays:[30,60]})
  const checked=validateForecast(raw)
  const result=evaluateForecast({...raw,...checked},history,{dataClass:'synthetic',events:[event('a',8,'2026-01-31T00:00:00.000Z')]},{bootstrap:0})
  assert.deepEqual(result.groups.map((/** @type {any} */ g)=>[g.requested,g.evaluated,g.missingForecasts,g.invalidForecasts,g.missingOutcomes]),[[4,1,1,1,1],[4,0,3,0,1]])
  for(const group of result.groups)assert.equal(group.requested,group.evaluated+group.missingForecasts+group.invalidForecasts+group.missingOutcomes)
  assert.equal(evaluateForecast({...raw,...checked},history,{dataClass:'patient',events:[]}).dataClass,'patient')
})

test('predictive samples supply design variance, but parameter draws and a single sample cannot',()=>{
  const pred=prediction([{subjectKey:'a',horizonDays:30,point:6,samples:[5,7],uncertainty:'predictive'},
    {subjectKey:'b',horizonDays:30,point:8,samples:[7,9],uncertainty:'predictive'}])
  const design=forecastDesignInputs(pred)[0]
  assert.equal(design.withinSubjectPredictiveVariance,2);assert.equal(design.outcomeVariance,4)
  assert.deepEqual(design.varianceSources,['predictive_samples'])
  const metric=metricIntervals([{subjectKey:'a',point:6,actual:6,samples:[5,7],uncertainty:'predictive'}],'continuous',{bootstrap:0})
  assert.equal(metric.crps.availability,'computed');assert.equal(metric.crps.value,.5);assert.equal(metric.crps.unavailableReason,null)
  assert.equal(metric.intervalCoverage.unavailableReason,'predictive_quantiles_missing')
  assert.equal(forecastDesignInputs({...pred,rows:pred.rows.map(r=>({...r,uncertainty:'parameter'}))})[0].outcomeVariance,null)
  assert.equal(forecastDesignInputs({...pred,rows:pred.rows.map(r=>({...r,samples:[r.point]}))})[0].outcomeVariance,null)
})

test('an increasing survival horizon is quarantined without discarding other subjects or consistent horizons',()=>{
  const pred=prediction([{subjectKey:'a',horizonDays:60,point:.8},{subjectKey:'a',horizonDays:30,point:.2},
    {subjectKey:'b',horizonDays:60,point:.6},{subjectKey:'b',horizonDays:30,point:.9}],{horizonsDays:[30,60],endpoint:{code:'survival',unit:'probability',type:'survival_probability'}})
  const checked=validateForecast(pred)
  assert.equal(checked.rows.length,3)
  assert.deepEqual(checked.rejected,[{subjectKey:'a',horizonDays:60,codes:['survival_probability_increases']}])
  assert.equal(checked.issues[0].codes[0],'survival_probability_increases')
})
