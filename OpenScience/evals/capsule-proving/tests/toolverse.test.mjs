import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGraph, edgeRule, loadGraphs, unlockDepths } from '../synthetic/toolverse/graph.mjs';
import { tool } from '../synthetic/toolverse/toolSpec.mjs';
import { EVIMED_TOOLS } from '../synthetic/toolverse/evimedTools.mjs';
import { canon, intermediateValues, materialize, sameArgs, simulate, userValues } from '../synthetic/toolverse/env.mjs';
import { allChains, dynamicUnlock, feedersFrom, randomWalk } from '../synthetic/toolverse/samplers.mjs';
import { makeRng } from '../synthetic/toolverse/rng.mjs';
import { scoreTrajectory } from '../synthetic/toolverse/score.mjs';
import { cardProblems, mentions, requestProblems, sessionsProblems } from '../synthetic/toolverse/checks.mjs';
import { buildC3Chains, buildL8Chains, c3Stats } from '../synthetic/toolverse/build.mjs';

const fixture = () => buildGraph({
  name: 'fx',
  tools: [
    tool('find_city', 's', 'Find a city.', ['query:searchQuery'], ['city:city']),
    tool('city_weather', 's', 'Weather of a city.', ['city:city'], ['temperature:temperature']),
    tool('make_event', 's', 'Create an event.', ['title:eventTitle', 'date:date'], ['eventId:eventId']),
    tool('read_event', 's', 'Read an event.', ['eventId:eventId'], ['title:eventTitle']),
  ],
  overrides: { remove: [], add: ['city_weather.temperature->make_event.title'] },
});
const G = loadGraphs();

test('graph edges from a fixture schema set', () => {
  const g = fixture();
  const ids = g.edges.map((e) => e.id).sort();
  assert.ok(ids.includes('find_city.city->city_weather.city'));
  assert.ok(ids.includes('make_event.eventId->read_event.eventId'));
  assert.ok(!ids.includes('find_city.city->make_event.title'));
  const ov = g.edges.find((e) => e.rule === 'override');
  assert.equal(ov.id, 'city_weather.temperature->make_event.title');
  assert.throws(() => buildGraph({ name: 'x', tools: fixture().tools, overrides: { remove: ['a.b->c.d'] } }), /not there/);
});

test('edge rule: kind, name and description fallbacks', () => {
  const o = { name: 'userId', type: 'string', desc: 'the account holder identifier number' };
  assert.equal(edgeRule(o, { name: 'user_id', type: 'string', accepts: undefined }), 'name');
  assert.equal(edgeRule(o, { name: 'who', type: 'string', desc: 'account holder identifier number given' }), 'description');
  assert.equal(edgeRule(o, { name: 'who', type: 'integer', desc: 'account holder identifier number' }), null);
  assert.equal(edgeRule({ name: 'a', type: 'string', kind: 'pmid' }, { name: 'a', type: 'string', kind: 'doi', accepts: ['doi'] }), null);
});

test('evimed tools use real input names from the server schema snapshot', () => {
  const snap = JSON.parse(readFileSync(new URL('../synthetic/toolverse/evimedSchema.json', import.meta.url), 'utf8')).tools;
  for (const t of EVIMED_TOOLS) {
    assert.ok(snap[t.name], `${t.name} is not an evimed-research tool`);
    for (const i of t.inputs) assert.ok(i.name in snap[t.name].inputs, `${t.name}.${i.name} is not in the schema`);
  }
  assert.ok(G.evimed.edges.length > 20 && G.general.edges.length > 40);
});

test('simulated environment: a consumed value equals the produced value, and mismatches error', () => {
  for (const [name, g] of Object.entries(G)) {
    for (let s = 0; s < 40; s++) {
      const names = dynamicUnlock(g, makeRng(`env${s}`), 1 + (s % 4));
      const m = materialize(g, names, makeRng(`m${s}`));
      if (!m) continue;
      for (const [j, st] of m.steps.entries()) for (const [p, b] of Object.entries(st.bind)) assert.deepEqual(st.args[p], m.steps[b.step].output[b.field], `${name} step ${j} ${p}`);
    }
  }
  const g = G.general;
  let task;
  for (let s = 0; !task; s++) task = materialize(g, dynamicUnlock(g, makeRng(`t${s}`), 2), makeRng(`tv${s}`));
  const first = task.steps[0];
  const reordered = Object.fromEntries(Object.entries(first.args).reverse().map(([k, v]) => [k, typeof v === 'string' ? `  ${v} ` : v]));
  assert.equal(simulate(task, { tool: first.tool, args: reordered }).ok, true);
  assert.deepEqual(simulate(task, { tool: first.tool, args: reordered }).output, first.output);
  const wrongKey = Object.keys(first.args)[0];
  const err = simulate(task, { tool: first.tool, args: { ...first.args, [wrongKey]: 'zzz-not-it' } });
  assert.equal(err.ok, false); assert.equal(err.error.code, 'not_found');
  assert.equal(simulate(task, { tool: 'nope', args: {} }).error.code, 'unknown_tool');
  assert.equal(simulate(task, { tool: first.tool, args: {} }).error.code, 'invalid_arguments');
  assert.equal(JSON.stringify(err).includes(String(first.args[wrongKey])), false, 'the error must not leak the expected value');
});

test('canonicalising dict match', () => {
  assert.ok(sameArgs({ a: 1, b: ' x ' }, { b: 'x', a: '1.0' }) === true || sameArgs({ a: 1 }, { a: '1' }));
  assert.ok(sameArgs({ a: 5 }, { a: '5.0' }));
  assert.ok(!sameArgs({ a: 5 }, { a: 6 }));
  assert.deepEqual(canon({ b: null, a: [' 2 '] }), { a: [2] });
});

test('sampler properties: dynamic length grows with level; random matches lengths; chains are valid', () => {
  for (const g of Object.values(G)) {
    const mean = (l) => { const xs = Array.from({ length: 30 }, (_, i) => dynamicUnlock(g, makeRng(`d${l}-${i}`), l)).filter(Boolean); assert.ok(xs.length); return xs.reduce((a, c) => a + c.length, 0) / xs.length; };
    assert.deepEqual([1, 2, 3, 4].map((l) => Math.round(mean(l))), [2, 3, 4, 5]);
    for (let l = 1; l <= 4; l++) {
      const c = dynamicUnlock(g, makeRng(`v${l}`), l);
      c.slice(1).forEach((t, i) => assert.ok(feedersFrom(g, c.slice(0, i + 1), t).length > 0));
      assert.equal(randomWalk(g, makeRng(`r${l}`), l + 1).length, l + 1);
    }
    assert.ok(allChains(g, 3).length > allChains(g, 2).length);
  }
  const items = buildC3Chains(G);
  assert.equal(items.length, 100);
  const st = c3Stats(G, items);
  for (const gn of ['evimed', 'general']) assert.deepEqual(st[`${gn}/dynamicUnlock`].lengthHistogram, st[`${gn}/randomWalk`].lengthHistogram);
  assert.equal(items.filter((t) => t.sampler === 'dynamicUnlock').length, 50);
});

test('L8 chains: balanced, withheld values only of gap kinds, gold per arm', () => {
  const l = buildL8Chains(G, { split: 'dev', count: 20 });
  assert.equal(l.filter((x) => x.source === 'card').length, 10);
  assert.equal(l.filter((x) => x.graph === 'general').length, 10);
  for (const t of l) {
    assert.ok(t.removed.length >= 1 && t.removed.length <= 2);
    assert.ok(t.arms['no-memory'].gold.steps.some((s) => s.ask));
    assert.ok(t.arms['memory+method'].gold.steps.every((s) => !s.ask));
    assert.equal(t.arms.memory.expect, t.source === 'sessions' ? 'direct' : 'ask');
  }
  const again = buildL8Chains(G, { split: 'dev', count: 20 });
  assert.deepEqual(again.map((x) => x.key), l.map((x) => x.key), 'seeded');
  const sealed = buildL8Chains(G, { split: 'sealed', count: 20, exclude: new Set(l.map((x) => x.key)) });
  assert.equal(sealed.filter((x) => l.some((d) => d.key === x.key)).length, 0);
});

const sampleTask = () => {
  const l = buildL8Chains(G, { split: 'dev', count: 6 });
  return l.find((t) => t.removed.length === 1 && t.source === 'sessions') || l[0];
};
test('validators: request, sessions, card', () => {
  const t = sampleTask();
  const known = userValues(t).filter((u) => !t.removed.some((r) => r.step === u.step && r.param === u.param));
  const good = `请帮我处理一下：${known.map((u) => [].concat(u.value).join(' ')).join('，')}。`;
  assert.deepEqual(requestProblems(t, good, { removed: t.removed }), []);
  assert.ok(requestProblems(t, good + t.removed[0].value, { removed: t.removed }).some((p) => /withheld/.test(p)));
  assert.ok(requestProblems(t, '请帮我处理一下这件事情吧，谢谢你', { removed: t.removed }).some((p) => /lacks/.test(p)));
  const inter = intermediateValues(t)[0];
  if (inter) assert.ok(requestProblems(t, `${good} ${[].concat(inter.value).join(' ')}`, { removed: t.removed }).some((p) => /tool-produced/.test(p)));
  assert.ok(requestProblems(t, `${good} 用${t.steps[0].tool}`, { removed: t.removed }).some((p) => /names a tool/.test(p)));
  const sess = (txt) => [{ messages: [{ role: 'user', content: `顺便说一下，${txt}` }, { role: 'assistant', content: '好的，记下了。' }] }];
  assert.deepEqual(sessionsProblems(t, sess(`我常用的是 ${t.removed[0].value}`), t.removed), []);
  assert.ok(sessionsProblems(t, sess('没什么特别的事情要说明'), t.removed).length > 0);
  assert.ok(sessionsProblems(t, [], t.removed).length > 0);
  assert.deepEqual(cardProblems(t, { title: '习惯', body: `我们组一律按 ${t.removed[0].value} 处理` }, t.removed), []);
  assert.ok(cardProblems(t, { title: '习惯', body: '我们组一律按惯例处理一下就可以了' }, t.removed).length > 0);
  assert.ok(mentions('use US dollars', 'US') && !mentions('USB cable', 'US'));
});

test('scoreTrajectory: exact, reordered keys, wrong arg, missing step, asks', () => {
  const gold = { steps: [{ tool: 'a', args: { x: 1, y: 'p' } }, { tool: 'b', args: { z: 'q' } }], askedAboutKnown: [] };
  const exact = scoreTrajectory(gold, [{ tool: 'a', args: { x: 1, y: 'p' } }, { tool: 'b', args: { z: 'q' } }]);
  assert.deepEqual([exact.pass, exact.firstFail, exact.perStep], [true, null, [true, true]]);
  assert.equal(scoreTrajectory(gold, [{ tool: 'a', args: { y: ' p', x: '1' } }, { tool: 'b', args: { z: 'q' } }]).pass, true);
  const wrong = scoreTrajectory(gold, [{ tool: 'a', args: { x: 1, y: 'p' } }, { tool: 'b', args: { z: 'WRONG' } }]);
  assert.deepEqual([wrong.pass, wrong.firstFail, wrong.perStep], [false, 1, [true, false]]);
  const missing = scoreTrajectory(gold, [{ tool: 'a', args: { x: 1, y: 'p' } }]);
  assert.deepEqual([missing.pass, missing.firstFail], [false, 1]);
  assert.equal(scoreTrajectory(gold, [{ tool: 'a', args: { x: 1, y: 'p' } }, { tool: 'b', args: { z: 'q' } }, { tool: 'c', args: {} }]).extraCalls, 1);
  // clarifying question expected at the gap
  const ask = { steps: [{ ask: { params: ['cur'] } }, { tool: 'a', args: { cur: 'USD' } }], askedAboutKnown: [] };
  assert.equal(scoreTrajectory(ask, [{ ask: { params: ['cur'] } }, { tool: 'a', args: { cur: 'USD' } }]).pass, true);
  const guessed = scoreTrajectory(ask, [{ tool: 'a', args: { cur: 'CNY' } }]);
  assert.deepEqual([guessed.pass, guessed.firstFail], [false, 0]);
  // memory arm: asking for a known value is a TellOnce failure even when the calls then match
  const direct = { steps: [{ tool: 'a', args: { cur: 'USD' } }], askedAboutKnown: ['cur'] };
  const told = scoreTrajectory(direct, [{ ask: { params: ['cur'] } }, { tool: 'a', args: { cur: 'USD' } }]);
  assert.deepEqual([told.tellOnceFailure, told.pass, told.perStep], [true, false, [true]]);
  assert.equal(scoreTrajectory(direct, [{ tool: 'a', args: { cur: 'USD' } }]).pass, true);
});
