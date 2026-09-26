// The token table must load in a browser, in a plugin sandbox and in a Vue
// build — so the rules below deny it `node:*` and every Node global. The one
// exception is `generate.mjs`, which is a build script and nothing else's
// dependency: it writes `dist/`, so it is allowed a filesystem and a process.
// Keeping the two in one package but under different rules is what stops a
// `readFileSync` from drifting into the table itself.
import js from "@eslint/js";

export default [
  {
    ignores: ["node_modules/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      // Only the globals that exist in every environment this package claims to
      // load in — a browser bundle, a plugin sandbox and Node. Anything outside
      // this list (`process`, `Buffer`, `require`) should fail here rather than
      // pass quietly and then throw in the one environment nobody tested.
      globals: {
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
      },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // Seventeen modules of pure vocabulary re-exported from one root is
          // exactly where a name collision hides: `export *` resolves a
          // duplicated name to `undefined` rather than to either definition, so
          // the consumer imports something that looks defined, is not, and
          // fails somewhere else entirely. It happened twice during the DSH
          // migration (`CLAIM_TIERS`, `AUTOPILOT_TASK_TYPES`). Named re-exports
          // turn the same mistake into a load-time `SyntaxError: Duplicate
          // export`, which nobody can ship past.
          selector: "ExportAllDeclaration",
          message:
            "Re-export by name. `export *` makes a duplicated name resolve to undefined instead of failing loudly.",
        },
        {
          selector: "ImportDeclaration[source.value=/^node:/]",
          message:
            "@evimed/design-tokens must load in a browser, a plugin sandbox and a Vue build. Take content as an argument, not a path — src/generate.mjs is the one file allowed a filesystem.",
        },
      ],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-redeclare": "error",
      "no-shadow": "error",
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "error",
      "no-unsafe-optional-chaining": ["error", { disallowArithmeticOperators: true }],
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    // The build script: the only file here that writes anything.
    files: ["src/generate.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // The tests are the one place that may name Node globals, and the one place
    // a star import is harmless: they import the root as a namespace precisely
    // to walk it looking for the collisions the rule above prevents.
    files: ["test/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", Buffer: "readonly", URL: "readonly" },
    },
    rules: { "no-restricted-syntax": "off" },
  },
];
