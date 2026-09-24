/**
 * The reply check (L1) as a row under the answer it is about — and only when
 * the check found something: 「⚠ 2 处引用待核对」, opened into one entry per
 * flagged sentence with the reviewer's verdict, its one-line reason, the
 * source's own words and the source.
 *
 * Until 2026-09-23 the row was there for every checked answer — 「依据核对
 * ✓ 3 · ⚠ 1」, 「依据核对中…」 while the reviewer worked, 「依据核对没有完成」
 * when it failed — beside a sentence about how the check works. The owner's
 * ruling (整改方案 §5.3) follows what Claude Science does with its reviewer:
 * nothing is shown while checking, when everything checked out, or when the
 * check itself failed; a finding appears under the message it refers to, and
 * there is no tally of what passed.
 *
 * Hidden knowledge, read off the pinned 0.1.5-rc.2 client (`ui-chat`):
 *
 *  - There is no per-sentence seat in the transcript: the answer's prose is
 *    drawn by the kernel's markdown component with no hook into a sentence or
 *    a link. So the check is one row per answer, not a mark after a sentence
 *    (survey 2026-09-23 §1.5).
 *  - Every chat node renders through the keyed slot `conversation.chat.node`;
 *    `ui-chat` holds `assistant-step` at priority 0, and the lowest priority
 *    renders. This body takes the key over below it (-1) and renders the row
 *    it shadows first (`kit.shadowed`), then its own after the one answer a
 *    check is about. The delivered-files body sits below this one and does
 *    the same, so an answer can carry both.
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
 * comes after it, and says what the reviewer could not find in the sources.
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
 * What the row says, or null when there is nothing to say: a check still
 * running, one that failed, and one that found every cited sentence
 * supported all draw nothing. A problem is a sentence its source does not
 * support or could not be opened for, or a medicine statement the source
 * contradicts; a pharmacist caution on a medicine the answer names is one
 * too, and is never hidden.
 * @param {any} check
 * @returns {{ text: string, items: { sentence: string, reason: string, evidence: string, source: string, url: string }[], cautions: { title: string, message: string }[] } | null}
 */
export function replyCheckSummary(check) {
  if (!check || check.status !== 'done') return null;
  const words = /** @type {Record<string, string>} */ ({
    supported: '来源支持', partial: '来源部分支持', unsupported: '来源不支持', unresolvable: '来源打不开', uncertain: '无法判断',
  });
  const items = (Array.isArray(check.verdicts) ? check.verdicts : [])
    .filter((/** @type {any} */ verdict) => verdict && (verdict.verdict === 'unsupported' || verdict.verdict === 'unresolvable' || verdict.safety === 'contradicted'))
    .map((/** @type {any} */ verdict) => {
      const word = words[String(verdict.verdict)] ?? words.uncertain;
      const safety = verdict.safety === 'contradicted' ? '（用药说法与来源相反）' : '';
      return {
        sentence: String(verdict.sentence ?? ''),
        reason: `${word}${safety}${verdict.reason ? `：${String(verdict.reason)}` : ''}`,
        evidence: String(verdict.evidence ?? '').trim(),
        source: verdict.source?.number ? `[${verdict.source.number}] ${String(verdict.source.title ?? '')}` : '',
        url: /^https:\/\//.test(String(verdict.source?.url ?? '')) ? String(verdict.source.url) : '',
      };
    });
  const cautions = (Array.isArray(check.cautions) ? check.cautions : [])
    .map((/** @type {any} */ caution) => ({ title: String(caution?.title ?? ''), message: String(caution?.message ?? '') }))
    .filter((/** @type {{ title: string, message: string }} */ caution) => caution.title || caution.message);
  if (!items.length && !cautions.length) return null;
  const parts = [items.length ? `${items.length} 处引用待核对` : null, cautions.length ? `用药提示 ${cautions.length} 条` : null].filter(Boolean);
  return { text: `⚠ ${parts.join(' · ')}`, items, cautions };
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
  const { text, meta, card, tone, textButton, link } = frameStyles();

  /** @param {{ model: NonNullable<ReturnType<typeof replyCheckSummary>> }} props */
  function ReplyCheckRow({ model }) {
    const [open, setOpen] = react.useState(false);
    const entry = (/** @type {string} */ key, /** @type {any[]} */ ...children) => h('div', { key, style: { margin: '8px 0' } }, ...children);
    return h('div', { style: { marginTop: '8px' }, 'data-evimed-reply-check': 'warn' },
      h('button', {
        type: 'button', 'aria-expanded': open, onClick: () => setOpen(!open),
        style: { ...textButton, ...text, display: 'inline-flex', alignItems: 'center', gap: '4px', color: tone('warn') },
      }, model.text,
      h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        style: { transform: open ? 'rotate(90deg)' : 'none' } }, h('path', { d: 'm9 18 6-6-6-6' }))),
      open ? h('div', { style: { ...card, marginTop: '4px' } },
        ...model.items.map((item, index) => entry(`s${index}`,
          h('div', { style: { color: 'var(--dsw-alias-label-primary)' } }, item.sentence),
          h('div', { style: { ...meta, color: 'var(--dsw-alias-label-secondary)' } }, item.reason),
          item.evidence ? h('div', { style: { ...meta, whiteSpace: 'pre-wrap' } }, `原文：「${item.evidence}」`) : null,
          item.source ? h('div', { style: meta }, item.url ? h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', style: link }, item.source) : item.source) : null)),
        ...model.cautions.map((caution, index) => entry(`c${index}`,
          h('div', { style: { color: 'var(--dsw-alias-label-primary)' } }, `用药提示：${caution.title}`),
          caution.message ? h('div', { style: { ...meta, color: 'var(--dsw-alias-label-secondary)' } }, caution.message) : null))) : null);
  }

  /** @param {any} props */
  function AssistantStep(props) {
    const Shadowed = kit.shadowed(slot, 'assistant-step', AssistantStep);
    const state = kit.useFrameState((/** @type {any} */ frameState) => frameState.replyChecks);
    let model = null;
    try { model = replyCheckSummary(replyCheckFor(state, props?.node)); } catch { model = null; }
    const own = Shadowed ? h(Shadowed, props) : null;
    if (!model) return own;
    return h(react.Fragment, null, own, h(ReplyCheckRow, { model }));
  }

  kit.guarded('reply check row', () => kit.occupy({ slot, key: 'assistant-step', priority: -1, locale: 'chat' }, AssistantStep));
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({ name: 'reply-checks', inject, parts: Object.freeze([frameStyles, replyCheckFor, replyCheckSummary, apply]) });
