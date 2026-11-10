import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { VcrStore, vcrMonthDay, vcrNeutralStudyName, vcrTitleName } from '../src/vcrStore.mjs';
import { vcrStudyName } from '../src/vcrNotify.mjs';
import { resolveJobSubject, vcrConversationSubject } from '../src/vcrSubjects.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

// F1/F2 (VCR remediation 2026-11-01, review P1-4): the studies a conversation makes are named by the model's title for the research
// question, or for the kind of work they hold and the day, and never from a sentence anyone said; they are listed on the module's home
// in a field of their own, and the list every other reader shares is not widened.

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
const today = () => vcrMonthDay(new Date());

test('a title is a name with the identifiers of closed formats taken out, cut as a name is; nothing said is ever one', () => {
  assert.equal(vcrTitleName('晚期肺癌二线两臂设计'), '晚期肺癌二线两臂设计');
  assert.equal(vcrTitleName('  住院号 20260123 患者的方案匹配  '), '住院号 患者的方案匹配', 'the record number goes, its label is only a label');
  assert.equal(vcrTitleName('手机 13812345678 随访  试验'), '手机 随访 试验');
  assert.equal(vcrTitleName('身份证 11010519491231002X'), '身份证');
  assert.equal(vcrTitleName('2026年11月2日'), null, 'a title that was only an identifier names nothing');
  assert.equal(vcrTitleName('一个很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的名字').length, 40);
  assert.equal(vcrTitleName('   '), null);
  assert.equal(vcrTitleName(null), null);
  assert.equal(vcrTitleName({ title: 'x' }), null);
});

test('an untitled study is called for the kind of work it holds and the day, from the tabs in their order', () => {
  const day = new Date('2026-11-02T08:00:00Z');
  assert.equal(vcrNeutralStudyName(['matching'], day), '患者匹配 · 11月2日');
  assert.equal(vcrNeutralStudyName(['population', 'matching'], day), '虚拟人群 · 11月2日');
  assert.equal(vcrNeutralStudyName(['trial'], day), '试验设计 · 11月2日');
  assert.equal(vcrNeutralStudyName(['data'], day), '研究资料 · 11月2日');
  assert.equal(vcrNeutralStudyName([], day), null, 'a study that holds nothing has no kind of work to name');
  assert.equal(vcrNeutralStudyName(['elsewhere'], day), null);
});

test('a conversation\'s study is made with the placeholder and is not named from anything said', options, async () => {
  const first = await vcr.store.taskContext(origin('named_a'), { opening: async () => '张三，男，58岁，住院号 20260123，诊断为肺腺癌' });
  assert.equal(first.name, '对话研究', 'an opening sentence is not read, even when a caller hands one over');
  assert.equal(first.nameBasis, null);
  assert.equal(first.scope, 'conversation');
  const again = await vcr.store.taskContext(origin('named_a'));
  assert.equal(again.id, first.id);
  assert.equal(again.name, '对话研究');
  assert.equal(await vcr.store.taskContext(origin('named_never'), { create: false }), null);
});

test('a title names the study once, a later title or a definition may name it again, and a person\'s name is never undone', options, async () => {
  const study = await vcr.store.taskContext(origin('named_title'));
  const titled = await vcr.store.nameConversationStudy(study, { title: '住院号 20260123 患者的二线治疗方案匹配' });
  assert.equal(titled.name, '住院号 患者的二线治疗方案匹配', 'the identifier is taken out of the name');
  assert.equal(titled.nameBasis, 'assigned');
  assert.equal((await vcr.store.studyById(study.id)).name, titled.name);
  // A later title replaces it (the model sharpened the question); a title that names nothing leaves it.
  assert.equal((await vcr.store.nameConversationStudy(study, { title: '晚期肺癌二线两臂设计' })).name, '晚期肺癌二线两臂设计');
  assert.equal(await vcr.store.nameConversationStudy(study, { title: '2026年11月2日' }), null);
  assert.equal(await vcr.store.nameConversationStudy({ id: null }, { title: 'x' }), null);
  assert.equal((await vcr.store.studyById(study.id)).name, '晚期肺癌二线两臂设计');
  // A definition's title names it again; the definition's question and population do not: they are sentences.
  await vcr.store.saveDefinition({ studyId: study.id, userId: 'owner', pico: { population: '成人晚期肺癌' }, title: '二线治疗的生存比较', question: '张三的二线治疗是否延长生存' });
  const defined = await vcr.store.studyById(study.id);
  assert.equal(defined.name, '二线治疗的生存比较');
  assert.equal(defined.nameBasis, 'assigned');
  assert.equal(defined.question, '张三的二线治疗是否延长生存', 'the question is kept where it is kept');
  await vcr.store.saveDefinition({ studyId: study.id, userId: 'owner', pico: {}, question: '又一个问题' });
  assert.equal((await vcr.store.studyById(study.id)).name, '二线治疗的生存比较', 'a definition with no title leaves the name');

  // A person's rename is final.
  const renamed = await vcr.store.taskContext(origin('named_person'));
  await vcr.store.updateStudy(renamed.id, { name: '我自己起的名字' }, 'owner');
  assert.equal(await vcr.store.nameConversationStudy(renamed, { title: '模型想起的名字' }), null);
  await vcr.store.saveDefinition({ studyId: renamed.id, userId: 'owner', pico: { population: '成人' }, title: '定义给的名字' });
  await vcr.store.savePopulation({ studyId: renamed.id, userId: 'owner', name: '情景人群', kind: 'scenario', definition: { n: 100 }, allowedUses: ['design'] });
  assert.equal(await vcr.store.nameFromWhatItHolds(renamed), null);
  const kept = await vcr.store.studyById(renamed.id);
  assert.equal(kept.name, '我自己起的名字');
  assert.equal(kept.nameBasis, null);
});

test('a study that holds something and has no title is named for the kind of work and the day, once, and a title that came meanwhile stands', options, async () => {
  const bare = await vcr.store.taskContext(origin('named_held'));
  assert.equal(await vcr.store.nameFromWhatItHolds(bare), null, 'nothing held: nothing to call it');
  assert.equal((await vcr.store.studyById(bare.id)).name, '对话研究');
  await vcr.matchStore.saveProtocolVersion({ studyId: bare.id, userId: 'owner', title: '方案 v1', criteria: [
    { kind: 'inclusion', criterionType: 'demographic', sourceText: '年龄 ≥ 18 岁', sourceLocator: { page: 1 }, requirement: { op: 'compare', variable: 'age', comparator: 'gte', value: 18 }, evidenceNeeded: [] },
  ] });
  const named = await vcr.store.nameFromWhatItHolds(bare);
  assert.equal(named.name, `患者匹配 · ${today()}`);
  assert.equal(named.nameBasis, 'assigned');
  // Once: a second call finds it named, and a study that holds more later keeps its name.
  await vcr.store.savePopulation({ studyId: bare.id, userId: 'owner', name: '情景人群', kind: 'scenario', definition: { n: 100 }, allowedUses: ['design'] });
  assert.equal(await vcr.store.nameFromWhatItHolds(bare), null);
  assert.equal((await vcr.store.studyById(bare.id)).name, `患者匹配 · ${today()}`);
  // A title replaces the kind of work.
  assert.equal((await vcr.store.nameConversationStudy(bare, { title: '二线治疗匹配' })).name, '二线治疗匹配');

  // A title that arrived between the look and the write is not overwritten by the neutral name.
  const raced = await vcr.store.taskContext(origin('named_raced'));
  await vcr.store.savePopulation({ studyId: raced.id, userId: 'owner', name: '情景人群', kind: 'scenario', definition: { n: 100 }, allowedUses: ['design'] });
  await vcr.store.nameConversationStudy(raced, { title: '先到的标题' });
  assert.equal(await vcr.store.nameFromWhatItHolds(raced), null);
  assert.equal((await vcr.store.studyById(raced.id)).name, '先到的标题');
});

test('studies named from a first sentence before the review are named again for the kind of work, at start, once', options, async () => {
  const held = await vcr.store.taskContext(origin('retire_held'));
  await vcr.store.savePopulation({ studyId: held.id, userId: 'owner', name: '情景人群', kind: 'scenario', definition: { n: 100 }, allowedUses: ['design'] });
  const empty = await vcr.store.taskContext(origin('retire_empty'));
  const kept = await vcr.store.taskContext(origin('retire_person'));
  await vcr.store.updateStudy(kept.id, { name: '我起的名字' }, 'owner');
  await vcr.store.query(`UPDATE evimed_vcr.studies SET name = '张三，男，58岁，住院号 20260123', name_basis = 'opening' WHERE id = ANY($1::text[])`, [[held.id, empty.id]]);
  // A process that starts later reads the rows once: the name a patient's sentence gave is gone from both, and nothing else moved.
  const later = new VcrStore({ database });
  await later.ready();
  const [h, e, k] = [await vcr.store.studyById(held.id), await vcr.store.studyById(empty.id), await vcr.store.studyById(kept.id)];
  assert.equal(h.name, `虚拟人群 · ${vcrMonthDay(h.createdAt)}`);
  assert.equal(h.nameBasis, 'assigned');
  assert.equal(e.name, '对话研究', 'a study that holds nothing has the placeholder back');
  assert.equal(e.nameBasis, null);
  assert.equal(k.name, '我起的名字');
  const after = await vcr.store.rows(`SELECT count(*)::int AS n FROM evimed_vcr.studies WHERE name_basis = 'opening'`);
  assert.equal(after[0].n, 0);
  // Idempotent: a third process finds nothing to do and changes nothing.
  await new VcrStore({ database }).ready();
  assert.equal((await vcr.store.studyById(h.id)).name, h.name);
});

test('notices call a study by its name, and a placeholder by its question', () => {
  assert.equal(vcrStudyName({ name: '二线治疗的生存比较', question: '' }), '二线治疗的生存比较');
  assert.equal(vcrStudyName({ name: '对话研究', question: '二线治疗是否延长生存' }), '二线治疗是否延长生存');
  assert.equal(vcrStudyName({ name: '对话研究', question: '' }), '虚拟临床研究');
});

test('the home lists a conversation\'s study in a field of its own, only once it holds something, and the shared list is not widened', options, async () => {
  const user = { id: 'home_owner' };
  const empty = await vcr.store.taskContext(origin('home_empty', user.id));
  const matched = await vcr.store.taskContext(origin('home_matching', user.id));
  await vcr.matchStore.saveProtocolVersion({ studyId: matched.id, userId: user.id, title: '方案 v1', criteria: [
    { kind: 'inclusion', criterionType: 'demographic', sourceText: '年龄 ≥ 18 岁', sourceLocator: { page: 1 }, requirement: { op: 'compare', variable: 'age', comparator: 'gte', value: 18 }, evidenceNeeded: [] },
  ] });
  const designed = await vcr.store.taskContext(origin('home_design', user.id));
  await vcr.store.saveDefinition({ studyId: designed.id, userId: user.id, pico: { population: '成人' }, title: '' });
  const populated = await vcr.store.taskContext(origin('home_population', user.id));
  await vcr.store.savePopulation({ studyId: populated.id, userId: user.id, name: '情景人群', kind: 'scenario', definition: { n: 100 }, allowedUses: ['design'] });
  const other = await vcr.store.taskContext(origin('home_other', 'someone_else'));
  await vcr.store.savePopulation({ studyId: other.id, userId: 'someone_else', name: '别人的人群', kind: 'scenario', definition: { n: 10 }, allowedUses: ['design'] });
  const removed = await vcr.store.taskContext(origin('home_removed', user.id));
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
  assert.equal(byId.get(matched.id).name, `患者匹配 · ${vcrMonthDay(byId.get(matched.id).createdAt)}`, 'called for the kind of work it holds and the day, in code');
  assert.equal(byId.get(populated.id).name, `虚拟人群 · ${vcrMonthDay(byId.get(populated.id).createdAt)}`);
  assert.equal(byId.get(designed.id).name, `研究资料 · ${vcrMonthDay(byId.get(designed.id).createdAt)}`, 'a definition with no title names nothing');
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

test('a study that holds only a result no object owns is listed on the tab that shows it (live 2026-11-04: a 3+3 against BOIN comparison was not on the home)', options, async () => {
  const user = { id: 'home_resultonly' };
  const result = (/** @type {string} */ studyId, /** @type {string} */ kind) => vcr.store.recordResult({ studyId, userId: user.id, kind, subjectId: `${kind}:one`, conclusion: 'estimable', measures: [], diagnostics: {} });
  const dose = await vcr.store.taskContext(origin('ro_dose', user.id));
  await result(dose.id, 'design_dose');
  const network = await vcr.store.taskContext(origin('ro_network', user.id));
  await result(network.id, 'network_meta');
  const empty = await vcr.store.taskContext(origin('ro_empty', user.id));
  const listed = new Map((await vcr.service.listStudies(user)).conversationStudies.map((/** @type {any} */ row) => [row.id, row]));
  assert.deepEqual(listed.get(dose.id)?.tabs, ['trial'], 'a dose-finding comparison is a trial-page result');
  assert.deepEqual(listed.get(network.id)?.tabs, ['data'], 'a network meta-analysis is read on the data page');
  assert.ok(!listed.has(empty.id), 'a study that holds nothing is still not listed');
  assert.deepEqual(await vcr.store.heldTabs(dose.id), ['trial']);
});

test('the home lists the newest fifty, and says when the list could not be read instead of drawing an empty one', options, async () => {
  const user = { id: 'home_many' };
  /** @type {string[]} */ const ids = [];
  for (let n = 0; n < 53; n += 1) {
    const study = await vcr.store.taskContext(origin(`many_${n}`, user.id));
    ids.push(study.id);
    await vcr.store.savePopulation({ studyId: study.id, userId: user.id, name: `人群 ${n}`, kind: 'scenario', definition: { n }, allowedUses: ['design'] });
    await vcr.store.query('UPDATE evimed_vcr.studies SET updated_at = $2 WHERE id = $1', [study.id, new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString()]);
  }
  const home = await vcr.service.listStudies(user);
  assert.equal(home.conversationStudies.length, 50);
  assert.equal(home.conversationStudies[0].id, ids[52]);
  assert.equal(home.conversationStudies[49].id, ids[3]);

  const original = vcr.store.conversationStudies;
  vcr.store.conversationStudies = async () => { throw new Error('unreadable'); };
  try {
    const failed = await vcr.service.listStudies(user);
    assert.equal(failed.conversationStudies, undefined);
    assert.equal(failed.conversationStudiesUnreadable, true);
    assert.deepEqual(failed.studies, [], 'the rest of the home is read as it was');
  } finally { vcr.store.conversationStudies = original; }
});

test('a row that still carries the placeholder is called for the kind of work it holds, and its question is not its name', options, async () => {
  const user = { id: 'home_legacy' };
  const study = await vcr.store.taskContext(origin('legacy_row', user.id));
  assert.equal(study.name, '对话研究');
  await vcr.store.savePopulation({ studyId: study.id, userId: user.id, name: '人群', kind: 'scenario', definition: { n: 10 }, allowedUses: ['design'] });
  const listed = async () => (await vcr.service.listStudies(user)).conversationStudies[0];
  assert.equal((await listed()).name, `虚拟人群 · ${vcrMonthDay(study.createdAt)}`);
  await vcr.store.query("UPDATE evimed_vcr.studies SET question = '二线治疗是否延长生存' WHERE id = $1", [study.id]);
  const row = await listed();
  assert.equal(row.name, `虚拟人群 · ${vcrMonthDay(study.createdAt)}`);
  assert.equal(row.question, '二线治疗是否延长生存', 'the question is its own field');
});

test('the study page says which tabs hold something, so a study with only matching results can open on 匹配 (F4)', options, async () => {
  const user = { id: 'held_owner' };
  const matched = await vcr.store.taskContext(origin('held_matching', user.id));
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
  const study = await vcr.store.taskContext(origin('orig_conv', user.id));
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

test('a complete scenario-only patient generation files its own object and retains previous settings without inheriting a cohort', options, async () => {
  const study = await vcr.store.taskContext({ userId: 'selfpatients', projectId: 'default', rootSessionId: 'selfpatients_root', runId: 'r', callId: 'c', programme: false }, { create: true });
  const scenario = { design: { nTreat: 40, nControl: 40 }, endpoint: { type: 'binary' }, truth: { controlRate: 0.3, treatmentRate: 0.45 } };
  const first = await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'generate_patients_binary', scenario });
  assert.ok(first);
  assert.equal(await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'generate_patients_binary', scenario }), first);
  const changed = { ...scenario, truth: { ...scenario.truth, treatmentRate: 0.4 } };
  const second = await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'generate_patients_binary', scenario: changed });
  assert.notEqual(second, first);
  const rows = await vcr.store.patientSets(study.id);
  assert.deepEqual(rows.find(row => row.id === first).scenario, scenario);
  assert.deepEqual(rows.find(row => row.id === second).scenario, changed);
  assert.ok(rows.every(row => !row.populationId && !row.modelId));
  assert.equal(await vcrConversationSubject({ store: vcr.store, study: { ...study, scope: 'study' }, userId: study.userId, kind: 'generate_patients_binary', scenario }), null);
  assert.equal(await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'apply_prognostic_model', scenario }), null);
  const count = rows.length;
  await assert.rejects(vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'generate_patients_binary', scenario: { ...scenario, truth: { controlRate: 2 } } }), { code: 'vcr_job_scenario_invalid' });
  assert.equal((await vcr.store.patientSets(study.id)).length, count);
});

test('a name collision cannot silently attach a scenario-only generation to an existing selected population', options, async () => {
  const study = await vcr.store.taskContext({ userId: 'selfpatients-bound', projectId: 'default', rootSessionId: 'selfpatients_bound', runId: 'r', callId: 'c', programme: false }, { create: true });
  const scenario = { design: { nTreat: 40, nControl: 40 }, endpoint: { type: 'binary' }, truth: { controlRate: 0.3, treatmentRate: 0.45 } };
  const population = await vcr.store.savePopulation({ studyId: study.id, userId: study.userId, kind: 'scenario', name: 'Selected population', definition: {} });
  const held = await vcr.store.savePatientSet({ studyId: study.id, userId: study.userId, name: '虚拟患者集 2', scenario, populationId: population.id });
  const created = await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'generate_patients_binary', scenario });
  assert.notEqual(created, held.id);
  const rows = await vcr.store.patientSets(study.id);
  assert.equal(rows.find(row => row.id === created).populationId, null);
  assert.equal(rows.find(row => row.id === held.id).populationId, population.id);
  const explicit = await resolveJobSubject({ store: vcr.store, study, kind: 'generate_patients_binary', subjectId: held.id, scenario });
  assert.equal(explicit.row.populationId, population.id);
});

test('changing a generated cohort scenario or removing a bound preserves the exact previous configuration', options, async () => {
  const study = await vcr.store.taskContext({ userId: 'selfcohort-version', projectId: 'default', rootSessionId: 'selfcohort_version', runId: 'r', callId: 'c', programme: false }, { create: true });
  const firstScenario = { n: 200, population: { variables: [{ name: 'age', family: 'normal', mean: 60, sd: 9, min: 18 }] } };
  const first = await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'generate_population', scenario: firstScenario });
  const changed = { n: 200, population: { variables: [{ name: 'age', family: 'normal', mean: 65, sd: 9 }] } };
  const second = await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'generate_population', scenario: changed });
  assert.notEqual(second, first);
  const thirdScenario = { ...changed, n: 300 };
  const third = await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'generate_population', subjectId: second, scenario: thirdScenario });
  assert.notEqual(third, second);
  const rows = await vcr.store.populations(study.id);
  assert.deepEqual(rows.find(row => row.id === first).definition, firstScenario);
  assert.deepEqual(rows.find(row => row.id === second).definition, changed);
  assert.deepEqual(rows.find(row => row.id === third).definition, thirdScenario);
});

test("a stand-alone E-value of a stated estimate and limit runs in a conversation with nothing written first, and never under another comparison the study holds", options, async () => {
  const study = await vcr.store.taskContext({ userId: 'evalue_owner', projectId: 'default', rootSessionId: 'evalue_root', runId: 'r', callId: 'c', dispatchId: null, routeReason: null, programme: false }, { create: true });
  const hazard = { riskRatio: 0.6, confidenceLimit: 0.8, scale: 'hazard_ratio', rare: true };
  // another comparison the study holds: its result is its own
  const other = await vcr.store.saveComparatorDesign({ studyId: study.id, userId: study.userId, name: '对照 1', route: 'external_control', estimand: 'ATT', configuration: { covariates: ['age'] }, targetTrial: {} });
  const made = await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'evalue', scenario: hazard });
  assert.ok(made, 'the estimate is the object');
  assert.notEqual(made, other.id, 'it is not filed under the comparison the study already holds');
  const subject = await resolveJobSubject({ store: vcr.store, study, kind: 'evalue', subjectId: made, scenario: hazard });
  assert.equal(subject.objectKind, 'comparator');
  assert.equal(subject.row.route, 'literature_control');
  assert.deepEqual(subject.row.configuration, hazard);
  // the same estimate again is the one object; another estimate is another
  assert.equal(await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'evalue', scenario: hazard }), made);
  const second = await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'evalue', scenario: { ...hazard, riskRatio: 0.5 } });
  assert.ok(second && second !== made);
  // a scenario the engine would refuse is refused by what is wrong with it, and nothing is written
  await assert.rejects(vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'evalue', scenario: { riskRatio: -1, scale: 'hazard_ratio' } }), { code: 'vcr_job_scenario_invalid' });
  assert.equal((await vcr.store.comparatorDesigns(study.id, 50)).length, 3, 'the other comparison, and the two estimates');
  // a study with a page of its own still asks for the object first
  assert.equal(await vcrConversationSubject({ store: vcr.store, study: { ...study, scope: 'project' }, userId: study.userId, kind: 'evalue', scenario: hazard }), null);
});
