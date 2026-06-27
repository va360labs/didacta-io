import type {
  MemberSubscriptionMatch,
  MemberSubscriptionLookupFailure,
} from '@didacta/mod-payment-connections';
import type { TelegramMembership } from './inscripcion.dto';

// ============================================================================
// Plantillas de email del flujo de inscripción de miembros (funciones PURAS,
// sin @Injectable). Clonan el estilo del email de bienvenida de inscribe.service
// (doctype, font Inter, color #0D1B2A, botón CTA <a> con background, footer
// 'Powered by Didacta.io'). Todo valor dinámico pasa por escapeHtml.
// ============================================================================

/** Escapa los caracteres con significado en HTML para evitar inyección. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

// ─── OTP: código de acceso de un solo uso ────────────────────────────────────
/** Email con el código OTP grande (no es un link). Validez de 10 minutos. */
export function buildOtpEmail(code: string, tenantName = 'Didacta'): EmailContent {
  const subject = 'Tu código de acceso';
  const text = `Hola,

Tu código de acceso a ${tenantName} es:

  ${code}

Introdúcelo en la pantalla de verificación para continuar.

Este código caduca en 10 minutos. Si no has solicitado este acceso, ignora este mensaje.

— Equipo ${tenantName}

—
Powered by Didacta.io`;
  const html = `<!DOCTYPE html>
<html lang="es"><body style="font-family: 'Inter', system-ui, sans-serif; color: #0D1B2A; line-height: 1.6;">
  <p>Hola,</p>
  <p>Tu código de acceso a ${escapeHtml(tenantName)} es:</p>
  <p style="margin: 24px 0; text-align: center;">
    <span style="display: inline-block; font-size: 34px; font-weight: 700; letter-spacing: 8px; color: #0D1B2A; background: #f1f5f9; padding: 16px 28px; border-radius: 12px;">
      ${escapeHtml(code)}
    </span>
  </p>
  <p style="font-size: 14px; color: #5b6b7c;">
    Introdúcelo en la pantalla de verificación para continuar. Este código caduca en 10 minutos.
  </p>
  <p style="font-size: 14px; color: #5b6b7c;">
    Si no has solicitado este acceso, ignora este mensaje.
  </p>
  <p style="margin-top: 32px; font-size: 12px; color: #94a3b8;">— Equipo ${escapeHtml(tenantName)}</p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 12px;" />
  <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">Powered by Didacta.io</p>
</body></html>`;
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
  tenantName?: string;
  /** Suscripciones detectadas del solicitante en las cuentas de pago conectadas. */
  subscriptionMatches?: MemberSubscriptionMatch[];
  /** Conexiones que NO se pudieron consultar (caídas/credencial/timeout): el resultado puede ser incompleto. */
  subscriptionFailures?: MemberSubscriptionLookupFailure[];
}

/** Texto del estado de pertenencia al grupo según el tri-estado. */
function membershipHeading(inGroup: TelegramMembership): string {
  if (inGroup === 'true') return 'Miembro del grupo VA360';
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

/** Describe una suscripción detectada en una sola línea legible. */
function describeMatch(m: MemberSubscriptionMatch): string {
  const plan = m.planName ?? 'suscripción';
  return `${providerLabel(m.provider)}: ${plan} (${m.status})${formatMatchAmount(m.unitAmount, m.currency)}`;
}

/**
 * Email de decisión para el aprobador: muestra los datos del solicitante, un
 * banner rojo si consta como impago, y dos botones (APROBAR / RECHAZAR).
 */
export function buildDecisionEmail(params: DecisionEmailParams): EmailContent {
  const { name, email, telegramId, inGroup, isDelinquent, approveUrl, rejectUrl } = params;
  const tenantName = params.tenantName ?? 'Didacta';
  const heading = membershipHeading(inGroup);
  const matches = params.subscriptionMatches ?? [];
  const failures = params.subscriptionFailures ?? [];
  const failedNote = failures.length
    ? ` (no se pudo consultar ${failures.length} cuenta(s) de pago: ${failures
        .map((f) => f.connectionName)
        .join(', ')})`
    : '';

  const delinquentLineText = isDelinquent ? '\n⚠ CONSTA COMO IMPAGO\n' : '';
  // 3 casos: con matches / sin matches pero con fallos (no concluyente) / sin nada.
  let subscriptionText: string;
  if (matches.length) {
    subscriptionText = `\nSuscripción detectada:\n${matches
      .map((m) => `  • ${describeMatch(m)}`)
      .join('\n')}${failedNote ? `\n  ⚠ Resultado parcial${failedNote}.` : ''}\n`;
  } else if (failures.length) {
    subscriptionText = `\n⚠ No se pudo verificar la suscripción${failedNote}. Revisar manualmente antes de decidir.\n`;
  } else {
    subscriptionText = '\nSuscripción detectada: ninguna en las cuentas de pago conectadas.\n';
  }
  const subject = `Nueva inscripción pendiente — ${name}`;
  const text = `Hola,

Hay una nueva inscripción pendiente de tu aprobación en ${tenantName}.

Estado: ${heading}
${delinquentLineText}
  Nombre: ${name}
  Email: ${email}
  Telegram ID: ${telegramId}
${subscriptionText}
Aprobar: ${approveUrl}
Rechazar: ${rejectUrl}

— ${tenantName}

—
Powered by Didacta.io`;

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
  if (matches.length) {
    subscriptionBlock = `<div style="margin: 16px 0; padding: 12px 16px; background: #ecfdf5; border: 1px solid #10b981; border-radius: 8px;">
    <p style="margin: 0 0 8px; font-weight: 700; color: #065f46; font-size: 15px;">Suscripción detectada</p>
    <ul style="margin: 0; padding-left: 18px; color: #065f46; font-size: 14px;">
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

  const html = `<!DOCTYPE html>
<html lang="es"><body style="font-family: 'Inter', system-ui, sans-serif; color: #0D1B2A; line-height: 1.6;">
  <p>Hola,</p>
  <p>Hay una nueva inscripción pendiente de tu aprobación en ${escapeHtml(tenantName)}.</p>
  <p style="margin: 16px 0; font-size: 15px; font-weight: 600;">${escapeHtml(heading)}</p>
  ${delinquentBanner}
  <table style="margin: 16px 0; font-size: 15px;">
    <tr><td style="padding: 2px 8px; color: #5b6b7c;">Nombre</td><td style="padding: 2px 8px;"><strong>${escapeHtml(name)}</strong></td></tr>
    <tr><td style="padding: 2px 8px; color: #5b6b7c;">Email</td><td style="padding: 2px 8px;"><strong>${escapeHtml(email)}</strong></td></tr>
    <tr><td style="padding: 2px 8px; color: #5b6b7c;">Telegram ID</td><td style="padding: 2px 8px;"><strong>${escapeHtml(telegramId)}</strong></td></tr>
  </table>
  ${subscriptionBlock}
  <p style="margin: 32px 0;">
    <a href="${approveUrl}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-right: 12px;">
      Aprobar
    </a>
    <a href="${rejectUrl}" style="display: inline-block; background: #dc2626; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
      Rechazar
    </a>
  </p>
  <p style="margin-top: 32px; font-size: 12px; color: #94a3b8;">— ${escapeHtml(tenantName)}</p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 12px;" />
  <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">Powered by Didacta.io</p>
</body></html>`;
  return { subject, text, html };
}

// ─── Bienvenida: inscripción aprobada ────────────────────────────────────────
/** Email de bienvenida tras la aprobación, con botón 'Entrar' al signin. */
export function buildWelcomeEmail(
  name: string,
  signinUrl: string,
  tenantName = 'Didacta',
): EmailContent {
  const greeting = name ? `Hola ${name},` : 'Hola,';
  const subject = `Tu inscripción en ${tenantName} ha sido aprobada`;
  const text = `${greeting}

¡Buenas noticias! Tu inscripción en ${tenantName} ha sido aprobada y tu cuenta ya está activa.

Entra aquí: ${signinUrl}

— Equipo ${tenantName}

—
Powered by Didacta.io`;
  const html = `<!DOCTYPE html>
<html lang="es"><body style="font-family: 'Inter', system-ui, sans-serif; color: #0D1B2A; line-height: 1.6;">
  <p>${escapeHtml(greeting)}</p>
  <p>¡Buenas noticias! Tu inscripción en ${escapeHtml(tenantName)} ha sido aprobada y tu cuenta ya está activa.</p>
  <p style="margin: 32px 0;">
    <a href="${signinUrl}" style="display: inline-block; background: #1E5AA8; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
      Entrar
    </a>
  </p>
  <p style="margin-top: 32px; font-size: 12px; color: #94a3b8;">— Equipo ${escapeHtml(tenantName)}</p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 12px;" />
  <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">Powered by Didacta.io</p>
</body></html>`;
  return { subject, text, html };
}

// ─── Rechazo: inscripción no aprobada ────────────────────────────────────────
/** Aviso breve de que la inscripción no ha sido aprobada. */
export function buildRejectionEmail(name: string, tenantName = 'Didacta'): EmailContent {
  const greeting = name ? `Hola ${name},` : 'Hola,';
  const subject = `Sobre tu inscripción en ${tenantName}`;
  const text = `${greeting}

Gracias por tu interés en ${tenantName}. Tras revisar tu solicitud, no hemos podido aprobar tu inscripción en este momento.

Si crees que se trata de un error, puedes ponerte en contacto con el equipo.

— Equipo ${tenantName}

—
Powered by Didacta.io`;
  const html = `<!DOCTYPE html>
<html lang="es"><body style="font-family: 'Inter', system-ui, sans-serif; color: #0D1B2A; line-height: 1.6;">
  <p>${escapeHtml(greeting)}</p>
  <p>Gracias por tu interés en ${escapeHtml(tenantName)}. Tras revisar tu solicitud, no hemos podido aprobar tu inscripción en este momento.</p>
  <p style="font-size: 14px; color: #5b6b7c;">
    Si crees que se trata de un error, puedes ponerte en contacto con el equipo.
  </p>
  <p style="margin-top: 32px; font-size: 12px; color: #94a3b8;">— Equipo ${escapeHtml(tenantName)}</p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 12px;" />
  <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">Powered by Didacta.io</p>
</body></html>`;
  return { subject, text, html };
}
