import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { vcrOpeningName } from '../src/vcrStore.mjs';
import { vcrStudyName } from '../src/vcrNotify.mjs';
import { resolveJobSubject, vcrConversationSubject } from '../src/vcrSubjects.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

// F1/F2 (VCR remediation 2026-11-01): the studies a conversation makes are named from its first sentence and listed on the module's home
// in a field of their own; the list every other reader shares is not widened.

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Owned local PostgreSQL is required' };
/** @type {any} */ let isolated;
/** @type {any} */ let database;
/** @type {any} */ let dir;
/** @type {any} */ let vcr;

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrchome');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-chome-'));
  vcr = composeVcr({ productDatabase: database, config: { vcrEnabled: true, vcrAudience: 'all', vcrDataPlaneDir: dir, vcrProviderAgreements: true,
    vcrProviderAgreementReference: 'Local synthetic fixture', deepseekBaseUrl: 'https://model.invalid', vcrMaxConcurrentJobs: 1 } });
  await vcr.store.ready();
});
after(async () => {
  await database?.close();
  await isolated?.drop();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

const origin = (/** @type {string} */ session, userId = 'owner') => ({ userId, projectId: 'default', rootSessionId: session, sessionId: session, runId: 'run', callId: 'call' });
const saying = (/** @type {string} */ text) => async () => text;

test('the first sentence said in a conversation is its study\'s name, cut as a name is and never reworded', () => {
  assert.equal(vcrOpeningName('用虚拟临床研究匹配患者和临床试验。资料是：62 岁男性，肺腺癌 IV 期'), '帮我匹配患者和临床试验');
  assert.equal(vcrOpeningName('  我想比较两种试验设计的把握度！先看第一种  '), '我想比较两种试验设计的把握度');
  assert.equal(vcrOpeningName('Plan a two-arm survival trial with 80% power and a hazard ratio of 0.7'), 'Plan a two-arm survival');
  assert.equal(vcrOpeningName('第一行\n第二行'), '第一行');
  assert.equal(vcrOpeningName('   '), null);
  assert.equal(vcrOpeningName(null), null);
});

test('a conversation\'s study is named by its first sentence; a second one of the same words is told apart by the day', options, async () => {
  const first = await vcr.store.taskContext(origin('named_a'), { opening: saying('用虚拟临床研究匹配患者和临床试验。资料是：略') });
  assert.equal(first.name, '帮我匹配患者和临床试验');
  assert.equal(first.nameBasis, 'opening');
  assert.equal(first.scope, 'conversation');
  const again = await vcr.store.taskContext(origin('named_a'), { opening: saying('完全不同的另一句话') });
  assert.equal(again.id, first.id);
  assert.equal(again.name, first.name, 'a study is named once; the second look finds it named and does not read the ledger');
  let read = 0;
  const same = await vcr.store.taskContext(origin('named_b'), { opening: async () => { read += 1; return '用虚拟临床研究匹配患者和临床试验。资料是：另一位'; } });
  assert.equal(read, 1);
  assert.notEqual(same.name, first.name);
  assert.match(same.name, /^帮我匹配患者和临床试验 \d+月\d+日$/);
  let none = 0;
  await vcr.store.taskContext(origin('named_b'), { opening: async () => { none += 1; return 'x'; } });
  assert.equal(none, 0, 'a named study never reads the ledger again');
});

test('with nothing said the study keeps the placeholder, and the first write that can say names it once', options, async () => {
  const bare = await vcr.store.taskContext(origin('named_none'), { opening: async () => null });
  assert.equal(bare.name, '对话研究');
  assert.equal(bare.nameBasis, null);
  const lookup = await vcr.store.taskContext(origin('named_none'), { create: false });
  assert.equal(lookup.name, '对话研究');
  const named = await vcr.store.taskContext(origin('named_none'), { opening: saying('评估一个单臂二期试验的样本量') });
  assert.equal(named.id, bare.id);
  assert.equal(named.name, '评估一个单臂二期试验的样本量');
  assert.equal(named.nameBasis, 'opening');
  const failing = await vcr.store.taskContext(origin('named_failing'), { opening: async () => { throw new Error('ledger unreadable'); } });
  assert.equal(failing.name, '对话研究', 'a ledger that cannot be read leaves the placeholder; the write goes on');
});

test('a saved definition may name a study the first sentence named; a name a person gave is not undone', options, async () => {
  const study = await vcr.store.taskContext(origin('named_def'), { opening: saying('帮我看看这个设计') });
  assert.equal(study.name, '帮我看看这个设计');
  await vcr.store.saveDefinition({ studyId: study.id, userId: 'owner', pico: { population: '成人晚期肺癌' }, title: '晚期肺癌二线两臂设计', question: '二线治疗是否延长生存' });
  const defined = await vcr.store.studyById(study.id);
  assert.equal(defined.name, '晚期肺癌二线两臂设计');
  assert.equal(defined.nameBasis, null);
  assert.equal(defined.question, '二线治疗是否延长生存');
  await vcr.store.saveDefinition({ studyId: study.id, userId: 'owner', pico: {}, title: '又一个名字' });
  assert.equal((await vcr.store.studyById(study.id)).name, '晚期肺癌二线两臂设计', 'a name a definition gave is not given again');

  const renamed = await vcr.store.taskContext(origin('named_person'), { opening: saying('第一句话') });
  await vcr.store.updateStudy(renamed.id, { name: '我自己起的名字' }, 'owner');
  await vcr.store.saveDefinition({ studyId: renamed.id, userId: 'owner', pico: { population: '成人' }, title: '定义给的名字' });
  const kept = await vcr.store.studyById(renamed.id);
  assert.equal(kept.name, '我自己起的名字');
  assert.equal(kept.nameBasis, null);

  // A definition with nothing to name it from leaves the first sentence's name where it is.
  const quiet = await vcr.store.taskContext(origin('named_quiet'), { opening: saying('只有第一句话') });
  await vcr.store.saveDefinition({ studyId: quiet.id, userId: 'owner', pico: {} });
  const left = await vcr.store.studyById(quiet.id);
  assert.equal(left.name, '只有第一句话');
  assert.equal(left.nameBasis, 'opening');
});

test('a definition never renames the person\'s own project after a conversation\'s study', options, async () => {
  const named = [];
  vcr.store.onStudyNamed = async (/** @type {any} */ event) => { named.push(event); };
  try {
    const study = await vcr.store.taskContext(origin('named_project'), { opening: saying('这段对话的第一句话') });
    await vcr.store.saveDefinition({ studyId: study.id, userId: 'owner', pico: { population: '成人' }, title: '定义的名字' });
    assert.deepEqual(named, []);
  } finally { vcr.store.onStudyNamed = null; }
});

test('notices call a study by its name, and a placeholder by its question', () => {
  assert.equal(vcrStudyName({ name: '帮我匹配患者和临床试验', question: '' }), '帮我匹配患者和临床试验');
  assert.equal(vcrStudyName({ name: '对话研究', question: '二线治疗是否延长生存' }), '二线治疗是否延长生存');
  assert.equal(vcrStudyName({ name: '对话研究', question: '' }), '虚拟临床研究');
});

test('the home lists a conversation\'s study in a field of its own, only once it holds something, and the shared list is not widened', options, async () => {
  const user = { id: 'home_owner' };
  const empty = await vcr.store.taskContext(origin('home_empty', user.id), { opening: saying('只说了一句话，什么也没保存') });
  const matched = await vcr.store.taskContext(origin('home_matching', user.id), { opening: saying('帮我给这位患者找试验') });
  await vcr.matchStore.saveProtocolVersion({ studyId: matched.id, userId: user.id, title: '方案 v1', criteria: [
    { kind: 'inclusion', criterionType: 'demographic', sourceText: '年龄 ≥ 18 岁', sourceLocator: { page: 1 }, requirement: { op: 'compare', variable: 'age', comparator: 'gte', value: 18 }, evidenceNeeded: [] },
  ] });
  const designed = await vcr.store.taskContext(origin('home_design', user.id), { opening: saying('比较两种试验设计') });
  await vcr.store.saveDefinition({ studyId: designed.id, userId: user.id, pico: { population: '成人' }, title: '' });
  const populated = await vcr.store.taskContext(origin('home_population', user.id), { opening: saying('生成一个虚拟人群') });
  await vcr.store.savePopulation({ studyId: populated.id, userId: user.id, name: '情景人群', kind: 'scenario', definition: { n: 100 }, allowedUses: ['design'] });
  const other = await vcr.store.taskContext(origin('home_other', 'someone_else'), { opening: saying('别人的对话') });
  await vcr.store.savePopulation({ studyId: other.id, userId: 'someone_else', name: '别人的人群', kind: 'scenario', definition: { n: 10 }, allowedUses: ['design'] });
  const removed = await vcr.store.taskContext(origin('home_removed', user.id), { opening: saying('随后被删除的对话') });
  await vcr.store.savePopulation({ studyId: removed.id, userId: user.id, name: '要删的人群', kind: 'scenario', definition: { n: 10 }, allowedUses: ['design'] });
  await vcr.store.softDeleteStudy(removed.id, user.id);

  const home = await vcr.service.listStudies(user);
  const listed = home.conversationStudies;
  assert.deepEqual(new Set(listed.map((/** @type {any} */ row) => row.id)), new Set([matched.id, designed.id, populated.id]));
  assert.ok(!listed.some((/** @type {any} */ row) => row.id === empty.id), 'a study that holds nothing is not a place to come back to');
  assert.ok(!listed.some((/** @type {any} */ row) => [other.id, removed.id].includes(row.id)));
  const byId = new Map(listed.map((/** @type {any} */ row) => [row.id, row]));
  assert.deepEqual(byId.get(matched.id).tabs, ['matching']);
  assert.deepEqual(byId.get(designed.id).tabs, ['data']);
  assert.deepEqual(byId.get(populated.id).tabs, ['population']);
  assert.equal(byId.get(matched.id).name, '帮我给这位患者找试验');
  assert.equal(byId.get(matched.id).originatingSessionId, 'home_matching');
  assert.equal(byId.get(matched.id).projectId, 'default');
  assert.deepEqual(Object.keys(byId.get(matched.id)).sort(), ['createdAt', 'id', 'name', 'originatingSessionId', 'projectId', 'question', 'status', 'tabs', 'updatedAt'],
    'a light summary: none of the per-study rows of the home list');

  // What the sidebar, the knowledge base and the pickers read is what it was: no conversation study, and no default project among the studies.
  assert.deepEqual(home.studies, []);
  assert.ok(!(await vcr.store.listStudies(user.id)).some((/** @type {any} */ row) => row.scope === 'conversation'));
  assert.equal(await vcr.store.studyByControlProject(user.id, 'default'), null);
  assert.deepEqual(home.draftProjectIds, []);
});

test('the home lists the newest fifty, and says when the list could not be read instead of drawing an empty one', options, async () => {
  const user = { id: 'home_many' };
  for (let n = 0; n < 53; n += 1) {
    const study = await vcr.store.taskContext(origin(`many_${n}`, user.id), { opening: saying(`第 ${n} 次对话`) });
    await vcr.store.savePopulation({ studyId: study.id, userId: user.id, name: `人群 ${n}`, kind: 'scenario', definition: { n }, allowedUses: ['design'] });
    await vcr.store.query('UPDATE evimed_vcr.studies SET updated_at = $2 WHERE id = $1', [study.id, new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString()]);
  }
  const home = await vcr.service.listStudies(user);
  assert.equal(home.conversationStudies.length, 50);
  assert.equal(home.conversationStudies[0].name, '第 52 次对话');
  assert.equal(home.conversationStudies[49].name, '第 3 次对话');

  const original = vcr.store.conversationStudies;
  vcr.store.conversationStudies = async () => { throw new Error('unreadable'); };
  try {
    const failed = await vcr.service.listStudies(user);
    assert.equal(failed.conversationStudies, undefined);
    assert.equal(failed.conversationStudiesUnreadable, true);
    assert.deepEqual(failed.studies, [], 'the rest of the home is read as it was');
  } finally { vcr.store.conversationStudies = original; }
});

test('a row made before the first sentence named studies is called by its question', options, async () => {
  const user = { id: 'home_legacy' };
  const study = await vcr.store.taskContext(origin('legacy_row', user.id));
  assert.equal(study.name, '对话研究');
  await vcr.store.savePopulation({ studyId: study.id, userId: user.id, name: '人群', kind: 'scenario', definition: { n: 10 }, allowedUses: ['design'] });
  assert.equal((await vcr.service.listStudies(user)).conversationStudies[0].name, '未命名研究');
  await vcr.store.query("UPDATE evimed_vcr.studies SET question = '二线治疗是否延长生存' WHERE id = $1", [study.id]);
  assert.equal((await vcr.service.listStudies(user)).conversationStudies[0].name, '二线治疗是否延长生存');
});

test('the study page says which tabs hold something, so a study with only matching results can open on 匹配 (F4)', options, async () => {
  const user = { id: 'held_owner' };
  const matched = await vcr.store.taskContext(origin('held_matching', user.id), { opening: saying('只做了匹配') });
  assert.deepEqual((await vcr.service.studyView(user, matched.id)).holds, [], 'a study that holds nothing says so');
  await vcr.matchStore.saveProtocolVersion({ studyId: matched.id, userId: user.id, title: '方案 v1', criteria: [
    { kind: 'inclusion', criterionType: 'demographic', sourceText: '年龄 ≥ 18 岁', sourceLocator: { page: 1 }, requirement: { op: 'compare', variable: 'age', comparator: 'gte', value: 18 }, evidenceNeeded: [] },
  ] });
  const view = await vcr.service.studyView(user, matched.id);
  assert.deepEqual(view.holds, ['matching']);
  assert.equal(view.question, null, 'nothing was asked of the study: it still holds its results');
  assert.deepEqual(await vcr.store.heldTabs(matched.id), ['matching']);
  await vcr.store.savePopulation({ studyId: matched.id, userId: user.id, name: '情景人群', kind: 'scenario', definition: { n: 100 }, allowedUses: ['design'] });
  assert.deepEqual((await vcr.service.studyView(user, matched.id)).holds, ['population', 'matching'], 'in the tabs\' order, not in the order they were made');
});

test('the way back from a conversation study\'s page is the conversation it was made in, whatever a resolver would name for the project (F6)', options, async () => {
  const user = { id: 'back_owner' };
  const study = await vcr.store.taskContext(origin('orig_conv', user.id), { opening: saying('调整一个设计') });
  await vcr.store.savePopulation({ studyId: study.id, userId: user.id, name: '情景人群', kind: 'scenario', definition: { n: 100 }, allowedUses: ['design'] });
  const packages = vcr.service.packages;
  const original = packages.conversations;
  /** @type {any[]} */ const asked = [];
  try {
    // The resolver a project study falls back to names the oldest conversation of the project: someone else's work, for a study that sits in the person's own project.
    packages.conversations = { resolve: async (/** @type {any} */ target, /** @type {any} */ options) => { asked.push([target.id, options]); return { sessionId: 'oldest_of_project', exists: true }; } };
    let view = await vcr.service.studyView(user, study.id);
    assert.equal(view.conversation.sessionId, 'orig_conv');
    assert.equal(view.sessionId, 'orig_conv', 'the readers that predate `conversation` read the same one');
    assert.equal(view.conversation.exists, false, 'the kernel was not shown to have this one');
    assert.deepEqual(asked, [[study.id, { create: false }]], 'looking at a study never makes a conversation');

    // The resolver confirms it, or says the kernel no longer has it.
    packages.conversations = { resolve: async (/** @type {any} */ target) => ({ sessionId: target.conversationSessionId, exists: true }) };
    view = await vcr.service.studyView(user, study.id);
    assert.deepEqual([view.conversation.sessionId, view.conversation.exists], ['orig_conv', true]);
    packages.conversations = { resolve: async (/** @type {any} */ target) => ({ sessionId: target.conversationSessionId, exists: false }) };
    view = await vcr.service.studyView(user, study.id);
    assert.deepEqual([view.conversation.sessionId, view.conversation.exists], ['orig_conv', false]);

    // A resolver that fails, or none at all: the conversation the study was made in is still the answer.
    packages.conversations = { resolve: async () => { throw new Error('kernel unreachable'); } };
    assert.equal((await vcr.service.studyView(user, study.id)).conversation.sessionId, 'orig_conv');
    packages.conversations = null;
    assert.equal((await vcr.service.studyView(user, study.id)).conversation.sessionId, 'orig_conv');

    // A study of the module's own keeps its resolver: it is the project's conversation the resolver finds.
    const own = await vcr.store.createStudy({ userId: user.id, projectId: 'own_project', name: '模块自己的研究', question: 'q' });
    packages.conversations = { resolve: async () => ({ sessionId: 'found_for_project', exists: true }) };
    assert.equal((await vcr.service.studyView(user, own.id)).conversation.sessionId, 'found_for_project');
  } finally { packages.conversations = original; }
});

test('a conversation computes a design or a population with nothing written first; a study with its own page does not', options, async () => {
  const study = await vcr.store.taskContext({ userId: 'selffiled', projectId: 'default', rootSessionId: 'selffiled_root', runId: 'r', callId: 'c', dispatchId: null, routeReason: null, programme: false }, { create: true });
  assert.equal(study.scope, 'conversation');
  const design = { design: { kind: 'two_arm_fixed' }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.75, controlMedian: 12 } };
  const made = await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'design_analytic', scenario: design });
  assert.ok(made, 'the scenario is the object');
  assert.equal((await resolveJobSubject({ store: vcr.store, study, kind: 'design_analytic', subjectId: made, scenario: design })).row.id, made);
  // The same design again is the one the study holds: not a second object.
  assert.equal(await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'design_analytic', scenario: design }), null);
  assert.equal((await resolveJobSubject({ store: vcr.store, study, kind: 'design_analytic', scenario: design })).row.id, made);
  const people = { n: 100, population: { variables: [{ name: 'age', family: 'normal', mean: 60, sd: 10 }] } };
  const population = await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'generate_population', scenario: people });
  assert.ok(population);
  // A kind whose input is another object still asks for it, and a named id is left alone.
  assert.equal(await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'generate_patients', scenario: {} }), null);
  assert.equal(await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'design_analytic', subjectId: made, scenario: design }), null);
  // A scenario the engine would refuse is refused here, by what is wrong with it.
  await assert.rejects(vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'design_grid', scenario: {} }), { code: 'vcr_job_scenario_invalid' });
  assert.equal(await vcrConversationSubject({ store: vcr.store, study: { ...study, scope: 'study' }, userId: study.userId, kind: 'design_simulation', scenario: design }), null);
});
