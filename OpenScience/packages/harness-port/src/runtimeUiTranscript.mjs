/**
 * The transcript as a reader takes it in: a finished conversation opens with
 * each turn's process folded into one line, and without its backstage rows —
 * the assembled system prompt, the context the platform injects, and events
 * no renderer knows — which an operator diagnosing a run keeps.
 *
 * Hidden knowledge, read off the pinned 0.1.5-rc.2 client (`ui-chat`,
 * `dsh-api-session-controller`):
 *
 *  - The kernel folds a closed turn's process — tool rows, reasoning, earlier
 *    messages — into one line (「171 次工具调用 · 12 条消息」) in its default
 *    Compact mode, but only once the whole history is loaded: "While older
 *    history remains available through Load earlier, process controls stay
 *    absent and no members are hidden" (`ChatNodeSeat`:
 *    `processWindowReady … && !historyIncomplete`, where `historyIncomplete`
 *    is the session's `hasMore`). A session opens on its newest page, so a
 *    long research conversation opened with every step of its process spread
 *    out — the wall of English the owner saw (整改方案 §3). So when the
 *    conversation on screen is not running and has earlier pages, this body
 *    reads it to its first event through the session's own jump loader —
 *    `ctx.sessions.binding(id).session.loadThrough(seq)`, the call the chat's
 *    turn rail makes (`ui-chat` client.js, `loadThrough: (seq) =>
 *    session.loadThrough(seq)`) — and the kernel folds every closed turn.
 *    A running turn stays open by the kernel's own rule. A run that finishes
 *    while the reader watches is read to its start then, and folds as a short
 *    conversation does natively.
 *  - `loadThrough` pages 200 messages at a time until the window covers the
 *    seq or nothing is left, and fails soft; one call per session per opening
 *    of its history window, so a failed page is not asked for in a loop.
 *  - Every chat node renders through the keyed slot `conversation.chat.node`
 *    with the node's kind as the key; `ui-chat` holds `system-prompt`,
 *    `context` and `unknown` at priority 0, and the lowest priority renders,
 *    so a takeover goes below it.
 *  - A node that renders nothing leaves an empty flow item, and the chat's own
 *    stylesheet hid empty flow items (`.flowItem:empty{display:none}`) and
 *    skipped them in the flow gap — `null` is a supported render, not a hole.
 *    At 0.1.7-rc.2 the flow item holds the chat-node outlet anchor, so it is no
 *    longer `:empty` and kept its gap: `runtimeUiShell.mjs` hides these three
 *    kinds by their empty outlet instead.
 *  - The language pack is the wrong tool: the row's title is copy, but the
 *    label beside it (`@deepseek-ai/dsh-system-prompt`, the plugin that
 *    injected the context) is data. Emptying the copy left a dot and a bare
 *    package name. An unknown event's row is its type and raw payload.
 *  - One context kind is the researcher's own: a cross-session recall (their
 *    `@` reference to another task), `provenance.role === 'recall'`. That row
 *    is drawn by the kernel's own component — read from the slot ledger, whose
 *    `entries()` view is the documented inspection surface — so it looks
 *    exactly as it would without this body.
 *
 *  - The researcher's own message is drawn by `UserMessageNodeView` (keys `user`
 *    and `steering`): `UserStyleBubble` joins EVERY text part of the message into
 *    the one bubble and draws any other part as a JSON block, so a second text
 *    part the platform appended for the model is read by the researcher under
 *    their own words. A result revision does exactly that (`resultRevision.bind`
 *    appends its frozen selection as `<evimed_result_selection>…`), which stood
 *    in the bubble as raw JSON until 2026-10-10. The takeover below draws the
 *    kernel's own row over the same message with that block removed; the model
 *    still receives it, the transcript on the wire still holds it.
 *
 * What this does not buy, stated plainly: the prompt and the injected context
 * still reach the browser over the session socket, and devtools still show
 * them. This removes the affordance, not the data (the same argument as the
 * trajectory panel's in `hiddenPanelsHaveAMethodBan.test.mjs`).
 *
 * @module @evimed/harness-port/runtime-ui-transcript
 */

import { mainViewSession } from './runtimeUiKit.mjs';

/** Services this body needs outright: the slot registry and the sessions. */
export const inject = ['slots', 'sessions'];

/**
 * Whether a session's history should be read to its start now: its window is
 * open and has earlier pages, nothing is paging it already, and it is not
 * running.
 * @param {any} snapshot the session's `SessionSnapshot`
 * @returns {boolean}
 */
export function historyWanted(snapshot) {
  return Boolean(snapshot) && snapshot.openState === 'open' && snapshot.hasMore === true
    && snapshot.loadingOlder !== true && snapshot.running !== true;
}

/**
 * A researcher's own message without the blocks the platform appended for the
 * model: `<evimed_result_selection>…</evimed_result_selection>` (a result
 * revision's frozen selection, `resultRevision.bind`). A closed tag, not a
 * pattern over prose; a block whose closing tag is missing is taken to the end of
 * its part. A part left empty is dropped, and a message without the block comes
 * back as the same array, so an ordinary message is never copied.
 * @param {any} content a message's content parts
 * @returns {any}
 */
export function withoutPlatformBlocks(content) {
  if (!Array.isArray(content)) return content;
  const block = /\s*<evimed_result_selection>[\s\S]*?(?:<\/evimed_result_selection>|$)/g;
  let changed = false;
  /** @type {any[]} */
  const kept = [];
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string' && part.text.includes('<evimed_result_selection>')) {
      changed = true;
      const text = part.text.replace(block, '');
      if (text.trim() !== '') kept.push({ ...part, text });
      continue;
    }
    kept.push(part);
  }
  return changed ? kept : content;
}

/**
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} [target] Browser global.
 * @param {(id: string) => any} [_require]
 * @param {any} [kit] The frame kit.
 */
export function apply(ctx, _config, target = globalThis, _require = undefined, kit = undefined) {
  if (!kit || !kit.ours) return;

  // Finished conversations open folded, for every account.
  kit.guarded('finished history', () => {
    const sessions = ctx.sessions;
    if (!sessions || typeof sessions.binding !== 'function' || typeof sessions.list?.subscribe !== 'function') return;
    // Sessions whose whole history was asked for since their window opened.
    /** @type {Set<string>} */
    const asked = new Set();
    /** @type {{ id: string, face: any, unsubscribe: () => void } | null} */
    let watched = null;
    // Both run inside the kernel's own change notifications, so neither may
    // throw into them; the page read from `loadThrough` is started after the
    // notification returns.
    const check = () => kit.guarded('finished history', () => {
      if (!watched) return;
      const { id, face } = watched;
      const snapshot = face.getSnapshot();
      if (snapshot?.openState !== 'open') { asked.delete(id); return; }
      if (asked.has(id) || !historyWanted(snapshot)) return;
      asked.add(id);
      Promise.resolve().then(() => face.loadThrough(0)).catch((/** @type {unknown} */ error) => {
        target?.console?.warn?.('[evimed-frame] the conversation history did not load in full:', error);
      });
    });
    const follow = () => kit.guarded('finished history', () => {
      const id = mainViewSession(sessions.list.getSnapshot());
      if (watched && watched.id === id) return;
      watched?.unsubscribe();
      watched = null;
      if (typeof id !== 'string' || !id) return;
      const face = sessions.binding(id)?.session;
      if (!face || typeof face.getSnapshot !== 'function' || typeof face.subscribe !== 'function' || typeof face.loadThrough !== 'function') return;
      watched = { id, face, unsubscribe: face.subscribe(check) };
      check();
    });
    ctx.effect(() => {
      const unsubscribe = sessions.list.subscribe(follow);
      follow();
      return () => { unsubscribe(); watched?.unsubscribe(); watched = null; };
    }, 'evimed-transcript: finished history');
  });

  // An operator's page is the kernel's own transcript, every row of it.
  if (kit.operator || !kit.h) return;
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

  /**
   * The kernel's own row for the researcher's message, over the same message
   * with the platform's model-only block taken out. Registered for both keys
   * the kernel draws it with, and drawn through the entry it shadows, so the
   * row, its actions and its references are the kernel's.
   * @param {any} props
   */
  function UserRow(props) {
    const kind = props?.node?.kind === 'steering' ? 'steering' : 'user';
    const Shipped = kit.shadowed(slot, kind, UserRow);
    if (!Shipped) return null;
    const data = props?.node?.data;
    const content = withoutPlatformBlocks(data?.content);
    return h(Shipped, content === data?.content ? props : { ...props, node: { ...props.node, data: { ...data, content } } });
  }

  // `locale: 'chat'` hands these the chat namespace's translator, which the
  // kernel's context row is drawn with when a recall passes through.
  kit.guarded('system prompt row', () => kit.occupy({ slot, key: 'system-prompt', priority: -1, locale: 'chat' }, HiddenRow));
  kit.guarded('context row', () => kit.occupy({ slot, key: 'context', priority: -1, locale: 'chat' }, ContextRow));
  kit.guarded('unknown event row', () => kit.occupy({ slot, key: 'unknown', priority: -1, locale: 'chat' }, HiddenRow));
  // The shipped user rows carry no `inject` today; `occupyOver` inherits one if a later kernel adds it (E-11).
  kit.guarded('user message row', () => kit.occupyOver({ slot, key: 'user', priority: -1, locale: 'chat' }, UserRow));
  kit.guarded('steering message row', () => kit.occupyOver({ slot, key: 'steering', priority: -1, locale: 'chat' }, UserRow));
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({ name: 'transcript', inject, parts: Object.freeze([mainViewSession, historyWanted, withoutPlatformBlocks, apply]) });
