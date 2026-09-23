/**
 * The reply check (L1) as a row under the answer it is about: 「依据核对 ✓ 3 ·
 * ⚠ 1」, opened into one line per cited sentence — the verdict, the reviewer's
 * reason, the source.
 *
 * Hidden knowledge, read off the pinned 0.1.5-rc.2 client (`ui-chat`):
 *
 *  - There is no per-sentence seat in the transcript: the answer's prose is
 *    drawn by the kernel's markdown component with no hook into a sentence or
 *    a link. So the check is one row per answer, not a mark after a sentence
 *    (survey 2026-09-23 §1.5).
 *  - Every chat node renders through the keyed slot `conversation.chat.node`;
 *    `ui-chat` holds `assistant-step` at priority 0, and the lowest priority
 *    renders. This body takes the key over below it and renders the kernel's
 *    own component — found through the slot ledger's `entries()`, the
 *    documented inspection surface, exactly as the transcript body does for a
 *    recall row — then adds its row after the one answer a check is about.
 *    Every other assistant step renders as it would without this body.
 *  - Which answer: the check carries the event sequence of the closing
 *    assistant message the control plane read the reply from; the kernel's
 *    node carries the same sequence as `finalNode.seq`. Both sides read it
 *    off the same session event.
 *  - The frame has no fetch of its own. The shell polls the control plane for
 *    the open conversation's checks and posts them in (`reply-check`, kept as
 *    frame state by the hub); a check that arrives after the answer is drawn
 *    re-renders the row, nothing else.
 *
 * Nothing here holds, hides or changes the answer (principle 13): the row
 * comes after it, and says what the reviewer could and could not find.
 *
 * @module @evimed/harness-port/runtime-ui-reply-checks
 */

import { frameStyles } from './runtimeUiStyles.mjs';

/** Services this body needs outright: the slot registry. */
export const inject = ['slots'];

/**
 * The check a rendered assistant step carries, or null: the one whose closing
 * sequence is this node's final message.
 * @param {any} state the frame's `replyChecks` state
 * @param {any} node the chat node the kernel is rendering
 * @returns {any}
 */
export function replyCheckFor(state, node) {
  const checks = Array.isArray(state?.checks) ? state.checks : [];
  const seq = node?.data?.finalNode?.seq;
  if (!Number.isInteger(seq) || !checks.length) return null;
  return checks.find((/** @type {any} */ check) => check && check.turnSeq === seq) ?? null;
}

/**
 * What the row says: its tone, its one-line summary, and one entry per
 * sentence and pharmacist caution.
 * @param {any} check
 * @returns {{ tone: 'ok'|'warn'|'active'|'muted', text: string, items: { mark: string, tone: string, sentence: string, reason: string, source: string, url: string }[], cautions: { title: string, message: string }[] }}
 */
export function replyCheckSummary(check) {
  const verdicts = Array.isArray(check?.verdicts) ? check.verdicts : [];
  const cautions = (Array.isArray(check?.cautions) ? check.cautions : [])
    .map((/** @type {any} */ caution) => ({ title: String(caution?.title ?? ''), message: String(caution?.message ?? '') }))
    .filter((/** @type {{ title: string, message: string }} */ caution) => caution.title || caution.message);
  if (check?.status === 'queued' || check?.status === 'running') {
    return { tone: 'active', text: '依据核对中…', items: [], cautions: [] };
  }
  if (check?.status === 'failed') return { tone: 'muted', text: '依据核对没有完成', items: [], cautions: [] };
  const marks = /** @type {Record<string, { mark: string, tone: string, word: string }>} */ ({
    supported: { mark: '✓', tone: 'ok', word: '来源支持' },
    partial: { mark: '◐', tone: 'active', word: '来源部分支持' },
    unsupported: { mark: '⚠', tone: 'warn', word: '来源不支持' },
    unresolvable: { mark: '⚠', tone: 'warn', word: '来源打不开' },
    uncertain: { mark: '·', tone: 'muted', word: '无法判断' },
  });
  const items = verdicts.map((/** @type {any} */ verdict) => {
    const known = marks[String(verdict?.verdict)] ?? marks.uncertain;
    const safety = verdict?.safety === 'contradicted' ? '（用药说法与来源相反）' : '';
    return {
      mark: known.mark,
      tone: known.tone,
      sentence: String(verdict?.sentence ?? ''),
      reason: `${known.word}${safety}${verdict?.reason ? `：${String(verdict.reason)}` : ''}`,
      source: verdict?.source?.number ? `[${verdict.source.number}] ${String(verdict.source.title ?? '')}` : '',
      url: /^https:\/\//.test(String(verdict?.source?.url ?? '')) ? String(verdict.source.url) : '',
    };
  });
  const ok = items.filter((/** @type {any} */ item) => item.mark === '✓').length;
  const warn = items.filter((/** @type {any} */ item) => item.mark === '⚠').length;
  const parts = [];
  if (items.length) parts.push(`依据核对 ✓ ${ok}${warn ? ` · ⚠ ${warn}` : ''}${items.length - ok - warn ? ` · 其他 ${items.length - ok - warn}` : ''}`);
  if (cautions.length) parts.push(`用药提示 ${cautions.length} 条`);
  if (!parts.length) return { tone: 'muted', text: '', items, cautions };
  return { tone: warn || cautions.length ? 'warn' : 'ok', text: parts.join(' · '), items, cautions };
}

/**
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} [_target] Browser global.
 * @param {(id: string) => any} [_require]
 * @param {any} [kit] The frame kit.
 */
export function apply(ctx, _config, _target = globalThis, _require = undefined, kit = undefined) {
  if (!kit || !kit.ours || !kit.h || !kit.react) return;
  const h = kit.h;
  const react = kit.react;
  const slot = 'conversation.chat.node';
  const styles = frameStyles();

  /** The kernel's own renderer for an assistant step: the next entry below ours. */
  function shippedAssistantStep() {
    const entries = typeof ctx.slots?.entries === 'function' ? ctx.slots.entries(slot) : [];
    const entry = (Array.isArray(entries) ? entries : []).find((/** @type {any} */ candidate) => candidate
      && candidate.options && candidate.options.key === 'assistant-step' && candidate.component !== AssistantStep
      && (candidate.options.priority ?? 0) >= 0);
    return entry ? entry.component : null;
  }

  /** @param {{ check: any }} props */
  function ReplyCheckRow({ check }) {
    const [open, setOpen] = react.useState(false);
    const model = replyCheckSummary(check);
    if (!model.text) return null;
    const expandable = model.items.length > 0 || model.cautions.length > 0;
    return h('div', { style: { ...styles.card, margin: '4px 0 2px' }, 'data-evimed-reply-check': model.tone },
      h('div', { style: styles.line },
        h('span', { style: styles.pill(model.tone) }, model.text),
        h('span', { style: styles.quiet }, '独立审查按来源原文逐句核对，不改动回答'),
        expandable ? h('button', { type: 'button', style: styles.button, onClick: () => setOpen(!open), 'aria-expanded': open }, open ? '收起' : '查看') : null),
      open ? h('div', { style: { marginTop: '6px' } },
        ...model.items.map((item, index) => h('div', { key: `s${index}`, style: { ...styles.secondary, margin: '6px 0' } },
          h('div', { style: { color: 'var(--dsw-alias-label-primary)' } }, h('span', { style: { ...styles.pill(item.tone), marginRight: '6px' } }, item.mark), item.sentence),
          h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, item.reason),
          item.source ? h('div', { style: styles.quiet }, item.url ? h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.source) : item.source) : null)),
        ...model.cautions.map((caution, index) => h('div', { key: `c${index}`, style: { ...styles.secondary, margin: '6px 0' } },
          h('span', { style: { ...styles.pill('warn'), marginRight: '6px' } }, '用药提示'),
          h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, caution.title),
          caution.message ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, caution.message) : null))) : null);
  }

  /** @param {any} props */
  function AssistantStep(props) {
    const Shipped = shippedAssistantStep();
    const state = kit.useFrameState((/** @type {any} */ frameState) => frameState.replyChecks);
    let check = null;
    try { check = replyCheckFor(state, props?.node); } catch { check = null; }
    const own = Shipped ? h(Shipped, props) : null;
    if (!check) return own;
    return h(react.Fragment, null, own, h(ReplyCheckRow, { check }));
  }

  kit.guarded('reply check row', () => kit.occupy({ slot, key: 'assistant-step', priority: -1, locale: 'chat' }, AssistantStep));
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({ name: 'reply-checks', inject, parts: Object.freeze([frameStyles, replyCheckFor, replyCheckSummary, apply]) });
