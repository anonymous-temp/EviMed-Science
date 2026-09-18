// The capability entry points: the `/能力` command, the role cards on a blank
// conversation, and `@` references to the knowledge base.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apply, BODY, capabilityOptions, knowledgeCandidates, knowledgeReference, knowledgeSerialization, roleCards,
} from '../src/runtimeUiCommands.mjs';
import { fakeCtx, fakeTarget, kernelSlots, kitFor, renderStatic } from './helpers/frameFakes.mjs';

const CATALOGUE = [
  { id: 'clinical-evidence-synthesis', title: '临床证据深度分析', category: '临床证据', brief: '请以「临床证据深度分析」能力完成以下任务：\n分析……', summary: '围绕一个临床问题检索并综合证据。', minutes: [20, 40] },
  { id: 'comprehensive-drug-evaluation', title: '综合药品评价', category: '综合评价', brief: '请以「综合药品评价」能力完成以下任务：\n评价……', summary: '多维度评价一个药品。', minutes: [30, 30] },
  { id: 'research-topic-selection', title: '科研选题', category: '研究规划', brief: '请以「科研选题」能力完成以下任务：\n选题……', summary: '提出可落地的选题。' },
  { id: 'source-understanding', title: '来源理解', category: '内部', brief: 'b', visibility: 'internal' },
];

function frame({ commandUi = true, inputTriggers = true } = {}) {
  /** @type {any[]} */
  const commands = [];
  /** @type {any[]} */
  const sources = [];
  /** @type {Array<[string, string]>} */
  const drafts = [];
  const ctx = fakeCtx({
    slots: kernelSlots(),
    sessions: {
      list: { getSnapshot: () => ({ current: 'session-a' }), subscribe: () => () => {} },
      scope: (/** @type {string} */ id) => (id === 'session-a' ? { id } : undefined),
    },
    conversation: { input: { for: (/** @type {any} */ scope) => ({ setDraft: (/** @type {string} */ text) => drafts.push([scope.id, text]) }) } },
    ...(commandUi ? { commandUi: { register(/** @type {any} */ contribution) { commands.push(contribution); return () => {}; } } } : {}),
    ...(inputTriggers ? { inputTriggers: { registerSource(/** @type {any} */ source) { sources.push(source); return () => {}; } } } : {}),
  });
  const target = fakeTarget({ frame: { capabilities: CATALOGUE } });
  const kit = kitFor(ctx, target);
  apply(ctx, {}, target, undefined, kit);
  return { ctx, target, kit, commands, sources, drafts };
}

test('the slash popup lists the public capabilities, with category, summary and duration to search by', () => {
  const options = capabilityOptions(/** @type {any} */ (kitFor(fakeCtx(), fakeTarget({ frame: { capabilities: CATALOGUE } })).frame).capabilities);
  assert.deepEqual(options, [
    { id: 'clinical-evidence-synthesis', label: '临床证据深度分析', detail: '临床证据 · 围绕一个临床问题检索并综合证据。 · 约 20–40 分钟' },
    { id: 'comprehensive-drug-evaluation', label: '综合药品评价', detail: '综合评价 · 多维度评价一个药品。 · 约 30 分钟' },
    { id: 'research-topic-selection', label: '科研选题', detail: '研究规划 · 提出可落地的选题。' },
  ]);
});

test('the blank conversation offers roles, each answered by one capability, and none this deployment lacks', () => {
  const cards = roleCards(CATALOGUE);
  assert.deepEqual(cards.map((card) => [card.role, card.capabilityTitle]), [
    ['临床问题', '临床证据深度分析'], ['药物评价', '综合药品评价'], ['选题与申报', '科研选题'],
  ]);
  assert.ok(cards.every((card) => card.brief.startsWith('请以「')));
});

test('/能力 fills the conversation it was typed in, never a new one', async () => {
  const f = frame();
  assert.equal(f.commands.length, 1);
  const command = f.commands[0];
  assert.equal(command.name, '能力');
  assert.match(command.description(), /研究能力/);
  assert.equal(command.available({ sessionId: 'session-a' }), true);
  assert.equal(command.ui.kind, 'popupSelect');
  const options = await command.ui.options({ sessionId: 'session-a' }, new globalThis.AbortController().signal);
  assert.equal(options.length, 3, 'the internal capability is not offered');
  command.ui.onSelect(options[1], { sessionId: 'session-a' });
  assert.deepEqual(f.drafts, [['session-a', CATALOGUE[1].brief]]);
  command.ui.onSelect({ id: 'unknown' }, { sessionId: 'session-a' });
  assert.equal(f.drafts.length, 1);
  assert.throws(() => command.ui.onSelect(options[0], { sessionId: 'session-gone' }), /还没有准备好/);
  // The row of pills above the composer is retired.
  assert.equal(f.ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.name === 'conversation.input.dock').length, 0);
  assert.equal(BODY.name, 'commands');
});

test('the role cards sit in the hero seat below the kernel, in Chinese', () => {
  const f = frame();
  const seat = f.ctx.slots.registrations.find((/** @type {any} */ entry) => entry.name === 'conversation.hero.agentPreset');
  assert.equal(seat.options.priority, -1);
  const html = renderStatic(seat.component);
  for (const role of ['临床问题', '药物评价', '选题与申报']) assert.match(html, new RegExp(role));
  assert.doesNotMatch(html, /数据可行性/, 'no card for a capability the catalogue does not carry');
});

test('the @ menu offers the parsed sources the shell names, and a pick reads to the model as where the text is', async () => {
  const f = frame();
  assert.equal(f.sources.length, 1);
  const source = f.sources[0];
  assert.equal(source.trigger, '@');
  assert.equal(source.name, '知识库');
  // The shell's answer, through the hub the bridge attaches.
  /** @type {any[]} */
  const asked = [];
  f.kit.hub.attach((/** @type {string} */ type, /** @type {any} */ fields) => {
    asked.push([type, fields.query]);
    setTimeout(() => f.kit.hub.deliver('kb-result', { requestId: fields.requestId, ok: true, items: [
      { id: 'src_ab12', title: 'ROCKET-AF.pdf', detail: '利伐沙班与华法林的比较' },
      { id: 'not-a-source', title: 'x' },
    ] }), 0);
  });
  const candidates = await source.candidates({ sessionId: 'session-a' }, { query: 'rocket', signal: new globalThis.AbortController().signal });
  assert.deepEqual(asked, [['kb-query', 'rocket']]);
  assert.deepEqual(candidates.map((/** @type {any} */ candidate) => [candidate.name, candidate.description]), [['ROCKET-AF.pdf', '利伐沙班与华法林的比较']]);
  const outcome = source.onPick({ candidate: candidates[0] });
  assert.deepEqual(outcome.insert.source, '知识库');
  assert.equal(outcome.insert.label, 'ROCKET-AF.pdf');
  assert.equal(await source.codec.serialize(outcome.insert.ref, new globalThis.AbortController().signal),
    '【知识库文献 src_ab12：「ROCKET-AF.pdf」，解析后的正文在工作区 .evimed-knowledge/.evimed-derived/src_ab12/ 下】');
  assert.equal(source.codec.clipboardText(outcome.insert.ref), '@ROCKET-AF.pdf');
  // With the shell unreachable the group is empty, not an error.
  const lonely = frame();
  assert.deepEqual(await lonely.sources[0].candidates({ sessionId: 'session-a' }, { query: 'x', signal: new globalThis.AbortController().signal }), []);
});

test('references are read back strictly', () => {
  assert.deepEqual(knowledgeReference('{"id":"src_1","title":"A"}'), { id: 'src_1', title: 'A' });
  assert.equal(knowledgeReference('{"id":"../../etc","title":"A"}'), null);
  assert.equal(knowledgeReference('not json'), null);
  assert.throws(() => knowledgeSerialization('{}', '.evimed-knowledge'), /无法识别/);
  assert.deepEqual(knowledgeCandidates({ ok: false, items: [{ id: 'src_1', title: 'A' }] }), []);
});

test('without the command or trigger services the rest still stands', () => {
  const f = frame({ commandUi: false, inputTriggers: false });
  assert.equal(f.commands.length, 0);
  assert.equal(f.sources.length, 0);
  assert.ok(f.ctx.slots.registrations.some((/** @type {any} */ entry) => entry.name === 'conversation.hero.agentPreset'));
});
