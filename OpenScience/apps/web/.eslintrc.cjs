/** One banned class pattern, checked in every string literal and template. */
const banned = (pattern, message) => [
  { selector: `Literal[value=${pattern}]`, message },
  { selector: `TemplateElement[value.raw=${pattern}]`, message },
];

const tokenRules = [
  ...banned(
    "/text-\\[\\d+(\\.\\d+)?px\\]/",
    "Arbitrary px font sizes are banned in components. Use the semantic type scale: text-caption / text-ui-sm / text-ui / text-body / text-title / text-display (see fontSize in tailwind.config.js).",
  ),
  ...banned(
    "/(^|[\\s:])text-(xs|sm|base|lg|xl|[2-9]xl)($|\\s)/",
    "Tailwind's default text sizes bypass the six-rung scale. Use text-caption (12px) / text-ui-sm (13px) / text-ui / text-body / text-title / text-display (see fontSize in tailwind.config.js).",
  ),
  ...banned(
    "/rounded-\\[\\d+px\\]/",
    "Arbitrary px radii are banned in components. Use rounded-input (10px) or rounded-card (14px) (see borderRadius in tailwind.config.js).",
  ),
  ...banned(
    "/\\bshadow-(sm|md|lg)\\b/",
    "Bare shadow-sm/md/lg are banned in components. Use shadow-card for static cards or shadow-pop for overlays (see boxShadow in tailwind.config.js).",
  ),
  ...banned(
    "/-\\[#[0-9a-fA-F]{3,8}\\]/",
    "Arbitrary hex colors are banned in components. Use the color tokens (text-text / text-muted / bg-surface / border-border / text-accent …, defined as CSS variables in src/index.css).",
  ),
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
