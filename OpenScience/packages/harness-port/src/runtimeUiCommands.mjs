/**
 * The research tools, offered where the typing happens: a chip in the
 * composer's own toolbar for the one you picked (on 科研工具, or with `/工具`),
 * its example questions under the headline while the conversation is still
 * blank, a `/工具` command in the kernel's own slash menu, and `@` references to
 * the researcher's knowledge base.
 *
 * The blank conversation is the kernel's own: a headline and one composer, as
 * in DeepSeek, ChatGPT, Claude and Gemini. It carried a grid of eight tool
 * cards until 2026-09-22, then a page for the chosen tool — its summary,
 * outputs, limits and starters above the composer — until later that day,
 * when the owner saw it on a wide screen: the page had no width of its own,
 * so it stretched the hero and the composer under it to the frame's edge
 * (「首页进去的输入框那么宽」, 「对话框上边一堆啥排版都是」). ChatGPT, Claude
 * and Gemini show a chosen tool or mode as a chip attached to the composer
 * and nothing more; the tool's description stays on the page it was chosen
 * from. So: a chip, the starters as small pills while there is nothing to
 * read yet, and the composer keeps the kernel's own width.
 *
 * Where the chip sits (E-17, 2026-10-08). It stood in the row under the
 * composer card, after the kernel's session statistics, with the two modules'
 * options as native selects beside it; on 2026-10-08 the owner saw that row
 * and said everything was 「堆到了最底下」 with 「一点没有底部的空白」: the
 * kernel gives that row 4 px above the window's edge, and a select is as wide
 * as its longest option. The chip is now in the toolbar inside the card
 * (`conversation.input.left`, after the paperclip), as ChatGPT keeps a chosen
 * tool, with its one-click 「×」; the two modules' options are the chip's own
 * menu, which opens upward, and the chip names an option only when it is not
 * at its default (「虚拟临床研究 · 队列」). Nothing of ours is under the card.
 *
 * The blank conversation. The toolbar's seats render when the composer has a
 * session (`conversation.input.left` needs one), and a conversation the shell
 * has created has its session from the first moment — measured on a booted
 * 0.1.7-rc.2: the blank hero composer carries the paperclip and the chip in its
 * toolbar, and a chip in the hero seat as well made two. So the chip is in the
 * toolbar from the start, as it stays once the conversation has begun (it does
 * not jump), and the hero seat carries it only for a composer with no toolbar —
 * a frame that has no session yet — together with the starters, which are the
 * hero's alone.
 *
 * Hidden knowledge, read off the pinned 0.1.5-rc.2 client:
 *
 *  - `ctx.commandUi.register({ name, description, available, ui })`
 *    (`dsh-client-ui-commands`) adds a client-owned slash command. A
 *    `popupSelect` opens the kernel's own searchable popup; its rows are a
 *    label and one line of detail, filtered by substring over both — so the
 *    category and the one-line summary go in the detail, and typing 「证据」
 *    finds rows by them. How long a tool usually takes is said once, on 科研工具
 *    where it is chosen, and nowhere after (整改方案 §5.3). A contribution
 *    whose name collides with a host command fails loud at candidate synthesis
 *    and takes the whole menu with it; host commands are ASCII identifiers, and
 *    this one's name is not.
 *  - `conversation.input.left` is a list seat in the toolbar inside the card,
 *    after the kernel's own `+` and our paperclip. Its container is a flex
 *    item that may shrink (`min-width: 0`) in a row that WRAPS and measures
 *    its children's natural widths (`observeControlRow`: it collapses the model
 *    name to an icon when they do not fit on a line, and the row wraps only
 *    when even that does not help). A chip as wide as its label would wrap the
 *    toolbar at 390 px, so its width is held to what is left of the row: the
 *    row is a size container (`container-type: inline-size`), and the chip's
 *    `max-width` is a function of `100cqw`.
 *  - `conversation.composer.dock`, directly under the card, is the kernel's
 *    (session statistics, the context ring) and is not ours.
 *  - `ctx.inputTriggers.registerSource({ trigger: '@', … })` adds a group to
 *    the `@` menu. A pick inserts a reference chip; `codec.serialize` is what
 *    the model receives for it at send time. The page cannot read the
 *    control plane's source list, so the candidates are asked of the shell
 *    (`kb-query` → `kb-result`), which answers from the sources this project
 *    already parsed.
 *
 * A 循证 GEO conversation (bound to any of the module's capabilities) reads
 * 「循证 GEO」 on its chip whether or not the catalogue lists the capability —
 * the module hides them from 科研工具 — and, once the shell has found the
 * GEO project this conversation belongs to (`geo`), carries two optional
 * settings in the chip's menu, 覆盖周期 and AI 引擎, which report a change back
 * (`geo-options`) for the shell to write to the project; its starters are the
 * module's single steps, a short name on each pill and a whole sentence into
 * the composer, never sent. The composer bar itself has no seat on the blank
 * conversation (`conversation.input.left` renders only with a session), so the
 * chip and its menu sit in the hero seat there, and in the toolbar once the
 * conversation has started.
 *
 * A 虚拟临床研究 conversation reads 「虚拟临床研究」 on its chip the same way and, once
 * the shell has found the study this conversation belongs to (`vcr`), carries
 * two optional settings in the chip's menu — 起点 (自动 / 队列 / 患者 / 对照 / 试验)
 * and 预期用途 (默认「探索」) — which report a change back (`vcr-options`) for
 * the shell to write to the study, and six single-task starters: a short name
 * on each pill and a whole sentence into the composer, never sent. There is
 * no form; anything the reader does not say the platform sets and labels
 * 「AI 设定」 (plan §9.3).
 *
 * Picking a tool binds this conversation to it through the shell
 * (`bind-capability`), which is the control plane's own deterministic route —
 * the same one the capabilities page has always used. It no longer writes
 * 「请以「X」能力完成以下任务：」 into the draft: that prefix became the
 * conversation's title, and the router re-decided the capability anyway with a
 * classifier the researcher had already answered for.
 *
 * @module @evimed/harness-port/runtime-ui-commands
 */

import { mainViewSession } from './runtimeUiKit.mjs';
import { frameStyles } from './runtimeUiStyles.mjs';

/** Services this body needs outright. */
export const inject = ['slots', 'sessions', 'conversation'];

/**
 * The slash popup's rows: every public tool a researcher picks from, in
 * catalogue order (which is by category), the category first in the detail
 * line. A tool its own module opens (`listed: false`, the 「循证 GEO」
 * capabilities) stays in the catalogue for its chip and is not a row here;
 * `hidden` names any other tool entered elsewhere.
 * @param {any[]} capabilities the frame's validated catalogue
 * @param {readonly string[]} [hidden]
 * @returns {{ id: string, label: string, detail: string }[]}
 */
export function capabilityOptions(capabilities, hidden = []) {
  return (Array.isArray(capabilities) ? capabilities : [])
    .filter((entry) => entry && !entry.internal && entry.listed !== false && entry.id && entry.title && !hidden.includes(entry.id))
    .map((entry) => ({
      id: String(entry.id),
      label: String(entry.title),
      detail: [entry.category, entry.summary].filter((part) => typeof part === 'string' && part).join(' · '),
    }));
}

/**
 * The tool this conversation runs, as the chip and the starters read it: its
 * name and three questions to start from. What it does, how long it takes,
 * what it hands back, needs and cannot do stays on 科研工具, where the tool
 * was chosen.
 *
 * A conversation bound to one of 循证 GEO's capabilities reads 「循证 GEO」
 * whichever of them it is, and whether or not the catalogue lists it: the
 * module hides its capabilities from 科研工具 with a display flag, and the
 * chip must still say what the conversation runs.
 * @param {any[]} capabilities @param {unknown} id
 * @param {{ title?: string, capabilities?: readonly string[] } | null |
 *   readonly ({ title?: string, capabilities?: readonly string[], geo?: boolean, vcr?: boolean } | null)[]} [modules]
 *   the vocabulary's module entries (GEO's, 虚拟临床研究's); one entry is accepted
 *   as itself, because that is what every caller passed before the second
 *   module existed.
 */
export function toolPageModel(capabilities, id, modules = null) {
  const key = String(id ?? '');
  const entries = Array.isArray(modules) ? modules : [modules];
  for (const entry of entries) {
    if (!entry || typeof entry.title !== 'string' || !Array.isArray(entry.capabilities)) continue;
    if (!entry.capabilities.includes(key)) continue;
    // `geo: true` and `vcr: true` are what draw a module's composer controls,
    // so each is the entry's to claim rather than this function's to assume: a
    // module with neither is only a chip.
    return { id: key, title: entry.title, category: '', summary: '', outputs: [], limits: [], materials: '', starters: [],
      geo: entry.geo === true, vcr: entry.vcr === true, module: true };
  }
  const entry = (Array.isArray(capabilities) ? capabilities : []).find((candidate) => candidate && candidate.id === key && !candidate.internal);
  if (!entry) return null;
  return {
    id: entry.id,
    title: String(entry.title),
    category: String(entry.category || ''),
    summary: String(entry.summary || ''),
    outputs: Array.isArray(entry.outputs) ? entry.outputs : [],
    limits: Array.isArray(entry.limits) ? entry.limits : [],
    materials: typeof entry.materials === 'string' ? entry.materials : '',
    starters: Array.isArray(entry.starters) ? entry.starters : [],
  };
}

/**
 * The `@` menu's knowledge-base rows, from the shell's answer.
 * @param {any} result the shell's `kb-result`
 * @returns {{ name: string, description?: string, icon: 'file', value: string }[]}
 */
export function knowledgeCandidates(result) {
  if (!result || result.ok === false || !Array.isArray(result.items)) return [];
  return result.items
    .filter((/** @type {any} */ item) => item && typeof item.id === 'string' && /^src_[A-Za-z0-9_-]{1,120}$/.test(item.id))
    .map((/** @type {any} */ item) => {
      const title = String(item.title || item.id).slice(0, 200);
      return {
        name: title,
        ...(item.detail ? { description: String(item.detail).slice(0, 200) } : {}),
        icon: /** @type {'file'} */ ('file'),
        value: JSON.stringify({ id: item.id, title }),
      };
    });
}

/**
 * A knowledge reference as the chip carries it (`ref`), read back.
 * @param {unknown} ref
 * @returns {{ id: string, title: string } | null}
 */
export function knowledgeReference(ref) {
  try {
    const value = JSON.parse(String(ref));
    return value && typeof value.id === 'string' && /^src_[A-Za-z0-9_-]{1,120}$/.test(value.id)
      ? { id: value.id, title: typeof value.title === 'string' && value.title ? value.title : value.id }
      : null;
  } catch {
    return null;
  }
}

/**
 * The sent message keeps the source title. Identifiers and read paths reach the
 * model through the saved session scope and its control-plane context note.
 * @param {unknown} ref @param {string} _knowledgeDir
 * @returns {string}
 */
export function knowledgeSerialization(ref, _knowledgeDir) {
  const reference = knowledgeReference(ref);
  if (!reference) throw new Error('知识库引用无法识别');
  return `“${reference.title}”`;
}

/**
 * What a module's chip says beyond its name: nothing while every setting is at
 * its default, the one setting that is not (「队列」, 「180 天」, 「3 个引擎」), and
 * 「2 项设置」 when both are — so the chip stays short and a reader still sees
 * that this conversation is not on the defaults.
 *
 * The defaults are the platform's (`FRAME_VOCABULARY.chipDefaults`, from the
 * domain); a setting the reader may not change is never named, because it is
 * not the reader's.
 * @param {{ geo?: boolean, vcr?: boolean } | null} model
 * @param {any} geoOptions the shell's `geo` message
 * @param {any} vcrOptions the shell's `vcr` message
 * @param {{ geo?: { coverageDays?: number, engines?: readonly string[] }, vcr?: { start?: string, intendedUse?: string } }} [defaults]
 * @returns {string}
 */
export function chipSuffix(model, geoOptions, vcrOptions, defaults = {}) {
  if (!model) return '';
  /** @type {string[]} */
  const changed = [];
  /** @param {unknown} list @param {unknown} id */
  const labelOf = (list, id) => {
    const hit = (Array.isArray(list) ? list : []).find((/** @type {any} */ choice) => choice && choice.id === id);
    return hit ? String(hit.label) : '';
  };
  if (model.vcr && vcrOptions && vcrOptions.controls) {
    const base = defaults.vcr ?? {};
    const mayStart = Array.isArray(vcrOptions.startOptions) && vcrOptions.startOptions.length > 0;
    if (mayStart && base.start && vcrOptions.start && vcrOptions.start !== base.start) changed.push(labelOf(vcrOptions.startOptions, vcrOptions.start));
    if (vcrOptions.canSetUse && base.intendedUse && vcrOptions.intendedUse && vcrOptions.intendedUse !== base.intendedUse) changed.push(labelOf(vcrOptions.useOptions, vcrOptions.intendedUse));
  } else if (model.geo && geoOptions && geoOptions.controls) {
    const base = defaults.geo ?? {};
    if (base.coverageDays && Number.isInteger(geoOptions.coverageDays) && geoOptions.coverageDays !== base.coverageDays) changed.push(`${geoOptions.coverageDays} 天`);
    const engines = Array.isArray(geoOptions.engines) ? geoOptions.engines : [];
    const standard = Array.isArray(base.engines) ? base.engines : [];
    if (standard.length && engines.length && (engines.length !== standard.length || engines.some((/** @type {string} */ engine) => !standard.includes(engine)))) changed.push(`${engines.length} 个引擎`);
  }
  const named = changed.filter(Boolean);
  if (!named.length) return '';
  return named.length === 1 ? named[0] : `${named.length} 项设置`;
}

/**
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} target Browser global.
 * @param {(id: string) => any} [_require]
 * @param {any} [kit] The frame kit.
 */
export function apply(ctx, _config, target = globalThis, _require = undefined, kit = undefined) {
  if (!kit || !kit.ours || !kit.h) return;
  const h = kit.h;
  const React = kit.react;
  const { text: textStyle, textButton } = frameStyles();
  const catalogue = kit.frame.capabilities.filter((/** @type {any} */ entry) => !entry.internal);
  const knowledgeDir = String(kit.vocabulary?.knowledgeDir || '.evimed-knowledge');
  /** @type {{ title: string, capabilities: readonly string[], geo?: boolean } | null} */
  const geo = kit.vocabulary?.geo && Array.isArray(kit.vocabulary.geo.capabilities)
    ? { ...kit.vocabulary.geo, geo: true } : null;
  /** @type {{ title: string, capabilities: readonly string[], vcr?: boolean } | null} */
  const vcr = kit.vocabulary?.vcr && Array.isArray(kit.vocabulary.vcr.capabilities)
    ? { ...kit.vocabulary.vcr, vcr: true } : null;
  // Hidden from `/工具` for the same reason in both cases: a module's
  // capabilities are entered from its own sidebar row, never picked here.
  const geoIds = [...(geo ? geo.capabilities : []), ...(vcr ? vcr.capabilities : [])];
  /** @param {string | null} id */
  const modelOf = (id) => (id ? toolPageModel(catalogue, id, [geo, vcr]) : null);

  // Which tool this conversation runs. The control plane owns the answer — it
  // binds the session and tells the frame — and this holds the optimistic one
  // between the pick and that confirmation, so the page never reads as if the
  // click did nothing.
  /** @type {{ id: string | null }} */
  const tool = { id: null };
  /** @type {Set<() => void>} */
  const toolListeners = new Set();
  /** @param {string | null} id */
  const setTool = (id) => {
    if (tool.id === id) return;
    tool.id = id;
    for (const listener of [...toolListeners]) { try { listener(); } catch { /* a listener must not stop the others */ } }
  };
  const useTool = () => React.useSyncExternalStore(
    (/** @type {() => void} */ listener) => { toolListeners.add(listener); return () => { toolListeners.delete(listener); }; },
    () => tool.id, () => tool.id,
  );

  const currentSession = () => {
    try { return mainViewSession(ctx.sessions?.list?.getSnapshot?.()); } catch { return null; }
  };
  /** The composer's own text, so choosing a tool never costs a typed question. */
  /** @param {string | null} sessionId */
  const draftOf = (sessionId) => {
    try {
      const scope = sessionId && typeof ctx.sessions?.scope === 'function' ? ctx.sessions.scope(sessionId) : null;
      const state = scope && ctx.conversation?.input ? ctx.conversation.input.for(scope).state?.getSnapshot?.() : null;
      return typeof state?.draft === 'string' ? state.draft.slice(0, 100_000) : '';
    } catch { return ''; }
  };
  /**
   * Choosing a tool is the control plane binding this conversation to it. A
   * binding is fixed once the conversation has run something, so the shell may
   * answer by opening a fresh conversation instead — which is why the draft
   * travels with the request.
   * @param {string | null} id
   */
  const bind = (id) => {
    setTool(id);
    const sessionId = currentSession();
    kit.hub.send('bind-capability', { capabilityId: id, sessionId, draft: draftOf(sessionId) });
  };

  // The shell's answer, and a conversation switch. A tool belongs to a
  // conversation, so moving to another one drops it until the shell says what
  // that one runs.
  ctx.effect(() => kit.hub.on('capability', (/** @type {any} */ data) => {
    setTool(data && typeof data.capabilityId === 'string' ? data.capabilityId : null);
  }), 'evimed-commands: bound capability');
  ctx.effect(() => kit.hub.on('session', () => { setTool(null); setGeoOptions(null); setVcrOptions(null); }), 'evimed-commands: capability follows the conversation');

  // 循证 GEO's two options for the project this conversation belongs to —
  // 覆盖周期 and AI 引擎 — and its single-step starters, as the shell reads them
  // from the control plane (`geo`). The frame shows them and reports a change
  // (`geo-options`); the shell writes it to the project. Nothing here decides.
  /** @type {{ value: any }} */
  const geoOptions = { value: null };
  /** @type {Set<() => void>} */
  const geoListeners = new Set();
  /** @param {any} value */
  function setGeoOptions(value) {
    if (geoOptions.value === value) return;
    geoOptions.value = value;
    for (const listener of [...geoListeners]) { try { listener(); } catch { /* a listener must not stop the others */ } }
  }
  const useGeoOptions = () => React.useSyncExternalStore(
    (/** @type {() => void} */ listener) => { geoListeners.add(listener); return () => { geoListeners.delete(listener); }; },
    () => geoOptions.value, () => geoOptions.value,
  );
  ctx.effect(() => kit.hub.on('geo', (/** @type {any} */ data) => {
    setGeoOptions(data && typeof data === 'object' && Array.isArray(data.starters) ? data : null);
  }), 'evimed-commands: GEO options');
  /**
   * A changed option, shown at once and sent to the shell, which writes it to
   * the project and answers with what the project now holds.
   * @param {{ coverageDays?: number, engines?: string[] }} patch
   */
  const changeGeo = (patch) => {
    if (!geoOptions.value) return;
    setGeoOptions({ ...geoOptions.value, ...patch });
    kit.hub.send('geo-options', { sessionId: currentSession(), ...patch });
  };

  // 虚拟临床研究's two options for the study this conversation belongs to — 起点 and
  // 预期用途 — and its single-task starters, as the shell reads them from the
  // control plane (`vcr`). Same contract as GEO's: the frame shows them and
  // reports a change (`vcr-options`); the shell writes it to the study. A
  // control that was refused comes back as the value the study holds.
  /** @type {{ value: any }} */
  const vcrOptions = { value: null };
  /** @type {Set<() => void>} */
  const vcrListeners = new Set();
  /** @param {any} value */
  function setVcrOptions(value) {
    if (vcrOptions.value === value) return;
    vcrOptions.value = value;
    for (const listener of [...vcrListeners]) { try { listener(); } catch { /* a listener must not stop the others */ } }
  }
  const useVcrOptions = () => React.useSyncExternalStore(
    (/** @type {() => void} */ listener) => { vcrListeners.add(listener); return () => { vcrListeners.delete(listener); }; },
    () => vcrOptions.value, () => vcrOptions.value,
  );
  ctx.effect(() => kit.hub.on('vcr', (/** @type {any} */ data) => {
    setVcrOptions(data && typeof data === 'object' && Array.isArray(data.starters) ? data : null);
  }), 'evimed-commands: 虚拟临床研究 options');
  /**
   * A changed option, shown at once and sent to the shell, which writes it to
   * the study and answers with what the study now holds.
   * @param {{ start?: string, intendedUse?: string }} patch
   */
  const changeVcr = (patch) => {
    if (!vcrOptions.value) return;
    setVcrOptions({ ...vcrOptions.value, ...patch });
    kit.hub.send('vcr-options', { sessionId: currentSession(), ...patch });
  };

  /**
   * Put a question in the composer of the session on screen; with none open,
   * ask the shell for a new conversation carrying it.
   * @param {string} text
   */
  const fill = (text) => {
    const sessionId = currentSession();
    const scope = sessionId && typeof ctx.sessions?.scope === 'function' ? ctx.sessions.scope(sessionId) : null;
    if (scope && ctx.conversation?.input) {
      ctx.conversation.input.for(scope).setDraft(text);
      return;
    }
    target.__EVIMED_SHELL__?.navigate?.('new-task', text);
  };

  // `/工具`: the whole catalogue, searchable, in the kernel's own popup.
  kit.withServices(['commandUi'], (/** @type {any} */ scope) => {
    const options = capabilityOptions(catalogue, geoIds);
    if (!options.length) return;
    scope.effect(() => scope.commandUi.register({
      name: '工具',
      description: () => '选择科研工具',
      available: () => true,
      ui: {
        kind: 'popupSelect',
        options: async () => options,
        /** @param {{ id: string }} option */
        onSelect(option) { bind(String(option.id)); },
      },
    }), 'evimed-commands: /工具');
  });

  if (React && (catalogue.length || geoIds.length)) {
    const starterText = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    // The chip: a 24 px capsule in the accent's soft fill — the page's one
    // accent (整改方案 §4) — with no outline.
    const chipStyle = {
      display: 'inline-flex', alignItems: 'center', gap: '2px', minWidth: 0, boxSizing: 'border-box',
      height: '24px', padding: '0 4px 0 8px', borderRadius: '999px', fontSize: '12px', lineHeight: '24px',
      background: 'var(--dsw-alias-state-business-tertiary)', color: 'var(--dsw-alias-state-business-primary)',
    };
    // In the toolbar the chip may take what the row has left and no more: the
    // row (`.row`, a size container) holds the `+`, the paperclip, the model
    // and the send button, which the kernel shrinks to icons when the line is
    // short, so about 194 px of the row's width is not the chip's (measured on
    // 0.1.7-rc.2 at 390 px: 70 for `+` and the paperclip, 8 and 12 of gaps, 96
    // for the collapsed model and the send button, and 4 to spare). Past that
    // the label gives way with an ellipsis instead of wrapping the toolbar.
    const barChipBudget = 'max(56px, calc(100cqw - 194px))';
    // A starter: a 32 px capsule with the one hairline, in the secondary ink.
    const starterStyle = {
      ...textStyle, display: 'inline-flex', alignItems: 'center', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box',
      height: '32px', padding: '0 12px', borderRadius: '999px', cursor: 'pointer', fontFamily: 'inherit',
      border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
    };
    // The defaults the chip leaves unnamed (`FRAME_VOCABULARY`, from the domain).
    const defaults = kit.vocabulary?.chipDefaults ?? {};

    // The chip's menu: a small popover that opens upward, in the kernel's own
    // menu surface. Each setting is a labelled group of choices — a radio group
    // of pills, or (the engines) a list of checkboxes — so nothing is as wide
    // as its longest option.
    const menuStyle = {
      position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 40, boxSizing: 'border-box',
      width: 'max-content', minWidth: '224px', maxWidth: 'min(320px, calc(100vw - 16px))',
      display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px', borderRadius: '12px',
      border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3))',
      color: 'var(--dsw-alias-label-primary)', fontSize: '12px', lineHeight: '20px', textAlign: 'left',
      boxShadow: 'var(--dsw-elevation-panel, 0 4px 16px rgba(0,0,0,.12))',
    };
    const groupLabelStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '20px', marginBottom: '4px' };
    const choiceStyle = {
      ...textButton, display: 'inline-flex', alignItems: 'center', height: '24px', lineHeight: '24px', padding: '0 10px',
      borderRadius: '999px', fontSize: '12px', color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-interactive-bg-hover)',
    };
    const chosenStyle = { background: 'var(--dsw-alias-state-business-tertiary)', color: 'var(--dsw-alias-state-business-primary)', fontWeight: 600 };

    /**
     * One setting: its name, and its choices as a radio group. The chosen one
     * is the group's value, so a reader sees the setting, not only its change.
     * @param {{ name: string, choices: { id: string, label: string }[], value: string | null, onPick: (id: string) => void }} props
     */
    const ChoiceGroup = ({ name, choices, value, onPick }) => h('div', { role: 'radiogroup', 'aria-label': name },
      h('div', { style: groupLabelStyle, 'aria-hidden': 'true' }, name),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } }, choices.map((choice) => {
        const chosen = choice.id === value;
        return h('button', {
          key: choice.id, type: 'button', role: 'radio', 'aria-checked': chosen, onClick: () => { if (!chosen) onPick(choice.id); },
          style: chosen ? { ...choiceStyle, ...chosenStyle } : choiceStyle,
        }, choice.label);
      })));

    /** 循证 GEO's two settings: 覆盖周期, and which AI 引擎 to measure (one always stays on). */
    const GeoMenu = () => {
      const options = useGeoOptions();
      if (!options || !options.controls) return null;
      const engines = Array.isArray(options.engines) ? options.engines : [];
      const offered = Array.isArray(options.offered) ? options.offered : [];
      /** @param {string} engine */
      const toggle = (engine) => {
        const next = engines.includes(engine) ? engines.filter((/** @type {string} */ item) => item !== engine) : [...engines, engine];
        const order = offered.map((/** @type {any} */ item) => item.id);
        if (next.length) changeGeo({ engines: order.filter((/** @type {string} */ item) => next.includes(item)) });
      };
      return h(React.Fragment, null,
        h(ChoiceGroup, {
          name: '覆盖周期', value: String(options.coverageDays ?? ''),
          choices: (Array.isArray(options.coverageOptions) ? options.coverageOptions : []).map((/** @type {number} */ days) => ({ id: String(days), label: `${days} 天` })),
          onPick: (/** @type {string} */ id) => changeGeo({ coverageDays: Number(id) }),
        }),
        h('div', { role: 'group', 'aria-label': 'AI 引擎' },
          h('div', { style: groupLabelStyle, 'aria-hidden': 'true' }, 'AI 引擎'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, offered.map((/** @type {{ id: string, name: string }} */ engine) => {
            const checked = engines.includes(engine.id);
            return h('label', { key: engine.id, style: { display: 'flex', alignItems: 'center', gap: '8px', minHeight: '24px', cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked, disabled: checked && engines.length === 1, onChange: () => toggle(engine.id) }),
              engine.name);
          }))));
    };

    /**
     * 虚拟临床研究's two settings: 起点, and 预期用途. Each is offered only to a
     * reader who may change it (`startOptions` is empty for one who may not
     * write; 预期用途 is the lead's, `canSetUse`), so the menu never offers a
     * control the server would refuse.
     */
    const VcrMenu = () => {
      const options = useVcrOptions();
      if (!options || !options.controls) return null;
      const startOptions = Array.isArray(options.startOptions) ? options.startOptions : [];
      const useOptions = Array.isArray(options.useOptions) ? options.useOptions : [];
      return h(React.Fragment, null,
        startOptions.length ? h(ChoiceGroup, { name: '起点', choices: startOptions, value: options.start ?? null, onPick: (/** @type {string} */ id) => changeVcr({ start: id }) }) : null,
        options.canSetUse && useOptions.length ? h(ChoiceGroup, { name: '预期用途', choices: useOptions, value: options.intendedUse ?? null, onPick: (/** @type {string} */ id) => changeVcr({ intendedUse: id }) }) : null);
    };

    /**
     * The chip: which tool this conversation runs, the way out of it, and for
     * the two modules the menu of its settings. In a session the hero is gone,
     * so this is the only place that says it. The name alone: what the tool
     * does and how long it takes were said on 科研工具, where it was chosen.
     *
     * `placement` is where it is drawn: `bar` (the toolbar inside the composer
     * card, width held to what the row has left) or `hero` (the blank
     * conversation's seat). The 「×」 is its own button — one click removes the
     * tool — and the menu is the label's: a second button, so a click on the
     * name never removes anything.
     * @param {{ placement?: 'bar' | 'hero' }} props
     */
    const ToolChip = ({ placement = 'bar' }) => {
      const id = useTool();
      const geoState = useGeoOptions();
      const vcrState = useVcrOptions();
      const model = modelOf(id);
      const [open, setOpen] = React.useState(false);
      const wrap = React.useRef(null);
      const trigger = React.useRef(null);
      const menuRef = React.useRef(null);
      const menuId = React.useId();
      // The menu is anchored to the chip, which sits to the right of `+` and the
      // paperclip; on a narrow screen that would put its right edge past the
      // window's. It is slid back inside the window once it is measured.
      const [slide, setSlide] = React.useState(0);
      const settings = model && model.geo ? geoState : model && model.vcr ? vcrState : null;
      const hasMenu = Boolean(model && settings && settings.controls
        && (model.geo || (Array.isArray(settings.startOptions) && settings.startOptions.length) || (settings.canSetUse && Array.isArray(settings.useOptions) && settings.useOptions.length)));
      const menuOpen = open && hasMenu;
      const suffix = model ? chipSuffix(model, geoState, vcrState, defaults) : '';
      const label = model ? (suffix ? `${model.title} · ${suffix}` : model.title) : '';
      React.useLayoutEffect(() => {
        const menu = menuRef.current;
        if (!menuOpen || !menu || typeof menu.getBoundingClientRect !== 'function') { setSlide(0); return; }
        const width = Number(target.innerWidth) || 0;
        if (!width) return;
        // Measured with no slide applied (the style below is only ever the last one set).
        const rect = menu.getBoundingClientRect();
        const margin = 8;
        let by = 0;
        if (rect.right - slide > width - margin) by = (width - margin) - (rect.right - slide);
        if (rect.left - slide + by < margin) by = margin - (rect.left - slide);
        setSlide(Math.round(by));
      }, [menuOpen, label]);
      React.useEffect(() => {
        if (!menuOpen) return undefined;
        const doc = target.document;
        if (!doc || typeof doc.addEventListener !== 'function') return undefined;
        /** @param {any} event */
        const outside = (event) => { if (wrap.current && !wrap.current.contains(event.target)) setOpen(false); };
        /** @param {any} event */
        const escape = (event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          setOpen(false);
          if (trigger.current && typeof trigger.current.focus === 'function') trigger.current.focus();
        };
        doc.addEventListener('pointerdown', outside, true);
        doc.addEventListener('keydown', escape, true);
        return () => { doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', escape, true); };
      }, [menuOpen]);
      if (!model) return null;
      // The name gives way first on a short line: the suffix is what says the
      // conversation is not on the defaults, and it is short.
      const labelNode = h('span', { style: { display: 'inline-flex', minWidth: 0, fontWeight: 500 } },
        h('span', { style: starterText }, model.title),
        suffix ? h('span', { style: { flex: 'none', whiteSpace: 'nowrap' } }, ` · ${suffix}`) : null);
      return h('span', {
        ref: wrap, 'data-evimed-tool-chip': model.id, 'data-evimed-chip-placement': placement,
        style: { ...chipStyle, position: 'relative', flex: '0 1 auto', maxWidth: placement === 'bar' ? barChipBudget : '100%' },
      },
      hasMenu
        ? h('button', {
          ref: trigger, type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': menuOpen, 'aria-controls': menuOpen ? menuId : undefined,
          'aria-label': `${label}，设置`,
          style: { ...textButton, display: 'inline-flex', alignItems: 'center', gap: '2px', flex: '0 1 auto', minWidth: 0, height: '24px', lineHeight: '24px', padding: 0, color: 'inherit', fontSize: '12px' },
          onClick: () => setOpen(!menuOpen),
        }, labelNode,
        h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
          style: { flex: 'none', transform: menuOpen ? 'rotate(180deg)' : 'none' } }, h('path', { d: 'M3 4.5 6 7.5 9 4.5' })))
        : labelNode,
      h('button', {
        type: 'button', 'aria-label': `移除“${model.title}”`,
        style: { ...textButton, flex: 'none', height: '20px', lineHeight: '20px', padding: '0 4px', borderRadius: '999px', fontSize: '14px' },
        onClick: () => bind(null),
      }, '×'),
      menuOpen ? h('div', { ref: menuRef, id: menuId, role: 'dialog', 'aria-label': `${model.title}设置`, 'data-evimed-chip-menu': model.id, style: { ...menuStyle, left: `${slide}px` } },
        model.geo ? h(GeoMenu) : h(VcrMenu)) : null);
    };

    // Whether a composer toolbar is on the page to carry the chip: the hero seat
    // draws the chip only when there is none, so a blank conversation that has a
    // session (and so a toolbar) shows it once. A count, because the kernel may
    // keep more than one composer mounted.
    const toolbars = { count: 0 };
    /** @type {Set<() => void>} */
    const toolbarListeners = new Set();
    const useToolbar = () => React.useSyncExternalStore(
      (/** @type {() => void} */ listener) => { toolbarListeners.add(listener); return () => { toolbarListeners.delete(listener); }; },
      () => toolbars.count > 0, () => false,
    );
    /** @param {number} by */
    const toolbarSeats = (by) => {
      toolbars.count += by;
      for (const listener of [...toolbarListeners]) { try { listener(); } catch { /* a listener must not stop the others */ } }
    };

    // The toolbar seat: after the kernel's `+` and the paperclip.
    const BarChip = () => {
      React.useLayoutEffect(() => { toolbarSeats(1); return () => { toolbarSeats(-1); }; }, []);
      return h(ToolChip, { placement: 'bar' });
    };
    kit.guarded('tool chip', () => kit.occupy({ slot: 'conversation.input.left', id: 'evimed-tool', order: 10 }, BarChip));

    const SourceScopeChip = () => {
      const [selection, setSelection] = React.useState(null);
      const [failed, setFailed] = React.useState(false);
      React.useEffect(() => {
        const read = () => {
          setSelection(null);
          const sessionId = currentSession();
          if (sessionId) void kit.hub.request('source-scope', { sessionId }).catch(() => {});
        };
        const result = kit.hub.on('source-scope-result', (/** @type {any} */ data) => {
          if (data.ok && data.sessionId === currentSession()) { setSelection(data); setFailed(false); }
        });
        const switched = kit.hub.on('session', read);
        read();
        return () => { result(); switched(); };
      }, []);
      if (!selection?.sourceIds?.length && !selection?.originReference) return null;
      return h(React.Fragment, null,
        selection.originReference ? h('button', { type: 'button', style: { ...chipStyle, ...textButton, maxWidth: barChipBudget }, title: selection.originReference.title,
          onClick: () => kit.hub.send('open-event', { eventId: selection.originReference.id }) }, h('span', { style: starterText }, '来自：', selection.originReference.title)) : null,
        selection.sourceIds?.length ? h('span' , { style: chipStyle, 'data-evimed-source-scope': selection.sourceIds.length },
        h('span', null, `${selection.sourceIds.length} 份资料`),
        h('button', { type: 'button', style: textButton, 'aria-label': failed ? '移除资料范围失败，重试' : '移除资料范围',
          onClick: async () => {
            try {
              const result = await kit.hub.request('source-scope', { sessionId: selection.sessionId, sourceIds: [] });
              if (!result.ok) setFailed(true);
            } catch { setFailed(true); }
          },
        }, failed ? '重试' : '×')) : null);
    };
    kit.guarded('source scope', () => kit.occupy({ slot: 'conversation.input.left', id: 'evimed-source-scope', order: 11 }, SourceScopeChip));

    /**
     * The tool's example questions, as pills the reader can start from. Drawn
     * on the hero only (below): the hero is the blank conversation by the
     * kernel's own definition, and once something has been asked three more
     * pills under every reply would be noise — measured on
     * evimed-6af04c41d3f5-1, where a guess at "blank" from the run state left
     * them under the first answer.
     */
    const Starters = () => {
      const id = useTool();
      const geoState = useGeoOptions();
      const vcrState = useVcrOptions();
      const model = modelOf(id);
      if (!model) return null;
      // A module's single steps (循证 GEO's, 虚拟临床研究's single tasks): a short
      // name on the pill, a whole sentence into the composer — never sent.
      if (model.geo || model.vcr) {
        const options = model.geo ? geoState : vcrState;
        const starters = options && Array.isArray(options.starters) ? options.starters : [];
        if (!starters.length) return null;
        return h('div', {
          'data-evimed-tool-starters': model.id,
          style: { flexBasis: '100%', display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '8px', minWidth: 0 },
        }, starters.map((/** @type {{ label: string, draft: string }} */ starter) => h('button', {
          key: starter.label, type: 'button', title: starter.draft, style: starterStyle, onClick: () => fill(starter.draft),
        }, h('span', { style: starterText }, starter.label))));
      }
      if (!model.starters.length) return null;
      return h('span', { 'data-evimed-tool-starters': model.id, style: { display: 'contents' } },
        model.starters.slice(0, 3).map((/** @type {string} */ starter) => h('button', {
          key: starter, type: 'button', title: starter, style: starterStyle, onClick: () => fill(starter),
        }, h('span', { style: starterText }, starter))));
    };

    /**
     * The starters on the blank conversation, and the chip when the composer
     * has no toolbar to carry it. The toolbar seats render only inside a
     * session (`input !== undefined && sessionId !== undefined`); with one —
     * which is what a conversation the shell created has, blank or not — the
     * chip is in the toolbar and this seat holds the starters alone. Without
     * one, a tool chosen on 科研工具 lands here, the chip with its menu (which
     * opens upward over the headline) and the starters beside it, held to the
     * composer's width and centred, so nothing there can stretch the composer
     * again. The hero seat renders only while the conversation is blank.
     */
    const HeroTools = () => {
      const id = useTool();
      const hasToolbar = useToolbar();
      const model = modelOf(id);
      if (!model) return null;
      return h('div', {
        'data-evimed-hero-tools': model.id,
        style: { width: '100%', maxWidth: 'var(--dsh-composer-card-max-width, 952px)', margin: '8px auto 0', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: '8px', minWidth: 0 },
      }, hasToolbar ? null : h(ToolChip, { placement: 'hero' }), h(Starters));
    };
    kit.guarded('hero tools', () => kit.occupy({ slot: 'conversation.hero.agentPreset', priority: -1 }, HeroTools));
  }

  // `@` knowledge-base references.
  // Native serialization calls every reference with the same attempt signal. Collect those references before
  // saving the scope once, then let the native send proceed. Removed chips never join this attempt.
  const selections = new WeakMap();
  kit.withServices(['inputTriggers'], (/** @type {any} */ scope) => {
    scope.effect(() => scope.inputTriggers.registerSource({
      trigger: '@',
      name: '知识库',
      order: 20,
      /** @param {any} _session @param {{ query: string, signal: AbortSignal }} request */
      async candidates(_session, { query, signal }) {
        let result = null;
        try { result = await kit.hub.request('kb-query', { query: String(query ?? '').slice(0, 200) }, 5000); } catch { return []; }
        return signal?.aborted ? [] : knowledgeCandidates(result);
      },
      /** @param {{ candidate: { value?: string } }} pick */
      onPick({ candidate }) {
        const reference = knowledgeReference(candidate.value);
        if (!reference) return undefined;
        return { insert: kit.knowledgeChip(reference) };
      },
      codec: {
        /** @param {string} ref */
        clipboardText: (ref) => `@${knowledgeReference(ref)?.title ?? ''}`,
        /** @param {string} ref @param {AbortSignal} signal */
        serialize: async (ref, signal) => {
          const reference = knowledgeReference(ref);
          if (!reference || signal?.aborted) throw new Error('资料引用无法使用，请重新选择');
          const sessionId = mainViewSession(ctx.sessions.list.getSnapshot());
          if (!sessionId) throw new Error('对话暂时无法打开');
          let selection = selections.get(signal);
          if (!selection) {
            selection = { ids: new Set(), promise: null };
            const current = selection;
            current.promise = Promise.resolve().then(async () => {
              if (signal.aborted) throw new Error('发送已取消');
              const result = await kit.hub.request('source-scope', { sessionId, sourceIds: [...current.ids] });
              if (!result?.ok) throw new Error('无法保存资料范围，请重试');
            });
            selections.set(signal, selection);
          }
          selection.ids.add(reference.id);
          await selection.promise;
          return knowledgeSerialization(ref, knowledgeDir);
        },
      },
    }), 'evimed-commands: @ knowledge base');
  });
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({
  name: 'commands',
  inject,
  parts: Object.freeze([frameStyles, mainViewSession, capabilityOptions, toolPageModel, chipSuffix, knowledgeCandidates, knowledgeReference, knowledgeSerialization, apply]),
});
