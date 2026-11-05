import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { AUTOPILOT_PLANNER_INSTRUCTIONS } from '../../../apps/server/src/autopilotNextAction.mjs';
import { FRONTIER_EDITOR_VERSION, FRONTIER_EDIT_INSTRUCTIONS, FRONTIER_SCREEN_INSTRUCTIONS } from '../../../apps/server/src/frontierEditor.mjs';
import { REFERENCE_PRICE_LIST } from '../../../packages/domain/src/metering.mjs';
import { buildHarnessCampaign, developmentOnly, readChecked } from '../harness_assemble.mjs';
import { harnessArmsIssues } from '../harness_campaign.mjs';
import { EXIT_INCOMPLETE, FIDELITY_BRIEF, drawExportItems, fidelityPackets, fidelityVerdicts, moduleCasePool, moduleIncumbent, moduleJudgeBlock, moduleRound, runModuleArms, writeArmsOutcome } from '../module_arms.mjs';
import { MODULE_KIT } from '../module_campaign.mjs';
import { frontierNumbersPassed } from '../module_scorers.mjs';
import { improvementOf } from '../profiles/harness_fixture.mjs';
import { judgeOf, sha256 } from '../profiles/module_fixture.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'rsi-module-arms-'));
after(() => rm(scratch, { recursive: true, force: true }));
let files = 0;
const nextPath = (name = 'out.json') => join(scratch, `${files += 1}-${name}`);
const IMAGE = Object.freeze({ id: 'module-test', digest: 'ab'.repeat(32) });
const KEY = 'sk-a-key-nothing-may-print';
const usage = { prompt_tokens: 3000, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 2000, completion_tokens: 400 };
const answer = (content, extra = {}) => ({ id: 'x', model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage, ...extra });

/** A planner model: it answers from the case's own expectation so a baseline passes, and records what it was sent. */
function plannerModel({ decide = (context) => ({ action: 'run', taskType: context.taskTypes.find((type) => type.state === 'available').id, focus: 'f', reason: 'r' }), seen = [] } = {}) {
  return async (_dependencies, call) => {
    seen.push(call);
    return answer(decide(JSON.parse(call.body.messages[1].content), call));
  };
}
const round = (surface, scorer, pool, changes = {}) => moduleRound({ surface, scorer, round: 'b2-arms', salt: 'test-salt', pool, developmentCount: pool.length, registeredAt: '2026-11-01T00:00:00Z', ...changes });
const incumbentOf = (surface) => moduleIncumbent(surface);

test('the case files read as rows: the planner\'s 9, the frontier editor\'s four kinds, the screen\'s lane cases, gold as closed expectations', async () => {
  const planner = await moduleCasePool('autopilot-planner');
  assert.equal(planner.length, 9);
  assert.ok(planner.every((row) => row.gold.expect.length && ['run', 'stop'].includes(row.category) && row.variants.length === 1));
  const edit = await moduleCasePool('frontier-edit'), screen = await moduleCasePool('frontier-screen');
  assert.deepEqual([...new Set(edit.map((row) => row.category))].sort(), ['evidence_type', 'flags', 'industry_kind', 'lane']);
  assert.equal(edit.length, 5 + 9 + 6 + 16);
  assert.ok(screen.every((row) => row.category === 'lane' && row.variants[0].input.screen), 'only a lane case says what a screen reads');
  assert.equal(screen.length, 5);
  assert.deepEqual(edit.find((row) => row.id === 'food-recall-flour').gold, { kind: 'lane', expectNot: ['safety'] });
  assert.deepEqual(edit.find((row) => row.id === 'kind-control-paper').gold, { kind: 'industry_kind', expect: [null] });
});

test('the arms run production\'s planner on production\'s prompt: a candidate reaches it as a served policy, nothing is copied, and the source is one the lab reads', async () => {
  const pool = (await moduleCasePool('autopilot-planner')).slice(0, 3), seen = [];
  const candidates = [{ title: 'c', policy: { plannerInstructions: 'A candidate text for the planner.' } }];
  const { source, gold, missing } = await runModuleArms({ surface: 'autopilot-planner', role: 'development', scorerId: 'autopilot-checklist', rows: pool, repeats: 2, candidates, incumbent: incumbentOf('autopilot-planner'), image: IMAGE, apiKey: KEY, callModel: plannerModel({ seen }) });
  assert.deepEqual(missing, []);
  assert.equal(gold, null, 'development rows carry their gold');
  assert.equal(seen.length, 3 * 3 * 2, 'baseline, aa and the candidate on every case and repeat');
  const systems = new Set(seen.map((call) => call.body.messages[0].content));
  assert.ok([...systems].some((text) => text.startsWith(AUTOPILOT_PLANNER_INSTRUCTIONS)), 'the baseline is the text production ships');
  assert.ok([...systems].some((text) => text.startsWith('A candidate text for the planner.')), 'the candidate is the text it says');
  assert.ok(seen.every((call) => call.body.model === 'deepseek-flash' && call.body.temperature === 0), 'production\'s call');
  const armId = Object.keys(source.arms).find((id) => id.startsWith('cand-'));
  assert.equal(source.arms[armId].harness.policy.component, 'plannerInstructions');
  for (const run of source.runs) {
    assert.equal(run.status, 'succeeded');
    assert.equal(run.calls.length, 1);
    assert.deepEqual([run.calls[0].cacheHit, run.calls[0].cacheMiss, run.calls[0].output], [1000, 2000, 400]);
    assert.ok(run.cost > 0);
    if (run.arm === armId) assert.equal(run.policyRevisionId, armId, 'production\'s class says it served the candidate');
    else assert.match(run.policyRevisionId, /^default:/, 'and its code default to the baseline and the control');
  }
  assert.equal(source.priceVersion, REFERENCE_PRICE_LIST.version);
  // The lab's own validation reads what the arms wrote.
  const registered = round('autopilot-planner', 'autopilot-checklist', pool);
  const development = { ...source, image: IMAGE };
  assert.deepEqual(harnessArmsIssues(development, { surface: 'autopilot-planner', scorer: 'autopilot-checklist' }, MODULE_KIT), []);
  const preview = developmentOnly({ development, registration: registered, improvement: improvementOf(), month: '2026-11' });
  assert.equal(preview.supply.developmentChoice.controls[0].arm, 'aa');
  assert.ok(Number.isFinite(preview.supply.developmentChoice.noiseFloor));
});

test('no arm always goes first on a case: the provider\'s cache would hand it to the second arm of every cost comparison', async () => {
  const pool = await moduleCasePool('autopilot-planner'), seen = [], candidate = 'The planner text under test.';
  await runModuleArms({ surface: 'autopilot-planner', role: 'confirmation', scorerId: 'autopilot-checklist', rows: pool, repeats: 3, candidates: [{ policy: { plannerInstructions: candidate } }], incumbent: incumbentOf('autopilot-planner'), image: IMAGE, apiKey: KEY, concurrency: 1, callModel: plannerModel({ seen }) });
  // Two arms in turn: every odd call opens a case and repeat.
  const firsts = seen.filter((_, at) => at % 2 === 0).map((call) => call.body.messages[0].content.startsWith(candidate));
  assert.equal(firsts.length, 27);
  assert.ok(firsts.includes(true) && firsts.includes(false), 'each arm opens some');
  assert.ok(Math.abs(firsts.filter(Boolean).length - 13.5) < 7, `the candidate opens ${firsts.filter(Boolean).length} of 27`);
});

test('an infrastructure failure is never scored: exit 3 and nothing written; --allow-incomplete writes what exists and says so; the same command runs only what is missing', async () => {
  const pool = (await moduleCasePool('autopilot-planner')).slice(0, 2), journalPath = nextPath('arms.journal.jsonl'), out = nextPath();
  let refusals = 2, calls = 0;
  const flaky = plannerModel();
  const callModel = async (dependencies, call) => { calls += 1; if (refusals > 0) { refusals -= 1; throw Object.assign(new Error(`upstream said ${KEY}`), { code: 'model_gateway_upstream_error' }); } return flaky(dependencies, call); };
  const shared = { surface: 'autopilot-planner', role: 'development', scorerId: 'autopilot-checklist', rows: pool, repeats: 1, incumbent: incumbentOf('autopilot-planner'), image: IMAGE, apiKey: KEY, journalPath, concurrency: 1 };
  const first = await runModuleArms({ ...shared, callModel });
  assert.equal(first.missing.length, 2, 'two runs met the provider');
  assert.deepEqual([...new Set(first.missing.map((row) => row.reason))], ['model_gateway_upstream_error'], 'by closed code');
  assert.equal(first.source.runs.length, 2, 'the others stand');
  assert.equal(await writeArmsOutcome({ out, ...first }), EXIT_INCOMPLETE);
  assert.equal(existsSync(out), false, 'nothing is written');
  // What the lab would say of it if it were written.
  const allowed = nextPath();
  assert.equal(await writeArmsOutcome({ out: allowed, ...first, allowIncomplete: true }), EXIT_INCOMPLETE);
  assert.deepEqual(harnessArmsIssues(JSON.parse(await readFile(allowed, 'utf8')), { surface: 'autopilot-planner', scorer: 'autopilot-checklist' }, MODULE_KIT), ['harness_arms_runs_incomplete']);
  assert.equal(JSON.parse(await readFile(`${allowed}.incomplete.json`, 'utf8')).length, 2);
  // Resuming pays for the two missing runs and nothing else.
  const before = calls;
  const second = await runModuleArms({ ...shared, callModel });
  assert.deepEqual(second.missing, []);
  assert.equal(calls - before, 2);
  assert.equal(second.source.runs.length, 4);
  assert.deepEqual(harnessArmsIssues(second.source, { surface: 'autopilot-planner', scorer: 'autopilot-checklist' }, MODULE_KIT), []);
  // A journal of another campaign is not resumed.
  await assert.rejects(runModuleArms({ ...shared, repeats: 2, callModel }), { message: 'module_arms_journal_mismatch' });
  // The key is in nothing written, whatever a provider's error said.
  for (const path of [journalPath, allowed, `${allowed}.incomplete.json`]) assert.equal((await readFile(path, 'utf8')).includes(KEY), false, path);
});

test('a solver\'s own non-delivery is a run that scores 0, kept with its cost; a response with no usage stops the command: a cost that cannot be priced is not a cost', async () => {
  const pool = (await moduleCasePool('autopilot-planner')).slice(0, 1);
  const shared = { surface: 'autopilot-planner', role: 'development', scorerId: 'autopilot-checklist', rows: pool, repeats: 1, incumbent: incumbentOf('autopilot-planner'), image: IMAGE, apiKey: KEY };
  const invalid = await runModuleArms({ ...shared, callModel: async () => answer('this is not a decision') });
  assert.deepEqual(invalid.missing, []);
  assert.ok(invalid.source.runs.every((run) => run.status === 'failed' && run.answer === null && run.solverCode === 'autopilot_planner_invalid' && run.cost > 0));
  await assert.rejects(runModuleArms({ ...shared, callModel: async () => ({ ...answer({ action: 'stop', stopKind: 'answered', reason: 'r' }), usage: undefined }) }), { message: 'module_arms_cost_unpriced' });
  await assert.rejects(runModuleArms({ ...shared, callModel: async () => ({ ...answer({ action: 'stop', stopKind: 'answered', reason: 'r' }), usage: { prompt_tokens: 10 } }) }), { message: 'module_arms_cost_unpriced' });
});

test('one candidate in a confirmation, its rows sealed, its gold apart; a file nobody can verify is refused by the assembly\'s own check', async () => {
  const pool = (await moduleCasePool('autopilot-planner')).slice(0, 2);
  const shared = { surface: 'autopilot-planner', role: 'confirmation', scorerId: 'autopilot-checklist', rows: pool, repeats: 3, incumbent: incumbentOf('autopilot-planner'), image: IMAGE, apiKey: KEY, callModel: plannerModel() };
  await assert.rejects(runModuleArms(shared), { message: 'module_arms_confirmation_one_candidate' });
  const made = await runModuleArms({ ...shared, candidates: [{ policy: { plannerInstructions: 'The frozen text.' } }] });
  assert.equal(made.source.rows.some((row) => Object.hasOwn(row, 'gold')), false, 'the rows travel without gold');
  assert.equal(Object.hasOwn(made.source.arms, 'aa'), false, 'no control arm in a confirmation');
  assert.deepEqual(Object.keys(made.gold.gold).sort(), pool.map((row) => row.id).sort());
  const out = nextPath();
  assert.equal(await writeArmsOutcome({ out, ...made }), 0);
  assert.deepEqual(JSON.parse(await readChecked(out)).rows, made.source.rows);
  assert.ok(JSON.parse(await readChecked(out.replace(/\.json$/, '.gold.json'))).gold);
  await writeFile(out, 'changed');
  await assert.rejects(readChecked(out), { message: 'campaign_input_checksum_mismatch' });
});

test('frontier-edit: production\'s editor, its number check on the rewrite, its verification; a candidate production would not serve runs no arm', async () => {
  const pool = (await moduleCasePool('frontier-edit')).filter((row) => row.id === 'toxic-supplement-recall');
  const rewrite = (summary, lane = 'safety') => ({ scores: { impact: 10, novelty: 10, relevance: 10 }, practice: { changing: false, reason_zh: '' }, genre: 'safety', industry_kind: '', title_zh: '补充剂因毒性被召回', summary_zh: summary, reason_zh: '', tags: [], lane, specialties: [], evidence_type: 'safety-notice', entities: { drugs: [], trials: [], orgs: [], diseases: [] }, flags: [] });
  const shared = { surface: 'frontier-edit', role: 'development', scorerId: 'frontier-numbers', rows: pool, repeats: 2, incumbent: incumbentOf('frontier-edit'), image: IMAGE, apiKey: KEY };
  const systems = [];
  const clean = await runModuleArms({ ...shared, callModel: async (_d, call) => { systems.push(call.body.messages[0].content); return answer(rewrite('这种补充剂被召回，生产商提醒消费者停止使用。')); } });
  assert.ok(systems.every((text) => text === FRONTIER_EDIT_INSTRUCTIONS), 'the prompt under test is the one that ships');
  const unit = clean.source.runs[0].answer.units[0];
  assert.deepEqual(unit.numbers.missing, []);
  assert.ok(['passed', 'repaired'].includes(unit.verification), unit.verification);
  assert.equal(unit.output.lane, 'safety');
  // An invented figure: the check names it, the rewrite is asked once more, and the arm counts both calls.
  const invented = await runModuleArms({ ...shared, callModel: async () => answer(rewrite('召回涉及 98765 名消费者，生产商提醒停止使用。')) });
  const failed = invented.source.runs[0];
  assert.ok(failed.answer.units[0].numbers.missing.length > 0, JSON.stringify(failed.answer.units[0].numbers));
  assert.equal(failed.answer.units[0].verification, 'title-only');
  assert.equal(failed.calls.length, 2, 'the rewrite was a second paid call');
  // Instructions without an answer key would have production fall back to its code default: such a candidate would be the baseline under another name.
  await assert.rejects(runModuleArms({ ...shared, callModel: async () => answer(rewrite('s')), candidates: [{ policy: { editInstructions: 'A text that names no answer keys.' } }] }), { message: 'module_candidate_not_current' });
  const current = `${FRONTIER_EDIT_INSTRUCTIONS}\nOne more rule.`;
  const served = await runModuleArms({ ...shared, callModel: async () => answer(rewrite('这种补充剂被召回，生产商提醒消费者停止使用。')), candidates: [{ policy: { editInstructions: current } }] });
  const armId = Object.keys(served.source.arms).find((id) => id.startsWith('cand-'));
  assert.ok(served.source.runs.filter((run) => run.arm === armId).every((run) => /^frontier-editor-policy\./.test(run.policyRevisionId)), 'the editor stamps what it wrote with the text it used');
  assert.ok(served.source.runs.filter((run) => run.arm !== armId).every((run) => run.policyRevisionId === FRONTIER_EDITOR_VERSION));
  assert.deepEqual(harnessArmsIssues(served.source, { surface: 'frontier-edit', scorer: 'frontier-numbers' }, MODULE_KIT), []);
  // One component: a planner's text is not an editor candidate.
  await assert.rejects(runModuleArms({ ...shared, callModel: async () => answer(rewrite('s')), candidates: [{ policy: { plannerInstructions: 'x' } }] }), { message: 'module_candidate_not_one_component' });
});

test('frontier-screen: the screen under test feeds the edit, both are production\'s, and the screen\'s own lane is in the unit', async () => {
  const pool = (await moduleCasePool('frontier-screen')).filter((row) => row.id === 'food-recall-flour');
  const verdict = (lane) => ({ items: [{ id: '1', medical: true, news: true, lane, specialties: [], language: 'en', digest: false }] });
  const systems = [];
  const callModel = async (_d, call) => {
    const text = call.body.messages[0].content;
    systems.push(text);
    return text === FRONTIER_EDIT_INSTRUCTIONS ? answer({ scores: { impact: 1, novelty: 1, relevance: 1 }, practice: { changing: false, reason_zh: '' }, genre: 'safety', industry_kind: '', title_zh: '面粉因麸质被召回', summary_zh: '一家公司召回面粉产品。', reason_zh: '', tags: [], lane: 'regulatory', specialties: [], evidence_type: 'safety-notice', entities: { drugs: [], trials: [], orgs: [], diseases: [] }, flags: [] }) : answer(verdict('regulatory'));
  };
  const candidate = 'A candidate for the screen.';
  const made = await runModuleArms({ surface: 'frontier-screen', role: 'development', scorerId: 'frontier-numbers', rows: pool, repeats: 2, incumbent: incumbentOf('frontier-screen'), image: IMAGE, apiKey: KEY, callModel, candidates: [{ policy: { screenInstructions: candidate } }] });
  assert.ok(systems.includes(FRONTIER_SCREEN_INSTRUCTIONS) && systems.includes(candidate) && systems.includes(FRONTIER_EDIT_INSTRUCTIONS));
  assert.ok(made.source.runs.every((run) => run.answer.units[0].screenLane === 'regulatory' && run.calls.length === 2), 'a screen and an edit');
  assert.deepEqual(harnessArmsIssues(made.source, { surface: 'frontier-screen', scorer: 'frontier-numbers' }, MODULE_KIT), []);
});

test('the baseline is the text a proposal would replace: the code\'s own, named by its digest, and no production revision is claimed', () => {
  for (const [surface, text] of [['autopilot-planner', AUTOPILOT_PLANNER_INSTRUCTIONS], ['frontier-screen', FRONTIER_SCREEN_INSTRUCTIONS], ['frontier-edit', FRONTIER_EDIT_INSTRUCTIONS]]) {
    assert.deepEqual(moduleIncumbent(surface), { revisionId: `code-default:${sha256(text).slice(0, 16)}`, componentSha256: sha256(text) }, surface);
  }
});

test('a rewrite\'s source says how many numbers it holds, by the editor\'s own check, and one that drops them all is seen', async () => {
  const pool = drawExportItems(exportFixture(), { sample: 1, salt: 'm' }).rows, rewrite = (summary) => ({ scores: { impact: 10, novelty: 10, relevance: 10 }, practice: { changing: false, reason_zh: '' }, genre: 'paper', industry_kind: '', title_zh: '一项公开研究的结果', summary_zh: summary, reason_zh: '', tags: [], lane: 'evidence', specialties: [], evidence_type: 'other', entities: { drugs: [], trials: [], orgs: [], diseases: [] }, flags: [] });
  const shared = { surface: 'frontier-edit', role: 'development', scorerId: 'frontier-numbers', rows: pool.map((row) => ({ ...row, gold: {} })), repeats: 1, incumbent: incumbentOf('frontier-edit'), image: IMAGE, apiKey: KEY };
  const dropped = (await runModuleArms({ ...shared, callModel: async () => answer(rewrite('这项研究纳入了一些患者，并报告了结果。')) })).source.runs[0].answer.units[0];
  assert.ok(dropped.numbers.source > 0, JSON.stringify(dropped.numbers));
  assert.equal(dropped.numbers.checked, 0);
  assert.equal(frontierNumbersPassed(dropped), false);
  const kept = (await runModuleArms({ ...shared, callModel: async () => answer(rewrite('这项研究纳入了 42 名患者，并报告了结果。')) })).source.runs[0].answer.units[0];
  assert.ok(kept.numbers.checked > 0 && kept.numbers.missing.length === 0, JSON.stringify(kept.numbers));
  assert.equal(frontierNumbersPassed(kept), true);
});

test('a torn last line of the journal is dropped with a note and its run is run again; the paid runs before it are kept', async () => {
  const pool = (await moduleCasePool('autopilot-planner')).slice(0, 2), journalPath = nextPath('torn.journal.jsonl'), notes = [];
  let calls = 0;
  const model = plannerModel(), callModel = async (dependencies, call) => { calls += 1; return model(dependencies, call); };
  const shared = { surface: 'autopilot-planner', role: 'development', scorerId: 'autopilot-checklist', rows: pool, repeats: 1, incumbent: incumbentOf('autopilot-planner'), image: IMAGE, apiKey: KEY, journalPath, concurrency: 1, callModel, note: (text) => notes.push(text) };
  const first = await runModuleArms(shared);
  assert.equal(first.source.runs.length, 4);
  const text = await readFile(journalPath, 'utf8'), lines = text.split('\n').filter(Boolean);
  assert.equal(lines.length, 5);
  // A kill in the middle of the last append: half a line, no newline.
  await writeFile(journalPath, `${lines.slice(0, 4).join('\n')}\n${lines[4].slice(0, 40)}`);
  const before = calls;
  const second = await runModuleArms(shared);
  assert.equal(calls - before, 1, 'one run is run again, the three before it are not paid for twice');
  assert.equal(second.source.runs.length, 4);
  assert.deepEqual(harnessArmsIssues(second.source, { surface: 'autopilot-planner', scorer: 'autopilot-checklist' }, MODULE_KIT), []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /module_arms_journal_torn_line/);
  // The journal it leaves reads whole: the next start pays for nothing.
  const after = calls;
  await runModuleArms(shared);
  assert.equal(calls, after);
  assert.equal(notes.length, 1);
  // A broken line anywhere but the end is not a kill: that journal is refused, nothing is overwritten.
  const damaged = await readFile(journalPath, 'utf8'), rows = damaged.split('\n').filter(Boolean);
  rows[1] = rows[1].slice(0, 20);
  await writeFile(journalPath, `${rows.join('\n')}\n`);
  await assert.rejects(runModuleArms(shared), { message: 'module_arms_journal_invalid' });
});

// A month in the export's shape: `days[].rows` carry what the platform wrote about an item, `texts` what the source said.
const exportFixture = (items = 80) => {
  const texts = {}, rows = [];
  for (let at = 0; at < items; at += 1) {
    const id = String(5000 + at);
    rows.push({ id, event_id: at % 10 === 9 ? 'shared-event' : null, score_total: 80, lane: 'PLATFORM-LANE', verification: 'passed', summary_zh: 'PLATFORM-WROTE-THIS', practice_zh: 'PLATFORM-WROTE-THIS' });
    texts[id] = { title_raw: `A public item ${id}`, source_name: 'A journal', source_type: 'journal', journal: 'J', publication_types: ['Journal Article'], published_at: '2026-10-05T00:00:00Z', date_precision: 'day', lang: 'en', excerpt: at % 13 === 12 ? '' : `Source text of ${id} with 42 patients.` };
  }
  return { schema: 'rsi-frontier-export-v1', incumbent: { revisionId: `default:${'c'.repeat(64)}`, threshold: 66 }, days: [{ day: '2026-10-05', rows: rows.slice(0, items / 2) }, { day: '2026-10-06', rows: rows.slice(items / 2) }], texts };
};

test('a confirmation supply from the export: ascending sha256(salt|id), never what development saw, one per event, source text only, and the counts say how many groups that is', () => {
  const exported = exportFixture(), first = drawExportItems(exported, { sample: 30, salt: 'month-salt' });
  assert.equal(first.rows.length, 30);
  assert.equal(first.counts.groups, 30, 'each item is one group: at 25 and more the campaign can qualify');
  assert.deepEqual(first.rows, drawExportItems(exported, { sample: 30, salt: 'month-salt' }).rows, 'the same salt, the same draw');
  assert.notDeepEqual(first.rows.map((row) => row.id), drawExportItems(exported, { sample: 30, salt: 'other-salt' }).rows.map((row) => row.id));
  const hashes = first.rows.map((row) => sha256(`month-salt|${row.id.replace('export-', '')}`));
  assert.deepEqual(hashes, [...hashes].sort(), 'ascending');
  assert.ok(first.rows.every((row) => row.category === 'export' && Object.keys(row.gold).length === 0), 'its numbers check needs no gold');
  // Eligible: 80 items, 6 with no excerpt, the 8 with a text in the shared event count once.
  assert.equal(first.counts.items, 80);
  assert.equal(first.counts.noText, 6);
  assert.equal(first.counts.sameEvent, 7);
  assert.equal(first.counts.eligible, 67);
  assert.equal(drawExportItems(exported, { sample: 500, salt: 'month-salt' }).counts.groups, 67, 'a sample larger than the month is what the month has');
  const seen = new Set([first.rows[0].id, first.rows[1].id.replace('export-', '')]);
  const second = drawExportItems(exported, { sample: 30, salt: 'month-salt', exclude: seen });
  assert.equal(second.rows.some((row) => row.id === first.rows[0].id || row.id === first.rows[1].id), false, 'never an item the development set saw');
  assert.equal(drawExportItems(exported, { sample: 500, salt: 's', excludeTitles: new Set(['A public item 5000']) }).rows.some((row) => row.id === 'export-5000'), false, 'nor a case\'s own incident');
  const input = JSON.stringify(first.rows);
  assert.equal(input.includes('PLATFORM'), false, 'nothing a model of the platform wrote');
  assert.ok(input.includes('Source text of'));
  assert.equal(first.rows[0].variants[0].input.edit.summary.startsWith('Source text of'), true);
  assert.throws(() => drawExportItems({ days: [] }, { sample: 1, salt: 's' }), { message: 'module_arms_export_invalid' });
  assert.throws(() => drawExportItems(exported, { sample: 0, salt: 's' }), { message: 'module_arms_export_invalid' });
});

test('the registration names rows by hash order, development apart from confirmation, and the assembly takes it', async () => {
  const pool = await moduleCasePool('autopilot-planner');
  const made = round('autopilot-planner', 'autopilot-checklist', pool, { developmentCount: 6, confirmationCount: 3 });
  assert.equal(made.rows.development.length, 6);
  assert.equal(made.rows.confirmation.length, 3);
  assert.equal(new Set([...made.rows.development, ...made.rows.confirmation]).size, 9);
  assert.equal(made.groupsBelowMinimum, true, 'the 9 cases can only ever be directional');
  assert.deepEqual(made.failureSlice, ['run', 'stop']);
  assert.throws(() => round('autopilot-planner', 'autopilot-checklist', pool, { failureSlice: ['no-such-kind'] }), { message: 'campaign_registration_invalid' });
  assert.throws(() => round('autopilot-planner', 'frontier-numbers', pool), { message: 'campaign_scorer_not_qualified' });
  const drawn = drawExportItems(exportFixture(), { sample: 30, salt: 'm' }).rows;
  const edit = round('frontier-edit', 'frontier-numbers', await moduleCasePool('frontier-edit'), { drawn });
  assert.equal(edit.rows.confirmation.length, 30);
  assert.equal(edit.groupsBelowMinimum, false);
  assert.ok(edit.failureSlice.includes('export'));
});

test('--exclude-from holds on a pool round too: what an earlier round confirmed leaves both roles, what it developed on leaves the confirmation', async () => {
  const pool = await moduleCasePool('frontier-edit');
  const first = round('frontier-edit', 'frontier-numbers', pool, { developmentCount: 10, confirmationCount: 26 });
  assert.equal(first.rows.confirmation.length, 26);
  const second = round('frontier-edit', 'frontier-numbers', pool, { salt: 'another-salt', developmentCount: 10, confirmationCount: 26, exclude: { confirmation: new Set(first.rows.confirmation), development: new Set(first.rows.development) } });
  const firstConfirmation = new Set(first.rows.confirmation), firstDevelopment = new Set(first.rows.development);
  assert.deepEqual(second.rows.confirmation.filter((id) => firstConfirmation.has(id) || firstDevelopment.has(id)), [], 'none of r1\'s rows confirms again');
  assert.deepEqual(second.rows.development.filter((id) => firstConfirmation.has(id)), [], 'and what r1 confirmed is not developed on');
  // The command, from the file: the same exclusion, recorded with what it read.
  const tool = fileURLToPath(new URL('../module_arms.mjs', import.meta.url)), r1 = nextPath('r1.json'), r2 = nextPath('r2.json');
  const register = (out, salt, extra = []) => spawnSync(process.execPath, [tool, 'register', '--surface', 'frontier-edit', '--scorer', 'frontier-numbers', '--round', 'r', '--salt', salt, '--development', '10', '--confirmation', '10', ...extra, '--out', out], { encoding: 'utf8' });
  assert.equal(register(r1, 'one').status, 0);
  const done = register(r2, 'two', ['--exclude-from', r1]);
  assert.equal(done.status, 0, done.stderr);
  const [one, two] = [JSON.parse(await readChecked(r1)), JSON.parse(await readChecked(r2))];
  assert.deepEqual(two.rows.confirmation.filter((id) => one.rows.confirmation.includes(id) || one.rows.development.includes(id)), []);
  assert.deepEqual(two.rows.development.filter((id) => one.rows.confirmation.includes(id)), []);
  assert.equal(two.excludedFrom[0].sha256, sha256(await readFile(r1)));
});

test('the commands: register and draw from a gzipped export, on the file system, with no key and no network', async () => {
  const tool = fileURLToPath(new URL('../module_arms.mjs', import.meta.url));
  const exportPath = nextPath('frontier.json.gz');
  await writeFile(exportPath, gzipSync(JSON.stringify(exportFixture())));
  const drawn = spawnSync(process.execPath, [tool, 'draw', '--items-from-export', exportPath, '--sample', '30', '--salt', 'm'], { encoding: 'utf8' });
  assert.equal(drawn.status, 0, drawn.stderr);
  assert.equal(JSON.parse(drawn.stdout).groups, 30);
  assert.equal(drawn.stdout.includes('Source text'), false, 'counts only');
  const out = nextPath('round.json');
  const registered = spawnSync(process.execPath, [tool, 'register', '--surface', 'frontier-edit', '--scorer', 'frontier-numbers', '--round', 'r', '--salt', 'm', '--items-from-export', exportPath, '--sample', '30', '--out', out], { encoding: 'utf8' });
  assert.equal(registered.status, 0, registered.stderr);
  assert.equal(JSON.parse(registered.stdout).confirmation, 30);
  assert.equal(JSON.parse(registered.stdout).sealed, true, 'the operator reads it before paying for an arm');
  const written = JSON.parse(await readChecked(out));
  assert.ok(written.digest);
  assert.deepEqual([written.confirmationDraw.exportSha256, written.confirmationDraw.salt, written.confirmationDraw.sample], [sha256(await readFile(exportPath)), 'm', 30], 'what binds rows with no gold: the export, the salt');
  const refused = spawnSync(process.execPath, [tool, 'register', '--surface', 'autopilot-planner', '--scorer', 'autopilot-checklist', '--round', 'r', '--salt', 'm', '--items-from-export', exportPath, '--sample', '3', '--out', nextPath()], { encoding: 'utf8' });
  assert.equal(refused.status, 2);
  assert.equal(JSON.parse(refused.stderr).reason, 'module_arms_export_not_supported', 'an export has no expected lanes for a screen or a planner to be right about');
  const noRegistration = spawnSync(process.execPath, [tool, 'nonsense'], { encoding: 'utf8' });
  assert.equal(noRegistration.status, 2);
});

test('frontier-source: packets are blind, verdict records are bound to the judge, and the assembly reads them', async () => {
  const pool = (await moduleCasePool('frontier-edit')).filter((row) => row.id === 'toxic-supplement-recall');
  const rewrite = { scores: { impact: 10, novelty: 10, relevance: 10 }, practice: { changing: false, reason_zh: '' }, genre: 'safety', industry_kind: '', title_zh: '补充剂因毒性被召回', summary_zh: '这种补充剂被召回，生产商提醒消费者停止使用。', reason_zh: '', tags: [], lane: 'safety', specialties: [], evidence_type: 'safety-notice', entities: { drugs: [], trials: [], orgs: [], diseases: [] }, flags: [] };
  const made = await runModuleArms({ surface: 'frontier-edit', role: 'development', scorerId: 'frontier-source', rows: pool, repeats: 2, incumbent: incumbentOf('frontier-edit'), image: IMAGE, apiKey: KEY, callModel: async () => answer(rewrite) });
  const packets = fidelityPackets(made.source, { passes: 3, seed: 'seed' }), keys = JSON.parse(packets['operator/keys.json']);
  assert.equal(Object.keys(keys).length, made.source.runs.length);
  const key = Object.keys(keys)[0], packet = Object.entries(packets).filter(([path]) => path.startsWith(`${key}/pass1/`));
  assert.deepEqual(packet.map(([path]) => path.split('/').pop()).sort(), ['meta.json', 'questions.json', 'rewrite.json', 'source.txt']);
  for (const [path, text] of packet) assert.equal(/baseline|\baa\b|cand-/.test(text), false, `${path}: no arm in a packet`);
  assert.ok(packets[`${key}/pass1/source.txt`].includes('标题：'), 'the source as the writer was shown it');
  assert.ok(packets['brief.md'].includes('denominators, units, uncertainty and causal strength') && FIDELITY_BRIEF.includes('untrusted'));
  assert.match(packets['brief.md'], /kept the source's main results/, 'a rewrite that says nothing wrong by dropping what matters is not faithful: on rows with no gold only the judge pulls against that');
  const judge = judgeOf({ maxCalls: 100 }), judgeRecord = { schema: 'claude-judge/2', judge: judge.id, model: judge.model, effort: judge.effort, dialect: 'questions', briefSha256: 'b'.repeat(64) };
  const line = (packetKey, verdict) => `${JSON.stringify({ key: `${packetKey}#supported`, verdict, judge: judge.id, model: judge.model, effort: judge.effort })}\n`;
  const parts = Object.fromEntries(Object.keys(keys).flatMap((packetKey) => [1, 2, 3].map((pass) => [`${packetKey}.p${pass}.jsonl`, line(packetKey, pass === 3 ? 'incorrect' : 'correct')])));
  const { source, text } = fidelityVerdicts({ source: made.source, keys, parts, judgeRecord, judge });
  assert.equal(text.split('\n').filter(Boolean).length, made.source.runs.length * 3);
  assert.equal(source.judged.recordsFile.sha256, sha256(text));
  assert.deepEqual(harnessArmsIssues({ ...source, judged: { ...source.judged, records: text.split('\n').filter(Boolean).map((row) => JSON.parse(row)) } }, { surface: 'frontier-edit', scorer: 'frontier-source', judge }, MODULE_KIT), []);
  // Another judge's parts, a missing pass, or a line stamped otherwise is not a record.
  assert.throws(() => fidelityVerdicts({ source: made.source, keys, parts, judgeRecord: { ...judgeRecord, model: 'claude-opus-5-5' }, judge }), { message: 'harness_judge_identity_mismatch' });
  const missingPass = { ...parts };
  delete missingPass[`${key}.p3.jsonl`];
  assert.throws(() => fidelityVerdicts({ source: made.source, keys, parts: missingPass, judgeRecord, judge }), { message: 'harness_judge_verdicts_incomplete' });
  assert.throws(() => fidelityVerdicts({ source: made.source, keys, parts: { ...parts, [`${key}.p1.jsonl`]: line(key, 'correct').replace(judge.model, 'qwen3.8-max') }, judgeRecord, judge }), { message: 'harness_judge_identity_mismatch' });
  // The measurement: what a registered judge's qualification is copied from, and nothing else fills it.
  const told = JSON.stringify({ schema: 'judge-noise/2', scale: 'verdict-0-1', families: { 'frontier-source': { absolute: { form: 'absolute', scale: 'verdict-0-1', agreement: 0.95, noiseSd: 0.02, noiseBand95: 0.04 } } } });
  const { qualification, ...identity } = judge;
  const block = moduleJudgeBlock(identity, 'n.json', told);
  assert.equal(block.qualification.measuredOn, `n.json sha256:${sha256(told).slice(0, 16)} frontier-source/absolute`);
  assert.deepEqual([block.qualification.agreement, block.qualification.noiseSd, block.qualification.noiseBand95, block.qualification.form, block.qualification.scale], [0.95, 0.02, 0.04, 'absolute', 'verdict-0-1']);
  assert.throws(() => moduleJudgeBlock(identity, 'n.json', told.replace('0.95', 'null')), { message: 'campaign_judge_unqualified' }, 'a judge that never tells two rewrites apart has no agreement');
  assert.throws(() => moduleJudgeBlock(judge, 'n.json', told), { message: 'campaign_judge_unqualified' }, 'figures typed into the judge\'s file are refused');
  assert.throws(() => moduleJudgeBlock(identity, 'n.json', undefined), { message: 'campaign_judge_unqualified' }, 'no measurement, no judge');
  assert.throws(() => moduleJudgeBlock({ ...identity, form: 'pairwise' }, 'n.json', told), { message: 'campaign_judge_unqualified' }, 'a measurement of another form is not this judge\'s');
  assert.throws(() => moduleJudgeBlock(identity, 'n.json', told.replace('frontier-source', 'drb')), { message: 'campaign_judge_unqualified' }, 'nor of another family');
  const pool2 = await moduleCasePool('frontier-edit');
  assert.throws(() => round('frontier-edit', 'frontier-source', pool2), { message: 'campaign_judge_unregistered' });
  assert.throws(() => round('frontier-edit', 'frontier-numbers', pool2, { judge: block }), { message: 'campaign_judge_unexpected' });
  assert.throws(() => round('frontier-edit', 'frontier-source', pool2, { judge: { ...block, maxCalls: 1 } }), { message: 'campaign_judge_budget_below_registration' });
  assert.equal(round('frontier-edit', 'frontier-source', pool2, { judge: { ...block, maxCalls: 5000 } }).judge.id, judge.id);
});

test('the operator\'s whole judged path on files: claude_judge.py takes the packets, its parts remap, noise_sample.py measures them, register copies that, the records validate', async () => {
  const tools = fileURLToPath(new URL('../../public-benchmarks/tools/', import.meta.url)), python = (...args) => spawnSync('python3', ['-I', ...args], { encoding: 'utf8' });
  const pool = (await moduleCasePool('frontier-edit')).filter((row) => ['toxic-supplement-recall', 'food-recall-flour'].includes(row.id));
  const made = await runModuleArms({ surface: 'frontier-edit', role: 'development', scorerId: 'frontier-source', rows: pool, repeats: 2, incumbent: incumbentOf('frontier-edit'), image: IMAGE, apiKey: KEY, callModel: async () => answer({ scores: { impact: 10, novelty: 10, relevance: 10 }, practice: { changing: false, reason_zh: '' }, genre: 'safety', industry_kind: '', title_zh: '产品被召回', summary_zh: '这种产品被召回。', reason_zh: '', tags: [], lane: 'safety', specialties: [], evidence_type: 'safety-notice', entities: { drugs: [], trials: [], orgs: [], diseases: [] }, flags: [] }) });
  const dir = await mkdtemp(join(scratch, 'judged-')), packets = join(dir, 'packets'), files = fidelityPackets(made.source, { passes: 2, seed: 'seed' });
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(packets, path)), { recursive: true }); await writeFile(join(packets, path), text); }
  // The real judge runner over a stand-in CLI: its parser accepts the packets as they are, one verdict per packet and pass, and it records the judge.
  const fakeState = join(dir, 'fake'), parts = join(dir, 'parts');
  await mkdir(fakeState, { recursive: true });
  const judged = spawnSync('python3', ['-I', join(tools, 'claude_judge.py'), 'judge', packets, '--model', 'claude-sonnet-5-5', '--effort', 'medium', '--judge-id', 'claude-fidelity-test', '--dialect', 'questions', '--brief', join(packets, 'brief.md'), '--parts', parts,
    '--claude', join(tools, 'test/fake_claude_judge.py'), '--retry-wait', '0', '--concurrency', '2'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, FAKE_JUDGE_STATE: fakeState, FAKE_JUDGE_LOG: join(dir, 'fake.log') } });
  assert.equal(judged.status, 0, judged.stderr);
  const keys = JSON.parse(files['operator/keys.json']);
  const judgeRecord = JSON.parse(await readFile(join(parts, 'judge.json'), 'utf8'));
  assert.equal((await readdir(parts)).filter((name) => name.endsWith('.jsonl')).length, Object.keys(keys).length * 2);
  // Verdicts that tell the rewrites apart, in the bytes the runner wrote: a stand-in has no opinion.
  const order = Object.keys(keys).sort();
  for (const [at, key] of order.entries()) for (const pass of [1, 2]) {
    const path = join(parts, `${key}.p${pass}.jsonl`), row = JSON.parse((await readFile(path, 'utf8')).trim());
    await writeFile(path, `${JSON.stringify({ ...row, verdict: at % 3 === 0 || (at === 1 && pass === 1) ? 'correct' : 'incorrect' })}\n`);
  }
  const noiseDir = join(dir, 'noise');
  await mkdir(noiseDir, { recursive: true });
  await writeFile(join(packets, 'operator', 'keys.json'), JSON.stringify(keys));
  const remapped = python(join(tools, 'claude_judge.py'), 'remap', '--keys', join(packets, 'operator', 'keys.json'), '--parts', parts, '--dialect', 'questions', '--bench-key', 'frontier-source', '--repeats', '2', '--out', join(noiseDir, 'frontier-source'));
  assert.equal(remapped.status, 0, remapped.stderr);
  const band = python(join(tools, 'noise_sample.py'), 'band', '--verdicts', noiseDir, '--out', join(dir, 'judge-noise.json'));
  assert.equal(band.status, 0, band.stderr);
  const python_ = JSON.parse(await readFile(join(dir, 'judge-noise.json'), 'utf8')).families['frontier-source'].absolute;
  assert.equal(python_.units, order.length, 'one unit per rewrite: the repeat in a remapped key keeps them apart');
  assert.ok(Number.isFinite(python_.agreement) && python_.noiseSd > 0);
  const partsText = {};
  for (const name of await readdir(parts)) if (name.endsWith('.jsonl')) partsText[name] = await readFile(join(parts, name), 'utf8');
  // The measurement registers the judge; the records of the same parts join the source.
  const judge = { id: 'claude-fidelity-test', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium', form: 'absolute', passes: 2, maxCalls: 100 };
  const block = moduleJudgeBlock(judge, 'judge-noise.json', await readFile(join(dir, 'judge-noise.json'), 'utf8'));
  assert.equal(block.qualification.noiseSd, python_.noiseSd);
  const verdicts = fidelityVerdicts({ source: made.source, keys, parts: partsText, judgeRecord, judge: block });
  assert.deepEqual(harnessArmsIssues({ ...verdicts.source, judged: { ...verdicts.source.judged, records: verdicts.text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) } }, { surface: 'frontier-edit', scorer: 'frontier-source', judge: block }, MODULE_KIT), []);
});

test('a whole assembly from the arms\' own outputs: a directional planner campaign on the 9 cases, fake model, real validation', async () => {
  const pool = await moduleCasePool('autopilot-planner');
  const registered = round('autopilot-planner', 'autopilot-checklist', pool, { developmentCount: 6, confirmationCount: 3 });
  const byId = new Map(pool.map((row) => [row.id, row]));
  const text = 'The planner text a Claude session wrote.', candidates = [{ title: 't', policy: { plannerInstructions: text } }];
  const shared = { surface: 'autopilot-planner', scorerId: 'autopilot-checklist', incumbent: incumbentOf('autopilot-planner'), image: IMAGE, apiKey: KEY, candidates, callModel: plannerModel({ decide: (context, call) => (call.body.messages[0].content.startsWith(text) ? { action: 'stop', stopKind: 'answered', reason: 'r' } : { action: 'run', taskType: context.taskTypes[0].id, focus: 'f', reason: 'r' }) }) };
  const development = await runModuleArms({ ...shared, role: 'development', rows: registered.rows.development.map((id) => byId.get(id)), repeats: registered.repeats.development });
  const confirmation = await runModuleArms({ ...shared, role: 'confirmation', rows: registered.rows.confirmation.map((id) => byId.get(id)), repeats: registered.repeats.confirmation });
  const built = await buildHarnessCampaign({ development: development.source, confirmation: confirmation.source, confirmationGold: confirmation.gold, registration: registered, month: '2026-11', pilotRationale: 'Fake model, real validation.', now: '2026-10-26T00:00:00Z', improvement: improvementOf() });
  assert.equal(built.manifest.surface, 'autopilot-planner');
  assert.equal(built.manifest.candidateKind, 'policy');
  assert.equal(built.manifest.target.baselineRevision, shared.incumbent.revisionId);
  assert.equal(built.manifest.target.dependencyDigest, IMAGE.digest);
  assert.equal(built.supply.directional, true, 'fewer than 25 confirmation groups');
  assert.deepEqual(built.manifest.models.solver, { provider: 'deepseek', model: 'deepseek-flash' });
  assert.deepEqual(built.manifest.models.improvers, improvementOf().improvers);
  assert.equal(built.inputs.registration.statistics.cost_identity, 'operator-box-reference-price-cny');
  assert.ok(built.inputs.sources['confirmation-2026-11'].rows.every((row) => row.gold), 'the assembly joined the gold');
});
