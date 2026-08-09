/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Traducción de errores de la API por `code` estable (decisión D6: el backend
 * NO traduce; añade `code` y el front resuelve contra el namespace `errors`).
 *
 * Patrón de uso en catch:
 *   const tErrors = useTranslations('errors');
 *   setError(apiErrorMessage(err, tErrors));
 */

import { ApiHttpError } from '@/lib/api-client';
import type { TranslatorLike } from './labels';

/**
 * Codes cuyo mensaje de catálogo interpola `{detail}` con el dato que el
 * backend mandaba incrustado en el `message` y ahora manda además como campo
 * propio (`ApiError.detail`).
 *
 * La lista es EXPLÍCITA a propósito: es el contrato entre el body de la API y
 * las DOS traducciones. Añadir un code aquí obliga a que el catálogo `es` y el
 * `en` tengan la key con `{detail}` (lo comprueba `api-error.test.ts`
 * recorriendo esta misma lista) y a que el throw del backend rellene el campo.
 * Sin la lista habría que adivinar en runtime si un mensaje lleva placeholder,
 * y un `t(code)` sobre un mensaje con `{detail}` sin valor pinta la key cruda
 * en pantalla.
 *
 * Se exporta SOLO para que el test la recorra: nadie más debe leerla.
 */
export const CODES_WITH_DETAIL: ReadonlySet<string> = new Set([
  // ── Diagnóstico de un sistema EXTERNO (proveedor de pago, MTA, IdP, IA) ──
  // Es la información con la que un admin resuelve la incidencia sin abrir un
  // ticket. Perderla al traducir el code era el bug grave.
  'ADMIN_STRIPE_KEY_REJECTED',
  'ADMIN_SMTP_TEST_FAILED',
  'AI_CONTENT_PROVIDER_ERROR',
  'AI_GRADER_RESPONSE_PARSE_ERROR',
  'BILLING_STRIPE_API_ERROR',
  'BILLING_WEBHOOK_SIGNATURE_INVALID',
  'BILLING_WEBHOOK_SIGNATURE_REJECTED',
  'MEMBER_REG_EMAIL_SEND_FAILED',
  'PAYCONN_EMAIL_SEND_FAILED',
  'PAYMENT_CONNECTIONS_STRIPE_API_ERROR',
  'PAYMENT_CONNECTIONS_STRIPE_KEY_INVALID',
  'SCORM_PACKAGE_INVALID',
  'SSO_OIDC_IDP_ERROR',
  'SSO_SAML_RESPONSE_INVALID',
  'SUBS_WEBHOOK_SIGNATURE_REJECTED',
  'SUBSCRIPTIONS_STRIPE_API_ERROR',
  'SUBSCRIPTIONS_WEBHOOK_SIGNATURE_INVALID',
  'TENANT_SETTINGS_SMTP_CONFIG_INVALID',
  'TENANT_SETTINGS_SMTP_TEST_FAILED',
  'ZOOM_API_ERROR',
  'ZOOM_HOST_NOT_FOUND',
  // ── Dato del propio producto (identificador, slug, límite) ───────────────
  // Menos crítico, mismo defecto: el inglés se lo tragaba.
  'ACCESS_GROUPS_SLUG_TAKEN',
  'ADMIN_CUSTOM_DOMAIN_EXISTS',
  'ADMIN_CUSTOM_DOMAIN_NOT_FOUND',
  'ADMIN_ROLE_NOT_ASSIGNABLE',
  'ADMIN_SMTP_TEMPLATE_NOT_FOUND',
  'ADMIN_TENANT_SLUG_EXISTS',
  'AI_CONTENT_DRAFT_NOT_FOUND',
  'AI_CONTENT_LESSON_TEXT_EMPTY',
  'AI_GRADER_ATTEMPT_NOT_PENDING',
  'AI_GRADER_RUBRIC_INVALID',
  'AI_GRADER_RUBRIC_NOT_FOUND',
  'AI_GRADER_SUGGESTION_NOT_FOUND',
  'AI_PROVIDERS_PROVIDER_NOT_REGISTERED',
  'AI_TUTOR_CORRECTION_NOT_FOUND',
  'AI_TUTOR_COURSE_ACCESS_DENIED',
  'AI_TUTOR_COURSE_NOT_INDEXED',
  'AI_TUTOR_COURSE_NOT_PUBLISHED',
  'AI_TUTOR_MESSAGE_NOT_FOUND',
  'AUTH_API_KEY_MISSING_SCOPES',
  'BILLING_ORDER_NOT_FOUND',
  'BILLING_PRODUCT_ALREADY_EXISTS',
  'BILLING_PRODUCT_INACTIVE',
  'BILLING_PRODUCT_NOT_FOUND',
  'BILLING_STRIPE_CONFIG_MISSING',
  'COURSE_ALREADY_PUBLISHED',
  'COURSE_SLUG_EXISTS',
  'FUNDAE_ACTION_NOT_FOUND',
  'FUNDAE_ACTION_WITHOUT_COURSE',
  'FUNDAE_BLOCK_NOT_FOUND',
  'FUNDAE_BLOCK_ORDINAL_DUPLICADO',
  'FUNDAE_CODIGO_DUPLICADO',
  'FUNDAE_COMPANY_NIF_DUPLICADO',
  'FUNDAE_COMPANY_NOT_FOUND',
  'FUNDAE_COST_NOT_FOUND',
  'FUNDAE_COURSE_NOT_IN_TENANT',
  'FUNDAE_GROUP_CERRADO',
  'FUNDAE_GROUP_NOT_FOUND',
  'FUNDAE_GROUP_NUMERO_DUPLICADO',
  'FUNDAE_GROUP_PARTICIPANT_NOT_FOUND',
  'FUNDAE_GROUP_SIN_CURSO',
  'FUNDAE_PARTICIPANT_NOT_IN_ACTION',
  'FUNDAE_RLPT_NOTIFICACION_INICIAL_MISSING',
  'FUNDAE_RLPT_NOT_FOUND',
  'FUNDAE_RLPT_SIZE_INVALID',
  'INVITATION_INVALID',
  'MARKETPLACE_ASSET_SURFACE_INVALID',
  'MARKETPLACE_DISPATCHER_ROUTE_NOT_FOUND',
  'MAX_ATTEMPTS_REACHED',
  'MEMBERSHIP_CONFIG_INCOMPLETE',
  'MEMBERSHIP_PLAN_INTERVAL_INVALID',
  'MEMBERSHIP_PLAN_NOT_FOUND',
  'MESSAGING_SPACE_NOT_FOUND',
  'MODERATION_REASON_TOO_LONG',
  'MODERATION_SCOPES_UNKNOWN',
  'PAYCONN_PATTERN_INVALID',
  'PAYMENT_CONNECTIONS_ALREADY_EXISTS',
  'PAYMENT_CONNECTIONS_NOT_FOUND',
  'PAYMENT_CONNECTIONS_PORTAL_UNAVAILABLE',
  'PAYMENT_CONNECTIONS_PROVIDER_NOT_SUPPORTED',
  'PAYMENT_CONNECTIONS_TIER_NAME_CONFLICT',
  'PAYMENT_CONNECTIONS_TIER_NOT_FOUND',
  'REFERRALS_COMMISSION_NOT_FOUND',
  'SPACE_EXISTS',
  'SPACE_NOT_FOUND',
  'SSO_EMAIL_DOMAIN_NOT_ALLOWED',
  'STORAGE_FILE_SIZE_OUT_OF_RANGE',
  'SUBSCRIPTIONS_ALREADY_ACTIVE',
  'SUBSCRIPTIONS_NOT_FOUND',
  'SUBSCRIPTIONS_PRICE_NOT_RECURRING',
  'SUBSCRIPTIONS_STRIPE_CONFIG_MISSING',
  'TAG_NAME_EXISTS',
  'TAG_NOT_FOUND',
  'TEMPLATE_IN_USE',
  'TEMPLATE_NAME_TAKEN',
  'TENANT_MODULES_MODULE_NOT_ACTIVE',
  'TENANT_SETTINGS_PARAM_INVALID',
  'THEMING_CUSTOM_CSS_TOO_LARGE',
  'THEMING_CUSTOM_CSS_UNSAFE',
  'THEMING_FOOTER_HTML_TOO_LARGE',
  'THEMING_INVALID_URL',
  'THEMING_LOGO_TOO_LARGE',
  'ZOOM_COURSE_NOT_IN_TENANT',
]);

/**
 * Si el backend mandó `code` y existe `errors.<code>` en el catálogo →
 * mensaje traducido. Si no → `e.message` (el español del backend como
 * fallback honesto: nunca una key cruda ni un texto inventado en pantalla).
 *
 * CAMINO DEGRADADO ÚNICO: un code de `CODES_WITH_DETAIL` que llega SIN
 * `detail` (API vieja contra un front nuevo, o un throw que se olvidó del
 * campo). Se devuelve `e.message`, que lleva el diagnóstico incrustado en
 * español, en vez de pintar la frase traducida con el hueco vacío: preferimos
 * el idioma equivocado a prometer un diagnóstico y no enseñarlo.
 */
export function apiErrorMessage(e: unknown, t: TranslatorLike): string {
  if (e instanceof ApiHttpError) {
    // Un code con '.' se interpretaría como path de namespace: se ignora.
    if (e.code && !e.code.includes('.') && t.has(e.code)) {
      if (!CODES_WITH_DETAIL.has(e.code)) return t(e.code);
      const detail = typeof e.detail === 'string' ? e.detail.trim() : '';
      if (!detail) return e.message;
      return t(e.code, { detail });
    }
    return e.message;
  }
  // Fallos de red de fetch (API caída, sin conexión) son TypeError con
  // mensajes de motor ("Failed to fetch", "Load failed"), y un proxy que
  // devuelve HTML rompe JSON.parse con SyntaxError. Ninguno debe llegar a
  // pantalla. Los `Error` normales sí conservan su message: hay throws
  // intencionales con copy propio en libs y componentes.
  if (e instanceof TypeError || e instanceof SyntaxError) return t('unknown');
  if (e instanceof Error && e.message) return e.message;
  return t('unknown');
}
