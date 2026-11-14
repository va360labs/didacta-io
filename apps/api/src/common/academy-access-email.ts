/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { renderBrandedEmail, escapeHtml, type EmailBranding } from './branded-email';
import {
  interpolate,
  linkValidityLabel,
  resolveAcademyOwnerWelcomeCopy,
  resolveNewAccessLinkCopy,
  toHubTemplateLang,
} from '../modules/notifications/email-template-catalog';

/**
 * Los dos correos de ACCESO que no son ni un «olvidé mi contraseña» ni una
 * invitación:
 *
 *  - la BIENVENIDA de quien acaba de crear su academia (la manda el alta del
 *    aula, `POST /admin/tenants`), y
 *  - el ENLACE NUEVO que se pide con un clic desde un enlace caducado.
 *
 * Copy en el catálogo (`ACADEMY_OWNER_WELCOME_COPY`, `NEW_ACCESS_LINK_COPY`),
 * maqueta de marca del aula (`renderBrandedEmail`), igual que la invitación.
 */
export interface AccessEmailContent {
  /** Saludo ya resuelto («Hola Lucía,» o «Hola,»). */
  greeting: string;
  /** Enlace personal para definir la contraseña. */
  resetUrl: string;
  /** Minutos de validez del enlace, para decirlo sin mentir. */
  ttlMinutes: number;
  /** Idioma del destinatario (`user.locale`, ya resuelto). */
  locale: string;
}

export function academyOwnerWelcomeEmail(
  branding: EmailBranding,
  content: AccessEmailContent,
): { subject: string; html: string; text: string } {
  const tenant = branding.tenantName;
  const copy = resolveAcademyOwnerWelcomeCopy(content.locale);
  const validez = linkValidityLabel(content.ttlMinutes, content.locale);
  const subject = interpolate(copy.subject, { tenantName: tenant });

  const bodyText = `${content.greeting}

${interpolate(copy.introText, { tenantName: tenant })}

1. ${copy.step1}
2. ${copy.step2}
3. ${copy.step3}

${interpolate(copy.validityNote, { validez })} ${copy.expiredHelp}`;

  // `introHtml` trae el `<strong>` de la maqueta y recibe el nombre YA escapado.
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
  )} ${escapeHtml(copy.expiredHelp)}</p>
  <p style="margin:0;font-size:14px;color:#5b6b7c;">${escapeHtml(
    copy.linkFallback,
  )}<br /><span style="word-break:break-all;">${escapeHtml(content.resetUrl)}</span></p>`;

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

export function newAccessLinkEmail(
  branding: EmailBranding,
  content: AccessEmailContent,
): { subject: string; html: string; text: string } {
  const tenant = branding.tenantName;
  const copy = resolveNewAccessLinkCopy(content.locale);
  const validez = linkValidityLabel(content.ttlMinutes, content.locale);
  const subject = interpolate(copy.subject, { tenantName: tenant });
  const body = interpolate(copy.body, { tenantName: tenant });
  const validity = interpolate(copy.validityNote, { validez });

  const bodyText = `${content.greeting}

${body}

${validity}`;
  const bodyHtml = `<p style="margin:0 0 12px;">${escapeHtml(content.greeting)}</p>
  <p style="margin:0 0 12px;">${escapeHtml(body)}</p>
  <p style="margin:0 0 12px;font-size:14px;color:#5b6b7c;">${escapeHtml(validity)}</p>
  <p style="margin:0;font-size:14px;color:#5b6b7c;">${escapeHtml(
    copy.linkFallback,
  )}<br /><span style="word-break:break-all;">${escapeHtml(content.resetUrl)}</span></p>`;

  const { html, text } = renderBrandedEmail(branding, {
    lang: toHubTemplateLang(content.locale),
    title: copy.title,
    bodyHtml,
    bodyText,
    cta: { url: content.resetUrl, label: copy.cta },
    footerNote: copy.footerNote,
  });
  return { subject, html, text };
}
