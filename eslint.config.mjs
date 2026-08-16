import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

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
      // Documentación fuera del árbol versionado (ver .gitignore).
      '.fueradegit/**',
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
  // ── TypeScript del backend y de los módulos ──────────────────────────────
  //
  // Sin este bloque, eslint IGNORABA todo el `.ts` que no fuera `apps/web/src`:
  // los bloques de arriba no declaran `files`, así que solo alcanzan a la
  // extensión por defecto (`.js`), y el único bloque con `.ts` era el
  // guardarraíl i18n de la web. O sea: la API entera, los 20 módulos y los
  // paquetes no pasaban por el linter y nadie lo sabía — `pnpm lint` salía
  // verde porque no miraba. Se ve con `npx eslint <fichero>`: respondía
  // «File ignored because no matching configuration was supplied».
  //
  // `no-unused-vars` va con el mismo `^_` que el bloque de arriba, que es la
  // convención que ya usa el repo para lo deliberadamente sin usar (los stubs
  // de las interfaces sandbox están llenos de `_key`, `_opts`…).
  {
    files: ['apps/api/src/**/*.ts', 'modules/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...tseslint.configs.recommended.reduce((acc, c) => ({ ...acc, ...(c.rules ?? {}) }), {}),
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Las cubre tsc con tipos; en `.ts` la versión de espree da falsos positivos.
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-redeclare': 'off',
    },
  },
  // ── Guardarraíl i18n (apps/web) ──────────────────────────────────────────
  // Prohíbe formateo con locale cableado fuera de los helpers de
  // `apps/web/src/lib/i18n/**` (único sitio permitido para toLocale*/Intl.*).
  //
  // RATCHET CERRADO: la lista de `ignores` contenía los ficheros que aún tenían
  // formateo cableado cuando se puso el guardarraíl. Todos migrados; solo quedan
  // las dos exclusiones permanentes (los helpers y wall-time.ts, que usa Intl
  // para CÁLCULO de fechas, no para presentación). No añadir entradas nuevas:
  // el guardarraíl es la razón de existir de este bloque.
  //
  // Necesita el parser de TS: el flat config base usa espree y no parsea TSX.
  // Las reglas de espree que tsc ya cubre se apagan (no-undef con tipos, etc.)
  // y el plugin de Next se registra sin reglas para que los
  // `eslint-disable @next/next/...` existentes en la web resuelvan.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: [
      // Los propios helpers: son el único sitio donde Intl.*/toLocale* es legal.
      'apps/web/src/lib/i18n/**',
      // Intl.DateTimeFormat para CÁLCULO de wall-time en una zona horaria, no
      // para presentación. Exclusión intencionada y permanente.
      'apps/web/src/modules/zoom-live/wall-time.ts',
    ],
    languageOptions: { parser: tseslint.parser },
    // Los plugins se registran SIN activar sus reglas: la web tiene comentarios
    // `eslint-disable` que los referencian (heredados de `next lint`) y sin el
    // plugin registrado ESLint los reporta como "definition not found".
    plugins: {
      '@next/next': nextPlugin,
      'jsx-a11y': jsxA11yPlugin,
      'react-hooks': reactHooksPlugin,
    },
    // Idem: con las reglas apagadas esos disable quedarían "unused" (warning
    // que rompe --max-warnings=0). Se desactiva el report solo en este bloque.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/]',
          message:
            'Formateo con locale cableado. Usa formatDate/formatDateTime/formatTime/formatNumber de @/lib/i18n/format.',
        },
        {
          selector: "MemberExpression[object.name='Intl']",
          message:
            'Intl.* directo prohibido fuera de @/lib/i18n. Usa los helpers de formato (o getBrowserTimeZone).',
        },
      ],
    },
  },
];
