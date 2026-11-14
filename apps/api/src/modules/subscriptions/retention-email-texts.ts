/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { PLAIN_EMAIL_INTL_LOCALE, type EmailLang } from '../../common/branded-email';
import { formatMinor } from '../payouts/payouts-notifier';

/**
 * Textos de los correos de la oferta al darse de baja (es/en/pt): pausa
 * confirmada, descuento aplicado y baja confirmada. En llano, sin jerga, con
 * fechas e importes concretos. En portugués, «escola» (nunca «academia»).
 *
 * Puro: lo fijan los tests.
 */

export interface RetentionEmailTexts {
  subject: string;
  title: string;
  body: string;
  cta: string;
}

interface Common {
  lang: EmailLang;
  /** Nombre de pila o nombre completo; vacío = saludo sin nombre. */
  name: string | null;
  academy: string;
  /** Plan de la membresía o curso. */
  item: string;
}

export function formatDay(date: Date, lang: EmailLang): string {
  return new Intl.DateTimeFormat(PLAIN_EMAIL_INTL_LOCALE[lang], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function hello(lang: EmailLang, name: string | null): string {
  const n = name?.trim();
  if (lang === 'en') return n ? `Hi ${n},` : 'Hi,';
  if (lang === 'pt') return n ? `Olá, ${n}!` : 'Olá!';
  return n ? `Hola, ${n}:` : 'Hola:';
}

export function pauseConfirmedTexts(
  input: Common & { startsAt: Date; endsAt: Date; months: number },
): RetentionEmailTexts {
  const from = formatDay(input.startsAt, input.lang);
  const to = formatDay(input.endsAt, input.lang);
  const h = hello(input.lang, input.name);
  if (input.lang === 'en') {
    return {
      subject: 'Your subscription is on pause',
      title: 'Pause confirmed',
      body:
        `${h}\n\nWe've paused your subscription to ${input.item} at ${input.academy}.\n\n` +
        `Until ${from}, nothing changes: that time is already paid for.\n\n` +
        `From ${from} to ${to} you won't be charged and you won't have access to the content. ` +
        `Your account, your progress and your certificates stay exactly as they are.\n\n` +
        `On ${to} it restarts on its own: you'll be charged your usual fee and your access comes back.\n\n` +
        `If you change your mind, you can cancel at any time from your account.`,
      cta: 'See my subscription',
    };
  }
  if (input.lang === 'pt') {
    return {
      subject: 'Sua assinatura está em pausa',
      title: 'Pausa confirmada',
      body:
        `${h}\n\nPausamos sua assinatura de ${input.item} na ${input.academy}.\n\n` +
        `Até ${from}, nada muda: esse período já está pago.\n\n` +
        `De ${from} a ${to} você não será cobrado e não terá acesso ao conteúdo. ` +
        `Sua conta, seu progresso e seus certificados continuam como estão.\n\n` +
        `Em ${to} ela volta sozinha: você será cobrado o valor de sempre e o acesso volta.\n\n` +
        `Se mudar de ideia, pode cancelar quando quiser na sua conta.`,
      cta: 'Ver minha assinatura',
    };
  }
  return {
    subject: 'Tu suscripción queda en pausa',
    title: 'Pausa confirmada',
    body:
      `${h}\n\nHemos pausado tu suscripción a ${input.item} en ${input.academy}.\n\n` +
      `Hasta el ${from} todo sigue igual: ese tiempo ya está pagado.\n\n` +
      `Del ${from} al ${to} no se te cobrará nada y no tendrás acceso al contenido. ` +
      `Tu cuenta, tu progreso y tus certificados se quedan como están.\n\n` +
      `El ${to} se reanuda sola: se te cobrará la cuota de siempre y volverás a tener acceso.\n\n` +
      `Si cambias de idea, puedes darte de baja cuando quieras desde tu cuenta.`,
    cta: 'Ver mi suscripción',
  };
}

export function discountAppliedTexts(
  input: Common & {
    percent: number;
    /** Meses con descuento, o null = solo la siguiente renovación. */
    months: number | null;
    amountCents: number;
    discountedAmountCents: number;
    currency: string;
    nextChargeAt: Date | null;
  },
): RetentionEmailTexts {
  const before = formatMinor(input.amountCents, input.currency, input.lang);
  const after = formatMinor(input.discountedAmountCents, input.currency, input.lang);
  const next = input.nextChargeAt ? formatDay(input.nextChargeAt, input.lang) : null;
  const h = hello(input.lang, input.name);
  const p = input.percent;
  if (input.lang === 'en') {
    const what =
      input.months === null
        ? `Your next renewal${next ? ` (${next})` : ''} will be ${after} instead of ${before}.`
        : input.months === 1
          ? `Your next payment will be ${after} instead of ${before}.`
          : `Your next ${input.months} payments will be ${after} instead of ${before}.`;
    return {
      subject: `You're staying with ${p}% off`,
      title: 'Discount applied',
      body:
        `${h}\n\nThanks for staying at ${input.academy}. We've applied a ${p}% discount to your ` +
        `subscription to ${input.item}.\n\n${what}\n\nAfter that, the fee goes back to ${before}. ` +
        `You don't need to do anything else.`,
      cta: 'See my subscription',
    };
  }
  if (input.lang === 'pt') {
    const what =
      input.months === null
        ? `Sua próxima renovação${next ? ` (${next})` : ''} será de ${after} em vez de ${before}.`
        : input.months === 1
          ? `Seu próximo pagamento será de ${after} em vez de ${before}.`
          : `Seus próximos ${input.months} pagamentos serão de ${after} em vez de ${before}.`;
    return {
      subject: `Você fica com ${p}% de desconto`,
      title: 'Desconto aplicado',
      body:
        `${h}\n\nObrigado por ficar na ${input.academy}. Aplicamos ${p}% de desconto à sua ` +
        `assinatura de ${input.item}.\n\n${what}\n\nDepois, o valor volta a ser ${before}. ` +
        `Você não precisa fazer mais nada.`,
      cta: 'Ver minha assinatura',
    };
  }
  const what =
    input.months === null
      ? `Tu próxima renovación${next ? ` (${next})` : ''} será de ${after} en vez de ${before}.`
      : input.months === 1
        ? `Tu próximo pago será de ${after} en vez de ${before}.`
        : `Tus próximos ${input.months} pagos serán de ${after} en vez de ${before}.`;
  // Espacio duro entre el número y el «%»: el asunto nunca se parte en «30» / «% de…».
  const pct = `${p}\u00a0%`;
  return {
    subject: `Te quedas con un ${pct} de descuento`,
    title: 'Descuento aplicado',
    body:
      `${h}\n\nGracias por quedarte en ${input.academy}. Hemos aplicado un ${pct} de descuento ` +
      `a tu suscripción a ${input.item}.\n\n${what}\n\nDespués, la cuota vuelve a ser de ${before}. ` +
      `No tienes que hacer nada más.`,
    cta: 'Ver mi suscripción',
  };
}

export function cancelConfirmedTexts(
  input: Common & { accessEndsAt: Date | null },
): RetentionEmailTexts {
  const until = input.accessEndsAt ? formatDay(input.accessEndsAt, input.lang) : null;
  const h = hello(input.lang, input.name);
  if (input.lang === 'en') {
    return {
      subject: 'Your cancellation is confirmed',
      title: 'Cancellation confirmed',
      body:
        `${h}\n\nWe've cancelled your subscription to ${input.item} at ${input.academy}. ` +
        `You won't be charged again.\n\n` +
        (until
          ? `You keep your access until ${until}, the end of the period you've already paid for.\n\n`
          : '') +
        `If you change your mind, just reply to this email.`,
      cta: 'See my subscription',
    };
  }
  if (input.lang === 'pt') {
    return {
      subject: 'Seu cancelamento está confirmado',
      title: 'Cancelamento confirmado',
      body:
        `${h}\n\nCancelamos sua assinatura de ${input.item} na ${input.academy}. ` +
        `Você não será cobrado novamente.\n\n` +
        (until ? `Você mantém o acesso até ${until}, o fim do período que já pagou.\n\n` : '') +
        `Se mudar de ideia, é só responder a este e-mail.`,
      cta: 'Ver minha assinatura',
    };
  }
  return {
    subject: 'Tu baja está confirmada',
    title: 'Baja confirmada',
    body:
      `${h}\n\nHemos tramitado tu baja de ${input.item} en ${input.academy}. ` +
      `No se te cobrará nada más.\n\n` +
      (until
        ? `Sigues teniendo acceso hasta el ${until}, el final del periodo que ya pagaste.\n\n`
        : '') +
      `Si cambias de idea, responde a este correo.`,
    cta: 'Ver mi suscripción',
  };
}

/** Nombre genérico de lo suscrito cuando no se puede leer el plan ni el curso. */
export function fallbackItemName(lang: EmailLang): string {
  if (lang === 'en') return 'your membership';
  if (lang === 'pt') return 'sua assinatura';
  return 'tu membresía';
}
