// The domain package lints on its own ESLint, one major ahead of the apps, for
// a concrete reason: `clinical-safety-rules.json` is loaded with an import
// attribute (`with { type: "json" }`) so the gate never reaches for `node:fs`,
// and ESLint 8's parser reads that as a syntax error. Pinning this package to a
// parser that understands it is better than leaving the two largest files in it
// unlinted, and the config is flat and local, so it does not disturb the apps.
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
            "@evimed/domain must load in a browser and in a plugin sandbox. Take content as an argument, not a path.",
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
