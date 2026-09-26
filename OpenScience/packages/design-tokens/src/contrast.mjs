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
import { COLOR_ROLES, colorRole, resolveColor } from './index.mjs'

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
 * The contrast ratio of two opaque colours, rounded to two decimals the way
 * the notes quote it.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

/**
 * One requirement: a foreground role on a background role, at a floor.
 * @typedef {{ fg: string, bg: string, min: number, what: string }} ContrastRule
 */

/**
 * What the design language promises, as checkable pairs.
 *
 * 4.5 is WCAG AA for body text, 3.0 is AA for large text and for the visible
 * boundary of a control (1.4.11). A graphic that carries no meaning on its own
 * — a chart gridline, the `text-graphic` rule colour — is not listed, because
 * it is not making a promise.
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
  { fg: 'accent', bg: 'bg', min: 4.5, what: 'a link on the canvas' },
  { fg: 'accent', bg: 'surface', min: 4.5, what: 'a link on a card' },
  { fg: 'accent-fg', bg: 'accent', min: 4.5, what: 'the primary button label' },
  { fg: 'accent-strong', bg: 'accent-soft', min: 4.5, what: 'text on a selected row' },
  { fg: 'error', bg: 'bg', min: 4.5, what: 'a safety notice on the canvas' },
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
  { fg: 'dot-running', bg: 'bg', min: 3, what: 'the running dot' },
  { fg: 'dot-failed', bg: 'bg', min: 3, what: 'the failed dot' },
  { fg: 'dot-done', bg: 'bg', min: 3, what: 'the finished dot' },
])

/**
 * One measured result.
 * @typedef {{ rule: ContrastRule, scheme: 'light' | 'dark', ratio: number, ok: boolean }} ContrastResult
 */

/**
 * Measure every rule in both schemes.
 * @returns {ContrastResult[]}
 */
export function measureContrast() {
  /** @type {ContrastResult[]} */
  const results = []
  for (const scheme of /** @type {const} */ (['light', 'dark'])) {
    for (const rule of CONTRAST_RULES) {
      const fg = resolveColor(colorRole(rule.fg, scheme))
      const bg = resolveColor(colorRole(rule.bg, scheme))
      const ratio = contrastRatio(fg, bg)
      results.push({ rule, scheme, ratio, ok: ratio >= rule.min })
    }
  }
  return results
}

/**
 * Every failure, as a line a build log can print. Empty means the table keeps
 * its promises.
 * @returns {string[]}
 */
export function contrastFailures() {
  return measureContrast()
    .filter((result) => !result.ok)
    .map(
      ({ rule, scheme, ratio }) =>
        `${scheme}: ${rule.what} — --${rule.fg} on --${rule.bg} is ${ratio.toFixed(2)}:1, needs ${rule.min}:1`,
    )
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
