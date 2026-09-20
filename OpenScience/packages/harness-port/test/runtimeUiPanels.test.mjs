// The 运行 view and the right column's single 文件 tab: what each draws from
// the shell's run state and evidence, how they register, and when the column
// opens on its own.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apply, artifactKind, artifactModel, BODY, evidenceModel, panelTabs, progressModel, runStateText, runViewTab, sourcesModel,
} from '../src/runtimeUiPanels.mjs';
import { fakeCtx, fakeTarget, kernelSlots, kitFor, renderStatic } from './helpers/frameFakes.mjs';

const CAPABILITIES = [{ id: 'clinical-evidence-synthesis', title: '临床证据综合', category: '证据综合', brief: 'b' }];

function kit() {
  const target = fakeTarget({ frame: { capabilities: CAPABILITIES } });
  return kitFor(fakeCtx(), target);
}

const LIVE = {
  runId: 'run-1', sessionId: 'session-a', state: 'running', title: '老年房颤抗凝',
  artifacts: [],
  unverifiedArtifacts: [],
  progress: {
    deliverables: [
      { id: 'evidence', title: '老年房颤抗凝证据综述', capability: 'clinical-evidence-synthesis', status: 'rejected', attempts: 2, lastVerdict: 'issues', mustFixCount: 3, childSessionId: 'child-1' },
      { id: 'brief', title: '临床决策简报', status: 'planned', attempts: 0 },
    ],
    phaseCounts: { search: 4, screen: 2, fulltext: 1, claims: 0, write: 0, deliver: 0 },
    currentPhase: 'screen',
    sources: { searched: 120, included: 18, fullText: 6 },
    claims: { total: 0, verified: 0 },
    children: [{ childSessionId: 'child-1', deliverableId: 'evidence', state: 'running', lastActivityAt: null }],
    usage: { requests: 40, inputTokens: 1, cachedInputTokens: 1, outputTokens: 1, costCny: 0.4218 },
    startedAt: new Date(1_000_000).toISOString(),
    updatedAt: new Date(1_300_000).toISOString(),
  },
};

const EVIDENCE = {
  runId: 'run-1',
  reportPath: 'deliverables/evidence/clinical-evidence-report.md',
  claims: [
    { claimId: 'CLM-001', claim: '利伐沙班降低卒中风险。', claimType: 'direct', status: 'verified', sourceTitle: 'ROCKET AF' },
    { claimId: 'CLM-002', claim: '老年患者大出血风险相近。', claimType: 'direct', status: 'quote_not_found', sourceTitle: 'ARISTOTLE' },
    { claimId: 'CLM-003', claim: '换算 NNT 约为 90。', claimType: 'derived', status: 'derived' },
  ],
  sources: [
    { title: 'ROCKET AF', identifier: 'PMID:21830957', url: 'https://pubmed.ncbi.nlm.nih.gov/21830957/', sourceType: 'rct', claims: 1 },
    { title: '2023 ACC/AHA 房颤指南', sourceType: 'guideline', claims: 2, url: 'javascript:alert(1)' },
  ],
};

test('one tab type, because a second guide entry replaces the column with the kernel compass', () => {
  assert.deepEqual(panelTabs().map((tab) => tab.title), ['文件']);
  assert.deepEqual(runViewTab(), { id: 'evimed-run', label: '运行', order: 5 });
  assert.deepEqual(runStateText({ state: 'running' }), { text: '进行中', tone: 'active' });
  assert.deepEqual(runStateText({ state: 'succeeded', verification: 'unverified' }), { text: '已交付 · 有结论未逐字核对', tone: 'warn' });
  assert.deepEqual(runStateText({ state: 'canceled' }), { text: '已停止', tone: 'muted' });
});

test('a delivered file is named by what the contract calls it', () => {
  assert.equal(artifactKind('deliverables/evidence/clinical-evidence-report.md').label, '报告');
  assert.equal(artifactKind('deliverables/evidence/clinical-evidence-matrix.json').label, '证据表');
  assert.equal(artifactKind('deliverables/evidence/revision-notes.md').label, '修订说明');
  assert.equal(artifactKind('deliverables/brief/summary.docx').label, '文档');
  assert.equal(artifactKind('deliverables/brief/data.csv').label, '文件');
});

test('the run view reads the run: phases reached, counts, cost and each piece of work', () => {
  const model = /** @type {any} */ (progressModel(LIVE, 1_000_000 + 125_000, kit()));
  assert.equal(model.title, '老年房颤抗凝');
  assert.equal(model.state.text, '进行中');
  assert.equal(model.elapsed, '2 分 05 秒');
  assert.equal(model.cost, '约 ¥0.42');
  // Only phases something happened in, and 「当前」 is the furthest reached —
  // not whichever labelled call happened to be last.
  assert.deepEqual(model.phases.map((/** @type {any} */ phase) => `${phase.label}${phase.count}${phase.current ? '*' : ''}`), ['检索4', '筛选2', '全文1*']);
  assert.equal(model.sources, '检索 120 次 · 纳入 18 篇 · 全文 6 篇');
  assert.equal(model.claims, null, 'no conclusions yet says nothing rather than 「结论 0 条」');
  assert.deepEqual(model.deliverables.map((/** @type {any} */ item) => [item.title, item.status, item.childState, item.attempts, item.verdict?.text ?? null, item.childSessionId]), [
    ['老年房颤抗凝证据综述', '需修改', '进行中', 2, '⚠ 3 项需核对', 'child-1'],
    ['临床决策简报', '待开始', null, 0, null, null],
  ]);
  assert.equal(progressModel(null, 0, kit()), null);
  // A finished run's duration stops at its last update.
  const done = /** @type {any} */ (progressModel({ ...LIVE, state: 'succeeded' }, 9_999_999_999, kit()));
  assert.equal(done.elapsed, '5 分 00 秒');
});

test('the files group by the piece of work that wrote them, and say which were not checked', () => {
  const live = { ...LIVE, artifacts: ['deliverables/evidence/clinical-evidence-matrix.json', 'deliverables/evidence/clinical-evidence-report.md', 'notes.md'],
    unverifiedArtifacts: ['deliverables/brief/clinical-decision-brief.md', 'deliverables/evidence/clinical-evidence-report.md'] };
  const model = /** @type {any} */ (artifactModel(live));
  assert.equal(model.produced, true);
  assert.deepEqual(model.groups.map((/** @type {any} */ group) => [group.title, group.files.map((/** @type {any} */ file) => `${file.label}:${file.name}:${file.verified ? '✓' : '·'}`)]), [
    ['老年房颤抗凝证据综述', ['报告:clinical-evidence-report.md:✓', '证据表:clinical-evidence-matrix.json:✓']],
    ['其他文件', ['文档:notes.md:✓']],
    ['临床决策简报', ['文档:clinical-decision-brief.md:·']],
  ]);
  assert.equal(/** @type {any} */ (artifactModel(LIVE)).produced, false);
});

test('each conclusion carries what the check found, and only for the run on screen', () => {
  const model = /** @type {any} */ (evidenceModel(EVIDENCE, LIVE));
  assert.equal(model.summary, '3 条结论：✓ 1 条已核对，⚠ 1 条待核对');
  assert.deepEqual(model.claims.map((/** @type {any} */ claim) => [claim.mark, claim.text, claim.statusText]), [
    ['✓', '利伐沙班降低卒中风险。', '引文已在保存的原文中核对'],
    ['⚠', '老年患者大出血风险相近。', '引文未在保存的原文中找到'],
    ['·', '换算 NNT 约为 90。', '推算结果，本身没有引文'],
  ]);
  assert.equal(evidenceModel({ ...EVIDENCE, runId: 'run-0' }, LIVE), null, 'evidence of an earlier run is not this run');
});

test('the cited sources carry their type and only web links', () => {
  const model = sourcesModel(EVIDENCE, LIVE, kit());
  assert.deepEqual(model.sources.map((/** @type {any} */ source) => [source.title, source.type, source.identifier, source.url]), [
    ['ROCKET AF', 'RCT', 'PMID:21830957', 'https://pubmed.ncbi.nlm.nih.gov/21830957/'],
    ['2023 ACC/AHA 房颤指南', '指南', null, null],
  ]);
});

/** A frame with the right column's two services. */
function column({ failFirstOpen = false } = {}) {
  /** @type {any[]} */
  const definitions = [];
  /** @type {string[]} */
  const opened = [];
  let failures = failFirstOpen ? 1 : 0;
  const ctx = fakeCtx({
    slots: kernelSlots(),
    sessions: { list: { getSnapshot: () => ({ current: 'session-a', subagentsByParent: {} }), subscribe: () => () => {} }, refreshSubagents() {}, openSubagent() {} },
    sidebarRightTabs: { register(/** @type {any} */ definition) { definitions.push(definition); return () => {}; } },
    sidebarRight: { openTab(/** @type {string} */ kind) { if (failures > 0) { failures--; throw new Error('no seat mounted'); } opened.push(kind); } },
  });
  const target = fakeTarget({ frame: { capabilities: CAPABILITIES } });
  const frameKit = kitFor(ctx, target);
  apply(ctx, {}, target, undefined, frameKit);
  frameKit.hub.deliver('session', { sessionId: 'session-a' });
  return { ctx, target, kit: frameKit, definitions, opened };
}

test("运行 registers in the view ring beside 对话, and 文件 is the column's only guide entry", () => {
  const f = column();
  assert.deepEqual(f.definitions.map((definition) => [definition.id, definition.kind, definition.priority, definition.title(), definition.guide[0].title()]), [
    ['evimed-files', 'evimed-files', 'extension', '文件', '文件'],
  ]);
  assert.equal(f.definitions.reduce((sum, definition) => sum + definition.guide.length, 0), 1,
    'exactly one guide entry: zero or several make the column open the kernel 「开始」 compass instead');
  const bodies = f.ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.name === 'sidebar.right.pane.tab');
  assert.deepEqual(bodies.map((/** @type {any} */ entry) => entry.options.key), ['evimed-files']);
  const views = f.ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.name === 'conversation.view');
  assert.deepEqual(views.map((/** @type {any} */ entry) => [entry.options.id, entry.options.order, entry.options.label()]), [['evimed-run', 5, '运行']]);
  assert.deepEqual(f.target.warnings, []);
  assert.equal(BODY.name, 'panels');
});

test('文件 opens when a report appears while the reader watches, not on a visit to a finished task', () => {
  const watching = column();
  watching.kit.hub.deliver('run-state', { ...LIVE, state: 'running', progress: { ...LIVE.progress, children: [], deliverables: [] } });
  assert.deepEqual(watching.opened, []);
  watching.kit.hub.deliver('run-state', { ...LIVE, state: 'succeeded', artifacts: ['deliverables/evidence/clinical-evidence-report.md'] });
  assert.deepEqual(watching.opened, ['evimed-files']);
  watching.kit.hub.deliver('run-state', { ...LIVE, state: 'succeeded', updatedAt: 'later', artifacts: ['deliverables/evidence/clinical-evidence-report.md'] });
  assert.deepEqual(watching.opened, ['evimed-files'], 'once per run');
  const visiting = column();
  visiting.kit.hub.deliver('run-state', { ...LIVE, state: 'succeeded', artifacts: ['deliverables/evidence/clinical-evidence-report.md'] });
  assert.deepEqual(visiting.opened, [], 'a finished task already has its files; the column does not jump out');
});

test('the column retries its open while no seat is mounted', () => {
  const f = column({ failFirstOpen: true });
  f.kit.hub.deliver('run-state', { ...LIVE, state: 'running', artifacts: [] });
  assert.deepEqual(f.opened, []);
  f.kit.hub.deliver('run-state', { ...LIVE, artifacts: ['deliverables/evidence/clinical-evidence-report.md'] });
  assert.deepEqual(f.opened, [], 'the first open had no seat');
  f.kit.hub.deliver('run-state', { ...LIVE, updatedAt: 'later', artifacts: ['deliverables/evidence/clinical-evidence-report.md'] });
  assert.deepEqual(f.opened, ['evimed-files']);
});

test('both surfaces render Chinese, with an honest empty state before anything exists', () => {
  const f = column();
  const view = f.ctx.slots.registrations.find((/** @type {any} */ entry) => entry.name === 'conversation.view').component;
  const files = f.ctx.slots.registrations.find((/** @type {any} */ entry) => entry.name === 'sidebar.right.pane.tab').component;
  assert.match(renderStatic(view), /这次对话还没有研究任务/);
  assert.match(renderStatic(files), /还没有产出文件/);
  f.kit.hub.deliver('run-state', { ...LIVE, artifacts: ['deliverables/evidence/clinical-evidence-report.md'] });
  f.kit.hub.deliver('evidence', EVIDENCE);
  const run = renderStatic(view);
  assert.match(run, /老年房颤抗凝证据综述/);
  assert.match(run, /筛选 2/);
  assert.match(run, /查看子任务/);
  assert.match(run, /3 条结论：✓ 1 条已核对，⚠ 1 条待核对/);
  assert.match(run, /ROCKET AF/);
  assert.doesNotMatch(run, /javascript:/);
  assert.doesNotMatch(run, /核验 0|撰写 0|交付 0/, 'a phase nothing happened in is not a row');
  const column1 = renderStatic(files);
  assert.match(column1, /报告/);
  assert.match(column1, /打开/);
});
