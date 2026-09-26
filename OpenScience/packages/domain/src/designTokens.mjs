/**
 * The design tokens, re-exported.
 *
 * The table moved to `@evimed/design-tokens` when the fusion gave it a third
 * consumer — the Vue shell, which is another repository and cannot import a
 * module out of `@evimed/domain`'s source tree. This file holds no values, for
 * the same reason `clinicalEvidenceQuality.mjs` holds no rules: a value added
 * here instead of in the package would be invisible to the Vue side, which is
 * exactly the drift the package exists to make impossible.
 *
 * New code should import `@evimed/design-tokens` directly. This subpath stays
 * because `apps/web/tailwind.config.js`, `runtimeUiTheme.mjs` and the pages
 * already say it, and a rename is not a design change.
 *
 * @module @evimed/domain/design-tokens
 */
export {
  CHART_COLORS,
  CHART_SERIES,
  COLOR_RAMPS,
  COLOR_ROLE_ALIASES,
  COLOR_ROLES,
  CONTAINERS,
  CONTROL_HEIGHTS,
  DESIGN_TOKENS_VERSION,
  ELEVATION,
  FONT_STACKS,
  FONT_WEIGHTS,
  ICON_SIZES,
  ICON_STROKE,
  MOTION,
  RADII,
  SPACE,
  STUDY_TYPE_BADGES,
  TYPE_SCALE,
  TYPE_SIZES,
  colorRole,
  resolveColor,
} from '@evimed/design-tokens'
export { DESIGN_TOKENS_CSS_BEGIN, DESIGN_TOKENS_CSS_END, designTokensCss } from '@evimed/design-tokens/css'
export { kernelThemeTokens } from '@evimed/design-tokens/kernel'
