/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  renderBrandedEmail,
  type EmailBranding,
  type EmailLang,
  type EmailSection,
  type EmailSummaryRow,
} from '../../common/branded-email';
import { formatDay, formatDayTime, formatMinor } from '../../common/money-format';
import { CREATOR_SALE_COPY, SALE_EMAIL_COPY, fill, type SaleEmailCopy } from './sale-email-copy';
import {
  SALE_EMAIL_DEFAULTS,
  creatorTextToHtml,
  fillSaleTemplate,
  sanitizeBody,
  sanitizeSubject,
  type SaleEmailKey,
  type SaleEmailValues,
  type SaleTemplateText,
} from './sale-email-templates';

/**
 * Composers PUROS de los correos de venta y acceso: reciben los datos ya
 * reunidos (el servicio los busca en la base y en Stripe) y devuelven asunto,
 * HTML y texto. Sin E/S: los fijan los tests en los tres idiomas.
 *
 * Todos van con la maqueta común (`renderBrandedEmail`) y la marca del aula,
 * salvo el aviso de venta a la creadora, que firma el operador.
 */

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Lo que el creador escribió para este correo e idioma (sin interpolar). */
export interface SaleTemplateOverride {
  readonly subject: string | null;
  readonly body: string;
}

export interface PaymentMethodView {
  /** `card`, `sepa_debit`, `paypal`, `link`… (tipo de Stripe). */
  readonly type: string;
  readonly brand?: string | null;
  readonly last4?: string | null;
  /** `apple_pay`, `google_pay`… si la tarjeta iba en un monedero. */
  readonly wallet?: string | null;
}

export interface SellerView {
  readonly name: string;
  readonly legalName: string | null;
  readonly contactEmail: string | null;
}

export type ProductKind = 'course' | 'membership' | 'course_subscription';

export interface ProductView {
  readonly title: string | null;
  readonly kind: ProductKind;
  /** Meses entre cobros de una suscripción (1 = mensual, 12 = anual). */
  readonly intervalMonths?: number | null;
  /** `week` cuando la suscripción es semanal (Stripe). */
  readonly intervalUnit?: 'week' | 'month' | 'year' | null;
  readonly imageUrl?: string | null;
}

export type AccessView =
  | { readonly kind: 'set_password'; readonly url: string }
  | { readonly kind: 'course'; readonly url: string }
  | { readonly kind: 'academy'; readonly url: string };

/** Datos del recibo de una compra (curso, alta en membresía o prueba gratis). */
export interface PurchaseReceiptData {
  readonly lang: EmailLang;
  readonly timeZone: string;
  readonly academy: string;
  readonly buyerName: string | null;
  readonly buyerEmail: string;
  readonly product: ProductView;
  readonly orderRef: string;
  readonly paidAt: Date;
  readonly currency: string;
  /** Importes en la unidad mínima de Stripe. */
  readonly subtotal: number | null;
  readonly discount: number;
  readonly tax: number;
  readonly total: number;
  readonly paymentMethod: PaymentMethodView | null;
  /** Prueba gratis: cuándo es el primer cobro y de cuánto. */
  readonly trial: { readonly endsAt: Date | null; readonly amount: number | null } | null;
  /** Suscripción pagada: cuándo se renueva y por cuánto. */
  readonly nextRenewal: { readonly at: Date; readonly amount: number | null } | null;
  readonly seller: SellerView;
  readonly withdrawal: {
    readonly acceptedAt: Date;
    readonly text: string;
    readonly version: string;
  } | null;
  readonly refundPolicyUrl: string | null;
  readonly access: AccessView | null;
}

const BRAND_NAMES: Readonly<Record<string, string>> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  american_express: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  cartes_bancaires: 'Cartes Bancaires',
  eftpos_au: 'eftpos',
};

const WALLET_NAMES: Readonly<Record<string, string>> = {
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  samsung_pay: 'Samsung Pay',
  link: 'Link',
};

const METHOD_NAMES: Readonly<Record<string, string>> = {
  paypal: 'PayPal',
  link: 'Link',
  bizum: 'Bizum',
  klarna: 'Klarna',
  ideal: 'iDEAL',
  bancontact: 'Bancontact',
  pix: 'Pix',
  boleto: 'Boleto',
  revolut_pay: 'Revolut Pay',
};

function capitalize(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1).replace(/_/g, ' ') : word;
}

/** Medio de pago de un cargo de Stripe (`payment_method_details`). */
export function paymentMethodFromCharge(charge: unknown): PaymentMethodView | null {
  const details = (charge as { payment_method_details?: Record<string, unknown> } | null)
    ?.payment_method_details;
  if (!details || typeof details !== 'object') return null;
  const type = typeof details['type'] === 'string' ? (details['type'] as string) : null;
  if (!type) return null;
  const inner = (details[type] ?? {}) as {
    brand?: string;
    last4?: string;
    wallet?: { type?: string } | null;
  };
  return {
    type,
    brand: inner.brand ?? null,
    last4: inner.last4 ?? null,
    wallet: inner.wallet?.type ?? null,
  };
}

/** «Visa ···· 4242», «Mastercard ···· 4444 (Apple Pay)», «PayPal». */
export function paymentMethodLabel(
  method: PaymentMethodView | null,
  lang: EmailLang,
): string | null {
  if (!method) return null;
  const last4 = method.last4?.replace(/\D/g, '').slice(-4) || null;
  if (method.type === 'card') {
    const brand = BRAND_NAMES[(method.brand ?? '').toLowerCase()] ?? capitalize(method.brand ?? '');
    const base = [brand || null, last4 ? `···· ${last4}` : null].filter(Boolean).join(' ');
    const wallet = method.wallet
      ? (WALLET_NAMES[method.wallet] ?? capitalize(method.wallet))
      : null;
    if (!base) return wallet;
    return wallet ? `${base} (${wallet})` : base;
  }
  if (method.type === 'sepa_debit') {
    const name = SALE_EMAIL_COPY[lang].sepaDebit;
    return last4 ? `${name} ···· ${last4}` : name;
  }
  const name = METHOD_NAMES[method.type] ?? capitalize(method.type);
  return last4 ? `${name} ···· ${last4}` : name;
}

/**
 * Referencia corta del pedido, la misma para el comprador y para la creadora:
 * los 8 últimos caracteres alfanuméricos del id de la orden (curso) o de la
 * factura de Stripe (suscripción), en mayúsculas. «3F2A9C1B».
 */
export function orderReference(id: string | null | undefined): string {
  const clean = (id ?? '').replace(/[^A-Za-z0-9]/g, '');
  return clean.slice(-8).toUpperCase();
}

function intervalLabel(copy: SaleEmailCopy, product: ProductView): string | null {
  if (product.intervalUnit === 'week') return copy.intervalWeek;
  const months =
    product.intervalUnit === 'year' ? 12 * (product.intervalMonths ?? 1) : product.intervalMonths;
  if (!months || months <= 0) return null;
  if (months === 1) return copy.intervalMonth;
  if (months === 3) return copy.intervalQuarter;
  if (months === 6) return copy.intervalHalf;
  if (months === 12) return copy.intervalYear;
  return fill(copy.intervalMonths, { n: months });
}

/** «Curso · pago único», «Membresía · mensual», «Curso · suscripción anual». */
export function productKindLabel(product: ProductView, lang: EmailLang): string {
  const copy = SALE_EMAIL_COPY[lang];
  if (product.kind === 'course') return copy.kindCourse;
  const interval = intervalLabel(copy, product);
  const template =
    product.kind === 'membership' ? copy.kindMembership : copy.kindCourseSubscription;
  if (!interval) {
    // Sin periodicidad conocida, solo el tipo: «Membresía», «Curso».
    return template.split(' · ')[0]!;
  }
  return fill(template, { interval });
}

/** Primer nombre del comprador para el saludo («Ana García» → «Ana»). */
export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

/**
 * Asunto y mensaje del creador (o los originales) ya rellenos y saneados.
 * Un asunto vacío tras sanear cae al original: un correo nunca sale sin asunto.
 */
export function composeEditable(
  key: SaleEmailKey,
  lang: EmailLang,
  values: SaleEmailValues,
  override: SaleTemplateOverride | null,
): { subject: string; bodyText: string; bodyHtml: string } {
  const original: SaleTemplateText = SALE_EMAIL_DEFAULTS[key][lang];
  const subjectSource = override?.subject?.trim() ? override.subject : original.subject;
  const bodySource = override?.body?.trim() ? override.body : original.body;
  let subject = sanitizeSubject(fillSaleTemplate(subjectSource, values));
  if (!subject) subject = sanitizeSubject(fillSaleTemplate(original.subject, values));
  const bodyText = sanitizeBody(fillSaleTemplate(bodySource, values));
  return { subject, bodyText, bodyHtml: creatorTextToHtml(bodyText) };
}

function money(amount: number, currency: string, lang: EmailLang): string {
  return formatMinor(amount, currency, lang);
}

function sellerSection(copy: SaleEmailCopy, seller: SellerView): EmailSection {
  return {
    heading: copy.soldBy,
    lines: [
      seller.name,
      ...(seller.legalName && seller.legalName.toLowerCase() !== seller.name.toLowerCase()
        ? [fill(copy.legalName, { name: seller.legalName })]
        : []),
      ...(seller.contactEmail ? [fill(copy.contact, { email: seller.contactEmail })] : []),
    ],
  };
}

function safeUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

/**
 * Recibo de una COMPRA: lo recibe el comprador al pagar (o al empezar una
 * prueba gratis). Lleva el acceso (elegir contraseña o entrar), el recibo
 * completo, el vendedor, la renuncia al desistimiento que aceptó y la
 * política de devoluciones.
 */
export function buildPurchaseReceiptEmail(
  branding: EmailBranding,
  data: PurchaseReceiptData,
  override: SaleTemplateOverride | null = null,
): RenderedEmail {
  const { lang } = data;
  const copy = SALE_EMAIL_COPY[lang];
  const productTitle = data.product.title?.trim() || copy.fallbackProduct;
  const total = money(data.total, data.currency, lang);
  const day = formatDay(data.paidAt, lang, data.timeZone);
  const method = paymentMethodLabel(data.paymentMethod, lang);

  const values: SaleEmailValues = {
    name: firstName(data.buyerName),
    product: productTitle,
    amount: total,
    order: data.orderRef,
    date: day,
    academy: data.academy,
    email: data.buyerEmail,
  };
  const editable = composeEditable('purchase.receipt', lang, values, override);

  const rows: EmailSummaryRow[] = [];
  const subtotal = data.subtotal ?? data.total + data.discount - data.tax;
  if (data.discount > 0 || data.tax > 0) {
    rows.push({ label: copy.subtotal, value: money(subtotal, data.currency, lang) });
  }
  if (data.discount > 0) {
    rows.push({ label: copy.discount, value: `−${money(data.discount, data.currency, lang)}` });
  }
  if (data.tax > 0) {
    rows.push({ label: copy.tax, value: money(data.tax, data.currency, lang) });
  }
  rows.push({ label: data.trial ? copy.totalToday : copy.totalPaid, value: total, total: true });

  const notes: string[] = [];
  if (data.tax <= 0) notes.push(copy.taxIncluded);
  if (data.trial?.endsAt && data.trial.amount !== null && data.trial.amount !== undefined) {
    notes.push(
      fill(copy.trialFirstCharge, {
        date: formatDay(data.trial.endsAt, lang, data.timeZone),
        amount: money(data.trial.amount, data.currency, lang),
      }),
    );
  } else if (data.nextRenewal && data.nextRenewal.amount !== null) {
    notes.push(
      fill(copy.nextRenewal, {
        date: formatDay(data.nextRenewal.at, lang, data.timeZone),
        amount: money(data.nextRenewal.amount, data.currency, lang),
      }),
    );
  }

  const sections: EmailSection[] = [sellerSection(copy, data.seller)];
  const policy = safeUrl(data.refundPolicyUrl);
  if (data.withdrawal) {
    sections.push({
      heading: copy.withdrawalHeading,
      lines: [
        fill(copy.withdrawalLead, {
          date: formatDayTime(data.withdrawal.acceptedAt, lang, data.timeZone),
        }),
        fill(copy.withdrawalQuote, { text: data.withdrawal.text }),
        fill(copy.withdrawalEffect, { version: data.withdrawal.version }),
      ],
      ...(policy ? { link: { label: copy.refundPolicy, url: policy } } : {}),
    });
  } else if (policy) {
    sections.push({
      heading: copy.refundPolicy,
      lines: [],
      link: { label: copy.refundPolicy, url: policy },
    });
  }

  const cta = accessCta(copy, data.access, data.academy, data.buyerEmail);

  const { html, text } = renderBrandedEmail(branding, {
    lang,
    title: '',
    bodyHtml: editable.bodyHtml,
    bodyText: editable.bodyText,
    preheader: `${data.trial ? copy.trialNote : fill(copy.paidOn, { date: day })} · ${total} · ${productTitle}`,
    hero: {
      eyebrow: fill(copy.receiptEyebrow, { academy: data.academy }),
      amount: total,
      amountNote: data.trial ? copy.trialNote : fill(copy.paidOn, { date: day }),
      facts: [
        { label: copy.factOrder, value: data.orderRef },
        { label: copy.factDate, value: day },
        ...(method ? [{ label: copy.factMethod, value: method }] : []),
      ],
    },
    ...(cta ? { cta: cta.button, ctaNote: cta.note } : {}),
    summary: {
      heading: copy.summaryHeading,
      item: {
        title: productTitle,
        subtitle: productKindLabel(data.product, lang),
        imageUrl: safeUrl(data.product.imageUrl),
        amount: money(subtotal, data.currency, lang),
      },
      rows,
      notes,
    },
    sections,
    signature: false,
    footerNote: fill(copy.whyPurchase, { academy: data.academy }),
    finePrint: [copy.notInvoice, copy.securePayment],
  });
  return { subject: editable.subject, html, text };
}

function accessCta(
  copy: SaleEmailCopy,
  access: AccessView | null,
  academy: string,
  email: string,
): { button: { url: string; label: string }; note: string } | null {
  if (!access || !safeUrl(access.url)) return null;
  if (access.kind === 'set_password') {
    return {
      button: { url: access.url, label: copy.ctaSetPassword },
      note: fill(copy.ctaSetPasswordNote, { email }),
    };
  }
  return {
    button: {
      url: access.url,
      label: access.kind === 'course' ? copy.ctaCourse : fill(copy.ctaAcademy, { academy }),
    },
    note: fill(copy.ctaEnterNote, { email }),
  };
}

/** Datos del recibo de una RENOVACIÓN (cada cobro periódico de una suscripción). */
export interface RenewalReceiptData {
  readonly lang: EmailLang;
  readonly timeZone: string;
  readonly academy: string;
  readonly buyerName: string | null;
  readonly buyerEmail: string;
  readonly product: ProductView;
  readonly orderRef: string;
  readonly paidAt: Date;
  readonly currency: string;
  readonly subtotal: number | null;
  readonly discount: number;
  readonly tax: number;
  readonly total: number;
  readonly paymentMethod: PaymentMethodView | null;
  readonly nextRenewal: Date | null;
  readonly seller: SellerView;
  readonly refundPolicyUrl: string | null;
  /** «Gestionar mi suscripción» (la cuenta del alumno en el aula). */
  readonly manageUrl: string | null;
  readonly academyUrl: string | null;
}

export function buildRenewalReceiptEmail(
  branding: EmailBranding,
  data: RenewalReceiptData,
  override: SaleTemplateOverride | null = null,
): RenderedEmail {
  const { lang } = data;
  const copy = SALE_EMAIL_COPY[lang];
  const productTitle = data.product.title?.trim() || copy.fallbackProduct;
  const total = money(data.total, data.currency, lang);
  const day = formatDay(data.paidAt, lang, data.timeZone);
  const next = data.nextRenewal ? formatDay(data.nextRenewal, lang, data.timeZone) : '';
  const method = paymentMethodLabel(data.paymentMethod, lang);
  const values: SaleEmailValues = {
    name: firstName(data.buyerName),
    product: productTitle,
    amount: total,
    order: data.orderRef,
    date: day,
    academy: data.academy,
    email: data.buyerEmail,
    nextDate: next,
  };
  const editable = composeEditable('purchase.renewal_receipt', lang, values, override);
  const subtotal = data.subtotal ?? data.total + data.discount - data.tax;
  const rows: EmailSummaryRow[] = [];
  if (data.discount > 0 || data.tax > 0) {
    rows.push({ label: copy.subtotal, value: money(subtotal, data.currency, lang) });
  }
  if (data.discount > 0) {
    rows.push({ label: copy.discount, value: `−${money(data.discount, data.currency, lang)}` });
  }
  if (data.tax > 0) rows.push({ label: copy.tax, value: money(data.tax, data.currency, lang) });
  rows.push({ label: copy.totalPaid, value: total, total: true });

  const sections: EmailSection[] = [];
  const manage = safeUrl(data.manageUrl);
  if (next || manage) {
    sections.push({
      heading: copy.subscriptionHeading,
      lines: next ? [fill(copy.nextRenewalShort, { date: next })] : [],
      ...(manage ? { link: { label: copy.manageSubscription, url: manage } } : {}),
    });
  }
  sections.push(sellerSection(copy, data.seller));
  const policy = safeUrl(data.refundPolicyUrl);
  if (policy) {
    sections.push({
      heading: copy.refundPolicy,
      lines: [],
      link: { label: copy.refundPolicy, url: policy },
    });
  }
  const academyUrl = safeUrl(data.academyUrl);

  const { html, text } = renderBrandedEmail(branding, {
    lang,
    title: '',
    bodyHtml: editable.bodyHtml,
    bodyText: editable.bodyText,
    preheader: `${fill(copy.paidOn, { date: day })} · ${total} · ${productTitle}`,
    hero: {
      eyebrow: fill(copy.receiptEyebrow, { academy: data.academy }),
      amount: total,
      amountNote: fill(copy.paidOn, { date: day }),
      facts: [
        { label: copy.factOrder, value: data.orderRef },
        { label: copy.factDate, value: day },
        ...(method ? [{ label: copy.factMethod, value: method }] : []),
      ],
    },
    ...(academyUrl
      ? {
          cta: { url: academyUrl, label: fill(copy.ctaAcademy, { academy: data.academy }) },
        }
      : {}),
    summary: {
      heading: copy.summaryHeading,
      item: {
        title: productTitle,
        subtitle: productKindLabel(data.product, lang),
        imageUrl: safeUrl(data.product.imageUrl),
        amount: money(subtotal, data.currency, lang),
      },
      rows,
      notes: data.tax <= 0 ? [copy.taxIncluded] : [],
    },
    sections,
    signature: false,
    footerNote: fill(copy.whySubscription, { academy: data.academy }),
    finePrint: [copy.notInvoice, copy.securePayment],
  });
  return { subject: editable.subject, html, text };
}

/** Datos del aviso de PAGO FALLIDO de una renovación. */
export interface PaymentFailedData {
  readonly lang: EmailLang;
  readonly timeZone: string;
  readonly academy: string;
  readonly buyerName: string | null;
  readonly buyerEmail: string;
  readonly product: ProductView;
  readonly failedAt: Date;
  readonly currency: string;
  readonly amountDue: number;
  readonly paymentMethod: PaymentMethodView | null;
  /** Hasta cuándo conserva el acceso (fin de la gracia), si se sabe. */
  readonly deadline: Date | null;
  /** Siguiente intento automático de Stripe, si lo hay. */
  readonly nextAttempt: Date | null;
  readonly seller: SellerView;
  /** Donde se actualiza la tarjeta. */
  readonly updateUrl: string | null;
}

export function buildPaymentFailedEmail(
  branding: EmailBranding,
  data: PaymentFailedData,
  override: SaleTemplateOverride | null = null,
): RenderedEmail {
  const { lang } = data;
  const copy = SALE_EMAIL_COPY[lang];
  const productTitle = data.product.title?.trim() || copy.fallbackProduct;
  const amount = money(data.amountDue, data.currency, lang);
  const day = formatDay(data.failedAt, lang, data.timeZone);
  const deadline = data.deadline ? formatDay(data.deadline, lang, data.timeZone) : '';
  const method = paymentMethodLabel(data.paymentMethod, lang);
  const values: SaleEmailValues = {
    name: firstName(data.buyerName),
    product: productTitle,
    amount,
    date: day,
    academy: data.academy,
    email: data.buyerEmail,
    deadline,
  };
  const editable = composeEditable('purchase.payment_failed', lang, values, override);
  const notes = [
    deadline ? fill(copy.failedDeadline, { date: deadline }) : copy.failedNoDeadline,
    ...(data.nextAttempt
      ? [fill(copy.failedRetry, { date: formatDay(data.nextAttempt, lang, data.timeZone) })]
      : []),
  ];
  const update = safeUrl(data.updateUrl);
  const { html, text } = renderBrandedEmail(branding, {
    lang,
    title: '',
    bodyHtml: editable.bodyHtml,
    bodyText: editable.bodyText,
    preheader: `${fill(copy.failedOn, { date: day })} · ${amount} · ${productTitle}`,
    hero: {
      eyebrow: fill(copy.failedEyebrow, { academy: data.academy }),
      amount,
      amountNote: fill(copy.failedOn, { date: day }),
      facts: [
        { label: copy.factDate, value: day },
        ...(method ? [{ label: copy.factMethod, value: method }] : []),
      ],
    },
    ...(update ? { cta: { url: update, label: copy.ctaUpdateCard } } : {}),
    summary: {
      heading: copy.failedSummaryHeading,
      item: {
        title: productTitle,
        subtitle: productKindLabel(data.product, lang),
        imageUrl: safeUrl(data.product.imageUrl),
      },
      rows: [{ label: copy.amountDue, value: amount, total: true }],
      notes,
    },
    sections: [sellerSection(copy, data.seller)],
    signature: false,
    footerNote: fill(copy.whySubscription, { academy: data.academy }),
  });
  return { subject: editable.subject, html, text };
}

/** Datos del aviso de REEMBOLSO al alumno. */
export interface RefundData {
  readonly lang: EmailLang;
  readonly timeZone: string;
  readonly academy: string;
  readonly buyerName: string | null;
  readonly buyerEmail: string;
  readonly product: ProductView;
  readonly orderRef: string | null;
  readonly refundedAt: Date;
  readonly currency: string;
  readonly refunded: number;
  /** Lo que pagó en su día (para ver si es todo o parte). */
  readonly originallyPaid: number | null;
  readonly full: boolean;
  readonly paymentMethod: PaymentMethodView | null;
  readonly seller: SellerView;
}

export function buildRefundEmail(
  branding: EmailBranding,
  data: RefundData,
  override: SaleTemplateOverride | null = null,
): RenderedEmail {
  const { lang } = data;
  const copy = SALE_EMAIL_COPY[lang];
  const productTitle = data.product.title?.trim() || copy.fallbackProduct;
  const refunded = money(data.refunded, data.currency, lang);
  const day = formatDay(data.refundedAt, lang, data.timeZone);
  const method = paymentMethodLabel(data.paymentMethod, lang);
  const values: SaleEmailValues = {
    name: firstName(data.buyerName),
    product: productTitle,
    amount: refunded,
    order: data.orderRef ?? '',
    date: day,
    academy: data.academy,
    email: data.buyerEmail,
  };
  const editable = composeEditable('purchase.refund', lang, values, override);
  const rows: EmailSummaryRow[] = [];
  if (data.originallyPaid !== null && data.originallyPaid !== data.refunded) {
    rows.push({ label: copy.youPaid, value: money(data.originallyPaid, data.currency, lang) });
  }
  rows.push({ label: copy.refunded, value: refunded, total: true });
  const access =
    data.product.kind === 'course'
      ? [data.full ? copy.refundAccessGone : copy.refundAccessKept]
      : [];
  const { html, text } = renderBrandedEmail(branding, {
    lang,
    title: '',
    bodyHtml: editable.bodyHtml,
    bodyText: editable.bodyText,
    preheader: `${fill(copy.refundedOn, { date: day })} · ${refunded} · ${productTitle}`,
    hero: {
      eyebrow: fill(copy.refundEyebrow, { academy: data.academy }),
      amount: refunded,
      amountNote: fill(copy.refundedOn, { date: day }),
      facts: [
        ...(data.orderRef ? [{ label: copy.factOrder, value: data.orderRef }] : []),
        { label: copy.factDate, value: day },
        ...(method ? [{ label: copy.refundedTo, value: method }] : []),
      ],
    },
    summary: {
      heading: copy.refundSummaryHeading,
      item: {
        title: productTitle,
        subtitle: productKindLabel(data.product, lang),
        imageUrl: safeUrl(data.product.imageUrl),
      },
      rows,
      notes: [copy.refundArrival, ...access],
    },
    sections: [sellerSection(copy, data.seller)],
    signature: false,
    footerNote: fill(copy.whyPurchase, { academy: data.academy }),
  });
  return { subject: editable.subject, html, text };
}

/** Datos del aviso de VENTA a quien administra el aula. */
export interface CreatorSaleData {
  readonly lang: EmailLang;
  readonly timeZone: string;
  readonly operator: string;
  readonly academy: string;
  readonly kind: 'course' | 'membership' | 'renewal';
  readonly product: string | null;
  readonly buyerName: string | null;
  readonly buyerEmail: string | null;
  readonly orderRef: string | null;
  readonly paidAt: Date;
  /** Lo que pagó el alumno, en su divisa. */
  readonly presentmentAmount: number;
  readonly presentmentCurrency: string;
  /** El reparto, en la divisa de liquidación (null mientras no se conoce). */
  readonly settlementCurrency: string | null;
  readonly gross: number | null;
  readonly cardFee: number | null;
  readonly operatorFee: number | null;
  readonly feeBps: number | null;
  readonly debtNetted: number;
  readonly youReceive: number | null;
  readonly status: 'pending' | 'arrival' | 'sent' | 'netted' | 'held_tax_data' | 'held';
  readonly arrival: Date | null;
  /** Título, entrada y botón (los textos de siempre del aviso). */
  readonly texts: { subject: string; title: string; body: string; cta: string };
  readonly salesUrl: string | null;
  readonly footer: string | null;
}

/** «5», «2,5», «2.5» según el idioma. */
function percentLabel(bps: number, lang: EmailLang): string {
  const pct = bps / 100;
  return Number.isInteger(pct)
    ? String(pct)
    : pct
        .toFixed(2)
        .replace(/0+$/, '')
        .replace('.', lang === 'en' ? '.' : ',');
}

export function buildCreatorSaleEmail(
  branding: EmailBranding,
  data: CreatorSaleData,
): RenderedEmail {
  const { lang } = data;
  const copy = CREATOR_SALE_COPY[lang];
  const base = SALE_EMAIL_COPY[lang];
  const paid = money(data.presentmentAmount, data.presentmentCurrency, lang);
  const day = formatDay(data.paidAt, lang, data.timeZone);
  const settle = data.settlementCurrency ?? data.presentmentCurrency;
  const rows: EmailSummaryRow[] = [{ label: copy.paidByStudent, value: paid }];
  if (
    data.gross !== null &&
    data.settlementCurrency &&
    data.settlementCurrency.toLowerCase() !== data.presentmentCurrency.toLowerCase()
  ) {
    rows.push({
      label: fill(copy.receivedIn, { currency: data.settlementCurrency.toUpperCase() }),
      value: money(data.gross, settle, lang),
    });
  }
  rows.push({
    label: copy.cardFee,
    value: data.cardFee !== null ? `−${money(data.cardFee, settle, lang)}` : copy.pendingValue,
  });
  if (data.feeBps !== null || data.operatorFee !== null) {
    rows.push({
      label: fill(copy.operatorFee, {
        percent: data.feeBps !== null ? percentLabel(data.feeBps, lang) : '—',
        operator: data.operator,
      }),
      value:
        data.operatorFee !== null ? `−${money(data.operatorFee, settle, lang)}` : copy.pendingValue,
    });
  }
  if (data.debtNetted > 0) {
    rows.push({ label: copy.debtNetted, value: `−${money(data.debtNetted, settle, lang)}` });
  }
  rows.push({
    label: copy.youReceive,
    value: data.youReceive !== null ? money(data.youReceive, settle, lang) : copy.pendingValue,
    total: true,
  });

  const when =
    data.status === 'held_tax_data'
      ? copy.whenHeldTaxData
      : data.status === 'held'
        ? copy.whenHeld
        : data.status === 'netted'
          ? copy.whenNetted
          : data.status === 'sent'
            ? copy.whenSent
            : data.status === 'arrival' && data.arrival
              ? fill(copy.whenArrival, { date: formatDay(data.arrival, lang, 'UTC') })
              : copy.whenPending;

  const buyerLines = [data.buyerName, data.buyerEmail].filter(
    (v, i, all): v is string => !!v && all.indexOf(v) === i,
  );
  const eyebrow =
    data.kind === 'renewal'
      ? copy.eyebrowRenewal
      : data.kind === 'membership'
        ? copy.eyebrowMembership
        : copy.eyebrowCourse;
  const salesUrl = safeUrl(data.salesUrl);
  const { html, text } = renderBrandedEmail(branding, {
    lang,
    title: data.texts.title,
    bodyHtml: creatorTextToHtml(data.texts.body),
    bodyText: data.texts.body,
    preheader: `${fill(base.paidOn, { date: day })} · ${paid}`,
    hero: {
      eyebrow: fill(eyebrow, { academy: data.academy }),
      amount: paid,
      amountNote: fill(base.paidOn, { date: day }),
      facts: [
        ...(data.orderRef ? [{ label: base.factOrder, value: data.orderRef }] : []),
        { label: base.factDate, value: day },
        ...(buyerLines[0] ? [{ label: copy.factBuyer, value: buyerLines[0] }] : []),
      ],
    },
    ...(salesUrl ? { cta: { url: salesUrl, label: data.texts.cta } } : {}),
    summary: {
      heading: copy.breakdownHeading,
      item: {
        title: data.product?.trim() || base.fallbackProduct,
        subtitle: data.kind === 'course' ? base.kindCourse : base.kindMembership.split(' · ')[0]!,
      },
      rows,
      notes: data.cardFee === null ? [copy.feesPending] : [],
    },
    sections: [
      { heading: copy.whenHeading, lines: [when] },
      ...(buyerLines.length ? [{ heading: copy.buyerHeading, lines: buyerLines }] : []),
    ],
    ...(data.footer ? { footerNote: data.footer } : {}),
  });
  return { subject: data.texts.subject, html, text };
}

/** Por si el composer necesita el texto ORIGINAL de un correo (vista del editor). */
export function originalTemplate(key: SaleEmailKey, lang: EmailLang): SaleTemplateText {
  return SALE_EMAIL_DEFAULTS[key][lang];
}

export { sanitizeBody, sanitizeSubject };
