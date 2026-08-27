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
      // Un NBSP dentro de un COMENTARIO suele ser el propio comentario
      // explicando que ahi hay un NBSP — es literalmente el caso de
      // `lib/i18n/format.test.ts`, que documenta el separador que mete `Intl`
      // entre importe y simbolo. En codigo sigue siendo error.
      'no-irregular-whitespace': ['error', { skipComments: true }],
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
  // -- Prisma vive encapsulado en @didacta/database -------------------------
  //
  // `@prisma/client` solo lo declara `packages/database`. Importarlo desde otro
  // sitio funciona en local y en CI porque `.npmrc` tiene `shamefully-hoist=true`
  // y el paquete acaba en el `node_modules` raiz — pero DENTRO DE LA IMAGEN la
  // resolucion no lo alcanza. Nos costo una release: `pnpm -r build`,
  // `pnpm typecheck` y los cinco checks de CI pasaron en verde con `nest build`
  // roto en el contenedor, y lo unico que lo reproducia era `docker build`.
  //
  // Van DOS bloques y no uno a proposito. El primero cae sobre codigo que eslint
  // ya miraba, asi que no arrastra nada. El segundo ENSANCHA la cobertura a
  // `scripts/` y `tests/`, que no entraban en ninguna config, y ese ensanchado
  // tiene efectos colaterales que hay que apagar — pero solo ahi. Meterlo todo
  // en un bloque unico silenciaba `reportUnusedDisableDirectives` en TODO el
  // `src/` del repo, que es un aviso util y que nadie habia pedido apagar.
  {
    files: ['apps/*/src/**/*.{ts,tsx}', 'modules/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    // El dueno del paquete es el unico que puede importarlo.
    ignores: ['packages/database/**'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      // Mismo apagado que el resto de bloques de TS: tsc ya cubre esto con
      // tipos y espree da falsos positivos. Hace falta aqui porque este glob
      // reintroduce `apps/web/src/lib/i18n/**`, que el bloque de la web excluye
      // a proposito — sin esto, `document` en `locale-cookie.ts` pasa a ser
      // `no-undef`. Este bloque solo existe para la regla de abajo.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message:
                'Dependencia fantasma: solo packages/database la declara. Importa el tipo o el cliente de @didacta/database, y si el enum que necesitas no esta reexportado, anadelo en packages/database/src/client.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'apps/*/scripts/**/*.ts',
      'apps/*/tests/**/*.ts',
      'modules/*/tests/**/*.ts',
      'packages/*/tests/**/*.ts',
    ],
    ignores: ['packages/database/**'],
    languageOptions: { parser: tseslint.parser },
    // Registrado SIN activar reglas: los tests que este bloque acaba de meter en
    // el alcance traen `eslint-disable` que apuntan a reglas de este plugin, y
    // sin registrarlo eslint los reporta como "definition not found".
    plugins: { '@typescript-eslint': tseslint.plugin },
    // Y esos mismos `eslint-disable` quedarian como "directiva sin usar". Es
    // ruido del ensanchado, no una senal: se calla AQUI, no en todo el repo.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      // Al entrar por primera vez en el alcance, a estos ficheros les caen
      // encima las reglas base pensadas para `.js` con espree: 133 `no-undef` y
      // 130 `no-unused-vars` de golpe, todos falsos positivos que tsc ya cubre
      // con tipos. Se apagan igual que en el bloque del backend. Ensanchar la
      // cobertura no es excusa para colar un ratchet nuevo de 263 hallazgos.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
      // Un script de post-despliegue y un test e2e existen para contar lo que
      // pasa por pantalla: prohibirles `console.log` es una regla de codigo de
      // produccion aplicada donde no toca.
      'no-console': 'off',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message:
                'Dependencia fantasma: solo packages/database la declara. Importa el tipo o el cliente de @didacta/database, y si el enum que necesitas no esta reexportado, anadelo en packages/database/src/client.ts.',
            },
          ],
        },
      ],
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
    plugins: {
      '@next/next': nextPlugin,
      'jsx-a11y': jsxA11yPlugin,
      'react-hooks': reactHooksPlugin,
    },
    // La web arrastra `eslint-disable` heredados de `next lint` que apuntan a
    // reglas de `@next/next` y `react-hooks`, que aqui siguen sin activarse;
    // con el report encendido cada uno de esos comentarios seria un warning y
    // `--max-warnings=0` no pasaria.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
      // -- Accesibilidad --------------------------------------------------
      //
      // El plugin llevaba tiempo registrado SIN una sola regla activa, asi que
      // no detectaba nada: cualquier regresion de accesibilidad entraba en
      // verde. Se activa el conjunto `recommended` completo.
      ...jsxA11yPlugin.configs.recommended.rules,
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
  // ── Accesibilidad: RATCHET ABIERTO ───────────────────────────────────────
  //
  // `eslint-plugin-jsx-a11y` llevaba tiempo registrado sin una sola regla
  // activa: no detectaba nada, y cualquier regresión de accesibilidad entraba
  // en verde. Al encenderlo aparecieron los incumplimientos que la web ya
  // arrastraba. En lugar de volver a apagarlo (que es cómo se llegó aquí),
  // quedan listados aquí uno a uno.
  //
  // ESTA LISTA SOLO PUEDE ENCOGER. Un fichero nuevo, o una línea nueva en un
  // fichero que no esté aquí, falla el lint. Al arreglar un fichero se borra su
  // entrada; cuando un bloque se queda vacío, se borra el bloque.
  {
    files: ['apps/web/src/components/ui/card.tsx'],
    rules: {
      // <h3> genérico del Card: el contenido lo pone quien lo usa, y el linter
      // no puede verlo desde aquí.
      'jsx-a11y/heading-has-content': 'off',
    },
  },
  {
    files: ['apps/web/src/components/video-embed.tsx'],
    rules: {
      // Falta pista de subtítulos en el <video>. Es deuda real de accesibilidad
      // —y de las que Fundae mira—, no un falso positivo: hace falta poder
      // adjuntar un .vtt por lección antes de poder cerrarlo.
      'jsx-a11y/media-has-caption': 'off',
    },
  },
  {
    files: [
      'apps/web/src/app/(app)/admin/seguridad/page.tsx',
      'apps/web/src/components/restriction-shield.tsx',
    ],
    rules: {
      'jsx-a11y/label-has-associated-control': 'off',
    },
  },
  {
    files: [
      'apps/web/src/components/clase-embed-card.tsx',
      'apps/web/src/components/image-lightbox.tsx',
      'apps/web/src/components/renewal-email-modal.tsx',
      'apps/web/src/components/ui/select.tsx',
    ],
    rules: {
      // Mismo patrón que ya se corrigió en `ui/dialog.tsx` y
      // `create-space-modal.tsx`: un <div onClick> que solo existe para el
      // ratón. Se arreglan igual, sacando el fondo a un <button>.
      'jsx-a11y/click-events-have-key-events': 'off',
      'jsx-a11y/no-static-element-interactions': 'off',
      'jsx-a11y/no-noninteractive-element-interactions': 'off',
    },
  },
  {
    files: [
      'apps/web/src/app/(app)/admin/fundae/page.tsx',
      'apps/web/src/app/(app)/formador/aula-virtual/page.tsx',
      // El segmento dinamico va con comodin: minimatch leeria '[id]' como
      // una clase de caracteres y el patron no casaria con nada.
      'apps/web/src/app/(app)/formador/cursos/*/course-editor.tsx',
      'apps/web/src/app/(app)/mensajes/page.tsx',
      'apps/web/src/app/(auth)/mfa/verify/mfa-verify-form.tsx',
      'apps/web/src/app/bienvenida/page.tsx',
      'apps/web/src/app/bienvenida/paso-curso.tsx',
      'apps/web/src/app/setup/setup-wizard.tsx',
      'apps/web/src/components/command-palette.tsx',
      'apps/web/src/components/new-course-form.tsx',
      'apps/web/src/components/post-detail-view.tsx',
    ],
    rules: {
      // `autoFocus`. En un buscador que se abre con atajo es legítimo; en un
      // paso de formulario mueve el foco sin avisar a quien usa lector. Caso
      // por caso, no de golpe.
      'jsx-a11y/no-autofocus': 'off',
    },
  },
];
