/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Catálogo ÚNICO de plantillas de email/notificación del producto.
 *
 * Dos familias:
 *  1. **Hub** (`HUB_TEMPLATE_DEFAULTS`): notificaciones que pasan por el
 *     NotificationHub (`prisma-notification-hub.service.ts`) — matrícula,
 *     quizzes, comunidad, desbloqueo de clases… El hub ya resolvía overrides
 *     per-tenant en `notification_template`; sus defaults viven aquí.
 *  2. **Transaccionales** (`TRANSACTIONAL_EMAIL_DEFS`): emails compuestos en
 *     código y enviados directo por `SmtpAdapterService` (reset de contraseña,
 *     OTP, decisión de inscripción, bienvenidas, avisos de renovación…). Desde
 *     alpha.83 sus subject/cuerpo también admiten override per-tenant vía la
 *     MISMA tabla `notification_template` (channel EMAIL, locale es-ES). Las
 *     partes estructurales (botón CTA, código OTP, bloques de datos, botones
 *     aprobar/rechazar) NO son editables: un override nunca puede romper el
 *     funcionamiento del email.
 *
 * La UI admin (`/admin/emails`) consume `buildEmailTemplateCatalog()` para
 * listar TODOS los emails del producto con su default y variables.
 *
 * Los módulos first-party pueden REGISTRAR aquí sus plantillas exportando sus
 * entradas (estructuralmente compatibles con `EmailTemplateCatalogEntry`) desde
 * su paquete: mod.member-registration aporta las suyas
 * (`member_registration.*`) y este catálogo las agrega a las transaccionales.
 */

import { MEMBER_REGISTRATION_EMAIL_TEMPLATES } from '@didacta/mod-member-registration';

export type EmailTemplateCategory =
  | 'account'
  | 'members'
  | 'billing'
  | 'community'
  | 'learning'
  | 'system';

export interface EmailTemplateVariable {
  name: string;
  description: string;
}

export interface EmailTemplateCatalogEntry {
  key: string;
  /** Nombre humano para la UI admin. */
  name: string;
  /** Cuándo se envía (trigger real del producto). */
  description: string;
  category: EmailTemplateCategory;
  /** 'transactional' = compuesto en código; 'hub' = via NotificationHub. */
  source: 'transactional' | 'hub';
  /** Canales por los que el producto lo despacha HOY. */
  channels: Array<'EMAIL' | 'IN_APP'>;
  defaultSubject: string | null;
  defaultBody: string;
  variables: EmailTemplateVariable[];
  /** Partes fijas que se añaden siempre (CTA, código, bloques). */
  structuralNote?: string;
}

// ─── Interpolación estilo Mustache (compartida hub + transaccionales) ────────

/**
 * Interpola `{{var}}`, secciones `{{#var}}…{{/var}}` (si truthy) y
 * `{{^var}}…{{/var}}` (si falsy). Las variables no resueltas quedan vacías.
 * (Movida desde prisma-notification-hub.service.ts para compartirla.)
 */
export function interpolate(text: string, variables: Record<string, unknown>): string {
  const truthy = (name: string): boolean => {
    const v = variables[name];
    return v !== undefined && v !== null && v !== '' && v !== false;
  };
  let out = text.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, name, content) =>
    truthy(name) ? content : '',
  );
  out = out.replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, name, content) =>
    truthy(name) ? '' : content,
  );
  return out.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    const v = variables[name];
    return v === undefined || v === null ? '' : String(v);
  });
}

// ─── Defaults del NotificationHub (movidos desde el hub, misma semántica) ────

export interface TemplateDef {
  subject: string | null;
  body: string;
}

/**
 * Locale de referencia del producto. Es el ÚNICO idioma con copy por defecto
 * garantizado para todas las claves del catálogo, y por eso es el destino
 * deliberado de cualquier camino degradado (destinatario desconocido, `locale`
 * vacío o un locale que el producto todavía no traduce). No es un default
 * implícito: quien caiga aquí lo hace porque no hay nada mejor que servir.
 */
export const HUB_DEFAULT_LOCALE = 'es-ES';

/**
 * Idiomas con catálogo de plantillas propio. Es una lista CERRADA y más corta
 * que los locales que el usuario puede guardar en su perfil (`ALLOWED_LOCALES`
 * de `me.controller.ts` admite además `es-AR`): las variantes regionales
 * comparten catálogo por idioma base.
 *
 * `pt` (portugués de Brasil) entró cuando `pt-BR` volvió a ser elegible: un
 * idioma que el usuario puede guardar y que aquí cayera a `es` le dejaría la
 * interfaz en portugués y los correos en español. Las tablas de abajo van
 * tipadas con `Record<HubTemplateLang, …>` / `satisfies`, así que añadir un
 * idioma a esta lista sin traducir alguna de ellas NO compila.
 */
export const HUB_TEMPLATE_LANGS = ['es', 'en', 'pt'] as const;
export type HubTemplateLang = (typeof HUB_TEMPLATE_LANGS)[number];

/**
 * Reduce un locale BCP-47 (`en-US`, `es_AR`, `EN`, `pt-BR`) al idioma con
 * catálogo. Cualquier cosa que no sea inglés ni portugués cae a `es` — ver
 * `HUB_DEFAULT_LOCALE`. El portugués europeo (`pt-PT`, que solo puede llegar
 * por SCIM) usa el catálogo `pt`: es brasileño, pero es portugués.
 */
export function toHubTemplateLang(locale: string | null | undefined): HubTemplateLang {
  const base = (typeof locale === 'string' ? locale : '').trim().toLowerCase().split(/[-_]/)[0];
  if (base === 'en') return 'en';
  if (base === 'pt') return 'pt';
  return 'es';
}

/**
 * Idioma efectivo de un destinatario a partir del `locale` guardado en su fila
 * de `user`, para los composers que leen esa columna directamente (reset de
 * contraseña, alta por API, pruebas de SMTP).
 *
 * CAMINO DEGRADADO ÚNICO y deliberado: una fila con `locale` vacío o ausente
 * cae a `HUB_DEFAULT_LOCALE`. La columna tiene default en BD, así que solo pasa
 * si alguien la escribió a mano en blanco o si el composer no encontró usuario.
 *
 * Un locale guardado pero SIN traducir (alcanzable por SCIM, que copia el del
 * IdP sin validar: `fr-FR`) NO se resuelve aquí: se devuelve tal cual para que
 * un override per-tenant en ese locale todavía pueda ganar, y lo absorbe
 * `toHubTemplateLang` al elegir catálogo. Misma semántica que
 * `resolveUserLocale` del NotificationHub.
 */
export function resolveRecipientLocale(stored: string | null | undefined): string {
  const trimmed = typeof stored === 'string' ? stored.trim() : '';
  return trimmed || HUB_DEFAULT_LOCALE;
}

export const HUB_TEMPLATE_DEFAULTS: Record<string, TemplateDef> = {
  'enrollment.created': {
    subject: 'Te matriculaste en {{course}}',
    body: 'Acabas de matricularte en el curso "{{course}}". ¡A aprender! Puedes continuar desde tu panel.',
  },
  'course.completed': {
    subject: '¡Curso completado!',
    body: 'Felicitaciones, completaste el curso "{{course}}". Tu certificado se está generando y estará disponible en tu sección de certificados.',
  },
  'certificate.issued': {
    subject: 'Tu certificado de "{{course}}" está listo',
    body: 'Ya puedes descargar el certificado número {{number}} desde Mis certificados.',
  },
  'attempt.passed': {
    subject: 'Aprobaste el quiz de "{{course}}"',
    body: 'Tu intento del quiz "{{quiz}}" obtuvo {{scorePercent}}% — ¡aprobaste!',
  },
  'attempt.failed': {
    subject: 'Resultado de quiz: no aprobado',
    body: 'Tu intento del quiz "{{quiz}}" obtuvo {{scorePercent}}%, por debajo del umbral del {{passThreshold}}%. Puedes reintentarlo si el quiz lo permite.',
  },
  'attempt.graded': {
    subject: 'El formador corrigió tu quiz',
    body: 'Tu intento del quiz "{{quiz}}" fue corregido manualmente. Resultado: {{scorePercent}}% ({{result}}).',
  },
  'admin.smtp.test': {
    subject: 'Prueba de SMTP — {{tenantName}}',
    body: 'Si recibiste este correo, la configuración SMTP de {{tenantName}} funciona correctamente.\n\nTenant: {{tenantSlug}}\nFecha: {{timestamp}}',
  },
  'community.mention': {
    subject: 'Te mencionaron en la comunidad',
    body: '{{authorName}} te mencionó en un {{#commentId}}comentario{{/commentId}}{{#postId}}post{{/postId}}.',
  },
  // Alguien comentó en un post del que sos autor. La deep-link a "responder"
  // la arma el frontend con postId/commentId de metadata.
  'community.comment.on_post': {
    subject: '{{actorName}} comentó en tu publicación',
    body: '{{actorName}} comentó en tu publicación "{{postTitle}}":\n\n"{{excerpt}}"',
  },
  // Alguien respondió a un comentario tuyo dentro de un post.
  'community.reply.to_comment': {
    subject: '{{actorName}} respondió a tu comentario',
    body: '{{actorName}} respondió a tu comentario en "{{postTitle}}":\n\n"{{excerpt}}"',
  },
  'community.digest.weekly': {
    subject:
      'Tu resumen semanal de la comunidad ({{mentionsCount}} menciones · {{repliesCount}} respuestas)',
    // El pie de baja es una sección: sin `unsubUrl` (no se conoce la dirección
    // pública del aula) desaparece. La baja corta los DOS correos de la
    // comunidad, y por eso el texto nombra los dos.
    body: 'Esta semana en la comunidad:\n\n· {{mentionsCount}} mención(es) nueva(s)\n· {{repliesCount}} respuesta(s) en hilos donde participaste\n\nRevísalas todas en tu sección de menciones. Desde el resumen anterior: {{sinceIso}}.{{#unsubUrl}}\n\n———\nRecibes este resumen como miembro de la comunidad. Para dejar de recibir los correos de la comunidad (resumen semanal y avisos), entra aquí: {{unsubUrl}}{{/unsubUrl}}',
  },
  // Aviso masivo (broadcast) a toda la comunidad. El asunto y el cuerpo los
  // escribe el admin al enviarlo, así que van como passthrough; el enlace a la
  // publicación y el pie de baja SÍ son copy del producto y por eso viven aquí
  // (antes los concatenaba el worker al `body`, en español, y llegaban al hub
  // dentro de una variable donde ninguna traducción los alcanzaba).
  //
  // Los dos bloques son secciones: sin `postUrl` / sin `unsubUrl` desaparecen,
  // que es como el aviso in-app se queda sin pie de baja.
  'community.broadcast': {
    subject: '{{subject}}',
    body: '{{body}}{{#postUrl}}\n\nVer la publicación: {{postUrl}}{{/postUrl}}{{#unsubUrl}}\n\n———\nRecibes este aviso como miembro de la comunidad. Para dejar de recibir los correos de la comunidad (avisos y resumen semanal), entra aquí: {{unsubUrl}}{{/unsubUrl}}',
  },
  // Aviso de desbloqueo de una clase programada por fecha (MEJ-009). Lo dispara
  // el LessonUnlockNotifierWorker cuando la lección cruza su publishAt.
  'lesson.unlocked': {
    subject: 'Ya está disponible: {{lessonTitle}}',
    body: 'La clase "{{lessonTitle}}" del curso "{{courseTitle}}" ya está disponible.',
  },
  // Programa de referidos (mod.referrals): comisión devengada y liquidación.
  // Puntos y retos (mod.gamification). Sin estos avisos el alumno no se entera
  // de que le han revisado la entrega ni de que ha subido de nivel: el esfuerzo
  // cae en el vacío y el sistema deja de ser un bucle.
  'gamification.level.reached': {
    subject: 'Has llegado a {{levelName}}',
    body: 'Enhorabuena: acabas de alcanzar el nivel {{levelName}} en {{tenantName}}.\n\nMira lo que desbloquea en la sección de Retos.',
  },
  'gamification.challenge.approved': {
    subject: 'Reto superado: {{title}}',
    body: 'Hemos revisado tu entrega de "{{title}}" y está aprobada: {{points}} puntos para ti.{{#reviewNote}}\n\nComentario del equipo: {{reviewNote}}{{/reviewNote}}\n\nGracias por documentarlo y compartirlo.',
  },
  'gamification.challenge.rejected': {
    subject: 'Tu entrega de "{{title}}" necesita un repaso',
    body: 'Hemos revisado tu entrega de "{{title}}" y todavía no la damos por buena.{{#reviewNote}}\n\nQué falta: {{reviewNote}}{{/reviewNote}}\n\nSi lo ajustas y quieres otra oportunidad, escríbenos.',
  },
  'gamification.staff.pending': {
    subject: 'Tienes algo que revisar',
    body: '{{message}}\n\nLo tienes en Gestión → Puntos y retos.',
  },
  'gamification.perk.handled': {
    subject: 'Sobre tu solicitud: {{perkTitle}}',
    body: '{{statusText}}{{#staffNote}}\n\n{{staffNote}}{{/staffNote}}',
  },
  'referrals.commission.earned': {
    subject: '¡Has ganado una comisión de {{amount}}!',
    body: 'Tu recomendación ha dado fruto: has ganado {{amount}} por el pago de {{baseAmount}} de una persona que entró con tu enlace.\n\nLa comisión queda pendiente durante el periodo de garantía; puedes seguirla en tu área de Referidos.',
  },
  'referrals.payout.recorded': {
    subject: 'Te hemos liquidado {{amount}}',
    body: 'Hemos registrado el pago de tus comisiones aprobadas: {{amount}}.\n\nReferencia del pago: {{reference}}. Tienes el detalle en tu área de Referidos.',
  },
  // Clases en directo (mod.zoom-live, ADR-017): confirmación de inscripción y
  // aviso de cancelación a inscritos. El enlace de la clase viaja en
  // {{classUrl}} — el joinUrl de Zoom NUNCA va por email: se ve en /live/[id]
  // solo estando inscrito.
  'zoom.class.registration.confirmed': {
    subject: 'Inscripción confirmada: {{topic}}',
    body: 'Te has inscrito a la clase en directo "{{topic}}" ({{startsAt}}).{{#classUrl}}\n\nCuando llegue el momento podrás unirte desde la página de la clase:\n{{classUrl}}{{/classUrl}}{{#calendarGoogleUrl}}\n\nGuárdala en tu calendario para que no se te pase:\nGoogle Calendar: {{calendarGoogleUrl}}{{/calendarGoogleUrl}}{{#calendarIcsUrl}}\nOutlook, Apple y otros: {{calendarIcsUrl}}{{/calendarIcsUrl}}\n\nTe avisaremos otra vez 2 horas antes de empezar.',
  },
  // Recordatorio automático 2h antes (worker `zoom-reminder.worker.ts`). Un
  // único envío por clase; si se reprograma, vuelve a armarse.
  'zoom.class.reminder': {
    subject: 'Tu clase "{{topic}}" empieza en {{hoursBefore}} h',
    body: 'Recordatorio: la clase en directo "{{topic}}" empieza {{startsAt}}.{{#classUrl}}\n\nEntra desde la página de la clase:\n{{classUrl}}{{/classUrl}}{{#calendarGoogleUrl}}\n\n¿Aún no la tienes en el calendario?\nGoogle Calendar: {{calendarGoogleUrl}}{{/calendarGoogleUrl}}{{#calendarIcsUrl}}\nOutlook, Apple y otros: {{calendarIcsUrl}}{{/calendarIcsUrl}}',
  },
  'zoom.class.cancelled': {
    subject: 'Clase cancelada: {{topic}}',
    body: 'La clase en directo "{{topic}}" prevista para el {{startsAt}} ha sido cancelada.\n\nSi se reprograma, la verás de nuevo en el calendario.',
  },

  // Encuestas (mod.surveys, bloque 2): invitación anónima al terminar cada
  // clase en directo. El enlace apunta a la página de la clase (/live/[id]),
  // donde vive el panel de la encuesta.
  'surveys.post_class.invitation': {
    subject: 'Valora la clase: {{topic}}',
    body: '¿Qué te ha parecido "{{topic}}"? Son 30 segundos y la respuesta es anónima: nos ayuda a decidir qué grabar y qué mejorar.{{#surveyUrl}}\n\nResponde desde la página de la clase:\n{{surveyUrl}}{{/surveyUrl}}',
  },
  'surveys.post_class.reminder': {
    subject: 'Un momento: ¿qué te pareció "{{topic}}"?',
    body: 'Ayer estuviste inscrito en "{{topic}}" y aún no nos has contado qué te pareció. Son 30 segundos y la respuesta es anónima — de verdad nos ayuda a mejorar las próximas clases.{{#surveyUrl}}\n\nValórala desde la página de la clase:\n{{surveyUrl}}{{/surveyUrl}}\n\n(Si ya la valoraste desde otra cuenta o no llegaste a asistir, ignora este mensaje.)',
  },
};

/**
 * Traducción al inglés de `HUB_TEMPLATE_DEFAULTS`. MISMAS claves y MISMOS
 * placeholders (`{{var}}`, secciones `{{#var}}`/`{{^var}}`): un test verifica
 * que ambos catálogos no divergen. Si una clave faltara aquí,
 * `resolveHubDefault` cae al español en vez de dejar la notificación vacía.
 */
export const HUB_TEMPLATE_DEFAULTS_EN: Record<string, TemplateDef> = {
  'enrollment.created': {
    subject: 'You enrolled in {{course}}',
    body: 'You have just enrolled in the course "{{course}}". Time to learn! You can pick up where you left off from your dashboard.',
  },
  'course.completed': {
    subject: 'Course completed!',
    body: 'Congratulations, you completed the course "{{course}}". Your certificate is being generated and will be available in your certificates section.',
  },
  'certificate.issued': {
    subject: 'Your certificate for "{{course}}" is ready',
    body: 'You can now download certificate number {{number}} from My certificates.',
  },
  'attempt.passed': {
    subject: 'You passed the quiz for "{{course}}"',
    body: 'Your attempt at the quiz "{{quiz}}" scored {{scorePercent}}% — you passed!',
  },
  'attempt.failed': {
    subject: 'Quiz result: not passed',
    body: 'Your attempt at the quiz "{{quiz}}" scored {{scorePercent}}%, below the {{passThreshold}}% pass threshold. You can try again if the quiz allows it.',
  },
  'attempt.graded': {
    subject: 'Your instructor graded your quiz',
    body: 'Your attempt at the quiz "{{quiz}}" was graded manually. Result: {{scorePercent}}% ({{result}}).',
  },
  'admin.smtp.test': {
    subject: 'SMTP test — {{tenantName}}',
    body: 'If you received this email, the SMTP configuration for {{tenantName}} is working correctly.\n\nTenant: {{tenantSlug}}\nDate: {{timestamp}}',
  },
  'community.mention': {
    subject: 'You were mentioned in the community',
    body: '{{authorName}} mentioned you in a {{#commentId}}comment{{/commentId}}{{#postId}}post{{/postId}}.',
  },
  'community.comment.on_post': {
    subject: '{{actorName}} commented on your post',
    body: '{{actorName}} commented on your post "{{postTitle}}":\n\n"{{excerpt}}"',
  },
  'community.reply.to_comment': {
    subject: '{{actorName}} replied to your comment',
    body: '{{actorName}} replied to your comment on "{{postTitle}}":\n\n"{{excerpt}}"',
  },
  'community.digest.weekly': {
    subject: 'Your weekly community digest ({{mentionsCount}} mentions · {{repliesCount}} replies)',
    body: 'This week in the community:\n\n· {{mentionsCount}} new mention(s)\n· {{repliesCount}} new replies in threads you took part in\n\nReview them all in your mentions section. Since the previous digest: {{sinceIso}}.{{#unsubUrl}}\n\n———\nYou receive this digest as a member of the community. To stop receiving community emails (the weekly digest and notices), go here: {{unsubUrl}}{{/unsubUrl}}',
  },
  // El asunto y el cuerpo los escribe el admin al enviar el aviso (passthrough,
  // no hay nada que traducir ahí). Lo que SÍ es copy del producto —el enlace a
  // la publicación y el pie de baja— se traduce aquí.
  'community.broadcast': {
    subject: '{{subject}}',
    body: '{{body}}{{#postUrl}}\n\nSee the post: {{postUrl}}{{/postUrl}}{{#unsubUrl}}\n\n———\nYou receive this notice as a member of the community. To stop receiving community emails (notices and the weekly digest), go here: {{unsubUrl}}{{/unsubUrl}}',
  },
  'lesson.unlocked': {
    subject: 'Now available: {{lessonTitle}}',
    body: 'The lesson "{{lessonTitle}}" from the course "{{courseTitle}}" is now available.',
  },
  'gamification.level.reached': {
    subject: 'You reached {{levelName}}',
    body: 'Congratulations: you have just reached the {{levelName}} level at {{tenantName}}.\n\nSee what it unlocks in the Challenges section.',
  },
  'gamification.challenge.approved': {
    subject: 'Challenge completed: {{title}}',
    body: 'We reviewed your submission for "{{title}}" and it is approved: {{points}} points for you.{{#reviewNote}}\n\nFeedback from the team: {{reviewNote}}{{/reviewNote}}\n\nThanks for documenting it and sharing it.',
  },
  'gamification.challenge.rejected': {
    subject: 'Your submission for "{{title}}" needs another look',
    body: 'We reviewed your submission for "{{title}}" and we cannot approve it yet.{{#reviewNote}}\n\nWhat is missing: {{reviewNote}}{{/reviewNote}}\n\nIf you adjust it and would like another try, get in touch.',
  },
  'gamification.staff.pending': {
    subject: 'You have something to review',
    body: '{{message}}\n\nYou will find it under Management → Points and challenges.',
  },
  // El resultado lo compone el emisor en `statusText`; aquí solo se enmarca.
  'gamification.perk.handled': {
    subject: 'About your request: {{perkTitle}}',
    body: '{{statusText}}{{#staffNote}}\n\n{{staffNote}}{{/staffNote}}',
  },
  'referrals.commission.earned': {
    subject: 'You earned a commission of {{amount}}!',
    body: 'Your referral paid off: you earned {{amount}} from the {{baseAmount}} payment of someone who joined through your link.\n\nThe commission stays pending during the guarantee period; you can track it in your Referrals area.',
  },
  'referrals.payout.recorded': {
    subject: 'We have paid you {{amount}}',
    body: 'We have recorded the payment of your approved commissions: {{amount}}.\n\nPayment reference: {{reference}}. You have the details in your Referrals area.',
  },
  'zoom.class.registration.confirmed': {
    subject: 'Registration confirmed: {{topic}}',
    body: 'You have registered for the live class "{{topic}}" ({{startsAt}}).{{#classUrl}}\n\nWhen the time comes you will be able to join from the class page:\n{{classUrl}}{{/classUrl}}{{#calendarGoogleUrl}}\n\nSave it to your calendar so it does not slip by:\nGoogle Calendar: {{calendarGoogleUrl}}{{/calendarGoogleUrl}}{{#calendarIcsUrl}}\nOutlook, Apple and others: {{calendarIcsUrl}}{{/calendarIcsUrl}}\n\nWe will remind you again 2 hours before it starts.',
  },
  'zoom.class.reminder': {
    subject: 'Your class "{{topic}}" starts in {{hoursBefore}} h',
    body: 'Reminder: the live class "{{topic}}" starts {{startsAt}}.{{#classUrl}}\n\nJoin from the class page:\n{{classUrl}}{{/classUrl}}{{#calendarGoogleUrl}}\n\nStill not in your calendar?\nGoogle Calendar: {{calendarGoogleUrl}}{{/calendarGoogleUrl}}{{#calendarIcsUrl}}\nOutlook, Apple and others: {{calendarIcsUrl}}{{/calendarIcsUrl}}',
  },
  'zoom.class.cancelled': {
    subject: 'Class cancelled: {{topic}}',
    body: 'The live class "{{topic}}" scheduled for {{startsAt}} has been cancelled.\n\nIf it is rescheduled, you will see it again in the calendar.',
  },
  'surveys.post_class.invitation': {
    subject: 'Rate the class: {{topic}}',
    body: 'What did you think of "{{topic}}"? It takes 30 seconds and the answer is anonymous: it helps us decide what to record and what to improve.{{#surveyUrl}}\n\nAnswer from the class page:\n{{surveyUrl}}{{/surveyUrl}}',
  },
  'surveys.post_class.reminder': {
    subject: 'One moment: what did you think of "{{topic}}"?',
    body: 'Yesterday you were registered for "{{topic}}" and you have not told us what you thought yet. It takes 30 seconds and the answer is anonymous — it really helps us improve the next classes.{{#surveyUrl}}\n\nRate it from the class page:\n{{surveyUrl}}{{/surveyUrl}}\n\n(If you already rated it from another account or did not attend, please ignore this message.)',
  },
};

/**
 * Traducción al portugués de Brasil de `HUB_TEMPLATE_DEFAULTS`. Mismo contrato
 * que la inglesa: MISMAS claves y MISMOS placeholders (hay test), y si una
 * clave faltara aquí `resolveHubDefault` cae al español.
 *
 * Vocabulario alineado con el catálogo `pt` de la web
 * (`apps/web/src/i18n/messages/pt`): lección y clase son «aula» («aula ao
 * vivo» la de Zoom), formador es «instrutor», reto es «desafio», referidos son
 * «indicações» y liquidar una comisión es «repasse». Tratamiento de «você» y
 * redacción sin marca de género donde se puede («Você passou», no «Você foi
 * aprovado»): el destinatario no ha dicho cómo quiere que se le trate.
 */
export const HUB_TEMPLATE_DEFAULTS_PT: Record<string, TemplateDef> = {
  'enrollment.created': {
    subject: 'Você se matriculou em {{course}}',
    body: 'Você acabou de se matricular no curso "{{course}}". Bons estudos! Você pode continuar pelo seu painel.',
  },
  'course.completed': {
    subject: 'Curso concluído!',
    body: 'Parabéns, você concluiu o curso "{{course}}". Seu certificado está sendo gerado e ficará disponível na sua seção de certificados.',
  },
  'certificate.issued': {
    subject: 'Seu certificado de "{{course}}" está pronto',
    body: 'Você já pode baixar o certificado número {{number}} em Meus certificados.',
  },
  'attempt.passed': {
    subject: 'Você passou no quiz de "{{course}}"',
    body: 'Sua tentativa no quiz "{{quiz}}" obteve {{scorePercent}}% — você passou!',
  },
  'attempt.failed': {
    subject: 'Resultado do quiz: não aprovado',
    body: 'Sua tentativa no quiz "{{quiz}}" obteve {{scorePercent}}%, abaixo do mínimo de {{passThreshold}}%. Você pode tentar novamente, se o quiz permitir.',
  },
  'attempt.graded': {
    subject: 'O instrutor corrigiu seu quiz',
    body: 'Sua tentativa no quiz "{{quiz}}" foi corrigida manualmente. Resultado: {{scorePercent}}% ({{result}}).',
  },
  'admin.smtp.test': {
    subject: 'Teste de SMTP — {{tenantName}}',
    body: 'Se você recebeu este e-mail, a configuração SMTP de {{tenantName}} está funcionando corretamente.\n\nTenant: {{tenantSlug}}\nData: {{timestamp}}',
  },
  // El artículo va DENTRO de cada sección: «um comentário» / «uma publicação»
  // no comparten género, y fuera de ellas quedaría «em um publicação».
  'community.mention': {
    subject: 'Mencionaram você na comunidade',
    body: '{{authorName}} mencionou você em {{#commentId}}um comentário{{/commentId}}{{#postId}}uma publicação{{/postId}}.',
  },
  'community.comment.on_post': {
    subject: '{{actorName}} comentou na sua publicação',
    body: '{{actorName}} comentou na sua publicação "{{postTitle}}":\n\n"{{excerpt}}"',
  },
  'community.reply.to_comment': {
    subject: '{{actorName}} respondeu ao seu comentário',
    body: '{{actorName}} respondeu ao seu comentário em "{{postTitle}}":\n\n"{{excerpt}}"',
  },
  'community.digest.weekly': {
    subject:
      'Seu resumo semanal da comunidade ({{mentionsCount}} menções · {{repliesCount}} respostas)',
    body: 'Esta semana na comunidade:\n\n· {{mentionsCount}} menção(ões) nova(s)\n· {{repliesCount}} resposta(s) em tópicos dos quais você participou\n\nVeja todas na sua seção de menções. Desde o resumo anterior: {{sinceIso}}.',
  },
  // Passthrough del asunto y del cuerpo (los escribe el admin); se traduce lo
  // que es copy del producto: el enlace a la publicación y el pie de baja.
  'community.broadcast': {
    subject: '{{subject}}',
    body: '{{body}}{{#postUrl}}\n\nVer a publicação: {{postUrl}}{{/postUrl}}{{#unsubUrl}}\n\n———\nVocê recebe este aviso por ser membro da comunidade. Para deixar de receber avisos, acesse: {{unsubUrl}}{{/unsubUrl}}',
  },
  'lesson.unlocked': {
    subject: 'Já está disponível: {{lessonTitle}}',
    body: 'A aula "{{lessonTitle}}" do curso "{{courseTitle}}" já está disponível.',
  },
  'gamification.level.reached': {
    subject: 'Você chegou a {{levelName}}',
    body: 'Parabéns: você acaba de alcançar o nível {{levelName}} em {{tenantName}}.\n\nVeja o que ele desbloqueia na seção de Desafios.',
  },
  'gamification.challenge.approved': {
    subject: 'Desafio concluído: {{title}}',
    body: 'Analisamos sua entrega de "{{title}}" e ela foi aprovada: {{points}} pontos para você.{{#reviewNote}}\n\nComentário da equipe: {{reviewNote}}{{/reviewNote}}\n\nObrigado por documentar e compartilhar.',
  },
  'gamification.challenge.rejected': {
    subject: 'Sua entrega de "{{title}}" precisa de uma revisão',
    body: 'Analisamos sua entrega de "{{title}}" e ainda não podemos aprová-la.{{#reviewNote}}\n\nO que falta: {{reviewNote}}{{/reviewNote}}\n\nSe você ajustar e quiser outra chance, fale com a gente.',
  },
  'gamification.staff.pending': {
    subject: 'Você tem algo para revisar',
    body: '{{message}}\n\nEstá em Gestão → Pontos e desafios.',
  },
  // El resultado lo compone el emisor en `statusText`; aquí solo se enmarca.
  'gamification.perk.handled': {
    subject: 'Sobre sua solicitação: {{perkTitle}}',
    body: '{{statusText}}{{#staffNote}}\n\n{{staffNote}}{{/staffNote}}',
  },
  'referrals.commission.earned': {
    subject: 'Você ganhou uma comissão de {{amount}}!',
    body: 'Sua indicação deu resultado: você ganhou {{amount}} pelo pagamento de {{baseAmount}} de uma pessoa que entrou pelo seu link.\n\nA comissão fica pendente durante o período de garantia; você pode acompanhá-la na sua área de Indicações.',
  },
  'referrals.payout.recorded': {
    subject: 'Repassamos {{amount}} para você',
    body: 'Registramos o repasse das suas comissões aprovadas: {{amount}}.\n\nReferência do pagamento: {{reference}}. Os detalhes estão na sua área de Indicações.',
  },
  'zoom.class.registration.confirmed': {
    subject: 'Inscrição confirmada: {{topic}}',
    body: 'Você se inscreveu na aula ao vivo "{{topic}}" ({{startsAt}}).{{#classUrl}}\n\nQuando chegar a hora, você poderá entrar pela página da aula:\n{{classUrl}}{{/classUrl}}{{#calendarGoogleUrl}}\n\nSalve no seu calendário para não perder:\nGoogle Calendar: {{calendarGoogleUrl}}{{/calendarGoogleUrl}}{{#calendarIcsUrl}}\nOutlook, Apple e outros: {{calendarIcsUrl}}{{/calendarIcsUrl}}\n\nVamos avisar você de novo 2 horas antes do início.',
  },
  'zoom.class.reminder': {
    subject: 'Sua aula "{{topic}}" começa em {{hoursBefore}} h',
    body: 'Lembrete: a aula ao vivo "{{topic}}" começa {{startsAt}}.{{#classUrl}}\n\nEntre pela página da aula:\n{{classUrl}}{{/classUrl}}{{#calendarGoogleUrl}}\n\nAinda não está no seu calendário?\nGoogle Calendar: {{calendarGoogleUrl}}{{/calendarGoogleUrl}}{{#calendarIcsUrl}}\nOutlook, Apple e outros: {{calendarIcsUrl}}{{/calendarIcsUrl}}',
  },
  'zoom.class.cancelled': {
    subject: 'Aula cancelada: {{topic}}',
    body: 'A aula ao vivo "{{topic}}" prevista para {{startsAt}} foi cancelada.\n\nSe for reagendada, você a verá de novo no calendário.',
  },
  'surveys.post_class.invitation': {
    subject: 'Avalie a aula: {{topic}}',
    body: 'O que você achou de "{{topic}}"? São 30 segundos e a resposta é anônima: ela nos ajuda a decidir o que gravar e o que melhorar.{{#surveyUrl}}\n\nResponda pela página da aula:\n{{surveyUrl}}{{/surveyUrl}}',
  },
  'surveys.post_class.reminder': {
    subject: 'Um instante: o que você achou de "{{topic}}"?',
    body: 'Você se inscreveu em "{{topic}}", que aconteceu ontem, e ainda não nos contou o que achou. São 30 segundos e a resposta é anônima — ela realmente nos ajuda a melhorar as próximas aulas.{{#surveyUrl}}\n\nAvalie pela página da aula:\n{{surveyUrl}}{{/surveyUrl}}\n\n(Se você já avaliou por outra conta ou não chegou a participar, ignore esta mensagem.)',
  },
};

/**
 * Defaults del hub indexados por idioma. ADITIVO: `HUB_TEMPLATE_DEFAULTS` sigue
 * exportándose tal cual y sus 16 importadores no cambian.
 */
export const HUB_TEMPLATE_DEFAULTS_BY_LOCALE: Record<
  HubTemplateLang,
  Record<string, TemplateDef>
> = {
  es: HUB_TEMPLATE_DEFAULTS,
  en: HUB_TEMPLATE_DEFAULTS_EN,
  pt: HUB_TEMPLATE_DEFAULTS_PT,
};

/**
 * Default del producto para (key, locale). Devuelve `undefined` SOLO si la key
 * no existe en el catálogo — un idioma sin traducir nunca produce `undefined`,
 * cae al español (`HUB_DEFAULT_LOCALE`) de forma deliberada.
 */
export function resolveHubDefault(key: string, locale?: string | null): TemplateDef | undefined {
  const lang = toHubTemplateLang(locale);
  return HUB_TEMPLATE_DEFAULTS_BY_LOCALE[lang][key] ?? HUB_TEMPLATE_DEFAULTS[key];
}

// ─── Copy FIJO de los emails (no personalizable) por idioma ─────────────────

/**
 * Copy que se añade SIEMPRE a un email y que un override per-tenant NO puede
 * editar: etiquetas de botón CTA, títulos del bloque de marca y rellenos.
 *
 * Vive aquí —y no incrustado en cada composer— por la misma razón que
 * `HUB_TEMPLATE_DEFAULTS_EN`: para que traducir un email sea tocar UN fichero y
 * para que un test pueda comprobar que ningún idioma se queda corto. Antes de
 * esta tabla, un destinatario con `locale = 'en-US'` recibía un cuerpo en
 * inglés con un botón en español.
 *
 * La lista de idiomas es la MISMA lista cerrada del hub (`HUB_TEMPLATE_LANGS`):
 * cualquier locale sin catálogo cae a `HUB_DEFAULT_LOCALE` vía
 * `toHubTemplateLang`.
 */
export const FIXED_EMAIL_COPY = {
  es: {
    'cta.hub_enter': 'Entrar a {{tenantName}}',
    'cta.manage_subscription': 'Gestionar mi suscripción',
    'cta.password_reset': 'Restablecer contraseña',
    'cta.set_my_password': 'Definir mi contraseña',
    'cta.set_password': 'Define tu contraseña',
    'cta.signin': 'Entrar',
    'footer.hub_member': 'Recibiste este correo como miembro de {{tenantName}}.',
    'footer.signin_hint': 'Después podrás iniciar sesión desde {{signinUrl}} con tu email.',
    'cta.decision_approve': 'Aprobar',
    'cta.decision_reject': 'Rechazar',
    'label.applicant_email': 'Email',
    'label.applicant_name': 'Nombre',
    'label.applicant_telegram': 'Telegram ID',
    'label.otp_code': 'Código',
    // Bloque de decisión al aprobador (`buildDecisionEmail`). Es ESTRUCTURAL:
    // un override del tenant edita el asunto y la intro, nunca estos rótulos.
    'decision.delinquent': '⚠ CONSTA COMO IMPAGO',
    'decision.membership_in_group': 'Miembro del grupo de {{tenantName}}',
    'decision.membership_not_in_group': 'NO está en el grupo - revisar caso',
    'decision.membership_unknown': 'Pertenencia NO verificable (error Telegram)',
    'decision.partial_result': '⚠ Resultado parcial',
    'decision.partial_result_html':
      '⚠ Resultado parcial: no se pudo consultar {{count}} cuenta(s) de pago ({{names}}).',
    'decision.partial_suffix': ' (no se pudo consultar {{count}} cuenta(s) de pago: {{names}})',
    'decision.purchases': 'Compras detectadas ({{count}})',
    'decision.state': 'Estado',
    'decision.subscription_active': 'Suscripción vigente',
    'decision.subscription_inactive': '⚠ Suscripción NO vigente (baja o impago)',
    'decision.subscription_inactive_html': '⚠ Suscripción no vigente (baja o impago)',
    'decision.subscription_none': 'Suscripción detectada: ninguna en las cuentas de pago conectadas.', // prettier-ignore
    'decision.subscription_none_html': 'Sin suscripción detectada en las cuentas de pago conectadas.', // prettier-ignore
    'decision.subscription_unverifiable':
      '⚠ No se pudo verificar la suscripción{{suffix}}. Revisar manualmente antes de decidir.',
    'decision.subscription_unverifiable_html':
      '⚠ No se pudo verificar la suscripción ({{names}}). Revisar manualmente antes de decidir.',
    'title.member_rejection': 'Sobre tu inscripción',
    'title.member_welcome': '¡Bienvenido!',
    'title.otp_code': 'Tu código de acceso',
    'title.password_reset': 'Restablecer tu contraseña',
    'title.smtp_test': 'Prueba de SMTP',
    'title.subscriptions_digest': 'Resumen de suscripciones',
    'value.no_upcoming_renewals': 'Ninguna en los próximos {{windowDays}} días.',
    'value.subscription': 'Suscripción',
    'value.unknown_tenant_slug': '(desconocido)',
    'value.your_access': 'tu acceso',
  },
  en: {
    'cta.hub_enter': 'Go to {{tenantName}}',
    'cta.manage_subscription': 'Manage my subscription',
    'cta.password_reset': 'Reset password',
    'cta.set_my_password': 'Set my password',
    'cta.set_password': 'Set your password',
    'cta.signin': 'Sign in',
    'footer.hub_member': 'You received this email as a member of {{tenantName}}.',
    'footer.signin_hint': 'From then on you can sign in at {{signinUrl}} with your email.',
    'cta.decision_approve': 'Approve',
    'cta.decision_reject': 'Reject',
    'label.applicant_email': 'Email',
    'label.applicant_name': 'Name',
    'label.applicant_telegram': 'Telegram ID',
    'label.otp_code': 'Code',
    'decision.delinquent': '⚠ RECORDED AS UNPAID',
    'decision.membership_in_group': 'Member of the {{tenantName}} group',
    'decision.membership_not_in_group': 'NOT in the group - review this case',
    'decision.membership_unknown': 'Membership NOT verifiable (Telegram error)',
    'decision.partial_result': '⚠ Partial result',
    'decision.partial_result_html':
      '⚠ Partial result: {{count}} payment account(s) could not be queried ({{names}}).',
    'decision.partial_suffix': ' ({{count}} payment account(s) could not be queried: {{names}})',
    'decision.purchases': 'Purchases found ({{count}})',
    'decision.state': 'Status',
    'decision.subscription_active': 'Active subscription',
    'decision.subscription_inactive': '⚠ Subscription NOT active (cancelled or unpaid)',
    'decision.subscription_inactive_html': '⚠ Subscription not active (cancelled or unpaid)',
    'decision.subscription_none': 'Subscriptions found: none in the connected payment accounts.',
    'decision.subscription_none_html': 'No subscription found in the connected payment accounts.',
    'decision.subscription_unverifiable':
      '⚠ The subscription could not be verified{{suffix}}. Review it manually before deciding.',
    'decision.subscription_unverifiable_html':
      '⚠ The subscription could not be verified ({{names}}). Review it manually before deciding.',
    'title.member_rejection': 'About your registration',
    'title.member_welcome': 'Welcome!',
    'title.otp_code': 'Your access code',
    'title.password_reset': 'Reset your password',
    'title.smtp_test': 'SMTP test',
    'title.subscriptions_digest': 'Subscriptions digest',
    'value.no_upcoming_renewals': 'None in the next {{windowDays}} days.',
    'value.subscription': 'Subscription',
    'value.unknown_tenant_slug': '(unknown)',
    'value.your_access': 'your access',
  },
  pt: {
    'cta.hub_enter': 'Acessar {{tenantName}}',
    'cta.manage_subscription': 'Gerenciar minha assinatura',
    'cta.password_reset': 'Redefinir senha',
    'cta.set_my_password': 'Definir minha senha',
    'cta.set_password': 'Defina sua senha',
    'cta.signin': 'Entrar',
    'footer.hub_member': 'Você recebeu este e-mail por ser membro de {{tenantName}}.',
    'footer.signin_hint': 'Depois, você poderá entrar em {{signinUrl}} com seu e-mail.',
    'cta.decision_approve': 'Aprovar',
    'cta.decision_reject': 'Rejeitar',
    'label.applicant_email': 'E-mail',
    'label.applicant_name': 'Nome',
    'label.applicant_telegram': 'Telegram ID',
    'label.otp_code': 'Código',
    'decision.delinquent': '⚠ CONSTA COMO INADIMPLENTE',
    'decision.membership_in_group': 'Membro do grupo de {{tenantName}}',
    'decision.membership_not_in_group': 'NÃO está no grupo - revisar o caso',
    'decision.membership_unknown': 'Participação NÃO verificável (erro do Telegram)',
    'decision.partial_result': '⚠ Resultado parcial',
    'decision.partial_result_html':
      '⚠ Resultado parcial: não foi possível consultar {{count}} conta(s) de pagamento ({{names}}).',
    'decision.partial_suffix':
      ' (não foi possível consultar {{count}} conta(s) de pagamento: {{names}})',
    'decision.purchases': 'Compras detectadas ({{count}})',
    'decision.state': 'Status',
    'decision.subscription_active': 'Assinatura ativa',
    'decision.subscription_inactive': '⚠ Assinatura NÃO ativa (cancelada ou inadimplente)',
    'decision.subscription_inactive_html': '⚠ Assinatura não ativa (cancelada ou inadimplente)',
    'decision.subscription_none': 'Assinatura detectada: nenhuma nas contas de pagamento conectadas.', // prettier-ignore
    'decision.subscription_none_html': 'Nenhuma assinatura detectada nas contas de pagamento conectadas.', // prettier-ignore
    'decision.subscription_unverifiable':
      '⚠ Não foi possível verificar a assinatura{{suffix}}. Revise manualmente antes de decidir.',
    'decision.subscription_unverifiable_html':
      '⚠ Não foi possível verificar a assinatura ({{names}}). Revise manualmente antes de decidir.',
    'title.member_rejection': 'Sobre sua inscrição',
    'title.member_welcome': 'Boas-vindas!',
    'title.otp_code': 'Seu código de acesso',
    'title.password_reset': 'Redefinir sua senha',
    'title.smtp_test': 'Teste de SMTP',
    'title.subscriptions_digest': 'Resumo de assinaturas',
    'value.no_upcoming_renewals': 'Nenhuma nos próximos {{windowDays}} dias.',
    'value.subscription': 'Assinatura',
    'value.unknown_tenant_slug': '(desconhecido)',
    'value.your_access': 'seu acesso',
  },
} as const satisfies Record<HubTemplateLang, Record<string, string>>;

export type FixedEmailCopyKey = keyof (typeof FIXED_EMAIL_COPY)['es'];

/** Copy fijo en el idioma del destinatario. Nunca `undefined`: la key es cerrada. */
export function resolveFixedEmailCopy(key: FixedEmailCopyKey, locale?: string | null): string {
  return FIXED_EMAIL_COPY[toHubTemplateLang(locale)][key];
}

/**
 * Saludo de apertura de los emails transaccionales en el idioma del
 * destinatario. La condición es de VERACIDAD (no `trim()`) a propósito: así el
 * español sale byte a byte igual que antes de existir esta función.
 */
export function emailGreeting(name: string | null | undefined, locale?: string | null): string {
  const lang = toHubTemplateLang(locale);
  if (lang === 'en') return name ? `Hi ${name},` : 'Hi,';
  // El portugués pide coma de vocativo («Olá, Ana»); con la coma final de las
  // otras dos lenguas quedarían dos seguidas, así que cierra con exclamación,
  // que es además el saludo habitual de un correo de producto en Brasil.
  if (lang === 'pt') return name ? `Olá, ${name}!` : 'Olá!';
  return name ? `Hola ${name},` : 'Hola,';
}

/**
 * Ping de diagnóstico de SMTP de `POST /tenant-settings/notifications/smtp/test`.
 *
 * NO está en el catálogo de `/admin/emails` a propósito: no es un email del
 * producto que un tenant quiera personalizar, es una comprobación técnica que
 * el admin se manda a sí mismo. Pero sí tiene que salir en SU idioma, así que
 * el copy vive aquí, con la misma resolución por idioma que el resto.
 *
 * (El otro test de SMTP, el de `/admin/tenant-settings/smtp`, sí es del
 * catálogo: es la key de hub `admin.smtp.test`.)
 */
export const SMTP_SETTINGS_PING: Record<HubTemplateLang, TemplateDef> = {
  es: {
    subject: 'Prueba de SMTP — Didacta',
    body: 'Si recibiste este correo, la configuración SMTP de tu tenant en Didacta funciona correctamente.\n\nTenant: {{tenantSlug}}\nFecha: {{timestamp}}',
  },
  en: {
    subject: 'SMTP test — Didacta',
    body: 'If you received this email, the SMTP configuration of your tenant in Didacta is working correctly.\n\nTenant: {{tenantSlug}}\nDate: {{timestamp}}',
  },
  pt: {
    subject: 'Teste de SMTP — Didacta',
    body: 'Se você recebeu este e-mail, a configuração SMTP do seu tenant na Didacta está funcionando corretamente.\n\nTenant: {{tenantSlug}}\nData: {{timestamp}}',
  },
};

/** El ping de SMTP en el idioma del admin que lo dispara. */
export function resolveSmtpSettingsPing(locale?: string | null): TemplateDef {
  return SMTP_SETTINGS_PING[toHubTemplateLang(locale)];
}

/**
 * Locale BCP-47 con el que formatear fechas dentro de un email. Los emails
 * llevan fechas «bonitas» (`24 de julio de 2026`), y `toLocaleDateString` con
 * `es-ES` cableado escribía esa fecha en español dentro de un email inglés.
 *
 * Devuelve un locale COMPLETO (no el idioma base) porque `Intl` necesita región
 * para elegir el orden día/mes. Misma lista cerrada que el resto del catálogo:
 * lo que no tenga catálogo cae a `HUB_DEFAULT_LOCALE`.
 *
 * También lo usan los importes de las notificaciones (`hub-values.ts`): con
 * `pt-BR` una comisión sale como «R$ 12,50» / «€ 12,50», no como «12,50 €».
 */
export const EMAIL_DATE_LOCALE: Record<HubTemplateLang, string> = {
  es: HUB_DEFAULT_LOCALE,
  en: 'en-US',
  pt: 'pt-BR',
};

/** Locale de formateo de fechas para el idioma del destinatario. */
export function emailDateLocale(locale?: string | null): string {
  return EMAIL_DATE_LOCALE[toHubTemplateLang(locale)];
}

/**
 * Email de INVITACIÓN al aula (`invitation-email.ts`).
 *
 * NO tiene entrada en `/admin/emails` — igual que `SMTP_SETTINGS_PING`, y por
 * la misma razón de alcance: darle una la convertiría en una plantilla
 * personalizable per-tenant, que es una decisión de PRODUCTO y no de idioma.
 * Aquí solo se traduce lo que ya existía.
 *
 * El copy vive troceado (y no como un `body` único) porque este email tiene
 * maqueta propia: una lista ordenada de 3 pasos, una nota gris y el enlace
 * copiable. Troceándolo, los dos idiomas comparten EXACTAMENTE la misma
 * maqueta y el español sale byte a byte igual que antes.
 */
export const INVITATION_EMAIL_COPY = {
  es: {
    subject: '{{tenantName}} te ha invitado a su aula',
    title: 'Tu cuenta ya está lista',
    // `introHtml` lleva el `<strong>` de la maqueta; `{{tenantName}}` entra YA
    // escapado (lo escapa el composer), así que interpolarlo no abre XSS.
    introHtml:
      '<strong>{{tenantName}}</strong> te ha invitado a su aula y <strong>tu cuenta ya está creada</strong>. No tienes que registrarte: solo elegir una contraseña para entrar por primera vez.',
    introText:
      '{{tenantName}} te ha invitado a su aula y tu cuenta ya está creada. No tienes que registrarte: solo elegir una contraseña para entrar por primera vez.',
    step1: 'Pulsa el botón de abajo: te lleva directo a elegir tu contraseña.',
    step2: 'Completa tu perfil en un par de pasos.',
    step3: 'Listo: ya puedes entrar al aula cuando quieras.',
    validityNote: 'Tarda menos de un minuto · el enlace es personal y vale {{validez}}.',
    validityText: 'El enlace es personal y vale {{validez}}.',
    linkFallback: '¿No funciona el botón? Copia este enlace en tu navegador:',
    help: 'Si te atascas en cualquier paso, responde a este correo y te echamos una mano.',
    cta: 'Crear mi contraseña y entrar',
    footerNote: 'Recibes este correo porque {{tenantName}} te ha dado de alta en su aula.',
    dayOne: 'día',
    dayMany: 'días',
  },
  en: {
    subject: '{{tenantName}} has invited you to their classroom',
    title: 'Your account is ready',
    introHtml:
      '<strong>{{tenantName}}</strong> has invited you to their classroom and <strong>your account is already created</strong>. You do not have to sign up: you only have to choose a password to get in for the first time.',
    introText:
      '{{tenantName}} has invited you to their classroom and your account is already created. You do not have to sign up: you only have to choose a password to get in for the first time.',
    step1: 'Press the button below: it takes you straight to choosing your password.',
    step2: 'Complete your profile in a couple of steps.',
    step3: 'Done: you can enter the classroom whenever you like.',
    validityNote: 'It takes less than a minute · the link is personal and valid for {{validez}}.',
    validityText: 'The link is personal and valid for {{validez}}.',
    linkFallback: 'Button not working? Copy this link into your browser:',
    help: 'If you get stuck at any step, reply to this email and we will give you a hand.',
    cta: 'Create my password and get in',
    footerNote:
      'You are receiving this email because {{tenantName}} signed you up to their classroom.',
    dayOne: 'day',
    dayMany: 'days',
  },
  // «sala de aula» y no «aula»: en portugués «aula» es la lección/clase, no el
  // lugar. Sin posesivo («su aula»): «sua sala de aula» se leería como la del
  // invitado, no la de la academia.
  pt: {
    subject: '{{tenantName}} convidou você para a sala de aula',
    title: 'Sua conta já está pronta',
    introHtml:
      '<strong>{{tenantName}}</strong> convidou você para a sala de aula e <strong>sua conta já está criada</strong>. Você não precisa se cadastrar: basta escolher uma senha para entrar pela primeira vez.',
    introText:
      '{{tenantName}} convidou você para a sala de aula e sua conta já está criada. Você não precisa se cadastrar: basta escolher uma senha para entrar pela primeira vez.',
    step1: 'Clique no botão abaixo: ele leva você direto para escolher sua senha.',
    step2: 'Complete seu perfil em poucos passos.',
    step3: 'Pronto: você já pode entrar na sala de aula quando quiser.',
    validityNote: 'Leva menos de um minuto · o link é pessoal e vale por {{validez}}.',
    validityText: 'O link é pessoal e vale por {{validez}}.',
    linkFallback: 'O botão não funciona? Copie este link no seu navegador:',
    help: 'Se você travar em algum passo, responda a este e-mail e nós ajudamos.',
    cta: 'Criar minha senha e entrar',
    footerNote: 'Você recebe este e-mail porque {{tenantName}} cadastrou você na sala de aula.',
    dayOne: 'dia',
    dayMany: 'dias',
  },
} as const satisfies Record<HubTemplateLang, Record<string, string>>;

/** Piezas de copy de la invitación, ya ensanchadas a `string` por idioma. */
export type InvitationEmailCopy = Record<keyof (typeof INVITATION_EMAIL_COPY)['es'], string>;

/** Copy de la invitación al aula en el idioma del invitado. */
export function resolveInvitationEmailCopy(locale?: string | null): InvitationEmailCopy {
  return INVITATION_EMAIL_COPY[toHubTemplateLang(locale)];
}

/** Metadatos de los templates del hub para la UI (nombre humano, trigger, vars). */
const HUB_TEMPLATE_META: Record<
  string,
  Pick<EmailTemplateCatalogEntry, 'name' | 'description' | 'category' | 'channels' | 'variables'>
> = {
  'enrollment.created': {
    name: 'Matrícula creada',
    description: 'Cuando un alumno se matricula en un curso.',
    category: 'learning',
    channels: ['IN_APP'],
    variables: [
      { name: 'course', description: 'Nombre del curso' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'course.completed': {
    name: 'Curso completado',
    description: 'Cuando un alumno completa el 100% de un curso.',
    category: 'learning',
    channels: ['IN_APP'],
    variables: [
      { name: 'course', description: 'Nombre del curso' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'certificate.issued': {
    name: 'Certificado emitido',
    description: 'Cuando se emite el certificado de un curso completado.',
    category: 'learning',
    channels: ['IN_APP'],
    variables: [
      { name: 'course', description: 'Nombre del curso' },
      { name: 'number', description: 'Número del certificado' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'attempt.passed': {
    name: 'Quiz aprobado',
    description: 'Cuando un intento de quiz supera el umbral de aprobado.',
    category: 'learning',
    channels: ['IN_APP'],
    variables: [
      { name: 'quiz', description: 'Nombre del quiz' },
      { name: 'course', description: 'Nombre del curso' },
      { name: 'scorePercent', description: 'Puntuación (%)' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'attempt.failed': {
    name: 'Quiz no aprobado',
    description: 'Cuando un intento de quiz queda por debajo del umbral.',
    category: 'learning',
    channels: ['IN_APP'],
    variables: [
      { name: 'quiz', description: 'Nombre del quiz' },
      { name: 'scorePercent', description: 'Puntuación (%)' },
      { name: 'passThreshold', description: 'Umbral de aprobado (%)' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'attempt.graded': {
    name: 'Quiz corregido por el formador',
    description: 'Cuando el formador corrige manualmente un intento.',
    category: 'learning',
    channels: ['IN_APP'],
    variables: [
      { name: 'quiz', description: 'Nombre del quiz' },
      { name: 'scorePercent', description: 'Puntuación (%)' },
      { name: 'result', description: 'Resultado (aprobado/no aprobado)' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'admin.smtp.test': {
    name: 'Prueba de SMTP',
    description: 'Email de prueba al verificar la configuración SMTP.',
    category: 'system',
    channels: ['EMAIL'],
    variables: [
      { name: 'tenantName', description: 'Nombre de la plataforma' },
      { name: 'tenantSlug', description: 'Slug del tenant' },
      { name: 'timestamp', description: 'Fecha/hora de la prueba' },
    ],
  },
  'community.mention': {
    name: 'Mención en la comunidad',
    description: 'Cuando alguien te menciona en un post o comentario.',
    category: 'community',
    channels: ['IN_APP'],
    variables: [
      { name: 'authorName', description: 'Quién mencionó' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'community.comment.on_post': {
    name: 'Comentario en tu publicación',
    description: 'Cuando alguien comenta una publicación tuya.',
    category: 'community',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'actorName', description: 'Quién comentó' },
      { name: 'postTitle', description: 'Título de la publicación' },
      { name: 'excerpt', description: 'Extracto del comentario' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'community.reply.to_comment': {
    name: 'Respuesta a tu comentario',
    description: 'Cuando alguien responde a un comentario tuyo.',
    category: 'community',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'actorName', description: 'Quién respondió' },
      { name: 'postTitle', description: 'Título de la publicación' },
      { name: 'excerpt', description: 'Extracto de la respuesta' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'community.digest.weekly': {
    name: 'Resumen semanal de la comunidad',
    description: 'Digest semanal con menciones y respuestas pendientes.',
    category: 'community',
    channels: ['EMAIL'],
    variables: [
      { name: 'mentionsCount', description: 'Nº de menciones nuevas' },
      { name: 'repliesCount', description: 'Nº de respuestas nuevas' },
      { name: 'sinceIso', description: 'Fecha del resumen anterior' },
      {
        name: 'unsubUrl',
        description: 'Enlace de baja de los correos de la comunidad (resumen y avisos)',
      },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'community.broadcast': {
    name: 'Aviso de la comunidad (broadcast)',
    description:
      'Aviso masivo enviado desde /admin/broadcasts. El asunto y el cuerpo los escribe el admin al enviarlo.',
    category: 'community',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'subject', description: 'Asunto escrito por el admin' },
      { name: 'body', description: 'Mensaje escrito por el admin' },
      { name: 'postUrl', description: 'Enlace a la publicación (vacío si el aviso no la lleva)' },
      {
        name: 'unsubUrl',
        description:
          'Enlace de baja de los correos de la comunidad: avisos y resumen (solo en el email)',
      },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'lesson.unlocked': {
    name: 'Clase desbloqueada',
    description: 'Cuando una clase programada por fecha se desbloquea (drip).',
    category: 'learning',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'lessonTitle', description: 'Título de la clase' },
      { name: 'courseTitle', description: 'Título del curso' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'gamification.level.reached': {
    name: 'Nuevo nivel alcanzado',
    description: 'Cuando un miembro cruza los puntos de un nivel.',
    category: 'community',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'levelName', description: 'Nombre del nivel alcanzado' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'gamification.challenge.approved': {
    name: 'Reto aprobado',
    description: 'Cuando el equipo aprueba la entrega de un reto y acredita los puntos.',
    category: 'community',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'title', description: 'Título del reto' },
      { name: 'points', description: 'Puntos concedidos' },
      { name: 'reviewNote', description: 'Comentario del equipo (puede ir vacío)' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'gamification.challenge.rejected': {
    name: 'Reto no aprobado',
    description: 'Cuando el equipo rechaza la entrega de un reto.',
    category: 'community',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'title', description: 'Título del reto' },
      { name: 'reviewNote', description: 'Motivo o qué falta (puede ir vacío)' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'gamification.staff.pending': {
    name: 'Aviso al equipo: algo pendiente de revisar',
    description:
      'Cuando llega una entrega de reto o una solicitud de beneficio. Solo dentro de la plataforma.',
    category: 'community',
    channels: ['IN_APP'],
    variables: [
      { name: 'message', description: 'Qué ha llegado' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'gamification.perk.handled': {
    name: 'Solicitud de beneficio atendida',
    description: 'Cuando el equipo aprueba, completa o rechaza la petición de un beneficio.',
    category: 'community',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'perkTitle', description: 'Beneficio solicitado' },
      { name: 'statusText', description: 'Frase según el resultado (aprobada, hecha o rechazada)' },
      { name: 'staffNote', description: 'Respuesta del equipo (puede ir vacío)' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'referrals.commission.earned': {
    name: 'Comisión de referido ganada',
    description: 'Cuando un pago de un referido genera una comisión para el miembro.',
    category: 'billing',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'amount', description: 'Importe de la comisión (ej. «2,97 €»)' },
      { name: 'baseAmount', description: 'Importe del cobro que la originó' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'referrals.payout.recorded': {
    name: 'Liquidación de referidos pagada',
    description: 'Cuando el admin registra la liquidación de comisiones aprobadas.',
    category: 'billing',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'amount', description: 'Total liquidado (ej. «45,00 €»)' },
      { name: 'reference', description: 'Referencia externa del pago' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'zoom.class.registration.confirmed': {
    name: 'Inscripción a clase en directo confirmada',
    description: 'Cuando un miembro se inscribe a una clase en directo (aula virtual Zoom).',
    category: 'learning',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'topic', description: 'Título de la clase' },
      { name: 'startsAt', description: 'Fecha y hora de inicio formateadas' },
      { name: 'classUrl', description: 'Enlace a la página de la clase (/live/…)' },
      { name: 'calendarGoogleUrl', description: 'Enlace para añadir la clase a Google Calendar' },
      {
        name: 'calendarIcsUrl',
        description: 'Descarga del evento .ics (Outlook, Apple Calendar y otros)',
      },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'zoom.class.reminder': {
    name: 'Recordatorio de clase en directo (2 h antes)',
    description:
      'Aviso automático a los inscritos poco antes de que empiece la clase. Se envía una sola vez por clase; si se reprograma, vuelve a enviarse a la hora nueva.',
    category: 'learning',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'topic', description: 'Título de la clase' },
      { name: 'startsAt', description: 'Cuándo empieza, en la zona horaria del formador' },
      { name: 'hoursBefore', description: 'Horas de antelación del aviso (2 por defecto)' },
      { name: 'classUrl', description: 'Enlace a la página de la clase (/live/…)' },
      { name: 'calendarGoogleUrl', description: 'Enlace para añadir la clase a Google Calendar' },
      {
        name: 'calendarIcsUrl',
        description: 'Descarga del evento .ics (Outlook, Apple Calendar y otros)',
      },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'zoom.class.cancelled': {
    name: 'Clase en directo cancelada',
    description: 'Cuando se cancela una clase en directo, avisa a cada miembro inscrito.',
    category: 'learning',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'topic', description: 'Título de la clase' },
      { name: 'startsAt', description: 'Fecha y hora que tenía la clase' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'surveys.post_class.invitation': {
    name: 'Encuesta post-clase',
    description:
      'Al terminar una clase en directo, invita a cada inscrito a valorarla (respuesta anónima).',
    category: 'learning',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'topic', description: 'Título de la clase' },
      { name: 'surveyUrl', description: 'Enlace a la página de la clase (/live/…)' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'surveys.post_class.reminder': {
    name: 'Recordatorio de encuesta post-clase',
    description:
      'A las 24h de crearse la encuesta, recuerda valorarla SOLO a los inscritos que aún no respondieron (un único recordatorio por clase).',
    category: 'learning',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'topic', description: 'Título de la clase' },
      { name: 'surveyUrl', description: 'Enlace a la página de la clase (/live/…)' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
};

// ─── Emails transaccionales (compuestos en código, override alpha.83) ────────

/**
 * Los `defaultSubject`/`defaultBody` REFLEJAN el copy hardcodeado de cada
 * composer (email-templates.ts, password-reset.service.ts, etc.). Se usan para
 * mostrar el default en la UI y como punto de partida al crear un override.
 * Si cambias el copy de un composer, actualiza el default aquí (hay test).
 */
export const TRANSACTIONAL_EMAIL_DEFS: EmailTemplateCatalogEntry[] = [
  {
    key: 'auth.password_reset',
    name: 'Restablecer contraseña',
    description:
      'Cuando un usuario pide restablecer su contraseña (o un admin le envía la invitación de acceso).',
    category: 'account',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject: 'Restablecer tu contraseña en {{tenantName}}',
    defaultBody:
      '{{greeting}}\n\nRecibimos una solicitud para restablecer la contraseña de tu cuenta en {{tenantName}}.\n\nPara definir una contraseña nueva, usa el botón de abajo (válido por {{ttlMinutes}} minutos).\n\nSi no fuiste tú, puedes ignorar este mensaje — tu contraseña actual sigue intacta.',
    variables: [
      { name: 'greeting', description: 'Saludo («Hola Nombre,» o «Hola,»)' },
      { name: 'userName', description: 'Nombre del usuario (puede estar vacío)' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
      { name: 'resetUrl', description: 'Enlace seguro de restablecimiento' },
      { name: 'ttlMinutes', description: 'Minutos de validez del enlace' },
    ],
    structuralNote:
      'El botón «Restablecer contraseña» con el enlace seguro se añade siempre al final.',
  },
  // Plantillas de mod.member-registration (`member_registration.*`):
  // registradas por el MÓDULO — sus defaults viven en el paquete y reflejan el
  // copy de los composers del host del módulo (hay test de coherencia).
  ...MEMBER_REGISTRATION_EMAIL_TEMPLATES,
  {
    key: 'enrollment.welcome',
    name: 'Bienvenida de alta por API',
    description:
      'Cuando el alta externa por API (n8n/Woo) crea un usuario nuevo con acceso a curso(s).',
    category: 'account',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject: 'Tu acceso a {{tenantName}}',
    defaultBody:
      '{{greeting}}\n\nSe ha creado tu cuenta en {{tenantName}} y ya tienes acceso a tu(s) curso(s).\n\nSolo te queda definir tu contraseña con el botón de abajo (el enlace vale 7 días).\n\nTu usuario es {{email}}. Si el enlace caduca, usa «¿Olvidaste tu contraseña?» en la pantalla de acceso.',
    variables: [
      { name: 'greeting', description: 'Saludo («Hola Nombre,» o «Hola,»)' },
      { name: 'name', description: 'Nombre del usuario (puede estar vacío)' },
      { name: 'email', description: 'Email del usuario' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
      { name: 'setPasswordUrl', description: 'Enlace mágico para definir contraseña' },
    ],
    structuralNote:
      'El botón «Define tu contraseña» con el enlace mágico se añade siempre al final.',
  },
  {
    key: 'membership.welcome',
    name: 'Bienvenida de la membresía',
    description:
      'Cuando la compra de la membresía (webhook de Stripe) crea al comprador como usuario.',
    category: 'billing',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject: 'Tu membresía en {{tenantName}}',
    defaultBody:
      '{{greeting}}\n\n¡Tu membresía en {{tenantName}} está activa! Ya tienes acceso a todos los cursos incluidos.\n\nPara entrar, define tu contraseña con el botón de abajo (el enlace es válido 7 días).',
    variables: [
      { name: 'greeting', description: 'Saludo («Hola Nombre,» o «Hola,»)' },
      { name: 'name', description: 'Nombre del comprador (puede estar vacío)' },
      { name: 'email', description: 'Email del comprador' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
      { name: 'setPasswordUrl', description: 'Enlace mágico para definir contraseña' },
      { name: 'signinUrl', description: 'URL de inicio de sesión' },
    ],
    structuralNote:
      'El botón «Definir mi contraseña» y la nota con la URL de acceso se añaden siempre.',
  },
  {
    key: 'billing.welcome',
    name: 'Bienvenida de compra de curso',
    description:
      'Cuando la compra pública de un curso suelto (webhook de Stripe) crea al comprador como usuario.',
    category: 'billing',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject: 'Tu curso en {{tenantName}}',
    defaultBody:
      '{{greeting}}\n\n¡Tu compra en {{tenantName}} está confirmada! Hemos creado tu cuenta y tu curso ya te espera dentro.\n\nPara entrar, define tu contraseña con el botón de abajo (el enlace es válido 7 días).',
    variables: [
      { name: 'greeting', description: 'Saludo («Hola Nombre,» o «Hola,»)' },
      { name: 'name', description: 'Nombre del comprador (puede estar vacío)' },
      { name: 'email', description: 'Email del comprador' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
      { name: 'setPasswordUrl', description: 'Enlace mágico para definir contraseña' },
      { name: 'signinUrl', description: 'URL de inicio de sesión' },
    ],
    structuralNote:
      'El botón «Definir mi contraseña» y la nota con la URL de acceso se añaden siempre.',
  },
  {
    key: 'subscriptions.renewal_warning',
    name: 'Aviso de renovación al suscriptor',
    description:
      'Aviso automático N días antes de que la suscripción externa del miembro se renueve.',
    category: 'billing',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject: 'Tu suscripción se renovará pronto',
    defaultBody:
      'Hola,\n\nTu suscripción{{#plan}} ({{plan}}){{/plan}} se renovará el {{renewalDate}}{{#amount}} por {{amount}}{{/amount}}.\n\n{{#cancelUrl}}Si no quieres continuar, puedes cancelarla antes de esa fecha con el botón de abajo.{{/cancelUrl}}{{^cancelUrl}}Si no quieres continuar, responde a este correo para cancelarla antes de esa fecha.{{/cancelUrl}}\n\nSi quieres seguir, no tienes que hacer nada.',
    variables: [
      { name: 'plan', description: 'Nombre del plan (puede estar vacío)' },
      { name: 'renewalDate', description: 'Fecha de renovación (ej. «24 de julio de 2026»)' },
      { name: 'amount', description: 'Importe con moneda (puede estar vacío)' },
      { name: 'cancelUrl', description: 'URL del portal de cancelación (puede estar vacía)' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
    structuralNote:
      'Si hay portal de Stripe configurado, el botón «Gestionar mi suscripción» se añade al final.',
  },
  {
    key: 'payment_connections.access_expiring',
    name: 'Aviso de fin de acceso (pago único con vigencia)',
    description:
      'Aviso automático N días antes de que termine un acceso comprado de una vez (p. ej. «Acceso ANUAL»). ' +
      'Es DISTINTO del aviso de renovación: este acceso no se renueva solo, hay que volver a comprarlo.',
    category: 'billing',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject: 'Tu acceso a {{tenantName}} termina el {{renewalDate}}',
    defaultBody:
      'Hola,\n\nTu acceso{{#plan}} a {{plan}}{{/plan}} termina el {{renewalDate}}.\n\nA diferencia de una suscripción, este acceso no se renueva solo: si quieres seguir, tendrás que renovarlo antes de esa fecha.\n\nSi ya lo has renovado, puedes ignorar este mensaje.',
    variables: [
      { name: 'plan', description: 'Producto comprado (puede estar vacío)' },
      { name: 'renewalDate', description: 'Fecha en que termina el acceso' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
    structuralNote:
      'No lleva botón: no hay portal que gestionar, la renovación es una compra nueva en la tienda.',
  },
  {
    key: 'subscriptions.admin_digest',
    name: 'Resumen diario de suscripciones (admins)',
    description:
      'Digest diario a los admins con las suscripciones activas y las próximas renovaciones.',
    category: 'billing',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject:
      'Resumen de suscripciones — {{activeCount}} activas, {{upcomingCount}} próximas ({{windowDays}} días)',
    defaultBody:
      'Suscripciones activas: {{activeCount}}\n\nPróximas a renovarse/caducar ({{windowDays}} días):\n{{upcomingList}}',
    variables: [
      { name: 'activeCount', description: 'Nº de suscripciones activas' },
      { name: 'upcomingCount', description: 'Nº de renovaciones próximas' },
      { name: 'windowDays', description: 'Días de la ventana del aviso' },
      { name: 'upcomingList', description: 'Lista formateada de próximas renovaciones' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
];

/**
 * Copy en INGLÉS de los transaccionales, indexado por la misma key.
 *
 * Es un mapa PARCIAL a propósito y no un espejo completo: una key ausente
 * significa «el composer de este email todavía solo sabe redactar en español»,
 * no un olvido. La regla de familia (composer y catálogo se tocan a la vez)
 * exige que traducir un composer añada aquí su entrada en el mismo commit; el
 * test de coherencia comprueba que toda key presente aquí existe en
 * `TRANSACTIONAL_EMAIL_DEFS` y conserva sus mismos placeholders.
 *
 * A diferencia del español —cuyo cuerpo lo maqueta cada composer con HTML
 * propio— el inglés se RENDERIZA desde aquí (`interpolate` + párrafos), igual
 * que un override de tenant. Así el composer inglés y el catálogo inglés no
 * pueden divergir: son el mismo texto.
 *
 * Composers que ya lo consumen:
 *  - `auth.password_reset`                 → apps/api/src/auth/password-reset.service.ts
 *  - `enrollment.welcome`                  → apps/api/src/enrollment/inscribe.service.ts
 *  - `member_registration.otp_code`        → apps/api/src/modules/member-registration/email-templates.ts
 *  - `member_registration.welcome_approved`→ idem
 *  - `member_registration.rejection`       → idem
 *  - `membership.welcome`                  → apps/api/src/modules/subscriptions/membership-provisioning.service.ts
 *  - `billing.welcome`                     → apps/api/src/modules/billing/billing-provisioning.service.ts
 *  - `subscriptions.renewal_warning`       → apps/api/src/modules/payment-connections/subscriptions-daily.worker.ts
 *  - `payment_connections.access_expiring` → idem
 *  - `subscriptions.admin_digest`          → idem
 *
 * Desde este PR NO queda ninguna key transaccional sin traducir. La última era
 * `member_registration.approval_request`, que estaba bloqueada porque las
 * etiquetas de estado de suscripción las redacta `classifySubscriptionStatus`
 * en `modules/payment-connections` y traducir solo la intro habría dejado un
 * email mitad inglés mitad español. Esa función admite ahora un idioma (con
 * español por defecto, así que sus otros tres consumidores no cambian) y el
 * resto del bloque estructural vive en `FIXED_EMAIL_COPY` (`decision.*`).
 */
export const TRANSACTIONAL_TEMPLATE_DEFAULTS_EN: Record<string, TemplateDef> = {
  'auth.password_reset': {
    subject: 'Reset your password at {{tenantName}}',
    body: '{{greeting}}\n\nWe received a request to reset the password of your account at {{tenantName}}.\n\nTo set a new password, use the button below (valid for {{ttlMinutes}} minutes).\n\nIf it was not you, you can ignore this message — your current password is still intact.',
  },
  'enrollment.welcome': {
    subject: 'Your access to {{tenantName}}',
    body: '{{greeting}}\n\nYour account at {{tenantName}} has been created and you already have access to your course(s).\n\nAll that is left is to set your password with the button below (the link is valid for 7 days).\n\nYour username is {{email}}. If the link expires, use "Forgot your password?" on the sign-in screen.',
  },
  'member_registration.otp_code': {
    subject: 'Your access code',
    body: 'Your access code for {{tenantName}} is the one shown below.\n\nEnter it on the verification screen to continue. This code expires in {{ttlMinutes}} minutes.\n\nIf you did not request this access, please ignore this message.',
  },
  'member_registration.approval_request': {
    subject: 'New registration pending — {{name}}',
    body: 'There is a new registration waiting for your approval at {{tenantName}}.',
  },
  'member_registration.welcome_approved': {
    subject: 'Your registration at {{tenantName}} has been approved',
    body: '{{greeting}}\n\nGood news! Your registration at {{tenantName}} has been approved and your account is now active.',
  },
  'member_registration.rejection': {
    subject: 'About your registration at {{tenantName}}',
    body: '{{greeting}}\n\nThank you for your interest in {{tenantName}}. After reviewing your request, we have not been able to approve your registration at this time.\n\nIf you believe this is a mistake, you can get in touch with the team.',
  },
  'membership.welcome': {
    subject: 'Your membership at {{tenantName}}',
    body: '{{greeting}}\n\nYour membership at {{tenantName}} is active! You already have access to every course included.\n\nTo get in, set your password with the button below (the link is valid for 7 days).',
  },
  'billing.welcome': {
    subject: 'Your course at {{tenantName}}',
    body: '{{greeting}}\n\nYour purchase at {{tenantName}} is confirmed! We have created your account and your course is waiting for you inside.\n\nTo get in, set your password with the button below (the link is valid for 7 days).',
  },
  'subscriptions.renewal_warning': {
    subject: 'Your subscription renews soon',
    body: 'Hi,\n\nYour subscription{{#plan}} ({{plan}}){{/plan}} renews on {{renewalDate}}{{#amount}} for {{amount}}{{/amount}}.\n\n{{#cancelUrl}}If you do not want to continue, you can cancel it before that date with the button below.{{/cancelUrl}}{{^cancelUrl}}If you do not want to continue, reply to this email to cancel it before that date.{{/cancelUrl}}\n\nIf you want to carry on, you do not have to do anything.',
  },
  'payment_connections.access_expiring': {
    subject: 'Your access to {{tenantName}} ends on {{renewalDate}}',
    body: 'Hi,\n\nYour access{{#plan}} to {{plan}}{{/plan}} ends on {{renewalDate}}.\n\nUnlike a subscription, this access does not renew on its own: if you want to carry on, you will have to renew it before that date.\n\nIf you have already renewed it, you can ignore this message.',
  },
  'subscriptions.admin_digest': {
    subject:
      'Subscriptions digest — {{activeCount}} active, {{upcomingCount}} upcoming ({{windowDays}} days)',
    body: 'Active subscriptions: {{activeCount}}\n\nRenewing/expiring soon ({{windowDays}} days):\n{{upcomingList}}',
  },
};

/**
 * Copy en PORTUGUÉS DE BRASIL de los transaccionales, indexado por la misma
 * key. Mismo contrato que `TRANSACTIONAL_TEMPLATE_DEFAULTS_EN`: mismos
 * placeholders que el español (hay test) y el composer lo RENDERIZA desde aquí
 * (`rendersFromCatalog`), así que composer y catálogo son el mismo texto.
 *
 * Nace COMPLETO: cubre las mismas keys que el inglés. Una key que faltara
 * caería al español en `resolveTransactionalDefault`, y el test de cobertura
 * lo convierte en fallo.
 *
 * Los dos avisos que en español e inglés abren con un saludo incrustado
 * («Hola,» / «Hi,») abren aquí con «Olá!», el mismo que da `emailGreeting`.
 */
export const TRANSACTIONAL_TEMPLATE_DEFAULTS_PT: Record<string, TemplateDef> = {
  'auth.password_reset': {
    subject: 'Redefinir sua senha em {{tenantName}}',
    body: '{{greeting}}\n\nRecebemos um pedido para redefinir a senha da sua conta em {{tenantName}}.\n\nPara definir uma nova senha, use o botão abaixo (válido por {{ttlMinutes}} minutos).\n\nSe não foi você, pode ignorar esta mensagem — sua senha atual continua a mesma.',
  },
  'enrollment.welcome': {
    subject: 'Seu acesso a {{tenantName}}',
    body: '{{greeting}}\n\nSua conta em {{tenantName}} foi criada e você já tem acesso ao(s) seu(s) curso(s).\n\nSó falta definir sua senha com o botão abaixo (o link vale por 7 dias).\n\nSeu usuário é {{email}}. Se o link expirar, use “Esqueceu sua senha?” na tela de login.',
  },
  'member_registration.otp_code': {
    subject: 'Seu código de acesso',
    body: 'Seu código de acesso a {{tenantName}} é o que aparece abaixo.\n\nDigite-o na tela de verificação para continuar. Este código expira em {{ttlMinutes}} minutos.\n\nSe você não solicitou este acesso, ignore esta mensagem.',
  },
  'member_registration.approval_request': {
    subject: 'Nova inscrição pendente — {{name}}',
    body: 'Há uma nova inscrição aguardando sua aprovação em {{tenantName}}.',
  },
  'member_registration.welcome_approved': {
    subject: 'Sua inscrição em {{tenantName}} foi aprovada',
    body: '{{greeting}}\n\nBoas notícias! Sua inscrição em {{tenantName}} foi aprovada e sua conta já está ativa.',
  },
  'member_registration.rejection': {
    subject: 'Sobre sua inscrição em {{tenantName}}',
    body: '{{greeting}}\n\nObrigado pelo seu interesse em {{tenantName}}. Depois de analisar sua solicitação, não foi possível aprovar sua inscrição neste momento.\n\nSe você acredita que houve um engano, entre em contato com a equipe.',
  },
  'membership.welcome': {
    subject: 'Sua assinatura em {{tenantName}}',
    body: '{{greeting}}\n\nSua assinatura em {{tenantName}} está ativa! Você já tem acesso a todos os cursos incluídos.\n\nPara entrar, defina sua senha com o botão abaixo (o link vale por 7 dias).',
  },
  'billing.welcome': {
    subject: 'Seu curso em {{tenantName}}',
    body: '{{greeting}}\n\nSua compra em {{tenantName}} está confirmada! Criamos sua conta e seu curso já está esperando por você.\n\nPara entrar, defina sua senha com o botão abaixo (o link vale por 7 dias).',
  },
  'subscriptions.renewal_warning': {
    subject: 'Sua assinatura será renovada em breve',
    body: 'Olá!\n\nSua assinatura{{#plan}} ({{plan}}){{/plan}} será renovada em {{renewalDate}}{{#amount}} por {{amount}}{{/amount}}.\n\n{{#cancelUrl}}Se você não quiser continuar, pode cancelá-la antes dessa data pelo botão abaixo.{{/cancelUrl}}{{^cancelUrl}}Se você não quiser continuar, responda a este e-mail para cancelá-la antes dessa data.{{/cancelUrl}}\n\nSe quiser continuar, não precisa fazer nada.',
  },
  'payment_connections.access_expiring': {
    subject: 'Seu acesso a {{tenantName}} termina em {{renewalDate}}',
    body: 'Olá!\n\nSeu acesso{{#plan}} a {{plan}}{{/plan}} termina em {{renewalDate}}.\n\nDiferente de uma assinatura, este acesso não se renova sozinho: se quiser continuar, você precisará renová-lo antes dessa data.\n\nSe você já renovou, pode ignorar esta mensagem.',
  },
  'subscriptions.admin_digest': {
    subject:
      'Resumo de assinaturas — {{activeCount}} ativas, {{upcomingCount}} próximas ({{windowDays}} dias)',
    body: 'Assinaturas ativas: {{activeCount}}\n\nPróximas de renovar/expirar ({{windowDays}} dias):\n{{upcomingList}}',
  },
};

/** Los transaccionales indexados por key, para resolver sin recorrer el array. */
const TRANSACTIONAL_DEFAULTS_ES: Record<string, TemplateDef> = Object.fromEntries(
  TRANSACTIONAL_EMAIL_DEFS.map((d) => [d.key, { subject: d.defaultSubject, body: d.defaultBody }]),
);

/** Los transaccionales por idioma. Mismo patrón que `HUB_TEMPLATE_DEFAULTS_BY_LOCALE`. */
const TRANSACTIONAL_DEFAULTS_BY_LANG: Record<HubTemplateLang, Record<string, TemplateDef>> = {
  es: TRANSACTIONAL_DEFAULTS_ES,
  en: TRANSACTIONAL_TEMPLATE_DEFAULTS_EN,
  pt: TRANSACTIONAL_TEMPLATE_DEFAULTS_PT,
};

/**
 * Copy por defecto de un email transaccional en el idioma pedido. Devuelve
 * `undefined` SOLO si la key no existe en el catálogo; un idioma sin traducir
 * cae al español (`HUB_DEFAULT_LOCALE`) de forma deliberada, igual que
 * `resolveHubDefault`.
 */
export function resolveTransactionalDefault(
  key: string,
  locale?: string | null,
): TemplateDef | undefined {
  return (
    TRANSACTIONAL_DEFAULTS_BY_LANG[toHubTemplateLang(locale)][key] ?? TRANSACTIONAL_DEFAULTS_ES[key]
  );
}

/**
 * ¿El cuerpo de este email se renderiza DESDE el catálogo (`interpolate` +
 * párrafos, la misma mecánica que un override de tenant) en vez de con la
 * maqueta HTML propia del composer?
 *
 * Solo el español conserva maqueta propia —es el copy original de cada
 * composer y sale byte a byte como siempre—. Toda TRADUCCIÓN se renderiza
 * desde el catálogo, para que composer y catálogo no puedan divergir.
 *
 * Existe para que los composers no pregunten `=== 'en'`: con esa pregunta, el
 * día que entró el portugués habrían caído todos a la rama española con el
 * asunto ya en portugués — un email mitad y mitad.
 */
export function rendersFromCatalog(locale?: string | null): boolean {
  return toHubTemplateLang(locale) !== 'es';
}

/**
 * Catálogo completo (hub + transaccionales) para la UI admin.
 *
 * `locale` es el idioma del OVERRIDE que el admin va a escribir, no el de la
 * pantalla: `/admin/emails` deja elegir (canal, idioma) y prefillea el editor
 * con el default del producto para ese par. Sin este parámetro el prefill salía
 * SIEMPRE en español, así que crear un override `en-US` empezaba copiando y
 * borrando un texto español.
 *
 * CAMINO DEGRADADO: `locale` ausente o sin catálogo cae a `HUB_DEFAULT_LOCALE`
 * vía `resolveHubDefault` / `resolveTransactionalDefault`. Omitirlo devuelve
 * byte a byte la respuesta de antes — es el default nombrado del producto, no
 * un accidente, y por eso los clientes viejos siguen viendo lo mismo.
 *
 * `name`, `description` y `category` NO se traducen todavía: son metadatos de
 * la UI del catálogo (36 entradas) y viven en `HUB_TEMPLATE_META` /
 * `TRANSACTIONAL_EMAIL_DEFS` solo en español. Es un hueco conocido y aparte.
 */
export function buildEmailTemplateCatalog(locale?: string | null): EmailTemplateCatalogEntry[] {
  const hubEntries: EmailTemplateCatalogEntry[] = Object.keys(HUB_TEMPLATE_DEFAULTS).map((key) => {
    const meta = HUB_TEMPLATE_META[key];
    // Nunca `undefined`: la key sale de HUB_TEMPLATE_DEFAULTS, que es el
    // último fallback de `resolveHubDefault`.
    const def = resolveHubDefault(key, locale)!;
    return {
      key,
      name: meta?.name ?? key,
      description: meta?.description ?? '',
      category: meta?.category ?? 'system',
      source: 'hub',
      channels: meta?.channels ?? ['IN_APP'],
      defaultSubject: def.subject,
      defaultBody: def.body,
      variables: meta?.variables ?? [],
    };
  });
  const transactional: EmailTemplateCatalogEntry[] = TRANSACTIONAL_EMAIL_DEFS.map((entry) => {
    const def = resolveTransactionalDefault(entry.key, locale);
    // Sin traducción para esa key, `resolveTransactionalDefault` devuelve el
    // español, que es exactamente lo que ya traía la entrada.
    return def ? { ...entry, defaultSubject: def.subject, defaultBody: def.body } : entry;
  });
  return [...transactional, ...hubEntries];
}

/** Todas las keys conocidas (hub + transaccionales), para /templates/keys. */
export function allKnownTemplateKeys(): string[] {
  return buildEmailTemplateCatalog().map((e) => e.key);
}

// ─── Resolución de overrides para emails transaccionales ─────────────────────

/** Override crudo (SIN interpolar) tal como está en `notification_template`. */
export interface RawEmailOverride {
  subject: string | null;
  body: string;
}

/** Cliente Prisma mínimo que necesita el fetch (evita acoplar al PrismaService). */
export interface TemplateOverridePrisma {
  notificationTemplate: {
    findUnique(args: unknown): Promise<{ subject: string | null; body: string } | null>;
  };
}

/**
 * Busca el override per-tenant de un email transaccional: (tenantId, key,
 * channel EMAIL, locale). Best-effort: cualquier error devuelve null y
 * el email sale con su copy por defecto — la personalización NUNCA rompe un
 * envío. La interpolación la hace el composer, que conoce las variables.
 *
 * `locale` es opcional y por defecto `HUB_DEFAULT_LOCALE`: un composer que
 * todavía no sepa el idioma del destinatario lo omite y busca exactamente la
 * misma fila que antes (una sola consulta, comportamiento byte a byte).
 *
 * Cuando el composer SÍ sabe el idioma, la precedencia es la MISMA que la de
 * `renderForTenant` en el hub: primero la fila del idioma pedido y, si no
 * existe, la del idioma de referencia. Un tenant que solo personalizó el correo
 * en español no pierde su personalización porque el destinatario esté en
 * inglés — el copy que el tenant escribió gana al default del producto, igual
 * que en el hub.
 */
export async function fetchEmailOverride(
  prisma: TemplateOverridePrisma,
  tenantId: string,
  key: string,
  locale: string = HUB_DEFAULT_LOCALE,
): Promise<RawEmailOverride | null> {
  const locales = locale === HUB_DEFAULT_LOCALE ? [locale] : [locale, HUB_DEFAULT_LOCALE];
  try {
    for (const candidate of locales) {
      const row = await prisma.notificationTemplate.findUnique({
        where: {
          tenantId_key_channel_locale: { tenantId, key, channel: 'EMAIL', locale: candidate },
        },
        select: { subject: true, body: true },
      });
      if (row) return { subject: row.subject, body: row.body };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Aplica un override crudo a un email: interpola subject/body con las
 * variables del composer. Si el override no define subject, se mantiene el
 * subject por defecto que pasa el caller.
 */
export function applyEmailOverride(
  override: RawEmailOverride,
  variables: Record<string, unknown>,
  fallbackSubject: string,
): { subject: string; bodyText: string } {
  const subject = override.subject?.trim()
    ? interpolate(override.subject, variables)
    : fallbackSubject;
  return { subject, bodyText: interpolate(override.body, variables) };
}
