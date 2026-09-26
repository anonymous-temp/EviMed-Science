/** One banned class pattern, checked in every string literal and template. */
const banned = (pattern, message) => [
  { selector: `Literal[value=${pattern}]`, message },
  { selector: `TemplateElement[value.raw=${pattern}]`, message },
];

const tokenRules = [
  ...banned(
    "/text-\\[\\d+(\\.\\d+)?px\\]/",
    "Arbitrary px font sizes are banned in components. Use the semantic type scale: text-badge / text-meta / text-caption (12) / text-compact (13) / text-ui (14) / text-body / text-wordmark (16) / text-section (18) / text-heading (20) / text-title / text-doc-title / text-display (24) / text-metric (32) / text-metric-lg / text-hero (40) — nine sizes, no more, and 32/40 only on a data page (see DESIGN.md and @evimed/design-tokens).",
  ),
  ...banned(
    "/(^|[\\s:])text-(xs|sm|base|lg|xl|[2-9]xl)($|\\s)/",
    "Tailwind's default text sizes bypass the type scale. Use text-meta / text-caption (12) / text-compact (13) / text-ui (14) / text-body (16) / text-section (18) / text-heading (20) / text-title (24) / text-metric (32) / text-metric-lg (40) (see @evimed/design-tokens).",
  ),
  ...banned(
    "/rounded-\\[\\d+px\\]/",
    "Arbitrary px radii are banned in components. Use rounded (8px: controls and rows), rounded-tag (6px: tags), rounded-card (12px: cards and popovers), rounded-panel (16px: dialogs, drawers and panels), rounded-composer (24px) or rounded-full (pills) (see @evimed/design-tokens).",
  ),
  ...banned(
    "/\\bshadow-(sm|md|lg)\\b/",
    "Bare shadow-sm/md/lg are banned in components. Structure is hairlines first: shadow-e1 for a card that must lift, shadow-e2 for the composer, menus and popovers, shadow-e3 for dialogs and drawers (see @evimed/design-tokens).",
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
    "/(^|[\\s:])(bg|text|border|ring|outline|divide|placeholder|decoration|fill|stroke|from|to|via|shadow|caret)-(bg|surface|surface-1|surface-2|scrim|border|border-hairline|border-faint|border-control|faint|strong|text|text-2|text-3|muted|accent|accent-fg|accent-soft|accent-strong|accent-pressed|link|warn|warn-soft|warn-strong|ok|ok-soft|error|error-fg|danger|danger-soft|danger-strong|info|info-soft|verify-ok|verify-pending|highlight|focus|unread|unread-fg|text-graphic|border-light|member-from|member-to|chart-own|chart-grid|chart-axis|chart-band|chart-target|dot-[a-z]+)\\x2F\\d+/",
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

// The serif is back and confined (fusion plan §5.2): the wordmark, the home
// headline, and the title of a document — three brand moments and no fourth.
// An evidence platform borrows its authority from the journals and every one of
// them is set in a serif; a serif on a button reads as an old intranet. So the
// ban stays exactly where a button lives: the primitives, the layout chrome and
// the card set never use it, and the rungs that may (`text-wordmark`,
// `text-hero`, `text-doc-title`) carry the family themselves.
const serifRules = banned(
  "/(^|[\\s:])font-serif($|\\s)/",
  "The serif is for three brand moments only — the wordmark, the home headline and a document title — and a primitive is none of them. Use text-wordmark / text-hero / text-doc-title, which carry the family themselves (see @evimed/design-tokens).",
);

// One component set (2026-09-23 plan §7, gate 1). A bordered pill and a
// bordered button were re-made on almost every page — about seventeen tag
// recipes and 85 hand-written button class lists (inventory §2.1, §2.2) — and
// each new feature added another. Outside `components/ui/` they are errors:
// a chip is `FilterChip` / `FilterChips`, a label is `Tag`, a button is
// `Button` / `IconButton`.
const componentRules = [
  ...banned(
    "/(?=.*(^|\\s)rounded-full(\\s|$))(?=.*(^|\\s)border(\\s|$))/",
    "A bordered pill is a hand-made chip or tag. Use FilterChip / FilterChips (clickable) or Tag (metadata) from components/ui.",
  ),
  {
    selector: "JSXOpeningElement[name.name='button'] JSXAttribute[name.name='className'] Literal[value=/(^|\\s)border(\\s|$)/]",
    message: "A bordered <button> is a hand-made outline button, and there are no outline buttons. Use Button (primary / secondary / text) or IconButton from components/ui.",
  },
  {
    selector: "JSXOpeningElement[name.name='button'] JSXAttribute[name.name='className'] TemplateElement[value.raw=/(^|\\s)border(\\s|$)/]",
    message: "A bordered <button> is a hand-made outline button, and there are no outline buttons. Use Button (primary / secondary / text) or IconButton from components/ui.",
  },
];

// Two icon sizes and one stroke (2026-09-23 plan §4): 16 inline, 20 for a
// chrome glyph; the stroke is set once in index.css (`svg.lucide`). Ten sizes
// and three strokes were in use, 43 of 239 icons on the scale.
const iconRules = [
  {
    selector: "JSXAttribute[name.name='size'] > JSXExpressionContainer > Literal[raw=/^(?!(16|20)$)\\d+$/]",
    message: "Icons are 16 (inline with text) or 20 (a chrome glyph) — ICON_SIZES in @evimed/design-tokens.",
  },
  {
    selector: "JSXOpeningElement[name.name=/^[A-Z]/] > JSXAttribute[name.name='strokeWidth']",
    message: "The icon stroke is set once, in index.css (svg.lucide, ICON_STROKE). Do not pass strokeWidth to an icon.",
  },
];

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
        "no-restricted-syntax": ["error", ...tokenRules, ...retiredTypeRules, ...componentRules, ...iconRules, ...errorTextRules],
      },
    },
    {
      // The design-system primitives: the type scale, the radii and the sans
      // stack are theirs to hold, so they take the serif ban too — a brand
      // moment is a page's, never a primitive's.
      files: [
        "src/components/ui/**/*.{ts,tsx}",
        "src/components/layout/**/*.{ts,tsx}",
        "src/components/cards/**/*.{ts,tsx}",
      ],
      rules: {
        "no-restricted-syntax": ["error", ...tokenRules, ...retiredTypeRules, ...serifRules, ...iconRules, ...errorTextRules],
      },
    },
    {
      // Surfaces whose colors are content, not chrome: the canvas / WebGL
      // viewers hand hex values to a renderer rather than to CSS. (The report
      // viewer used to be here with its own palette; it reads the tokens now.)
      // The raw-error rule still applies to them.
      files: [
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
