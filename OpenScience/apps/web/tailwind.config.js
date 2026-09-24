import {
  COLOR_ROLES,
  COLOR_ROLE_ALIASES,
  CONTAINERS,
  ELEVATION,
  FONT_STACKS,
  MOTION,
  RADII,
  TYPE_SCALE,
} from "@evimed/domain/design-tokens";

/**
 * The theme is derived, not typed.
 *
 * Every scale below is read from `packages/domain/src/designTokens.mjs`, the
 * same module that generates the custom properties in `src/index.css` and
 * feeds the kernel frame's theme override. A Tailwind class and a CSS variable
 * therefore cannot disagree about what `card` or `content` means — which they
 * did, in three directions, for as long as the two tables were maintained by
 * hand.
 *
 * Colours stay `var()` references so a theme switch is a class on `<html>` and
 * not a rebuild. One consequence to know: Tailwind 3 cannot decompose a
 * `var()` colour, so an opacity modifier (`bg-accent/10`, `text-muted/50`)
 * emits no CSS at all — ESLint rejects them, and a tint is its own token
 * (`-soft` / `-strong`).
 */

/** Role name → `var(--role)`, for Tailwind's colour map. */
const colors = Object.fromEntries(
  [...Object.keys(COLOR_ROLES), ...Object.keys(COLOR_ROLE_ALIASES)].map((role) => [role, `var(--${role})`]),
);

/** Rung name → `[size, lineHeight]`, Tailwind's `fontSize` shape. */
const fontSize = Object.fromEntries(
  Object.entries(TYPE_SCALE).map(([rung, { size, lineHeight }]) => [rung, [`${size}px`, lineHeight]]),
);

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ...colors,
        // `--badge` is a colour and `badge` is also a type rung, so `unread`
        // names the colour: `text-badge` would otherwise set both at once.
        unread: "var(--badge)",
        "unread-fg": "var(--badge-fg)",
        // Retired shorthands the pages still say. `faint` is the hairline's
        // faintest step, `strong` the control boundary.
        faint: "var(--border-faint)",
        strong: "var(--border-control)",
      },

      // Two durations: a state change (press, toggle, chevron) and a container
      // (menu, drawer, panel). `prefers-reduced-motion` collapses both to an
      // instant in src/index.css.
      transitionDuration: {
        fast: MOTION.fast,
        base: MOTION.base,
      },
      transitionTimingFunction: {
        standard: MOTION.easeStandard,
      },
      // One sans stack for the shell and the frame; mono for identifiers that
      // are compared character by character. There is no serif family —
      // `font-serif` resolves to the sans stack so a page nobody has migrated
      // yet renders in it rather than falling to the browser's Georgia.
      fontFamily: {
        sans: FONT_STACKS.sans,
        serif: FONT_STACKS.sans,
        mono: FONT_STACKS.mono,
      },
      // Eight named rungs over five sizes (12/14/16/20/24), and nothing
      // else: `designTokens.test.ts` asserts the set is closed, and ESLint
      // rejects `text-[Npx]` and Tailwind's own `text-sm`-style defaults.
      fontSize,
      // Containers. A page's title and body share one of these — `PageShell`
      // is what makes that structural. `page` is the one column every page
      // sits in; `measure` caps a paragraph at 40 CJK characters.
      // NOTE: `content` intentionally overrides Tailwind's own `max-w-content`.
      maxWidth: {
        "content-narrow": `${CONTAINERS.narrow}px`,
        content: `${CONTAINERS.content}px`,
        page: `${CONTAINERS.page}px`,
        measure: `${CONTAINERS.measure}px`,
        "measure-body": `${CONTAINERS.measureBody}px`,
        // Retired names of `page`, pointed at the same width so an unmigrated
        // call site converges rather than breaking.
        "content-wide": `${CONTAINERS.wide}px`,
        "content-full": `${CONTAINERS.full}px`,
      },
      // Radii by what wears them: a tag 4, controls and rows 8 (bare
      // `rounded`), cards, popovers and dialogs 12, the composer 24, pills
      // `rounded-full`. `panel` is the retired dialog step, now 12.
      borderRadius: {
        DEFAULT: `${RADII.control}px`,
        tag: `${RADII.tag}px`,
        input: `${RADII.control}px`,
        card: `${RADII.card}px`,
        panel: `${RADII.panel}px`,
        composer: `${RADII.composer}px`,
      },
      // Structure is hairlines, not shadows. A static card has none (a 1 px
      // border is its whole edge); only what floats casts one: `pop` for menus
      // and popovers, `modal` for dialogs and drawers.
      boxShadow: {
        pop: ELEVATION.pop,
        modal: ELEVATION.modal,
      },
      // A drawer arrives from the edge it lives on, in the base duration;
      // used as `motion-safe:animate-drawer-in`, so reduced motion gets none.
      keyframes: {
        "drawer-in": {
          from: { transform: "translateX(24px)", opacity: "0" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
      },
      animation: {
        "drawer-in": "drawer-in var(--dur-base) var(--ease-standard)",
      },
    },
  },
  plugins: [],
};
