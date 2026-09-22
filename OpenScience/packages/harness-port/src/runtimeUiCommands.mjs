/**
 * The research tools, offered where the typing happens: a chip under the
 * composer for the one you picked (on 科研工具, or with `/工具`), its example
 * questions beside it while the conversation is still blank, a `/工具` command
 * in the kernel's own slash menu, and `@` references to the researcher's
 * knowledge base.
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
 * Hidden knowledge, read off the pinned 0.1.5-rc.2 client:
 *
 *  - `ctx.commandUi.register({ name, description, available, ui })`
 *    (`dsh-client-ui-commands`) adds a client-owned slash command. A
 *    `popupSelect` opens the kernel's own searchable popup; its rows are a
 *    label and one line of detail, filtered by substring over both — so the
 *    category, the one-line summary and the typical duration go in the detail,
 *    and typing 「证据」 or 「分钟」 finds rows by them. A contribution whose
 *    name collides with a host command fails loud at candidate synthesis and
 *    takes the whole menu with it; host commands are ASCII identifiers, and
 *    this one's name is not.
 *  - `conversation.composer.dock` is a list seat directly under the composer
 *    card: one centred row of 13 px pills, which the kernel's own session
 *    statistics already occupy (`stats`, order 0). The chip and the starters
 *    sit beside them, at the composer's own width by construction — the seat
 *    above the card (`conversation.input.dock`) spans the frame and put the
 *    chip at the left edge beside a centred composer.
 *  - `ctx.inputTriggers.registerSource({ trigger: '@', … })` adds a group to
 *    the `@` menu. A pick inserts a reference chip; `codec.serialize` is what
 *    the model receives for it at send time. The page cannot read the
 *    control plane's source list, so the candidates are asked of the shell
 *    (`kb-query` → `kb-result`), which answers from the sources this project
 *    already parsed.
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

import { frameStyles } from './runtimeUiStyles.mjs';

/** Services this body needs outright. */
export const inject = ['slots', 'sessions', 'conversation'];

/**
 * A capability's typical duration, as the cards and the popup say it.
 * @param {any} entry
 * @returns {string | null}
 */
export function toolMinutes(entry) {
  const minutes = entry && Array.isArray(entry.minutes) && entry.minutes.length === 2 ? entry.minutes : null;
  if (!minutes) return null;
  return minutes[0] === minutes[1] ? `约 ${minutes[0]} 分钟` : `约 ${minutes[0]}–${minutes[1]} 分钟`;
}

/**
 * The slash popup's rows: every public tool, in catalogue order (which is by
 * category), the category first in the detail line.
 * @param {any[]} capabilities the frame's validated catalogue
 * @returns {{ id: string, label: string, detail: string }[]}
 */
export function capabilityOptions(capabilities) {
  return (Array.isArray(capabilities) ? capabilities : [])
    .filter((entry) => entry && !entry.internal && entry.id && entry.title)
    .map((entry) => ({
      id: String(entry.id),
      label: String(entry.title),
      detail: [entry.category, entry.summary, toolMinutes(entry)].filter((part) => typeof part === 'string' && part).join(' · '),
    }));
}

/**
 * The tool this conversation runs, as the chip and the starters read it: its
 * name, what it does, how long it usually takes, and three questions to start
 * from. What it hands back, needs and cannot do stays on 科研工具, where the
 * tool was chosen.
 * @param {any[]} capabilities @param {unknown} id
 */
export function toolPageModel(capabilities, id) {
  const key = String(id ?? '');
  const entry = (Array.isArray(capabilities) ? capabilities : []).find((candidate) => candidate && candidate.id === key && !candidate.internal);
  if (!entry) return null;
  return {
    id: entry.id,
    title: String(entry.title),
    category: String(entry.category || ''),
    summary: String(entry.summary || ''),
    minutes: toolMinutes(entry),
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
 * What the model reads for a knowledge reference: the source's id, its title,
 * and where its parsed text is in the workspace — the control plane
 * materializes a parsed source under `knowledge-base/.evimed-derived/<id>/`
 * and syncs the knowledge base read-only into the workspace before each
 * dispatch (`researchContext.mjs`), so the reference is something the run can
 * open, not a name it has to search for.
 * @param {unknown} ref @param {string} knowledgeDir
 * @returns {string}
 */
export function knowledgeSerialization(ref, knowledgeDir) {
  const reference = knowledgeReference(ref);
  if (!reference) throw new Error('知识库引用无法识别');
  return `【知识库文献 ${reference.id}：「${reference.title}」，解析后的正文在工作区 ${knowledgeDir}/.evimed-derived/${reference.id}/ 下】`;
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
  const { quiet, button, secondary } = frameStyles();
  const catalogue = kit.frame.capabilities.filter((/** @type {any} */ entry) => !entry.internal);
  const knowledgeDir = String(kit.vocabulary?.knowledgeDir || '.evimed-knowledge');

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
    try { return ctx.sessions?.list?.getSnapshot?.()?.current ?? null; } catch { return null; }
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
  ctx.effect(() => kit.hub.on('session', () => { setTool(null); }), 'evimed-commands: capability follows the conversation');

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
    const options = capabilityOptions(catalogue);
    if (!options.length) return;
    scope.effect(() => scope.commandUi.register({
      name: '工具',
      description: () => '选择一项科研工具，这次对话就按它来做',
      available: () => true,
      ui: {
        kind: 'popupSelect',
        options: async () => options,
        /** @param {{ id: string }} option */
        onSelect(option) { bind(String(option.id)); },
      },
    }), 'evimed-commands: /工具');
  });

  if (React && catalogue.length) {
    const { pill: pillTone } = frameStyles();
    // One 13 px pill, as the kernel's statistics pills beside it are drawn:
    // the same radius, the same secondary ink, on the layer-1 background.
    const chipStyle = {
      ...secondary,
      display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0,
      padding: '1px 8px', borderRadius: '24px',
      border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-secondary)',
    };
    const starterStyle = { ...chipStyle, cursor: 'pointer', font: 'inherit', maxWidth: '100%' };
    const starterText = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

    /** Which conversation is open, and whether anything has been said in it. */
    const useBlank = () => {
      const session = kit.useFrameState((/** @type {any} */ state) => state.session);
      const runState = kit.useFrameState((/** @type {any} */ state) => state.runState);
      // No session yet is the hero; a session the shell has no run for and
      // that is not running has not been asked anything.
      if (!session || !session.sessionId) return true;
      return !session.running && !runState?.runId;
    };

    /**
     * The chip under the composer: which tool this conversation runs, and the
     * way out of it. In a session the hero is gone, so this is the only place
     * that says it; its tooltip is the tool's one-line summary.
     */
    const ToolChip = () => {
      const id = useTool();
      const model = id ? toolPageModel(catalogue, id) : null;
      if (!model) return null;
      return h('span', { 'data-evimed-tool-chip': model.id, title: model.summary || undefined, style: chipStyle },
        h('span', { style: { ...pillTone('active'), fontWeight: 500, ...starterText } }, model.title),
        model.minutes ? h('span', { style: { ...quiet, flex: 'none' } }, model.minutes) : null,
        h('button', {
          type: 'button', 'aria-label': `不再用「${model.title}」`, title: '换一个工具，或不用工具',
          style: { ...button, marginLeft: 0, border: 'none', padding: '0 2px', lineHeight: 1 },
          onClick: () => bind(null),
        }, '×'));
    };
    kit.guarded('tool chip', () => kit.occupy({ slot: 'conversation.composer.dock', id: 'evimed-tool', order: 10 }, ToolChip));

    /**
     * The tool's example questions, as pills the reader can start from, only
     * while the conversation is blank: once something has been asked they
     * would be three more things under every reply.
     */
    const Starters = () => {
      const id = useTool();
      const blank = useBlank();
      const model = id && blank ? toolPageModel(catalogue, id) : null;
      if (!model || !model.starters.length) return null;
      return h('span', { 'data-evimed-tool-starters': model.id, style: { display: 'contents' } },
        model.starters.slice(0, 3).map((/** @type {string} */ starter) => h('button', {
          key: starter, type: 'button', title: starter, style: starterStyle, onClick: () => fill(starter),
        }, h('span', { style: starterText }, starter))));
    };
    kit.guarded('tool starters', () => kit.occupy({ slot: 'conversation.composer.dock', id: 'evimed-tool-starters', order: 20 }, Starters));

    /**
     * The same chip and starters on the blank conversation. The composer dock
     * renders only inside a session (`variant === "composer" && sessionId`),
     * so on the hero — where a tool chosen on 科研工具 lands — the seat under
     * the headline carries them instead, held to the composer's width and
     * centred, so nothing there can stretch the composer again. The hero
     * seat renders only while the conversation is blank, so the two never
     * show at once.
     */
    const HeroTools = () => {
      const id = useTool();
      const model = id ? toolPageModel(catalogue, id) : null;
      if (!model) return null;
      return h('div', {
        'data-evimed-hero-tools': model.id,
        style: { width: '100%', maxWidth: 'var(--dsh-composer-card-max-width, 952px)', margin: '4px auto 0', display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '6px', minWidth: 0 },
      }, h(ToolChip), h(Starters));
    };
    kit.guarded('hero tools', () => kit.occupy({ slot: 'conversation.hero.agentPreset', priority: -1 }, HeroTools));
  }

  // `@` knowledge-base references.
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
        return { insert: {
          source: '知识库',
          ref: JSON.stringify(reference),
          label: reference.title,
          appearance: 'file',
          clipboardText: `@${reference.title}`,
        } };
      },
      codec: {
        /** @param {string} ref */
        clipboardText: (ref) => `@${knowledgeReference(ref)?.title ?? ''}`,
        /** @param {string} ref */
        serialize: (ref) => Promise.resolve(knowledgeSerialization(ref, knowledgeDir)),
      },
    }), 'evimed-commands: @ knowledge base');
  });
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({
  name: 'commands',
  inject,
  parts: Object.freeze([frameStyles, toolMinutes, capabilityOptions, toolPageModel, knowledgeCandidates, knowledgeReference, knowledgeSerialization, apply]),
});
