/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { EmailLang } from '../../common/branded-email';

/**
 * Textos de los avisos de inactividad al creador (es/en). En llano, sin jerga
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
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'es-ES', {
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
