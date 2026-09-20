/**
 * The kernel client's slot contracts this frame layer occupies, and the
 * services it reaches, as the pinned client declares them.
 *
 * Transcribed from the `.d.ts` and the registration calls of the 0.1.5-rc.2
 * browser client (the packages the production runtime image serves), not
 * inferred from names. Three rules of that registry decide whether an occupant
 * appears at all, and each has already cost this codebase a shipped no-op:
 *
 *  - A list slot takes `options.id`; a keyed slot takes `options.key`; a chain
 *    slot takes `options.select`. The registry refuses the wrong one with
 *    "requires options.id" — and the refusal, caught by a guard, read as an
 *    occupant that simply never rendered.
 *  - A single slot renders its LOWEST priority and refuses a second entry at an
 *    occupied priority. The kernel's own occupants sit at the default 0, so an
 *    occupant of ours goes below them. The same holds per key in a keyed slot:
 *    a second entry for a shipped key at the same priority is refused, so a
 *    takeover of a shipped key (the chat's `system-prompt` row) goes below too.
 *  - A slot is declared by the `register()` call of the entry that owns its
 *    parent seat. A composition row that is disabled declares nothing, and an
 *    occupant waiting on an undeclared slot waits forever, silently.
 *
 * `declaredBy` names the composition row whose registration declares the slot,
 * so a test can hold every occupied slot to a row the hosted composition
 * actually mounts (the row list is `deploy/runtime-dsh/dump-config.baseline.json`,
 * minus what the control plane's profile patch disables).
 *
 * One correction to earlier notes, read off the pinned code rather than
 * repeated: `conversation.hero.agentPreset` is declared by `ui-conversation`'s
 * own `main.conversation` entry, not by `ui-agent-preset`, which only occupies
 * it. It looked undeclared because it renders inside the hero's workspace row,
 * which the hosted stylesheet used to hide whole.
 *
 * Data only: the build inlines this table into the browser bundle, because the
 * serialized frame bodies may import nothing.
 *
 * @module @evimed/harness-port/runtime-ui-slots
 */

/** The kernel client version these contracts were read from. */
export const RUNTIME_UI_KERNEL_PIN = '0.1.5-rc.2';

/**
 * The chat node kinds `ui-chat` registers (`registerChatNodeRenderers`). A
 * key in this list is a takeover, not an addition.
 */
const CHAT_NODE_KINDS = Object.freeze([
  'user', 'steering', 'context', 'system-prompt', 'assistant-step', 'command', 'manual-compaction',
  'compaction', 'model-retry', 'turn-error', 'turn-max-tokens', 'turn-process', 'turn-tail', 'unknown',
]);

/**
 * The tool names the shipped composition already renders with a keyed view
 * (`ui-tool`'s own rows, `ui-skill`, `ui-deliverables`, `ui-cordis`,
 * `ui-user-questions`). None of ours is among them; the list exists so a
 * future takeover is made deliberately, below the shipped entry.
 */
const SHIPPED_TOOL_VIEW_KEYS = Object.freeze([
  'ask_user_question', 'bash', 'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine', 'edit', 'glob',
  'grep', 'present', 'read', 'read_image', 'skill', 'todo_write', 'web_fetch', 'web_search', 'write',
]);

/**
 * @typedef {object} RuntimeUiSlotContract
 * @property {'single'|'list'|'keyed'|'chain'} kind
 * @property {'root'|'session'|'session-maybe'} scope
 * @property {string} declaredBy the composition row whose registration declares it
 * @property {readonly string[]} [shippedKeys] keyed slots only: keys a shipped entry already holds
 */

/** @type {Readonly<Record<string, RuntimeUiSlotContract>>} */
export const RUNTIME_UI_SLOTS = Object.freeze({
  // The whole left column (ui-layout's AppFrame declares it).
  sidebar: Object.freeze({ kind: 'single', scope: 'root', declaredBy: 'ui-layout' }),
  // Declared by the left column's own entry, which stays registered under our
  // occupant — so these stay declared and are the fallback brand.
  'sidebar.brand.mark': Object.freeze({ kind: 'single', scope: 'root', declaredBy: 'ui-sidebar' }),
  'sidebar.brand.name': Object.freeze({ kind: 'single', scope: 'root', declaredBy: 'ui-sidebar' }),
  // The blank-session hero: `main.conversation`'s children table.
  'conversation.hero.brand.mark': Object.freeze({ kind: 'single', scope: 'root', declaredBy: 'ui-conversation' }),
  'conversation.hero.workspace': Object.freeze({ kind: 'single', scope: 'root', declaredBy: 'ui-conversation' }),
  'conversation.hero.agentPreset': Object.freeze({ kind: 'single', scope: 'root', declaredBy: 'ui-conversation' }),
  // The conversation's own view ring: one entry per tab, rendered one at a
  // time, with the tab strip in the session header. `ui-chat` holds `chat` at
  // order 0 and `ui-trajectory` holds `trajectory` (operator-only here), so an
  // entry of ours adds a tab beside them rather than replacing either. The
  // registration's `label` is read through the kernel's own label resolver and
  // may be a thunk, so it re-reads on a language change.
  'conversation.view': Object.freeze({ kind: 'list', scope: 'session', declaredBy: 'ui-conversation' }),
  // Above the composer card: `main.conversation`'s children table.
  'conversation.input.dock': Object.freeze({ kind: 'list', scope: 'session', declaredBy: 'ui-conversation' }),
  // The composer: `conversation.composer.bar`'s children table.
  'conversation.input.attachments': Object.freeze({ kind: 'single', scope: 'session-maybe', declaredBy: 'ui-conversation' }),
  'conversation.input.right': Object.freeze({ kind: 'list', scope: 'session', declaredBy: 'ui-conversation' }),
  // The transcript: the `chat` view's children table.
  'conversation.chat.node': Object.freeze({ kind: 'keyed', scope: 'session', declaredBy: 'ui-chat', shippedKeys: CHAT_NODE_KINDS }),
  // One tool call's row: ui-tool's `tool-call` chat node declares it.
  'tool.call.toolview': Object.freeze({ kind: 'keyed', scope: 'session', declaredBy: 'ui-tool', shippedKeys: SHIPPED_TOOL_VIEW_KEYS }),
  // The right sidebar's tab bodies and live titles.
  'sidebar.right.pane.tab': Object.freeze({ kind: 'keyed', scope: 'session', declaredBy: 'ui-sidebar-right' }),
  'sidebar.right.pane.tab.title': Object.freeze({ kind: 'keyed', scope: 'session', declaredBy: 'ui-sidebar-right' }),
});

/**
 * Services the frame bodies use beyond the slot registry and the locale
 * runtime, with the composition row that provides each and the client package
 * `dsh.client.inject` must name so the loader delivers it first.
 *
 * Reached through `ctx.inject` inside the body that needs it — never required
 * at plugin level: a required service that is absent parks the whole plugin,
 * the navigation bridge included, and one missing panel must not take the
 * conversation down with it.
 */
export const RUNTIME_UI_OPTIONAL_SERVICES = Object.freeze({
  theme: Object.freeze({ row: 'ui-theme', package: '@deepseek-ai/dsh-client-ui-theme' }),
  layout: Object.freeze({ row: 'ui-layout', package: '@deepseek-ai/dsh-client-ui-layout' }),
  sidebarRight: Object.freeze({ row: 'ui-sidebar-right', package: '@deepseek-ai/dsh-client-ui-sidebar-right' }),
  sidebarRightTabs: Object.freeze({ row: 'ui-sidebar-right', package: '@deepseek-ai/dsh-client-ui-sidebar-right' }),
  commandUi: Object.freeze({ row: 'ui-commands', package: '@deepseek-ai/dsh-client-ui-commands' }),
  inputTriggers: Object.freeze({ row: 'ui-input-trigger', package: '@deepseek-ai/dsh-client-ui-input-trigger' }),
});

/**
 * Services a body requires outright, with their providers. These are the ones
 * every hosted page already has; the navigation bridge cannot work without the
 * first four and the brand cannot without the last two.
 */
export const RUNTIME_UI_REQUIRED_SERVICES = Object.freeze({
  sessions: Object.freeze({ row: 'session-controller', package: '@deepseek-ai/dsh-api-session-controller' }),
  conversation: Object.freeze({ row: 'ui-conversation', package: '@deepseek-ai/dsh-client-ui-conversation' }),
  connection: Object.freeze({ row: 'connection', package: '@deepseek-ai/dsh-client-connection' }),
  workspaces: Object.freeze({ row: 'workspace-controller', package: '@deepseek-ai/dsh-api-workspace-controller' }),
  slots: Object.freeze({ row: 'ui-renderer', package: '@deepseek-ai/dsh-client-ui-renderer' }),
  locale: Object.freeze({ row: 'locale', package: '@deepseek-ai/dsh-client-locale' }),
});
