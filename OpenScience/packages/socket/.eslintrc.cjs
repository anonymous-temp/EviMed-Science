// This package declared a lint script and shipped no config, so `pnpm lint`
// exited 2 — a broken script reads as coverage in a `package.json` and provides
// none.
//
// The environment split is the point. `plugins/` and `src/` load inside the
// kernel's plugin sandbox and reach the outside world only through the context
// the port hands them: there is no `process`, no `Buffer`, no `require`, and a
// test already asserts they import no node builtin. Declaring `env.node` for
// them would let a reference to `process.env` lint clean and then throw in the
// one place it runs. Tests are ordinary Node and say so.
module.exports = {
  root: true,
  env: { es2023: true },
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  extends: ["eslint:recommended"],
  globals: {
    URL: "readonly",
    URLSearchParams: "readonly",
    TextEncoder: "readonly",
    TextDecoder: "readonly",
    setTimeout: "readonly",
    clearTimeout: "readonly",
    setInterval: "readonly",
    clearInterval: "readonly",
    console: "readonly",
    // The capsule plugin calls the control plane's own recall endpoint at a
    // deployment-configured address with the workload token; the evidence
    // plugin sweeps for stale sources on an unref'd timer it disposes through
    // `ctx.effect`. Both are the sandbox's own globals, not an escape from it.
    fetch: "readonly",
    AbortSignal: "readonly",
  },
  rules: {
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    "no-dupe-class-members": "error",
    "no-redeclare": "error",
    "no-shadow": "error",
    "no-return-await": "error",
    "no-constant-binary-expression": "error",
    "no-self-compare": "error",
    "no-unsafe-optional-chaining": ["error", { disallowArithmeticOperators: true }],
    "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    eqeqeq: ["error", "always", { null: "ignore" }],
  },
  overrides: [
    {
      files: ["test/**/*.mjs"],
      env: { node: true },
      rules: { "no-shadow": "off", "no-useless-escape": "off", "no-control-regex": "off" },
    },
  ],
};
