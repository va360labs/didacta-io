/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';

/**
 * Renuncia al derecho de desistimiento al comprar contenido digital.
 *
 * Un consumidor de la UE tiene 14 días para desistir de una compra a
 * distancia. En el contenido digital ese derecho se pierde SOLO si (art. 103.m
 * TRLGDCU; art. 16.m Directiva 2011/83/UE, en la redacción de la Directiva
 * 2019/2161):
 *   1. la ejecución empieza con su consentimiento previo y EXPRESO,
 *   2. reconoce que con ello pierde el derecho, y
 *   3. el vendedor se lo confirma en un soporte duradero (art. 98.7) — el
 *      correo de confirmación con este mismo texto.
 *
 * Sin esto, el alumno puede ver el curso entero y pedir el dinero dentro de
 * los 14 días sin pagar nada por lo consumido (art. 108.4).
 *
 * El texto es el MISMO en la pantalla y en la prueba: la web lo pide a la API
 * (`GET /purchase-consent/withdrawal-waiver`) y la API lo vuelve a componer
 * igual al guardar el consentimiento. Si se cambia una palabra, se sube
 * `WITHDRAWAL_WAIVER_VERSION`: una pestaña abierta con el texto viejo recibe
 * 409 y vuelve a pedirlo, y cada prueba guardada dice qué versión aceptó.
 */

export const WITHDRAWAL_WAIVER_KIND = 'withdrawal_waiver';
/**
 * 2026-11-14: entra el portugués. El español y el inglés no cambian, pero un
 * comprador `pt-BR` pasaba de leer el texto inglés al portugués: con la versión
 * de antes, una pestaña abierta con el inglés habría guardado como prueba un
 * texto portugués que nunca vio. Subiéndola, esa pestaña recibe 409 y lo pide
 * de nuevo.
 */
export const WITHDRAWAL_WAIVER_VERSION = '2026-11-14';

export const PURCHASE_KINDS = ['course', 'membership', 'course_subscription'] as const;
export type PurchaseKind = (typeof PURCHASE_KINDS)[number];

export type WaiverLang = 'es' | 'en' | 'pt';

/** Lo que manda la web con el checkout. */
export const withdrawalWaiverSchema = z
  .object({
    accepted: z.literal(true),
    version: z.string().min(1).max(40),
    /** Idioma en el que la web enseñó el texto (`es`, `en`, `pt-BR`…). */
    locale: z.string().max(16).optional(),
  })
  .strict();
export type WithdrawalWaiverDto = z.infer<typeof withdrawalWaiverSchema>;

const STATEMENTS: Readonly<Record<WaiverLang, Readonly<Record<PurchaseKind, string>>>> = {
  es: {
    course:
      'Quiero acceder al curso ahora mismo. Entiendo que, al empezar ya, pierdo el derecho a desistir de la compra en 14 días.',
    membership:
      'Quiero acceder a la membresía ahora mismo. Entiendo que, al empezar ya, pierdo el derecho a desistir de la suscripción en 14 días. Puedo darme de baja cuando quiera para los cobros siguientes.',
    course_subscription:
      'Quiero acceder al curso ahora mismo. Entiendo que, al empezar ya, pierdo el derecho a desistir de la suscripción en 14 días. Puedo darme de baja cuando quiera para los cobros siguientes.',
  },
  en: {
    course:
      'I want to access the course right now. I understand that, by starting now, I lose my right to withdraw from this purchase within 14 days.',
    membership:
      'I want to access the membership right now. I understand that, by starting now, I lose my right to withdraw from this subscription within 14 days. I can cancel at any time for future payments.',
    course_subscription:
      'I want to access the course right now. I understand that, by starting now, I lose my right to withdraw from this subscription within 14 days. I can cancel at any time for future payments.',
  },
  // Portugués de Brasil. «Assinatura» es la membresía y la suscripción (como en
  // el panel) y «cobranças» los cargos al comprador; el plazo y el derecho son
  // los mismos de la versión española, que es la que manda.
  pt: {
    course:
      'Quero acessar o curso agora mesmo. Entendo que, ao começar agora, perco o direito de desistir da compra em até 14 dias.',
    membership:
      'Quero acessar a assinatura agora mesmo. Entendo que, ao começar agora, perco o direito de desistir da assinatura em até 14 dias. Posso cancelar quando quiser para as próximas cobranças.',
    course_subscription:
      'Quero acessar o curso agora mesmo. Entendo que, ao começar agora, perco o direito de desistir da assinatura em até 14 dias. Posso cancelar quando quiser para as próximas cobranças.',
  },
};

const SELLER: Readonly<Record<WaiverLang, (seller: string) => string>> = {
  es: (seller) => `Vende: ${seller}.`,
  en: (seller) => `Sold by ${seller}.`,
  pt: (seller) => `Vendido por ${seller}.`,
};

/**
 * `es`, `es-ES`, `es-419` → español; `pt`, `pt-BR` → portugués; otro idioma →
 * inglés. Sin idioma (ni la web lo dijo ni hay cookie), español: es el idioma
 * por defecto de la web.
 */
export function waiverLang(locale: string | null | undefined): WaiverLang {
  const value = (locale ?? '').trim().toLowerCase();
  if (!value) return 'es';
  if (value.startsWith('es')) return 'es';
  if (value.startsWith('pt')) return 'pt';
  return 'en';
}

export interface RenderedWaiver {
  readonly kind: typeof WITHDRAWAL_WAIVER_KIND;
  readonly version: string;
  readonly locale: WaiverLang;
  /** La frase de la casilla. */
  readonly statement: string;
  /** «Vende: {academia}.» */
  readonly sellerLine: string;
  /** Lo que se guarda como prueba: casilla + vendedor. */
  readonly text: string;
  readonly sellerName: string;
}

/** Puro: lo fijan los tests y lo comparten la pantalla y la prueba. */
export function renderWithdrawalWaiver(input: {
  readonly purchaseKind: PurchaseKind;
  readonly locale: string | null | undefined;
  readonly sellerName: string;
}): RenderedWaiver {
  const lang = waiverLang(input.locale);
  const seller = input.sellerName.replace(/\s+/g, ' ').trim() || '—';
  const statement = STATEMENTS[lang][input.purchaseKind];
  const sellerLine = SELLER[lang](seller);
  return {
    kind: WITHDRAWAL_WAIVER_KIND,
    version: WITHDRAWAL_WAIVER_VERSION,
    locale: lang,
    statement,
    sellerLine,
    text: `${statement} ${sellerLine}`,
    sellerName: seller,
  };
}
