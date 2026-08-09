/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { renderBrandedEmail, escapeHtml, type EmailBranding } from './branded-email';
import {
  interpolate,
  resolveInvitationEmailCopy,
  toHubTemplateLang,
} from '../modules/notifications/email-template-catalog';

/**
 * Email de INVITACIÓN al aula: el que recibe alguien cuya cuenta ya existe pero
 * aún no ha entrado nunca.
 *
 * Tiene copy propio y no reutiliza el del restablecimiento de contraseña,
 * porque son dos correos distintos: uno lo pide el usuario y se lee al momento;
 * este llega sin avisar y tiene que explicar qué es, por qué lo recibe y qué
 * gana entrando. La maqueta sí es la compartida de marca del TENANT
 * (`renderBrandedEmail`): header con su logo, color de marca, botón CTA y
 * footer "Powered by Didacta" — así la invitación de cada academia sale con su
 * propia identidad sin duplicar HTML de email.
 */
export interface InvitationEmailContent {
  /** Saludo ya resuelto («Hola Ana,» o «Hola,»). */
  greeting: string;
  /** Enlace personal para definir la contraseña. */
  resetUrl: string;
  /** Días de validez del enlace, para decirlo sin mentir. */
  validezDias: number;
  /**
   * Idioma del INVITADO (`user.locale` de su fila). Obligatorio: con un
   * parámetro opcional no se distingue «español» de «se me olvidó pasarlo»,
   * que es el patrón que ya causó tres bugs en esta migración. El caller lo
   * resuelve con `resolveRecipientLocale`.
   */
  locale: string;
}

export function invitationEmailHtml(
  branding: EmailBranding,
  content: InvitationEmailContent,
): { subject: string; html: string; text: string } {
  const tenant = branding.tenantName;
  const copy = resolveInvitationEmailCopy(content.locale);
  const subject = interpolate(copy.subject, { tenantName: tenant });
  const validez = `${content.validezDias} ${
    content.validezDias === 1 ? copy.dayOne : copy.dayMany
  }`;

  const bodyText = `${content.greeting}

${interpolate(copy.introText, { tenantName: tenant })}

${interpolate(copy.validityText, { validez })}

${copy.help}`;

  // `introHtml` trae el `<strong>` de la maqueta y recibe el tenant YA escapado.
  const introHtml = interpolate(copy.introHtml, { tenantName: escapeHtml(tenant) });
  const bodyHtml = `<p style="margin:0 0 12px;">${escapeHtml(content.greeting)}</p>
  <p style="margin:0 0 12px;">${introHtml}</p>
  <ol style="margin:0 0 12px;padding-left:20px;">
    <li style="margin:0 0 6px;">${escapeHtml(copy.step1)}</li>
    <li style="margin:0 0 6px;">${escapeHtml(copy.step2)}</li>
    <li style="margin:0;">${escapeHtml(copy.step3)}</li>
  </ol>
  <p style="margin:0 0 12px;font-size:14px;color:#5b6b7c;">${escapeHtml(
    interpolate(copy.validityNote, { validez }),
  )}</p>
  <p style="margin:0;font-size:14px;color:#5b6b7c;">${escapeHtml(
    copy.linkFallback,
  )}<br /><span style="word-break:break-all;">${escapeHtml(content.resetUrl)}</span></p>
  <p style="margin:12px 0 0;font-size:14px;color:#5b6b7c;">${escapeHtml(copy.help)}</p>`;

  const { html, text } = renderBrandedEmail(branding, {
    lang: toHubTemplateLang(content.locale),
    title: copy.title,
    bodyHtml,
    bodyText,
    cta: { url: content.resetUrl, label: copy.cta },
    footerNote: interpolate(copy.footerNote, { tenantName: tenant }),
  });

  return { subject, html, text };
}
