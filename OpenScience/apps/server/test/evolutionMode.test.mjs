// OPEN_SCIENCE_EVOLUTION_SERVING_ONLY: the serving cutover is one switch, off by default. Off, the control plane composes evolution as it did
// before the offline lab (the full composition, the search pause its own lever); on, it composes serving. The cutover's side effects
// (quarantining queued experimental jobs, closing queued events and pending cards, the harm-review default, the 409s) belong to serving alone.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { Readable } from 'node:stream';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { EVOLUTION_CONFIG_SCHEMA, validateEvolutionConfiguration } from '../src/evolutionConfiguration.mjs';
import { EvolutionDecisions } from '../src/evolutionDecisions.mjs';
import { createEvolution } from '../src/evolutionComposition.mjs';
import { composeEvolution } from '../src/evolutionMode.mjs';
import { evolutionServiceFixture } from './helpers/evolutionServiceFixture.mjs';

const user = { id: 'operator' };
/** The union of what either composition takes, with the doubles the existing composition tests use. @param {Record<string, any>} configOverrides */
function dependencies(configOverrides = {}) {
  const f = evolutionServiceFixture();
  const config = { ...Object.fromEntries(Object.entries(EVOLUTION_CONFIG_SCHEMA).map(([key, field]) => [key, field.default])),
    evolutionEnabled: true, dataDir: os.tmpdir(), operatorUsers: ['operator'], frontierEnabled: false, evolutionDependencyAllowlist: [], ...configOverrides };
  return { f, deps: { config, documents: f.documents, jobs: f.service.jobs, usageLedger: {}, judgeService: null, notifications: f.service.notifications,
    database: { query: async () => ({ rows: [] }), transaction: async fn => fn({ query: async () => ({ rows: [] }) }) },
    store: { userById: async () => user, projectFor: async () => ({ id: 'evolution' }), ensureSessionUser: async () => ({ user }), assertCsrf: async () => {}, requireProject: async () => ({ id: 'p', userId: user.id }) },
    registry: Promise.resolve({ list: () => [] }), runtimeManager: {}, researchSessions: {}, controller: {}, agentRuns: { list: async () => [] }, evaluationIsolation: {},
    sourceService: {}, autopilot: { wakeForEvolution: async () => ({ woken: true }) }, dataSemantics: null, sourceChanges: null, canRun: async () => true, webReader: null } };
}

test('the switch is a boolean config key, off by default, read from OPEN_SCIENCE_EVOLUTION_SERVING_ONLY', () => {
  const name = 'OPEN_SCIENCE_EVOLUTION_SERVING_ONLY', prior = process.env[name];
  try {
    delete process.env[name];
    assert.equal(loadConfig().evolutionServingOnly, false);
    process.env[name] = 'true';
    assert.equal(loadConfig().evolutionServingOnly, true);
    assert.equal(loadConfig({ evolutionServingOnly: false }).evolutionServingOnly, false, 'an override wins');
  } finally { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; }
  assert.deepEqual(validateEvolutionConfiguration({ evolutionServingOnly: true }), []);
  assert.ok(validateEvolutionConfiguration({ evolutionServingOnly: 'yes' }).some(issue => issue.key === 'evolutionServingOnly'));
});

test('off composes the full evolution with the config as given, so the search pause is honoured, and no serving composition is built', () => {
  for (const paused of [false, true]) {
    const { deps } = dependencies({ evolutionSearchPaused: paused });
    let seen = null;
    const evolution = composeEvolution(deps, {
      createFull: input => { seen = input; return createEvolution(input); },
      createServing: () => { throw new Error('the serving composition must not be built'); } });
    assert.ok(evolution);
    assert.equal(seen.config, deps.config, 'the full composition is given the deployment config untouched');
    assert.equal(evolution.worker.status().searchPaused, paused, 'OPEN_SCIENCE_EVOLUTION_SEARCH_PAUSED stays a lever of its own');
    assert.equal(evolution.worker.status().serving, undefined);
    // The full composition keeps its loops, and the names the control plane reads are the same objects, flat.
    assert.ok(evolution.loops && evolution.model && evolution.runs);
    assert.equal(evolution.signals, evolution.loops.signals);
    assert.equal(evolution.policyBasis, evolution.loops.policyBasis);
    assert.equal(evolution.observe, evolution.loops.observe);
    assert.equal(evolution.recordResumedResearchCompleted, evolution.loops.recordResumedResearchCompleted);
    assert.equal(typeof evolution.worker.interrupt, 'function');
  }
});

test('off with evolution unavailable composes nothing; on composes serving even when the pause lever is off', () => {
  assert.equal(composeEvolution(dependencies({ evolutionEnabled: false }).deps), null);
  const { deps } = dependencies({ evolutionServingOnly: true, evolutionSearchPaused: false });
  const evolution = composeEvolution(deps, { createFull: () => { throw new Error('the full composition must not be built'); } });
  assert.ok(evolution);
  assert.equal(evolution.loops, undefined);
  assert.equal(evolution.model, undefined);
  assert.equal(evolution.worker.status().serving, true);
  assert.equal(evolution.worker.status().experimentScheduling, false);
});

test('the cutover machinery is unreachable from the full composition: nothing in its imports quarantines a job or closes a card to the lab', async () => {
  const visited = new Set(), reached = [];
  async function visit(url) {
    if (visited.has(url.href)) return;
    visited.add(url.href); reached.push(url.pathname.split('/').pop());
    const text = await readFile(url, 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.\.?\/[^'"]+\.mjs)['"]/g)) await visit(new URL(match[1], url));
  }
  await visit(new URL('../src/evolutionComposition.mjs', import.meta.url));
  for (const forbidden of ['evolutionRetiredJobs.mjs', 'evolutionServingWorker.mjs', 'evolutionServing.mjs']) assert.ok(!reached.includes(forbidden), forbidden);
});

test('the 409s of serving are serving-only: off, an experimental route is not refused for being offline-only', async () => {
  const invoke = async (evolution, method, url) => {
    const req = Object.assign(Readable.from([]), { method, url, headers: {} });
    let status = 200;
    const res = { setHeader() {}, writeHead(code) { status = code; }, end() {} };
    try { await evolution.routes(req, res); } catch (error) { return error; }
    return { status };
  };
  const serving = composeEvolution(dependencies({ evolutionServingOnly: true }).deps);
  const refused = await invoke(serving, 'POST', '/api/evolution/prospective/register');
  assert.equal(refused.code, 'evolution_offline_only');
  const full = composeEvolution(dependencies().deps);
  const open = await invoke(full, 'POST', '/api/evolution/prospective/register');
  assert.equal(open.status, 400, 'it reaches the route\'s own validation instead');
  assert.notEqual(open.code, 'evolution_offline_only');
});

test('an unanswered harm review takes the protective retirement only under the cutover', async () => {
  const unanswered = async (serving, stored) => {
    const f = evolutionServiceFixture();
    f.service.config = { ...f.service.config, evolutionServingOnly: serving };
    const decisions = new EvolutionDecisions({ service: f.service });
    const review = await f.service.save('maintenance-review', 'review', { kind: 'sequential-harm', parentToolIds: ['tool'], status: 'pending' });
    const card = await f.service.save('decision', 'card', { category: 'tool-retire', subjectId: review.id, decisionClass: 'C', status: 'pending', history: [],
      options: [{ id: 'retire', operation: 'maintenance-retire' }, { id: 'keep', operation: 'keep' }], recommended: 'retire', conservative: stored });
    return decisions.unansweredOption(card);
  };
  assert.equal(await unanswered(true, 'keep'), 'retire', 'a card stored before the cutover as keep takes the protective option');
  assert.equal(await unanswered(false, 'keep'), 'keep', 'off, the card keeps what it stored');
  assert.equal(await unanswered(false, 'retire'), 'retire');
});
