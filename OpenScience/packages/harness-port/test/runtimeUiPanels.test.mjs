// The delivery card above the composer and the right column opening on the
// kernel's own file tree: what the card draws from the shell's run state and
// evidence, where it sits, and when the column opens on its own. The product's
// own 运行 view and 文件 tab left on 2026-09-22 for the kernel's trajectory
// view and file tree.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apply, artifactKind, artifactModel, BODY, composerColumnStyle, deliveryModel, evidenceModel, KERNEL_FILES_TAB, runStateText,
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
    // What the control plane sends since it decides both: the phases reached,
    // in order, and the furthest of them.
    reachedPhases: ['search', 'screen', 'fulltext'],
    currentPhase: 'fulltext',
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

test('the run is read in the words every surface uses for it', () => {
  assert.equal(KERNEL_FILES_TAB, 'files', "the kernel's own file-tree tab, which stays the column's only guide entry");
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
  assert.deepEqual(artifactKind('deliverables/results/reporting-checklist.md'), { kind: 'document', label: '报告规范清单' },
    'a completed reporting checklist is named for what it is, never taken for the report');
});

test('the card opens the section a checklist lists, not the checklist', () => {
  // manuscript-support delivers `manuscript-section.md` beside its CONSORT
  // checklist; only the checklist's name contains `report`.
  const delivered = { ...LIVE, state: 'succeeded',
    artifacts: ['deliverables/results/reporting-checklist.md', 'deliverables/results/manuscript-section.md', 'deliverables/evidence/clinical-evidence-report.md'] };
  const model = /** @type {any} */ (deliveryModel(delivered, null, 9_999_999_999, kit()));
  assert.equal(model.reportPath, 'deliverables/evidence/clinical-evidence-report.md');
  const onlySection = /** @type {any} */ (deliveryModel({ ...delivered, artifacts: ['deliverables/results/reporting-checklist.md', 'deliverables/results/manuscript-section.md'] }, null, 9_999_999_999, kit()));
  assert.equal(onlySection, null, 'with no report and no claims there is no card to show, and the checklist does not stand in for one');
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

test("nothing of the product's is registered in the view ring or as a column tab: both are the kernel's", () => {
  const f = column();
  assert.deepEqual(f.definitions, [], 'no tab type: a second guide entry would turn the column into the kernel 「开始」 compass');
  assert.deepEqual(f.ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.name === 'sidebar.right.pane.tab'), []);
  assert.deepEqual(f.ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.name === 'conversation.view'), [],
    "the kernel's trajectory view is the 运行 tab (relabelled by the language pack)");
  assert.deepEqual(f.target.warnings, []);
  assert.equal(BODY.name, 'panels');
});

test("the kernel's file tree opens when a report appears while the reader watches, not on a visit to a finished task", () => {
  const watching = column();
  watching.kit.hub.deliver('run-state', { ...LIVE, state: 'running', progress: { ...LIVE.progress, children: [], deliverables: [] } });
  assert.deepEqual(watching.opened, []);
  watching.kit.hub.deliver('run-state', { ...LIVE, state: 'succeeded', artifacts: ['deliverables/evidence/clinical-evidence-report.md'] });
  assert.deepEqual(watching.opened, ['files']);
  watching.kit.hub.deliver('run-state', { ...LIVE, state: 'succeeded', updatedAt: 'later', artifacts: ['deliverables/evidence/clinical-evidence-report.md'] });
  assert.deepEqual(watching.opened, ['files'], 'once per run');
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
  assert.deepEqual(f.opened, ['files']);
});

test('a finished run says so at the end of the turn that delivered it', () => {
  const delivered = { ...LIVE, state: 'succeeded', verification: 'unverified',
    artifacts: ['deliverables/evidence/clinical-evidence-report.md', 'deliverables/evidence/clinical-evidence-matrix.json'] };
  const model = /** @type {any} */ (deliveryModel(delivered, EVIDENCE, 9_999_999_999, kit()));
  assert.equal(model.state.text, '已交付 · 有结论未逐字核对');
  assert.equal(model.title, '老年房颤抗凝');
  assert.equal(model.reportPath, 'deliverables/evidence/clinical-evidence-report.md');
  assert.equal(model.claims, '结论 3 条，已核对 1 条，2 条待核对');
  assert.equal(model.fileCount, 2);
  assert.equal(model.attention, 1);
  assert.equal(model.elapsed, '5 分 00 秒');
  assert.equal(model.cost, '约 ¥0.42');
  assert.equal(deliveryModel(LIVE, EVIDENCE, 0, kit()), null, 'a running run has nothing to hand back yet');
  assert.equal(deliveryModel({ ...LIVE, state: 'succeeded' }, null, 0, kit()), null, 'neither has one that produced nothing');
});

test('the card sits above the composer, once, and says nothing before there is anything to hand back', () => {
  const f = column();
  const entry = f.ctx.slots.registrations.find((/** @type {any} */ item) => item.name === 'conversation.input.dock' && item.options.id === 'evimed-delivery');
  assert.ok(entry, 'one seat, in the list above the composer');
  assert.equal(renderStatic(entry.component), '', 'a conversation with no finished run says nothing');
  f.kit.hub.deliver('run-state', { ...LIVE, state: 'succeeded', artifacts: ['deliverables/evidence/clinical-evidence-report.md'] });
  f.kit.hub.deliver('evidence', EVIDENCE);
  const card = renderStatic(entry.component);
  assert.match(card, /打开报告/);
  assert.match(card, /结论 3 条，已核对 1 条/);
  assert.match(card, /引用前请在报告里核对带 ⚠ 的结论/);
  assert.match(card, /收起/);
  assert.doesNotMatch(card, /javascript:/);
  // The seat above the composer spans the frame; the card holds itself to
  // the composer's own centred width, as the kernel's queue dock does, or it
  // sits at the left edge beside a centred composer (2026-09-22).
  assert.match(card, /max-width:calc\(var\(--dsh-composer-card-max-width, ?952px\) - 2 \* var\(--dsh-composer-dock-inset, ?8px\)\)/);
  assert.match(card, /margin:0 auto/);
  assert.equal(composerColumnStyle().margin, '0 auto');
});
