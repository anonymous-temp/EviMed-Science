/**
 * The research tools, offered where the typing happens: a grid on the blank
 * conversation, a page for the one you picked above that same composer, a
 * `/工具` command in the kernel's own slash menu, and `@` references to the
 * researcher's knowledge base.
 *
 * The shape is the one every comparable product settled on (Manus, Kimi,
 * ChatGPT's GPTs, 豆包, Genspark): pick a tool under the composer, the tool
 * becomes a removable chip in that same composer, and its examples appear
 * above it. Nobody opens a drawer with a second input box, which is what this
 * replaced — and what sent a researcher who had already typed their question
 * to a different page to type it again.
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
 *  - The blank conversation's hero declares `conversation.hero.agentPreset`,
 *    a single seat whose kernel occupant (the agent-preset picker) the hosted
 *    profile disables. The grid and the tool page sit there, below the
 *    headline, and the seat renders only while the conversation is blank.
 *  - `conversation.input.dock` is a list seat directly above the composer, in
 *    every session; the chip that says which tool this conversation runs sits
 *    there beside the busy hint.
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
 * The blank conversation's grid: every public tool, grouped by category in
 * catalogue order.
 * @param {any[]} capabilities
 * @returns {{ category: string, tools: any[] }[]}
 */
export function toolGroups(capabilities) {
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const entry of Array.isArray(capabilities) ? capabilities : []) {
    if (!entry || entry.internal || !entry.id || !entry.title) continue;
    const category = String(entry.category || '其他');
    const list = groups.get(category) ?? [];
    list.push({ id: String(entry.id), title: String(entry.title), summary: String(entry.summary || ''), minutes: toolMinutes(entry) });
    groups.set(category, list);
  }
  return [...groups.entries()].map(([category, tools]) => ({ category, tools }));
}

/**
 * The page of the tool this conversation runs: what it does, what it hands
 * back, how long it usually takes, what it needs from the researcher, and
 * three questions to start from.
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
  const { card, line, title, quiet, pill, button, section, secondary } = frameStyles();
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
    const groups = toolGroups(catalogue);
    const total = groups.reduce((sum, group) => sum + group.tools.length, 0);

    /** @param {{ tool: any, onPick: (id: string) => void }} props */
    const ToolCard = ({ tool: entry, onPick }) => h('button', {
      type: 'button',
      'data-evimed-tool': entry.id,
      onClick: () => onPick(entry.id),
      title: entry.summary,
      style: {
        ...secondary,
        textAlign: 'left', font: 'inherit', cursor: 'pointer', minWidth: 0,
        border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)',
        padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '2px',
      },
    },
    h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, entry.title),
    h('span', { style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, entry.summary),
    entry.minutes ? h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, entry.minutes) : null);

    /**
     * The grid, on a conversation with no tool chosen: the first two of each
     * category, so every category is represented, and the rest one click away.
     * A flat budget spent in catalogue order left the last category out
     * entirely and showed one of the one before it.
     */
    const PER_CATEGORY = 2;
    const ToolGrid = () => {
      const [all, setAll] = React.useState(false);
      return h('div', {
        'data-evimed-tools': '',
        style: { flex: '1 1 100%', margin: '12px 0 4px', display: 'flex', flexDirection: 'column', gap: '10px' },
      },
      groups.map((group) => {
        const shown = all ? group.tools : group.tools.slice(0, PER_CATEGORY);
        if (!shown.length) return null;
        return h('div', { key: group.category },
          h('div', { style: { ...section, margin: '0 0 4px' } }, group.category),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '8px' } },
            shown.map((entry) => h(ToolCard, { key: entry.id, tool: entry, onPick: bind }))));
      }),
      groups.some((group) => group.tools.length > PER_CATEGORY) ? h('button', {
        type: 'button', style: { ...button, marginLeft: 0, alignSelf: 'flex-start' }, onClick: () => setAll(!all),
      }, all ? '收起' : `全部 ${total} 个工具`) : null);
    };

    /** The page of the chosen tool, above the same composer. */
    /** @param {{ id: string }} props */
    const ToolPage = ({ id }) => {
      const model = toolPageModel(catalogue, id);
      if (!model) return null;
      return h('div', {
        'data-evimed-tool-page': model.id,
        style: { flex: '1 1 100%', margin: '12px 0 4px', display: 'flex', flexDirection: 'column', gap: '6px', textAlign: 'left' },
      },
      h('div', { style: line },
        h('span', { style: { ...title, fontSize: '16px' } }, model.title),
        model.minutes ? h('span', { style: pill('muted') }, model.minutes) : null,
        h('button', { type: 'button', style: button, onClick: () => bind(null) }, '换一个工具')),
      h('div', { style: { ...secondary, color: 'var(--dsw-alias-label-secondary)' } }, model.summary),
      model.outputs.length ? h('div', { style: { ...secondary, color: 'var(--dsw-alias-label-tertiary)' } }, `你会拿到：${model.outputs.join('；')}`) : null,
      model.materials ? h('div', { style: { ...secondary, color: 'var(--dsw-alias-label-tertiary)' } }, `开始前：${model.materials}`) : null,
      model.limits.length ? h('div', { style: { ...secondary, color: 'var(--dsw-alias-label-tertiary)' } }, `做不到：${model.limits.join('；')}`) : null,
      model.starters.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' } },
        model.starters.map((/** @type {string} */ starter) => h('button', {
          key: starter, type: 'button', onClick: () => fill(starter),
          style: { ...card, margin: 0, display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit' },
        }, starter))) : null);
    };

    const HeroTools = () => {
      const id = useTool();
      return id ? h(ToolPage, { id }) : h(ToolGrid, null);
    };
    kit.guarded('hero tools', () => kit.occupy({ slot: 'conversation.hero.agentPreset', priority: -1 }, HeroTools));

    // The chip above the composer: which tool this conversation runs, and the
    // way out of it. In a session the hero is gone, so this is the only place
    // that still says it.
    const ToolChip = () => {
      const id = useTool();
      const model = id ? toolPageModel(catalogue, id) : null;
      if (!model) return null;
      return h('div', { 'data-evimed-tool-chip': model.id, style: { ...line, justifyContent: 'flex-start', padding: '0 4px 4px' } },
        h('span', { style: { ...pill('active'), fontWeight: 500 } }, model.title),
        model.minutes ? h('span', { style: quiet }, model.minutes) : null,
        h('button', { type: 'button', 'aria-label': `不再用「${model.title}」`, style: { ...button, marginLeft: 0 }, onClick: () => bind(null) }, '移除'));
    };
    kit.guarded('tool chip', () => kit.occupy({ slot: 'conversation.input.dock', id: 'evimed-tool', order: 20 }, ToolChip));
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
  parts: Object.freeze([frameStyles, toolMinutes, capabilityOptions, toolGroups, toolPageModel, knowledgeCandidates, knowledgeReference, knowledgeSerialization, apply]),
});
