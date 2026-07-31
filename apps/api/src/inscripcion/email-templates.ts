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
import type { TelegramMembership } from './inscripcion.dto';
import {
  renderBrandedEmail,
  textToHtmlParagraphs,
  escapeHtml,
  escapeHtmlAttr,
  type EmailBranding,
} from '../common/branded-email';
import {
  applyEmailOverride,
  type RawEmailOverride,
} from '../modules/notifications/email-template-catalog';

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

// ─── OTP: código de acceso de un solo uso ────────────────────────────────────
/** Email con el código OTP grande (no es un link). Validez de 10 minutos. */
export function buildOtpEmail(
  code: string,
  branding: EmailBranding,
  override?: RawEmailOverride | null,
): EmailContent {
  const codeBlockHtml = `<p style="margin:24px 0;text-align:center;">
    <span style="display:inline-block;font-size:34px;font-weight:700;letter-spacing:8px;color:#0D1B2A;background:#f1f5f9;padding:16px 28px;border-radius:12px;">${escapeHtml(
      code,
    )}</span>
  </p>`;

  if (override) {
    const vars = { code, tenantName: branding.tenantName, ttlMinutes: 10 };
    const applied = applyEmailOverride(override, vars, 'Tu código de acceso');
    // El código en grande es estructural: se muestra siempre. En el texto plano
    // solo lo añadimos si el admin no lo incluyó ya con {{code}}.
    const textWithCode = applied.bodyText.includes(code)
      ? applied.bodyText
      : `${applied.bodyText}\n\nCódigo: ${code}`;
    const { html, text } = renderBrandedEmail(branding, {
      title: applied.subject,
      bodyHtml: `${textToHtmlParagraphs(applied.bodyText)}${codeBlockHtml}`,
      bodyText: textWithCode,
    });
    return { subject: applied.subject, text, html };
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
    title: 'Tu código de acceso',
    bodyHtml,
    bodyText,
  });
  return { subject, text, html };
}

// ─── Decisión: email para el APROBADOR (aprobar / rechazar) ───────────────────
export interface DecisionEmailParams {
  name: string;
  email: string;
  telegramId: string;
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
   * adquirió un "acceso lifetime" y por eso NO aparece con suscripción vigente.
   */
  purchases?: MemberPurchaseMatch[];
}

/** Fecha corta legible de un pedido (o vacío si el proveedor no la dio). */
function purchaseDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-ES');
}

/** Describe un pedido en una línea: nº · fecha · estado · importe — productos. */
function describePurchase(p: MemberPurchaseMatch): string {
  const parts = [
    p.orderNumber ? `#${p.orderNumber}` : `#${p.orderId}`,
    purchaseDate(p.createdAt),
    p.status,
    formatMatchAmount(p.total, p.currency).replace(/^ — /, ''),
  ].filter((x) => x && x.length > 0);
  const head = parts.join(' · ');
  return p.products.length ? `${head} — ${p.products.join(', ')}` : head;
}

/** Texto del estado de pertenencia al grupo según el tri-estado. */
function membershipHeading(inGroup: TelegramMembership, tenantName: string): string {
  if (inGroup === 'true') return `Miembro del grupo de ${tenantName}`;
  if (inGroup === 'false') return 'NO está en el grupo - revisar caso';
  return 'Pertenencia NO verificable (error Telegram)';
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

/** Describe una suscripción detectada en una sola línea legible (con estado clasificado). */
function describeMatch(m: MemberSubscriptionMatch): string {
  const plan = m.planName ?? 'suscripción';
  const { label } = classifySubscriptionStatus(m.status);
  return `${providerLabel(m.provider)}: ${plan} — ${label}${formatMatchAmount(m.unitAmount, m.currency)}`;
}

/**
 * Email de decisión para el aprobador: muestra los datos del solicitante, un
 * banner rojo si consta como impago, y dos botones (APROBAR / RECHAZAR). Va
 * dentro de la plantilla de marca del tenant.
 */
export function buildDecisionEmail(
  params: DecisionEmailParams,
  override?: RawEmailOverride | null,
): EmailContent {
  const { name, email, telegramId, inGroup, isDelinquent, approveUrl, rejectUrl, branding } =
    params;
  const tenantName = branding.tenantName;
  const heading = membershipHeading(inGroup, tenantName);
  const matches = params.subscriptionMatches ?? [];
  const failures = params.subscriptionFailures ?? [];
  const failedNote = failures.length
    ? ` (no se pudo consultar ${failures.length} cuenta(s) de pago: ${failures
        .map((f) => f.connectionName)
        .join(', ')})`
    : '';

  const delinquentLineText = isDelinquent ? '\n⚠ CONSTA COMO IMPAGO\n' : '';
  // ¿Alguna de las suscripciones detectadas concede acceso hoy? Si todas son
  // bajas/impagos, lo decimos explícitamente (no es lo mismo que "sin suscripción").
  const hasEntitled = matches.some((m) => classifySubscriptionStatus(m.status).entitled);
  // 4 casos: vigente / detectada-pero-no-vigente / no concluyente (fallos) / nada.
  let subscriptionText: string;
  if (matches.length && hasEntitled) {
    subscriptionText = `\nSuscripción vigente:\n${matches
      .map((m) => `  • ${describeMatch(m)}`)
      .join('\n')}${failedNote ? `\n  ⚠ Resultado parcial${failedNote}.` : ''}\n`;
  } else if (matches.length) {
    subscriptionText = `\n⚠ Suscripción NO vigente (baja o impago):\n${matches
      .map((m) => `  • ${describeMatch(m)}`)
      .join('\n')}${failedNote ? `\n  ⚠ Resultado parcial${failedNote}.` : ''}\n`;
  } else if (failures.length) {
    subscriptionText = `\n⚠ No se pudo verificar la suscripción${failedNote}. Revisar manualmente antes de decidir.\n`;
  } else {
    subscriptionText = '\nSuscripción detectada: ninguna en las cuentas de pago conectadas.\n';
  }
  // Compras puntuales: quien compró un "lifetime" no tiene suscripción viva, así
  // que sin este bloque el aprobador vería "sin suscripción" y rechazaría a un
  // cliente legítimo. Solo se muestra si hay algo que mostrar.
  const purchases = params.purchases ?? [];
  const purchasesText = purchases.length
    ? `\nCompras detectadas (${purchases.length}):\n${purchases
        .map((p) => `  • ${describePurchase(p)}`)
        .join('\n')}\n`
    : '';

  // alpha.83 — subject e intro editables per-tenant; el resto (estado, datos,
  // suscripciones, compras y botones de decisión) es estructural.
  const overrideVars = { name, email, telegramId, tenantName };
  const applied = override
    ? applyEmailOverride(override, overrideVars, `Nueva inscripción pendiente — ${name}`)
    : null;
  const subject = applied?.subject ?? `Nueva inscripción pendiente — ${name}`;
  const introText =
    applied?.bodyText ?? `Hay una nueva inscripción pendiente de tu aprobación en ${tenantName}.`;
  const bodyText = `${introText}

Estado: ${heading}
${delinquentLineText}
  Nombre: ${name}
  Email: ${email}
  Telegram ID: ${telegramId}
${subscriptionText}${purchasesText}
Aprobar: ${approveUrl}
Rechazar: ${rejectUrl}`;

  const delinquentBanner = isDelinquent
    ? `<p style="margin: 16px 0; padding: 12px 16px; background: #fee2e2; border: 1px solid #dc2626; border-radius: 8px; color: #991b1b; font-weight: 700; font-size: 15px;">
    ⚠ CONSTA COMO IMPAGO
  </p>`
    : '';

  const failedNoteHtml = failures.length
    ? `<p style="margin: 6px 0 0; font-size: 13px; color: #b45309;">⚠ Resultado parcial: no se pudo consultar ${failures.length} cuenta(s) de pago (${escapeHtml(
        failures.map((f) => f.connectionName).join(', '),
      )}).</p>`
    : '';
  let subscriptionBlock: string;
  if (matches.length && hasEntitled) {
    subscriptionBlock = `<div style="margin: 16px 0; padding: 12px 16px; background: #ecfdf5; border: 1px solid #10b981; border-radius: 8px;">
    <p style="margin: 0 0 8px; font-weight: 700; color: #065f46; font-size: 15px;">Suscripción vigente</p>
    <ul style="margin: 0; padding-left: 18px; color: #065f46; font-size: 14px;">
      ${matches.map((m) => `<li>${escapeHtml(describeMatch(m))}</li>`).join('\n      ')}
    </ul>
    ${failedNoteHtml}
  </div>`;
  } else if (matches.length) {
    // Hay suscripción(es) pero ninguna vigente: baja o impago. Lo destacamos en ámbar.
    subscriptionBlock = `<div style="margin: 16px 0; padding: 12px 16px; background: #fffbeb; border: 1px solid #f59e0b; border-radius: 8px;">
    <p style="margin: 0 0 8px; font-weight: 700; color: #92400e; font-size: 15px;">⚠ Suscripción no vigente (baja o impago)</p>
    <ul style="margin: 0; padding-left: 18px; color: #92400e; font-size: 14px;">
      ${matches.map((m) => `<li>${escapeHtml(describeMatch(m))}</li>`).join('\n      ')}
    </ul>
    ${failedNoteHtml}
  </div>`;
  } else if (failures.length) {
    subscriptionBlock = `<p style="margin: 16px 0; padding: 12px 16px; background: #fffbeb; border: 1px solid #f59e0b; border-radius: 8px; color: #92400e; font-size: 14px;">
    ⚠ No se pudo verificar la suscripción (${escapeHtml(
      failures.map((f) => f.connectionName).join(', '),
    )}). Revisar manualmente antes de decidir.
  </p>`;
  } else {
    subscriptionBlock = `<p style="margin: 16px 0; padding: 12px 16px; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 8px; color: #475569; font-size: 14px;">
    Sin suscripción detectada en las cuentas de pago conectadas.
  </p>`;
  }

  const purchasesBlock = purchases.length
    ? `<div style="margin: 16px 0; padding: 12px 16px; background: #eff6ff; border: 1px solid #3b82f6; border-radius: 8px;">
    <p style="margin: 0 0 8px; font-weight: 700; color: #1e40af; font-size: 15px;">Compras detectadas (${purchases.length})</p>
    <ul style="margin: 0; padding-left: 18px; color: #1e40af; font-size: 14px;">
      ${purchases.map((p) => `<li>${escapeHtml(describePurchase(p))}</li>`).join('\n      ')}
    </ul>
  </div>`
    : '';

  const introHtml = applied
    ? textToHtmlParagraphs(applied.bodyText)
    : `<p style="margin:0 0 12px;">Hay una nueva inscripción pendiente de tu aprobación en ${escapeHtml(
        tenantName,
      )}.</p>`;
  const bodyHtml = `${introHtml}
  <p style="margin: 16px 0; font-size: 15px; font-weight: 600;">${escapeHtml(heading)}</p>
  ${delinquentBanner}
  <table style="margin: 16px 0; font-size: 15px;">
    <tr><td style="padding: 2px 8px; color: #5b6b7c;">Nombre</td><td style="padding: 2px 8px;"><strong>${escapeHtml(name)}</strong></td></tr>
    <tr><td style="padding: 2px 8px; color: #5b6b7c;">Email</td><td style="padding: 2px 8px;"><strong>${escapeHtml(email)}</strong></td></tr>
    <tr><td style="padding: 2px 8px; color: #5b6b7c;">Telegram ID</td><td style="padding: 2px 8px;"><strong>${escapeHtml(telegramId)}</strong></td></tr>
  </table>
  ${subscriptionBlock}
  ${purchasesBlock}
  <p style="margin: 32px 0;">
    <a href="${escapeHtmlAttr(approveUrl)}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-right: 12px;">
      Aprobar
    </a>
    <a href="${escapeHtmlAttr(rejectUrl)}" style="display: inline-block; background: #dc2626; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
      Rechazar
    </a>
  </p>`;

  const { html, text } = renderBrandedEmail(branding, {
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
  override?: RawEmailOverride | null,
): EmailContent {
  const greeting = name ? `Hola ${name},` : 'Hola,';

  if (override) {
    const vars = { greeting, name, tenantName: branding.tenantName, signinUrl };
    const applied = applyEmailOverride(
      override,
      vars,
      `Tu inscripción en ${branding.tenantName} ha sido aprobada`,
    );
    const { html, text } = renderBrandedEmail(branding, {
      title: applied.subject,
      bodyHtml: textToHtmlParagraphs(applied.bodyText),
      bodyText: applied.bodyText,
      cta: { url: signinUrl, label: 'Entrar' },
    });
    return { subject: applied.subject, text, html };
  }

  const subject = `Tu inscripción en ${branding.tenantName} ha sido aprobada`;
  const bodyText = `${greeting}

¡Buenas noticias! Tu inscripción en ${branding.tenantName} ha sido aprobada y tu cuenta ya está activa.`;
  const bodyHtml = `<p style="margin:0 0 12px;">${escapeHtml(greeting)}</p>
  <p style="margin:0;">¡Buenas noticias! Tu inscripción en ${escapeHtml(
    branding.tenantName,
  )} ha sido aprobada y tu cuenta ya está activa.</p>`;
  const { html, text } = renderBrandedEmail(branding, {
    title: '¡Bienvenido!',
    bodyHtml,
    bodyText,
    cta: { url: signinUrl, label: 'Entrar' },
  });
  return { subject, text, html };
}

// ─── Rechazo: inscripción no aprobada ────────────────────────────────────────
/** Aviso breve de que la inscripción no ha sido aprobada. */
export function buildRejectionEmail(
  name: string,
  branding: EmailBranding,
  override?: RawEmailOverride | null,
): EmailContent {
  const greeting = name ? `Hola ${name},` : 'Hola,';

  if (override) {
    const vars = { greeting, name, tenantName: branding.tenantName };
    const applied = applyEmailOverride(
      override,
      vars,
      `Sobre tu inscripción en ${branding.tenantName}`,
    );
    const { html, text } = renderBrandedEmail(branding, {
      title: applied.subject,
      bodyHtml: textToHtmlParagraphs(applied.bodyText),
      bodyText: applied.bodyText,
    });
    return { subject: applied.subject, text, html };
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
    title: 'Sobre tu inscripción',
    bodyHtml,
    bodyText,
  });
  return { subject, text, html };
}
