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
 *    "Preview" badge that describes the kernel's release stage, a local-build
 *    label, a workspace chooser this deployment binds for you.
 *  - The vendor's name used as a verb (「深度求索中」, DeepSeek's own Chinese
 *    name) for the working indicator.
 *  - One object with three names: the kernel says 「{count} 个 subagent」 in the
 *    transcript, 「子代理」 in the subagent catalogue and the workspace status,
 *    and 「子智能体」 in the `/` menu. On a research bench it is a sub-task, and
 *    it is called that everywhere.
 *  - English left inside Chinese sentences (`token`, `surface`, a trailing
 *    `s`), and a key error written for a laptop user who owns the key — a
 *    hosted runtime holds none, so the reader can do nothing about "API 密钥".
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
      'placeholder.hero': '描述你的研究问题或任务… / 调用指令，@ 引用文件或会话',
      'placeholder.default': '继续这项研究，或提出下一个任务… / 调用指令，@ 引用文件或会话',
      // Shown while the composer waits for its workspace; here the control
      // plane binds it, so there is nothing to choose.
      'placeholder.workspace': '正在连接本项目的工作区…',
      // The generic row title of the kernel's code-execution tool.
      'tool.title.code': '运行代码',
    },
    chat: {
      // The working indicator under the last message. The kernel's copy is its
      // vendor's Chinese name plus 中; the product's own name goes there.
      'chat.deepDiving': 'EviMed 思考中…',
      'message.turnProcess.subagents.one': '{count} 个子任务',
      'message.turnProcess.subagents.other': '{count} 个子任务',
      'message.maxTokens': '这一轮的输出达到了长度上限',
      'message.maxTokens.hint': '回答被截断，已写出的内容保留在对话中。发送“继续”即可接着写。',
      'message.failure.auth': '模型服务暂时无法认证。请稍后重试；持续出现请联系管理员。',
      'message.unknownSurface': '无法显示的事件：{type}',
      'message.retry.status': '{label}（{retry}/{maximum}）· {seconds} 秒',
    },
    subagent: {
      'count.total.one': '{count} 个子任务',
      'count.total.other': '{count} 个子任务',
      'count.running.one': '{count} 个子任务，正在运行',
      'count.running.other': '{count} 个子任务，正在运行',
      'switcher.aria': '切换子任务：{title}',
      'tree.aria': '子任务会话',
      'loading.label': '正在加载子任务…',
      'loading.aria': '正在加载子任务',
      'load.error': '无法加载子任务',
      'branch.collapse': '收起 {label} 的下级子任务',
      'branch.expand': '展开 {label} 的下级子任务',
      'diagnostic.unsupported': '子任务记录版本不受支持',
      'readonly.oneShot.title': '一次性子任务记录',
      'readonly.title': '此子任务暂时只读',
    },
    workspace: {
      'status.subagentsRunning.one': '{n} 个子任务运行中',
      'status.subagentsRunning.other': '{n} 个子任务运行中',
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
    // `common` is where every namespace's fallback pass looks last, so a key
    // here surfaces wherever a package asks for it.
    common: {
      'brand.localBuild': 'EviMed 研究运行时',
    },
  };
}

/** The same table, for readers outside the frame (the pack test reads it). */
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
