export default [{
  files: ['**/*.mjs'],
  languageOptions: {
    ecmaVersion: 'latest', sourceType: 'module',
    globals: { process: 'readonly', console: 'readonly', URL: 'readonly', setTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly' },
  },
  rules: {
    'no-undef': 'error',
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    'no-redeclare': 'error', 'no-dupe-class-members': 'error', 'no-constant-binary-expression': 'error',
    'no-unsafe-optional-chaining': 'error', 'prefer-const': 'error', eqeqeq: ['error', 'always', { null: 'ignore' }],
  },
}]
