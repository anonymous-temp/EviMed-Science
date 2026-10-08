// The research tools' entry points: the chip in the composer's toolbar for the
// tool a conversation runs (with its menu of settings for the two modules),
// its starters while the conversation is blank, the `/工具` command, and `@`
// references to the knowledge base. The blank conversation itself carries none
// of them.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apply, BODY, capabilityOptions, chipSuffix, knowledgeCandidates, knowledgeReference, knowledgeSerialization, toolPageModel,
} from '../src/runtimeUiCommands.mjs';
import { fakeCtx, fakeTarget, kernelSlots, kitFor, renderStatic } from './helpers/frameFakes.mjs';
import { FRAME_VOCABULARY } from '../src/runtimeUiFrame.mjs';

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
      list: { getSnapshot: () => ({ byId: { 'session-a': { id: 'session-a', retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} },
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

/** The toolbar seat: after the kernel's `+` and the paperclip, inside the composer card. */
const toolbarChip = (/** @type {any} */ f) => f.ctx.slots.registrations.find((/** @type {any} */ entry) => entry.name === 'conversation.input.left' && entry.options.id === 'evimed-tool');

test('the blank conversation is the headline and the composer; a chosen tool is a chip in the toolbar, with its starters on the hero', () => {
  const f = frame();
  // Nothing between the headline and the composer until a tool is chosen,
  // and no page of the tool then either (2026-09-22: it stretched the
  // composer to the frame's edge): the hero seat carries the starters, held
  // to the composer's width.
  const hero = f.ctx.slots.registrations.find((/** @type {any} */ entry) => entry.name === 'conversation.hero.agentPreset');
  assert.equal(hero.options.priority, -1);
  assert.equal(renderStatic(hero.component), '', 'nothing between the headline and the composer');
  assert.equal(f.ctx.slots.registrations.some((/** @type {any} */ entry) => entry.name === 'conversation.input.dock'), false);
  // E-17: nothing of ours is in the row under the composer card.
  assert.equal(f.ctx.slots.registrations.some((/** @type {any} */ entry) => entry.name === 'conversation.composer.dock'), false,
    'the row under the card is the kernel\'s: statistics and the context ring');
  const chip = toolbarChip(f);
  assert.ok(chip, 'in the toolbar inside the card, where the kernel keeps its + and our paperclip');
  assert.equal(chip.options.order, 10, "after the paperclip (order -100)");
  assert.equal(renderStatic(chip.component), '', 'no tool, no chip');
  // The shell reports what the control plane bound this conversation to.
  f.kit.hub.deliver('capability', { capabilityId: 'clinical-evidence-synthesis', sessionId: 'session-a' });
  const drawn = renderStatic(chip.component);
  assert.match(drawn, /临床证据深度分析/);
  // The tool's name alone: its duration and summary were said on 科研工具.
  assert.doesNotMatch(drawn, /分钟|围绕一个临床问题|你会拿到|做不到/);
  // One click removes it; a native tooltip would be a second name for the same button.
  assert.match(drawn, /aria-label="移除“临床证据深度分析”"/);
  assert.doesNotMatch(drawn, /title=/);
  // A tool with no settings has no menu.
  assert.doesNotMatch(drawn, /aria-haspopup|<select/);
  assert.doesNotMatch(drawn, /0\.5px/, 'every edge is one 1 px hairline, or none');
  // In the toolbar the chip takes what the row has left and gives way with an
  // ellipsis, rather than wrapping the toolbar at 390 px (measured, 0.1.7-rc.2).
  assert.match(drawn, /data-evimed-chip-placement="bar"/);
  assert.match(drawn, /max-width:max\(56px, ?calc\(100cqw - 194px\)\)/);
  assert.match(drawn, /flex:0 1 auto/);
  // The hero seat draws the chip (there is no toolbar yet in a static render) and
  // the starters within the composer's width.
  const heroDrawn = renderStatic(hero.component);
  assert.match(heroDrawn, /max-width:var\(--dsh-composer-card-max-width, ?952px\)/);
  assert.match(heroDrawn, /临床证据深度分析/);
  assert.match(heroDrawn, /data-evimed-chip-placement="hero"/);
  assert.match(heroDrawn, /≥70 岁人群阿司匹林一级预防/);
  assert.doesNotMatch(heroDrawn, /flex:1 1 100%|你会拿到/);
  // Something asked: the chip stays in the toolbar.
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

// 循证 GEO: its capabilities are hidden from 科研工具, so the catalogue may not
// list them, and a conversation bound to any of them still says 「循证 GEO」.
const GEO_OPTIONS = {
  sessionId: 'session-a', controls: true, coverageDays: 90, coverageOptions: [30, 60, 90, 180],
  engines: ['doubao', 'qianwen', 'deepseek', 'yuanbao', 'kimi'],
  offered: [
    { id: 'doubao', name: '豆包' }, { id: 'qianwen', name: '千问' }, { id: 'deepseek', name: 'DeepSeek' },
    { id: 'yuanbao', name: '元宝' }, { id: 'kimi', name: 'Kimi' },
  ],
  starters: [
    { label: '完整方案', draft: '做一套完整的循证 GEO 方案，产品是：' },
    { label: 'AI 怎么说我的产品', draft: '看看各家 AI 怎么回答我的产品，产品是：' },
    { label: '信源分析与预期', draft: '看看 AI 回答里引用了谁，产品是：' },
    { label: '优化已有稿件', draft: '把我已有的稿件逐篇优化：' },
    { label: '去 AI 味', draft: '给这批稿件去 AI 味：' },
    { label: '持续监测', draft: '持续监测各家 AI 怎么回答我的产品，产品是：' },
  ],
};

test('a GEO conversation reads 「循证 GEO」 whichever of its capabilities it is bound to, listed or not', () => {
  const geo = FRAME_VOCABULARY.geo;
  for (const id of ['geo-insight', 'geo-strategy', 'geo-content', 'geo-proposal']) {
    assert.equal(/** @type {any} */ (toolPageModel(CATALOGUE, id, geo)).title, '循证 GEO');
  }
  assert.equal(toolPageModel(CATALOGUE, 'geo-insight'), null, 'without the vocabulary it is an unknown tool');
  const f = frame();
  const chip = toolbarChip(f);
  f.kit.hub.deliver('capability', { capabilityId: 'geo-insight', sessionId: 'session-a' });
  const drawn = renderStatic(chip.component);
  assert.match(drawn, /循证 GEO/);
  assert.match(drawn, /aria-label="移除“循证 GEO”"/);
  assert.doesNotMatch(drawn, /覆盖周期|aria-haspopup/, 'no settings before the shell has found the project');
});

test('/工具 never offers the GEO capabilities, even when the catalogue lists them', () => {
  const listed = [...CATALOGUE, { id: 'geo-insight', title: 'GEO 洞察', category: '市场', brief: 'b', summary: 's' }];
  const catalogue = /** @type {any} */ (kitFor(fakeCtx(), fakeTarget({ frame: { capabilities: listed } })).frame).capabilities;
  assert.deepEqual(capabilityOptions(catalogue, FRAME_VOCABULARY.geo.capabilities).map((option) => option.id),
    ['clinical-evidence-synthesis', 'comprehensive-drug-evaluation', 'research-topic-selection']);
});

test('the GEO chip carries 覆盖周期 and AI 引擎 in its menu once the shell has found the project, and six single-step starters on the blank conversation', () => {
  const f = frame();
  const chip = toolbarChip(f);
  const hero = f.ctx.slots.registrations.find((/** @type {any} */ entry) => entry.name === 'conversation.hero.agentPreset');
  f.kit.hub.deliver('capability', { capabilityId: 'geo-insight', sessionId: 'session-a' });
  f.kit.hub.deliver('geo', GEO_OPTIONS);
  const drawn = renderStatic(chip.component);
  // The settings are a menu behind the chip, closed until asked for; no native select is as wide as its longest option.
  assert.match(drawn, /aria-haspopup="dialog"/);
  assert.match(drawn, /aria-expanded="false"/);
  assert.match(drawn, /aria-label="循证 GEO，设置"/);
  assert.doesNotMatch(drawn, /<select|<option|覆盖周期|AI 引擎/);
  // At the defaults the chip says nothing more than its name.
  assert.doesNotMatch(drawn, / · /);
  assert.doesNotMatch(drawn, /完整方案/, 'the starters live on the blank conversation only');
  // Off its defaults the chip names what changed, briefly.
  f.kit.hub.deliver('geo', { ...GEO_OPTIONS, coverageDays: 180 });
  assert.match(renderStatic(chip.component), /aria-label="循证 GEO · 180 天，设置"/);
  f.kit.hub.deliver('geo', { ...GEO_OPTIONS, engines: ['doubao', 'kimi', 'deepseek'] });
  assert.match(renderStatic(chip.component), /aria-label="循证 GEO · 3 个引擎，设置"/);
  f.kit.hub.deliver('geo', { ...GEO_OPTIONS, coverageDays: 30, engines: ['doubao'] });
  assert.match(renderStatic(chip.component), /aria-label="循证 GEO · 2 项设置，设置"/);
  f.kit.hub.deliver('geo', GEO_OPTIONS);
  const blank = renderStatic(hero.component);
  assert.match(blank, /循证 GEO/);
  const labels = [...blank.matchAll(/<button type="button" title="[^"]+"[^>]*><span[^>]*>([^<]+)<\/span><\/button>/g)].map((match) => match[1]);
  assert.deepEqual(labels, ['完整方案', 'AI 怎么说我的产品', '信源分析与预期', '优化已有稿件', '去 AI 味', '持续监测']);
  // A conversation in a project that is not a GEO project: the chip and the
  // starters, no settings to write anywhere.
  f.kit.hub.deliver('geo', { ...GEO_OPTIONS, controls: false });
  assert.doesNotMatch(renderStatic(chip.component), /aria-haspopup/);
  // Another conversation: the options go with the tool until the shell speaks.
  f.kit.hub.deliver('session', { sessionId: 'session-b' });
  assert.equal(renderStatic(chip.component), '');
});

test('what the chip leaves unsaid is the platform\'s default, and a setting the reader may not change is never named', () => {
  const defaults = FRAME_VOCABULARY.chipDefaults;
  const geo = { geo: true };
  const vcr = { vcr: true };
  // The defaults come from the domain, not from a number written here.
  assert.deepEqual([defaults.geo.coverageDays, [...defaults.geo.engines]], [90, ['doubao', 'qianwen', 'deepseek', 'yuanbao', 'kimi']]);
  assert.deepEqual({ ...defaults.vcr }, { start: 'auto', intendedUse: 'exploratory' });
  assert.equal(chipSuffix(null, GEO_OPTIONS, null, defaults), '');
  assert.equal(chipSuffix(geo, GEO_OPTIONS, null, defaults), '');
  assert.equal(chipSuffix(geo, { ...GEO_OPTIONS, coverageDays: 60 }, null, defaults), '60 天');
  // The same five engines in another order are the defaults; a sixth is not.
  assert.equal(chipSuffix(geo, { ...GEO_OPTIONS, engines: [...GEO_OPTIONS.engines].reverse() }, null, defaults), '');
  assert.equal(chipSuffix(geo, { ...GEO_OPTIONS, engines: [...GEO_OPTIONS.engines, 'baidu'] }, null, defaults), '6 个引擎');
  assert.equal(chipSuffix(geo, { ...GEO_OPTIONS, coverageDays: 30, engines: ['kimi'] }, null, defaults), '2 项设置');
  assert.equal(chipSuffix(geo, { ...GEO_OPTIONS, controls: false, coverageDays: 30 }, null, defaults), '', 'no project, nothing is set');
  assert.equal(chipSuffix(vcr, null, VCR_OPTIONS, defaults), '');
  assert.equal(chipSuffix(vcr, null, { ...VCR_OPTIONS, start: 'cohort' }, defaults), '队列');
  assert.equal(chipSuffix(vcr, null, { ...VCR_OPTIONS, intendedUse: 'design_support' }, defaults), '研究设计支持');
  assert.equal(chipSuffix(vcr, null, { ...VCR_OPTIONS, start: 'trial', intendedUse: 'design_support' }, defaults), '2 项设置');
  // A reader who may not write cannot have changed the start, nor one who is not the lead the use.
  assert.equal(chipSuffix(vcr, null, { ...VCR_OPTIONS, start: 'cohort', startOptions: [] }, defaults), '');
  assert.equal(chipSuffix(vcr, null, { ...VCR_OPTIONS, intendedUse: 'design_support', canSetUse: false }, defaults), '');
  assert.equal(chipSuffix(vcr, null, { ...VCR_OPTIONS, controls: false, start: 'cohort' }, defaults), '');
  // With no defaults to compare to, it says nothing rather than guess.
  assert.equal(chipSuffix(geo, { ...GEO_OPTIONS, coverageDays: 30 }, null, {}), '');
});

// 虚拟临床研究: the same chip through its five capabilities, and — once the shell has
// found the study — 起点 and 预期用途 beside it and six single-task starters.
const VCR_OPTIONS = {
  sessionId: 'session-a', controls: true, canSetUse: true,
  start: 'auto', startOptions: [{ id: 'auto', label: '自动' }, { id: 'cohort', label: '队列' }, { id: 'patients', label: '患者' }, { id: 'comparator', label: '对照' }, { id: 'trial', label: '试验' }],
  intendedUse: 'exploratory', useOptions: [{ id: 'exploratory', label: '探索' }, { id: 'design_support', label: '研究设计支持' }],
  starters: [
    { label: '估算样本量', draft: '帮我估算样本量：' }, { label: '外部对照可行性', draft: '评估外部对照是否可行：' },
    { label: '找先例和参数', draft: '帮我找同类试验先例和参数：' }, { label: '生成合成数据', draft: '帮我生成合成数据：' },
    { label: '匹配患者', draft: '帮我匹配患者：' }, { label: '完整研究', draft: '帮我做一个完整的研究：' },
  ],
};

test('a 虚拟临床研究 conversation reads 「虚拟临床研究」 whichever of its capabilities it is bound to', () => {
  const vcr = FRAME_VOCABULARY.vcr;
  for (const id of vcr.capabilities) {
    assert.equal(/** @type {any} */ (toolPageModel(CATALOGUE, id, vcr)).title, '虚拟临床研究');
  }
  assert.equal(/** @type {any} */ (toolPageModel(CATALOGUE, 'vcr-protocol', vcr)).vcr, false,
    'the vocabulary alone claims no controls: the body claims them');
  const f = frame();
  const chip = toolbarChip(f);
  f.kit.hub.deliver('capability', { capabilityId: 'vcr-analysis', sessionId: 'session-a' });
  const drawn = renderStatic(chip.component);
  assert.match(drawn, /虚拟临床研究/);
  assert.match(drawn, /aria-label="移除“虚拟临床研究”"/);
  assert.doesNotMatch(drawn, /起点|预期用途|aria-haspopup/, 'no settings before the shell has found the study');
});

test('the 虚拟临床研究 chip carries 起点 and 预期用途 in its menu once the shell has found the study, and six single-task starters on the blank conversation', () => {
  const f = frame();
  const chip = toolbarChip(f);
  const hero = f.ctx.slots.registrations.find((/** @type {any} */ entry) => entry.name === 'conversation.hero.agentPreset');
  f.kit.hub.deliver('capability', { capabilityId: 'vcr-protocol', sessionId: 'session-a' });
  f.kit.hub.deliver('vcr', VCR_OPTIONS);
  const drawn = renderStatic(chip.component);
  assert.match(drawn, /aria-haspopup="dialog"/);
  assert.match(drawn, /aria-label="虚拟临床研究，设置"/);
  assert.doesNotMatch(drawn, /<select|<option|起点|预期用途/, 'a closed menu, and no native select sized by its longest option');
  assert.doesNotMatch(drawn, /覆盖周期|AI 引擎/, 'GEO\'s settings are GEO\'s');
  assert.doesNotMatch(drawn, /估算样本量/, 'the starters live on the blank conversation only');
  // Off its defaults the chip says so, briefly: 「虚拟临床研究 · 队列」.
  f.kit.hub.deliver('vcr', { ...VCR_OPTIONS, start: 'cohort' });
  assert.match(renderStatic(chip.component), /aria-label="虚拟临床研究 · 队列，设置"/);
  f.kit.hub.deliver('vcr', { ...VCR_OPTIONS, start: 'cohort', intendedUse: 'design_support' });
  assert.match(renderStatic(chip.component), /aria-label="虚拟临床研究 · 2 项设置，设置"/);
  f.kit.hub.deliver('vcr', VCR_OPTIONS);
  const blank = renderStatic(hero.component);
  assert.match(blank, /虚拟临床研究/);
  const labels = [...blank.matchAll(/<button type="button" title="[^"]+"[^>]*><span[^>]*>([^<]+)<\/span><\/button>/g)].map((match) => match[1]);
  assert.deepEqual(labels, ['估算样本量', '外部对照可行性', '找先例和参数', '生成合成数据', '匹配患者', '完整研究']);

  // A reader who may neither write nor lead has no menu at all: the settings
  // are not theirs, and a control the server would refuse is not offered.
  f.kit.hub.deliver('vcr', { ...VCR_OPTIONS, startOptions: [], canSetUse: false });
  assert.doesNotMatch(renderStatic(chip.component), /aria-haspopup/);
  // One who may write but is not the lead still has the menu (for the start).
  f.kit.hub.deliver('vcr', { ...VCR_OPTIONS, canSetUse: false });
  assert.match(renderStatic(chip.component), /aria-haspopup="dialog"/);
  // A conversation in a project that is not a study: the chip and the starters, nothing to write to.
  f.kit.hub.deliver('vcr', { ...VCR_OPTIONS, controls: false });
  assert.doesNotMatch(renderStatic(chip.component), /aria-haspopup/);
  assert.match(renderStatic(hero.component), /估算样本量/);
  // Another conversation: the options go with the tool until the shell speaks.
  f.kit.hub.deliver('session', { sessionId: 'session-b' });
  assert.equal(renderStatic(chip.component), '');
  assert.equal(renderStatic(hero.component), '');
});

test('without the command or trigger services the rest still stands', () => {
  const f = frame({ commandUi: false, inputTriggers: false });
  assert.equal(f.commands.length, 0);
  assert.equal(f.sources.length, 0);
  assert.ok(toolbarChip(f));
  assert.ok(f.ctx.slots.registrations.some((/** @type {any} */ entry) => entry.name === 'conversation.hero.agentPreset'));
});
