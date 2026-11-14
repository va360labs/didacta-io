/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Correos de VENTA con aspecto de recibo: el de cada compra, el de cada
 * renovación, el aviso de cobro fallido, el reembolso y el aviso de venta a la
 * creadora. Que cada uno sale en los tres idiomas sin mezclar, que las
 * variables del creador funcionan en cualquier idioma, que lo que escribe el
 * creador se sanea y que el recibo (pedido, importe, vendedor, desistimiento)
 * no se puede quitar por mucho que cambie el texto.
 */

import { describe, expect, it, vi } from 'vitest';
import type { EmailBranding, EmailLang } from '../src/common/branded-email';
import { renderBrandedEmail, readableTextOn } from '../src/common/branded-email';
import {
  buildCreatorSaleEmail,
  buildPaymentFailedEmail,
  buildPurchaseReceiptEmail,
  buildRefundEmail,
  buildRenewalReceiptEmail,
  orderReference,
  paymentMethodFromCharge,
  paymentMethodLabel,
  productKindLabel,
  type CreatorSaleData,
  type PaymentFailedData,
  type PurchaseReceiptData,
  type RefundData,
  type RenewalReceiptData,
} from '../src/modules/sale-emails/sale-email-render';
import {
  SALE_EMAIL_DEFAULTS,
  SALE_EMAIL_KEYS,
  SALE_EMAIL_TEMPLATE_VARIABLES,
  SALE_EMAIL_TOKENS,
  creatorTextToHtml,
  fillSaleTemplate,
  sanitizeBody,
  sanitizeSubject,
} from '../src/modules/sale-emails/sale-email-templates';
import { SaleEmailsService } from '../src/modules/sale-emails/sale-emails.service';

const LANGS: readonly EmailLang[] = ['es', 'en', 'pt'];

const BRAND: EmailBranding = {
  tenantName: 'Primer Sorbo',
  logoUrl: 'https://primersorbo.example.com/logo.png',
  brandColor: '#8a4b24',
};

/** Palabras que en un correo inglés o portugués delatan español (y al revés). */
const SPANISH =
  /\b(Pedido nº|Fecha|Método de pago|Resumen del pedido|Vendido por:|Pagado el|Recibes este correo|impuestos incluidos|tu compra)\b|«|»/;
const ENGLISH = /\b(Order summary|Payment method|Paid on|Sold by|Total paid|You are receiving)\b/;

const RECEIPT: PurchaseReceiptData = {
  lang: 'es',
  timeZone: 'Europe/Madrid',
  academy: 'Primer Sorbo',
  buyerName: 'Ana García',
  buyerEmail: 'ana@example.com',
  product: {
    title: 'Iniciación al café de especialidad',
    kind: 'course',
    imageUrl: 'https://primersorbo.example.com/portada.jpg',
  },
  orderRef: '3F2A9C1B',
  paidAt: new Date('2026-11-14T09:30:00Z'),
  currency: 'eur',
  subtotal: 4900,
  discount: 0,
  tax: 0,
  total: 4900,
  paymentMethod: { type: 'card', brand: 'visa', last4: '4242' },
  trial: null,
  nextRenewal: null,
  seller: {
    name: 'Primer Sorbo',
    legalName: 'Lucía Martín',
    contactEmail: 'hola@primersorbo.example.com',
  },
  withdrawal: {
    acceptedAt: new Date('2026-11-14T09:29:00Z'),
    text: 'Quiero acceder al curso ahora mismo. Vende: Primer Sorbo.',
    version: '2026-11-14',
  },
  refundPolicyUrl: 'https://primersorbo.example.com/devoluciones',
  access: { kind: 'set_password', url: 'https://primersorbo.example.com/reset-password?token=abc' },
};

function receiptIn(lang: EmailLang): PurchaseReceiptData {
  return { ...RECEIPT, lang };
}

const RENEWAL: RenewalReceiptData = {
  lang: 'es',
  timeZone: 'Europe/Madrid',
  academy: 'Primer Sorbo',
  buyerName: 'Ana García',
  buyerEmail: 'ana@example.com',
  product: { title: 'Club del café', kind: 'membership', intervalMonths: 1 },
  orderRef: 'IN0001AB',
  paidAt: new Date('2026-12-14T09:30:00Z'),
  currency: 'eur',
  subtotal: 1900,
  discount: 0,
  tax: 0,
  total: 1900,
  paymentMethod: { type: 'card', brand: 'mastercard', last4: '4444' },
  nextRenewal: new Date('2027-01-14T09:30:00Z'),
  seller: { name: 'Primer Sorbo', legalName: null, contactEmail: 'hola@primersorbo.example.com' },
  refundPolicyUrl: null,
  manageUrl: 'https://primersorbo.example.com/account?tab=subscription',
  academyUrl: 'https://primersorbo.example.com',
};

const FAILED: PaymentFailedData = {
  lang: 'es',
  timeZone: 'Europe/Madrid',
  academy: 'Primer Sorbo',
  buyerName: 'Ana García',
  buyerEmail: 'ana@example.com',
  product: { title: 'Club del café', kind: 'membership', intervalMonths: 1 },
  failedAt: new Date('2026-12-14T09:30:00Z'),
  currency: 'eur',
  amountDue: 1900,
  paymentMethod: { type: 'card', brand: 'visa', last4: '0341' },
  deadline: new Date('2026-12-17T09:30:00Z'),
  nextAttempt: new Date('2026-12-16T09:30:00Z'),
  seller: { name: 'Primer Sorbo', legalName: null, contactEmail: null },
  updateUrl: 'https://primersorbo.example.com/account?tab=subscription',
};

const REFUND: RefundData = {
  lang: 'es',
  timeZone: 'Europe/Madrid',
  academy: 'Primer Sorbo',
  buyerName: 'Ana García',
  buyerEmail: 'ana@example.com',
  product: { title: 'Iniciación al café de especialidad', kind: 'course' },
  orderRef: '3F2A9C1B',
  refundedAt: new Date('2026-11-20T09:30:00Z'),
  currency: 'eur',
  refunded: 4900,
  originallyPaid: 4900,
  full: true,
  paymentMethod: { type: 'card', brand: 'visa', last4: '4242' },
  seller: { name: 'Primer Sorbo', legalName: null, contactEmail: null },
};

const CREATOR: CreatorSaleData = {
  lang: 'es',
  timeZone: 'Europe/Madrid',
  operator: 'Didacta',
  academy: 'Primer Sorbo',
  kind: 'course',
  product: 'Iniciación al café de especialidad',
  buyerName: 'Ana García',
  buyerEmail: 'ana@example.com',
  orderRef: '3F2A9C1B',
  paidAt: new Date('2026-11-14T09:30:00Z'),
  presentmentAmount: 4900,
  presentmentCurrency: 'eur',
  settlementCurrency: 'eur',
  gross: 4900,
  cardFee: 99,
  operatorFee: 245,
  feeBps: 500,
  debtNetted: 0,
  youReceive: 4556,
  status: 'arrival',
  arrival: new Date('2026-11-21T00:00:00Z'),
  texts: {
    subject: 'Nueva venta',
    title: 'Has vendido',
    body: 'Ana ha comprado.',
    cta: 'Ver mis ventas',
  },
  salesUrl: 'https://primersorbo.example.com/admin/payments',
  footer: 'Te escribe Didacta porque administras «Primer Sorbo».',
};

describe('recibo de una compra', () => {
  it('es: pedido, fecha, método, producto con portada, total, vendedor, desistimiento y devoluciones', () => {
    const { subject, html, text } = buildPurchaseReceiptEmail(BRAND, RECEIPT);
    expect(subject).toBe('Recibo de tu compra en Primer Sorbo (pedido 3F2A9C1B)');
    // Cabecera de recibo.
    expect(text).toContain('Recibo de Primer Sorbo');
    expect(text).toMatch(/^49,00\s€$/m);
    expect(text).toContain('Pagado el 14 de noviembre de 2026');
    expect(text).toContain('Pedido: 3F2A9C1B');
    expect(text).toContain('Método de pago: Visa ···· 4242');
    // Mensaje (editable) y acceso.
    expect(text).toContain('Hola, Ana:');
    expect(text).toContain('Ya tienes acceso a «Iniciación al café de especialidad».');
    expect(text).toContain(
      'Elige tu contraseña y entra: https://primersorbo.example.com/reset-password?token=abc',
    );
    expect(text).toContain('El botón vale 7 días. Tu usuario es ana@example.com.');
    // Resumen.
    expect(text).toContain('Curso · pago único');
    expect(text).toMatch(/Total pagado: 49,00\s€/);
    expect(text).toContain('Precio final, impuestos incluidos.');
    // Vendedor y legal.
    expect(text).toContain('Nombre fiscal: Lucía Martín');
    expect(text).toContain('Contacto: hola@primersorbo.example.com');
    expect(text).toContain('«Quiero acceder al curso ahora mismo. Vende: Primer Sorbo.»');
    expect(text).toContain('(versión del texto 2026-11-14)');
    expect(text).toContain(
      'Política de devoluciones: https://primersorbo.example.com/devoluciones',
    );
    expect(text).toContain('no una factura');
    // HTML: portada, logo, botón con el color de la marca, mailto y lang.
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('src="https://primersorbo.example.com/portada.jpg"');
    expect(html).toContain('src="https://primersorbo.example.com/logo.png"');
    expect(html).toContain('bgcolor="#8a4b24"');
    expect(html).toContain('href="mailto:hola@primersorbo.example.com"');
    expect(html).toContain('Powered by Didacta');
    // Móvil: la media query que apila las columnas.
    expect(html).toContain('@media only screen and (max-width:620px)');
  });

  it.each(LANGS)('%s: sale entero en su idioma, sin mezclar', (lang) => {
    const { subject, html, text } = buildPurchaseReceiptEmail(BRAND, receiptIn(lang));
    expect(html).toContain(`<html lang="${lang}">`);
    const all = `${subject}\n${text}`;
    if (lang !== 'es') expect(all.replace(/«Quiero[^»]*»/, '')).not.toMatch(SPANISH);
    if (lang !== 'en') expect(all).not.toMatch(ENGLISH);
    if (lang === 'en') {
      expect(subject).toBe('Your receipt from Primer Sorbo (order 3F2A9C1B)');
      expect(text).toContain('Paid on 14 November 2026');
      expect(text).toMatch(/Total paid: €49\.00/);
      expect(text).toContain('Course · one-off payment');
      expect(text).toContain('Choose your password and get in');
    }
    if (lang === 'pt') {
      expect(subject).toBe('Recibo da sua compra em Primer Sorbo (pedido 3F2A9C1B)');
      expect(text).toContain('Pago em 14 de novembro de 2026');
      expect(text).toMatch(/Total pago: €\s49,00/);
      expect(text).toContain('Curso · pagamento único');
      expect(text).toContain('Crie sua senha e entre');
      expect(text).toContain('nota fiscal');
    }
  });

  it('descuento e impuestos: subtotal, descuento en negativo, impuestos y total; sin nota de incluidos', () => {
    const { text } = buildPurchaseReceiptEmail(BRAND, {
      ...RECEIPT,
      subtotal: 5000,
      discount: 1000,
      tax: 840,
      total: 4840,
    });
    expect(text).toMatch(/Subtotal: 50,00\s€/);
    expect(text).toMatch(/Descuento: −10,00\s€/);
    expect(text).toMatch(/Impuestos: 8,40\s€/);
    expect(text).toMatch(/Total pagado: 48,40\s€/);
    expect(text).not.toContain('impuestos incluidos');
  });

  it('prueba gratis: 0 € hoy y cuándo es el primer cobro, sin método de pago', () => {
    const { text } = buildPurchaseReceiptEmail(BRAND, {
      ...RECEIPT,
      product: { title: 'Club del café', kind: 'membership', intervalMonths: 1 },
      subtotal: 0,
      total: 0,
      paymentMethod: null,
      trial: { endsAt: new Date('2026-11-21T09:30:00Z'), amount: 1900 },
    });
    expect(text).toContain('Prueba gratis: hoy no se cobra nada');
    expect(text).toMatch(/Total hoy: 0,00\s€/);
    expect(text).toMatch(
      /Tu prueba gratis dura hasta el 21 de noviembre de 2026\. Ese día se cobrarán 19,00\s€/,
    );
    expect(text).toContain('Membresía · mensual');
    expect(text).not.toContain('Método de pago');
  });

  it('suscripción pagada: cuándo se renueva y por cuánto', () => {
    const { text } = buildPurchaseReceiptEmail(BRAND, {
      ...RECEIPT,
      product: {
        title: 'Club del café',
        kind: 'membership',
        intervalUnit: 'year',
        intervalMonths: 1,
      },
      nextRenewal: { at: new Date('2027-11-14T09:30:00Z'), amount: 19000 },
    });
    expect(text).toContain('Membresía · anual');
    expect(text).toMatch(/Se renueva el 14 de noviembre de 2027 por 190,00\s€/);
  });

  it('cuenta que ya entró: «Ir a mi curso»; sin acceso, sin botón', () => {
    const enter = buildPurchaseReceiptEmail(BRAND, {
      ...RECEIPT,
      access: { kind: 'course', url: 'https://primersorbo.example.com/courses/cafe' },
    });
    expect(enter.text).toContain('Ir a mi curso: https://primersorbo.example.com/courses/cafe');
    expect(enter.text).not.toContain('Elige tu contraseña');
    const none = buildPurchaseReceiptEmail(BRAND, { ...RECEIPT, access: null });
    expect(none.html).not.toContain('Elige tu contraseña');
  });
});

describe('el creador personaliza el texto, el recibo se queda', () => {
  it('con un mensaje propio de una línea, el recibo y la parte legal siguen enteros', () => {
    const custom = { subject: '¡Gracias, {nombre}!', body: 'Nos vemos dentro.' };
    const { subject, html, text } = buildPurchaseReceiptEmail(BRAND, RECEIPT, custom);
    expect(subject).toBe('¡Gracias, Ana!');
    expect(text).toContain('Nos vemos dentro.');
    expect(text).not.toContain('Guárdalo: es tu justificante');
    for (const must of [
      '3F2A9C1B',
      'Visa ···· 4242',
      'Total pagado',
      'Vendido por'.toUpperCase(),
      'Nombre fiscal: Lucía Martín',
      'Quiero acceder al curso ahora mismo',
      'Política de devoluciones',
      'no una factura',
      'Elige tu contraseña y entra',
    ]) {
      expect(text, must).toContain(must);
    }
    expect(html).toContain('3F2A9C1B');
    expect(html).toContain('Quiero acceder al curso ahora mismo');
  });

  it('un mensaje vacío o un asunto vacío vuelven al original: nunca sale un correo sin asunto', () => {
    const { subject, text } = buildPurchaseReceiptEmail(BRAND, RECEIPT, {
      subject: '   ',
      body: '  ',
    });
    expect(subject).toBe('Recibo de tu compra en Primer Sorbo (pedido 3F2A9C1B)');
    expect(text).toContain('¡Gracias por tu compra!');
  });

  it('lo que escribe el creador se escapa: ni etiquetas, ni atributos, ni javascript:', () => {
    const { subject, html } = buildPurchaseReceiptEmail(BRAND, RECEIPT, {
      subject: 'Hola\r\nBcc: todos@example.com',
      body:
        '<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n' +
        'Mira javascript:alert(1) y https://primersorbo.example.com/guia?a=1&b=2.',
    });
    expect(subject).toBe('Hola Bcc: todos@example.com');
    expect(subject).not.toMatch(/[\r\n]/);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toContain(
      '<a href="https://primersorbo.example.com/guia?a=1&amp;b=2" target="_blank"',
    );
  });

  it('el nombre del comprador también se escapa (viene de Stripe, no es de fiar)', () => {
    const { html } = buildPurchaseReceiptEmail(BRAND, {
      ...RECEIPT,
      buyerName: '<b>Ana</b>',
    });
    expect(html).not.toContain('<b>Ana</b>');
    expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
  });
});

describe('variables', () => {
  const values = {
    name: 'Ana',
    product: 'Café',
    amount: '49,00 €',
    order: '3F2A9C1B',
    academy: 'Primer Sorbo',
  };

  it('en cualquiera de los tres idiomas y en la forma técnica {{x}}', () => {
    expect(fillSaleTemplate('{nombre} · {producto} · {importe} · {pedido}', values)).toBe(
      'Ana · Café · 49,00 € · 3F2A9C1B',
    );
    expect(fillSaleTemplate('{name} · {product} · {amount} · {order}', values)).toBe(
      'Ana · Café · 49,00 € · 3F2A9C1B',
    );
    expect(fillSaleTemplate('{nome} · {produto} · {valor} · {escola}', values)).toBe(
      'Ana · Café · 49,00 € · Primer Sorbo',
    );
    expect(fillSaleTemplate('{{name}} en {{ academy }}', values)).toBe('Ana en Primer Sorbo');
    expect(fillSaleTemplate('{NOMBRE}', values)).toBe('Ana');
  });

  it('lo que no es una variable se queda tal cual (una llave suelta no desaparece)', () => {
    expect(fillSaleTemplate('{descuento} y {} y {otra cosa}', values)).toBe(
      '{descuento} y {} y {otra cosa}',
    );
  });

  it('sin nombre, el saludo se arregla en los tres idiomas', () => {
    for (const lang of LANGS) {
      const body = SALE_EMAIL_DEFAULTS['purchase.receipt'][lang].body;
      const first = fillSaleTemplate(body, { ...values, name: '' }).split('\n')[0];
      expect(first, lang).toBe({ es: 'Hola:', en: 'Hi', pt: 'Olá!' }[lang]);
    }
  });

  it('cada texto original usa SOLO las variables de su correo, las mismas en los tres idiomas', () => {
    const tokenToVar = new Map<string, string>();
    for (const lang of LANGS) {
      for (const [variable, token] of Object.entries(SALE_EMAIL_TOKENS[lang])) {
        tokenToVar.set(token, variable);
      }
    }
    for (const key of SALE_EMAIL_KEYS) {
      const allowed = new Set<string>(SALE_EMAIL_TEMPLATE_VARIABLES[key]);
      const used = (lang: EmailLang) => {
        const { subject, body } = SALE_EMAIL_DEFAULTS[key][lang];
        const tokens = [...`${subject}\n${body}`.matchAll(/\{([\p{L}_]+)\}/gu)].map((m) => m[1]!);
        // Cada token es del idioma de ese texto, no de otro.
        for (const t of tokens) {
          expect(Object.values(SALE_EMAIL_TOKENS[lang]), `${key}/${lang}: {${t}}`).toContain(t);
        }
        return [...new Set(tokens.map((t) => tokenToVar.get(t)!))].sort();
      };
      const es = used('es');
      for (const v of es) expect(allowed.has(v), `${key}: ${v}`).toBe(true);
      expect(used('en'), key).toEqual(es);
      expect(used('pt'), key).toEqual(es);
    }
  });

  it('los tres idiomas tienen texto propio (no el español pegado)', () => {
    for (const key of SALE_EMAIL_KEYS) {
      const { es, en, pt } = SALE_EMAIL_DEFAULTS[key];
      expect(en.body, key).not.toBe(es.body);
      expect(pt.body, key).not.toBe(es.body);
      expect(pt.body, key).not.toBe(en.body);
      expect(`${pt.subject} ${pt.body}`, key).not.toMatch(/«|tu compra|correo/);
    }
  });
});

describe('saneado', () => {
  it('asunto en una línea, sin controles y con tope; mensaje sin controles y con tope', () => {
    expect(sanitizeSubject('  a\tb\nc\u0000d  ')).toBe('a b c d');
    expect(sanitizeSubject('x'.repeat(500))).toHaveLength(200);
    expect(sanitizeBody('a\r\nb\u0007\n\n\n\nc')).toBe('a\nb\n\nc');
    expect(sanitizeBody('y'.repeat(6000))).toHaveLength(5000);
  });

  it('el texto a HTML: párrafos, saltos y enlaces solo http(s)', () => {
    expect(creatorTextToHtml('Uno\nDos\n\nTres')).toBe(
      '<p style="margin:0 0 14px;">Uno<br />Dos</p><p style="margin:0 0 14px;">Tres</p>',
    );
    expect(creatorTextToHtml('ver http://a.example.com.')).toContain(
      '<a href="http://a.example.com" target="_blank"',
    );
    expect(creatorTextToHtml('data:text/html,<b>x</b>')).not.toContain('<a ');
  });
});

describe('renovación, cobro fallido y reembolso', () => {
  it.each(LANGS)(
    'recibo de renovación en %s: pedido, total, próxima renovación y gestionar',
    (lang) => {
      const { subject, text, html } = buildRenewalReceiptEmail(BRAND, { ...RENEWAL, lang });
      expect(html).toContain(`<html lang="${lang}">`);
      expect(text).toContain('IN0001AB');
      expect(text).toContain('https://primersorbo.example.com/account?tab=subscription');
      const expected = {
        es: [
          'Recibo de tu suscripción a «Club del café»',
          'Próxima renovación: 14 de enero de 2027.',
          'Mastercard ···· 4444',
          'Membresía · mensual',
        ],
        en: [
          'Receipt for your subscription to "Club del café"',
          'Next renewal: 14 January 2027.',
          'Mastercard ···· 4444',
          'Membership · monthly',
        ],
        pt: [
          'Recibo da sua assinatura de “Club del café”',
          'Próxima renovação: 14 de janeiro de 2027.',
          'Mastercard ···· 4444',
          'Assinatura · mensal',
        ],
      }[lang];
      expect(subject).toBe(expected[0]);
      for (const e of expected.slice(1)) expect(text).toContain(e);
      if (lang !== 'es') expect(`${subject} ${text}`).not.toMatch(SPANISH);
    },
  );

  it.each(LANGS)(
    'cobro fallido en %s: importe pendiente, fecha límite, reintento y botón',
    (lang) => {
      const { subject, text } = buildPaymentFailedEmail(BRAND, { ...FAILED, lang });
      const expected = {
        es: [
          'No hemos podido cobrar tu suscripción a «Club del café»',
          'antes del 17 de diciembre de 2026',
          'Volveremos a intentar el cobro el 16 de diciembre de 2026.',
          'Actualizar mi método de pago: https://',
        ],
        en: [
          'We could not charge your subscription to "Club del café"',
          'before 17 December 2026',
          'We will try to charge it again on 16 December 2026.',
          'Update my payment method: https://',
        ],
        pt: [
          'Não conseguimos cobrar sua assinatura de “Club del café”',
          'antes de 17 de dezembro de 2026',
          'Vamos tentar cobrar de novo em 16 de dezembro de 2026.',
          'Atualizar forma de pagamento: https://',
        ],
      }[lang];
      expect(subject).toBe(expected[0]);
      for (const e of expected.slice(1)) expect(text).toContain(e);
      if (lang !== 'es') expect(`${subject} ${text}`).not.toMatch(SPANISH);
    },
  );

  it('cobro fallido sin fecha de gracia: aviso genérico, nunca «antes del »', () => {
    const { text } = buildPaymentFailedEmail(BRAND, {
      ...FAILED,
      deadline: null,
      nextAttempt: null,
    });
    expect(text).toContain('Actualiza tu método de pago cuanto antes para no perder el acceso.');
    expect(text).not.toContain('antes del ');
  });

  it.each(LANGS)('reembolso en %s: lo devuelto, cuándo llega y el acceso', (lang) => {
    const { subject, text } = buildRefundEmail(BRAND, { ...REFUND, lang });
    const expected = {
      es: [
        'Te hemos devuelto',
        'Lo verás en tu cuenta en 5 a 10 días hábiles',
        'ya no tienes acceso al curso',
      ],
      en: [
        "We've refunded you",
        '5 to 10 business days',
        'you no longer have access to the course',
      ],
      pt: ['Devolvemos', '5 a 10 dias úteis', 'você não tem mais acesso ao curso'],
    }[lang];
    expect(subject).toContain(expected[0]);
    for (const e of expected.slice(1)) expect(text).toContain(e);
  });
});

describe('aviso de venta a la creadora', () => {
  it.each(LANGS)('%s: desglose, cuándo llega, quién compró y botón a Ventas', (lang) => {
    const { text, html } = buildCreatorSaleEmail(
      { tenantName: 'Didacta', logoUrl: null, brandColor: '#1E5AA8' },
      { ...CREATOR, lang },
    );
    expect(html).toContain(`<html lang="${lang}">`);
    expect(text).toContain('3F2A9C1B');
    expect(text).toContain('ana@example.com');
    expect(text).toContain('https://primersorbo.example.com/admin/payments');
    const expected = {
      es: [
        /Comisión de la tarjeta: −0,99\s€/,
        /5 % de Didacta: −2,45\s€/,
        /Te llega: 45,56\s€/,
        /hacia el 21 de noviembre de 2026/,
      ],
      en: [
        /Card fee: −€0\.99/,
        /Didacta 5% fee: −€2\.45/,
        /You receive: €45\.56/,
        /around 21 November 2026/,
      ],
      pt: [
        /Taxa do cartão: −€\s0,99/,
        /5% da Didacta: −€\s2,45/,
        /Você recebe: €\s45,56/,
        /por volta de 21 de novembro de 2026/,
      ],
    }[lang];
    for (const e of expected) expect(text).toMatch(e);
  });

  it('retenida por datos fiscales y comisión aún desconocida: lo dice, no inventa', () => {
    const { text } = buildCreatorSaleEmail(
      { tenantName: 'Didacta', logoUrl: null, brandColor: '#1E5AA8' },
      {
        ...CREATOR,
        cardFee: null,
        operatorFee: null,
        youReceive: null,
        status: 'held_tax_data',
        arrival: null,
      },
    );
    expect(text).toContain('Comisión de la tarjeta: Calculando…');
    expect(text).toContain('Te llega: Calculando…');
    expect(text).toContain('Retenida hasta que completes tus datos fiscales');
    expect(text).toContain(
      'La comisión de la tarjeta se conoce en cuanto el banco confirma el pago',
    );
  });

  it('cobrado en otra divisa: lo que pagó el alumno y lo recibido en la de liquidación', () => {
    const { text } = buildCreatorSaleEmail(
      { tenantName: 'Didacta', logoUrl: null, brandColor: '#1E5AA8' },
      { ...CREATOR, presentmentAmount: 5300, presentmentCurrency: 'usd', gross: 4900 },
    );
    expect(text).toMatch(/Pagado por el alumno: 53,00\sUS\$/);
    expect(text).toMatch(/Recibido en EUR: 49,00\s€/);
  });
});

describe('piezas', () => {
  it('referencia del pedido: 8 últimos alfanuméricos, en mayúsculas', () => {
    expect(orderReference('7c1e3a90-0000-4000-8000-00003f2a9c1b')).toBe('3F2A9C1B');
    expect(orderReference('in_1QabcDEF2ghIJk')).toBe('EF2GHIJK');
    expect(orderReference(null)).toBe('');
  });

  it('medio de pago: marca, monedero, SEPA y otros', () => {
    expect(paymentMethodLabel({ type: 'card', brand: 'amex', last4: '0005' }, 'es')).toBe(
      'American Express ···· 0005',
    );
    expect(
      paymentMethodLabel({ type: 'card', brand: 'visa', last4: '4242', wallet: 'apple_pay' }, 'en'),
    ).toBe('Visa ···· 4242 (Apple Pay)');
    expect(paymentMethodLabel({ type: 'sepa_debit', last4: '3000' }, 'pt')).toBe(
      'Débito SEPA ···· 3000',
    );
    expect(paymentMethodLabel({ type: 'paypal' }, 'es')).toBe('PayPal');
    expect(paymentMethodLabel(null, 'es')).toBeNull();
    expect(
      paymentMethodFromCharge({
        payment_method_details: {
          type: 'card',
          card: { brand: 'visa', last4: '4242', wallet: null },
        },
      }),
    ).toEqual({ type: 'card', brand: 'visa', last4: '4242', wallet: null });
    expect(paymentMethodFromCharge(null)).toBeNull();
  });

  it('tipo de producto con su periodicidad', () => {
    expect(productKindLabel({ title: 'x', kind: 'membership', intervalMonths: 3 }, 'es')).toBe(
      'Membresía · trimestral',
    );
    expect(
      productKindLabel({ title: 'x', kind: 'course_subscription', intervalMonths: 1 }, 'en'),
    ).toBe('Course · monthly subscription');
    expect(productKindLabel({ title: 'x', kind: 'membership', intervalMonths: 18 }, 'pt')).toBe(
      'Assinatura · a cada 18 meses',
    );
    expect(productKindLabel({ title: 'x', kind: 'membership' }, 'es')).toBe('Membresía');
  });

  it('texto del botón legible sobre la marca: blanco sobre oscuro, tinta sobre claro', () => {
    expect(readableTextOn('#1E5AA8')).toBe('#ffffff');
    expect(readableTextOn('#f5d90a')).toBe('#111827');
    const html = renderBrandedEmail(
      { tenantName: 'A', logoUrl: null, brandColor: '#f5d90a' },
      {
        lang: 'es',
        title: 't',
        bodyHtml: '',
        bodyText: '',
        cta: { url: 'https://a.example.com', label: 'Entrar' },
      },
    ).html;
    expect(html).toMatch(/color:#111827;text-decoration:none;[^>]*>Entrar</);
  });
});

// ─── El servicio: datos reales → recibo; renovación una vez por factura ──────

const TENANT = '11111111-1111-4111-8111-111111111111';

function fakeWorld(opts: { lastLoginAt?: Date | null; platform?: boolean } = {}) {
  const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const claims = new Set<string>();
  const prisma = {
    tenant: { findUnique: vi.fn(async () => ({ name: 'Primer Sorbo' })) },
    modThemingTenantTheme: {
      findUnique: vi.fn(async () => ({
        logoUrl: null,
        brandHue: 25,
        brandSaturation: 60,
        coverUrl: null,
      })),
    },
    user: {
      findFirst: vi.fn(async () => ({
        id: 'u1',
        email: 'ana@example.com',
        name: 'Ana García',
        locale: 'es-ES',
        status: 'ACTIVE',
        lastLoginAt: opts.lastLoginAt ?? null,
      })),
      findMany: vi.fn(async () => []),
    },
    modCoursesCourse: {
      findFirst: vi.fn(async () => ({
        title: 'Iniciación al café de especialidad',
        slug: 'iniciacion-cafe',
        thumbnailUrl: '/api/v1/storage/portada.jpg',
      })),
    },
    modSubscriptionsPlan: {
      findFirst: vi.fn(async () => ({
        name: 'Club del café',
        intervalMonths: 1,
        amountCents: 1900,
        currency: 'eur',
      })),
    },
    modSubscriptionsSubscription: {
      findFirst: vi.fn(async () => ({
        userId: 'u1',
        planId: 'p1',
        courseId: null,
        unitAmount: 1900,
        currency: 'eur',
        interval: 'month',
        currentPeriodEnd: new Date('2027-01-14T09:30:00Z'),
        trialEndsAt: null,
        gracePeriodEndsAt: new Date('2026-12-17T09:30:00Z'),
      })),
    },
    modPayoutsSale: { findFirst: vi.fn(async () => null) },
    notificationTemplate: {
      findUnique: vi.fn(async (): Promise<{ subject: string | null; body: string } | null> => null),
    },
    saleEmailSent: {
      create: vi.fn(async ({ data }: { data: { kind: string; ref: string } }) => {
        const k = `${data.kind}|${data.ref}`;
        if (claims.has(k)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        claims.add(k);
        return data;
      }),
    },
  };
  const smtp = {
    send: vi.fn(
      async (_c: unknown, input: { to: string; subject: string; text: string; html: string }) => {
        sent.push(input);
        return { ok: true };
      },
    ),
  };
  const passwordReset = {
    request: vi.fn(async () => ({ rawToken: 'tok123' })),
  };
  const service = new SaleEmailsService(
    prisma as never,
    { warn: vi.fn(), log: vi.fn(), error: vi.fn() } as never,
    {
      resolveTenantWebBaseUrlForBackground: async () => 'https://primersorbo.example.com',
    } as never,
    {
      resolve: async () => ({
        config: {
          from: 'Primer Sorbo <aulas@didacta.example.com>',
          sender: { replyTo: 'hola@primersorbo.example.com' },
        },
        source: 'global',
      }),
    } as never,
    smtp as never,
    passwordReset as never,
    undefined,
    undefined,
    opts.platform
      ? ({
          taxProfiles: null,
          stripe: { v1: vi.fn(async () => ({})) },
          // La suscripción está en el registro de objetos de la plataforma.
          platformRefs: () => ({ isPlatformObject: async (id: string) => id === 'sub_1' }),
        } as never)
      : undefined,
  );
  return { service, sent, prisma, passwordReset };
}

const CONSENT = {
  purchaseKind: 'course',
  itemRef: 'course-1',
  itemName: 'Iniciación al café de especialidad',
  orderId: '7c1e3a90-0000-4000-8000-00003f2a9c1b',
  sellerName: 'Primer Sorbo',
  paymentMode: 'own',
  version: '2026-11-14',
  locale: 'es',
  text: 'Quiero acceder al curso ahora mismo. Vende: Primer Sorbo.',
  acceptedAt: new Date('2026-11-14T09:29:00Z'),
};

const SESSION = {
  id: 'cs_test_1',
  mode: 'payment',
  payment_status: 'paid',
  amount_subtotal: 4900,
  amount_total: 4900,
  currency: 'eur',
  total_details: { amount_discount: 0, amount_tax: 0 },
  customer_details: { email: 'ana@example.com', name: 'Ana García' },
  created: Math.floor(new Date('2026-11-14T09:30:00Z').getTime() / 1000),
  payment_intent: null,
} as never;

describe('SaleEmailsService', () => {
  it('compra de una cuenta nueva: el recibo lleva el enlace para elegir contraseña (7 días) hacia su curso', async () => {
    const { service, sent, passwordReset } = fakeWorld({ lastLoginAt: null });
    const ok = await service.sendPurchaseReceipt(TENANT, {
      to: 'ana@example.com',
      consent: CONSENT,
      session: SESSION,
    });
    expect(ok).toBe(true);
    expect(passwordReset.request).toHaveBeenCalledWith(
      { email: 'ana@example.com', resolvedTenantId: TENANT },
      expect.anything(),
      { ttlMinutes: 7 * 24 * 60 },
    );
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.subject).toBe('Recibo de tu compra en Primer Sorbo (pedido 3F2A9C1B)');
    expect(mail.text).toContain(
      'Elige tu contraseña y entra: https://primersorbo.example.com/reset-password?token=tok123&next=%2Fcourses%2Finiciacion-cafe',
    );
    // Contacto: el «correo para respuestas» del aula, no la dirección de la plataforma.
    expect(mail.text).toContain('Contacto: hola@primersorbo.example.com');
    expect(mail.text).not.toContain('aulas@didacta.example.com');
    // Portada del curso con URL absoluta.
    expect(mail.html).toContain('src="https://primersorbo.example.com/api/v1/storage/portada.jpg"');
  });

  it('compra de una cuenta que ya entró: «Ir a mi curso», sin emitir enlaces', async () => {
    const { service, sent, passwordReset } = fakeWorld({ lastLoginAt: new Date() });
    await service.sendPurchaseReceipt(TENANT, {
      to: 'ana@example.com',
      consent: CONSENT,
      session: SESSION,
    });
    expect(passwordReset.request).not.toHaveBeenCalled();
    expect(sent[0]!.text).toContain(
      'Ir a mi curso: https://primersorbo.example.com/courses/iniciacion-cafe',
    );
  });

  it('el texto del aula manda (y el recibo sigue)', async () => {
    const { service, sent, prisma } = fakeWorld({ lastLoginAt: new Date() });
    prisma.notificationTemplate.findUnique.mockResolvedValueOnce({
      subject: 'Ya eres de {academia}, {nombre}',
      body: 'Gracias por apoyar {academia}.',
    });
    await service.sendPurchaseReceipt(TENANT, {
      to: 'ana@example.com',
      consent: CONSENT,
      session: SESSION,
    });
    expect(sent[0]!.subject).toBe('Ya eres de Primer Sorbo, Ana');
    expect(sent[0]!.text).toContain('Gracias por apoyar Primer Sorbo.');
    expect(sent[0]!.text).toContain('3F2A9C1B');
    expect(sent[0]!.text).toMatch(/Total pagado: 49,00\s€/);
  });

  const invoiceEvent = (type: string, billing_reason: string, attempt = 1) =>
    ({
      id: `evt_${type}_${attempt}`,
      type,
      created: Math.floor(new Date('2026-12-14T09:30:00Z').getTime() / 1000),
      data: {
        object: {
          id: 'in_1QabcDEF2ghIJk',
          billing_reason,
          subscription: 'sub_1',
          currency: 'eur',
          amount_paid: type === 'invoice.paid' ? 1900 : 0,
          amount_due: 1900,
          subtotal: 1900,
          total: 1900,
          attempt_count: attempt,
          next_payment_attempt: null,
          hosted_invoice_url: 'https://invoice.stripe.com/i/acct_x/test',
          lines: {
            data: [
              { period: { end: Math.floor(new Date('2027-01-14T09:30:00Z').getTime() / 1000) } },
            ],
          },
          status_transitions: {
            paid_at: Math.floor(new Date('2026-12-14T09:30:00Z').getTime() / 1000),
          },
        },
      },
    }) as never;

  it('renovación cobrada: un recibo por factura aunque Stripe reentregue el evento', async () => {
    const { service, sent } = fakeWorld();
    await service.onInvoiceEvent(TENANT, invoiceEvent('invoice.paid', 'subscription_cycle'));
    await service.onInvoiceEvent(TENANT, invoiceEvent('invoice.paid', 'subscription_cycle'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('ana@example.com');
    expect(sent[0]!.subject).toBe('Recibo de tu suscripción a «Club del café»');
    expect(sent[0]!.text).toContain('Próxima renovación: 14 de enero de 2027.');
  });

  it('el alta (primera factura) no manda otro recibo: ya salió el de la compra', async () => {
    const { service, sent } = fakeWorld();
    await service.onInvoiceEvent(TENANT, invoiceEvent('invoice.paid', 'subscription_create'));
    expect(sent).toHaveLength(0);
  });

  it('cobro fallido: un aviso por intento, con la fecha límite de la gracia y la página de pago', async () => {
    const { service, sent } = fakeWorld();
    await service.onInvoiceEvent(
      TENANT,
      invoiceEvent('invoice.payment_failed', 'subscription_cycle', 1),
    );
    await service.onInvoiceEvent(
      TENANT,
      invoiceEvent('invoice.payment_failed', 'subscription_cycle', 1),
    );
    await service.onInvoiceEvent(
      TENANT,
      invoiceEvent('invoice.payment_failed', 'subscription_cycle', 2),
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]!.subject).toBe('No hemos podido cobrar tu suscripción a «Club del café»');
    expect(sent[0]!.text).toContain('antes del 17 de diciembre de 2026');
    // Claves propias: la página de pago de la factura en Stripe (cuenta del aula).
    expect(sent[0]!.text).toContain(
      'Actualizar mi método de pago: https://invoice.stripe.com/i/acct_x/test',
    );
  });

  it('cobro fallido de una suscripción de la PLATAFORMA (sin venta anotada): el botón va a su cuenta del aula', async () => {
    const { service, sent } = fakeWorld({ platform: true });
    await service.onInvoiceEvent(
      TENANT,
      invoiceEvent('invoice.payment_failed', 'subscription_cycle', 1),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(
      'Actualizar mi método de pago: https://primersorbo.example.com/account?tab=subscription',
    );
    expect(sent[0]!.text).not.toContain('invoice.stripe.com');
  });

  it('vista previa con datos de ejemplo y el borrador del editor', async () => {
    const { service } = fakeWorld();
    for (const key of SALE_EMAIL_KEYS) {
      for (const lang of LANGS) {
        const out = await service.preview(TENANT, key, lang, null);
        expect(out.subject.length, `${key}/${lang}`).toBeGreaterThan(0);
        expect(out.html, `${key}/${lang}`).toContain(`<html lang="${lang}">`);
        expect(out.html, `${key}/${lang}`).toContain('Primer Sorbo');
      }
    }
    const draft = await service.preview(TENANT, 'purchase.receipt', 'es', {
      subject: 'Borrador para {nombre}',
      body: 'Texto del borrador',
    });
    expect(draft.subject).toBe('Borrador para Ana');
    expect(draft.text).toContain('Texto del borrador');
    expect(draft.text).toContain('A1B2C3D4');
  });
});
