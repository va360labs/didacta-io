/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Guarda de paridad es ↔ en de TODOS los namespaces del catálogo.
 *
 * Antes de este test solo `nav.json` tenía guarda (`lib/i18n/nav-catalog.test.ts`):
 * renombrar una key en `es/` y olvidarla en `en/` pasaba la CI sin que nadie se
 * enterase, y el síntoma en producción es una key cruda —o el idioma
 * equivocado— en una pantalla que nadie mira en inglés.
 *
 * Los ficheros se leen del DISCO, no del `index.ts`: así un namespace nuevo
 * entra en la guarda el día que se crea el JSON, sin acordarse de registrarlo
 * en ningún sitio.
 *
 * ── Las dos reglas ────────────────────────────────────────────────────────────
 *
 *  1. Una key en ES sin gemela en EN es SIEMPRE un fallo. No hay excepciones y
 *     no hay lista: el catálogo español es el canónico y todo lo que dice se
 *     tiene que poder decir en inglés.
 *
 *  2. Una key en EN sin gemela en ES es un fallo SALVO que esté declarada abajo,
 *     en `EN_ONLY_BY_DESIGN`, y solo en los namespaces `errorsApi*`.
 *
 * ── Por qué la asimetría de `errorsApi*` es deliberada ────────────────────────
 *
 * El backend NO traduce (decisión D6): manda un `code` estable y un `message` en
 * español. `apiErrorMessage()` (`lib/i18n/api-error.ts`) traduce por `code` SOLO
 * si la key existe en el catálogo activo; si no existe, cae al `message` crudo
 * del backend. La regla vigente aprovecha ese fallback:
 *
 *   · Mensaje FIJO en el backend  → el ES lleva key (traducción literal) y el EN
 *     también. Paridad normal.
 *   · Mensaje INTERPOLADO en el backend (lleva dentro un diagnóstico real: el
 *     nombre del curso, el error del MTA, la respuesta de Stripe…) → el ES NO
 *     lleva key a propósito, para que `apiErrorMessage` degrade al `message`
 *     crudo y el admin español conserve el detalle. El EN sí lleva una redacción
 *     genérica, porque sin key el anglófono vería el mensaje en español.
 *
 * Son los 174 codes declarados abajo. Van uno a uno y no como un `skip`
 * sobre `errorsApi*`: un code nuevo que aparezca solo en EN por descuido rompe
 * la CI igual que cualquier otra huérfana, y un code que se declare aquí y luego
 * se arregle (o se borre) también, porque la lista se valida contra los
 * catálogos en los dos sentidos.
 *
 * ── Lo que este test NO valida (y hay que arreglar en otra sesión) ────────────
 *
 * La CALIDAD de esa redacción genérica inglesa. Un barrido de la Sesión I cifra
 * en 32 los codes cuya traducción inglesa se traga el dato interpolado que el
 * español sí enseña (2 cerrados en el PR #34 —`ADMIN_STRIPE_KEY_REJECTED` y
 * `ADMIN_SMTP_TEST_FAILED`, que hoy interpolan `{detail}` y tienen test propio
 * en `lib/i18n/api-error.test.ts`—, 30 pendientes, 7 de ellos perdiendo un
 * diagnóstico de un sistema externo). Esos 30 están DENTRO de la lista de abajo:
 * este test los da por conocidos, no por correctos. El arreglo es mover cada uno
 * al patrón `{detail}` de `CODES_WITH_DETAIL` (backend + las dos traducciones) y
 * sacarlo de aquí — momento en el que este test lo exigirá.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MESSAGES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'messages');
const LOCALES = ['es', 'en'] as const;

/** Namespaces con permiso para declarar keys solo-EN (ver cabecera). */
const ASYMMETRY_ALLOWED_PREFIX = 'errorsApi';

/**
 * Codes con key SOLO en EN a propósito: el backend manda un `message` español
 * interpolado y el catálogo ES se calla para que `apiErrorMessage` lo deje
 * pasar entero. Ordenados alfabéticamente por namespace para que el diff de un
 * PR que añada o quite uno sea de una línea.
 */
const EN_ONLY_BY_DESIGN: Readonly<Record<string, readonly string[]>> = {
  errorsApiAdmin: [
    'ADMIN_CUSTOM_DOMAIN_EXISTS',
    'ADMIN_CUSTOM_DOMAIN_NOT_FOUND',
    'ADMIN_ROLE_NOT_ASSIGNABLE',
    'ADMIN_ROLE_NOT_FOUND',
    'ADMIN_SMTP_TEMPLATE_NOT_FOUND',
    'ADMIN_TENANT_HOSTNAME_EXISTS',
    'ADMIN_TENANT_SLUG_EXISTS',
  ],
  errorsApiAuthSso: [
    'AUTH_API_KEY_MISSING_SCOPES',
    'SSO_EMAIL_DOMAIN_NOT_ALLOWED',
    'SSO_OIDC_IDP_ERROR',
    'SSO_SAML_RESPONSE_INVALID',
  ],
  errorsApiModulesA: [
    'AI_PROVIDERS_PROVIDER_NOT_REGISTERED',
    'AI_PROVIDERS_PURPOSE_NOT_SUPPORTED',
    'CORE_MODULE_NOT_DISABLEABLE',
    'COURSE_ALREADY_PUBLISHED',
    'COURSE_NOT_FOUND',
    'COURSE_PUBLISH_VALIDATION_FAILED',
    'COURSE_SLUG_EXISTS',
    'INVITATION_INVALID',
    'LESSON_LOCKED',
    'MEMBER_REG_EMAIL_SEND_FAILED',
    'MODULE_HAS_ACTIVE_DEPENDENTS',
    'MODULE_NOT_FOUND',
    'SCORM_PACKAGE_INVALID',
    'STORAGE_FILE_SIZE_OUT_OF_RANGE',
    'TENANT_MODULES_MODULE_NOT_ACTIVE',
    'TENANT_SETTINGS_PARAM_INVALID',
    'TENANT_SETTINGS_SMTP_CONFIG_INVALID',
    'TENANT_SETTINGS_SMTP_TEST_FAILED',
    'THEMING_CUSTOM_CSS_TOO_LARGE',
    'THEMING_CUSTOM_CSS_UNSAFE',
    'THEMING_FOOTER_HTML_TOO_LARGE',
    'THEMING_INVALID_URL',
    'THEMING_LOGO_TOO_LARGE',
    'THEMING_SIGNIN_COPY_TOO_LONG',
    'THEMING_UNSUPPORTED_FONT',
    'THEMING_UNSUPPORTED_LOGO_TYPE',
    'ZOOM_API_ERROR',
    'ZOOM_ATTENDANCE_NOT_AVAILABLE',
    'ZOOM_COURSE_NOT_IN_TENANT',
    'ZOOM_HOST_NOT_FOUND',
    'ZOOM_LIVE_STAFF_ONLY',
    'ZOOM_SESSION_NOT_FOUND',
  ],
  errorsApiModulesB: [
    'ACCESS_GROUPS_SLUG_TAKEN',
    'AI_CONTENT_DRAFT_NOT_FOUND',
    'AI_CONTENT_DRAFT_NOT_IN_DRAFT',
    'AI_CONTENT_INVALID_JSON',
    'AI_CONTENT_LESSON_TEXT_EMPTY',
    'AI_CONTENT_PROVIDER_ERROR',
    'AI_GRADER_ATTEMPT_NOT_PENDING',
    'AI_GRADER_PROVIDER_ERROR',
    'AI_GRADER_QUESTION_NOT_GRADABLE',
    'AI_GRADER_RESPONSE_PARSE_ERROR',
    'AI_GRADER_RUBRIC_INVALID',
    'AI_GRADER_RUBRIC_NOT_FOUND',
    'AI_GRADER_SUGGESTION_NOT_FOUND',
    'AI_PROVIDER_AUTH',
    'AI_PROVIDER_NOT_CONFIGURED',
    'AI_PROVIDER_RATE_LIMIT',
    'AI_PROVIDER_UNAVAILABLE',
    'AI_PROVIDER_UNSUPPORTED_CAPABILITY',
    'AI_TUTOR_CHAT_PROVIDER_ERROR',
    'AI_TUTOR_CORRECTION_NOT_FOUND',
    'AI_TUTOR_COURSE_ACCESS_DENIED',
    'AI_TUTOR_COURSE_NOT_INDEXED',
    'AI_TUTOR_COURSE_NOT_PUBLISHED',
    'AI_TUTOR_DAILY_QUESTION_QUOTA',
    'AI_TUTOR_EMBEDDINGS_PROVIDER_ERROR',
    'AI_TUTOR_MESSAGE_NOT_FOUND',
    'AI_TUTOR_TOKEN_QUOTA_EXCEEDED',
    'AUDIT_EXPORT_SIGNING_UNAVAILABLE',
    'BILLING_ORDER_NOT_FOUND',
    'BILLING_PRODUCT_ALREADY_EXISTS',
    'BILLING_PRODUCT_INACTIVE',
    'BILLING_PRODUCT_NOT_FOUND',
    'BILLING_STRIPE_API_ERROR',
    'BILLING_STRIPE_CONFIG_MISSING',
    'BILLING_WEBHOOK_SIGNATURE_INVALID',
    'BILLING_WEBHOOK_SIGNATURE_REJECTED',
    'COMMUNITY_SPACE_UNKNOWN',
    'FUNDAE_ACTION_NOT_FOUND',
    'FUNDAE_ACTION_WITHOUT_COURSE',
    'FUNDAE_BLOCK_HOURS_EXCEED',
    'FUNDAE_BLOCK_NOT_FOUND',
    'FUNDAE_BLOCK_ORDINAL_DUPLICADO',
    'FUNDAE_CODIGO_DUPLICADO',
    'FUNDAE_COMPANY_NIF_DUPLICADO',
    'FUNDAE_COMPANY_NOT_FOUND',
    'FUNDAE_COMPANY_TIENE_GRUPOS_ACTIVOS',
    'FUNDAE_COST_NOT_FOUND',
    'FUNDAE_COURSE_NOT_IN_TENANT',
    'FUNDAE_CREDITO_INSUFICIENTE',
    'FUNDAE_GROUP_CERRADO',
    'FUNDAE_GROUP_NOT_FOUND',
    'FUNDAE_GROUP_NUMERO_DUPLICADO',
    'FUNDAE_GROUP_PARTICIPANT_DUPLICADO',
    'FUNDAE_GROUP_PARTICIPANT_NOT_FOUND',
    'FUNDAE_GROUP_PARTICIPANT_NOT_IN_COURSE',
    'FUNDAE_GROUP_SIN_CURSO',
    'FUNDAE_GROUP_TRANSICION_INVALIDA',
    'FUNDAE_PARTICIPANT_NOT_IN_ACTION',
    'FUNDAE_RLPT_NOTIFICACION_INICIAL_MISSING',
    'FUNDAE_RLPT_NOT_FOUND',
    'FUNDAE_RLPT_PLAZO_NO_CUMPLIDO',
    'FUNDAE_RLPT_SIZE_INVALID',
    'GAMIFICATION_CHALLENGE_CLOSED',
    'GAMIFICATION_CONFLICT',
    'GAMIFICATION_NOT_FOUND',
    'GAMIFICATION_PERK_UNAVAILABLE',
    'GAMIFICATION_VALIDATION',
    'GRADE_EXCEEDS_QUESTION_POINTS',
    'MAX_ATTEMPTS_REACHED',
    'MEMBERSHIP_CONFIG_INCOMPLETE',
    'MEMBERSHIP_PLAN_INTERVAL_INVALID',
    'MEMBERSHIP_PLAN_NOT_FOUND',
    'MESSAGING_SPACE_NOT_FOUND',
    'PAYCONN_EMAIL_SEND_FAILED',
    'PAYCONN_PATTERN_INVALID',
    'PAYMENT_CONNECTIONS_ALREADY_EXISTS',
    'PAYMENT_CONNECTIONS_NOT_FOUND',
    'PAYMENT_CONNECTIONS_PORTAL_UNAVAILABLE',
    'PAYMENT_CONNECTIONS_PROVIDER_NOT_SUPPORTED',
    'PAYMENT_CONNECTIONS_STRIPE_API_ERROR',
    'PAYMENT_CONNECTIONS_STRIPE_KEY_INVALID',
    'PAYMENT_CONNECTIONS_TIER_NAME_CONFLICT',
    'PAYMENT_CONNECTIONS_TIER_NOT_FOUND',
    'REFERRALS_COMMISSION_NOT_FOUND',
    'REFERRALS_COMMISSION_STATE',
    'REFERRALS_CONFIG_INVALID',
    'REFERRALS_PAYOUT_INVALID',
    'RESOURCES_VALIDATION',
    'SPACE_EXISTS',
    'SPACE_NOT_DELETABLE',
    'SPACE_NOT_FOUND',
    'SUBSCRIPTIONS_ALREADY_ACTIVE',
    'SUBSCRIPTIONS_NOT_FOUND',
    'SUBSCRIPTIONS_PRICE_NOT_RECURRING',
    'SUBSCRIPTIONS_STRIPE_API_ERROR',
    'SUBSCRIPTIONS_STRIPE_CONFIG_MISSING',
    'SUBSCRIPTIONS_WEBHOOK_SIGNATURE_INVALID',
    'SUBS_WEBHOOK_SIGNATURE_REJECTED',
    'SURVEYS_INVALID_ANSWER',
    'TAG_NAME_EXISTS',
    'TAG_NOT_FOUND',
    'TEMPLATE_IN_USE',
    'TEMPLATE_NAME_TAKEN',
  ],
  errorsApiResto: [
    'ALREADY_INSTALLED',
    'CORE_VERSION_INCOMPATIBLE',
    'MANIFEST_CONSISTENCY_INVALID',
    'MANIFEST_INVALID_JSON',
    'MANIFEST_SCHEMA_INVALID',
    'MARKETPLACE_ASSET_SURFACE_INVALID',
    'MARKETPLACE_DISPATCHER_ROUTE_NOT_FOUND',
    'MARKETPLACE_MODULE_HANDLER_ERROR',
    'MARKETPLACE_MODULE_NOT_AVAILABLE',
    'MARKETPLACE_MODULE_NOT_INSTALLED',
    'MARKETPLACE_PACKAGE_DOWNLOAD_FAILED',
    'MARKETPLACE_SURFACE_UI_MISSING',
    'MODERATION_REASON_TOO_LONG',
    'MODERATION_SCOPES_UNKNOWN',
    'MODULE_BOOT_FAILED',
    'MODULE_LINT_FAILED',
    'NAME_RESERVED',
    'NOT_FOUND',
    'PACKAGE_INVALID_ZIP',
    'PACKAGE_MISSING_FILE',
    'PACKAGE_TOO_LARGE',
    'SIGNATURE_INVALID',
    'SIGNATURE_VERIFY_FAILED',
    'STORAGE_FAILED',
    'SURFACE_BUNDLE_MISSING',
    'VENDOR_NOT_TRUSTED',
    'webhook_limit_exceeded',
    'webhook_url_duplicate',
  ],
};

type Json = { [k: string]: Json | string };

/** Hojas del catálogo en notación de punto, con su valor. */
function flatEntries(obj: Json, prefix = '', out: Array<[string, unknown]> = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') flatEntries(v, key, out);
    else out.push([key, v]);
  }
  return out;
}

function namespacesOf(locale: string): string[] {
  return readdirSync(path.join(MESSAGES_DIR, locale))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

function entriesOf(locale: string, ns: string): Array<[string, unknown]> {
  const raw = readFileSync(path.join(MESSAGES_DIR, locale, `${ns}.json`), 'utf8');
  return flatEntries(JSON.parse(raw) as Json);
}

function keysOf(locale: string, ns: string): Set<string> {
  return new Set(entriesOf(locale, ns).map(([k]) => k));
}

const NAMESPACES = namespacesOf('es');

function declaredEnOnly(ns: string): ReadonlySet<string> {
  return new Set(EN_ONLY_BY_DESIGN[ns] ?? []);
}

describe('catálogo i18n · paridad es ↔ en', () => {
  it('los dos idiomas declaran exactamente los mismos namespaces', () => {
    expect(namespacesOf('en')).toEqual(NAMESPACES);
  });

  it('el barrido cubre todos los namespaces del disco (no está vacío)', () => {
    // Si alguien mueve la carpeta, el resto de tests pasaría en verde sobre
    // una lista vacía. Esto lo convierte en fallo.
    expect(NAMESPACES.length).toBeGreaterThan(30);
  });

  it('ninguna key existe solo en ES (regla sin excepciones)', () => {
    const huerfanas: string[] = [];
    for (const ns of NAMESPACES) {
      const en = keysOf('en', ns);
      for (const k of keysOf('es', ns)) if (!en.has(k)) huerfanas.push(`${ns}.${k}`);
    }
    expect(
      huerfanas,
      `keys en es/ sin gemela en en/ (traducir o borrar):\n  ${huerfanas.join('\n  ')}`,
    ).toEqual([]);
  });

  it('toda key solo-EN está declarada como deliberada', () => {
    const inesperadas: string[] = [];
    for (const ns of NAMESPACES) {
      const es = keysOf('es', ns);
      const declared = declaredEnOnly(ns);
      for (const k of keysOf('en', ns)) {
        if (!es.has(k) && !declared.has(k)) inesperadas.push(`${ns}.${k}`);
      }
    }
    expect(
      inesperadas,
      `keys en en/ sin gemela en es/ y SIN declarar en EN_ONLY_BY_DESIGN.\n` +
        `Si es deliberado (mensaje del backend interpolado) decláralo con motivo;\n` +
        `si no, falta la traducción española:\n  ${inesperadas.join('\n  ')}`,
    ).toEqual([]);
  });

  it('toda entrada declarada sigue siendo realmente asimétrica (la lista no se pudre)', () => {
    const obsoletas: string[] = [];
    for (const ns of NAMESPACES) {
      const es = keysOf('es', ns);
      const en = keysOf('en', ns);
      for (const k of declaredEnOnly(ns)) {
        if (!en.has(k)) obsoletas.push(`${ns}.${k} (ya no existe en en/)`);
        else if (es.has(k)) obsoletas.push(`${ns}.${k} (ya tiene gemela en es/)`);
      }
    }
    expect(
      obsoletas,
      `entradas de EN_ONLY_BY_DESIGN que ya no son asimétricas.\n` +
        `La declaración se pudrió: bórralas de la lista:\n  ${obsoletas.join('\n  ')}`,
    ).toEqual([]);
  });

  it('solo los namespaces errorsApi* pueden declarar asimetría', () => {
    const fuera = Object.keys(EN_ONLY_BY_DESIGN).filter(
      (ns) => !ns.startsWith(ASYMMETRY_ALLOWED_PREFIX),
    );
    expect(
      fuera,
      `la excusa del fallback al message crudo solo vale para codes de la API:\n  ${fuera.join('\n  ')}`,
    ).toEqual([]);
  });

  it('todo namespace declarado existe en el disco', () => {
    const fantasma = Object.keys(EN_ONLY_BY_DESIGN).filter((ns) => !NAMESPACES.includes(ns));
    expect(fantasma, `namespaces declarados que ya no existen: ${fantasma.join(', ')}`).toEqual([]);
  });
});

describe('catálogo i18n · integridad', () => {
  it('ningún valor está vacío en ninguno de los dos idiomas', () => {
    const vacias: string[] = [];
    for (const locale of LOCALES) {
      for (const ns of NAMESPACES) {
        for (const [k, v] of entriesOf(locale, ns)) {
          if (typeof v !== 'string' || v.trim() === '') vacias.push(`${locale}/${ns}.${k}`);
        }
      }
    }
    expect(vacias, `valores vacíos o no-string:\n  ${vacias.join('\n  ')}`).toEqual([]);
  });

  it('ningún code de error se define en dos errorsApi* a la vez', () => {
    // Los cinco `errorsApi*.json` se funden bajo el namespace `errors` en
    // `messages/<locale>/index.ts`: un code duplicado hace que gane el último
    // import, en silencio y distinto por idioma.
    const colisiones: string[] = [];
    for (const locale of LOCALES) {
      const origen = new Map<string, string>();
      const errorNs = NAMESPACES.filter((ns) => ns.startsWith(ASYMMETRY_ALLOWED_PREFIX));
      for (const ns of [...errorNs, 'errors']) {
        for (const k of keysOf(locale, ns)) {
          const previo = origen.get(k);
          if (previo) colisiones.push(`${locale}: ${k} en ${previo} y en ${ns}`);
          else origen.set(k, ns);
        }
      }
    }
    expect(colisiones, `codes duplicados:\n  ${colisiones.join('\n  ')}`).toEqual([]);
  });
});
