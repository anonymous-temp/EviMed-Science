/**
 * The research capabilities, offered where the typing happens.
 *
 * @module @evimed/harness-port/runtime-ui-commands
 */

/** Services this body needs outright: the slot registry. */
export const inject = ['slots'];

/**
 * @param {any} _ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} target Browser global.
 * @param {(id: string) => any} [_require]
 * @param {any} [kit] The frame kit.
 */
export function apply(_ctx, _config, target = globalThis, _require = undefined, kit = undefined) {
  if (!kit || !kit.ours || !kit.h) return;
  const h = kit.h;
  const capabilities = kit.frame.capabilities.filter((/** @type {any} */ entry) => !entry.internal).slice(0, 24);
  if (!capabilities.length) return;
  /**
   * The fifteen research capabilities, one row above the composer.
   *
   * `conversation.input.dock` is a list slot, registered with an `id` — `key`,
   * which the right sidebar's tab slot takes, is refused here with
   * `requires options.id`. The click leaves through the shell, which opens a
   * task carrying the brief.
   */
  const CapabilityDock = () => h('details', {
    style: { width: '100%', margin: '0 0 6px' },
  },
  h('summary', {
    style: { cursor: 'pointer', fontSize: '12px', opacity: 0.6, listStyle: 'none', padding: '2px 0' },
  }, `科研能力 · ${capabilities.length} 项`),
  h('div', {
    style: { display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '6px 0 2px' },
  }, capabilities.map((/** @type {any} */ capability) => h('button', {
    key: capability.id,
    type: 'button',
    title: `${capability.category} · ${capability.title}`,
    onClick: () => {
      try { target.__EVIMED_SHELL__?.navigate?.('new-task', capability.brief); } catch { /* no channel, no navigation */ }
    },
    style: { padding: '4px 10px', borderRadius: '999px', border: '1px solid rgba(127,127,127,0.28)',
      background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: '12px' },
  }, capability.title))));
  kit.guarded('capability dock', () => kit.occupy({ slot: 'conversation.input.dock', id: 'evimed-capabilities' }, CapabilityDock));
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({ name: 'commands', inject, parts: Object.freeze([apply]) });
