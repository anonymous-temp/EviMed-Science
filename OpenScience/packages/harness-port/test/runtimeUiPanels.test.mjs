// What a finished run hands back, in the conversation: its files as cards
// after the answer that delivered them (and nothing above the composer), and
// the right column opening on the kernel's own file tree. The product's own
// 运行 view and 文件 tab left on 2026-09-22; the delivery card above the
// composer on 2026-09-23.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  apply, BODY, documentNameOf, fileAddress, fileCardsModel, fileTypeOf, formatBytes, hasReport, KERNEL_FILES_TAB, turnCarriesRun,
} from '../src/runtimeUiPanels.mjs';
import { apply as applyReplyChecks } from '../src/runtimeUiReplyChecks.mjs';
import { fakeCtx, fakeTarget, kernelSlots, kitFor, realReact, renderStatic } from './helpers/frameFakes.mjs';

const TURN_START = Date.parse('2026-09-22T10:00:00.000Z');
const TURN_END = Date.parse('2026-09-22T10:25:00.000Z');
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

const DELIVERED = {
  runId: 'run-1', sessionId: 'session-a', state: 'succeeded', verification: 'unverified', title: '老年房颤抗凝',
  artifacts: ['deliverables/evidence/reporting-checklist.md', 'deliverables/evidence/clinical-evidence-matrix.json', 'deliverables/evidence/clinical-evidence-report.md', 'deliverables/evidence/screening.xlsx'],
  unverifiedArtifacts: ['deliverables/evidence/revision-notes.md', 'deliverables/evidence/clinical-evidence-report.md', '../escape.md', '/etc/passwd'],
  progress: {
    deliverables: [{ id: 'evidence', title: '老年房颤抗凝证据综述', status: 'accepted', attempts: 2 }],
    claims: { total: 15, verified: 15 },
    usage: { costCny: 4.81 },
    startedAt: iso(TURN_START + 2_000),
    updatedAt: iso(TURN_END + 20_000),
  },
};

test('a delivered file is named by its type, and sorts the report first', () => {
  assert.equal(KERNEL_FILES_TAB, 'files', "the kernel's own file-tree tab, which stays the column's only guide entry");
  assert.deepEqual(fileTypeOf('deliverables/evidence/clinical-evidence-report.md'), { name: 'clinical-evidence-report.md', type: 'Markdown', icon: 'doc', rank: 0 });
  assert.deepEqual(fileTypeOf('deliverables/evidence/clinical-evidence-matrix.json'), { name: 'clinical-evidence-matrix.json', type: 'JSON', icon: 'data', rank: 1 });
  // A completed reporting checklist matches `report` and is not the report.
  assert.equal(fileTypeOf('deliverables/section/reporting-checklist.md').rank, 2);
  assert.equal(fileTypeOf('deliverables/study/feasibility-matrix.md').rank, 2, 'only a matrix table is the evidence table');
  assert.equal(fileTypeOf('deliverables/brief/summary.docx').type, 'Word');
  assert.equal(fileTypeOf('a/screening.xlsx').type, 'Excel');
  assert.equal(fileTypeOf('a/figure.png').type, '图片');
  assert.equal(fileTypeOf('a/Makefile').type, '文件');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(24_576), '24 KB');
  assert.equal(formatBytes(3 * 1024 * 1024 + 200_000), '3.2 MB');
  assert.equal(formatBytes(undefined), null, 'a size the backend did not report is not a size');
  assert.equal(fileAddress('session-a', 'deliverables/证据 表.md'), 'dsh-resource://file/session/session-a/deliverables/%E8%AF%81%E6%8D%AE%20%E8%A1%A8.md');
});

test('the cards are the run\'s files once it finished — accepted or not, each once, never a path that climbs', () => {
  const model = /** @type {any} */ (fileCardsModel(DELIVERED));
  assert.equal(model.runId, 'run-1');
  assert.deepEqual(model.files.map((/** @type {any} */ file) => [file.path, file.label]), [
    ['deliverables/evidence/clinical-evidence-report.md', '证据分析报告'],
    ['deliverables/evidence/clinical-evidence-matrix.json', '证据矩阵'],
    ['deliverables/evidence/reporting-checklist.md', '报告规范清单'],
    ['deliverables/evidence/screening.xlsx', 'screening.xlsx'],
  ], 'report, evidence table, the rest, each by the name the reader gives it; revision notes are backstage and stay in the file tree');
  assert.equal(fileCardsModel({ ...DELIVERED, state: 'running' }), null, 'a running run has nothing to hand back yet');
  assert.equal(fileCardsModel({ ...DELIVERED, artifacts: [], unverifiedArtifacts: [] }), null, 'neither has one that wrote nothing');
  assert.ok(fileCardsModel({ ...DELIVERED, state: 'failed' }), 'a failed run keeps what it wrote');
  assert.equal(hasReport(DELIVERED), true);
  assert.equal(hasReport({ artifacts: ['a/screening.xlsx'] }), false);
});

test('a completed reporting checklist is never taken for the report: it follows the section it lists', () => {
  // manuscript-support delivers `manuscript-section.md` beside its CONSORT
  // checklist; only the checklist's name contains `report`.
  const delivered = { ...DELIVERED, artifacts: ['deliverables/results/reporting-checklist.md', 'deliverables/results/manuscript-section.md'], unverifiedArtifacts: [] };
  assert.deepEqual(/** @type {any} */ (fileCardsModel(delivered)).files.map((/** @type {any} */ file) => file.label), ['论文章节', '报告规范清单']);
  assert.equal(hasReport(delivered), false, 'a checklist alone does not open the file tree as a report would');
  const withReport = { ...delivered, artifacts: [...delivered.artifacts, 'deliverables/evidence/clinical-evidence-report.md'] };
  assert.equal(/** @type {any} */ (fileCardsModel(withReport)).files[0].label, '证据分析报告');
});

test('two deliverables of one kind are the lead cards, each saying its folder; the delivery summaries wait behind the fold', () => {
  // Production, 2026-09-24 (run_cfb13f0e): a manuscript run with two
  // deliverables showed three 「交付摘要」 and one 「论文章节」 as its cards.
  const artifacts = ['consort-checklist', 'ms-methods-results'].flatMap((id) => ['citation-ledger.csv', 'delivery-summary.md', 'manuscript-section.md', 'reporting-checklist.md', 'revision-notes.md', 'section-claims.json']
    .map((file) => `deliverables/${id}/${file}`)).concat('delivery-summary.md');
  const model = /** @type {any} */ (fileCardsModel({ ...DELIVERED, artifacts, unverifiedArtifacts: [] }));
  assert.deepEqual(model.files.slice(0, 4).map((/** @type {any} */ file) => [file.label, file.where]), [
    ['论文章节', 'consort-checklist'], ['论文章节', 'ms-methods-results'],
    ['报告规范清单', 'consort-checklist'], ['报告规范清单', 'ms-methods-results'],
  ]);
  assert.ok(model.files.filter((/** @type {any} */ file) => file.label === '交付摘要').every((/** @type {any} */ file) => file.rank > 4), 'a summary is not one of the readable lead cards');
  assert.equal(model.files.find((/** @type {any} */ file) => file.path === 'delivery-summary.md').where, null, 'a file at the root has no folder to say');
  assert.equal(/** @type {any} */ (fileCardsModel(DELIVERED)).files.every((/** @type {any} */ file) => file.where === null), true, 'a name used once needs no folder');
});

test("a card names a document exactly as the shell's reader does, from a table held equal to the shell's", async () => {
  // The frame's copy exists because a body may import nothing; this is what
  // keeps it from drifting from `apps/web/src/lib/artifactNames.ts`.
  const source = await readFile(new URL('../../../apps/web/src/lib/artifactNames.ts', import.meta.url), 'utf8');
  const table = source.slice(source.indexOf('DOCUMENT_NAMES'), source.indexOf('});', source.indexOf('DOCUMENT_NAMES')));
  const shell = [...table.matchAll(/^\s*"([^"]+)":\s*"([^"]+)",?\s*$/gm)].map((match) => [match[1], match[2]]);
  assert.ok(shell.length >= 20, `only ${shell.length} names were read from the shell's table; the parse walked nothing`);
  for (const [file, name] of shell) assert.equal(documentNameOf(`deliverables/x/${file}`), name, `${file}`);
  // And nothing the shell does not name.
  const frame = BODY.parts.find((part) => part.name === 'documentNameOf')?.toString() ?? '';
  const named = [...frame.matchAll(/'([^']+\.[a-z]+)': '/g)].map((match) => match[1]);
  assert.deepEqual(named.sort(), shell.map(([file]) => file).sort());
  assert.equal(documentNameOf('deliverables/x/screening.xlsx'), null, 'a file with no document name keeps its own');
});

test('a turn carries the run when it began before the run finished and ended after it began', () => {
  assert.equal(turnCarriesRun({ start: TURN_START, end: TURN_END }, DELIVERED), true);
  assert.equal(turnCarriesRun({ start: TURN_END + 10 * 60_000, end: TURN_END + 11 * 60_000 }, DELIVERED), false, 'a later question');
  assert.equal(turnCarriesRun({ start: TURN_START - 60 * 60_000, end: TURN_START - 50 * 60_000 }, DELIVERED), false, 'an earlier one');
  assert.equal(turnCarriesRun({}, DELIVERED), true, 'a time neither side knows does not decide');
});

/** A kernel whose answer row is a real component, so what is drawn around it can be seen. */
function kernel() {
  const slots = kernelSlots();
  const { React } = realReact();
  const KernelAnswer = (/** @type {any} */ props) => React.createElement('div', { 'data-kernel-answer': props.node.data.finalNode?.seq ?? 'streaming' }, 'answer');
  const shipped = /** @type {any} */ (slots.registrations.find((/** @type {any} */ entry) => entry.name === 'conversation.chat.node' && entry.options.key === 'assistant-step'));
  shipped.component = KernelAnswer;
  return slots;
}

/**
 * A frame with the right column's two services, and the bodies named.
 * @param {{ failFirstOpen?: boolean, replyChecks?: boolean }} [options]
 */
function column({ failFirstOpen = false, replyChecks = false } = {}) {
  /** @type {any[]} */
  const definitions = [];
  /** @type {string[]} */
  const opened = [];
  let failures = failFirstOpen ? 1 : 0;
  const ctx = fakeCtx({
    slots: kernel(),
    sessions: { list: { getSnapshot: () => ({ current: 'session-a', subagentsByParent: {} }), subscribe: () => () => {} }, refreshSubagents() {}, openSubagent() {} },
    sidebarRightTabs: { register(/** @type {any} */ definition) { definitions.push(definition); return () => {}; } },
    sidebarRight: { openTab(/** @type {string} */ kind) { if (failures > 0) { failures--; throw new Error('no seat mounted'); } opened.push(kind); } },
  });
  const target = fakeTarget();
  const frameKit = kitFor(ctx, target);
  /** @type {any[]} */
  const sent = [];
  frameKit.hub.attach((/** @type {string} */ type, /** @type {any} */ fields) => { sent.push([type, fields]); });
  if (replyChecks) applyReplyChecks(ctx, {}, target, undefined, frameKit);
  apply(ctx, {}, target, undefined, frameKit);
  frameKit.hub.deliver('session', { sessionId: 'session-a' });
  const answerRow = () => ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.name === 'conversation.chat.node' && entry.options.key === 'assistant-step')
    .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0];
  return { ctx, target, kit: frameKit, definitions, opened, sent, answerRow };
}

/**
 * The props the chat hands an answer row: the node, and the slot's own hooks
 * — the turn's published tail, the chat snapshot, the kernel's resources.
 * @param {{ seq?: number, turn?: number, turns?: number[], closingSeq?: number | null, sizes?: Record<string, number> }} [at]
 */
function answerProps({ seq = 40, turn = 2, turns = [1, 2], closingSeq = 40, sizes = { 'clinical-evidence-report.md': 24_576 } } = {}) {
  /** @type {string[]} */
  const asked = [];
  return {
    asked,
    props: {
      node: { kind: 'assistant-step', data: { turn, step: 5, finalNode: { seq } }, location: { kind: 'step', turn: { turn, start: { time: TURN_START } } } },
      useTurnData: (/** @type {string} */ key) => (key === 'turn-tail' && closingSeq !== null ? { turn, time: TURN_END, closing: { finalNode: { seq: closingSeq } } } : undefined),
      useChat: (/** @type {(snapshot: any) => any} */ selector) => selector({ timeline: { turnOrder: turns } }),
      useResource: (/** @type {string} */ address) => {
        asked.push(address);
        const name = decodeURIComponent(address.split('/').pop() ?? '');
        return name in sizes ? { status: 'live', value: { absolutePath: `/workspace/${name}`, version: 'v', bytes: sizes[name] } } : { status: 'loading' };
      },
    },
  };
}

test("nothing of the product's is registered above the composer, in the view ring or as a column tab", () => {
  const f = column();
  assert.deepEqual(f.definitions, [], 'no tab type: a second guide entry would turn the column into the kernel 「开始」 compass');
  for (const name of ['sidebar.right.pane.tab', 'conversation.view', 'conversation.input.dock']) {
    assert.deepEqual(f.ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.name === name), [], `${name} is not ours`);
  }
  const ours = f.answerRow();
  assert.equal(ours.options.priority, -2, 'below the reply check (-1), below the kernel (0)');
  assert.equal(ours.options.locale, 'chat', "the kernel's answer is drawn with the chat namespace's translator");
  assert.deepEqual(f.target.warnings, []);
  assert.equal(BODY.name, 'panels');
});

test('the delivering answer ends with its files: name, type · size, one way to open — and nothing about the run', () => {
  const f = column();
  f.kit.hub.deliver('run-state', DELIVERED);
  const { props, asked } = answerProps();
  const html = renderStatic(f.answerRow().component, props);
  assert.match(html, /^<div data-kernel-answer="40">answer<\/div>/, 'the kernel draws the answer first, as it would without this body');
  assert.match(html, /data-evimed-files="run-1"/);
  assert.match(html, />证据分析报告</, "the document's name, as the reader titles it");
  assert.match(html, /title="clinical-evidence-report\.md"/, "the file's own name is the tooltip");
  assert.match(html, /aria-label="打开证据分析报告"/);
  assert.match(html, />报告规范清单</);
  assert.match(html, /Markdown · 24 KB/, 'the size the kernel stat reports');
  assert.match(html, />JSON</, 'a size not yet known: the type alone');
  assert.match(html, /Excel/);
  assert.match(html, /grid-template-columns:repeat\(2, minmax\(0, 1fr\)\)/, 'two columns');
  assert.doesNotMatch(html, /已交付|已核对|结论|用时|¥|revision-notes|修订说明|条待核对/);
  assert.ok(asked.includes('dsh-resource://file/session/session-a/deliverables/evidence/clinical-evidence-report.md'));
  // One file is one full-width card.
  f.kit.hub.deliver('run-state', { ...DELIVERED, artifacts: ['deliverables/evidence/clinical-evidence-report.md'], unverifiedArtifacts: [] });
  assert.match(renderStatic(f.answerRow().component, answerProps().props), /grid-template-columns:minmax\(0, 1fr\)/);
});

test('only the closing answer of the newest turn that belongs to the run wears the files', () => {
  const f = column();
  const Row = f.answerRow().component;
  const bare = '<div data-kernel-answer="40">answer</div>';
  assert.equal(renderStatic(Row, answerProps().props), bare, 'no run state: nothing');
  f.kit.hub.deliver('run-state', { ...DELIVERED, state: 'running' });
  assert.equal(renderStatic(Row, answerProps().props), bare, 'still running: nothing yet');
  f.kit.hub.deliver('run-state', DELIVERED);
  assert.equal(renderStatic(Row, answerProps({ closingSeq: 41 }).props), bare, 'a step before the answer the turn closed on');
  assert.equal(renderStatic(Row, answerProps({ closingSeq: null }).props), bare, 'a turn still open');
  assert.equal(renderStatic(Row, answerProps({ turns: [1, 2, 3] }).props), bare, 'a later question was asked');
  f.kit.hub.deliver('run-state', { ...DELIVERED, progress: { ...DELIVERED.progress, startedAt: iso(TURN_END + 60 * 60_000), updatedAt: iso(TURN_END + 70 * 60_000) } });
  assert.equal(renderStatic(Row, answerProps().props), bare, 'a run that began after this turn ended is not this turn\'s');
  f.kit.hub.deliver('run-state', DELIVERED);
  f.kit.hub.deliver('session', { sessionId: 'child-1', subagent: true, rootSessionId: 'session-a' });
  assert.equal(renderStatic(Row, answerProps().props), bare, "a delegated child's view is the same run, and shows none of its files");
  f.kit.hub.deliver('session', { sessionId: 'session-a' });
  assert.match(renderStatic(Row, answerProps().props), /data-evimed-files/);
});

test('past four files the rest wait behind one control', () => {
  const f = column();
  f.kit.hub.deliver('run-state', { ...DELIVERED, artifacts: ['a/1.md', 'a/2.md', 'a/3.md', 'a/4.md', 'a/5.md', 'a/6.csv'], unverifiedArtifacts: [] });
  const html = renderStatic(f.answerRow().component, answerProps().props);
  assert.equal((html.match(/data-evimed-file="/g) ?? []).length, 4);
  assert.match(html, /显示全部 6 个文件/);
});

// Production, 2026-09-24: two helper scripts took half the cards of a
// finished review. A reader's files are the cards; the rest wait.
test('a helper script is not a card while there are readable files', () => {
  const f = column();
  f.kit.hub.deliver('run-state', { ...DELIVERED, artifacts: ['d/clinical-evidence-report.md', 'd/clinical-evidence-matrix.json', 'd/build_claims.py', 'd/build_tables.py', 'd/renumber.py'], unverifiedArtifacts: [] });
  const html = renderStatic(f.answerRow().component, answerProps().props);
  assert.equal((html.match(/data-evimed-file="/g) ?? []).length, 2);
  assert.doesNotMatch(html, /data-evimed-file="d\/build_/);
  assert.match(html, /显示全部 5 个文件/);
});

test('an answer can carry both the reply check and the files, each drawing what it shadows first', () => {
  const f = column({ replyChecks: true });
  f.kit.hub.deliver('run-state', DELIVERED);
  f.kit.hub.deliver('reply-check', { sessionId: 'session-a', checks: [{ turnSeq: 40, status: 'done', verdicts: [
    { sentence: '华法林与布洛芬合用无妨 [2]。', verdict: 'unsupported', reason: '来源说增加出血', safety: 'none', source: null },
  ], cautions: [] }] });
  const html = renderStatic(f.answerRow().component, answerProps().props);
  const answer = html.indexOf('data-kernel-answer');
  const check = html.indexOf('data-evimed-reply-check');
  const files = html.indexOf('data-evimed-files');
  assert.ok(answer === 5 && check > answer && files > check, `answer, then its check, then its files: ${html}`);
});

test("the kernel's file tree opens when a report appears while the reader watches, not on a visit to a finished task", () => {
  const watching = column();
  watching.kit.hub.deliver('run-state', { ...DELIVERED, state: 'running', artifacts: [], unverifiedArtifacts: [] });
  assert.deepEqual(watching.opened, []);
  watching.kit.hub.deliver('run-state', DELIVERED);
  assert.deepEqual(watching.opened, ['files']);
  watching.kit.hub.deliver('run-state', { ...DELIVERED, updatedAt: 'later' });
  assert.deepEqual(watching.opened, ['files'], 'once per run');
  const visiting = column();
  visiting.kit.hub.deliver('run-state', DELIVERED);
  assert.deepEqual(visiting.opened, [], 'a finished task already has its files; the column does not jump out');
});

test('the column retries its open while no seat is mounted', () => {
  const f = column({ failFirstOpen: true });
  f.kit.hub.deliver('run-state', { ...DELIVERED, state: 'running', artifacts: [], unverifiedArtifacts: [] });
  assert.deepEqual(f.opened, []);
  f.kit.hub.deliver('run-state', { ...DELIVERED, state: 'running' });
  assert.deepEqual(f.opened, [], 'the first open had no seat');
  f.kit.hub.deliver('run-state', { ...DELIVERED, state: 'running', updatedAt: 'later' });
  assert.deepEqual(f.opened, ['files']);
});

test('outside a frame nothing is taken over', () => {
  const ctx = fakeCtx({ slots: kernel() });
  const target = fakeTarget({ framed: false });
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  assert.equal(ctx.slots.registrations.filter((/** @type {any} */ entry) => (entry.options.priority ?? 0) < 0).length, 0);
});
