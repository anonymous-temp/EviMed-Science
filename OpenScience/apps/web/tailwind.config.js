/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        border: "var(--border)",
        faint: "var(--border-faint)",
        text: "var(--text)",
        muted: "var(--muted)",
        accent: "var(--accent)",
        "accent-fg": "var(--accent-fg)",
        link: "var(--link)",
        warn: "var(--warn)",
        ok: "var(--ok)",
        error: "var(--error)",
        "error-fg": "var(--error-fg)",
        // Direction A's added roles (src/index.css). Opacity modifiers such as
        // `bg-accent/10` produce no CSS at all on a `var()` colour in Tailwind
        // 3, so every tint is a token of its own rather than an alpha.
        "accent-soft": "var(--accent-soft)",
        "accent-strong": "var(--accent-strong)",
        danger: "var(--danger)",
        "danger-soft": "var(--danger-soft)",
        "danger-strong": "var(--danger-strong)",
        "warn-soft": "var(--warn-soft)",
        "warn-strong": "var(--warn-strong)",
        "ok-soft": "var(--ok-soft)",
        "info-soft": "var(--info-soft)",
        "verify-ok": "var(--verify-ok)",
        "verify-pending": "var(--verify-pending)",
        focus: "var(--focus)",
        // `--badge` in CSS; `unread` here because `badge` is already a
        // font-size rung, and `text-badge` would then set both at once.
        unread: "var(--badge)",
        "unread-fg": "var(--badge-fg)",
        dot: {
          running: "var(--dot-running)",
          done: "var(--dot-done)",
          review: "var(--dot-review)",
          failed: "var(--dot-failed)",
          canceled: "var(--dot-canceled)",
        },
      },
      borderColor: {
        // `border-strong`: the visible boundary of a control (3:1). Plain
        // `border-border` is decoration.
        strong: "var(--border-strong)",
      },
      // Two durations: a state change (press, toggle, chevron) and a container
      // (menu, drawer, panel). `prefers-reduced-motion` collapses both to an
      // instant in src/index.css.
      transitionDuration: {
        fast: "120ms",
        base: "200ms",
      },
      // Latin faces first (they carry the metrics the type scale was measured
      // against), Chinese faces after them. Neither stack named a CJK face
      // until 2026-09-16, so `font-serif` — 31 uses, all of them Chinese page
      // titles — fell to SimSun on Windows and to the system serif on macOS.
      fontFamily: {
        serif: ["'Source Serif 4'", "Georgia", "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", "serif"],
        sans: ["Inter", "system-ui", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
      },
      // Semantic type scale (design spec §3). Arbitrary `text-[*px]` values are
      // banned in components by ESLint; use these six rungs instead.
      // The two smallest rungs were 11px and 12.5px, below the size at which a
      // Chinese glyph's strokes stay separable on a 1x display (2026-09-16
      // walk, V2). Raised to 12px and 13px; line heights go up with them,
      // because CJK needs more leading than Latin at the same size.
      fontSize: {
        // A count badge on a 16 px icon: digits stay legible at 11 px where a
        // Chinese glyph would not, and the caption rung's 18 px line box could
        // not fit a 16 px pill (2026-09-18, the bell's 「31」 covered the bell).
        badge: ["11px", "1"],
        caption: ["12px", "1.5"], // meta info, timestamps
        "ui-sm": ["13px", "1.5"], // secondary buttons, chips, helper rows
        ui: ["13.5px", "1.55"], // default UI text, list rows
        body: ["15px", "1.65"], // chat / markdown body copy
        title: ["20px", "1.3"], // page titles (serif)
        display: ["26px", "1.25"], // brand-level titles, empty states (serif)
      },
      // Page-level container widths (design spec §4).
      // NOTE: `content` intentionally overrides Tailwind's default
      // `max-w-content` (fit-content), which was unused in this codebase.
      maxWidth: {
        "content-narrow": "672px", // settings / forms
        content: "760px", // conversation flow
        "content-wide": "1024px", // notebooks / run logs
        "content-full": "1080px", // memory / catalog
      },
      borderRadius: {
        card: "14px",
        input: "10px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(40, 39, 35, 0.04), 0 4px 16px rgba(40, 39, 35, 0.05)",
        pop: "0 8px 30px rgba(40, 39, 35, 0.14)",
      },
    },
  },
  plugins: [],
};
