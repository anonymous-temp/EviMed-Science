// The kernel's composer model seat as the pinned client registers it, for the tests that need the thing the product's own seat takes over.
//
// Transcribed from `@deepseek-ai/dsh-client-ui-model-selection@0.1.7-rc.2` (`lib/client.js`: `ModelDirectory`, `ModelSelect` and the `apply` that
// registers the seat) and `@deepseek-ai/dsh-llm-deepseek@0.1.7-rc.2` (`REASONING_EFFORTS`), not inferred:
//
//  - the seat is registered at priority 0 with `locale: 'model'` and an `inject` that, given a session, returns `{ available, directory, load,
//    select }` -- the session's shared model directory (a snapshot store of `ModelDirectoryState`), a verb that loads the catalogue, and
//    `ModelDirectory.select`;
//  - `select(selection)` publishes the selection as `pending`, sends `session.selectModel({ sessionId, provider, model, reasoningEffort? })`
//    and, when the Host answers ok, the session's durable projection (`model/selection`) moves `current` to it;
//  - the kernel's component draws the catalogue's own model name and the adapter's own effort name -- 「deepseek-flash High」, the two strings
//    no locale key reaches.
import assert from 'node:assert/strict';

/** The adapter's own reasoning choices (`dsh-llm-deepseek` `REASONING_EFFORTS`): the English names the researcher used to read. */
export const ADAPTER_EFFORTS = Object.freeze([
  Object.freeze({ id: 'off', name: 'Off' }),
  Object.freeze({ id: 'low', name: 'Low' }),
  Object.freeze({ id: 'high', name: 'High' }),
  Object.freeze({ id: 'max', name: 'Max' }),
]);

/**
 * One session's model directory over a catalogue with the certified model.
 *
 * @param {{ sessionId?: string, effort?: string, defaultEffort?: string, efforts?: readonly { id: string, name: string }[] | null,
 *   outcome?: (selection: any) => Promise<any> }} [options]
 *   `effort` is the session's stored choice (absent: the product default applies), `efforts` null is an adapter that advertises no
 *   reasoning levels, `outcome` is what the Host answers to a selection.
 */
export function modelDirectory({ sessionId = 'actual-session', effort, defaultEffort = 'high', efforts = ADAPTER_EFFORTS,
  outcome = async () => ({ ok: true, value: undefined }) } = {}) {
  /** @type {any} */
  let state = {
    current: { provider: 'deepseek-official', model: 'deepseek-flash', ...(effort === undefined ? {} : { reasoningEffort: effort }) },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-flash', name: 'deepseek-flash', ...(efforts === null ? {} : { reasoning: { efforts, defaultEffort } }) }],
    }],
    failures: [],
    status: 'ready',
    pending: null,
    error: null,
  };
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const store = {
    getSnapshot: () => state,
    subscribe(/** @type {() => void} */ listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(/** @type {(draft: any) => void} */ change) {
      const draft = globalThis.structuredClone(state);
      change(draft);
      state = draft;
      for (const listener of [...listeners]) listener();
    },
  };
  /** What the seat handed `select`. @type {any[]} */
  const selections = [];
  /** What `session.selectModel` sent to the Host. @type {any[]} */
  const wire = [];
  let loads = 0;
  return {
    sessionId,
    store,
    selections,
    wire,
    loads: () => loads,
    load: () => { loads += 1; },
    /** @param {any} selection */
    async select(selection) {
      selections.push(globalThis.structuredClone(selection));
      store.update((draft) => { draft.status = 'selecting'; draft.pending = selection; draft.error = null; });
      wire.push({ sessionId, provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) });
      const result = await outcome(selection);
      if (!result.ok) {
        store.update((draft) => { draft.status = 'error'; draft.pending = null; draft.error = `${result.error.code}: ${result.error.message}`; });
        return result;
      }
      store.update((draft) => { draft.status = 'ready'; draft.pending = null; draft.current = selection; });
      return { ok: true, value: undefined };
    },
  };
}

/**
 * The `inject` the kernel registers the seat with. `face` is the prop the directory store is handed over under (`directory`, as pinned); a
 * test that wants a kernel which injects something else gives another name.
 * @param {ReturnType<typeof modelDirectory>} directory
 * @param {string[]} [asked] the session keys it was asked for
 * @param {string} [face]
 */
export function seatInject(directory, asked = [], face = 'directory') {
  return (/** @type {string} */ sessionId) => {
    asked.push(sessionId);
    return { available: true, [face]: directory.store, load: directory.load, select: (/** @type {any} */ selection) => directory.select(selection) };
  };
}

/**
 * The kernel's seat: its registration options and its component.
 * @param {any} React @param {ReturnType<typeof modelDirectory>} directory @param {string} [face] the prop name the directory store is injected under
 */
export function nativeSeat(React, directory, face = 'directory') {
  /** @type {string[]} */
  const asked = [];
  /** @type {any[]} */
  const rendered = [];
  const h = React.createElement;
  /** @param {any} props */
  function NativeModelSeat(props) {
    rendered.push(props);
    const directoryStore = props[face];
    assert.equal(typeof directoryStore?.getSnapshot, 'function', 'the seat is injected with the session directory store');
    const state = React.useSyncExternalStore((/** @type {() => void} */ listener) => directoryStore.subscribe(listener), () => directoryStore.getSnapshot());
    const model = state.groups.flatMap((/** @type {any} */ group) => group.models).find((/** @type {any} */ entry) => entry.id === state.current?.model);
    const effort = state.current?.reasoningEffort ?? model?.reasoning?.defaultEffort;
    const name = model?.reasoning?.efforts.find((/** @type {any} */ level) => level.id === effort)?.name ?? effort;
    return h('button', { type: 'button', 'data-native-model-seat': '', disabled: props.locked === true }, [model?.name, name].filter(Boolean).join(' '));
  }
  return {
    asked,
    rendered,
    component: NativeModelSeat,
    options: { name: 'conversation.input.model', locale: 'model', inject: seatInject(directory, asked, face) },
  };
}
