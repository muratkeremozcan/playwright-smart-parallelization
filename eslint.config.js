'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', '_bmad/', '_bmad-output/', '.claude/', '.agents/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    // Playwright reads the fixtures a test or hook uses from the destructured first argument, so
    // `async ({}, info) => {}` is how a test that uses none of them takes its info.
    files: ['fixtures/consumer/lifecycle-tests/**/*.js'],
    rules: { 'no-empty-pattern': 'off' },
  },
];
