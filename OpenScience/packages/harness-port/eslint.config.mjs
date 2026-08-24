// Flat config on ESLint 9, for the same reason `packages/domain` is: this
// package loads `seam-manifest.json` with an import attribute
// (`with { type: 'json' }`) so the manifest is read without reaching for
// `node:fs`, and ESLint 8's parser reads that as a syntax error. The choice is
// between a parser that understands the file and leaving the package's two
// entry points unlinted.
//
// Until now there was a third option in effect: a `lint` script with no config
// at all, which exited 2 every time and read as coverage in `package.json`.
import js from "@eslint/js";

export default [
  { ignores: ["node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        AbortSignal: "readonly",
        console: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-dupe-class-members": "error",
      "no-redeclare": "error",
      "no-shadow": "error",
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "no-unsafe-optional-chaining": ["error", { disallowArithmeticOperators: true }],
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    files: ["test/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", Buffer: "readonly", global: "readonly", console: "readonly" },
    },
    rules: { "no-shadow": "off", "no-useless-escape": "off", "no-control-regex": "off" },
  },
];
