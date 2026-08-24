// The hosted web boundary had no lint or type coverage at all: every change to
// auth, the sandbox guards, the model gateway and memory landed here unchecked.
// These rules target the mistakes that actually reach production in plain ESM —
// unused bindings, shadowed declarations, forgotten awaits, duplicate keys —
// rather than style.
module.exports = {
  root: true,
  env: { node: true, es2023: true },
  // `latest`, not a year: import attributes (`with { type: "json" }`) are how a
  // JSON module is loaded without reaching for `node:fs`, and pinning the
  // parser to 2023 makes that a syntax error rather than a supported feature.
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  extends: ["eslint:recommended"],
  rules: {
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    // A second definition silently replaces the first. One shipped here: a
    // helper declared twice in a class body had been dead since it was written.
    "no-dupe-class-members": "error",
    "no-redeclare": "error",
    "no-shadow": "error",
    "no-await-in-loop": "off",
    // Both of these fire constantly on correct code here: the
    // `new Promise((resolve) => setTimeout(resolve, ms))` idiom appears
    // throughout, and require-atomic-updates flags ordinary sequential awaits.
    "no-promise-executor-return": "off",
    "require-atomic-updates": "off",
    "no-return-await": "error",
    "no-unmodified-loop-condition": "error",
    "no-constant-binary-expression": "error",
    "no-self-compare": "error",
    "no-template-curly-in-string": "error",
    "no-unsafe-optional-chaining": ["error", { disallowArithmeticOperators: true }],
    // `let x;` assigned once but read by a closure before that point cannot
    // become const; agentRuns and its runtime manager refer to each other.
    "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    eqeqeq: ["error", "always", { null: "ignore" }],
  },
  overrides: [
    {
      files: ["test/**/*.mjs"],
      rules: {
        "no-shadow": "off",
        // Fixtures deliberately carry escapes, ${...} literals and control
        // characters as data — they are the thing under test, not a mistake.
        "no-useless-escape": "off",
        "no-template-curly-in-string": "off",
        "no-control-regex": "off",
        "no-regex-spaces": "off",
        // Loop flags here are flipped by a closure the rule cannot follow.
        "no-unmodified-loop-condition": "off",
      },
    },
  ],
};
