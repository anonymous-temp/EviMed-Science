/**
 * The composer's own controls, over the native composer.
 *
 *  - File selection, kept separate: admission, upload and presentation stay with the native composer.
 *  - The researcher's model seat. The kernel's seat (`conversation.input.model`) reads 「deepseek-flash High」: the catalogue's model id and
 *    the adapter's English effort name, neither of which a locale key reaches. A researcher gets 「思考强度」 and the level in Chinese
 *    instead; an operator keeps the kernel's own seat, as with the session statistics.
 */

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

/**
 * What the thinking-intensity seat shows and offers, read off the kernel's model directory: the snapshot a seat is injected with, holding the
 * session's `current` selection, the catalogue's `groups` with each model's advertised `reasoning`, and a `pending` selection while one is
 * in flight.
 *
 * The levels are the ones the session's model advertises, in the kernel's order, that the product has a word for (`labels`, a closed set):
 * one the adapter adds later is not offered until it has a word, and one the model does not advertise is not invented. The level in use is
 * the pending choice while one is in flight, else the session's own, else the model's default (the product's configured effort) -- the
 * order the kernel's own picker reads them in.
 *
 * @param {any} state the directory snapshot, or null
 * @param {Record<string, string>} labels effort id to the product's word for it
 * @returns {{ waiting: boolean, provider: string, model: string, effort: string | null, choices: { id: string, label: string }[] }}
 *   `waiting` is a directory whose catalogue has not arrived; no choices and not waiting is a model that advertises no level the product names.
 */
export function thinkingIntensity(state, labels) {
  const current = state && state.current;
  if (!current || typeof current.provider !== 'string' || typeof current.model !== 'string') {
    return { waiting: true, provider: '', model: '', effort: null, choices: [] };
  }
  const groups = Array.isArray(state.groups) ? state.groups : [];
  const group = groups.find((/** @type {any} */ entry) => entry && entry.id === current.provider);
  const model = group && Array.isArray(group.models) ? group.models.find((/** @type {any} */ entry) => entry && entry.id === current.model) : undefined;
  const reasoning = model && model.reasoning;
  const advertised = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
  const choices = advertised
    .filter((/** @type {any} */ level) => level && typeof level.id === 'string' && Object.prototype.hasOwnProperty.call(labels, level.id))
    .map((/** @type {any} */ level) => ({ id: level.id, label: labels[level.id] }));
  const pending = state.pending && state.pending.provider === current.provider && state.pending.model === current.model ? state.pending.reasoningEffort : undefined;
  const effort = pending ?? current.reasoningEffort ?? (reasoning ? reasoning.defaultEffort : undefined);
  return { waiting: false, provider: current.provider, model: current.model, effort: choices.some((/** @type {any} */ choice) => choice.id === effort) ? effort : null, choices };
}

/**
 * The researcher's model seat: a control named 「思考强度」 that shows the session's level and sets it. It is the kernel's own picker minus the
 * model. It receives what the kernel's seat is injected with and makes the same call -- `select({ provider, model, reasoningEffort })` on the
 * session's model directory, which sends `session.selectModel` and keeps the choice with the session -- so where the choice is stored, what
 * a run and its specialist launches read afterwards, and the product default for a session that has made none are the kernel's, not this
 * body's.
 *
 * Nothing here is a gate. A choice the kernel rejects leaves the level where it was and says so in one plain line; a model that advertises
 * no level the product names draws nothing; a face the body does not recognise draws the kernel's own seat. The kernel's row sets `--dsh-composer-model-text-display` and `--dsh-composer-model-icon-display`
 * when its controls cannot share a line, and the control follows them as the kernel's own does: the words give way to an icon.
 *
 * @param {any} kit @param {any} target the browser global
 * @returns {(props: any) => any}
 */
export function createThinkingSeat(kit, target) {
  const React = kit.react, h = kit.h;
  const labels = (kit.vocabulary && kit.vocabulary.reasoningEffortLabels) || {};
  const LABEL = '思考强度';
  const FAILURE = '没能切换，请再试一次';
  const idle = { getSnapshot: () => null, subscribe: () => () => {} };
  const hover = 'var(--dsw-alias-interactive-bg-hover)';
  // The kernel's own trigger: 28 px, 13 px type, the secondary ink, the level in the caption ink behind the name.
  const triggerStyle = {
    display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0, maxWidth: 'min(360px, 45cqw)', height: '28px', boxSizing: 'border-box',
    padding: '0 4px 0 8px', border: 'none', borderRadius: 'var(--dsw-radius-sm)', fontFamily: 'inherit', fontSize: '13px', fontWeight: 400,
    lineHeight: '20px', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)',
  };
  const wordStyle = { display: 'var(--dsh-composer-model-text-display, block)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
  const iconStyle = { display: 'var(--dsh-composer-model-icon-display, none)', flex: 'none' };
  const glyph = { flex: 'none', color: 'var(--dsw-alias-label-caption)' };
  // The menu opens upward, as the tool chip's does, in the same surface.
  const popoverStyle = {
    position: 'absolute', bottom: 'calc(100% + 8px)', right: 0, zIndex: 40, boxSizing: 'border-box', minWidth: '128px',
    maxWidth: 'min(240px, calc(100vw - 16px))', display: 'flex', flexDirection: 'column', gap: '2px', padding: '4px', borderRadius: '12px',
    border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3))',
    color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '20px', textAlign: 'left',
    boxShadow: 'var(--dsw-elevation-panel, 0 4px 16px rgba(0,0,0,.12))',
  };
  const rowStyle = {
    display: 'flex', alignItems: 'center', gap: '8px', boxSizing: 'border-box', width: '100%', minHeight: '32px', padding: '4px 8px', border: 'none',
    borderRadius: '8px', fontFamily: 'inherit', fontSize: '13px', lineHeight: '20px', textAlign: 'left', color: 'inherit',
  };
  const failureStyle = { padding: '4px 8px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' };

  /** @param {any} props the kernel's injected face (`available`, `directory`, `load`, `select`) and the owner's `locked` */
  function ThinkingSeat(props) {
    const store = props.directory && typeof props.directory.subscribe === 'function' && typeof props.directory.getSnapshot === 'function' ? props.directory : idle;
    const subscribe = React.useCallback((/** @type {() => void} */ listener) => store.subscribe(listener), [store]);
    const read = React.useCallback(() => store.getSnapshot(), [store]);
    const state = React.useSyncExternalStore(subscribe, read, read);
    const [open, setOpen] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const [hot, setHot] = React.useState(/** @type {string | null} */ (null));
    const root = React.useRef(/** @type {any} */ (null));
    const trigger = React.useRef(/** @type {any} */ (null));
    const rowNodes = React.useRef(/** @type {any[]} */ ([]));
    const withKeyboard = React.useRef(false);
    const mounted = React.useRef(true);
    const menuId = React.useId();
    const view = thinkingIntensity(state, labels);
    const locked = props.locked === true;
    const menuOpen = open && !locked && view.choices.length > 0;
    const busy = Boolean(state && state.pending);
    const load = props.load;

    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    // A session switched to starts closed, and the kernel is asked for its catalogue. It shares the one load in flight, so asking again is cheap.
    React.useEffect(() => {
      setOpen(false);
      setFailed(false);
      if (typeof load === 'function') load();
    }, [store]);
    React.useEffect(() => { if (locked) setOpen(false); }, [locked]);
    // A row that closes under the pointer never fires `mouseleave`, so its highlight would be waiting for the next time the menu opens.
    React.useEffect(() => { if (!menuOpen) setHot((/** @type {string | null} */ value) => (value === 'trigger' ? value : null)); }, [menuOpen]);
    React.useEffect(() => {
      if (!menuOpen) return undefined;
      const doc = target && target.document;
      if (!doc || typeof doc.addEventListener !== 'function') return undefined;
      /** @param {any} event */
      const outside = (event) => { if (root.current && !root.current.contains(event.target)) setOpen(false); };
      // Escape closes the menu and goes no further: in the composer it would also be the stop shortcut.
      /** @param {any} event */
      const escape = (event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        setOpen(false);
        if (trigger.current) trigger.current.focus();
      };
      doc.addEventListener('pointerdown', outside, true);
      doc.addEventListener('keydown', escape, true);
      return () => { doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', escape, true); };
    }, [menuOpen]);
    // Opened from the keyboard, the menu takes focus on the level in use.
    React.useEffect(() => {
      if (!menuOpen || !withKeyboard.current) return;
      withKeyboard.current = false;
      const items = rowNodes.current.filter(Boolean);
      const inUse = items.find((/** @type {any} */ node) => node.getAttribute('aria-checked') === 'true') || items[0];
      if (inUse) inUse.focus();
    }, [menuOpen]);

    // A face this body does not recognise (a kernel that injects something else into its seat): the kernel's own seat reads what it injected, so
    // it is drawn in this one's place, and the researcher keeps a picker.
    if (store === idle) {
      const Kernel = kit.shadowed('conversation.input.model', null, ThinkingSeat);
      return Kernel ? h(Kernel, props) : null;
    }
    if (props.available !== true) return null;
    if (view.waiting && state && state.status === 'error') return null;
    if (!view.waiting && view.choices.length === 0) return null;

    /** @param {boolean} byKeyboard */
    const show = (byKeyboard) => {
      withKeyboard.current = byKeyboard;
      setFailed(false);
      setOpen(true);
      if (typeof load === 'function') load();
    };
    /** @param {boolean} restoreFocus */
    const hide = (restoreFocus) => {
      setOpen(false);
      if (restoreFocus && trigger.current) trigger.current.focus();
    };
    /** @param {string} id */
    const choose = (id) => {
      if (view.effort === id) { hide(true); return; }
      setFailed(false);
      /** @type {any} */
      let outcome;
      try { outcome = typeof props.select === 'function' ? props.select({ provider: view.provider, model: view.model, reasoningEffort: id }) : undefined; }
      catch (error) { outcome = Promise.reject(error); }
      Promise.resolve(outcome).then((/** @type {any} */ result) => {
        if (!mounted.current) return;
        if (result && result.ok === false) setFailed(true);
        else hide(true);
      }, () => { if (mounted.current) setFailed(true); });
    };
    /** @param {any} event */
    const onKeyDown = (event) => {
      if (locked || view.choices.length === 0) return;
      const down = event.key === 'ArrowDown', up = event.key === 'ArrowUp';
      if (!down && !up && event.key !== 'Home' && event.key !== 'End') return;
      if (!menuOpen) {
        if (down || up) { event.preventDefault(); show(true); }
        return;
      }
      event.preventDefault();
      const items = rowNodes.current.filter(Boolean);
      if (items.length === 0) return;
      const at = items.indexOf(event.target);
      let next = at < 0 ? (down ? 0 : items.length - 1) : (at + (down ? 1 : -1) + items.length) % items.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = items.length - 1;
      items[next].focus();
    };
    // Leaving the control by the keyboard closes the menu; moving inside it does not.
    /** @param {any} event */
    const onBlur = (event) => {
      if (event.relatedTarget && root.current && root.current.contains(event.relatedTarget)) return;
      setOpen(false);
    };
    // A press on the control must not take focus off the composer's text before the control decides where it goes.
    /** @param {any} event */
    const onMouseDown = (event) => {
      if (event.target && typeof event.target.closest === 'function' && event.target.closest('button')) event.preventDefault();
    };

    const level = view.choices.find((/** @type {any} */ choice) => choice.id === view.effort);
    const sentence = level ? `${LABEL}：${level.label}` : LABEL;
    const triggerNode = h('button', {
      ref: trigger, type: 'button', title: sentence, disabled: locked || view.waiting,
      'aria-haspopup': 'menu', 'aria-expanded': menuOpen, 'aria-controls': menuOpen ? menuId : undefined, 'aria-busy': busy || view.waiting || undefined,
      'aria-label': level ? `${LABEL}，当前：${level.label}` : LABEL,
      onClick: (/** @type {any} */ event) => { if (menuOpen) hide(true); else show(event.detail === 0); },
      onMouseEnter: () => setHot('trigger'), onMouseLeave: () => setHot(null),
      style: { ...triggerStyle, background: hot === 'trigger' && !locked ? hover : 'transparent', ...(locked || view.waiting ? { cursor: 'default', color: 'var(--dsw-alias-label-dimmed)' } : {}) },
    },
    h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': 'true', style: iconStyle },
      h('path', { d: 'M3.5 13v-3M8 13V7M12.5 13V4' })),
    h('span', { style: wordStyle }, LABEL),
    level ? h('span', { style: { ...wordStyle, flexShrink: 1000, color: 'var(--dsw-alias-label-caption)' } }, `：${level.label}`) : null,
    h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      style: { ...glyph, transform: menuOpen ? 'rotate(180deg)' : 'none' } }, h('path', { d: 'M3 4.5 6 7.5 9 4.5' })));
    const popover = menuOpen
      ? h('div', { style: popoverStyle },
        h('div', { id: menuId, role: 'menu', 'aria-label': LABEL, 'aria-busy': busy || undefined, style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          view.choices.map((/** @type {{ id: string, label: string }} */ choice, /** @type {number} */ index) => {
            const chosen = choice.id === view.effort;
            return h('button', {
              key: choice.id, ref: (/** @type {any} */ node) => { rowNodes.current[index] = node; }, type: 'button', role: 'menuitemradio', 'aria-checked': chosen, disabled: busy,
              onClick: () => choose(choice.id), onMouseEnter: () => setHot(choice.id), onMouseLeave: () => setHot(null),
              style: { ...rowStyle, cursor: busy ? 'default' : 'pointer', background: hot === choice.id && !busy ? hover : 'transparent' },
            },
            h('span', { style: { flex: 1, minWidth: 0 } }, choice.label),
            h('span', { style: { flex: '0 0 14px', display: 'grid', placeItems: 'center' } },
              chosen ? h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
                h('path', { d: 'M3 7.5 5.8 10 11 4.5' })) : null));
          })),
        failed ? h('div', { role: 'alert', style: failureStyle }, FAILURE) : null)
      : null;
    return h('div', { ref: root, style: { position: 'relative', minWidth: 0 }, onKeyDown, onBlur, onMouseDown }, triggerNode, popover);
  }
  return ThinkingSeat;
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
  // The model seat, for a researcher. The occupant inherits the kernel's registration (its `inject` is how it reaches the session's model
  // directory), so it is made once the kernel's entry exists, in whichever order the two start. An operator keeps the kernel's own seat.
  // From 0.2.1 the kernel's seat declares a child, `conversation.input.model.label`, where `ui-deepseek-model-label-1017`
  // adds its 「1017」 badge beside the catalogue's display name; this seat names the model the product's way and does not
  // draw it (the badge draws only under the name DeepSeek-V4.1-Flash, which this deployment does not show).
  if (!kit.operator) kit.guarded('thinking intensity', () => kit.occupyOver({ slot: 'conversation.input.model', priority: -1 }, createThinkingSeat(kit, target)));
}
export const BODY = Object.freeze({ name: 'composer', inject: ['slots'], parts: Object.freeze([createComposerUploadStore, thinkingIntensity, createThinkingSeat, apply]) });
