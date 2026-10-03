/** Separate file selection, with all admission/upload/presentation still owned by the native composer. */

/** One resident composer scope; a file dialog never borrows a later session's intake.
 * @param {string | undefined} sessionId @returns {any} */
export function createComposerUploadStore(sessionId) {
  /** @type {any} */ let owner = null;
  /** @type {Set<() => void>} */ const listeners = new Set();
  const publish = (/** @type {any} */ next) => { owner = next; for (const listener of listeners) listener(); };
  const store = {
    sessionId,
    getSnapshot: () => owner,
    subscribe(/** @type {() => void} */ listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish,
    clear(/** @type {any} */ previous) { if (owner === previous) publish(null); },
    open() { return sessionId && owner?.canAcceptDrop === true && typeof owner.onAddFiles === 'function' ? store : null; },
    deliver(/** @type {any} */ selection, /** @type {readonly any[]} */ files) {
      if (selection !== store || !store.open() || !Array.isArray(files) || files.length === 0) return false;
      owner.onAddFiles(files); return true;
    },
  };
  return store;
}

/** @param {any} ctx @param {any} config @param {any} target @param {any} require @param {any} kit */
export function apply(ctx, config, target, require, kit) {
  if (!kit.ours || !kit.react || !kit.h) return;
  const React = kit.react, h = kit.h;
  // Child slots keep the native bar as their sole declarer. Share only its
  // public Session identity and connection epoch, never a parent React root.
  const fallback = new Map(), generations = new WeakMap();
  function useUploadStore(/** @type {any} */ props) {
    const generation = ctx.connection?.generation;
    const epoch = React.useSyncExternalStore((/** @type {()=>void} */ listener) => generation?.subscribe(listener) ?? (() => {}), () => generation?.getSnapshot() ?? null, () => null);
    const map = epoch && typeof epoch === 'object' ? generations.get(epoch) ?? (() => { const created = new Map();generations.set(epoch,created);return created; })() : fallback;
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined;
    if (!map.has(sessionId)) map.set(sessionId,createComposerUploadStore(sessionId));
    return map.get(sessionId);
  }
  const attachmentSlot = 'conversation.input.attachments';
  /** The native attachment rail/drop/retry/removal body retains every original owner prop. @param {any} props */
  function Attachments(props) {
    const store = useUploadStore(props);
    React.useLayoutEffect(() => {
      if (!store) return undefined;
      store.publish(props); return () => { store.clear(props); };
    }, [store, props]);
    const Native = kit.shadowed(attachmentSlot, null, Attachments);
    return Native ? h(Native, props) : null;
  }
  /** @param {any} props */
  function Upload(props) {
    const store = useUploadStore(props), input = React.useRef(null), opened = React.useRef(null);
    const owner = React.useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.getSnapshot ?? (() => null), () => null);
    const available = Boolean(store?.sessionId && owner?.canAcceptDrop === true && typeof owner.onAddFiles === 'function');
    const label = typeof props.t === 'function' ? props.t('input.upload') : '上传附件';
    return h(React.Fragment, null,
      h('button', { type: 'button', title: label, 'aria-label': label, disabled: !available, className: 'evimed-composer-upload',
        onMouseDown: (/** @type {any} */ event) => event.preventDefault(),
        onClick: () => { const selection = store?.open(); if (selection && input.current) { opened.current = selection; input.current.click(); } },
        style: { display: 'inline-flex', alignItems: 'center', appearance: 'none', background: 'transparent', border: 0, color: 'inherit', font: 'inherit', cursor: available ? 'pointer' : 'default' },
      }, h('svg', { style: { width: '1em', height: '1em' }, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true },
        h('path', { d: 'M21 11.5l-8.6 8.6a6 6 0 01-8.5-8.5l9.2-9.2a4 4 0 015.7 5.7l-9.2 9.2a2 2 0 01-2.8-2.8l8.5-8.5' }))),
      h('input', { type: 'file', multiple: true, hidden: true, disabled: !available, ref: input, 'aria-label': label,
        onChange: (/** @type {any} */ event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; const selection = opened.current; opened.current = null; store?.deliver(selection, files); },
        onCancel: () => { opened.current = null; },
      }),
    );
  }
  kit.guarded('native upload controls', () => {
    kit.occupy({ slot: attachmentSlot, priority: -1, locale: 'conversation' }, Attachments);
    kit.occupy({ slot: 'conversation.input.left', id: 'evimed-upload', order: -100, locale: 'conversation' }, Upload);
  });
}
export const BODY = Object.freeze({ name: 'composer', inject: ['slots'], parts: Object.freeze([createComposerUploadStore, apply]) });
