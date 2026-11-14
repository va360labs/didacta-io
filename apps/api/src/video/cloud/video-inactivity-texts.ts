/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { PLAIN_EMAIL_INTL_LOCALE, type EmailLang } from '../../common/branded-email';

/**
 * Textos de los avisos de inactividad al creador (es/en/pt). En llano, sin jerga
 * y SIN mencionar la copia de seguridad: el compromiso con el creador es el
 * borrado; la copia es una red del operador, no una promesa.
 *
 * Puro: lo fijan los tests.
 */

export interface InactivityTexts {
  subject: string;
  title: string;
  body: string;
  cta: string;
}

export function formatDay(date: Date, lang: EmailLang): string {
  return new Intl.DateTimeFormat(PLAIN_EMAIL_INTL_LOCALE[lang], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function inactivityTexts(input: {
  lang: EmailLang;
  stage: 10 | 20;
  academy: string;
  /** Fecha a partir de la cual se borran los vídeos. */
  deleteOn: Date;
}): InactivityTexts {
  const day = formatDay(input.deleteOn, input.lang);
  if (input.lang === 'pt') {
    // «Academia» se queda «academia» porque el español de estos avisos dice
    // «academia» (glosario pt-BR); solo el «aula» española pasa a «escola».
    if (input.stage === 10) {
      return {
        subject: `${input.academy} está há 10 dias sem atividade`,
        title: 'Sua academia está há 10 dias sem atividade',
        body:
          `Faz 10 dias que ninguém usa ${input.academy}: nem você, nem seus alunos, e não houve vendas.\n\n` +
          `Se continuar assim, em ${day} vamos excluir os vídeos que você enviou e arquivar a academia.\n\n` +
          `Para que tudo continue como está, basta entrar antes disso. Se você não precisa mais dela, não precisa fazer nada.`,
        cta: 'Entrar na minha academia',
      };
    }
    return {
      subject: `Em ${day} vamos excluir os vídeos de ${input.academy}`,
      title: `Em ${day} vamos excluir seus vídeos`,
      body:
        `${input.academy} está há 20 dias sem atividade.\n\n` +
        `Se ninguém entrar antes de ${day}, vamos excluir os vídeos que você enviou e arquivar a academia.\n\n` +
        `Para mantê-los, entre antes dessa data.`,
      cta: 'Entrar na minha academia',
    };
  }
  if (input.lang === 'en') {
    if (input.stage === 10) {
      return {
        subject: `${input.academy} has had no activity for 10 days`,
        title: 'Your academy has had no activity for 10 days',
        body:
          `Nobody has used ${input.academy} for 10 days: not you, not your students, and there have been no sales.\n\n` +
          `If it stays like this, on ${day} we will delete the videos you uploaded and archive the academy.\n\n` +
          `To keep everything as it is, just sign in before then. If you no longer need the academy, you don't have to do anything.`,
        cta: 'Go to my academy',
      };
    }
    return {
      subject: `We will delete the videos of ${input.academy} on ${day}`,
      title: `We will delete your videos on ${day}`,
      body:
        `${input.academy} has had no activity for 20 days.\n\n` +
        `If nobody signs in before ${day}, we will delete the videos you uploaded and archive the academy.\n\n` +
        `To keep them, sign in before that date.`,
      cta: 'Go to my academy',
    };
  }
  if (input.stage === 10) {
    return {
      subject: `${input.academy} lleva 10 días sin actividad`,
      title: 'Tu academia lleva 10 días sin actividad',
      body:
        `Hace 10 días que nadie usa ${input.academy}: ni tú ni tus alumnos, y no ha habido ventas.\n\n` +
        `Si sigue así, el ${day} borraremos los vídeos que has subido y archivaremos la academia.\n\n` +
        `Para que todo siga como está, basta con que entres antes. Si ya no la necesitas, no tienes que hacer nada.`,
      cta: 'Entrar en mi academia',
    };
  }
  return {
    subject: `El ${day} borraremos los vídeos de ${input.academy}`,
    title: `El ${day} borraremos tus vídeos`,
    body:
      `${input.academy} lleva 20 días sin actividad.\n\n` +
      `Si nadie entra antes del ${day}, borraremos los vídeos que has subido y archivaremos la academia.\n\n` +
      `Para conservarlos, entra antes de esa fecha.`,
    cta: 'Entrar en mi academia',
  };
}
