// The sources behind an answer, as cards under it.
//
// The payload is the shell's `evidence` message, in the shape
// `apps/web/src/lib/runtimeUiBridge.ts` builds from the delivered evidence
// matrix and its claim verification — so the fixtures here are that shape and
// not an invention of this suite. What is asserted is what a reader acts on:
// the composition line counts the cards it stands over, a withdrawn work says
// so in a strip of its own, a quotation carries the verdict the control plane
// reached, and nothing of the platform's own vocabulary reaches the row.
import assert from 'node:assert/strict';
import test from 'node:test';

import { STUDY_TYPE_BADGES } from '@evimed/design-tokens';
import { STUDY_BADGE_KINDS } from '@evimed/domain';
import { apply, BODY, sourceCardsModel, sourceStatusText } from '../src/runtimeUiSources.mjs';
import { FRAME_VOCABULARY } from '../src/runtimeUiFrame.mjs';
import { fakeCtx, fakeTarget, kernelSlots, kitFor, renderStatic } from './helpers/frameFakes.mjs';

const LIVE = {
  runId: 'run-1', sessionId: 'session-a', state: 'done',
  artifacts: ['deliverables/evidence/clinical-evidence-report.md'],
  progress: { deliverables: [], startedAt: '2026-09-26T01:00:00.000Z', updatedAt: '2026-09-26T01:40:00.000Z' },
};

const EVIDENCE = {
  runId: 'run-1',
  reportPath: 'deliverables/evidence/clinical-evidence-report.md',
  matrixPath: 'deliverables/evidence/clinical-evidence-matrix.json',
  claims: [],
  sources: [
    { title: '中国 2 型糖尿病防治指南（2020 年版）', identifier: 'CN-GL-2020', sourceType: 'guideline',
      journal: '中华糖尿病杂志', year: '2021', claims: 3, status: 'verified', quote: '二甲双胍是首选用药。', claimId: 'CLM-001' },
    { title: 'Effect of intensive blood-glucose control with metformin (UKPDS 34)', identifier: 'PMID 9742977',
      url: 'https://pubmed.ncbi.nlm.nih.gov/9742977/', sourceType: 'rct', journal: 'The Lancet', year: '1998', claims: 2,
      status: 'quote_not_found', quote: '36% for all-cause mortality', claimId: 'CLM-002', funding: 'industry' },
    { title: 'Metformin and cardiovascular disease: a meta-analysis', identifier: '10.1000/meta', sourceType: 'meta-analysis', claims: 1,
      updates: [{ kind: 'retraction', noticeDoi: '10.1000/notice', date: '2024-03-01', source: 'retraction-watch' }] },
    { title: 'A cohort of metformin users', sourceType: 'observational', claims: 1 },
  ],
  grade: { letter: 'C', reasons: ['4 项研究', '样本量不足 400'] },
  premises: ['成人', '肾功能正常', '非妊娠'],
};

/** The model of a payload, never null in these fixtures.
 *  @param {any} evidence @returns {any} */
function modelOf(evidence) {
  const model = sourceCardsModel(evidence, FRAME_VOCABULARY);
  assert.ok(model, 'the fixture has sources, so it has a model');
  return model;
}

/** A frame with the sources body applied, and the shell's state delivered. */
function frame(evidence = EVIDENCE, live = LIVE) {
  const ctx = fakeCtx({ slots: kernelSlots() });
  const target = fakeTarget();
  const kit = kitFor(ctx, target);
  apply(ctx, {}, target, undefined, kit);
  kit.hub.deliver('session', { sessionId: 'session-a' });
  kit.hub.deliver('run-state', live);
  kit.hub.deliver('evidence', evidence);
  const entry = ctx.slots.registrations.find((/** @type {any} */ row) => row.name === 'conversation.chat.node'
    && row.options.key === 'assistant-step' && row.component !== 'shipped');
  return { ctx, target, kit, entry };
}

/** The props the chat's own slot hands an answer row, for the closing answer of the newest turn. */
function answerProps() {
  return {
    node: { data: { turn: 't1', finalNode: { seq: 42 } }, location: { turn: { start: { time: Date.parse('2026-09-26T01:05:00.000Z') } } } },
    useTurnData: (/** @type {string} */ key) => (key === 'turn-tail' ? { closing: { finalNode: { seq: 42 } }, time: Date.parse('2026-09-26T01:35:00.000Z') } : undefined),
    useChat: (/** @type {(snapshot: any) => any} */ select) => select({ timeline: { turnOrder: ['t0', 't1'] } }),
  };
}

test('the five badge names the vocabulary maps to are the palette\'s own', () => {
  const kinds = Object.keys(STUDY_TYPE_BADGES);
  assert.ok(kinds.length >= 5, `only ${kinds.length} badges were read, so this test walked nothing`);
  for (const [type, kind] of Object.entries(STUDY_BADGE_KINDS)) {
    assert.ok(kinds.includes(kind), `${type} maps to "${kind}", which the palette has no colour for`);
  }
  // The frame carries the colours themselves: the shell's `--study-*` custom
  // properties are on the shell's document, not on the kernel's page.
  assert.deepEqual(FRAME_VOCABULARY.studyBadges, STUDY_TYPE_BADGES);
  assert.deepEqual(FRAME_VOCABULARY.studyBadgeKinds, STUDY_BADGE_KINDS);
});

test('the composition line counts the cards it stands over, in the domain\'s order', () => {
  const model = modelOf(EVIDENCE);
  assert.equal(model.total, 4);
  assert.deepEqual(model.composition.map((/** @type {any} */ entry) => `${entry.label} ${entry.count}`),
    ['指南 1', 'Meta 分析 1', 'RCT 1', '观察性研究 1']);
  const counted = model.composition.reduce((/** @type {number} */ sum, /** @type {any} */ entry) => sum + entry.count, 0);
  assert.equal(counted, model.total, 'the summary counts every card and no other');
  // A payload with no sources is not a list with nothing in it.
  assert.equal(sourceCardsModel({ runId: 'run-1', sources: [] }, FRAME_VOCABULARY), null);
  assert.equal(sourceCardsModel(null, FRAME_VOCABULARY), null);
});

test('a card is the badge, the title, the journal and year, and the identifier — never an id of ours', () => {
  const html = renderStatic(frame().entry.component, answerProps());
  assert.match(html, /来源 4/);
  assert.match(html, /指南 1 · Meta 分析 1 · RCT 1 · 观察性研究 1/);
  assert.match(html, /中华糖尿病杂志/);
  assert.match(html, /1998/);
  assert.match(html, /PMID 9742977/);
  assert.match(html, /复制/);
  assert.match(html, /data-evimed-study="rct"/);
  assert.match(html, new RegExp(STUDY_TYPE_BADGES.rct.bg), 'the badge draws in the palette\'s own colour');
  assert.match(html, /企业资助/);
  assert.doesNotMatch(html, /clinical-evidence-matrix|deliverables\/|run-1|CLM-00/, 'a path, a run id or a claim id reached the reader');
});

test('a retracted source says so in a strip of its own, louder than a correction', () => {
  const html = renderStatic(frame().entry.component, answerProps());
  assert.match(html, /data-evimed-retracted="withdrawn"/);
  assert.match(html, /已撤稿 · 2024-03-01/);
  const corrected = modelOf({
    ...EVIDENCE,
    sources: [{ title: 'x', sourceType: 'rct', updates: [{ kind: 'correction', noticeDoi: null, date: null, source: 'publisher' }] }],
  });
  assert.deepEqual(corrected.sources[0].withdrawn, { label: '有更正', severe: false });
  const unknown = modelOf({
    ...EVIDENCE,
    sources: [{ title: 'x', sourceType: 'rct', updates: [{ kind: 'from-a-newer-table' }] }],
  });
  assert.equal(unknown.sources[0].withdrawn, null, 'a notice this build cannot name is not drawn as one it can');
});

test('a quotation opens with the verdict the control plane reached, and an unknown status is not a ✓', () => {
  const words = sourceStatusText();
  assert.equal(words.verified.mark, '✓');
  assert.equal(words.quote_not_found.mark, '⚠');
  assert.equal(words.quote_not_found.tone, 'warn');
  assert.ok(!Object.hasOwn(words, 'unchecked'), 'an unknown status must fall through to no mark at all');

  const { entry, kit } = frame();
  const html = renderStatic(entry.component, answerProps());
  assert.match(html, /✓ 引文已核对/);
  assert.match(html, /⚠ 引文未在原文中找到/);
  // The quotation itself sits behind that control, on the highlighter.
  assert.doesNotMatch(html, /36% for all-cause mortality/, 'the quotation waits until the reader asks for it');
  const model = modelOf(kit.hub.getState().evidence);
  assert.equal(model.sources[1].quote, '36% for all-cause mortality');
  assert.equal(model.sources[3].status, null, 'a source the check did not reach carries no mark');
  // Reading it in place is the report reader's, reached by the address the
  // shell already navigates to: the report, with the claim as its fragment.
  assert.equal(model.reportPath, EVIDENCE.reportPath);
  assert.equal(model.sources[0].claimId, 'CLM-001');
});

test('the answer-level grade and its premises draw only when the platform computed them', () => {
  const html = renderStatic(frame().entry.component, answerProps());
  assert.match(html, /data-evimed-grade="C"/);
  assert.match(html, /证据等级 · 低/);
  assert.match(html, /适用前提/);
  assert.match(html, /肾功能正常/);
  const without = modelOf({ ...EVIDENCE, grade: null, premises: [] });
  assert.equal(without.grade, null);
  assert.deepEqual(without.premises, []);
  const unknownLetter = modelOf({ ...EVIDENCE, grade: { letter: 'Z' } });
  assert.equal(unknownLetter.grade, null, 'a letter this build has no word for is not shown as one it has');
});

test('the list follows the answer it belongs to, under the files and the check', () => {
  const { target, entry } = frame();
  assert.equal(entry.options.priority, -3, 'the reply check is at -1 and the delivered files at -2');
  assert.equal(entry.options.locale, 'chat');
  assert.deepEqual(target.warnings, []);
  assert.equal(BODY.name, 'sources');
  // The row it shadows is always drawn; what these three must not add is the
  // list (`data-evimed-sources`).
  const earlier = { ...answerProps(), node: { data: { turn: 't0', finalNode: { seq: 7 } }, location: { turn: { start: { time: 0 } } } } };
  assert.doesNotMatch(renderStatic(entry.component, earlier), /data-evimed-sources/, 'an earlier answer of the same conversation');
  const other = frame({ ...EVIDENCE, runId: 'run-2' });
  assert.doesNotMatch(renderStatic(other.entry.component, answerProps()), /data-evimed-sources/, 'evidence of another run');
  const child = frame();
  child.kit.hub.deliver('session', { sessionId: 'child-1', subagent: true, rootSessionId: 'session-a' });
  assert.doesNotMatch(renderStatic(child.entry.component, answerProps()), /data-evimed-sources/, "a delegated child's view is the same run and shows none");
  // And nothing at all outside a control-plane-served page.
  const bare = fakeCtx({ slots: kernelSlots() });
  const outside = fakeTarget({ framed: false });
  apply(bare, {}, outside, undefined, kitFor(bare, outside));
  assert.equal(bare.slots.registrations.filter((/** @type {any} */ row) => row.component !== 'shipped').length, 0);
});
