/**
 * The frame bodies' shared look: inline style objects over the kernel's own
 * tokens, so a card sits in the transcript and a tab in the right column the
 * way the kernel's own rows do, in both schemes, under the theme layer.
 *
 * Inline styles, not a stylesheet: the bodies reach the page as serialized
 * functions with no asset pipeline, and a style object dies with the element
 * that carries it. The sizes are the kernel tool row's own
 * (`--dsh-content-font-size-secondary`, `--dsh-content-font-delta`), so the
 * reader's font-size setting moves these with everything else.
 *
 * Emitted into each body that lists it among its parts.
 *
 * @module @evimed/harness-port/runtime-ui-styles
 */

/**
 * @returns {{
 *   tone: (name: string) => string,
 *   secondary: Record<string, any>, card: Record<string, any>, line: Record<string, any>,
 *   title: Record<string, any>, quiet: Record<string, any>, pill: (name: string) => Record<string, any>,
 *   button: Record<string, any>, section: Record<string, any>, empty: Record<string, any>,
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
  const secondary = { fontSize: 'var(--dsh-content-font-size-secondary, 13px)', lineHeight: 'calc(22px + var(--dsh-content-font-delta, 0px))' };
  return {
    tone,
    secondary,
    card: {
      ...secondary,
      border: '0.5px solid var(--dsw-alias-border-l2)',
      borderRadius: '10px',
      background: 'var(--dsw-alias-bg-layer-1)',
      padding: '8px 12px',
      margin: '2px 0',
      color: 'var(--dsw-alias-label-secondary)',
      minWidth: 0,
    },
    line: { ...secondary, display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0, color: 'var(--dsw-alias-label-secondary)' },
    title: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500, flex: 'none' },
    quiet: { color: 'var(--dsw-alias-label-tertiary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    pill: (name) => ({ color: tone(name), flex: 'none', fontWeight: 500 }),
    button: {
      ...secondary,
      marginLeft: 'auto',
      flex: 'none',
      border: '0.5px solid var(--dsw-alias-border-l4)',
      borderRadius: '6px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      padding: '0 8px',
      cursor: 'pointer',
      font: 'inherit',
    },
    section: { ...secondary, color: 'var(--dsw-alias-label-tertiary)', margin: '12px 0 4px', fontWeight: 500 },
    empty: { ...secondary, color: 'var(--dsw-alias-label-tertiary)', padding: '24px 16px', textAlign: 'center' },
  };
}
