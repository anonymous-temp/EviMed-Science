/**
 * Contrast, measured rather than asserted.
 *
 * The role table carries `note` fields like "6.24 on the page". Those numbers
 * were true when someone typed them and silently stopped being true the next
 * time a step moved — which is the same failure mode as two hand-maintained
 * token tables, one scale smaller. So the build recomputes every pair it
 * cares about with the WCAG 2.1 relative-luminance formula and fails on a
 * shortfall, and the notes are regenerated from the measurement.
 *
 * @module @evimed/design-tokens/contrast
 */
import { CHART_COLORS, CHART_OWN, COLOR_ROLES, COLOR_ROLES_MORE_CONTRAST, colorRole, resolveColor } from './index.mjs'

/**
 * sRGB hex → relative luminance (WCAG 2.1 §relative luminance).
 * @param {string} hex
 * @returns {number}
 */
export function luminance(hex) {
  const value = hex.trim().replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`contrast: not an opaque hex colour: "${hex}"`)
  /** @param {number} offset @returns {number} */
  const channel = (offset) => {
    const srgb = parseInt(full.slice(offset, offset + 2), 16) / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/**
 * The exact contrast ratio of two opaque colours.
 *
 * Unrounded on purpose. `contrastRatio` used to round to the two decimals the
 * notes quote, and a pair at 4.4995 then read as "4.50" and passed a 4.5 floor
 * — a measurement that flatters itself is worse than no measurement, and the
 * kernel frame's own test, which does not round, is what caught it.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The same ratio at the two decimals a note quotes. Never compared to a floor.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function quotedContrast(a, b) {
  return Math.round(contrastRatio(a, b) * 100) / 100
}

/**
 * One requirement: a foreground role on a background role, at a floor.
 * @typedef {{ fg: string, bg: string, min: number, what: string }} ContrastRule
 */

/**
 * The grounds a status dot is drawn on: the canvas, a card, and the sidebar
 * (`surface-1`), where a conversation row carries one. A dot was measured on
 * the canvas only, and a graphic that clears 3:1 there can fail on the ground
 * next to it — 已停止 was 2.59:1 on the sidebar before 2.1.3.
 */
const DOT_GROUNDS = /** @type {const} */ (['bg', 'surface', 'surface-1'])
const GROUND_NAMES = /** @type {const} */ ({ bg: 'the canvas', surface: 'a card', 'surface-1': 'the sidebar' })

/**
 * The run-state dots (`RunStatusDot`): graphics that carry a meaning, so each
 * is a non-text graphic at 3:1 (WCAG 1.4.11) on every ground it sits on.
 */
const DOT_RULES = /** @type {const} */ ([
  ['dot-running', 'the running dot'],
  ['dot-done', 'the finished dot'],
  ['dot-review', 'the finished-with-something-to-check dot'],
  ['dot-failed', 'the failed dot'],
  ['dot-canceled', 'the stopped dot'],
]).flatMap(([fg, what]) => DOT_GROUNDS.map((bg) => ({ fg, bg, min: 3, what: `${what} on ${GROUND_NAMES[bg]}` })))

/**
 * What the design language promises, as checkable pairs.
 *
 * 4.5 is WCAG AA for body text, 3.0 is AA for large text and for the visible
 * boundary of a control (1.4.11), and for a graphic that carries a meaning —
 * the run-state dots.
 *
 * `text-graphic` is the one grey that makes no 3:1 promise, and it says so
 * rather than being left out: it is for icons and hairline rules that mean
 * nothing on their own, never for a word and never for a status. It gets a
 * floor (2.5:1, so that a decoration stays perceivable and cannot be lightened
 * into nothing) and a structural rule (`sharedWithGraphic`: no `dot-*` role may
 * resolve to its colour — that was the 已停止 defect). Its documented figure,
 * 2.69 on the page, is held by the note check (`staleNotes`).
 *
 * @type {readonly ContrastRule[]}
 */
export const CONTRAST_RULES = Object.freeze([
  { fg: 'text', bg: 'bg', min: 4.5, what: 'body text on the canvas' },
  { fg: 'text', bg: 'surface', min: 4.5, what: 'body text on a card' },
  { fg: 'text', bg: 'surface-1', min: 4.5, what: 'body text on the sidebar' },
  { fg: 'text', bg: 'surface-2', min: 4.5, what: 'body text on a hovered row' },
  { fg: 'text-2', bg: 'bg', min: 4.5, what: 'secondary text on the canvas' },
  { fg: 'text-2', bg: 'surface-1', min: 4.5, what: 'secondary text on the sidebar' },
  { fg: 'text-3', bg: 'bg', min: 4.5, what: 'metadata on the canvas' },
  { fg: 'text-3', bg: 'surface-1', min: 4.5, what: 'metadata on the sidebar — the lightest text there is' },
  { fg: 'text-3', bg: 'surface-2', min: 4.5, what: 'metadata on a hovered row' },
  // The darkest ground text is drawn on: an inset track here, `bg-layer-3` in
  // the kernel frame. It was missing from this list, and the frame's own test
  // is what found the 4.27:1 that followed.
  { fg: 'text-3', bg: 'surface-3', min: 4.5, what: 'metadata on an inset track' },
  { fg: 'text-2', bg: 'surface-3', min: 4.5, what: 'secondary text on an inset track' },
  { fg: 'accent', bg: 'bg', min: 4.5, what: 'a link on the canvas' },
  { fg: 'accent', bg: 'surface', min: 4.5, what: 'a link on a card' },
  { fg: 'accent-fg', bg: 'accent', min: 4.5, what: 'the primary button label' },
  { fg: 'accent-strong', bg: 'accent-soft', min: 4.5, what: 'text on a selected row' },
  { fg: 'error', bg: 'bg', min: 4.5, what: 'a safety notice on the canvas' },
  { fg: 'error', bg: 'surface-3', min: 4.5, what: 'a safety notice on an inset track' },
  { fg: 'warn', bg: 'surface-3', min: 4.5, what: 'an attention mark on an inset track' },
  { fg: 'ok', bg: 'surface-3', min: 4.5, what: 'a completed state on an inset track' },
  { fg: 'accent', bg: 'surface-3', min: 4.5, what: 'a link on an inset track' },
  { fg: 'danger-strong', bg: 'danger-soft', min: 4.5, what: 'text in a safety card' },
  { fg: 'error-fg', bg: 'error', min: 4.5, what: 'the label of a destructive button' },
  { fg: 'warn-strong', bg: 'warn-soft', min: 4.5, what: 'text in an attention notice' },
  { fg: 'warn', bg: 'bg', min: 4.5, what: 'an attention mark on the canvas' },
  { fg: 'ok', bg: 'bg', min: 4.5, what: 'a completed state on the canvas' },
  { fg: 'badge-fg', bg: 'badge', min: 4.5, what: 'an unread count' },
  { fg: 'text', bg: 'highlight', min: 4.5, what: 'body text under the highlighter' },
  { fg: 'border-control', bg: 'bg', min: 3, what: 'the edge of an input on the canvas' },
  { fg: 'border-control', bg: 'surface-1', min: 3, what: 'the edge of an input on the sidebar' },
  { fg: 'focus', bg: 'bg', min: 3, what: 'the focus ring' },
  ...DOT_RULES,
  { fg: 'text-graphic', bg: 'bg', min: 2.5, what: 'a decorative icon or rule on the canvas — never text, never a status' },
  { fg: 'text-graphic', bg: 'surface', min: 2.5, what: 'a decorative icon or rule on a card — never text, never a status' },
])

/**
 * One data colour on one ground: a literal from `CHART_COLORS` against a role.
 * @typedef {{ name: string, color: string, bg: string, scheme: 'light' | 'dark', min: number, what: string }} DataContrastRule
 */

/**
 * The data colours that make a promise: each rival grey is a line or a mark a
 * reader has to find, so it is a graphic at 3:1 (WCAG 1.4.11) on the page and
 * on a card, and on the dark canvas. 2.0's third rival was 1.92:1 on white and
 * nothing measured it (spec §32.4, appendix E #22). The categorical series are
 * not listed: slots 2, 6 and 8 sit under 3:1 on white by design and carry
 * direct labels instead (§32.4).
 *
 * @type {readonly DataContrastRule[]}
 */
export const DATA_CONTRAST_RULES = Object.freeze([
  ...(/** @type {const} */ ([['bg', 'light'], ['surface', 'light'], ['bg', 'dark'], ['surface', 'dark']])).map(([bg, scheme]) => ({
    name: 'chart-own', color: CHART_OWN[scheme], bg, scheme, min: 3, what: 'our own series as a line or mark',
  })),
  ...CHART_COLORS.rivals.flatMap((color, index) =>
    /** @type {const} */ ([
      ['bg', 'light'],
      ['surface', 'light'],
      ['bg', 'dark'],
    ]).map(([bg, scheme]) => ({
      name: `chart-rival-${index + 1}`,
      color,
      bg,
      scheme,
      min: 3,
      what: `rival ${index + 1} as a line or mark`,
    })),
  ),
])

/**
 * One measured result.
 * @typedef {{ rule: ContrastRule, scheme: 'light' | 'dark', variant: 'standard' | 'more', ratio: number, ok: boolean }} ContrastResult
 */

/**
 * A role's colour under a contrast variant: the table, or the table with the
 * more-contrast overrides applied.
 * @param {string} role
 * @param {'light' | 'dark'} scheme
 * @param {'standard' | 'more'} variant
 * @returns {string}
 */
export function roleColor(role, scheme, variant = 'standard') {
  const override = variant === 'more' ? COLOR_ROLES_MORE_CONTRAST[role] : undefined
  return resolveColor(override ? override[scheme] : colorRole(role, scheme))
}

/**
 * Measure every rule in both schemes, under the standard table and under the
 * more-contrast layer — every combination a reader can be shown.
 * @returns {ContrastResult[]}
 */
export function measureContrast() {
  /** @type {ContrastResult[]} */
  const results = []
  for (const variant of /** @type {const} */ (['standard', 'more'])) {
    for (const scheme of /** @type {const} */ (['light', 'dark'])) {
      for (const rule of CONTRAST_RULES) {
        const ratio = contrastRatio(roleColor(rule.fg, scheme, variant), roleColor(rule.bg, scheme, variant))
        results.push({ rule, scheme, variant, ratio, ok: ratio >= rule.min })
      }
    }
  }
  return results
}

/**
 * Every failure, as a line a build log can print. Empty means the table keeps
 * its promises — the roles in both schemes and both contrast variants, and the
 * data colours that promise to be seen. Compared unrounded.
 * @returns {string[]}
 */
export function contrastFailures() {
  const roles = measureContrast()
    .filter((result) => !result.ok)
    .map(
      ({ rule, scheme, variant, ratio }) =>
        `${scheme}${variant === 'more' ? ' (more contrast)' : ''}: ${rule.what} — --${rule.fg} on --${rule.bg} is ${ratio.toFixed(2)}:1, needs ${rule.min}:1`,
    )
  const data = DATA_CONTRAST_RULES.map((rule) => ({ rule, ratio: contrastRatio(rule.color, colorRole(rule.bg, rule.scheme)) }))
    .filter(({ rule, ratio }) => ratio < rule.min)
    .map(
      ({ rule, ratio }) =>
        `${rule.scheme}: ${rule.what} — --${rule.name} (${rule.color}) on --${rule.bg} is ${ratio.toFixed(2)}:1, needs ${rule.min}:1`,
    )
  return [...roles, ...data, ...sharedWithGraphic(), ...staleNotes()]
}

/**
 * Every `dot-*` role that resolves to `text-graphic`'s colour in some scheme
 * and contrast variant. A dot says something (running, stopped, failed); the
 * decorative grey says nothing, and a mark that borrows it inherits a contrast
 * that was never promised — 已停止 did, at 2.69:1 and 2.71:1.
 * @param {Readonly<Record<string, import('./index.mjs').ColorRole>>} [roles] the table to read; the real one by default
 * @returns {string[]}
 */
export function sharedWithGraphic(roles = COLOR_ROLES) {
  /** @type {string[]} */
  const shared = []
  /** @param {string} role @param {'light' | 'dark'} scheme @param {'standard' | 'more'} variant */
  const colour = (role, scheme, variant) => {
    const override = variant === 'more' ? COLOR_ROLES_MORE_CONTRAST[role] : undefined
    return resolveColor((override ?? roles[role])[scheme])
  }
  for (const variant of /** @type {const} */ (['standard', 'more'])) {
    for (const scheme of /** @type {const} */ (['light', 'dark'])) {
      const decoration = colour('text-graphic', scheme, variant)
      for (const role of Object.keys(roles).filter((name) => name.startsWith('dot-'))) {
        if (colour(role, scheme, variant) === decoration) {
          shared.push(`${scheme}${variant === 'more' ? ' (more contrast)' : ''}: --${role} is the same colour as --text-graphic (${decoration}); a status mark cannot wear the decorative grey`)
        }
      }
    }
  }
  return shared
}

/**
 * A role's `note` quotes figures ("6.05 on the page; white on it 6.27"). They
 * were typed, and four of them were fiction before anything checked them. The
 * four phrases a note may use are read back and measured, light scheme, and
 * compared at the two decimals they quote:
 *
 *  - "N on the page"      the role on `bg`
 *  - "N on the sidebar"   the role on `surface-1`
 *  - "white on it N"      `#ffffff` on the role
 *  - "on <role>: N"       the role on that role
 *
 * @param {Readonly<Record<string, import('./index.mjs').ColorRole>>} [roles] the table to read; the real one by default
 * @returns {string[]} one line per quoted figure that is not the measured one
 */
export function staleNotes(roles = COLOR_ROLES) {
  /** @param {string} role */
  const light = (role) => resolveColor(roles[role].light)
  /** @type {string[]} */
  const stale = []
  /**
   * @param {string} role
   * @param {string} quoted
   * @param {string} fg
   * @param {string} bg
   * @param {string} phrase
   */
  const check = (role, quoted, fg, bg, phrase) => {
    const measured = quotedContrast(fg, bg).toFixed(2)
    if (measured !== quoted) stale.push(`--${role}: its note says "${phrase}" and it measures ${measured}`)
  }
  for (const [role, { note }] of Object.entries(roles)) {
    if (!note) continue
    const own = light(role)
    for (const match of note.matchAll(/(\d+\.\d+) on the page/g)) check(role, match[1], own, light('bg'), match[0])
    for (const match of note.matchAll(/(\d+\.\d+) on the sidebar/g)) check(role, match[1], own, light('surface-1'), match[0])
    for (const match of note.matchAll(/white on it (\d+\.\d+)/g)) check(role, match[1], '#ffffff', own, match[0])
    for (const match of note.matchAll(/on ([a-z0-9-]+): (\d+\.\d+)/g)) {
      if (roles[match[1]]) check(role, match[2], own, light(match[1]), match[0])
    }
  }
  return stale
}

/**
 * The measured note for a role, in the shape the table's `note` fields use, so
 * a reviewer reading the module sees a measurement rather than a memory.
 * @param {string} role
 * @returns {string | undefined}
 */
export function measuredNote(role) {
  if (!COLOR_ROLES[role]) return undefined
  const ratio = contrastRatio(resolveColor(colorRole(role, 'light')), resolveColor(colorRole('bg', 'light')))
  return `${ratio.toFixed(2)} on the page`
}
