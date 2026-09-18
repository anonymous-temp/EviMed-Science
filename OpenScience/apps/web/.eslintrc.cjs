/** One banned class pattern, checked in every string literal and template. */
const banned = (pattern, message) => [
  { selector: `Literal[value=${pattern}]`, message },
  { selector: `TemplateElement[value.raw=${pattern}]`, message },
];

const tokenRules = [
  ...banned(
    "/text-\\[\\d+(\\.\\d+)?px\\]/",
    "Arbitrary px font sizes are banned in components. Use the semantic type scale: text-caption (12) / text-ui (14) / text-body (16) / text-title (20) / text-display (26), plus text-badge and text-wordmark (see fontSize in tailwind.config.js).",
  ),
  ...banned(
    "/(^|[\\s:])text-(xs|sm|base|lg|xl|[2-9]xl)($|\\s)/",
    "Tailwind's default text sizes bypass the type scale. Use text-caption (12px) / text-ui (14px) / text-body (16px) / text-title (20px) / text-display (26px) (see fontSize in tailwind.config.js).",
  ),
  ...banned(
    "/rounded-\\[\\d+px\\]/",
    "Arbitrary px radii are banned in components. Use rounded (4px), rounded-input (8px), rounded-card (12px) or rounded-panel (16px) (see borderRadius in tailwind.config.js).",
  ),
  ...banned(
    "/\\bshadow-(sm|md|lg)\\b/",
    "Bare shadow-sm/md/lg are banned in components. A static card has no shadow (its 1px border is its edge); use shadow-pop for menus and popovers, shadow-modal for dialogs and drawers (see boxShadow in tailwind.config.js).",
  ),
  // Two tiers and a hairline (appendix D §9.3): the static-card shadow is gone.
  ...banned(
    "/\\bshadow-card\\b/",
    "shadow-card was retired: a static card has no shadow, its 1px border-border is its whole edge. Floating layers use shadow-pop (menus, popovers) or shadow-modal (dialogs, drawers).",
  ),
  // `bg-accent/10`, `text-muted/50`, `border-error/30` … emit no CSS at all:
  // the tokens are `var()` colours, and Tailwind 3 can only apply an opacity
  // modifier to a colour it can decompose. 81 such classes sat in the shell
  // doing nothing (2026-09-18) — a sticky bar with no background, an error box
  // with no border. A tint is a token of its own (`-soft` / `-strong`). The
  // slash is written `\x2F` because an esquery regex literal cannot contain
  // one.
  ...banned(
    "/(^|[\\s:])(bg|text|border|ring|outline|divide|placeholder|decoration|fill|stroke|from|to|via|shadow|caret)-(bg|surface|surface-2|border|faint|strong|text|muted|accent|accent-fg|accent-soft|accent-strong|link|warn|warn-soft|warn-strong|ok|ok-soft|error|error-fg|danger|danger-soft|danger-strong|info-soft|verify-ok|verify-pending|focus|unread|unread-fg|dot-[a-z]+)\\x2F\\d+/",
    "An opacity modifier on a design-token colour generates no CSS (the tokens are var() colours). Use a solid token or its -soft / -strong partner from src/index.css.",
  ),
  ...banned(
    "/-\\[#[0-9a-fA-F]{3,8}\\]/",
    "Arbitrary hex colors are banned in components. Use the color tokens (text-text / text-muted / bg-surface / border-border / text-accent …, defined as CSS variables in src/index.css).",
  ),
];

// The 13 px rung merged into `text-ui` (14 px). Its own list so the two frame
// files the frame stream owns can be exempted until that stream next edits
// them (the class is kept as an alias of `ui`, so they render correctly).
const retiredTypeRules = banned(
  "/(^|[\\s:])text-ui-sm($|\\s)/",
  "text-ui-sm (13px) was merged into text-ui (14px): the 13 and 13.5 px rungs were one rung half a pixel apart. Use text-ui, or text-caption for metadata.",
);

const errorTextRules = [
  {
    // `X instanceof Error ? X.message : String(X)` is how the control
    // plane's English text reached researchers — 56 sites in 33 files
    // on 2026-09-16, two of them visible in one walk. `webErrorMessage`
    // is the one dictionary; a surface that needs different words
    // passes `overrides` to it.
    selector: "ConditionalExpression > BinaryExpression[operator='instanceof'][right.name='Error']",
    message:
      "Do not render a raw Error.message. Use webErrorMessage(error, { fallback }) from @/lib/apiClient (or productErrorMessage) so every refusal reads as one Chinese sentence.",
  },
];

module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:jsx-a11y/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  plugins: ["react-hooks", "react-refresh", "jsx-a11y"],
  ignorePatterns: ["dist", "src-tauri", ".eslintrc.cjs", "vite.config.ts"],
  rules: {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "off",
    // All current autoFocus sites are deliberate focus moves into the primary
    // input of a just-opened surface (login form, command palette, figure
    // annotation draft, sidebar rename). Keep the rule visible as a warning;
    // convergence plan: audit each new occurrence at review, remove the warn
    // override once the codebase stays clean, and let it error again.
    "jsx-a11y/no-autofocus": "warn",
  },
  overrides: [
    {
      // Design-token guardrail (design spec §13): block arbitrary px font
      // sizes, px radii, bare shadows, Tailwind's default text sizes and
      // arbitrary hex colors anywhere a class string can be written.
      //
      // Any string, not only a JSX `className` literal (2026-09-16 review,
      // V2/V3): the selectors used to require a `className` ancestor, so a
      // class map in an object (`{ h1: "text-2xl …" }`), a `cn()` argument or a
      // template assigned first and applied later passed untouched — and 13
      // hex colors, `w-[360px]` and 140 default `text-xs`/`text-sm` sat outside
      // the six-rung scale that way. Exceptions get an inline eslint-disable
      // with a reason, or an entry in the override below.
      files: ["src/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-syntax": ["error", ...tokenRules, ...retiredTypeRules, ...errorTextRules],
      },
    },
    {
      // The frame bridge and the session route belong to the frame stream
      // (2026-09-18 file ownership); they still say text-ui-sm, which renders
      // as text-ui through the retired alias.
      files: ["src/app/routes/RuntimeUiFrame.tsx", "src/app/routes/SessionRoute.tsx"],
      rules: {
        "no-restricted-syntax": ["error", ...tokenRules, ...errorTextRules],
      },
    },
    {
      // Surfaces whose colors are content, not chrome: the Markdown "paper" a
      // report is read on keeps its own print palette and heading sizes, and
      // the canvas / WebGL viewers hand hex values to a renderer rather than to
      // CSS. The raw-error rule still applies to them.
      files: [
        "src/components/markdown-viewer/MarkdownViewer.tsx",
        "src/components/inspector/MeshView.tsx",
        "src/components/inspector/QCodeView.tsx",
        "src/components/inspector/AnomalyMapView.tsx",
        "src/components/inspector/FitsView.tsx",
      ],
      rules: {
        "no-restricted-syntax": ["error", ...errorTextRules],
      },
    },
  ],
};
