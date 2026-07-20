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
      },
      fontFamily: {
        serif: ["'Source Serif 4'", "Georgia", "serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
      },
      // Semantic type scale (design spec §3). Arbitrary `text-[*px]` values are
      // banned in components by ESLint; use these six rungs instead.
      fontSize: {
        caption: ["11px", "1.4"], // badges, meta info, timestamps
        "ui-sm": ["12.5px", "1.45"], // secondary buttons, chips, helper rows
        ui: ["13.5px", "1.5"], // default UI text, list rows
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
