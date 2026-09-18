/**
 * The transcript without its backstage rows: the assembled system prompt and
 * the context the platform injects are not drawn for a researcher; an operator
 * diagnosing a run keeps them.
 *
 * Hidden knowledge, read off the pinned 0.1.5-rc.2 client (`ui-chat`):
 *
 *  - Every chat node renders through the keyed slot `conversation.chat.node`
 *    with the node's kind as the key; `ui-chat` holds `system-prompt` and
 *    `context` at priority 0, and the lowest priority renders, so a takeover
 *    goes below it.
 *  - A node that renders nothing leaves an empty flow item, and the chat's own
 *    stylesheet hides empty flow items (`.flowItem:empty{display:none}`) and
 *    skips them in the flow gap — `null` is a supported render, not a hole.
 *  - The language pack is the wrong tool: the row's title is copy, but the
 *    label beside it (`@deepseek-ai/dsh-system-prompt`, the plugin that
 *    injected the context) is data. Emptying the copy left a dot and a bare
 *    package name.
 *  - One context kind is the researcher's own: a cross-session recall (their
 *    `@` reference to another task), `provenance.role === 'recall'`. That row
 *    is drawn by the kernel's own component — read from the slot ledger, whose
 *    `entries()` view is the documented inspection surface — so it looks
 *    exactly as it would without this body.
 *
 * What this does not buy, stated plainly: the prompt and the injected context
 * still reach the browser over the session socket, and devtools still show
 * them. This removes the affordance, not the data (the same argument as the
 * trajectory panel's in `hiddenPanelsHaveAMethodBan.test.mjs`).
 *
 * @module @evimed/harness-port/runtime-ui-transcript
 */

/** Services this body needs outright: the slot registry. */
export const inject = ['slots'];

/**
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} [_target] Browser global.
 * @param {(id: string) => any} [_require]
 * @param {any} [kit] The frame kit.
 */
export function apply(ctx, _config, _target = globalThis, _require = undefined, kit = undefined) {
  if (!kit || !kit.ours || !kit.h) return;
  // An operator's page is the kernel's own transcript, every row of it.
  if (kit.operator) return;
  const h = kit.h;
  const slot = 'conversation.chat.node';

  function HiddenRow() { return null; }

  /** The kernel's own renderer for a context row: the next entry below ours. */
  function shippedContextRow() {
    const entries = typeof ctx.slots?.entries === 'function' ? ctx.slots.entries(slot) : [];
    const entry = (Array.isArray(entries) ? entries : []).find((/** @type {any} */ candidate) => candidate
      && candidate.options && candidate.options.key === 'context' && candidate.component !== ContextRow
      && (candidate.options.priority ?? 0) >= 0);
    return entry ? entry.component : null;
  }

  /** @param {any} props */
  function ContextRow(props) {
    if (props?.node?.data?.provenance?.role !== 'recall') return null;
    const Shipped = shippedContextRow();
    return Shipped ? h(Shipped, props) : null;
  }

  // `locale: 'chat'` hands these the chat namespace's translator, which the
  // kernel's context row is drawn with when a recall passes through.
  kit.guarded('system prompt row', () => kit.occupy({ slot, key: 'system-prompt', priority: -1, locale: 'chat' }, HiddenRow));
  kit.guarded('context row', () => kit.occupy({ slot, key: 'context', priority: -1, locale: 'chat' }, ContextRow));
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({ name: 'transcript', inject, parts: Object.freeze([apply]) });
