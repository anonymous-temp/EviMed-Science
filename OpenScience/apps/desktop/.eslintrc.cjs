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
      // Design-token guardrail (design spec §13): block new arbitrary px
      // font sizes, px radii, and bare shadows in className strings across
      // the app. Exceptions get an inline eslint-disable with a reason.
      files: ["src/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector:
              "JSXAttribute[name.name='className'] Literal[value=/text-\\[\\d+(\\.\\d+)?px\\]/]",
            message:
              "Arbitrary px font sizes are banned in components. Use the semantic type scale: text-caption / text-ui-sm / text-ui / text-body / text-title / text-display (see fontSize in tailwind.config.js).",
          },
          {
            selector:
              "JSXAttribute[name.name='className'] TemplateElement[value.raw=/text-\\[\\d+(\\.\\d+)?px\\]/]",
            message:
              "Arbitrary px font sizes are banned in components. Use the semantic type scale: text-caption / text-ui-sm / text-ui / text-body / text-title / text-display (see fontSize in tailwind.config.js).",
          },
          {
            selector:
              "JSXAttribute[name.name='className'] Literal[value=/rounded-\\[\\d+px\\]/]",
            message:
              "Arbitrary px radii are banned in components. Use rounded-input (10px) or rounded-card (14px) (see borderRadius in tailwind.config.js).",
          },
          {
            selector:
              "JSXAttribute[name.name='className'] TemplateElement[value.raw=/rounded-\\[\\d+px\\]/]",
            message:
              "Arbitrary px radii are banned in components. Use rounded-input (10px) or rounded-card (14px) (see borderRadius in tailwind.config.js).",
          },
          {
            selector:
              "JSXAttribute[name.name='className'] Literal[value=/\\bshadow-(sm|md|lg)\\b/]",
            message:
              "Bare shadow-sm/md/lg are banned in components. Use shadow-card for static cards or shadow-pop for overlays (see boxShadow in tailwind.config.js).",
          },
          {
            selector:
              "JSXAttribute[name.name='className'] TemplateElement[value.raw=/\\bshadow-(sm|md|lg)\\b/]",
            message:
              "Bare shadow-sm/md/lg are banned in components. Use shadow-card for static cards or shadow-pop for overlays (see boxShadow in tailwind.config.js).",
          },
        ],
      },
    },
  ],
};
