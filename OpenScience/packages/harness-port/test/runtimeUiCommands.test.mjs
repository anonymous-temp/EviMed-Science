// The research tools' entry points: the chip under the composer for the tool
// a conversation runs, its starters while the conversation is blank, the
// `/工具` command, and `@` references to the knowledge base. The blank
// conversation itself carries none of them.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apply, BODY, capabilityOptions, knowledgeCandidates, knowledgeReference, knowledgeSerialization, toolPageModel,
} from '../src/runtimeUiCommands.mjs';
import { fakeCtx, fakeTarget, kernelSlots, kitFor, renderStatic } from './helpers/frameFakes.mjs';

const CATALOGUE = [
  { id: 'clinical-evidence-synthesis', title: '临床证据深度分析', category: '临床证据', brief: 'b1', summary: '围绕一个临床问题检索并综合证据。', minutes: [20, 40],
    starters: ['≥70 岁人群阿司匹林一级预防的获益与出血风险。'], outputs: ['证据综述报告', '证据表'], materials: '' },
  { id: 'comprehensive-drug-evaluation', title: '综合药品评价', category: '临床证据', brief: 'b2', summary: '多维度评价一个药品。', minutes: [30, 30],
    starters: [], outputs: [], materials: '需要你的资料' },
  { id: 'research-topic-selection', title: '科研选题', category: '研究规划', brief: 'b3', summary: '提出可落地的选题。' },
  { id: 'source-understanding', title: '来源理解', category: '内部', brief: 'b', visibility: 'internal' },
];

function frame({ commandUi = true, inputTriggers = true } = {}) {
  /** @type {any[]} */
  const sent = [];
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
    conversation: { input: { for: (/** @type {any} */ scope) => ({
      setDraft: (/** @type {string} */ text) => drafts.push([scope.id, text]),
      state: { getSnapshot: () => ({ draft: '老年房颤该不该抗凝？' }) },
    }) } },
    ...(commandUi ? { commandUi: { register(/** @type {any} */ contribution) { commands.push(contribution); return () => {}; } } } : {}),
    ...(inputTriggers ? { inputTriggers: { registerSource(/** @type {any} */ source) { sources.push(source); return () => {}; } } } : {}),
  });
  const target = fakeTarget({ frame: { capabilities: CATALOGUE } });
  const kit = kitFor(ctx, target);
  kit.hub.attach((/** @type {string} */ type, /** @type {any} */ fields) => { sent.push([type, fields]); });
  apply(ctx, {}, target, undefined, kit);
  return { ctx, target, kit, commands, sources, drafts, sent };
}

test('the slash popup lists the public tools, with category and summary to search by and no duration', () => {
  const options = capabilityOptions(/** @type {any} */ (kitFor(fakeCtx(), fakeTarget({ frame: { capabilities: CATALOGUE } })).frame).capabilities);
  assert.deepEqual(options, [
    { id: 'clinical-evidence-synthesis', label: '临床证据深度分析', detail: '临床证据 · 围绕一个临床问题检索并综合证据。' },
    { id: 'comprehensive-drug-evaluation', label: '综合药品评价', detail: '临床证据 · 多维度评价一个药品。' },
    { id: 'research-topic-selection', label: '科研选题', detail: '研究规划 · 提出可落地的选题。' },
  ], 'how long a tool takes is said once, on 科研工具');
});

test('a tool its own module opens is not a row in the popup, and still has a chip', () => {
  // 「循证 GEO」 (build spec 2026-09-25 §6): kept public so its module can bind
  // a conversation to it by id, kept out of the list by `display.listed: false`,
  // and named by its chip in the conversation it runs.
  const catalogue = /** @type {any} */ (kitFor(fakeCtx(), fakeTarget({ frame: { capabilities: [
    ...CATALOGUE,
    { id: 'geo-insight', title: '循证 GEO', category: '写作与传播', brief: 'b', summary: '一句话', starters: ['做一套完整的方案。'], listed: false },
  ] } })).frame).capabilities;
  assert.equal(capabilityOptions(catalogue).some((option) => option.id === 'geo-insight'), false);
  assert.equal(capabilityOptions(catalogue).length, 3, 'every listed public tool is still a row');
  const page = /** @type {any} */ (toolPageModel(catalogue, 'geo-insight'));
  assert.equal(page?.title, '循证 GEO', 'a bound conversation still names its tool');
});

test('a tool\'s page reads from the catalogue, and an internal capability has none', () => {
  // Through the bootstrap reader, as the frame sees it: that is what turns
  // `visibility: internal` into the flag the page filters on.
  const catalogue = /** @type {any} */ (kitFor(fakeCtx(), fakeTarget({ frame: { capabilities: CATALOGUE } })).frame).capabilities;
  const page = /** @type {any} */ (toolPageModel(catalogue, 'clinical-evidence-synthesis'));
  assert.deepEqual([page.title, page.outputs, page.starters.length, page.materials], ['临床证据深度分析', ['证据综述报告', '证据表'], 1, '']);
  assert.equal(toolPageModel(catalogue, 'source-understanding'), null, 'an internal capability has no page');
});

test('/工具 binds the conversation it was typed in, and writes nothing into the draft', async () => {
  const f = frame();
  assert.equal(f.commands.length, 1);
  const command = f.commands[0];
  assert.equal(command.name, '工具');
  assert.equal(command.description(), '选择科研工具');
  assert.equal(command.available({ sessionId: 'session-a' }), true);
  assert.equal(command.ui.kind, 'popupSelect');
  const options = await command.ui.options({ sessionId: 'session-a' }, new globalThis.AbortController().signal);
  assert.equal(options.length, 3, 'the internal capability is not offered');
  command.ui.onSelect(options[1], { sessionId: 'session-a' });
  assert.deepEqual(f.sent.filter(([type]) => type === 'bind-capability').map(([, fields]) => [fields.capabilityId, fields.sessionId, fields.draft]),
    [['comprehensive-drug-evaluation', 'session-a', '老年房颤该不该抗凝？']],
    'the typed question travels with the choice: a binding may cost a fresh conversation');
  assert.deepEqual(f.drafts, [], 'the question stays the researcher\'s own words; the binding carries the tool');
  assert.equal(BODY.name, 'commands');
});

test('the blank conversation is the headline and the composer; a chosen tool is a chip under the composer, with its starters', () => {
  const f = frame();
  // Nothing between the headline and the composer until a tool is chosen,
  // and no page of the tool then either (2026-09-22: it stretched the
  // composer to the frame's edge): the hero seat carries the same chip and
  // starters the composer dock does, held to the composer's width.
  const hero = f.ctx.slots.registrations.find((/** @type {any} */ entry) => entry.name === 'conversation.hero.agentPreset');
  assert.equal(hero.options.priority, -1);
  assert.equal(renderStatic(hero.component), '', 'nothing between the headline and the composer');
  assert.equal(f.ctx.slots.registrations.some((/** @type {any} */ entry) => entry.name === 'conversation.input.dock'), false);
  const chip = f.ctx.slots.registrations.find((/** @type {any} */ entry) => entry.name === 'conversation.composer.dock' && entry.options.id === 'evimed-tool');
  assert.ok(chip, 'in the row under the composer, where the kernel keeps its (hidden) statistics');
  assert.ok(chip.options.order > 0, "after the kernel's stats pill (order 0)");
  // The starters live on the hero only: under a reply they would be noise.
  assert.equal(f.ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.name === 'conversation.composer.dock').length, 1);
  assert.equal(renderStatic(chip.component), '', 'no tool, no chip');
  // The shell reports what the control plane bound this conversation to.
  f.kit.hub.deliver('capability', { capabilityId: 'clinical-evidence-synthesis', sessionId: 'session-a' });
  const drawn = renderStatic(chip.component);
  assert.match(drawn, /临床证据深度分析/);
  // The tool's name alone: its duration and summary were said on 科研工具.
  assert.doesNotMatch(drawn, /分钟|围绕一个临床问题|你会拿到|做不到/);
  assert.match(drawn, /aria-label="移除「临床证据深度分析」"/);
  assert.match(drawn, /title="移除"/);
  assert.doesNotMatch(drawn, /0\.5px/, 'every edge is one 1 px hairline, or none');
  // The hero seat draws the chip and the starters within the composer's width.
  const heroDrawn = renderStatic(hero.component);
  assert.match(heroDrawn, /max-width:var\(--dsh-composer-card-max-width, ?952px\)/);
  assert.match(heroDrawn, /临床证据深度分析/);
  assert.match(heroDrawn, /≥70 岁人群阿司匹林一级预防/);
  assert.doesNotMatch(heroDrawn, /flex:1 1 100%|你会拿到/);
  // Something asked: the chip stays under the composer.
  f.kit.hub.deliver('session', { sessionId: 'session-a', running: true });
  f.kit.hub.deliver('capability', { capabilityId: 'clinical-evidence-synthesis', sessionId: 'session-a' });
  assert.match(renderStatic(chip.component), /临床证据深度分析/);
  // Moving to another conversation drops it until the shell says otherwise.
  f.kit.hub.deliver('session', { sessionId: 'session-b' });
  assert.equal(renderStatic(chip.component), '');
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
  assert.ok(f.ctx.slots.registrations.some((/** @type {any} */ entry) => entry.name === 'conversation.composer.dock' && entry.options.id === 'evimed-tool'));
  assert.ok(f.ctx.slots.registrations.some((/** @type {any} */ entry) => entry.name === 'conversation.hero.agentPreset'));
});
