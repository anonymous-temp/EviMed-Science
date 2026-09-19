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
        // `border-strong` (and `bg-strong` for a divider's hover): the visible
        // boundary of a control, 3:1. Plain `border-border` is decoration.
        strong: "var(--border-strong)",
        dot: {
          running: "var(--dot-running)",
          done: "var(--dot-done)",
          review: "var(--dot-review)",
          failed: "var(--dot-failed)",
          canceled: "var(--dot-canceled)",
        },
      },

      // Two durations: a state change (press, toggle, chevron) and a container
      // (menu, drawer, panel). `prefers-reduced-motion` collapses both to an
      // instant in src/index.css.
      transitionDuration: {
        fast: "120ms",
        base: "200ms",
      },
      transitionTimingFunction: {
        standard: "cubic-bezier(0.2, 0, 0, 1)",
      },
      // One stack for the shell and the frame (contract C10; appendix D §8.1).
      // Latin faces first, so numbers, DOIs and identifiers keep the metrics
      // the scale was measured against; then every Chinese face a reader's
      // OS might carry — HarmonyOS Sans and MiSans cover Huawei and Xiaomi
      // devices, and naming Microsoft YaHei keeps Windows off bitmap SimSun.
      fontFamily: {
        sans: ["Inter", "SF Pro Text", "system-ui", "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "sans-serif"],
        // Titles only; never Chinese body text. SimSun is gone from the end of
        // it: naming it chose the bitmap face on Windows on purpose.
        serif: ["'Source Serif 4'", "Georgia", "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "serif"],
        // DOIs, PMIDs, run ids — checked character by character. JetBrains
        // Mono has no Chinese glyphs, so the Chinese sans faces follow it
        // rather than whatever the OS picks at a different width.
        mono: ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "Noto Sans Mono CJK SC", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "monospace"],
      },
      // The type scale (appendix D §8.3, the owner's plan §6.2). Five rungs
      // plus two single-purpose ones. The 13 px `ui-sm` and 13.5 px `ui` were
      // one rung pretending to be two — half a pixel apart, rounding
      // differently per display — and are one 14/22 rung now, where Ant
      // Design and TDesign independently land. Arbitrary `text-[*px]` values
      // are banned by ESLint.
      fontSize: {
        // A count on a 16 px pill: digits stay legible at 11 px where a
        // Chinese glyph would not (2026-09-18, the bell's 「31」).
        badge: ["11px", "1"],
        caption: ["12px", "1.5"], // timestamps, metadata, counts
        ui: ["14px", "22px"], // default interface text, list rows, controls
        // Retired: merged into `ui`. Kept as an alias only so a class nobody
        // has migrated renders at the ui rung instead of inheriting nothing;
        // ESLint rejects new uses.
        "ui-sm": ["14px", "22px"],
        body: ["16px", "1.75"], // report prose and conversation body
        title: ["20px", "1.35"], // every page H1 (serif)
        display: ["26px", "1.25"], // the login page and empty states only (serif)
        // The sidebar's EviMed lockup: between body and title on purpose.
        wordmark: ["17px", "1"],
      },
      // Four containers (appendix D §8.5). `content` is the reading measure:
      // 680 px holds ~42 Chinese characters per line at 16 px — the old 760 px
      // at 15 px was 50, past the 35–45 a Chinese reader tracks comfortably.
      // NOTE: `content` intentionally overrides Tailwind's `max-w-content`.
      maxWidth: {
        "content-narrow": "640px", // settings, forms
        content: "680px", // conversation, report prose, the inbox
        "content-wide": "1000px", // run ledger
        "content-full": "1120px", // catalogues, the evidence matrix
      },
      // Four radii, nothing else: 4 (`rounded`, Tailwind's own), controls 8,
      // cards 12, panels and dialogs 16; `rounded-full` for chips. 14 px
      // cards read as consumer software; 12 reads as an instrument.
      borderRadius: {
        input: "8px",
        card: "12px",
        panel: "16px",
      },
      // Structure is hairlines, not shadows. A static card has none (a 1 px
      // `border-border` is its whole edge); only what floats casts one:
      // `pop` for menus and popovers, `modal` for dialogs and drawers.
      boxShadow: {
        pop: "0 4px 16px rgba(20, 24, 26, 0.10), 0 1px 3px rgba(20, 24, 26, 0.06)",
        modal: "0 16px 48px rgba(20, 24, 26, 0.18), 0 2px 8px rgba(20, 24, 26, 0.08)",
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
