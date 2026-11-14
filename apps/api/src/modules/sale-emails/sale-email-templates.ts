/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { escapeHtml, type EmailLang } from '../../common/branded-email';

/**
 * Correos de VENTA y ACCESO que el creador puede personalizar (asunto y
 * mensaje), en Ajustes del modo sencillo («Correos») y en `/admin/emails`.
 *
 * Lo editable es solo el texto de arriba. El recibo (pedido, importe, método
 * de pago, vendedor, desistimiento, devoluciones…) y el botón son ESTRUCTURALES:
 * los pone el composer siempre, escriba lo que escriba el creador
 * (`sale-email-render.ts`). Así un correo personalizado nunca deja al
 * comprador sin la información legal mínima.
 *
 * Variables con nombre de PERSONA en el idioma del aula: `{nombre}`,
 * `{producto}`, `{importe}`, `{pedido}`… (en inglés `{name}`, `{product}`…; en
 * portugués `{nome}`, `{produto}`, `{valor}`, `{escola}`…). Se aceptan las de
 * cualquiera de los tres idiomas y también la forma técnica `{{name}}`, para
 * que un texto copiado de otro sitio no salga con huecos. Lo que no es una
 * variable conocida se deja tal cual (una llave suelta no desaparece).
 *
 * Se guardan en la MISMA tabla que el resto de plantillas
 * (`notification_template`, canal EMAIL, un idioma por fila: es-ES, en-US,
 * pt-BR), igual que `/admin/emails`: no hay un segundo sistema de plantillas.
 */

export const SALE_EMAIL_KEYS = [
  'purchase.receipt',
  'purchase.renewal_receipt',
  'purchase.payment_failed',
  'purchase.refund',
] as const;
export type SaleEmailKey = (typeof SALE_EMAIL_KEYS)[number];

export function isSaleEmailKey(key: string): key is SaleEmailKey {
  return (SALE_EMAIL_KEYS as readonly string[]).includes(key);
}

export const SALE_EMAIL_VARIABLES = [
  'name',
  'product',
  'amount',
  'order',
  'date',
  'academy',
  'email',
  'nextDate',
  'deadline',
] as const;
export type SaleEmailVariable = (typeof SALE_EMAIL_VARIABLES)[number];

/** Cómo se escribe cada variable en cada idioma (sin las llaves). */
export const SALE_EMAIL_TOKENS: Readonly<
  Record<EmailLang, Readonly<Record<SaleEmailVariable, string>>>
> = {
  es: {
    name: 'nombre',
    product: 'producto',
    amount: 'importe',
    order: 'pedido',
    date: 'fecha',
    academy: 'academia',
    email: 'correo',
    nextDate: 'renovacion',
    deadline: 'fecha_limite',
  },
  en: {
    name: 'name',
    product: 'product',
    amount: 'amount',
    order: 'order',
    date: 'date',
    academy: 'academy',
    email: 'email',
    nextDate: 'renewal',
    deadline: 'deadline',
  },
  pt: {
    name: 'nome',
    product: 'produto',
    amount: 'valor',
    order: 'pedido',
    date: 'data',
    academy: 'escola',
    email: 'email',
    nextDate: 'renovacao',
    deadline: 'prazo',
  },
};

/** Las variables que tiene cada correo (el editor solo ofrece estas). */
export const SALE_EMAIL_TEMPLATE_VARIABLES: Readonly<
  Record<SaleEmailKey, readonly SaleEmailVariable[]>
> = {
  'purchase.receipt': ['name', 'product', 'amount', 'order', 'date', 'academy', 'email'],
  'purchase.renewal_receipt': [
    'name',
    'product',
    'amount',
    'order',
    'date',
    'academy',
    'email',
    'nextDate',
  ],
  'purchase.payment_failed': ['name', 'product', 'amount', 'date', 'academy', 'email', 'deadline'],
  'purchase.refund': ['name', 'product', 'amount', 'order', 'date', 'academy', 'email'],
};

export interface SaleTemplateText {
  readonly subject: string;
  readonly body: string;
}

/**
 * Texto ORIGINAL de cada correo por idioma: lo que sale si el creador no lo
 * ha tocado y lo que recupera «Volver al original».
 */
export const SALE_EMAIL_DEFAULTS: Readonly<
  Record<SaleEmailKey, Readonly<Record<EmailLang, SaleTemplateText>>>
> = {
  'purchase.receipt': {
    es: {
      subject: 'Recibo de tu compra en {academia} (pedido {pedido})',
      body: 'Hola, {nombre}:\n\n¡Gracias por tu compra! Ya tienes acceso a «{producto}».\n\nAquí abajo tienes el recibo con todos los datos. Guárdalo: es tu justificante de pago.',
    },
    en: {
      subject: 'Your receipt from {academy} (order {order})',
      body: 'Hi {name},\n\nThank you for your purchase! You now have access to "{product}".\n\nBelow is your receipt with all the details. Keep it: it is your proof of payment.',
    },
    pt: {
      subject: 'Recibo da sua compra em {escola} (pedido {pedido})',
      body: 'Olá, {nome}!\n\nObrigado pela sua compra! Você já tem acesso a “{produto}”.\n\nAbaixo está o recibo com todos os dados. Guarde-o: ele é o seu comprovante de pagamento.',
    },
  },
  'purchase.renewal_receipt': {
    es: {
      subject: 'Recibo de tu suscripción a «{producto}»',
      body: 'Hola, {nombre}:\n\nHemos cobrado {importe} por tu suscripción a «{producto}». No tienes que hacer nada: tu acceso sigue activo.\n\nAquí abajo tienes el recibo.',
    },
    en: {
      subject: 'Receipt for your subscription to "{product}"',
      body: 'Hi {name},\n\nWe have charged {amount} for your subscription to "{product}". You do not need to do anything: your access is still active.\n\nYour receipt is below.',
    },
    pt: {
      subject: 'Recibo da sua assinatura de “{produto}”',
      body: 'Olá, {nome}!\n\nCobramos {valor} pela sua assinatura de “{produto}”. Você não precisa fazer nada: seu acesso continua ativo.\n\nO recibo está logo abaixo.',
    },
  },
  'purchase.payment_failed': {
    es: {
      subject: 'No hemos podido cobrar tu suscripción a «{producto}»',
      body: 'Hola, {nombre}:\n\nTu banco ha rechazado el cobro de {importe} de tu suscripción a «{producto}». Suele pasar cuando la tarjeta ha caducado o no tiene saldo suficiente.\n\nActualiza tu método de pago con el botón de abajo para no perder el acceso. Si ya lo has hecho, puedes ignorar este correo.',
    },
    en: {
      subject: 'We could not charge your subscription to "{product}"',
      body: 'Hi {name},\n\nYour bank declined the {amount} payment for your subscription to "{product}". This usually happens when the card has expired or does not have enough funds.\n\nUpdate your payment method with the button below so you do not lose access. If you have already done it, you can ignore this email.',
    },
    pt: {
      subject: 'Não conseguimos cobrar sua assinatura de “{produto}”',
      body: 'Olá, {nome}!\n\nSeu banco recusou a cobrança de {valor} da sua assinatura de “{produto}”. Isso costuma acontecer quando o cartão venceu ou não tem saldo suficiente.\n\nAtualize sua forma de pagamento pelo botão abaixo para não perder o acesso. Se você já fez isso, pode ignorar este e-mail.',
    },
  },
  'purchase.refund': {
    es: {
      subject: 'Te hemos devuelto {importe} de «{producto}»',
      body: 'Hola, {nombre}:\n\n{academia} te ha devuelto {importe} de tu compra de «{producto}».\n\nSi tienes cualquier duda, responde a este correo.',
    },
    en: {
      subject: 'We\'ve refunded you {amount} for "{product}"',
      body: 'Hi {name},\n\n{academy} has refunded {amount} of your purchase of "{product}".\n\nIf you have any questions, just reply to this email.',
    },
    pt: {
      subject: 'Devolvemos {valor} de “{produto}”',
      body: 'Olá, {nome}!\n\n{escola} devolveu {valor} da sua compra de “{produto}”.\n\nSe tiver alguma dúvida, responda a este e-mail.',
    },
  },
};

/** Locale con el que se guarda cada idioma (los mismos de `/admin/emails`). */
export const SALE_EMAIL_STORAGE_LOCALE: Readonly<Record<EmailLang, string>> = {
  es: 'es-ES',
  en: 'en-US',
  pt: 'pt-BR',
};

/** Límites de lo que escribe el creador. */
export const SALE_EMAIL_LIMITS = { subject: 200, body: 5000 } as const;

/** Todas las formas de escribir una variable (los tres idiomas + la técnica), en minúsculas. */
const TOKEN_TO_VARIABLE: ReadonlyMap<string, SaleEmailVariable> = (() => {
  const map = new Map<string, SaleEmailVariable>();
  for (const variable of SALE_EMAIL_VARIABLES) {
    map.set(variable.toLowerCase(), variable);
    for (const lang of Object.keys(SALE_EMAIL_TOKENS) as EmailLang[]) {
      map.set(SALE_EMAIL_TOKENS[lang][variable].toLowerCase(), variable);
    }
  }
  return map;
})();

export type SaleEmailValues = Partial<Record<SaleEmailVariable, string>>;

/**
 * Sustituye las variables de un texto del creador. `{{x}}` y `{x}` en
 * cualquiera de los tres idiomas; lo que no es una variable conocida queda
 * igual. Si una variable no tiene valor (un comprador sin nombre), se quita
 * y se arregla la puntuación que deja («Hola, :» → «Hola:»).
 */
export function fillSaleTemplate(text: string, values: SaleEmailValues): string {
  let emptied = false;
  const out = text.replace(
    /\{\{\s*([\p{L}\p{N}_]+)\s*\}\}|\{([\p{L}\p{N}_]+)\}/gu,
    (whole, a: string | undefined, b: string | undefined) => {
      const variable = TOKEN_TO_VARIABLE.get((a ?? b ?? '').toLowerCase());
      if (!variable) return whole;
      const value = values[variable]?.trim() ?? '';
      if (!value) emptied = true;
      return value;
    },
  );
  if (!emptied) return out;
  return (
    out
      // «Hola, :», «Olá, !» → «Hola:», «Olá!»
      .replace(/[ \t]*,[ \t]*(?=[:!?.;,])/g, '')
      // «Hi ,» al final de línea → «Hi»
      .replace(/[ \t]*,[ \t]*$/gm, '')
      // espacio antes de la puntuación que queda («Hola :»)
      .replace(/[ \t]+(?=[:!?.;,])/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+$/gm, '')
  );
}

/**
 * Asunto seguro: una línea (sin saltos que permitan inyectar cabeceras), sin
 * caracteres de control y con un tope de longitud.
 */
export function sanitizeSubject(subject: string): string {
  return (
    subject
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SALE_EMAIL_LIMITS.subject)
  );
}

/** Mensaje en texto: saltos normalizados, sin caracteres de control, con tope. */
export function sanitizeBody(body: string): string {
  return (
    body
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, SALE_EMAIL_LIMITS.body)
  );
}

/**
 * Texto del creador → HTML. TODO se escapa (ni etiquetas ni atributos: un
 * `<script>` o un `<img onerror>` salen como texto); después los enlaces
 * http(s) se vuelven clicables y los saltos de línea, párrafos. Ningún otro
 * esquema (`javascript:`, `data:`) se enlaza.
 */
export function creatorTextToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map(
      (p) => `<p style="margin:0 0 14px;">${linkify(escapeHtml(p)).replace(/\n/g, '<br />')}</p>`,
    )
    .join('');
}

function linkify(escaped: string): string {
  return escaped.replace(/\bhttps?:\/\/[^\s<]+/gi, (match) => {
    const trail = /[.,;:!?)\]]+$/.exec(match)?.[0] ?? '';
    const url = trail ? match.slice(0, match.length - trail.length) : match;
    // `url` ya va escapado (`&amp;`): vale tal cual dentro del atributo.
    return `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" style="color:inherit;text-decoration:underline;">${url}</a>${trail}`;
  });
}
