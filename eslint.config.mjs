import js from '@eslint/js';

// Globals Node.js — usados por scripts (.mjs/.ts/.cjs) y archivos del runtime
// que tocan process/console/Buffer. Sin estos, eslint marca `no-undef` en
// `apps/api/scripts/run-integration-license.mjs` y similares.
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  global: 'readonly',
  module: 'readonly',
  require: 'readonly',
  exports: 'writable',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  crypto: 'readonly',
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
