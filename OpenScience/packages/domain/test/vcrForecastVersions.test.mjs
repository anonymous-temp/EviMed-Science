import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersionsToObserved } from '../index.mjs';

const endpoint = {code:'HbA1c',type:'continuous',unit:'%'};
/** @param {string} origin @param {number[]} horizonsDays @param {Record<string, number>} points @returns {any} */
const prediction = (origin,horizonsDays,points) => ({origin,endpoint,horizonsDays,historyId:'h',model:{name:'m',version:'1'},dataClass:'synthetic',
  rows:Object.entries(points).flatMap(([subjectKey,point]) => horizonsDays.map((/** @type {number} */ horizonDays) => ({subjectKey,horizonDays,point})))});
/** @param {string} subjectKey @param {number} value @param {string} occurredAt */
const observation = (subjectKey,value,occurredAt) => ({subjectKey,code:'HbA1c',unit:'%',value,occurredAt,availableAt:occurredAt,valueSource:'observed'});

test('older, newer and observed are compared on the people and the target date they share',() => {
  // the older forecast is made on Jan 1 for Jan 31 (30 days); the newer on Jan 11 for the same date (20 days)
  const older = prediction('2026-01-01T00:00:00.000Z',[30],{a:7,b:8});
  const newer = prediction('2026-01-11T00:00:00.000Z',[20],{a:6.2,b:8.5});
  const outcomes = {dataClass:'synthetic',events:[observation('a',6,'2026-01-31T00:00:00.000Z'),observation('b',8.4,'2026-01-31T00:00:00.000Z')]};
  const result = compareVersionsToObserved(older,newer,outcomes,{});
  assert.equal(result.available,true);
  const group = result.groups[0];
  assert.equal(group.observed,2);
  assert.ok(Math.abs(group.olderError-(1+.4)/2)<1e-12);
  assert.ok(Math.abs(group.newerError-(.2+.1)/2)<1e-12);
  assert.equal(group.newerCloser,2);
  assert.equal(result.causalEffectIdentified,false);
});

test('an observation the newer version could already see is not a test of it',() => {
  const older = prediction('2026-01-01T00:00:00.000Z',[30],{a:7});
  const newer = prediction('2026-01-11T00:00:00.000Z',[20],{a:6.2});
  // the value on Jan 5 is before the newer origin; only the Jan 31 value counts
  const outcomes = {dataClass:'synthetic',events:[observation('a',6,'2026-01-31T00:00:00.000Z'),observation('a',9,'2026-01-05T00:00:00.000Z')]};
  assert.equal(compareVersionsToObserved(older,newer,outcomes,{}).groups[0].observed,1);
  assert.equal(compareVersionsToObserved(older,newer,{dataClass:'synthetic',events:[observation('a',9,'2026-01-05T00:00:00.000Z')]},{}).available,false);
  assert.equal(compareVersionsToObserved(newer,older,outcomes,{}).available,false,'the newer must have the later origin');
});

test('real people under the small-cell floor: a date keeps its identity and loses its means and counts (review eng P0-3)',() => {
  const real = (/** @type {any} */ p) => ({...p,dataClass:'patient'});
  const older = real(prediction('2026-01-01T00:00:00.000Z',[30],{a:7,b:8}));
  const newer = real(prediction('2026-01-11T00:00:00.000Z',[20],{a:6.2,b:8.5}));
  const outcomes = {events:[observation('a',6,'2026-01-31T00:00:00.000Z'),observation('b',8.4,'2026-01-31T00:00:00.000Z')]};
  const result = compareVersionsToObserved(older,newer,outcomes,{});
  assert.equal(result.available,true,'two observed people are still an observed comparison');
  const group = result.groups[0];
  assert.equal(group.targetAt,'2026-01-31T00:00:00.000Z');
  for (const key of ['observed','observedMean','olderMean','newerMean','olderError','newerError','newerCloser','olderCloser','pairedPredictions']) assert.equal(group[key],null,key);
  assert.ok(group.suppressed.includes('observedMean'));
  // enough people: the means stand, but a split with a handful on one side is withheld
  const keys = Array.from({length:12},(_,i) => `p${i}`);
  const many = (/** @type {string} */ origin,/** @type {number} */ h,/** @type {(i:number)=>number} */ f) => real(prediction(origin,[h],Object.fromEntries(keys.map((k,i) => [k,f(i)]))));
  const o2 = many('2026-01-01T00:00:00.000Z',30,() => 7), n2 = many('2026-01-11T00:00:00.000Z',20,(i) => i < 2 ? 6.9 : 7.5);
  const big = compareVersionsToObserved(o2,n2,{events:keys.map(k => observation(k,6.8,'2026-01-31T00:00:00.000Z'))},{}).groups[0];
  assert.equal(big.observed,12);
  assert.ok(Number.isFinite(big.observedMean));
  assert.deepEqual([big.newerCloser,big.olderCloser],[null,null],'two people whose older forecast was closer are two people');
});

test('two forecasts made on different action schedules name the schedule as what changed (review stats P2-14)',async () => {
  const { compareForecasts } = await import('../index.mjs');
  const a = {...prediction('2026-01-01T00:00:00.000Z',[30],{a:7,b:8}),actionSchedule:[{code:'Metformin',atDay:7}]};
  const b = {...prediction('2026-01-01T00:00:00.000Z',[30],{a:6.5,b:7.5}),actionSchedule:[{code:'Metformin',atDay:28}]};
  const compared = compareForecasts(a,b,{mode:'scenario',bootstrap:0});
  assert.deepEqual(compared.changedFactors,['actions']);
  assert.deepEqual(compareForecasts(prediction('2026-01-01T00:00:00.000Z',[30],{a:7}),{...prediction('2026-01-01T00:00:00.000Z',[30],{a:7}),actionSchedule:[]},{bootstrap:0}).changedFactors,[],
    'a record that kept no schedule had none');
});

test('a real outcome history is never exempted by synthetic forecasts: the class is the strictest of all three (review F01)',() => {
  const older = prediction('2026-01-01T00:00:00.000Z',[30],{a:7}), newer = prediction('2026-01-11T00:00:00.000Z',[20],{a:6.2});
  assert.equal(older.dataClass,'synthetic');
  const real = {dataClass:'patient',events:[observation('a',9.12345,'2026-01-31T00:00:00.000Z')]};
  const result = compareVersionsToObserved(older,newer,real,{minCell:5,dataClass:'synthetic'});
  assert.equal(result.dataClass,'patient','the outer class follows the real outcome');
  const group = result.groups[0];
  for (const key of ['observed','observedMean','olderMean','newerMean','olderError','newerError','newerCloser','olderCloser']) assert.equal(group[key],null,key);
  assert.ok(!JSON.stringify(result).includes('9.12345'));
  // an outcome history that declares nothing is not synthetic either
  assert.equal(compareVersionsToObserved(older,newer,{events:real.events},{minCell:5}).groups[0].observed,null);
  // all three synthetic: shown whole, class synthetic
  const whole = compareVersionsToObserved(older,newer,{...real,dataClass:'synthetic'},{minCell:5});
  assert.equal(whole.dataClass,'synthetic');
  assert.equal(whole.groups[0].observed,1);
});

test('the paired comparison and the strictest class agree (review F01)',async () => {
  const { compareForecasts, strictestDataClass } = await import('../index.mjs');
  const a = prediction('2026-01-01T00:00:00.000Z',[30],{a:7}), b = {...a,dataClass:'patient'};
  assert.equal(compareForecasts(a,a,{mode:'update'}).dataClass,'synthetic');
  assert.equal(compareForecasts(a,b,{mode:'update'}).dataClass,'patient');
  assert.equal(strictestDataClass(),'patient');
  assert.equal(strictestDataClass({dataClass:'synthetic'},{}),'patient');
});
