/**
 * The kernel's own controls, made visible: what Enter does while a run is
 * working.
 *
 * Hidden knowledge, read off the pinned 0.1.5-rc.2 client
 * (`dsh-client-ui-conversation`):
 *
 *  - While the agent runs, the composer does not refuse a message: plain
 *    Enter queues it for the next turn and Ctrl/⌘+Enter steers it into the
 *    current one (`resolveSubmitMode`, preference `busyEnter`, default
 *    `queue`). The choice lives in a settings row the hosted page does not
 *    show, and the browser keeps settings in memory off loopback, so the
 *    default is what every researcher runs on — and nothing said it existed.
 *    For a run that takes twenty minutes this is the most useful control on
 *    the page.
 *  - `conversation.input.dock` is a list seat above the composer, rendered
 *    with the session snapshot as owner props; `session.running` is the same
 *    flag the composer reads. The hint shows only then.
 *
 * @module @evimed/harness-port/runtime-ui-controls
 */

import { frameStyles } from './runtimeUiStyles.mjs';

/** Services this body needs outright: the slot registry. */
export const inject = ['slots'];

/**
 * The hint's words.
 * @returns {string}
 */
export function busyHint() {
  return '运行中：Enter 排队 · Ctrl/⌘+Enter 插话';
}

/**
 * @param {any} _ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} [_target] Browser global.
 * @param {(id: string) => any} [_require]
 * @param {any} [kit] The frame kit.
 */
export function apply(_ctx, _config, _target = globalThis, _require = undefined, kit = undefined) {
  if (!kit || !kit.ours || !kit.h) return;
  const h = kit.h;
  const { secondary } = frameStyles();
  const text = busyHint();
  /** @param {{ session?: { running?: boolean } }} props */
  const BusyHint = ({ session }) => (session && session.running === true
    ? h('div', {
      'data-evimed-busy-hint': '',
      role: 'note',
      style: { ...secondary, color: 'var(--dsw-alias-label-tertiary)', padding: '0 16px 0 20px', textAlign: 'right' },
    }, text)
    : null);
  kit.guarded('busy hint', () => kit.occupy({ slot: 'conversation.input.dock', id: 'evimed-busy-hint', order: 30 }, BusyHint));
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({ name: 'controls', inject, parts: Object.freeze([frameStyles, busyHint, apply]) });
