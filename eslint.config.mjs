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
  // ── Guardarraíl i18n (apps/web) ──────────────────────────────────────────
  // Prohíbe formateo con locale cableado fuera de los helpers de
  // `apps/web/src/lib/i18n/**` (único sitio permitido para toLocale*/Intl.*).
  //
  // RATCHET: los ficheros de `ignores` son los que YA tenían formateo cableado
  // antes del guardarraíl; cada unidad de la migración i18n limpia los suyos y
  // la lista se borra en el commit de integración (quedará solo lib/i18n y
  // wall-time.ts, que usa Intl para CÁLCULO de fechas, no presentación).
  //
  // Necesita el parser de TS: el flat config base usa espree y no parsea TSX.
  // Las reglas de espree que tsc ya cubre se apagan (no-undef con tipos, etc.)
  // y el plugin de Next se registra sin reglas para que los
  // `eslint-disable @next/next/...` existentes en la web resuelvan.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: [
      'apps/web/src/lib/i18n/**',
      'apps/web/src/app/(app)/admin/api-keys/page.tsx',
      'apps/web/src/app/(app)/admin/auditoria/page.tsx',
      'apps/web/src/app/(app)/admin/avisos/page.tsx',
      'apps/web/src/app/(app)/admin/billing/products/page.tsx',
      'apps/web/src/app/(app)/admin/comunidad/publicaciones-api/page.tsx',
      'apps/web/src/app/(app)/admin/configuracion/page.tsx',
      'apps/web/src/app/(app)/admin/dominios/page.tsx',
      'apps/web/src/app/(app)/admin/encuestas/page.tsx',
      'apps/web/src/app/(app)/admin/fundae/empresas/\\[id\\]/page.tsx',
      'apps/web/src/app/(app)/admin/fundae/grupos/page.tsx',
      'apps/web/src/app/(app)/admin/gamificacion/page.tsx',
      'apps/web/src/app/(app)/admin/integraciones/payment-connections/page.tsx',
      'apps/web/src/app/(app)/admin/integraciones/payment-connections/subscriptions-dashboard.tsx',
      'apps/web/src/app/(app)/admin/invitaciones/page.tsx',
      'apps/web/src/app/(app)/admin/licencia/page.tsx',
      'apps/web/src/app/(app)/admin/marketplace/page.tsx',
      'apps/web/src/app/(app)/admin/modules/\\[name\\]/page.tsx',
      'apps/web/src/app/(app)/admin/referidos/page.tsx',
      'apps/web/src/app/(app)/admin/scim/page.tsx',
      'apps/web/src/app/(app)/admin/seguridad/page.tsx',
      'apps/web/src/app/(app)/admin/solicitudes-miembros/page.tsx',
      'apps/web/src/app/(app)/admin/tenants/\\[id\\]/page.tsx',
      'apps/web/src/app/(app)/admin/usuarios/page.tsx',
      'apps/web/src/app/(app)/admin/webhooks/page.tsx',
      'apps/web/src/app/(app)/calendario/eventos-view.tsx',
      'apps/web/src/app/(app)/calendario/page.tsx',
      'apps/web/src/app/(app)/clase/\\[id\\]/page.tsx',
      'apps/web/src/app/(app)/comunidad/menciones/page.tsx',
      'apps/web/src/app/(app)/cuenta/page.tsx',
      'apps/web/src/app/(app)/cursos/\\[slug\\]/page.tsx',
      'apps/web/src/app/(app)/formador/aula-virtual/page.tsx',
      'apps/web/src/app/(app)/formador/correcciones/\\[id\\]/page.tsx',
      'apps/web/src/app/(app)/formador/correcciones/page.tsx',
      'apps/web/src/app/(app)/formador/cursos/\\[id\\]/alumnos/\\[enrollmentId\\]/page.tsx',
      'apps/web/src/app/(app)/formador/cursos/\\[id\\]/alumnos/page.tsx',
      'apps/web/src/app/(app)/formador/cursos/\\[id\\]/invitations-panel.tsx',
      'apps/web/src/app/(app)/formador/cursos/\\[id\\]/lesson-content-editor.tsx',
      'apps/web/src/app/(app)/formador/cursos/page.tsx',
      'apps/web/src/app/(app)/leaderboard/page.tsx',
      'apps/web/src/app/(app)/mis-certificados/page.tsx',
      'apps/web/src/app/(app)/notificaciones/page.tsx',
      'apps/web/src/app/(app)/referidos/page.tsx',
      'apps/web/src/app/(app)/retos/page.tsx',
      'apps/web/src/app/(public)/verificar/\\[id\\]/page.tsx',
      'apps/web/src/app/(venta)/unete/unete-view.tsx',
      'apps/web/src/components/account-security-tab.tsx',
      'apps/web/src/components/admin/business-metrics-panel.tsx',
      'apps/web/src/components/admin/smtp-settings-card.tsx',
      'apps/web/src/components/admin/stripe-settings-card.tsx',
      'apps/web/src/components/admin/zoom-webhook-events-tab.tsx',
      'apps/web/src/components/clase-embed-card.tsx',
      'apps/web/src/components/community-thread-card.tsx',
      'apps/web/src/components/community-upcoming-card.tsx',
      'apps/web/src/components/lesson-comments.tsx',
      'apps/web/src/components/pending-comments-queue.tsx',
      'apps/web/src/components/post-detail-view.tsx',
      'apps/web/src/components/quiz-player.tsx',
      'apps/web/src/components/restriction-shield.tsx',
      'apps/web/src/components/subscription-tab.tsx',
      'apps/web/src/components/user-dossier.tsx',
      'apps/web/src/lib/dossier.ts',
      'apps/web/src/lib/membership.ts',
      'apps/web/src/lib/payment-connections.ts',
      'apps/web/src/lib/referrals.ts',
      'apps/web/src/lib/restrictions.ts',
      'apps/web/src/modules/ai-tutor/admin-correcciones.tsx',
      'apps/web/src/modules/ai-tutor/admin-informe.tsx',
      'apps/web/src/modules/ai-tutor/admin-revision.tsx',
      'apps/web/src/modules/billing/client.ts',
      'apps/web/src/modules/fundae/companies-client.ts',
      'apps/web/src/modules/messaging/shared.ts',
      'apps/web/src/modules/subscriptions/client.ts',
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
