/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { NotificationValue } from '@didacta/core-kernel';
import type {
  PayoutsNotifier,
  RefundIssuedNotice,
  SaleMadeNotice,
  SaleNoticeKind,
} from '@didacta/mod-payouts';
import type { Logger as PinoLogger } from 'nestjs-pino';
import {
  academyLocale,
  academyTimeZone,
  type AcademyDefaultsPrisma,
} from '../../common/academy-defaults';
import {
  escapeHtml,
  renderBrandedEmail,
  resolveEmailBranding,
  textToHtmlParagraphs,
  type BrandingPrisma,
  type EmailBranding,
  type EmailLang,
} from '../../common/branded-email';
import { formatDay, formatMinor } from '../../common/money-format';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  fetchEmailOverride,
  toHubTemplateLang,
  type TemplateOverridePrisma,
} from '../notifications/email-template-catalog';
import {
  buildCreatorSaleEmail,
  buildRefundEmail,
  orderReference,
  type CreatorSaleData,
  type PaymentMethodView,
  type RenderedEmail,
} from '../sale-emails/sale-email-render';
import { SALE_EMAIL_STORAGE_LOCALE } from '../sale-emails/sale-email-templates';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import type { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import type { SmtpAdapterService } from '../smtp-adapter.service';
import type { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';

/**
 * Avisos de dinero de `mod.payouts` (E6) por la infraestructura de correo de
 * siempre (`TenantSmtpResolverService`, `renderBrandedEmail`).
 *
 *  - Al CREADOR (administradores del aula): cada venta (curso, alta o
 *    renovación de una membresía), disputa abierta con su fecha límite, y
 *    deuda que se descontará de sus próximos cobros. En llano, en su idioma
 *    (es/en/pt), sin jerga de Stripe. Los escribe el OPERADOR (Didacta): salen
 *    con su nombre y su SMTP (el global; el del aula si no hay), nunca con el
 *    nombre de la propia academia como si fuera otra persona — eso vio la
 *    creadora en el ensayo general («Cerámica con Lucía» le avisaba de una
 *    deuda con Cerámica con Lucía). El de cada venta va además a la campana y
 *    respeta las preferencias de «Sistema» de quien lo recibe.
 *  - Al ALUMNO, cuando se le reembolsa: lo devuelto y si pierde el acceso. Ese
 *    lo escribe la academia (es su relación con el alumno): su marca y su SMTP.
 *  - Al OPERADOR: cada alerta de dinero sale SIEMPRE en el log (`alert:`
 *    `payouts.*`, lo que vigila el operador) y, si hay
 *    `PAYMENTS_PLATFORM_OPERATOR_ALERT_EMAIL`, también por correo con el SMTP
 *    global del despliegue.
 *
 * Nunca lanza: un correo que no sale no deshace un asiento ni bloquea el
 * webhook.
 */

/** Lo que el notificador necesita del hub (solo la campana). */
export interface NotificationHubLike {
  send(notification: {
    tenantId: string;
    channel: 'in-app';
    templateKey: string;
    to: string;
    variables: Record<string, unknown>;
    category?: 'SYSTEM';
  }): Promise<void>;
}

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
  /** La campana (notificaciones del aula). Perezoso: el hub vive en otro módulo. */
  readonly hub?: () => NotificationHubLike | null;
  /**
   * Marca y 4 últimas cifras del medio de pago de un cargo (Stripe de la
   * plataforma), para el recibo del reembolso. Sin él, el recibo no lo dice.
   */
  readonly chargeMethod?: (chargeId: string) => Promise<PaymentMethodView | null>;
}

const ADMIN_ROLES = ['tenant_admin'];
const MAX_RECIPIENTS = 5;

/**
 * Clave de la notificación de venta en la campana (catálogo del hub): una por
 * tipo, para que la plantilla no necesite secciones anidadas.
 */
export function saleTemplateKey(kind: SaleNoticeKind): string {
  return `payouts.sale.${kind}`;
}

/** Color de los avisos del operador (sin la marca de ningún aula). */
const OPERATOR_BRAND_COLOR = '#1E5AA8';

type Texts = {
  subject: string;
  title: string;
  body: string;
  cta: string;
};

interface CreatorRecipient {
  readonly id: string;
  readonly email: string;
  readonly locale: string | null;
}

/** Re-exportado: los avisos de cobros lo han importado siempre de aquí. */
export { formatMinor };

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

/** Quién escribe al creador y por qué (pie de los avisos del operador). */
export function creatorFooter(lang: EmailLang, operator: string, academy: string): string {
  if (lang === 'pt') return `${operator} escreve para você porque você administra “${academy}”.`;
  if (lang === 'en') return `${operator} is writing to you because you run "${academy}".`;
  return `Te escribe ${operator} porque administras «${academy}».`;
}

/**
 * Aviso de una VENTA a quien administra el aula. Puro: lo fijan los tests.
 * `buyer` es el nombre del alumno (o su correo, si aún no tiene nombre).
 */
export function saleMadeTexts(input: {
  readonly lang: EmailLang;
  readonly kind: SaleNoticeKind;
  readonly product: string | null;
  readonly amount: string;
  readonly buyer: string | null;
  readonly heldForTaxData: boolean;
}): Texts {
  const { kind, amount } = input;
  if (input.lang === 'pt') {
    const item = input.product
      ? `“${input.product}”`
      : kind === 'course'
        ? 'um curso'
        : 'sua assinatura';
    const who = input.buyer ?? 'Um aluno';
    const lead =
      kind === 'renewal'
        ? `${who} renovou ${item}: ${amount}.`
        : kind === 'membership'
          ? `${who} entrou em ${item} por ${amount}.`
          : `${who} comprou ${item} por ${amount}.`;
    return {
      subject: `${kind === 'renewal' ? 'Renovação' : 'Nova venda'}: ${item} (${amount})`,
      title:
        kind === 'renewal'
          ? `${item} foi renovada`
          : kind === 'membership'
            ? `Novo membro em ${item}`
            : `Você vendeu ${item}`,
      body:
        `${lead}\n\nEm Vendas você vê quanto vai receber e quando.` +
        (input.heldForTaxData
          ? `\n\nAtenção: enquanto você não completar seus dados fiscais, o dinheiro desta venda fica retido. Leva um minuto: abra Vendas e preencha.`
          : ''),
      cta: 'Ver minhas vendas',
    };
  }
  if (input.lang === 'en') {
    const item = input.product
      ? `"${input.product}"`
      : kind === 'course'
        ? 'a course'
        : 'your membership';
    const who = input.buyer ?? 'A student';
    const lead =
      kind === 'renewal'
        ? `${who} renewed ${item}: ${amount}.`
        : kind === 'membership'
          ? `${who} joined ${item} for ${amount}.`
          : `${who} bought ${item} for ${amount}.`;
    return {
      subject: `${kind === 'renewal' ? 'Renewal' : 'New sale'}: ${item} (${amount})`,
      title:
        kind === 'renewal'
          ? `${item} renewed`
          : kind === 'membership'
            ? `New member in ${item}`
            : `You sold ${item}`,
      body:
        `${lead}\n\nIn Sales you can see what you'll receive and when.` +
        (input.heldForTaxData
          ? `\n\nHeads-up: until you complete your tax details, the money from this sale stays on hold. It only takes a minute: open Sales and fill them in.`
          : ''),
      cta: 'See my sales',
    };
  }
  const item = input.product
    ? `«${input.product}»`
    : kind === 'course'
      ? 'un curso'
      : 'tu membresía';
  const who = input.buyer ?? 'Un alumno';
  const lead =
    kind === 'renewal'
      ? `${who} ha renovado ${item}: ${amount}.`
      : kind === 'membership'
        ? `${who} se ha unido a ${item} por ${amount}.`
        : `${who} ha comprado ${item} por ${amount}.`;
  return {
    subject: `${kind === 'renewal' ? 'Renovación' : 'Nueva venta'}: ${item} (${amount})`,
    title:
      kind === 'renewal'
        ? `Se ha renovado ${item}`
        : kind === 'membership'
          ? `Nuevo miembro en ${item}`
          : `Has vendido ${item}`,
    body:
      `${lead}\n\nEn Ventas tienes lo que te llega y cuándo.` +
      (input.heldForTaxData
        ? `\n\nOjo: hasta que completes tus datos fiscales, el dinero de esta venta se queda retenido. Es un minuto: entra en Ventas y complétalos.`
        : ''),
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

  /**
   * Venta nueva: campana y correo a cada administrador del aula, en su idioma.
   * Respeta sus preferencias de «Sistema» (la campana la filtra el hub; el
   * correo, aquí). La idempotencia (una vez por venta) es de quien llama.
   */
  async saleMade(input: SaleMadeNotice): Promise<void> {
    const { prisma, logger } = this.deps;
    let buyer: string | null = input.buyerEmail;
    try {
      const found = input.buyerEmail
        ? await runAsTenant(input.tenantId, () =>
            prisma.user.findFirst({
              where: {
                tenantId: input.tenantId,
                email: { equals: input.buyerEmail!, mode: 'insensitive' },
                deletedAt: null,
              },
              select: { name: true },
            }),
          )
        : null;
      if (found?.name?.trim()) buyer = found.name.trim();
    } catch {
      // Sin nombre, el correo del alumno.
    }

    const admins = await this.admins(input.tenantId, 'payouts.sale_made');

    // Campana: el hub resuelve el idioma de cada uno y sus preferencias.
    const hub = this.hub();
    if (hub) {
      const amount: NotificationValue = {
        hubValue: 'money',
        cents: input.amount,
        currency: input.currency,
      };
      for (const admin of admins) {
        try {
          await hub.send({
            tenantId: input.tenantId,
            channel: 'in-app',
            templateKey: saleTemplateKey(input.kind),
            to: admin.id,
            variables: {
              saleId: input.saleId,
              product: input.description ?? '—',
              buyer: buyer ?? '',
              amount,
              held: input.heldForTaxData,
            },
            category: 'SYSTEM',
          });
        } catch (err) {
          logger.warn(
            { tenantId: input.tenantId, saleId: input.saleId, err },
            'payouts: la notificación de la venta en la campana no salió',
          );
        }
      }
    }

    // Correo, a quien no lo haya apagado.
    const wanted: CreatorRecipient[] = [];
    for (const admin of admins) {
      if (await this.emailWanted(input.tenantId, admin.id)) wanted.push(admin);
    }
    if (wanted.length === 0) return;
    const timeZone = await this.timeZone(input.tenantId);
    const buyerName = buyer && buyer !== input.buyerEmail ? buyer : null;
    await this.toCreatorRendered(
      input.tenantId,
      'payouts.sale_made',
      (lang, ctx) =>
        buildCreatorSaleEmail(
          ctx.branding,
          creatorSaleData(input, lang, {
            operator: this.deps.operatorName,
            academy: ctx.academy,
            timeZone,
            buyerName,
            salesUrl: ctx.base ? `${ctx.base}/admin/payments` : null,
            footer: ctx.academy ? creatorFooter(lang, this.deps.operatorName, ctx.academy) : null,
          }),
        ),
      wanted,
    );
  }

  /**
   * Reembolso hecho: correo al ALUMNO en su idioma (o el del aula si no tiene
   * cuenta), con la marca y el SMTP de la academia y aspecto de recibo: lo
   * devuelto, lo que pagó, el pedido, a qué tarjeta vuelve y si pierde el
   * acceso. El asunto y el mensaje los puede personalizar el aula
   * (`purchase.refund`); el recibo no. Nunca lanza.
   */
  async refundIssued(input: RefundIssuedNotice): Promise<void> {
    const { prisma, logger, smtpResolver, smtp } = this.deps;
    try {
      if (!smtpResolver || !smtp || !input.buyerEmail) return;
      const buyerEmail = input.buyerEmail;
      const resolved = await smtpResolver.resolve(input.tenantId);
      if (!resolved) {
        logger.warn(
          { tenantId: input.tenantId, refundId: input.refundId },
          'payouts: sin SMTP — el aviso de reembolso al alumno no se envió',
        );
        return;
      }
      const student = await runAsTenant(input.tenantId, () =>
        prisma.user.findFirst({
          where: { tenantId: input.tenantId, email: { equals: buyerEmail, mode: 'insensitive' } },
          select: { email: true, name: true, locale: true, deletedAt: true, status: true },
        }),
      );
      // A una cuenta eliminada o suspendida no se le escribe (como en el hub).
      if (
        student &&
        (student.deletedAt || student.status === 'SUSPENDED' || student.status === 'DEACTIVATED')
      ) {
        return;
      }
      let lang: EmailLang = 'es';
      if (student?.locale?.trim()) {
        lang = toHubTemplateLang(student.locale);
      } else {
        try {
          lang = await runAsTenant(input.tenantId, () =>
            academyLocale(prisma as unknown as AcademyDefaultsPrisma, input.tenantId),
          );
        } catch {
          // Sin poder leerlo, español.
        }
      }
      const base = this.deps.tenantResolver
        ? await this.deps.tenantResolver.resolveTenantWebBaseUrlForBackground(input.tenantId)
        : (process.env['WEB_BASE_URL'] ?? '');
      const branding = await resolveEmailBranding(
        prisma as unknown as BrandingPrisma,
        input.tenantId,
        base,
      );
      const sale = await this.saleForReceipt(input.tenantId, input.saleId);
      const override = await runAsTenant(input.tenantId, () =>
        fetchEmailOverride(
          prisma as unknown as TemplateOverridePrisma,
          input.tenantId,
          'purchase.refund',
          SALE_EMAIL_STORAGE_LOCALE[lang],
        ),
      );
      const contact =
        addressOf(resolved.config.sender?.replyTo) ??
        (resolved.source === 'tenant' || resolved.source === 'tenant_unverified'
          ? addressOf(resolved.config.from)
          : null);
      let method: PaymentMethodView | null = null;
      if (sale?.stripeChargeId && this.deps.chargeMethod) {
        method = await this.deps.chargeMethod(sale.stripeChargeId).catch(() => null);
      }
      const email = buildRefundEmail(
        branding,
        {
          lang,
          timeZone: await this.timeZone(input.tenantId),
          academy: branding.tenantName,
          buyerName: student?.name ?? null,
          buyerEmail: student?.email ?? buyerEmail,
          product: {
            title: input.description,
            kind: input.kind === 'membership' ? 'membership' : 'course',
            imageUrl: sale?.imageUrl ?? null,
          },
          orderRef: sale?.sourceRef ? orderReference(sale.sourceRef) : null,
          refundedAt: new Date(),
          currency: input.currency,
          refunded: input.amount,
          originallyPaid:
            sale && sale.presentmentCurrency.toLowerCase() === input.currency.toLowerCase()
              ? sale.presentmentAmount
              : null,
          full: input.full,
          paymentMethod: method,
          seller: { name: branding.tenantName, legalName: null, contactEmail: contact },
        },
        override,
      );
      const result = await smtp.send(
        resolved.config,
        {
          to: student?.email ?? buyerEmail,
          subject: email.subject,
          text: email.text,
          html: email.html,
        },
        branding.tenantName,
      );
      if (!result.ok) {
        logger.warn(
          { tenantId: input.tenantId, refundId: input.refundId, error: result.error },
          'payouts: el aviso de reembolso al alumno no salió',
        );
      }
    } catch (err) {
      logger.warn(
        { tenantId: input.tenantId, refundId: input.refundId, err },
        'payouts: excepción al avisar al alumno del reembolso',
      );
    }
  }

  /** La venta de un reembolso: pedido, lo que pagó, el cargo y la portada del curso. */
  private async saleForReceipt(
    tenantId: string,
    saleId: string,
  ): Promise<{
    sourceRef: string;
    presentmentAmount: number;
    presentmentCurrency: string;
    stripeChargeId: string;
    imageUrl: string | null;
  } | null> {
    try {
      const sale = await runAsTenant(tenantId, () =>
        this.deps.prisma.modPayoutsSale.findFirst({
          where: { id: saleId, tenantId },
          select: {
            sourceKind: true,
            sourceRef: true,
            presentmentAmount: true,
            presentmentCurrency: true,
            stripeChargeId: true,
          },
        }),
      );
      if (!sale) return null;
      let imageUrl: string | null = null;
      if (sale.sourceKind === 'ORDER') {
        try {
          const order = await runAsTenant(tenantId, () =>
            this.deps.prisma.modBillingOrder.findFirst({
              where: { id: sale.sourceRef, tenantId },
              select: { productId: true },
            }),
          );
          const product = order
            ? await runAsTenant(tenantId, () =>
                this.deps.prisma.modBillingProduct.findFirst({
                  where: { id: order.productId, tenantId },
                  select: { courseId: true },
                }),
              )
            : null;
          const course = product
            ? await runAsTenant(tenantId, () =>
                this.deps.prisma.modCoursesCourse.findFirst({
                  where: { id: product.courseId, tenantId },
                  select: { thumbnailUrl: true },
                }),
              )
            : null;
          imageUrl =
            course?.thumbnailUrl && /^https?:\/\//i.test(course.thumbnailUrl)
              ? course.thumbnailUrl
              : null;
        } catch {
          imageUrl = null;
        }
      }
      return {
        sourceRef: sale.sourceRef,
        presentmentAmount: sale.presentmentAmount,
        presentmentCurrency: sale.presentmentCurrency,
        stripeChargeId: sale.stripeChargeId,
        imageUrl,
      };
    } catch {
      return null;
    }
  }

  /** Zona horaria del aula para las fechas de los correos (por defecto, Madrid). */
  private async timeZone(tenantId: string): Promise<string> {
    try {
      return (
        (await runAsTenant(tenantId, () =>
          academyTimeZone(this.deps.prisma as unknown as AcademyDefaultsPrisma, tenantId),
        )) ?? 'Europe/Madrid'
      );
    } catch {
      return 'Europe/Madrid';
    }
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

  private hub(): NotificationHubLike | null {
    try {
      return this.deps.hub?.() ?? null;
    } catch {
      return null;
    }
  }

  /** Administradores activos del aula (los que reciben los avisos de dinero). */
  private async admins(tenantId: string, kind: string): Promise<CreatorRecipient[]> {
    try {
      return await runAsTenant(tenantId, () =>
        this.deps.prisma.user.findMany({
          where: {
            tenantId,
            deletedAt: null,
            status: 'ACTIVE',
            roles: { some: { role: { name: { in: ADMIN_ROLES } } } },
          },
          select: { id: true, email: true, locale: true },
          orderBy: { createdAt: 'asc' },
          take: MAX_RECIPIENTS,
        }),
      );
    } catch (err) {
      this.deps.logger.warn(
        { tenantId, kind, err },
        'payouts: no se pudo leer a quién avisar en el aula',
      );
      return [];
    }
  }

  /** ¿Quiere este administrador los avisos de «Sistema» por correo? (por defecto, sí). */
  private async emailWanted(tenantId: string, userId: string): Promise<boolean> {
    try {
      const pref = await runAsTenant(tenantId, () =>
        this.deps.prisma.userNotificationPreference.findUnique({
          where: {
            tenantId_userId_category_channel: {
              tenantId,
              userId,
              category: 'SYSTEM',
              channel: 'EMAIL',
            },
          },
          select: { enabled: true },
        }),
      );
      return pref?.enabled ?? true;
    } catch {
      return true;
    }
  }

  /**
   * A los administradores del aula, cada uno en su idioma. Escribe el
   * OPERADOR: su nombre en el remitente, en la cabecera y en la firma, y su
   * SMTP (el global; el del aula si la instalación no tiene). El pie dice de
   * qué academia se trata.
   */
  private async toCreator(
    tenantId: string,
    kind: string,
    texts: (lang: EmailLang) => Texts,
    recipients?: readonly CreatorRecipient[],
  ): Promise<void> {
    await this.toCreatorRendered(
      tenantId,
      kind,
      (lang, ctx) => {
        const t = texts(lang);
        const { html, text } = renderBrandedEmail(ctx.branding, {
          lang,
          title: t.title,
          bodyHtml: textToHtmlParagraphs(t.body),
          bodyText: t.body,
          ...(ctx.base ? { cta: { label: t.cta, url: `${ctx.base}/admin/payments` } } : {}),
          ...(ctx.academy
            ? { footerNote: creatorFooter(lang, this.deps.operatorName, ctx.academy) }
            : {}),
        });
        return { subject: t.subject, html, text };
      },
      recipients,
    );
  }

  /** Igual que `toCreator`, con el correo ya compuesto por idioma. */
  private async toCreatorRendered(
    tenantId: string,
    kind: string,
    compose: (
      lang: EmailLang,
      ctx: { branding: EmailBranding; base: string; academy: string },
    ) => RenderedEmail,
    recipients?: readonly CreatorRecipient[],
  ): Promise<void> {
    const { prisma, logger, smtpResolver, smtp, operatorName } = this.deps;
    try {
      if (!smtpResolver || !smtp) return;
      const resolved = smtpResolver.resolveGlobal() ?? (await smtpResolver.resolve(tenantId));
      if (!resolved) {
        logger.warn({ tenantId, kind }, 'payouts: sin SMTP — aviso al creador no enviado');
        return;
      }
      const admins = recipients ?? (await this.admins(tenantId, kind));
      if (admins.length === 0) return;
      const rawBase = this.deps.tenantResolver
        ? await this.deps.tenantResolver.resolveTenantWebBaseUrlForBackground(tenantId)
        : (process.env['WEB_BASE_URL'] ?? '');
      const base = rawBase.replace(/\/+$/, '');
      let academy = '';
      try {
        const tenant = await runAsTenant(tenantId, () =>
          prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
        );
        academy = tenant?.name ?? '';
      } catch {
        // Sin el nombre del aula, el pie no la nombra.
      }
      const branding: EmailBranding = {
        tenantName: operatorName,
        logoUrl: null,
        brandColor: OPERATOR_BRAND_COLOR,
      };
      for (const admin of admins) {
        // Inglés y portugués con su copy; cualquier otro idioma, español.
        const lang: EmailLang = toHubTemplateLang(admin.locale);
        const email = compose(lang, { branding, base, academy });
        const result = await smtp.send(
          resolved.config,
          { to: admin.email, subject: email.subject, text: email.text, html: email.html },
          operatorName,
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

/** La dirección de un remitente «Nombre <correo>» o un correo suelto. */
function addressOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angle = /<([^>]+)>/.exec(raw);
  const value = (angle ? angle[1]! : raw).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

/**
 * Datos del aviso de venta a la creadora a partir de lo que trae el módulo de
 * cobros. Puro: lo fijan los tests. Dice lo que se sabe y, lo que aún no (la
 * comisión de la tarjeta antes de que el banco confirme), lo deja «calculando»
 * en vez de inventarlo.
 */
export function creatorSaleData(
  input: SaleMadeNotice,
  lang: EmailLang,
  ctx: {
    readonly operator: string;
    readonly academy: string;
    readonly timeZone: string;
    readonly buyerName: string | null;
    readonly salesUrl: string | null;
    readonly footer: string | null;
  },
): CreatorSaleData {
  const split = input.split ?? null;
  const feeKnown = split?.stripeFee !== null && split?.stripeFee !== undefined;
  const youReceive = !feeKnown
    ? null
    : (split!.transferAmount ??
      (split!.creatorNet !== null ? split!.creatorNet - split!.debtNetted : null));
  const status: CreatorSaleData['status'] = input.heldForTaxData
    ? 'held_tax_data'
    : !split
      ? 'pending'
      : split.status === 'SETTLED_NETTED'
        ? 'netted'
        : split.status === 'HELD' || split.status === 'FAILED'
          ? 'held'
          : (split.status === 'READY' || split.status === 'TRANSFERRED') && split.estimatedArrival
            ? 'arrival'
            : split.status === 'TRANSFERRED'
              ? 'sent'
              : 'pending';
  return {
    lang,
    timeZone: ctx.timeZone,
    operator: ctx.operator,
    academy: ctx.academy,
    kind: input.kind,
    product: input.description,
    buyerName: ctx.buyerName,
    buyerEmail: input.buyerEmail,
    orderRef: input.sourceRef ? orderReference(input.sourceRef) : null,
    paidAt: input.chargedAt ?? new Date(),
    presentmentAmount: input.amount,
    presentmentCurrency: input.currency,
    settlementCurrency: split?.currency ?? null,
    gross: split?.gross ?? null,
    cardFee: split?.stripeFee ?? null,
    operatorFee: split?.platformFee ?? null,
    feeBps: split?.feeBpsApplied ?? split?.currentFeeBps ?? null,
    debtNetted: split?.debtNetted ?? 0,
    youReceive,
    status,
    arrival: split?.estimatedArrival ?? null,
    texts: saleMadeTexts({
      lang,
      kind: input.kind,
      product: input.description,
      amount: formatMinor(input.amount, input.currency, lang),
      buyer: ctx.buyerName ?? input.buyerEmail,
      heldForTaxData: input.heldForTaxData,
    }),
    salesUrl: ctx.salesUrl,
    footer: ctx.footer,
  };
}
