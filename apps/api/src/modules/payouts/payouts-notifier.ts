/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsNotifier } from '@didacta/mod-payouts';
import type { Logger as PinoLogger } from 'nestjs-pino';
import {
  escapeHtml,
  PLAIN_EMAIL_INTL_LOCALE,
  renderBrandedEmail,
  resolveEmailBranding,
  textToHtmlParagraphs,
  type BrandingPrisma,
  type EmailLang,
} from '../../common/branded-email';
import type { PrismaService } from '../../prisma/prisma.service';
import { toHubTemplateLang } from '../notifications/email-template-catalog';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import type { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import type { SmtpAdapterService } from '../smtp-adapter.service';
import type { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';

/**
 * Avisos de dinero de `mod.payouts` (E6) por la infraestructura de correo de
 * siempre: SMTP del aula con caída al global (`TenantSmtpResolverService`) y
 * la plantilla con la marca del aula (`renderBrandedEmail`).
 *
 *  - Al CREADOR (administradores del aula): disputa abierta con su fecha
 *    límite, y deuda que se descontará de sus próximos cobros. En llano, en
 *    su idioma (es/en/pt), sin jerga de Stripe.
 *  - Al OPERADOR: cada alerta de dinero sale SIEMPRE en el log (`alert:`
 *    `payouts.*`, lo que vigila el operador) y, si hay
 *    `PAYMENTS_PLATFORM_OPERATOR_ALERT_EMAIL`, también por correo con el SMTP
 *    global del despliegue.
 *
 * Nunca lanza: un correo que no sale no deshace un asiento ni bloquea el
 * webhook.
 */

export interface PayoutsEmailNotifierDeps {
  readonly prisma: PrismaService;
  readonly logger: PinoLogger;
  readonly operatorName: string;
  readonly operatorAlertEmail: string | null;
  /** Quién paga la tasa de una disputa GANADA (por defecto, el creador). */
  readonly disputeWonFeeBearer?: 'creator' | 'platform';
  readonly smtpResolver?: TenantSmtpResolverService;
  readonly smtp?: SmtpAdapterService;
  readonly tenantResolver?: TenantResolverService;
}

const ADMIN_ROLES = ['tenant_admin'];
const MAX_RECIPIENTS = 5;

type Texts = {
  subject: string;
  title: string;
  body: string;
  cta: string;
};

/** Importe de Stripe (unidad mínima) legible: «93,25 €», «€93.25». */
export function formatMinor(amount: number, currency: string, lang: EmailLang): string {
  const zeroDecimal = new Set([
    'bif',
    'clp',
    'djf',
    'gnf',
    'jpy',
    'kmf',
    'krw',
    'mga',
    'pyg',
    'rwf',
    'vnd',
    'vuv',
    'xaf',
    'xof',
    'xpf',
  ]);
  const digits = zeroDecimal.has(currency.toLowerCase()) ? 0 : 2;
  try {
    return new Intl.NumberFormat(PLAIN_EMAIL_INTL_LOCALE[lang], {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(digits === 0 ? amount : amount / 100);
  } catch {
    return `${(digits === 0 ? amount : amount / 100).toFixed(digits)} ${currency.toUpperCase()}`;
  }
}

function formatDay(date: Date, lang: EmailLang): string {
  return new Intl.DateTimeFormat(PLAIN_EMAIL_INTL_LOCALE[lang], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** «una venta» cuando el pago no trae descripción. */
const A_SALE: Readonly<Record<EmailLang, string>> = {
  es: 'una venta',
  en: 'a sale',
  pt: 'uma venda',
};

/**
 * Textos de los avisos al creador. Puro: lo fijan los tests.
 *
 * Portugués: «contestação» es la reclamación al banco y «recebimentos» la
 * sección de cobros, como en el panel; las comillas son las curvas (“ ”) que
 * usa el portugués donde el español pone «».
 */
export function disputeOpenedTexts(input: {
  readonly lang: EmailLang;
  readonly operator: string;
  readonly description: string | null;
  readonly amount: string;
  readonly dueBy: string | null;
  /** ¿Paga el creador la tasa aunque se gane? (por defecto, sí). */
  readonly wonFeeCharged?: boolean;
}): Texts {
  const item = input.description ?? A_SALE[input.lang];
  const wonFeeCharged = input.wonFeeCharged ?? true;
  if (input.lang === 'pt') {
    const won = wonFeeCharged
      ? `Se o banco nos der razão, devolvemos o valor a você, mas o banco fica com a taxa dele mesmo quando ganhamos, e essa taxa será descontada dos seus próximos recebimentos.`
      : `Se o banco nos der razão, devolvemos o valor inteiro a você.`;
    return {
      subject: 'Um aluno contestou um pagamento junto ao banco',
      title: 'Um aluno contestou um pagamento',
      body:
        `Um aluno pediu ao banco que devolvesse o pagamento de “${item}” (${input.amount}).\n\n` +
        `${input.operator} vai responder ao banco em seu nome` +
        (input.dueBy ? ` até ${input.dueBy}` : '') +
        `. Se você tiver provas de que o aluno recebeu o curso (acessos, mensagens, fatura), envie para nós o quanto antes.\n\n` +
        `Enquanto o banco decide, o que você recebeu por essa venda fica retido. ${won} Se não, o valor será descontado dos seus próximos recebimentos junto com a taxa do banco.`,
      cta: 'Ver minhas vendas',
    };
  }
  if (input.lang === 'en') {
    const won = wonFeeCharged
      ? `If the bank rules in our favour, you get it back, but the bank keeps its fee even then, and that fee will be taken from your next payouts.`
      : `If the bank rules in our favour, you get it all back.`;
    return {
      subject: `A student has disputed a payment with their bank`,
      title: 'A student has disputed a payment',
      body:
        `A student has asked their bank to reverse the payment for "${item}" (${input.amount}).\n\n` +
        `${input.operator} will answer the bank on your behalf` +
        (input.dueBy ? ` before ${input.dueBy}` : '') +
        `. If you have proof that the student received the course (access history, messages, invoice), send it to us as soon as possible.\n\n` +
        `While the bank decides, what you received for this sale is on hold. ${won} If not, it will be taken from your next payouts together with the bank's fee.`,
      cta: 'See my sales',
    };
  }
  const won = wonFeeCharged
    ? `Si el banco nos da la razón, te lo devolvemos, pero el banco se queda su tasa aunque ganemos y esa tasa se descontará de tus próximos cobros.`
    : `Si el banco nos da la razón, te lo devolvemos entero.`;
  return {
    subject: 'Un alumno ha reclamado un pago a su banco',
    title: 'Un alumno ha reclamado un pago',
    body:
      `Un alumno ha pedido a su banco que le devuelva el pago de «${item}» (${input.amount}).\n\n` +
      `${input.operator} responderá al banco en tu nombre` +
      (input.dueBy ? ` antes del ${input.dueBy}` : '') +
      `. Si tienes pruebas de que el alumno recibió el curso (accesos, mensajes, factura), envíanoslas cuanto antes.\n\n` +
      `Mientras el banco decide, lo que recibiste por esa venta queda retenido. ${won} Si no, se descontará de tus próximos cobros junto con la tasa del banco.`,
    cta: 'Ver mis ventas',
  };
}

export function debtChargedTexts(input: {
  readonly lang: EmailLang;
  readonly description: string | null;
  readonly amount: string;
  readonly cause: 'refund' | 'dispute_withdrawn' | 'dispute_lost' | 'dispute_won';
}): Texts {
  const item = input.description ?? A_SALE[input.lang];
  if (input.cause === 'dispute_won') {
    // Buena noticia primero; luego, en llano, lo único que cuesta.
    if (input.lang === 'pt') {
      return {
        subject: `Ganhamos a contestação de “${item}”`,
        title: 'Ganhamos a contestação',
        body:
          `O banco do aluno nos deu razão sobre “${item}”: o que estava retido volta para você.\n\n` +
          `O banco não devolve a taxa dele por processar a contestação, mesmo quando ganhamos. Essa taxa (${input.amount}) será descontada dos seus próximos recebimentos.\n\n` +
          `Você não precisa fazer nada: ela é descontada automaticamente das suas próximas vendas, e você pode ver em Recebimentos.`,
        cta: 'Ver minhas vendas',
      };
    }
    if (input.lang === 'en') {
      return {
        subject: `We won the student's claim on "${item}"`,
        title: 'We won the claim',
        body:
          `The student's bank has ruled in our favour on "${item}": what was on hold comes back to you.\n\n` +
          `The bank doesn't return its fee for handling the claim, even when we win. That fee (${input.amount}) will be taken from your next payouts.\n\n` +
          `You don't need to do anything: it comes off your next sales automatically, and you can see it in Payouts.`,
        cta: 'See my sales',
      };
    }
    return {
      subject: `Hemos ganado la reclamación de «${item}»`,
      title: 'Hemos ganado la reclamación',
      body:
        `El banco del alumno nos ha dado la razón con «${item}»: lo que estaba retenido vuelve a ti.\n\n` +
        `El banco no devuelve su tasa por tramitar la reclamación, aunque ganemos. Esa tasa (${input.amount}) se descontará de tus próximos cobros.\n\n` +
        `No tienes que hacer nada: se resta sola de tus siguientes ventas y lo ves en Cobros.`,
      cta: 'Ver mis ventas',
    };
  }
  if (input.lang === 'pt') {
    const reason =
      input.cause === 'refund'
        ? `do reembolso de “${item}”`
        : `da contestação de “${item}”, que o aluno ganhou junto ao banco (taxa do banco e taxa do cartão)`;
    return {
      subject: `Vamos descontar ${input.amount} dos seus próximos recebimentos`,
      title: `Vamos descontar ${input.amount} dos seus próximos recebimentos`,
      body:
        `Por causa ${reason}, vamos descontar ${input.amount} dos seus próximos recebimentos.\n\n` +
        `Você não precisa fazer nada: o valor é descontado automaticamente das suas próximas vendas, e você pode ver em Recebimentos.`,
      cta: 'Ver minhas vendas',
    };
  }
  if (input.lang === 'en') {
    const reason =
      input.cause === 'refund'
        ? `the refund of "${item}"`
        : `the payment dispute on "${item}", which the student won at their bank (bank fee and card fee)`;
    return {
      subject: `We'll take ${input.amount} from your next payouts`,
      title: `We'll take ${input.amount} from your next payouts`,
      body:
        `Because of ${reason}, we'll take ${input.amount} from your next payouts.\n\n` +
        `You don't need to do anything: it comes off your next sales automatically, and you can see it in Payouts.`,
      cta: 'See my sales',
    };
  }
  const reason =
    input.cause === 'refund'
      ? `el reembolso de «${item}»`
      : `la reclamación de «${item}», que el alumno ganó en su banco (tasa del banco y comisión de la tarjeta)`;
  return {
    subject: `Te descontaremos ${input.amount} de tus próximos cobros`,
    title: `Te descontaremos ${input.amount} de tus próximos cobros`,
    body:
      `Por ${reason}, te descontaremos ${input.amount} de tus próximos cobros.\n\n` +
      `No tienes que hacer nada: se resta solo de tus siguientes ventas y lo ves en Cobros.`,
    cta: 'Ver mis ventas',
  };
}

export class PayoutsEmailNotifier implements PayoutsNotifier {
  constructor(private readonly deps: PayoutsEmailNotifierDeps) {}

  async disputeOpened(input: Parameters<PayoutsNotifier['disputeOpened']>[0]): Promise<void> {
    await this.toCreator(input.tenantId, 'payouts.dispute_opened', (lang) =>
      disputeOpenedTexts({
        lang,
        operator: this.deps.operatorName,
        description: input.description,
        amount: formatMinor(input.amount, input.currency, lang),
        dueBy: input.evidenceDueBy ? formatDay(input.evidenceDueBy, lang) : null,
        wonFeeCharged: (this.deps.disputeWonFeeBearer ?? 'creator') === 'creator',
      }),
    );
  }

  async debtCharged(input: Parameters<PayoutsNotifier['debtCharged']>[0]): Promise<void> {
    await this.toCreator(input.tenantId, 'payouts.debt_charged', (lang) =>
      debtChargedTexts({
        lang,
        description: input.description,
        amount: formatMinor(input.amount, input.currency, lang),
        cause: input.cause,
      }),
    );
  }

  async operatorAlert(alert: string, detail: Record<string, unknown>): Promise<void> {
    const to = this.deps.operatorAlertEmail;
    if (!to || !this.deps.smtpResolver || !this.deps.smtp) return;
    try {
      const resolved = this.deps.smtpResolver.resolveGlobal();
      if (!resolved) {
        this.deps.logger.warn({ alert }, 'payouts: sin SMTP global — alerta solo en el log');
        return;
      }
      const lines = Object.entries(detail).map(
        ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
      );
      const text = `${alert}\n\n${lines.join('\n')}`;
      const result = await this.deps.smtp.send(
        resolved.config,
        {
          to,
          subject: `[${this.deps.operatorName} · cobros] ${alert}`,
          text,
          html: `<pre style="font-family:ui-monospace,monospace;font-size:13px;">${escapeHtml(text)}</pre>`,
        },
        `${this.deps.operatorName} cobros`,
      );
      if (!result.ok) {
        this.deps.logger.warn(
          { alert, error: result.error },
          'payouts: la alerta por correo no salió',
        );
      }
    } catch (err) {
      this.deps.logger.warn({ alert, err }, 'payouts: excepción al enviar la alerta por correo');
    }
  }

  /** A los administradores del aula, cada uno en su idioma. */
  private async toCreator(
    tenantId: string,
    kind: string,
    texts: (lang: EmailLang) => Texts,
  ): Promise<void> {
    const { prisma, logger, smtpResolver, smtp } = this.deps;
    try {
      if (!smtpResolver || !smtp) return;
      const resolved = await smtpResolver.resolve(tenantId);
      if (!resolved) {
        logger.warn({ tenantId, kind }, 'payouts: sin SMTP — aviso al creador no enviado');
        return;
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
      if (admins.length === 0) return;
      const base = this.deps.tenantResolver
        ? await this.deps.tenantResolver.resolveTenantWebBaseUrlForBackground(tenantId)
        : (process.env['WEB_BASE_URL'] ?? '');
      const branding = await resolveEmailBranding(
        prisma as unknown as BrandingPrisma,
        tenantId,
        base,
      );
      for (const admin of admins) {
        // Inglés y portugués con su copy; cualquier otro idioma, español.
        const lang: EmailLang = toHubTemplateLang(admin.locale);
        const t = texts(lang);
        const { html, text } = renderBrandedEmail(branding, {
          lang,
          title: t.title,
          bodyHtml: textToHtmlParagraphs(t.body),
          bodyText: t.body,
          ...(base
            ? { cta: { label: t.cta, url: `${base.replace(/\/+$/, '')}/admin/payments` } }
            : {}),
        });
        const result = await smtp.send(
          resolved.config,
          { to: admin.email, subject: t.subject, text, html },
          branding.tenantName,
        );
        if (!result.ok) {
          logger.warn(
            { tenantId, kind, error: result.error },
            'payouts: el aviso al creador no salió',
          );
        }
      }
    } catch (err) {
      logger.warn({ tenantId, kind, err }, 'payouts: excepción al avisar al creador');
    }
  }
}
