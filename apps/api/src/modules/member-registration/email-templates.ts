/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  classifySubscriptionStatus,
  type MemberPurchaseMatch,
  type MemberSubscriptionMatch,
  type MemberSubscriptionLookupFailure,
} from '@didacta/mod-payment-connections';
import type { TelegramMembership } from '@didacta/mod-member-registration';
import {
  renderBrandedEmail,
  textToHtmlParagraphs,
  escapeHtml,
  escapeHtmlAttr,
  type EmailBranding,
} from '../../common/branded-email';
import {
  applyEmailOverride,
  emailDateLocale,
  emailGreeting,
  interpolate,
  resolveFixedEmailCopy,
  resolveTransactionalDefault,
  toHubTemplateLang,
  type FixedEmailCopyKey,
  type RawEmailOverride,
} from '../notifications/email-template-catalog';

// Re-exportado para compatibilidad con call sites/tests que lo importaban de aquí.
export { escapeHtml };

// ============================================================================
// Plantillas de email del flujo de inscripción de miembros (funciones PURAS,
// sin @Injectable). Todas envuelven su contenido en la plantilla de marca del
// TENANT (`renderBrandedEmail`): header con logo, color de marca, firma con el
// nombre del tenant y footer "Powered by Didacta". Todo valor dinámico pasa por
// escapeHtml. El branding lo resuelve el caller con `resolveEmailBranding`.
//
// alpha.83 — cada builder acepta un `override` opcional (subject/body editados
// por el tenant en /admin/emails, SIN interpolar; lo trae el caller con
// `fetchEmailOverride`). Con override, el texto del admin reemplaza el copy
// editable y las partes ESTRUCTURALES (código OTP, bloques de datos, botones)
// se mantienen: un override nunca puede romper el email.
// ============================================================================

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

/** Minutos de validez del código OTP (los mismos que aplica el service). */
const OTP_TTL_MINUTES = 10;
const OTP_TEMPLATE_KEY = 'member_registration.otp_code';
const APPROVAL_REQUEST_TEMPLATE_KEY = 'member_registration.approval_request';
const WELCOME_APPROVED_TEMPLATE_KEY = 'member_registration.welcome_approved';
const REJECTION_TEMPLATE_KEY = 'member_registration.rejection';

// ─── OTP: código de acceso de un solo uso ────────────────────────────────────
/** Email con el código OTP grande (no es un link). Validez de 10 minutos. */
export function buildOtpEmail(
  code: string,
  branding: EmailBranding,
  locale: string,
  override?: RawEmailOverride | null,
): EmailContent {
  const codeBlockHtml = `<p style="margin:24px 0;text-align:center;">
    <span style="display:inline-block;font-size:34px;font-weight:700;letter-spacing:8px;color:#0D1B2A;background:#f1f5f9;padding:16px 28px;border-radius:12px;">${escapeHtml(
      code,
    )}</span>
  </p>`;

  const vars = { code, tenantName: branding.tenantName, ttlMinutes: OTP_TTL_MINUTES };
  // Copy del catálogo para (key, idioma). Nunca `undefined`: la key la registra
  // el módulo en `TRANSACTIONAL_EMAIL_DEFS` y un idioma sin traducir cae al ES.
  const def = resolveTransactionalDefault(OTP_TEMPLATE_KEY, locale)!;
  const defaultSubject = interpolate(def.subject ?? '', vars);
  const codeLabel = resolveFixedEmailCopy('label.otp_code', locale);
  /** El código en grande es estructural; en texto plano solo si no venía ya. */
  const withCode = (body: string): string =>
    body.includes(code) ? body : `${body}\n\n${codeLabel}: ${code}`;

  if (override) {
    const applied = applyEmailOverride(override, vars, defaultSubject);
    const { html, text } = renderBrandedEmail(branding, {
      lang: toHubTemplateLang(locale),
      title: applied.subject,
      bodyHtml: `${textToHtmlParagraphs(applied.bodyText)}${codeBlockHtml}`,
      bodyText: withCode(applied.bodyText),
    });
    return { subject: applied.subject, text, html };
  }

  if (toHubTemplateLang(locale) === 'en') {
    // El inglés se renderiza DESDE el catálogo (misma mecánica que un
    // override) para que composer y catálogo no puedan divergir. El español
    // conserva su maqueta HTML propia más abajo, byte a byte.
    const bodyText = interpolate(def.body, vars);
    const { html, text } = renderBrandedEmail(branding, {
      lang: toHubTemplateLang(locale),
      title: resolveFixedEmailCopy('title.otp_code', locale),
      bodyHtml: `${textToHtmlParagraphs(bodyText)}${codeBlockHtml}`,
      bodyText: withCode(bodyText),
    });
    return { subject: defaultSubject, text, html };
  }

  const subject = 'Tu código de acceso';
  const bodyText = `Tu código de acceso a ${branding.tenantName} es:

  ${code}

Introdúcelo en la pantalla de verificación para continuar. Este código caduca en 10 minutos.

Si no has solicitado este acceso, ignora este mensaje.`;
  const bodyHtml = `<p style="margin:0 0 12px;">Tu código de acceso a ${escapeHtml(
    branding.tenantName,
  )} es:</p>
  ${codeBlockHtml}
  <p style="margin:0 0 8px;font-size:14px;color:#5b6b7c;">Introdúcelo en la pantalla de verificación para continuar. Este código caduca en 10 minutos.</p>
  <p style="margin:0;font-size:14px;color:#5b6b7c;">Si no has solicitado este acceso, ignora este mensaje.</p>`;
  const { html, text } = renderBrandedEmail(branding, {
    lang: toHubTemplateLang(locale),
    title: resolveFixedEmailCopy('title.otp_code', locale),
    bodyHtml,
    bodyText,
  });
  return { subject, text, html };
}

// ─── Decisión: email para el APROBADOR (aprobar / rechazar) ───────────────────
export interface DecisionEmailParams {
  name: string;
  email: string;
  /** null cuando el tenant no exige el verificador de Telegram. */
  telegramId: string | null;
  inGroup: TelegramMembership;
  isDelinquent: boolean;
  approveUrl: string;
  rejectUrl: string;
  branding: EmailBranding;
  /** Suscripciones detectadas del solicitante en las cuentas de pago conectadas. */
  subscriptionMatches?: MemberSubscriptionMatch[];
  /** Conexiones que NO se pudieron consultar (caídas/credencial/timeout): el resultado puede ser incompleto. */
  subscriptionFailures?: MemberSubscriptionLookupFailure[];
  /**
   * Compras PUNTUALES (pedidos) del solicitante. Es lo que justifica a quien
   * adquirió acceso con pago único y por eso NO aparece con suscripción vigente.
   */
  purchases?: MemberPurchaseMatch[];
}

/** Fecha corta legible de un pedido (o vacío si el proveedor no la dio). */
function purchaseDate(iso: string | null, locale: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(emailDateLocale(locale));
}

/** Describe un pedido en una línea: nº · fecha · estado · importe — productos. */
function describePurchase(p: MemberPurchaseMatch, locale: string): string {
  const parts = [
    p.orderNumber ? `#${p.orderNumber}` : `#${p.orderId}`,
    purchaseDate(p.createdAt, locale),
    p.status,
    formatMatchAmount(p.total, p.currency).replace(/^ — /, ''),
  ].filter((x) => x && x.length > 0);
  const head = parts.join(' · ');
  return p.products.length ? `${head} — ${p.products.join(', ')}` : head;
}

/** Texto del estado de pertenencia al grupo según el tri-estado. */
function membershipHeading(
  inGroup: TelegramMembership,
  tenantName: string,
  locale: string,
): string {
  if (inGroup === 'true') {
    return interpolate(resolveFixedEmailCopy('decision.membership_in_group', locale), {
      tenantName,
    });
  }
  if (inGroup === 'false') return resolveFixedEmailCopy('decision.membership_not_in_group', locale);
  return resolveFixedEmailCopy('decision.membership_unknown', locale);
}

/** Nombre legible del proveedor de pago. */
function providerLabel(provider: string): string {
  if (provider === 'stripe') return 'Stripe';
  if (provider === 'paypal') return 'PayPal';
  if (provider === 'woocommerce') return 'WooCommerce';
  return provider;
}

/** Formatea un importe en la unidad menor (céntimos) a string con moneda. */
function formatMatchAmount(unitAmount: number | null, currency: string | null): string {
  if (unitAmount == null) return '';
  const amount = (unitAmount / 100).toFixed(2);
  const cur = (currency ?? '').toUpperCase();
  return cur ? ` — ${amount} ${cur}` : ` — ${amount}`;
}

/**
 * Describe una suscripción detectada en una sola línea legible (con estado
 * clasificado).
 *
 * La etiqueta del estado la sigue redactando `classifySubscriptionStatus` de
 * `modules/payment-connections` —es el espejo del enum del backend, no copy de
 * pantalla— pero ahora se le pide en el idioma del aprobador. Su camino
 * degradado también se conserva: un estado que el módulo no conozca pinta el
 * VALOR CRUDO del proveedor, nunca un identificador interno.
 */
function describeMatch(m: MemberSubscriptionMatch, locale: string): string {
  const plan = m.planName ?? resolveFixedEmailCopy('value.subscription', locale).toLowerCase();
  const { label } = classifySubscriptionStatus(m.status, toHubTemplateLang(locale));
  return `${providerLabel(m.provider)}: ${plan} — ${label}${formatMatchAmount(m.unitAmount, m.currency)}`;
}

/**
 * Email de decisión para el aprobador: muestra los datos del solicitante, un
 * banner rojo si consta como impago, y dos botones (APROBAR / RECHAZAR). Va
 * dentro de la plantilla de marca del tenant.
 *
 * Era la ÚLTIMA plantilla transaccional monolingüe, y lo era por un motivo
 * concreto: su cuerpo es casi todo ESTRUCTURAL —estado de pertenencia al grupo,
 * tabla de datos, bloques de suscripciones y compras, botones de decisión— y
 * una de esas piezas, la etiqueta del estado de la suscripción, la redactaba
 * `classifySubscriptionStatus` en `modules/payment-connections`, fuera de
 * alcance. Traducir solo lo de aquí habría dejado un email mitad inglés mitad
 * español, que es PEOR que uno entero en español.
 *
 * Ahora sale entero en el idioma del aprobador: esa función acepta idioma (con
 * español por defecto, así que sus otros consumidores no cambian) y el resto de
 * rótulos vive en `FIXED_EMAIL_COPY` bajo `decision.*`. El `locale` es
 * OBLIGATORIO por la misma razón que en los otros cuatro composers: con un
 * opcional no se distingue «este email va en español» de «se me olvidó
 * pasarlo».
 */
export function buildDecisionEmail(
  params: DecisionEmailParams,
  locale: string,
  override?: RawEmailOverride | null,
): EmailContent {
  const { name, email, telegramId, inGroup, isDelinquent, approveUrl, rejectUrl, branding } =
    params;
  const tenantName = branding.tenantName;
  const copy = (key: FixedEmailCopyKey, vars?: Record<string, unknown>): string =>
    vars
      ? interpolate(resolveFixedEmailCopy(key, locale), vars)
      : resolveFixedEmailCopy(key, locale);
  // El bloque de Telegram (estado de pertenencia + ID) solo aparece si el
  // tenant exige ese verificador; en registros libre/OTP no hay nada que decir.
  const heading = telegramId !== null ? membershipHeading(inGroup, tenantName, locale) : null;
  const matches = params.subscriptionMatches ?? [];
  const failures = params.subscriptionFailures ?? [];
  const failureNames = failures.map((f) => f.connectionName).join(', ');
  const failedNote = failures.length
    ? copy('decision.partial_suffix', { count: failures.length, names: failureNames })
    : '';

  const delinquentLineText = isDelinquent ? `\n${copy('decision.delinquent')}\n` : '';
  // ¿Alguna de las suscripciones detectadas concede acceso hoy? Si todas son
  // bajas/impagos, lo decimos explícitamente (no es lo mismo que "sin suscripción").
  const hasEntitled = matches.some((m) => classifySubscriptionStatus(m.status).entitled);
  const matchLines = matches.map((m) => `  • ${describeMatch(m, locale)}`).join('\n');
  const partialLine = failedNote ? `\n  ${copy('decision.partial_result')}${failedNote}.` : '';
  // 4 casos: vigente / detectada-pero-no-vigente / no concluyente (fallos) / nada.
  let subscriptionText: string;
  if (matches.length && hasEntitled) {
    subscriptionText = `\n${copy('decision.subscription_active')}:\n${matchLines}${partialLine}\n`;
  } else if (matches.length) {
    subscriptionText = `\n${copy('decision.subscription_inactive')}:\n${matchLines}${partialLine}\n`;
  } else if (failures.length) {
    subscriptionText = `\n${copy('decision.subscription_unverifiable', { suffix: failedNote })}\n`;
  } else {
    subscriptionText = `\n${copy('decision.subscription_none')}\n`;
  }
  // Compras puntuales: quien compró acceso con pago único no tiene suscripción
  // viva, así que sin este bloque el aprobador vería "sin suscripción" y
  // rechazaría a un cliente legítimo. Solo se muestra si hay algo que mostrar.
  const purchases = params.purchases ?? [];
  const purchasesText = purchases.length
    ? `\n${copy('decision.purchases', { count: purchases.length })}:\n${purchases
        .map((p) => `  • ${describePurchase(p, locale)}`)
        .join('\n')}\n`
    : '';

  // alpha.83 — subject e intro editables per-tenant; el resto (estado, datos,
  // suscripciones, compras y botones de decisión) es estructural. El copy
  // editable se renderiza DESDE el catálogo en los dos idiomas (misma mecánica
  // que un override), así que composer y catálogo no pueden divergir.
  const overrideVars = { name, email, telegramId: telegramId ?? '', tenantName };
  const def = resolveTransactionalDefault(APPROVAL_REQUEST_TEMPLATE_KEY, locale)!;
  const defaultSubject = interpolate(def.subject ?? '', overrideVars);
  const applied = override ? applyEmailOverride(override, overrideVars, defaultSubject) : null;
  const subject = applied?.subject ?? defaultSubject;
  const introText = applied?.bodyText ?? interpolate(def.body, overrideVars);
  const bodyText = `${introText}
${heading !== null ? `\n${copy('decision.state')}: ${heading}` : ''}
${delinquentLineText}
  ${copy('label.applicant_name')}: ${name}
  ${copy('label.applicant_email')}: ${email}${telegramId !== null ? `\n  ${copy('label.applicant_telegram')}: ${telegramId}` : ''}
${subscriptionText}${purchasesText}
${copy('cta.decision_approve')}: ${approveUrl}
${copy('cta.decision_reject')}: ${rejectUrl}`;

  const delinquentBanner = isDelinquent
    ? `<p style="margin: 16px 0; padding: 12px 16px; background: #fee2e2; border: 1px solid #dc2626; border-radius: 8px; color: #991b1b; font-weight: 700; font-size: 15px;">
    ${escapeHtml(copy('decision.delinquent'))}
  </p>`
    : '';

  const failedNoteHtml = failures.length
    ? `<p style="margin: 6px 0 0; font-size: 13px; color: #b45309;">${escapeHtml(
        copy('decision.partial_result_html', { count: failures.length, names: failureNames }),
      )}</p>`
    : '';
  const matchItemsHtml = matches
    .map((m) => `<li>${escapeHtml(describeMatch(m, locale))}</li>`)
    .join('\n      ');
  let subscriptionBlock: string;
  if (matches.length && hasEntitled) {
    subscriptionBlock = `<div style="margin: 16px 0; padding: 12px 16px; background: #ecfdf5; border: 1px solid #10b981; border-radius: 8px;">
    <p style="margin: 0 0 8px; font-weight: 700; color: #065f46; font-size: 15px;">${escapeHtml(copy('decision.subscription_active'))}</p>
    <ul style="margin: 0; padding-left: 18px; color: #065f46; font-size: 14px;">
      ${matchItemsHtml}
    </ul>
    ${failedNoteHtml}
  </div>`;
  } else if (matches.length) {
    // Hay suscripción(es) pero ninguna vigente: baja o impago. Lo destacamos en ámbar.
    subscriptionBlock = `<div style="margin: 16px 0; padding: 12px 16px; background: #fffbeb; border: 1px solid #f59e0b; border-radius: 8px;">
    <p style="margin: 0 0 8px; font-weight: 700; color: #92400e; font-size: 15px;">${escapeHtml(copy('decision.subscription_inactive_html'))}</p>
    <ul style="margin: 0; padding-left: 18px; color: #92400e; font-size: 14px;">
      ${matchItemsHtml}
    </ul>
    ${failedNoteHtml}
  </div>`;
  } else if (failures.length) {
    subscriptionBlock = `<p style="margin: 16px 0; padding: 12px 16px; background: #fffbeb; border: 1px solid #f59e0b; border-radius: 8px; color: #92400e; font-size: 14px;">
    ${escapeHtml(copy('decision.subscription_unverifiable_html', { names: failureNames }))}
  </p>`;
  } else {
    subscriptionBlock = `<p style="margin: 16px 0; padding: 12px 16px; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 8px; color: #475569; font-size: 14px;">
    ${escapeHtml(copy('decision.subscription_none_html'))}
  </p>`;
  }

  const purchasesBlock = purchases.length
    ? `<div style="margin: 16px 0; padding: 12px 16px; background: #eff6ff; border: 1px solid #3b82f6; border-radius: 8px;">
    <p style="margin: 0 0 8px; font-weight: 700; color: #1e40af; font-size: 15px;">${escapeHtml(copy('decision.purchases', { count: purchases.length }))}</p>
    <ul style="margin: 0; padding-left: 18px; color: #1e40af; font-size: 14px;">
      ${purchases.map((p) => `<li>${escapeHtml(describePurchase(p, locale))}</li>`).join('\n      ')}
    </ul>
  </div>`
    : '';

  const introHtml = `<p style="margin:0 0 12px;">${escapeHtml(introText)}</p>`;
  const headingHtml =
    heading !== null
      ? `<p style="margin: 16px 0; font-size: 15px; font-weight: 600;">${escapeHtml(heading)}</p>\n  `
      : '';
  const telegramRowHtml =
    telegramId !== null
      ? `\n    <tr><td style="padding: 2px 8px; color: #5b6b7c;">${escapeHtml(copy('label.applicant_telegram'))}</td><td style="padding: 2px 8px;"><strong>${escapeHtml(telegramId)}</strong></td></tr>`
      : '';
  const bodyHtml = `${applied ? textToHtmlParagraphs(applied.bodyText) : introHtml}
  ${headingHtml}${delinquentBanner}
  <table style="margin: 16px 0; font-size: 15px;">
    <tr><td style="padding: 2px 8px; color: #5b6b7c;">${escapeHtml(copy('label.applicant_name'))}</td><td style="padding: 2px 8px;"><strong>${escapeHtml(name)}</strong></td></tr>
    <tr><td style="padding: 2px 8px; color: #5b6b7c;">${escapeHtml(copy('label.applicant_email'))}</td><td style="padding: 2px 8px;"><strong>${escapeHtml(email)}</strong></td></tr>${telegramRowHtml}
  </table>
  ${subscriptionBlock}
  ${purchasesBlock}
  <p style="margin: 32px 0;">
    <a href="${escapeHtmlAttr(approveUrl)}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-right: 12px;">
      ${escapeHtml(copy('cta.decision_approve'))}
    </a>
    <a href="${escapeHtmlAttr(rejectUrl)}" style="display: inline-block; background: #dc2626; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
      ${escapeHtml(copy('cta.decision_reject'))}
    </a>
  </p>`;

  const { html, text } = renderBrandedEmail(branding, {
    lang: toHubTemplateLang(locale),
    title: subject,
    bodyHtml,
    bodyText,
  });
  return { subject, text, html };
}

// ─── Bienvenida: inscripción aprobada ────────────────────────────────────────
/** Email de bienvenida tras la aprobación, con botón 'Entrar' al signin. */
export function buildWelcomeEmail(
  name: string,
  signinUrl: string,
  branding: EmailBranding,
  locale: string,
  override?: RawEmailOverride | null,
): EmailContent {
  const greeting = emailGreeting(name, locale);
  const vars = { greeting, name, tenantName: branding.tenantName, signinUrl };
  const def = resolveTransactionalDefault(WELCOME_APPROVED_TEMPLATE_KEY, locale)!;
  const defaultSubject = interpolate(def.subject ?? '', vars);
  // Estructural: el override del tenant no puede quitar el botón, pero sí
  // recibe su etiqueta en el idioma del destinatario.
  const cta = { url: signinUrl, label: resolveFixedEmailCopy('cta.signin', locale) };

  if (override) {
    const applied = applyEmailOverride(override, vars, defaultSubject);
    const { html, text } = renderBrandedEmail(branding, {
      lang: toHubTemplateLang(locale),
      title: applied.subject,
      bodyHtml: textToHtmlParagraphs(applied.bodyText),
      bodyText: applied.bodyText,
      cta,
    });
    return { subject: applied.subject, text, html };
  }

  if (toHubTemplateLang(locale) === 'en') {
    const bodyText = interpolate(def.body, vars);
    const { html, text } = renderBrandedEmail(branding, {
      lang: toHubTemplateLang(locale),
      title: resolveFixedEmailCopy('title.member_welcome', locale),
      bodyHtml: textToHtmlParagraphs(bodyText),
      bodyText,
      cta,
    });
    return { subject: defaultSubject, text, html };
  }

  const subject = `Tu inscripción en ${branding.tenantName} ha sido aprobada`;
  const bodyText = `${greeting}

¡Buenas noticias! Tu inscripción en ${branding.tenantName} ha sido aprobada y tu cuenta ya está activa.`;
  const bodyHtml = `<p style="margin:0 0 12px;">${escapeHtml(greeting)}</p>
  <p style="margin:0;">¡Buenas noticias! Tu inscripción en ${escapeHtml(
    branding.tenantName,
  )} ha sido aprobada y tu cuenta ya está activa.</p>`;
  const { html, text } = renderBrandedEmail(branding, {
    lang: toHubTemplateLang(locale),
    title: resolveFixedEmailCopy('title.member_welcome', locale),
    bodyHtml,
    bodyText,
    cta,
  });
  return { subject, text, html };
}

// ─── Rechazo: inscripción no aprobada ────────────────────────────────────────
/** Aviso breve de que la inscripción no ha sido aprobada. */
export function buildRejectionEmail(
  name: string,
  branding: EmailBranding,
  locale: string,
  override?: RawEmailOverride | null,
): EmailContent {
  const greeting = emailGreeting(name, locale);
  const vars = { greeting, name, tenantName: branding.tenantName };
  const def = resolveTransactionalDefault(REJECTION_TEMPLATE_KEY, locale)!;
  const defaultSubject = interpolate(def.subject ?? '', vars);

  if (override) {
    const applied = applyEmailOverride(override, vars, defaultSubject);
    const { html, text } = renderBrandedEmail(branding, {
      lang: toHubTemplateLang(locale),
      title: applied.subject,
      bodyHtml: textToHtmlParagraphs(applied.bodyText),
      bodyText: applied.bodyText,
    });
    return { subject: applied.subject, text, html };
  }

  if (toHubTemplateLang(locale) === 'en') {
    const bodyText = interpolate(def.body, vars);
    const { html, text } = renderBrandedEmail(branding, {
      lang: toHubTemplateLang(locale),
      title: resolveFixedEmailCopy('title.member_rejection', locale),
      bodyHtml: textToHtmlParagraphs(bodyText),
      bodyText,
    });
    return { subject: defaultSubject, text, html };
  }

  const subject = `Sobre tu inscripción en ${branding.tenantName}`;
  const bodyText = `${greeting}

Gracias por tu interés en ${branding.tenantName}. Tras revisar tu solicitud, no hemos podido aprobar tu inscripción en este momento.

Si crees que se trata de un error, puedes ponerte en contacto con el equipo.`;
  const bodyHtml = `<p style="margin:0 0 12px;">${escapeHtml(greeting)}</p>
  <p style="margin:0 0 12px;">Gracias por tu interés en ${escapeHtml(
    branding.tenantName,
  )}. Tras revisar tu solicitud, no hemos podido aprobar tu inscripción en este momento.</p>
  <p style="margin:0;font-size:14px;color:#5b6b7c;">Si crees que se trata de un error, puedes ponerte en contacto con el equipo.</p>`;
  const { html, text } = renderBrandedEmail(branding, {
    lang: toHubTemplateLang(locale),
    title: resolveFixedEmailCopy('title.member_rejection', locale),
    bodyHtml,
    bodyText,
  });
  return { subject, text, html };
}
