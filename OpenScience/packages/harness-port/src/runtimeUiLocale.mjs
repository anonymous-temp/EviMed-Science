/**
 * The product's language pack for the kernel's browser application.
 *
 * The kernel ships `zh` and `en` and picks by the browser's `navigator` on a
 * non-loopback page, where the user cannot switch (the General settings row is
 * disabled in the hosted composition). A Chinese product face must not depend
 * on a browser preference, so this registers a private-use language
 * `zh-x-evimed` whose fallback is `zh` and selects it. Lookup walks the
 * fallback chain per key (`zh-x-evimed → zh → en`, then the `common`
 * namespace), so every string this pack does not name stays the kernel's own
 * Chinese. It uses the three-argument `register(ns, locale, dict)` form: the
 * typed two-argument one demands complete `zh` and `en` dictionaries.
 *
 * What the pack rephrases, and why:
 *
 *  - Copy written for a coding agent: "describe what you want to build", a
 *    "Preview" badge that describes the kernel's release stage, a workspace
 *    chooser this deployment binds for you. (The kernel's local-build label,
 *    `brand.localBuild`, is drawn only by the left column this deployment
 *    removes, and is left to the kernel.)
 *  - The vendor's name used as a verb (「深度求索中」, DeepSeek's own Chinese
 *    name) for the working indicator.
 *  - One object with three names: the kernel says 「{count} 个 subagent」 in the
 *    transcript, 「子代理」 in the subagent catalogue and the workspace status,
 *    and 「子智能体」 in the `/` menu. On a research bench it is a sub-task, and
 *    it is called that everywhere.
 *  - English left inside Chinese sentences (`token`, `surface`, a trailing
 *    `s`), and a key error written for a laptop user who owns the key — a
 *    hosted runtime holds none, so the reader can do nothing about "API 密钥".
 *  - Copy that explains the machinery (整改方案 §4, 清单 C §1.3): the
 *    placeholders say what to type and nothing about commands, a truncated
 *    answer says how to go on, a retry says that it is retrying — not which
 *    attempt of how many, nor after how many seconds.
 *  - What Enter does while a run is working. The composer queues a message on
 *    plain Enter and steers it into the running turn on Ctrl/⌘+Enter
 *    (`resolveSubmitMode`, preference `busyEnter`, default `queue`), and the
 *    send button's tooltip — `input.send.queue` while a typed message waits
 *    on a running agent — is where that is said, instead of a line above the
 *    composer for the whole run.
 *
 * `<html lang>`: the locale runtime writes the active language onto the
 * document on every change, and it special-cases only the exact id `zh` (→
 * `zh-CN`), so selecting this pack left `lang="zh-x-evimed"` — a private-use
 * tag that font fallback, hyphenation and screen readers do not know. The
 * pack subscribes to the locale runtime (its documented LocaleFace
 * `subscribe`) after the kernel's own document sync, and puts `zh-CN` back
 * whenever this pack is the active language.
 *
 * @module @evimed/harness-port/runtime-ui-locale
 */

/** Services this body needs: the locale runtime. */
export const inject = ['locale'];

/** The private-use tag of the product's language pack; falls back to `zh`. */
export const EVIMED_LOCALE = 'zh-x-evimed';

/** What the document says its language is while the pack is active. */
export const EVIMED_DOCUMENT_LANG = 'zh-CN';

/**
 * The strings the product rephrases, per kernel namespace. Keys are the
 * kernel's own (read off the pinned client's dictionaries); anything absent
 * here resolves through `zh`.
 *
 * @returns {Record<string, Record<string, string>>}
 */
export function evimedDictionaries() {
  return {
    conversation: {
      'hero.headline': '从一个研究问题开始',
      'hero.preview': '',
      'placeholder.hero': '描述你的研究问题…',
      'placeholder.default': '继续提问…',
      // Shown while the composer waits for its workspace; here the control
      // plane binds it, so there is nothing to choose.
      'placeholder.workspace': '正在连接',
      // The generic row title of the kernel's code-execution tool.
      'tool.title.code': '运行代码',
      // The send button's tooltip and accessible name while a typed message
      // waits on a running agent (see the module note).
      'input.upload': '上传附件',
      'input.commands': '技能与工具',
      'input.send.queue': '排队发送 · Ctrl/⌘+Enter 插话',
      // The wait-for-agents tool and its detail panel (0.1.7).
      'tool.title.waitAgent': '等待子任务',
      'detail.wait.title': '子任务状态',
      'detail.wait.noProgress': '没有正在运行的子任务',
    },
    chat: {
      // The working indicator under the last message. The kernel's copy is its
      // vendor's Chinese name plus 中; the product's own name goes there, as
      // 正在 + a verb with no ellipsis (design reference §7.3, E-13).
      'chat.deepDiving': 'EviMed 正在思考',
      // 0.1.7 draws the running turn's header from this key, with the time so far; the old key above stopped
      // covering it and 「深度求索中，用时 N 秒」 came back on every live conversation (live walk 2026-10-10).
      'message.turnProcess.deepDivingFor': 'EviMed 正在思考，用时 {duration}',
      // A step that delegates: the same sub-task, said as status copy.
      'message.stepProcess.prepare.subagents': '正在准备子任务',
      'message.stepProcess.subagents': '正在协调子任务',
      'message.stepProcess.done.subagents': '已协调子任务',
      // The folded process of a finished turn counts its delegations by this
      // name (「171 次工具调用 · 3 个子任务」).
      'message.turnProcess.subagents.one': '{count} 个子任务',
      'message.turnProcess.subagents.other': '{count} 个子任务',
      'message.maxTokens': '这一轮的输出达到了长度上限',
      'message.maxTokens.hint': '发送“继续”接着写',
      'message.failure.auth': '服务暂时不可用，请稍后重试',
      // Only an operator's transcript draws an event no renderer knows; a
      // researcher's hides the row (the transcript body).
      'message.unknownSurface': '无法显示的事件：{type}',
      // A retry says that it is retrying. The row keeps its state words and
      // drops the attempt count and the countdown.
      'message.retry.status': '{label}',
      'message.retry.active': '正在重试',
      'message.retry.scheduled': '正在重试',
      'message.retry.started': '已重试',
      'message.retry.cancelled': '已取消重试',
    },
    subagent: {
      'count.total.one': '{count} 个子任务',
      'count.total.other': '{count} 个子任务',
      'count.running.one': '{count} 个子任务，正在运行',
      'count.running.other': '{count} 个子任务，正在运行',
      'switcher.aria': '切换子任务：{title}',
      'tree.aria': '子任务会话',
      'loading.label': '正在加载子任务',
      'load.error': '无法加载子任务',
      'branch.collapse': '收起 {label} 的下级子任务',
      'branch.expand': '展开 {label} 的下级子任务',
      'readonly.oneShot.title': '一次性子任务记录',
      'readonly.title': '此子任务暂时只读',
    },
    workspace: {
      'status.subagentsRunning.one': '{n} 个子任务运行中',
      'status.subagentsRunning.other': '{n} 个子任务运行中',
      'archive.confirm.subagents.one': '{n} 个运行中的子任务：{names}',
      'archive.confirm.subagents.other': '{n} 个运行中的子任务：{names}',
    },
    'slash.menu': {
      subagent: '子任务',
    },
    // The kernel's own process view — the timing overview over the per-step
    // ledger — is what this product calls the run (the view ring reads 对话 ·
    // 运行 since 2026-09-22; the product's own 运行 tab it replaced drew a
    // summary of the same run in fewer words).
    trajectory: {
      'view.trajectory': '运行',
    },
    // The goal bar of the LoopX plugin (`dsh-loopx-plugin`, pinned in deps-version.json `loopx`). Its own
    // Chinese names the vendor and an internal lane (「LoopX 目标状态」「Agent 通道待办」); the product calls
    // the feature 长任务, as the /loopx-init command does. Keys are the plugin's, recorded in
    // packages/contracts/loopx/goalbar-locale.json.
    'loopx.goalbar': {
      'region.label': '长任务目标',
      'progress.label': '进度：已完成 {processed} / {total}',
      'progress.empty': '还没有待办',
      'error.cli_unavailable': '长任务工具暂不可用，请刷新后重试',
      'error.binding_read_failed': '读不到这条对话的长任务，请刷新后重试',
      'error.protocol_mismatch': '长任务返回了无法识别的状态，请刷新后重试',
      'error.transport_error': '暂时连不上长任务，请刷新后重试',
      'error.protocol_error': '长任务返回了无法识别的结果，请刷新后重试',
      'error.binding_mismatch': '这条对话的长任务已变化，请刷新后再试',
      'error.binding_validation_failed': '无法核对这条对话的长任务，请刷新后再试',
      'error.action_in_flight': '另一个操作正在进行，请刷新查看结果',
      'error.driver_sync_failed': '长任务已更新，但对话没有同步，请刷新查看',
      'error.post_read_failed': '长任务已更新，但暂时读不到最新状态，请刷新查看',
    },
  };
}

/** The same table, for readers outside the frame (the pack test reads it). */
/**
 * Keys of the pack that are the product's own, not the kernel's: strings our own slot occupants ask for through
 * the kernel's `t` (the composer's upload button, `runtimeUiComposer.mjs`). Every other key rephrases one the
 * pinned kernel has, and `runtimeUiLocaleKernelKeys.test.mjs` holds it to the recorded dictionaries.
 */
export const EVIMED_OWN_KEYS = Object.freeze({ conversation: Object.freeze(['input.upload']) });

export const EVIMED_DICTIONARIES = Object.freeze(Object.fromEntries(
  Object.entries(evimedDictionaries()).map(([ns, dict]) => [ns, Object.freeze(dict)]),
));

/**
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} target Browser global.
 * @param {(id: string) => any} [_require]
 * @param {any} [kit] The frame kit.
 */
export function apply(ctx, _config, target = globalThis, _require = undefined, kit = undefined) {
  if (!kit || !kit.ours) return;
  const locale = ctx.locale;
  if (!locale || typeof locale.addLanguage !== 'function' || typeof locale.register !== 'function' || typeof locale.setLocale !== 'function') return;
  const localeId = 'zh-x-evimed';
  const doc = target.document;
  // After every publish of the locale runtime — which is also when the
  // kernel's own `syncDocumentLanguage` runs, and ours is subscribed after it
  // — so the document ends on `zh-CN` whichever order a change arrives in.
  const syncLang = () => {
    try {
      // `getSnapshot` is the LocaleFace read; the snapshot's `active` is the
      // selected language id.
      const snapshot = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null;
      const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : localeId;
      if (active === localeId && doc?.documentElement) doc.documentElement.lang = 'zh-CN';
    } catch { /* the language still applies; only the attribute is missed */ }
  };
  try {
    ctx.effect(() => locale.addLanguage({ id: localeId, label: '中文', fallback: 'zh' }), 'evimed-locale: language');
    for (const [ns, dict] of Object.entries(evimedDictionaries())) {
      ctx.effect(() => locale.register(ns, localeId, dict), `evimed-locale: ${ns} dictionary`);
    }
    if (typeof locale.subscribe === 'function') ctx.effect(() => locale.subscribe(syncLang), 'evimed-locale: document language');
    locale.setLocale(localeId);
    syncLang();
  } catch (error) {
    // The pack is a refinement; the language is the requirement.
    try { locale.setLocale('zh'); } catch { /* the kernel keeps its browser-derived choice */ }
    target.console?.warn?.('[evimed-locale] language pack unavailable:', error);
  }
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({ name: 'locale', inject, parts: Object.freeze([evimedDictionaries, apply]) });
