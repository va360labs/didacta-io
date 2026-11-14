/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@didacta/core-kernel';
import { RETENTION_EVENT } from '@didacta/mod-subscriptions';
import { Logger as PinoLogger } from 'nestjs-pino';
import {
  renderBrandedEmail,
  resolveEmailBranding,
  textToHtmlParagraphs,
  type BrandingPrisma,
  type EmailLang,
} from '../../common/branded-email';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { ModuleContextFactory } from '../module-context.factory';
import { resolveRecipientLocale, toHubTemplateLang } from '../notifications/email-template-catalog';
import { SmtpAdapterService } from '../smtp-adapter.service';
import { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';
import {
  cancelConfirmedTexts,
  discountAppliedTexts,
  fallbackItemName,
  pauseConfirmedTexts,
  type RetentionEmailTexts,
} from './retention-email-texts';

interface RetentionEventPayload {
  subscriptionId: string;
  userId: string;
  planId?: string | null;
  courseId?: string | null;
  // pausa
  months?: number | null;
  pauseStartsAt?: string;
  pauseEndsAt?: string;
  // descuento
  percent?: number;
  duration?: string;
  amountCents?: number;
  discountedAmountCents?: number;
  currency?: string;
  nextChargeAt?: string | null;
  // baja
  accessEndsAt?: string | null;
}

/**
 * Correo de confirmación de la oferta al darse de baja: pausa confirmada,
 * descuento aplicado o baja confirmada, en el idioma del alumno (es/en/pt) y
 * con la marca del aula.
 *
 * Escucha los eventos que publica `RetentionService` (`subscriptions.retention.*`).
 * Mejor esfuerzo, como la confirmación de compra: si el aula no tiene correo
 * configurado o el envío falla, se apunta en el log y no se reintenta —
 * reintentar el evento reenviaría a quien sí lo recibió.
 */
@Injectable()
export class RetentionMailerBridge implements OnModuleInit {
  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly prisma: PrismaService,
    private readonly tenantResolver: TenantResolverService,
    private readonly smtpResolver: TenantSmtpResolverService,
    private readonly smtp: SmtpAdapterService,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const bus = this.factory.getEventBus();
    for (const name of [
      RETENTION_EVENT.PAUSE_ACCEPTED,
      RETENTION_EVENT.DISCOUNT_ACCEPTED,
      RETENTION_EVENT.CANCEL_CONFIRMED,
    ]) {
      bus.subscribe<RetentionEventPayload>(name, async (event) => this.handle(event));
    }
  }

  async handle(event: DomainEvent<RetentionEventPayload>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    const data = event.data;
    try {
      const user = await this.prisma.user.findFirst({
        where: { id: data.userId, tenantId },
        select: { email: true, name: true, locale: true },
      });
      if (!user?.email) return;
      const lang: EmailLang = toHubTemplateLang(resolveRecipientLocale(user.locale));
      const resolved = await this.smtpResolver.resolve(tenantId);
      if (!resolved) {
        this.logger.warn(
          { tenantId, event: event.name },
          'retention-mailer: el aula no tiene correo configurado — confirmación no enviada',
        );
        return;
      }
      const base = await this.tenantResolver.resolveTenantWebBaseUrlForBackground(tenantId);
      const branding = await resolveEmailBranding(
        this.prisma as unknown as BrandingPrisma,
        tenantId,
        base,
      );
      const item = (await this.itemName(tenantId, data)) ?? fallbackItemName(lang);
      const common = { lang, name: user.name, academy: branding.tenantName, item };
      const texts = this.texts(event.name, data, common);
      if (!texts) return;
      const { html, text } = renderBrandedEmail(branding, {
        lang,
        title: texts.title,
        bodyHtml: textToHtmlParagraphs(texts.body),
        bodyText: texts.body,
        cta: { label: texts.cta, url: `${base}/account?tab=subscription` },
      });
      const result = await this.smtp.send(
        resolved.config,
        { to: user.email, subject: texts.subject, text, html },
        branding.tenantName,
      );
      if (!result.ok) {
        this.logger.warn(
          { tenantId, event: event.name, error: result.error },
          'retention-mailer: el correo no salió',
        );
      }
    } catch (err) {
      this.logger.warn(
        { tenantId, event: event.name, err: (err as Error).message },
        'retention-mailer: no se pudo enviar la confirmación',
      );
    }
  }

  private texts(
    name: string,
    data: RetentionEventPayload,
    common: { lang: EmailLang; name: string | null; academy: string; item: string },
  ): RetentionEmailTexts | null {
    if (name === RETENTION_EVENT.PAUSE_ACCEPTED && data.pauseStartsAt && data.pauseEndsAt) {
      return pauseConfirmedTexts({
        ...common,
        startsAt: new Date(data.pauseStartsAt),
        endsAt: new Date(data.pauseEndsAt),
        months: data.months ?? 1,
      });
    }
    if (name === RETENTION_EVENT.DISCOUNT_ACCEPTED && data.percent && data.currency) {
      return discountAppliedTexts({
        ...common,
        percent: data.percent,
        months: data.duration === 'once' ? null : (data.months ?? null),
        amountCents: data.amountCents ?? 0,
        discountedAmountCents: data.discountedAmountCents ?? 0,
        currency: data.currency,
        nextChargeAt: data.nextChargeAt ? new Date(data.nextChargeAt) : null,
      });
    }
    if (name === RETENTION_EVENT.CANCEL_CONFIRMED) {
      return cancelConfirmedTexts({
        ...common,
        accessEndsAt: data.accessEndsAt ? new Date(data.accessEndsAt) : null,
      });
    }
    return null;
  }

  /** Nombre del plan (membresía) o del curso, filtrado por aula. */
  private async itemName(tenantId: string, data: RetentionEventPayload): Promise<string | null> {
    if (data.planId) {
      const plan = await this.prisma.modSubscriptionsPlan.findFirst({
        where: { id: data.planId, tenantId },
        select: { name: true },
      });
      return plan?.name ?? null;
    }
    if (data.courseId) {
      const course = await this.prisma.modCoursesCourse.findFirst({
        where: { id: data.courseId, tenantId },
        select: { title: true },
      });
      return course?.title ?? null;
    }
    return null;
  }
}
