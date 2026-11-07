import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersionsToObserved } from '../index.mjs';

const endpoint = {code:'HbA1c',type:'continuous',unit:'%'};
const prediction = (origin,horizonsDays,points) => ({origin,endpoint,horizonsDays,historyId:'h',model:{name:'m',version:'1'},dataClass:'synthetic',
  rows:Object.entries(points).flatMap(([subjectKey,point]) => horizonsDays.map(horizonDays => ({subjectKey,horizonDays,point})))});
const observation = (subjectKey,value,occurredAt) => ({subjectKey,code:'HbA1c',unit:'%',value,occurredAt,availableAt:occurredAt,valueSource:'observed'});

test('older, newer and observed are compared on the people and the target date they share',() => {
  // the older forecast is made on Jan 1 for Jan 31 (30 days); the newer on Jan 11 for the same date (20 days)
  const older = prediction('2026-01-01T00:00:00.000Z',[30],{a:7,b:8});
  const newer = prediction('2026-01-11T00:00:00.000Z',[20],{a:6.2,b:8.5});
  const outcomes = {events:[observation('a',6,'2026-01-31T00:00:00.000Z'),observation('b',8.4,'2026-01-31T00:00:00.000Z')]};
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
  const outcomes = {events:[observation('a',6,'2026-01-31T00:00:00.000Z'),observation('a',9,'2026-01-05T00:00:00.000Z')]};
  assert.equal(compareVersionsToObserved(older,newer,outcomes,{}).groups[0].observed,1);
  assert.equal(compareVersionsToObserved(older,newer,{events:[observation('a',9,'2026-01-05T00:00:00.000Z')]},{}).available,false);
  assert.equal(compareVersionsToObserved(newer,older,outcomes,{}).available,false,'the newer must have the later origin');
});
