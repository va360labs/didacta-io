/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Logger } from '@nestjs/common';
import {
  escapeHtml,
  renderBrandedEmail,
  resolveEmailBranding,
  textToHtmlParagraphs,
  type BrandingPrisma,
  type EmailLang,
} from '../../common/branded-email';
import { toHubTemplateLang } from '../../modules/notifications/email-template-catalog';
import type { SmtpAdapterService } from '../../modules/smtp-adapter.service';
import type { TenantSmtpResolverService } from '../../modules/tenant-smtp-resolver.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import type { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { inactivityTexts } from './video-inactivity-texts';
import type { VideoInactivityNotifier } from './video-inactivity.service';

const ADMIN_ROLES = ['tenant_admin'];
const MAX_RECIPIENTS = 5;

/**
 * Avisos de inactividad por la infraestructura de correo de siempre: SMTP del
 * aula con caída al global y la plantilla con la marca del aula. A los
 * administradores del aula, cada uno en su idioma (es/en/pt).
 *
 * Nunca lanza: un correo que no sale devuelve 0 y el aviso no cuenta como
 * dado (sin aviso, no hay borrado).
 */
export class VideoInactivityEmailNotifier implements VideoInactivityNotifier {
  private readonly logger = new Logger(VideoInactivityEmailNotifier.name);

  constructor(
    private readonly deps: {
      prisma: PrismaService;
      smtpResolver: TenantSmtpResolverService;
      smtp: SmtpAdapterService;
      tenantResolver: TenantResolverService;
      operatorAlertEmail: string | null;
    },
  ) {}

  async warnCreator(input: { tenantId: string; stage: 10 | 20; deleteOn: Date }): Promise<number> {
    const { prisma, smtpResolver, smtp, tenantResolver } = this.deps;
    const { tenantId } = input;
    try {
      const resolved = await smtpResolver.resolve(tenantId);
      if (!resolved) {
        this.logger.warn(`alert: video.inactivity.no_smtp aula=${tenantId}: aviso no enviado`);
        return 0;
      }
      const admins = await runAsTenant(tenantId, () =>
        prisma.user.findMany({
          where: {
            tenantId,
            deletedAt: null,
            status: 'ACTIVE',
            roles: { some: { role: { name: { in: ADMIN_ROLES } } } },
          },
          select: { email: true, locale: true },
          orderBy: { createdAt: 'asc' },
          take: MAX_RECIPIENTS,
        }),
      );
      if (admins.length === 0) return 0;
      const base = await tenantResolver.resolveTenantWebBaseUrlForBackground(tenantId);
      const branding = await resolveEmailBranding(
        prisma as unknown as BrandingPrisma,
        tenantId,
        base,
      );
      let sent = 0;
      for (const admin of admins) {
        // Inglés y portugués con su copy; cualquier otro idioma, español.
        const lang: EmailLang = toHubTemplateLang(admin.locale);
        const t = inactivityTexts({
          lang,
          stage: input.stage,
          academy: branding.tenantName,
          deleteOn: input.deleteOn,
        });
        const { html, text } = renderBrandedEmail(branding, {
          lang,
          title: t.title,
          bodyHtml: textToHtmlParagraphs(t.body),
          bodyText: t.body,
          ...(base ? { cta: { label: t.cta, url: `${base.replace(/\/+$/, '')}/studio` } } : {}),
        });
        const result = await smtp.send(
          resolved.config,
          { to: admin.email, subject: t.subject, text, html },
          branding.tenantName,
        );
        if (result.ok) sent++;
        else this.logger.warn(`aviso de inactividad no salió (aula ${tenantId}): ${result.error}`);
      }
      return sent;
    } catch (err) {
      this.logger.warn(
        `excepción al avisar de inactividad (aula ${tenantId}): ${(err as Error).message}`,
      );
      return 0;
    }
  }

  async operatorAlert(alert: string, detail: Record<string, unknown>): Promise<void> {
    const to = this.deps.operatorAlertEmail;
    if (!to) return;
    try {
      const resolved = this.deps.smtpResolver.resolveGlobal();
      if (!resolved) return;
      const text = `${alert}\n\n${Object.entries(detail)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n')}`;
      await this.deps.smtp.send(
        resolved.config,
        {
          to,
          subject: `[vídeo] ${alert}`,
          text,
          html: `<pre style="font-family:ui-monospace,monospace;font-size:13px;">${escapeHtml(text)}</pre>`,
        },
        'Didacta vídeo',
      );
    } catch (err) {
      this.logger.warn(`alerta de vídeo por correo no salió: ${(err as Error).message}`);
    }
  }
}
