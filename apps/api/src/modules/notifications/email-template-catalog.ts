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
 */

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
    body: 'Esta semana en la comunidad:\n\n· {{mentionsCount}} mención(es) nueva(s)\n· {{repliesCount}} respuesta(s) en hilos donde participaste\n\nRevísalas todas en tu sección de menciones. Desde el resumen anterior: {{sinceIso}}.',
  },
  // Aviso masivo (broadcast) a toda la comunidad. Passthrough: el worker compone
  // el asunto y el cuerpo (mensaje + enlace de baja en email) y los pasa como vars.
  'community.broadcast': {
    subject: '{{subject}}',
    body: '{{body}}',
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
  // {{classUrl}} — el joinUrl de Zoom NUNCA va por email: se ve en /clase/[id]
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
  // clase en directo. El enlace apunta a la página de la clase (/clase/[id]),
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
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
  'community.broadcast': {
    name: 'Aviso de la comunidad (broadcast)',
    description:
      'Aviso masivo enviado desde /admin/avisos. El asunto y el cuerpo los escribe el admin al enviarlo.',
    category: 'community',
    channels: ['IN_APP', 'EMAIL'],
    variables: [
      { name: 'subject', description: 'Asunto escrito por el admin' },
      { name: 'body', description: 'Mensaje escrito por el admin' },
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
      { name: 'classUrl', description: 'Enlace a la página de la clase (/clase/…)' },
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
      { name: 'classUrl', description: 'Enlace a la página de la clase (/clase/…)' },
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
      { name: 'surveyUrl', description: 'Enlace a la página de la clase (/clase/…)' },
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
      { name: 'surveyUrl', description: 'Enlace a la página de la clase (/clase/…)' },
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
  {
    key: 'inscripcion.otp_code',
    name: 'Código de acceso (OTP)',
    description: 'Código de un solo uso durante el alta de miembros (verificación de email).',
    category: 'members',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject: 'Tu código de acceso',
    defaultBody:
      'Tu código de acceso a {{tenantName}} es el que ves abajo.\n\nIntrodúcelo en la pantalla de verificación para continuar. Este código caduca en {{ttlMinutes}} minutos.\n\nSi no has solicitado este acceso, ignora este mensaje.',
    variables: [
      { name: 'tenantName', description: 'Nombre de la plataforma' },
      { name: 'ttlMinutes', description: 'Minutos de validez del código' },
      { name: 'code', description: 'El código (se muestra también en grande automáticamente)' },
    ],
    structuralNote: 'El código de un solo uso se muestra siempre en grande debajo del texto.',
  },
  {
    key: 'inscripcion.approval_request',
    name: 'Nueva inscripción pendiente (al aprobador)',
    description:
      'Aviso al aprobador cuando llega una solicitud de inscripción de miembro pendiente.',
    category: 'members',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject: 'Nueva inscripción pendiente — {{name}}',
    defaultBody: 'Hay una nueva inscripción pendiente de tu aprobación en {{tenantName}}.',
    variables: [
      { name: 'name', description: 'Nombre del solicitante' },
      { name: 'email', description: 'Email del solicitante' },
      { name: 'telegramId', description: 'Telegram ID del solicitante' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
    structuralNote:
      'Los datos del solicitante (grupo, impagos, suscripciones, compras) y los botones «Aprobar»/«Rechazar» se añaden siempre después del texto.',
  },
  {
    key: 'inscripcion.welcome_approved',
    name: 'Inscripción aprobada (bienvenida)',
    description: 'Cuando el aprobador aprueba la solicitud de inscripción del miembro.',
    category: 'members',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject: 'Tu inscripción en {{tenantName}} ha sido aprobada',
    defaultBody:
      '{{greeting}}\n\n¡Buenas noticias! Tu inscripción en {{tenantName}} ha sido aprobada y tu cuenta ya está activa.',
    variables: [
      { name: 'greeting', description: 'Saludo («Hola Nombre,» o «Hola,»)' },
      { name: 'name', description: 'Nombre del miembro (puede estar vacío)' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
      { name: 'signinUrl', description: 'URL de inicio de sesión' },
    ],
    structuralNote: 'El botón «Entrar» con el enlace de acceso se añade siempre al final.',
  },
  {
    key: 'inscripcion.rejection',
    name: 'Inscripción rechazada',
    description: 'Cuando el aprobador rechaza la solicitud de inscripción del miembro.',
    category: 'members',
    source: 'transactional',
    channels: ['EMAIL'],
    defaultSubject: 'Sobre tu inscripción en {{tenantName}}',
    defaultBody:
      '{{greeting}}\n\nGracias por tu interés en {{tenantName}}. Tras revisar tu solicitud, no hemos podido aprobar tu inscripción en este momento.\n\nSi crees que se trata de un error, puedes ponerte en contacto con el equipo.',
    variables: [
      { name: 'greeting', description: 'Saludo («Hola Nombre,» o «Hola,»)' },
      { name: 'name', description: 'Nombre del solicitante (puede estar vacío)' },
      { name: 'tenantName', description: 'Nombre de la plataforma' },
    ],
  },
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

/** Catálogo completo (hub + transaccionales) para la UI admin. */
export function buildEmailTemplateCatalog(): EmailTemplateCatalogEntry[] {
  const hubEntries: EmailTemplateCatalogEntry[] = Object.entries(HUB_TEMPLATE_DEFAULTS).map(
    ([key, def]) => {
      const meta = HUB_TEMPLATE_META[key];
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
    },
  );
  return [...TRANSACTIONAL_EMAIL_DEFS, ...hubEntries];
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
 * channel EMAIL, locale es-ES). Best-effort: cualquier error devuelve null y
 * el email sale con su copy por defecto — la personalización NUNCA rompe un
 * envío. La interpolación la hace el composer, que conoce las variables.
 */
export async function fetchEmailOverride(
  prisma: TemplateOverridePrisma,
  tenantId: string,
  key: string,
): Promise<RawEmailOverride | null> {
  try {
    const row = await prisma.notificationTemplate.findUnique({
      where: {
        tenantId_key_channel_locale: { tenantId, key, channel: 'EMAIL', locale: 'es-ES' },
      },
      select: { subject: true, body: true },
    });
    if (!row) return null;
    return { subject: row.subject, body: row.body };
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
