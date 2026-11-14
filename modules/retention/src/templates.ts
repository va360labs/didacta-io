/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { RetentionLocale, RetentionTriggerName } from './variables.js';

/**
 * Plantillas listas para activar con un clic. Están escritas en primera
 * persona porque el mensaje llega como si lo escribiera quien firma el aula
 * (su nombre y su foto en la mensajería), y no prometen nada concreto del aula
 * —ni una clase, ni un descuento, ni un plazo— que la creadora no haya dicho:
 * lo concreto lo pone ella al editar.
 *
 * Glosario: en portugués el aula es «escola»; en inglés, «academy».
 */

export type RetentionTemplateKey =
  | 'welcome'
  | 'first_week'
  | 'first_month'
  | 'come_back'
  | 'course_completed'
  | 'first_post'
  | 'level_up'
  | 'anniversary';

export interface RetentionTemplateCopy {
  /** Nombre del mensaje en la lista del aula. */
  name: string;
  /** Asunto del correo (si se activa la copia por correo). */
  subject: string;
  body: string;
}

export interface RetentionTemplate {
  key: RetentionTemplateKey;
  trigger: RetentionTriggerName;
  days?: number;
  resendAfterDays?: number;
  /** Módulo sin el cual la plantilla no tiene sentido (se oculta si está apagado). */
  requiresModule?: string;
  copy: Readonly<Record<RetentionLocale, RetentionTemplateCopy>>;
}

export const RETENTION_TEMPLATES: readonly RetentionTemplate[] = [
  {
    key: 'welcome',
    trigger: 'WELCOME',
    copy: {
      es: {
        name: 'Bienvenida',
        subject: 'Te doy la bienvenida a {academia}',
        body:
          '¡Hola, {nombre}! Te doy la bienvenida a {academia}. Me alegra mucho tenerte aquí.\n\n' +
          'Para empezar con buen pie:\n' +
          '1. Preséntate a la comunidad: {enlace_presentate}\n' +
          '2. Empieza por aquí: {enlace_curso}\n\n' +
          'Si tienes cualquier duda, respóndeme a este mensaje y te ayudo.',
      },
      en: {
        name: 'Welcome',
        subject: 'Welcome to {academy}',
        body:
          "Hi {name}! Welcome to {academy}. I'm really glad you're here.\n\n" +
          'To get off to a good start:\n' +
          '1. Introduce yourself to the community: {intro_link}\n' +
          '2. Start here: {course_link}\n\n' +
          "If you have any questions, just reply to this message and I'll help you out.",
      },
      pt: {
        name: 'Boas-vindas',
        subject: 'Boas-vindas à escola {escola}',
        body:
          'Olá, {nome}! Boas-vindas à escola {escola}. Que bom ter você aqui.\n\n' +
          'Para começar com o pé direito:\n' +
          '1. Apresente-se para a comunidade: {link_apresentacao}\n' +
          '2. Comece por aqui: {link_curso}\n\n' +
          'Se tiver qualquer dúvida, é só responder a esta mensagem que eu te ajudo.',
      },
    },
  },
  {
    key: 'first_week',
    trigger: 'DAYS_AFTER_JOIN',
    days: 7,
    copy: {
      es: {
        name: 'Primera semana',
        subject: '¿Qué tal tu primera semana?',
        body:
          '¡Hola, {nombre}! Ya llevas una semana en {academia}. ¿Qué tal te está yendo?\n\n' +
          'Si todavía no has empezado, este es un buen momento: {enlace_curso}\n\n' +
          'Cuéntame qué te está pareciendo o en qué te puedo ayudar. Leo todas las respuestas.',
      },
      en: {
        name: 'First week',
        subject: 'How was your first week?',
        body:
          "Hi {name}! You've been at {academy} for a week now. How's it going?\n\n" +
          "If you haven't started yet, now is a great time: {course_link}\n\n" +
          'Tell me what you think so far or how I can help. I read every reply.',
      },
      pt: {
        name: 'Primeira semana',
        subject: 'Como foi a sua primeira semana?',
        body:
          'Olá, {nome}! Você já está há uma semana na escola {escola}. Como está indo?\n\n' +
          'Se ainda não começou, este é um bom momento: {link_curso}\n\n' +
          'Me conte o que está achando ou como posso ajudar. Eu leio todas as respostas.',
      },
    },
  },
  {
    key: 'first_month',
    trigger: 'DAYS_AFTER_JOIN',
    days: 30,
    copy: {
      es: {
        name: 'Primer mes',
        subject: 'Tu primer mes en {academia}',
        body:
          '¡{nombre}, ya llevas un mes en {academia}! Gracias por estar aquí.\n\n' +
          '¿Hay algo que te gustaría aprender y que todavía no encuentras? Respóndeme y lo tengo en cuenta.\n\n' +
          'Y si quieres compartir tus avances, la comunidad te espera: {enlace_comunidad}',
      },
      en: {
        name: 'First month',
        subject: 'Your first month at {academy}',
        body:
          "{name}, it's been a month since you joined {academy}! Thank you for being here.\n\n" +
          "Is there anything you'd like to learn that you haven't found yet? Reply and I'll keep it in mind.\n\n" +
          'And if you want to share your progress, the community is waiting for you: {community_link}',
      },
      pt: {
        name: 'Primeiro mês',
        subject: 'O seu primeiro mês na escola {escola}',
        body:
          '{nome}, você já está há um mês na escola {escola}! Obrigado por estar aqui.\n\n' +
          'Tem algo que você gostaria de aprender e ainda não encontrou? Me responda que eu levo em conta.\n\n' +
          'E se quiser compartilhar o seu progresso, a comunidade está esperando por você: {link_comunidade}',
      },
    },
  },
  {
    key: 'come_back',
    trigger: 'INACTIVE',
    days: 14,
    resendAfterDays: 7,
    copy: {
      es: {
        name: 'Te echamos de menos',
        subject: '¿Seguimos? Te echamos de menos en {academia}',
        body:
          'Hola, {nombre}. Hace unos días que no te veo por {academia} y quería saber qué tal estás.\n\n' +
          'Si te has atascado o te falta tiempo, cuéntamelo y lo vemos. ' +
          'Puedes retomarlo justo donde lo dejaste: {enlace_curso}',
      },
      en: {
        name: 'We miss you',
        subject: 'Shall we pick it up again? We miss you at {academy}',
        body:
          "Hi {name}. I haven't seen you around {academy} for a few days and wanted to check in.\n\n" +
          "If you got stuck or you're short on time, tell me and we'll figure it out. " +
          'You can pick up right where you left off: {course_link}',
      },
      pt: {
        name: 'Sentimos sua falta',
        subject: 'Vamos continuar? Sentimos sua falta na escola {escola}',
        body:
          'Olá, {nome}. Faz alguns dias que não vejo você na escola {escola} e queria saber como você está.\n\n' +
          'Se travou em algum ponto ou está sem tempo, me conte e a gente vê isso juntos. ' +
          'Você pode continuar exatamente de onde parou: {link_curso}',
      },
    },
  },
  {
    key: 'course_completed',
    trigger: 'COURSE_COMPLETED',
    requiresModule: 'mod.learning',
    copy: {
      es: {
        name: 'Curso terminado',
        subject: '¡Enhorabuena por terminar {curso}!',
        body:
          '¡Enhorabuena, {nombre}! Has terminado «{curso}». Es un logro de verdad.\n\n' +
          '¿Qué es lo que más te ha servido? Me encantaría saberlo. ' +
          'Y si te apetece, compártelo con la comunidad: {enlace_comunidad}',
      },
      en: {
        name: 'Course completed',
        subject: 'Congratulations on finishing {course}!',
        body:
          "Congratulations, {name}! You've finished “{course}”. That's a real achievement.\n\n" +
          "What helped you the most? I'd love to know. " +
          'And if you feel like it, share it with the community: {community_link}',
      },
      pt: {
        name: 'Curso concluído',
        subject: 'Parabéns por concluir {curso}!',
        body:
          'Parabéns, {nome}! Você concluiu «{curso}». É uma conquista de verdade.\n\n' +
          'O que mais te ajudou? Eu adoraria saber. ' +
          'E se quiser, compartilhe com a comunidade: {link_comunidade}',
      },
    },
  },
  {
    key: 'first_post',
    trigger: 'FIRST_POST',
    requiresModule: 'mod.community',
    copy: {
      es: {
        name: 'Primera publicación',
        subject: 'Gracias por tu primera publicación',
        body:
          '¡Gracias por tu primera publicación, {nombre}! Así es como se hace comunidad.\n\n' +
          'Sigue compartiendo dudas, avances y lo que vayas aprendiendo: {enlace_comunidad}',
      },
      en: {
        name: 'First post',
        subject: 'Thanks for your first post',
        body:
          "Thanks for your first post, {name}! That's how a community is built.\n\n" +
          "Keep sharing your questions, progress and what you're learning: {community_link}",
      },
      pt: {
        name: 'Primeira publicação',
        subject: 'Obrigado pela sua primeira publicação',
        body:
          'Obrigado pela sua primeira publicação, {nome}! É assim que se constrói uma comunidade.\n\n' +
          'Continue compartilhando dúvidas, avanços e o que for aprendendo: {link_comunidade}',
      },
    },
  },
  {
    key: 'level_up',
    trigger: 'LEVEL_UP',
    requiresModule: 'mod.gamification',
    copy: {
      es: {
        name: 'Subida de nivel',
        subject: '¡Has subido a {nivel}!',
        body:
          '¡Has subido a {nivel}, {nombre}! Se nota todo lo que participas en {academia}.\n\n' +
          'Gracias por aportar tanto. ¡A por el siguiente!',
      },
      en: {
        name: 'Level up',
        subject: "You've reached {level}!",
        body:
          "You've reached {level}, {name}! All your participation at {academy} really shows.\n\n" +
          'Thank you for contributing so much. On to the next one!',
      },
      pt: {
        name: 'Subida de nível',
        subject: 'Você chegou ao nível {nivel}!',
        body:
          'Você chegou ao nível {nivel}, {nome}! Dá para ver o quanto você participa na escola {escola}.\n\n' +
          'Obrigado por contribuir tanto. Rumo ao próximo!',
      },
    },
  },
  {
    key: 'anniversary',
    trigger: 'ANNIVERSARY',
    requiresModule: 'mod.subscriptions',
    copy: {
      es: {
        name: 'Aniversario',
        subject: '¡Feliz aniversario en {academia}!',
        body:
          '¡Feliz aniversario, {nombre}! Hoy hace un año más que formas parte de {academia}.\n\n' +
          'Gracias por seguir aquí. Si hay algo que te gustaría que preparara para este año, respóndeme y lo hablamos.',
      },
      en: {
        name: 'Anniversary',
        subject: 'Happy anniversary at {academy}!',
        body:
          'Happy anniversary, {name}! Today marks another year since you joined {academy}.\n\n' +
          "Thank you for still being here. If there's anything you'd like me to prepare for this year, reply and let's talk.",
      },
      pt: {
        name: 'Aniversário',
        subject: 'Feliz aniversário na escola {escola}!',
        body:
          'Feliz aniversário, {nome}! Hoje faz mais um ano que você faz parte da escola {escola}.\n\n' +
          'Obrigado por continuar aqui. Se tiver algo que você gostaria que eu preparasse para este ano, me responda e a gente conversa.',
      },
    },
  },
];

export function findTemplate(key: string): RetentionTemplate | undefined {
  return RETENTION_TEMPLATES.find((t) => t.key === key);
}
