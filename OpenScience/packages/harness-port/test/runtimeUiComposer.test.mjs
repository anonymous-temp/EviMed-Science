import assert from 'node:assert/strict';
import test from 'node:test';
import {apply,createComposerUploadStore,createThinkingSeat,thinkingIntensity} from '../src/runtimeUiComposer.mjs';
import {FRAME_VOCABULARY} from '../src/runtimeUiFrame.mjs';
import {SHIPPED_MODEL_SEAT,fakeCtx,fakeSlots,fakeTarget,kernelSlots,kitFor,renderStatic} from './helpers/frameFakes.mjs';
import {modelDirectory} from './helpers/nativeModelSeat.mjs';

test('native owner receives original ordered files and retains upload/removal/retry authority',()=>{
 const store=createComposerUploadStore('session-a');
/** @type {any[]} */const batches=[];const files=[{name:'证据.pdf'},{name:'结果.csv'}];
 const owner={canAcceptDrop:true,onAddFiles:(/** @type {any} */ batch)=>batches.push(batch),uploads:{id:{status:'uploading'}},onRetryFile:()=>{},onRemoveAttachment:()=>{}};
 store.publish(owner);const selection=store.open();assert.equal(store.deliver(selection,files),true);assert.equal(batches[0],files);assert.equal(store.getSnapshot(),owner);
});
test('file dialog results cannot move to a different session, unmounted owner or locked intake',()=>{
 const a=createComposerUploadStore('a'),b=createComposerUploadStore('b');let added=0;const owner={canAcceptDrop:true,onAddFiles:()=>added++};a.publish(owner);b.publish(owner);const picked=a.open();
 assert.equal(b.deliver(picked,[{}]),false);a.publish({...owner,canAcceptDrop:false});assert.equal(a.deliver(picked,[{}]),false);a.clear(owner);assert.equal(a.open(),null);
 a.publish(owner);const next=a.open();a.clear(owner);assert.equal(a.deliver(next,[{}]),false);assert.equal(added,0);
});
test('cancel and empty selection preserve draft/attachments without native side effects',()=>{
 const store=createComposerUploadStore('a');let called=0;store.publish({canAcceptDrop:true,onAddFiles:()=>called++});assert.equal(store.deliver(store.open(),[]),false);assert.equal(store.deliver(null,[{}]),false);assert.equal(called,0);
});

test('absent public slot observation leaves the complete native composer as fallback',async()=>{
 const {apply}=await import('../src/runtimeUiComposer.mjs');let registered=0;
 apply({slots:{entries:()=>[]}}, {}, {}, null, {ours:false,react:{createContext:()=>({})},h:()=>{},occupy:()=>registered++});assert.equal(registered,0);
});

// The researcher's model seat. The rendering on the pinned slot registry and renderer is in runtimeUiNativeAssembly.test.mjs; these hold the
// reading of the kernel's model directory and the registration, against a fake kernel that refuses what the pinned one refuses.
const LABELS = FRAME_VOCABULARY.reasoningEffortLabels;
const snapshot = (/** @type {Parameters<typeof modelDirectory>[0]} */ options = {}) => modelDirectory(options).store.getSnapshot();
const certified = { provider: 'deepseek-official', model: 'deepseek-flash' };

test('the product has a Chinese word for each of the four levels, and nothing else in them', () => {
  assert.deepEqual(Object.keys(LABELS), ['off', 'low', 'high', 'max']);
  assert.deepEqual(Object.values(LABELS), ['关闭', '低', '高', '最高']);
  for (const word of Object.values(LABELS)) assert.doesNotMatch(word, /[A-Za-z0-9]/, 'no English effort word');
});

test('the level in use is the pending choice, else the session\'s own, else the model\'s default', () => {
  assert.equal(thinkingIntensity(snapshot(), LABELS).effort, 'high', 'a session with no choice of its own starts from the default the profile gives the adapter');
  assert.equal(thinkingIntensity(snapshot({ defaultEffort: 'max' }), LABELS).effort, 'max');
  assert.equal(thinkingIntensity(snapshot({ effort: 'low' }), LABELS).effort, 'low');
  const asking = { ...snapshot({ effort: 'low' }), pending: { ...certified, reasoningEffort: 'max' } };
  assert.equal(thinkingIntensity(asking, LABELS).effort, 'max', 'while the kernel answers, what was asked for');
  const another = { ...snapshot({ effort: 'low' }), pending: { provider: 'deepseek-official', model: 'another', reasoningEffort: 'max' } };
  assert.equal(thinkingIntensity(another, LABELS).effort, 'low', 'a pending choice for another model is not this one\'s');
  assert.equal(thinkingIntensity(snapshot({ effort: 'medium' }), LABELS).effort, null, 'a stored level the product has no word for reads as none');
});

test('the levels are the ones the model advertises that the product names, in the kernel\'s order, with the session it will select for', () => {
  const view = thinkingIntensity(snapshot(), LABELS);
  assert.deepEqual(view.choices, [{ id: 'off', label: '关闭' }, { id: 'low', label: '低' }, { id: 'high', label: '高' }, { id: 'max', label: '最高' }]);
  assert.deepEqual({ provider: view.provider, model: view.model, waiting: view.waiting }, { ...certified, waiting: false });
  const shuffled = thinkingIntensity(snapshot({ efforts: [{ id: 'max', name: 'Max' }, { id: 'xhigh', name: 'XHigh' }, { id: 'off', name: 'Off' }] }), LABELS);
  assert.deepEqual(shuffled.choices.map(choice => choice.id), ['max', 'off'], 'the kernel\'s order; a level without a word is left out');
  assert.deepEqual(thinkingIntensity(snapshot({ efforts: [{ id: 'constructor', name: 'C' }, { id: '__proto__', name: 'P' }] }), LABELS).choices, [], 'a word is looked up as data, never through the prototype');
});

test('a directory whose catalogue has not arrived is waiting, and a model that advertises no levels offers none', () => {
  assert.equal(thinkingIntensity(null, LABELS).waiting, true);
  assert.equal(thinkingIntensity({ current: null, groups: [], status: 'loading' }, LABELS).waiting, true);
  const none = thinkingIntensity(snapshot({ efforts: null }), LABELS);
  assert.deepEqual({ waiting: none.waiting, choices: none.choices, effort: none.effort }, { waiting: false, choices: [], effort: null });
  const unlisted = thinkingIntensity({ ...snapshot(), current: { provider: 'deepseek-official', model: 'removed' } }, LABELS);
  assert.deepEqual({ waiting: unlisted.waiting, choices: unlisted.choices }, { waiting: false, choices: [] }, 'a selection whose model left the catalogue has nothing to choose');
});

/** @param {{ operator?: boolean, slots?: any }} [options] */
function seatFixture({ operator = false, slots = kernelSlots() } = {}) {
  const ctx = fakeCtx({ slots });
  const target = fakeTarget({ frame: operator ? { operator: true } : {} });
  const kit = kitFor(ctx, target);
  const occupant = () => ctx.slots.registrations.find((/** @type {any} */ entry) => entry.name === 'conversation.input.model' && entry.component !== 'shipped');
  return { ctx, target, kit, occupant };
}

test('a researcher\'s model seat is taken over below the kernel\'s, carrying the registration it is injected by', () => {
  const f = seatFixture();
  apply(f.ctx, {}, f.target, undefined, f.kit);
  const seat = f.occupant();
  assert.ok(seat, 'the seat is occupied');
  assert.ok(seat.options.priority < 0, 'below the kernel\'s own occupant, which sits at 0');
  assert.equal(seat.inject, SHIPPED_MODEL_SEAT.inject, 'with the kernel\'s inject, which is how it reaches the session\'s model directory');
  assert.equal(seat.locale, 'model');
  assert.ok(f.ctx.slots.registrations.some((/** @type {any} */ entry) => entry.name === 'conversation.input.model' && entry.component === 'shipped'), 'and the kernel\'s own entry is left registered');
});

test('an operator is given no occupant, so the kernel\'s own seat stands', () => {
  const f = seatFixture({ operator: true });
  apply(f.ctx, {}, f.target, undefined, f.kit);
  assert.equal(f.occupant(), undefined);
});

test('the takeover waits for the kernel\'s entry, whichever of the two starts first', () => {
  const f = seatFixture({ slots: fakeSlots(FRAME_VOCABULARY.slots) });
  apply(f.ctx, {}, f.target, undefined, f.kit);
  assert.equal(f.occupant(), undefined, 'nothing to take over yet, and nothing registered in its place');
  f.ctx.slots.register({ name: 'conversation.input.model', locale: 'model', inject: SHIPPED_MODEL_SEAT.inject }, 'shipped');
  const seat = f.occupant();
  assert.ok(seat && seat.options.priority < 0 && seat.inject === SHIPPED_MODEL_SEAT.inject);
});

test('without React, or outside a page the control plane served, the kernel\'s seat is left alone', () => {
  const bare = seatFixture();
  apply(bare.ctx, {}, bare.target, undefined, kitFor(bare.ctx, bare.target, { react: false }));
  assert.equal(bare.occupant(), undefined);
  const foreign = seatFixture();
  const target = fakeTarget({ framed: false });
  apply(foreign.ctx, {}, target, undefined, kitFor(foreign.ctx, target));
  assert.equal(foreign.occupant(), undefined);
});

test('a seat the kernel injects nothing into draws nothing: no session face, an addressed subagent, no levels', () => {
  const f = seatFixture();
  const Seat = createThinkingSeat(f.kit, f.target);
  const directory = modelDirectory();
  const face = { available: true, directory: directory.store, load: directory.load, select: directory.select, locked: false };
  assert.match(renderStatic(Seat, face), /思考强度/);
  assert.equal(renderStatic(Seat, {}), '', 'no injected face');
  assert.equal(renderStatic(Seat, { ...face, available: false }), '', 'a subagent session has no model selection of its own');
  assert.equal(renderStatic(Seat, { ...face, directory: modelDirectory({ efforts: null }).store }), '', 'a model with no levels');
  assert.equal(renderStatic(Seat, { ...face, directory: { getSnapshot: () => ({ current: null, groups: [], status: 'error' }), subscribe: () => () => {} } }), '', 'a catalogue that failed to load');
});

test('the closed control reads 「思考强度：高」 in the kernel\'s tokens and follows the row\'s compact form, with no English word', () => {
  const f = seatFixture();
  const Seat = createThinkingSeat(f.kit, f.target);
  const directory = modelDirectory();
  const html = renderStatic(Seat, { available: true, directory: directory.store, load: directory.load, select: directory.select, locked: false });
  assert.match(html, /思考强度/);
  assert.match(html, /：高/);
  assert.match(html, /aria-label="思考强度，当前：高"/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.doesNotMatch(html, /menuitemradio/, 'the menu is closed');
  // What a reader sees and hears: the text and the accessible names, not the style (`overflow` has `low` in it).
  assert.doesNotMatch(html.replace(/ style="[^"]*"/g, ''), /deepseek|High|Low|Max|Off|provider/i);
  // The kernel's row switches its seat to an icon when the controls cannot share a line; the control follows the same two variables.
  assert.match(html, /display:var\(--dsh-composer-model-text-display, block\)/);
  assert.match(html, /display:var\(--dsh-composer-model-icon-display, none\)/);
  assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b/, 'colour comes only through the kernel\'s roles');
  const waiting = renderStatic(Seat, { available: true, directory: { getSnapshot: () => ({ current: null, groups: [], status: 'loading' }), subscribe: () => () => {} }, locked: false });
  assert.match(waiting, /disabled=""/, 'while the catalogue loads the control holds its place, inert');
  assert.doesNotMatch(waiting, /：/, 'and names no level');
});
