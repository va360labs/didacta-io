/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Optional } from '@nestjs/common';
import { formatInvoiceAmount, type InvoiceView } from '@didacta/mod-payouts';
import { Logger as PinoLogger } from 'nestjs-pino';
import { escapeHtml, textToHtmlParagraphs, type EmailLang } from '../../common/branded-email';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { SmtpAdapterService } from '../smtp-adapter.service';
import { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';
import { PayoutsRuntime } from './payouts-runtime.service';

const ADMIN_ROLES = ['tenant_admin'];
const MAX_RECIPIENTS = 5;

/** Textos del correo de una factura. Puro: lo fijan los tests. */
export function invoiceEmailTexts(input: {
  readonly lang: EmailLang;
  readonly operator: string;
  readonly serviceName: string;
  readonly invoice: Pick<
    InvoiceView,
    | 'kind'
    | 'fullNumber'
    | 'periodStart'
    | 'periodEnd'
    | 'total'
    | 'taxBase'
    | 'vatAmount'
    | 'vatRateBps'
    | 'currency'
    | 'recipientComplete'
    | 'rectifies'
  >;
}): { subject: string; body: string } {
  const { invoice } = input;
  const total = formatInvoiceAmount(invoice.total, invoice.currency);
  const from = dayLabel(invoice.periodStart, input.lang);
  const to = dayLabel(invoice.periodEnd, input.lang);
  const vat =
    invoice.vatRateBps > 0
      ? input.lang === 'en'
        ? ` (${formatInvoiceAmount(invoice.taxBase, invoice.currency)} + ${invoice.vatRateBps / 100} % VAT)`
        : ` (${formatInvoiceAmount(invoice.taxBase, invoice.currency)} + IVA del ${invoice.vatRateBps / 100} %)`
      : '';
  const rectified = invoice.rectifies.map((r) => r.fullNumber).join(', ');
  if (input.lang === 'en') {
    const lead =
      invoice.kind === 'RECTIFYING'
        ? `Attached is corrective invoice ${invoice.fullNumber}, which corrects ${rectified}. Amount: ${total}${vat}.`
        : `Attached is invoice ${invoice.fullNumber} for our ${input.serviceName} fee from ${from} to ${to}: ${total}${vat}.`;
    return {
      subject:
        invoice.kind === 'RECTIFYING'
          ? `Corrective invoice ${invoice.fullNumber} from ${input.operator}`
          : `Your ${input.serviceName} invoice ${invoice.fullNumber}`,
      body:
        `${lead}\n\n` +
        (invoice.total < 0
          ? `There's nothing to do: this part of our fee was already returned to your payouts when the refund was made. You can also find it in Payouts → Your invoices.`
          : `There's nothing to pay: it was already deducted from the sales we collected on your behalf. You can also find it in Payouts → Your invoices.`) +
        (invoice.recipientComplete
          ? ''
          : `\n\nYour tax details are missing. Add them in Payouts and we'll send you this invoice again with them.`),
    };
  }
  const lead =
    invoice.kind === 'RECTIFYING'
      ? `Te adjuntamos la factura rectificativa ${invoice.fullNumber}, que corrige ${rectified}. Importe: ${total}${vat}.`
      : `Te adjuntamos la factura ${invoice.fullNumber} de nuestra comisión de ${input.serviceName} del ${from} al ${to}: ${total}${vat}.`;
  return {
    subject:
      invoice.kind === 'RECTIFYING'
        ? `Factura rectificativa ${invoice.fullNumber} de ${input.operator}`
        : `Tu factura de ${input.serviceName} ${invoice.fullNumber}`,
    body:
      `${lead}\n\n` +
      (invoice.total < 0
        ? `No tienes que hacer nada: esta parte de nuestra comisión ya volvió a tus cobros al hacer el reembolso. También la tienes en Cobros → Tus facturas.`
        : `No tienes que pagar nada: ya se descontó de las ventas que cobramos en tu nombre. También la tienes en Cobros → Tus facturas.`) +
      (invoice.recipientComplete
        ? ''
        : `\n\nFaltan tus datos fiscales. Complétalos en Cobros y te mandaremos esta factura con ellos.`),
  };
}

function dayLabel(isoDay: string, lang: EmailLang): string {
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'es-ES', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${isoDay}T00:00:00Z`));
}

/**
 * Correo de cada factura emitida, con el PDF adjunto, a los administradores
 * del aula. La factura la emite el OPERADOR: sale por el SMTP global de la
 * instalación (si no hay, por el del aula) con el nombre del operador.
 *
 * Nunca lanza. Un envío fallido se reintenta en la siguiente pasada (hasta 5
 * veces); el éxito queda en `emailed_at`.
 */
@Injectable()
export class PayoutsInvoiceMailer {
  constructor(
    private readonly runtime: PayoutsRuntime,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    @Optional() private readonly smtpResolver?: TenantSmtpResolverService,
    @Optional() private readonly smtp?: SmtpAdapterService,
    @Optional() private readonly tenantResolver?: TenantResolverService,
  ) {}

  /** Manda las facturas que aún no salieron. */
  async sendPending(limit = 50): Promise<{ sent: number; failed: number }> {
    const invoices = this.runtime.invoices;
    if (!invoices) return { sent: 0, failed: 0 };
    let sent = 0;
    let failed = 0;
    for (const pending of await invoices.pendingEmails(limit)) {
      if (await this.send(pending.tenantId, pending.id)) sent += 1;
      else failed += 1;
    }
    return { sent, failed };
  }

  async send(tenantId: string, invoiceId: string): Promise<boolean> {
    const invoices = this.runtime.invoices;
    if (!invoices || !this.smtp || !this.smtpResolver) return false;
    try {
      const data = await invoices.forEmail(tenantId, invoiceId);
      if (!data) return false;
      const resolved =
        this.smtpResolver.resolveGlobal() ?? (await this.smtpResolver.resolve(tenantId));
      if (!resolved) {
        this.logger.warn(
          { tenantId, invoiceId },
          'payouts.invoice: sin SMTP — la factura no se envió',
        );
        await invoices.markEmailed(tenantId, invoiceId, false);
        return false;
      }
      const admins = await runAsTenant(tenantId, () =>
        this.prisma.user.findMany({
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
      if (admins.length === 0) {
        await invoices.markEmailed(tenantId, invoiceId, false);
        return false;
      }
      const base = this.tenantResolver
        ? await this.tenantResolver.resolveTenantWebBaseUrlForBackground(tenantId)
        : '';
      let ok = true;
      for (const admin of admins) {
        const lang: EmailLang = (admin.locale ?? '').toLowerCase().startsWith('en') ? 'en' : 'es';
        const texts = invoiceEmailTexts({
          lang,
          operator: this.runtime.config.displayName,
          serviceName: invoices.config.serviceName,
          invoice: data.view,
        });
        const link = base ? `${base.replace(/\/+$/, '')}/admin/payments` : null;
        const html =
          `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.55;color:#0f172a;max-width:560px">` +
          textToHtmlParagraphs(texts.body) +
          (link
            ? `<p style="margin:16px 0 0"><a href="${escapeHtml(link)}" style="color:#1d4ed8">${lang === 'en' ? 'Open Payouts' : 'Abrir Cobros'}</a></p>`
            : '') +
          `</div>`;
        const result = await this.smtp.send(
          resolved.config,
          {
            to: admin.email,
            subject: texts.subject,
            text: link ? `${texts.body}\n\n${link}` : texts.body,
            html,
            attachments: [
              { filename: data.fileName, content: data.pdf, contentType: 'application/pdf' },
            ],
          },
          this.runtime.config.displayName,
        );
        if (!result.ok) {
          ok = false;
          this.logger.warn(
            { tenantId, invoiceId, error: result.error },
            'payouts.invoice: el correo de la factura no salió',
          );
        }
      }
      await invoices.markEmailed(tenantId, invoiceId, ok);
      return ok;
    } catch (err) {
      this.logger.warn(
        { tenantId, invoiceId, err: (err as Error).message },
        'payouts.invoice: excepción al enviar la factura',
      );
      return false;
    }
  }
}
