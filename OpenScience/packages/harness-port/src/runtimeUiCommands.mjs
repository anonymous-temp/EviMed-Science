/**
 * The research capabilities, offered where the typing happens: a `/能力`
 * command in the kernel's own slash menu, four role cards on a blank
 * conversation, and `@` references to the researcher's knowledge base.
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
 *  - A pick fills the CURRENT conversation's composer
 *    (`conversation.input.for(scope).setDraft`). The old row of pills opened a
 *    new task instead, which threw away whatever the researcher had open. The
 *    popup then tries to remove the `/能力` token it was opened from; the
 *    draft has changed under it, so that compare-and-swap misses, which the
 *    pipeline treats as benign — the brief stays.
 *  - The blank conversation's hero declares `conversation.hero.agentPreset`,
 *    a single seat whose kernel occupant (the agent-preset picker) the hosted
 *    profile disables. The role cards sit there, below the headline, and the
 *    seat renders only while the conversation is blank.
 *  - `ctx.inputTriggers.registerSource({ trigger: '@', … })` adds a group to
 *    the `@` menu. A pick inserts a reference chip; `codec.serialize` is what
 *    the model receives for it at send time. The page cannot read the
 *    control plane's source list, so the candidates are asked of the shell
 *    (`kb-query` → `kb-result`), which answers from the sources this project
 *    already parsed.
 *
 * @module @evimed/harness-port/runtime-ui-commands
 */

import { frameStyles } from './runtimeUiStyles.mjs';

/** Services this body needs outright. */
export const inject = ['slots', 'sessions', 'conversation'];

/**
 * The slash popup's rows: every public capability, in catalogue order (which
 * is by category), the category first in the detail line.
 * @param {any[]} capabilities the frame's validated catalogue
 * @returns {{ id: string, label: string, detail: string }[]}
 */
export function capabilityOptions(capabilities) {
  return (Array.isArray(capabilities) ? capabilities : [])
    .filter((entry) => entry && !entry.internal && entry.id && entry.title)
    .map((entry) => {
      const minutes = Array.isArray(entry.minutes) && entry.minutes.length === 2
        ? (entry.minutes[0] === entry.minutes[1] ? `约 ${entry.minutes[0]} 分钟` : `约 ${entry.minutes[0]}–${entry.minutes[1]} 分钟`)
        : null;
      return {
        id: String(entry.id),
        label: String(entry.title),
        detail: [entry.category, entry.summary, minutes].filter((part) => typeof part === 'string' && part).join(' · '),
      };
    });
}

/**
 * The four ways into the product on a blank conversation, by role rather than
 * by capability name — fifteen names ask a researcher to know the catalogue
 * before they have asked anything. Each card is the capability that answers
 * that role's first question; a card whose capability this deployment does
 * not offer is left out.
 * @param {any[]} capabilities
 * @returns {{ role: string, text: string, capabilityId: string, capabilityTitle: string, brief: string }[]}
 */
export function roleCards(capabilities) {
  const roles = [
    { role: '临床问题', text: '从一个临床问题出发，检索证据，给出可追溯的结论', capabilityId: 'clinical-evidence-synthesis' },
    { role: '药物评价', text: '围绕一个药品与适应证，完成多维度的综合评价', capabilityId: 'comprehensive-drug-evaluation' },
    { role: '选题与申报', text: '找到有证据依据、可落地的研究选题', capabilityId: 'research-topic-selection' },
    { role: '数据可行性', text: '判断手头的数据能支撑哪些研究课题', capabilityId: 'dataset-research-scoping' },
  ];
  const catalogue = Array.isArray(capabilities) ? capabilities : [];
  return roles.flatMap((role) => {
    const entry = catalogue.find((candidate) => candidate && candidate.id === role.capabilityId && !candidate.internal);
    return entry && typeof entry.brief === 'string' && entry.brief
      ? [{ ...role, capabilityTitle: String(entry.title), brief: entry.brief }]
      : [];
  });
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
  const catalogue = kit.frame.capabilities.filter((/** @type {any} */ entry) => !entry.internal);
  const knowledgeDir = String(kit.vocabulary?.knowledgeDir || '.evimed-knowledge');

  /**
   * Fill the composer of a session with a brief; with no session open, ask the
   * shell for a new task carrying it.
   * @param {string | null | undefined} sessionId @param {string} brief
   */
  const fill = (sessionId, brief) => {
    const scope = sessionId && typeof ctx.sessions?.scope === 'function' ? ctx.sessions.scope(sessionId) : null;
    if (scope && ctx.conversation?.input) {
      ctx.conversation.input.for(scope).setDraft(brief);
      return;
    }
    target.__EVIMED_SHELL__?.navigate?.('new-task', brief);
  };

  // `/能力`: the whole catalogue, searchable, in the kernel's own popup.
  kit.withServices(['commandUi'], (/** @type {any} */ scope) => {
    const options = capabilityOptions(catalogue);
    if (!options.length) return;
    scope.effect(() => scope.commandUi.register({
      name: '能力',
      description: () => '选择一项研究能力，把它的题面填进输入框',
      available: () => true,
      ui: {
        kind: 'popupSelect',
        options: async () => options,
        /** @param {{ id: string }} option @param {{ sessionId: string }} session */
        onSelect(option, session) {
          const entry = catalogue.find((/** @type {any} */ candidate) => candidate.id === option.id);
          if (!entry) return;
          const scopeOf = ctx.sessions.scope(session.sessionId);
          if (!scopeOf) throw new Error('这个会话还没有准备好，请稍后再选');
          ctx.conversation.input.for(scopeOf).setDraft(entry.brief);
        },
      },
    }), 'evimed-commands: /能力');
  });

  // The role cards on a blank conversation.
  const cards = roleCards(catalogue);
  if (cards.length) {
    const { secondary } = frameStyles();
    const RoleCards = () => h('div', {
      'data-evimed-role-cards': '',
      style: { flex: '1 1 100%', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px', margin: '12px 0 4px' },
    }, cards.map((card) => h('button', {
      key: card.role,
      type: 'button',
      title: `由「${card.capabilityTitle}」完成；点选后题面会填进输入框，改成你的问题再发送`,
      onClick: () => fill(ctx.sessions?.list?.getSnapshot?.()?.current, card.brief),
      style: {
        ...secondary,
        textAlign: 'left',
        font: 'inherit',
        cursor: 'pointer',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        minWidth: 0,
      },
    },
    h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, card.role),
    h('span', null, card.text))));
    kit.guarded('role cards', () => kit.occupy({ slot: 'conversation.hero.agentPreset', priority: -1 }, RoleCards));
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
  parts: Object.freeze([frameStyles, capabilityOptions, roleCards, knowledgeCandidates, knowledgeReference, knowledgeSerialization, apply]),
});
