/**
 * The sources behind an answer, as cards under it — what a reference list is
 * for a reader of medicine, instead of the model's own paragraph of titles and
 * bare links (融合方案 §8.3, m02).
 *
 * What a card carries is the trust design's 来源级 layer (§5.8): the study-type
 * badge, the title, the journal or issuing body and the year when the package
 * recorded them, the DOI or PMID with one click to copy it, a retraction strip
 * when the work no longer stands as published, and a mark when the work was
 * industry-funded. Above the list, one line of composition — 「指南 2 · 系统
 * 评价 3 · RCT 4 · 观察性 3」 — because what a body of evidence is made of is
 * the first thing a clinician weighs, and above that the answer's own grade
 * and the premises it holds under (§5.8 答案级) when the platform computed
 * them.
 *
 * Opened, a card shows the source's own words — the quotation the claim rests
 * on, highlighted — with ✓ when the control plane found that quotation in the
 * preserved source and ⚠ when it did not. That verdict is not this body's:
 * it is `claim_verification` in `@evimed/domain`, the same one the report
 * reader's 「依据」 popover draws (`ClaimCitation.tsx`), read by the shell and
 * posted in. There is one citation system and this is a second face on it.
 *
 * Hidden knowledge:
 *
 *  - The frame has no fetch of its own and the page it runs on holds no
 *    session of the control plane's. The claims and sources arrive as the
 *    shell's `evidence` message (`runtimeUiBridge.mjs`'s INBOUND table), which
 *    the shell reads from the delivered evidence matrix and its claim
 *    verification. A run with no matrix sends nothing and no card is drawn —
 *    the answer keeps whatever references it wrote itself.
 *  - There is no per-sentence seat in the kernel's transcript: an answer's
 *    prose is drawn by the kernel's own markdown component with no hook into a
 *    sentence or a link (the same finding that made the reply check one row
 *    per answer, 2026-09-23 §1.5). So the numbered mark that opens a quotation
 *    is on the card, not inside the sentence; inside the sentence it exists in
 *    the report reader, where the report's own claim markers give it an anchor.
 *  - Every answer is an `assistant-step` chat node in the keyed slot
 *    `conversation.chat.node`; `ui-chat` holds the key at priority 0, the reply
 *    check takes it over at -1 and the delivered files at -2, so this body goes
 *    at -3, renders the row it shadows first and adds its list after it. The
 *    order a reader sees is therefore: the answer, what needs checking, the
 *    files it delivered, and what it stood on.
 *  - Which answer: the closing answer of the conversation's newest turn, and
 *    only when that turn belongs to the bound run — `turnCarriesRun`, the same
 *    rule the files use, so a later question never wears an earlier run's
 *    sources.
 *
 * Nothing here holds or changes an answer (principle 13): the list comes after
 * it, and every number in it is counted from the records it names.
 *
 * @module @evimed/harness-port/runtime-ui-sources
 */

import { frameStyles } from './runtimeUiStyles.mjs';
import { liveRunFor } from './runtimeUiToolviews.mjs';
import { turnCarriesRun } from './runtimeUiPanels.mjs';

/** Services this body needs outright: the slot registry. */
export const inject = ['slots'];

/**
 * What each verification status says on a card, and how it reads.
 *
 * The words are the reader's, not the checker's: the control plane's own
 * status names (`quote_not_found`, `source_unavailable`) are codes. A status
 * this table does not know reads as unchecked rather than as verified — the
 * one direction in which being wrong is safe.
 * @returns {Record<string, { mark: string, label: string, tone: 'ok' | 'warn' }>}
 */
export function sourceStatusText() {
  return {
    verified: { mark: '✓', label: '引文已核对', tone: 'ok' },
    quote_not_found: { mark: '⚠', label: '引文未在原文中找到', tone: 'warn' },
    source_unavailable: { mark: '⚠', label: '原文未保存，无法核对', tone: 'warn' },
    no_quote: { mark: '⚠', label: '没有可核对的引文', tone: 'warn' },
  };
}

/**
 * The list a reader sees, or null when this conversation has no evidence of
 * its own to show.
 *
 * Every count is computed here from the records themselves — a composition
 * line that restated a number the payload carried would be a number nobody
 * checked.
 *
 * @param {any} evidence the shell's `evidence` payload
 * @param {any} vocabulary the frame vocabulary (source-type labels, badge kinds, grade words)
 * @returns {{ runId: string, reportPath: string, total: number, composition: { type: string, label: string, count: number }[],
 *   grade: { letter: string, label: string, reasons: string[] } | null, premises: string[],
 *   sources: { key: string, index: number, title: string, badge: { kind: string, label: string } | null,
 *     facts: string[], identifier: string | null, url: string | null, quote: string | null,
 *     status: string | null, withdrawn: { label: string, severe: boolean } | null, funding: string | null,
 *     claimId: string | null }[] } | null}
 */
export function sourceCardsModel(evidence, vocabulary) {
  const runId = typeof evidence?.runId === 'string' ? evidence.runId : '';
  const reportPath = typeof evidence?.reportPath === 'string' ? evidence.reportPath : '';
  const list = Array.isArray(evidence?.sources) ? evidence.sources : [];
  if (!runId || !list.length) return null;
  const labels = (vocabulary && vocabulary.sourceTypeLabels) || {};
  const order = Array.isArray(vocabulary && vocabulary.sourceTypes) ? vocabulary.sourceTypes : [];
  const badgeKinds = (vocabulary && vocabulary.studyBadgeKinds) || {};
  const updateLabels = (vocabulary && vocabulary.sourceUpdateLabels) || {};
  const updateWeights = (vocabulary && vocabulary.sourceUpdateWeights) || {};
  const text = (/** @type {unknown} */ value, /** @type {number} */ max) => {
    const value_ = String(value ?? '').replace(/\s+/g, ' ').trim();
    return value_.length > max ? `${value_.slice(0, max)}…` : value_;
  };
  /** @type {Map<string, number>} */
  const counts = new Map();
  const sources = list.map((/** @type {any} */ source, /** @type {number} */ index) => {
    const type = typeof source?.sourceType === 'string' ? source.sourceType : '';
    if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
    const kind = Object.hasOwn(badgeKinds, type) ? badgeKinds[type] : null;
    const badge = type && Object.hasOwn(labels, type) && type !== 'other' ? { kind: kind ?? 'other', label: labels[type] } : null;
    // The first notice that takes the work out of the record, else the first
    // notice of any kind: one strip, never a row of them.
    const updates = (Array.isArray(source?.updates) ? source.updates : [])
      .filter((/** @type {any} */ update) => update && Object.hasOwn(updateLabels, String(update.kind)));
    const severe = updates.find((/** @type {any} */ update) => updateWeights[String(update.kind)] === 'withdrawn');
    const notice = severe ?? updates[0] ?? null;
    return {
      key: `${index}`,
      index: index + 1,
      title: text(source?.title, 160) || '未命名来源',
      badge,
      // The journal or issuing body and the year, when the package recorded
      // them. A fact it does not carry is left out, never invented.
      facts: [text(source?.journal, 60), text(source?.year, 24)].filter(Boolean),
      identifier: text(source?.identifier, 80) || null,
      url: /^https?:\/\//i.test(String(source?.url ?? '')) ? String(source.url) : null,
      quote: text(source?.quote, 600) || null,
      status: typeof source?.status === 'string' ? source.status : null,
      withdrawn: notice
        ? { label: `${updateLabels[String(notice.kind)]}${notice.date ? ` · ${text(notice.date, 12)}` : ''}`, severe: Boolean(severe) }
        : null,
      funding: source?.funding === 'industry' ? '企业资助' : null,
      claimId: /^CLM-\d{3,6}$/.test(String(source?.claimId ?? '')) ? String(source.claimId) : null,
    };
  });
  const known = [...counts.keys()].filter((type) => Object.hasOwn(labels, type));
  const composition = [...order.filter((/** @type {string} */ type) => counts.has(type) && Object.hasOwn(labels, type)),
    ...known.filter((type) => !order.includes(type))]
    .map((type) => ({ type, label: labels[type], count: counts.get(type) ?? 0 }));
  const gradeLabels = (vocabulary && vocabulary.gradeLabels) || {};
  const letter = String(evidence?.grade?.letter ?? '');
  const grade = Object.hasOwn(gradeLabels, letter)
    ? {
      letter,
      label: gradeLabels[letter],
      reasons: (Array.isArray(evidence?.grade?.reasons) ? evidence.grade.reasons : [])
        .map((/** @type {unknown} */ reason) => text(reason, 60)).filter(Boolean).slice(0, 4),
    }
    : null;
  const premises = (Array.isArray(evidence?.premises) ? evidence.premises : [])
    .map((/** @type {unknown} */ premise) => text(premise, 40)).filter(Boolean).slice(0, 6);
  return { runId, reportPath, total: sources.length, composition, grade, premises, sources };
}

/**
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} target Browser global (the clipboard lives there).
 * @param {(id: string) => any} [_require]
 * @param {any} [kit] The frame kit.
 */
export function apply(ctx, _config, target = globalThis, _require = undefined, kit = undefined) {
  if (!kit || !kit.ours || !kit.h || !kit.react) return;
  const h = kit.h;
  const React = kit.react;
  const slot = 'conversation.chat.node';
  const { text, meta, card, line, title, tag, tone, textButton, link } = frameStyles();
  const badges = (kit.vocabulary && kit.vocabulary.studyBadges) || {};
  const statusText = sourceStatusText();

  /** @param {{ badge: { kind: string, label: string } }} props */
  const StudyBadge = ({ badge }) => {
    const colours = Object.hasOwn(badges, badge.kind) ? badges[badge.kind] : null;
    return h('span', {
      'data-evimed-study': badge.kind,
      style: colours ? { ...tag, background: colours.bg, color: colours.fg } : tag,
    }, badge.label);
  };

  /** The identifier, and one click to take it away. @param {{ value: string }} props */
  const Identifier = ({ value }) => {
    const [copied, setCopied] = React.useState(false);
    const copy = () => {
      const clipboard = target?.navigator?.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') return;
      Promise.resolve(clipboard.writeText(value)).then(() => setCopied(true)).catch(() => { /* the identifier is still on screen to select */ });
    };
    return h('button', {
      type: 'button', onClick: copy, 'aria-label': `复制 ${value}`,
      style: { ...textButton, ...meta, display: 'inline-flex', alignItems: 'center', gap: '4px' },
    }, value, h('span', { style: { color: copied ? tone('ok') : tone('muted') } }, copied ? '已复制' : '复制'));
  };

  /** @param {{ source: any, runId: string, reportPath: string }} props */
  const SourceCard = ({ source, runId, reportPath }) => {
    const [open, setOpen] = React.useState(false);
    const verdict = source.status && Object.hasOwn(statusText, source.status) ? statusText[source.status] : null;
    const heading = source.url
      ? h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', style: { ...link, fontWeight: 500 } }, source.title)
      : h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500 } }, source.title);
    return h('li', { style: { ...card, listStyle: 'none' }, 'data-evimed-source': String(source.index) },
      h('div', { style: { ...line, alignItems: 'flex-start' } },
        h('span', { style: { ...meta, flex: 'none', minWidth: '18px' } }, String(source.index)),
        h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
          h('div', { style: { ...text, wordBreak: 'break-word' } }, heading),
          h('div', { style: { ...line, ...meta, flexWrap: 'wrap', marginTop: '2px' } },
            source.badge ? h(StudyBadge, { badge: source.badge }) : null,
            ...source.facts.map((/** @type {string} */ fact, /** @type {number} */ index) => h('span', { key: `f${index}` }, fact)),
            source.identifier ? h(Identifier, { value: source.identifier }) : null,
            source.funding ? h('span', { style: { ...tag, color: tone('warn') } }, source.funding) : null))),
      // A work that no longer stands as published is the one thing on a card a
      // reader must not miss, so it is a strip of its own and never folded.
      source.withdrawn
        ? h('div', {
          'data-evimed-retracted': source.withdrawn.severe ? 'withdrawn' : 'notice',
          style: { ...meta, marginTop: '6px', padding: '4px 8px', borderRadius: '8px',
            background: source.withdrawn.severe ? 'var(--dsw-alias-state-error-bg, var(--dsw-alias-bg-layer-2))' : 'var(--dsw-alias-bg-layer-2)',
            color: source.withdrawn.severe ? 'var(--dsw-alias-state-error-label, var(--dsw-alias-label-primary))' : tone('warn') },
        }, source.withdrawn.label)
        : null,
      source.quote
        ? h('div', { style: { marginTop: '6px' } },
          h('button', {
            type: 'button', 'aria-expanded': open, onClick: () => setOpen(!open),
            style: { ...textButton, ...meta, display: 'inline-flex', alignItems: 'center', gap: '4px', color: verdict ? tone(verdict.tone) : tone('muted') },
          }, verdict ? `${verdict.mark} ${verdict.label}` : '原文引语'),
          open
            ? h('blockquote', {
              'data-evimed-quote': String(source.index),
              style: { ...text, margin: '4px 0 0', padding: '4px 8px', borderLeft: '2px solid var(--dsw-alias-border-l2)',
                background: 'var(--highlight, var(--dsw-alias-bg-layer-2))', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap' },
            }, `「${source.quote}」`)
            : null,
          // The report reader is where a quotation is read in place, and it
          // takes the claim as the address's fragment — the shape the shell's
          // `open-artifact` already navigates to (`anchor`).
          open && source.claimId && reportPath
            ? h('button', {
              type: 'button', style: { ...textButton, ...meta, marginTop: '4px', color: 'var(--dsw-alias-link)' },
              onClick: () => { kit.hub.send('open-artifact', { runId, path: reportPath, anchor: source.claimId }); },
            }, '在报告中查看')
            : null)
        : null);
  };

  /** @param {{ model: NonNullable<ReturnType<typeof sourceCardsModel>> }} props */
  const SourceCards = ({ model }) => {
    const [all, setAll] = React.useState(false);
    const shown = all ? model.sources : model.sources.slice(0, 5);
    const composition = model.composition.map((/** @type {any} */ entry) => `${entry.label} ${entry.count}`).join(' · ');
    return h('section', { style: { marginTop: '12px' }, 'data-evimed-sources': String(model.total), 'aria-label': '来源' },
      model.grade
        ? h('div', { style: { ...line, flexWrap: 'wrap', marginBottom: '4px' }, 'data-evimed-grade': model.grade.letter },
          h('span', { style: { ...tag, background: 'var(--dsw-alias-state-business-primary)', color: 'var(--dsw-alias-bg-layer-1)' } }, model.grade.letter),
          h('span', { style: { ...title, flex: '0 1 auto' } }, `证据等级 · ${model.grade.label}`),
          ...model.grade.reasons.map((/** @type {string} */ reason, /** @type {number} */ index) => h('span', { key: `r${index}`, style: meta }, reason)))
        : null,
      model.premises.length
        ? h('div', { style: { ...line, ...meta, flexWrap: 'wrap', marginBottom: '4px' }, 'data-evimed-premises': String(model.premises.length) },
          h('span', null, '适用前提'),
          ...model.premises.map((/** @type {string} */ premise, /** @type {number} */ index) => h('span', { key: `p${index}`, style: tag }, premise)))
        : null,
      h('div', { style: { ...line, ...meta, marginBottom: '4px' } },
        h('span', { style: { ...title, flex: '0 1 auto' } }, `来源 ${model.total}`),
        composition ? h('span', { style: { minWidth: 0 } }, composition) : null),
      h('ul', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '4px' } },
        shown.map((/** @type {any} */ source) => h(SourceCard, { key: source.key, source, runId: model.runId, reportPath: model.reportPath }))),
      model.sources.length > shown.length || all
        ? h('button', { type: 'button', 'aria-expanded': all, onClick: () => setAll(!all), style: { ...textButton, ...meta, marginTop: '4px' } },
          all ? '收起' : `显示全部 ${model.sources.length} 条来源`)
        : null);
  };

  /** The bound run's sources, when the turn they follow belongs to it.
   *  @param {{ turn: { start?: number, end?: number } }} props */
  const TurnSources = ({ turn }) => {
    const runState = kit.useFrameState((/** @type {any} */ state) => state.runState);
    const session = kit.useFrameState((/** @type {any} */ state) => state.session);
    const evidence = kit.useFrameState((/** @type {any} */ state) => state.evidence);
    const model = kit.guarded('source cards', () => {
      if (session?.subagent === true) return null;
      const live = liveRunFor(runState, session);
      if (!live || !turnCarriesRun(turn, live)) return null;
      if (evidence && live.runId && evidence.runId !== live.runId) return null;
      return sourceCardsModel(evidence, kit.vocabulary);
    });
    if (!model) return null;
    return h(SourceCards, { model });
  };

  /**
   * The answer row: whatever this takeover shadows — the kernel's own answer,
   * the reply check, the delivered files — then the sources it stood on.
   * @param {any} props
   */
  function AnswerWithSources(props) {
    const Shadowed = kit.shadowed(slot, 'assistant-step', AnswerWithSources);
    const tail = typeof props?.useTurnData === 'function' ? props.useTurnData('turn-tail') : undefined;
    const newest = typeof props?.useChat === 'function'
      ? props.useChat((/** @type {any} */ snapshot) => {
        const order = snapshot?.timeline?.turnOrder;
        return Array.isArray(order) && order.length ? order[order.length - 1] : null;
      })
      : undefined;
    const own = Shadowed ? h(Shadowed, props) : null;
    const node = props?.node;
    const seq = node?.data?.finalNode?.seq;
    const closing = Number.isInteger(seq) && tail?.closing?.finalNode?.seq === seq && (newest === undefined || newest === node.data.turn);
    if (!closing) return own;
    return h(React.Fragment, null, own, h(TurnSources, { turn: { start: node?.location?.turn?.start?.time, end: tail?.time } }));
  }

  kit.guarded('source cards', () => kit.occupy({ slot, key: 'assistant-step', priority: -3, locale: 'chat' }, AnswerWithSources));
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({
  name: 'sources',
  inject,
  parts: Object.freeze([frameStyles, liveRunFor, turnCarriesRun, sourceStatusText, sourceCardsModel, apply]),
});
