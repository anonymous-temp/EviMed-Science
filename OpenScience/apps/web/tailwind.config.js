import preset from "@evimed/design-tokens/tailwind";

/**
 * The theme is derived, not typed.
 *
 * Every scale comes from `@evimed/design-tokens` through its generated preset
 * — the same table that writes the custom properties in `src/index.css`, the
 * Element Plus theme the Vue shell links, the ECharts theme both sides
 * register, and the kernel frame's theme override. A Tailwind class and a CSS
 * variable therefore cannot disagree about what `card` or `accent` means,
 * which they did, in three directions, for as long as the tables were
 * maintained by hand.
 *
 * The Vue shell's own `tailwind.config.js` extends the same preset, so the two
 * front ends cannot disagree either. That is the whole mechanism: not a
 * document both teams are asked to remember.
 *
 * Colours stay `var()` references so a theme switch is a class on `<html>` and
 * not a rebuild. One consequence to know: Tailwind 3 cannot decompose a
 * `var()` colour, so an opacity modifier (`bg-accent/10`, `text-muted/50`)
 * emits no CSS at all — ESLint rejects them, and a tint is its own token
 * (`-soft` / `-strong`).
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  presets: [preset],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  plugins: [],
};
