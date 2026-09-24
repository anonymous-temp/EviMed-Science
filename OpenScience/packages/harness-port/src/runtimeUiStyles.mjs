/**
 * The frame bodies' shared look: inline style objects over the kernel's own
 * tokens, so a card in the transcript reads as the shell's own card, in both
 * schemes, under the theme layer.
 *
 * Inline styles, not a stylesheet: the bodies reach the page as serialized
 * functions with no asset pipeline, and a style object dies with the element
 * that carries it.
 *
 * The geometry is the shell's (`@evimed/domain/design-tokens`, 整改方案 §4),
 * written here as numbers because a body may import nothing: a card is 12 px
 * round, a control 8 and 24 px high inline, a tag 4 and 20 px high, every edge
 * one 1 px hairline, and text 14 px with 12 px for metadata. Colour arrives
 * only through the kernel's `--dsw-*` roles, which the theme body points at
 * the shell's tokens — never a literal, so a token moved in the shell moves
 * here too. Body text follows the kernel's own content size
 * (`--dsh-content-font-size`, 14 px by default), as the rows around it do.
 *
 * Emitted into each body that lists it among its parts.
 *
 * @module @evimed/harness-port/runtime-ui-styles
 */

/**
 * @returns {{
 *   tone: (name: string) => string,
 *   text: Record<string, any>, meta: Record<string, any>, card: Record<string, any>, line: Record<string, any>,
 *   title: Record<string, any>, quiet: Record<string, any>, tag: Record<string, any>,
 *   button: Record<string, any>, textButton: Record<string, any>, link: Record<string, any>,
 * }}
 */
export function frameStyles() {
  const tones = {
    ok: 'var(--dsw-alias-state-success-primary)',
    warn: 'var(--dsw-alias-state-warn-label)',
    active: 'var(--dsw-alias-state-business-primary)',
    muted: 'var(--dsw-alias-label-tertiary)',
  };
  /** @param {string} name */
  const tone = (name) => /** @type {Record<string, string>} */ (tones)[name] ?? tones.muted;
  const text = { fontSize: 'var(--dsh-content-font-size, 14px)', lineHeight: 'calc(22px + var(--dsh-content-font-delta, 0px))' };
  const meta = { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' };
  const ellipsis = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
  return {
    tone,
    text,
    meta,
    card: {
      ...text,
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '12px',
      padding: '8px 12px',
      margin: '2px 0',
      color: 'var(--dsw-alias-label-secondary)',
      minWidth: 0,
      boxSizing: 'border-box',
    },
    line: { ...text, display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, color: 'var(--dsw-alias-label-secondary)' },
    title: { ...ellipsis, color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
    quiet: { ...ellipsis, color: 'var(--dsw-alias-label-tertiary)' },
    // A tag that nothing clicks: grey, 20 px high, radius 4. Colour is for
    // clinical safety alone (整改方案 §4), so a state is words on grey.
    tag: {
      flex: 'none', display: 'inline-block', height: '20px', padding: '0 6px', borderRadius: '4px',
      fontSize: '12px', lineHeight: '20px', whiteSpace: 'nowrap',
      background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)',
    },
    // The secondary button: a grey fill, no outline, 24 px high inline.
    button: {
      flex: 'none', height: '24px', padding: '0 8px', borderRadius: '8px', border: 'none',
      fontFamily: 'inherit', fontSize: '12px', lineHeight: '24px', cursor: 'pointer',
      background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
    },
    // The text button: no fill until hovered, the same height.
    textButton: {
      flex: 'none', height: '24px', padding: '0 4px', borderRadius: '8px', border: 'none',
      fontFamily: 'inherit', fontSize: 'inherit', lineHeight: '24px', cursor: 'pointer',
      background: 'transparent', color: 'inherit',
    },
    link: { color: 'var(--dsw-alias-link)', textDecoration: 'none' },
  };
}
