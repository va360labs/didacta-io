/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Opciones de un error de dominio. `detail` es el diagnóstico CRUDO que el
 * `message` español lleva incrustado (lo que responde Zoom): viaja como campo
 * APARTE hasta el front para que el catálogo inglés no se lo trague al traducir
 * por `code`. Contrato completo en `apps/api/src/common/module-error-body.ts`.
 */
export interface ZoomLiveErrorOptions {
  readonly detail?: string;
}

export class ZoomLiveError extends Error {
  readonly detail?: string;

  constructor(
    public readonly code: string,
    message: string,
    options?: ZoomLiveErrorOptions,
  ) {
    super(message);
    this.name = 'ZoomLiveError';
    this.detail = options?.detail;
  }
}

export class SessionNotFoundError extends ZoomLiveError {
  constructor(sessionId: string) {
    // SIN `detail` a propósito: `zoom-live.controller.ts:67` lanza este MISMO
    // code con otra frase española («Sesión no encontrada.»). Una sola key ES no
    // puede rendir las dos byte a byte, así que el code se queda en
    // `EN_ONLY_BY_DESIGN` — ver la cabecera de `messages-parity.test.ts` ①.
    super('ZOOM_SESSION_NOT_FOUND', `La sesión ${sessionId} no existe en este tenant.`);
  }
}

export class SessionAlreadyEndedError extends ZoomLiveError {
  constructor() {
    super('ZOOM_SESSION_ALREADY_ENDED', 'La sesión ya finalizó; no se puede modificar.');
  }
}

export class CourseNotInTenantError extends ZoomLiveError {
  constructor(courseId: string) {
    super('ZOOM_COURSE_NOT_IN_TENANT', `El curso ${courseId} no pertenece a este tenant.`, {
      detail: courseId,
    });
  }
}

/**
 * Lanzado cuando se intenta vincular `lessonId` a una sesión cuyo `courseId`
 * no contiene esa lección (o cuando hay `lessonId` sin `courseId`).
 */
export class LessonNotInCourseError extends ZoomLiveError {
  constructor() {
    super(
      'ZOOM_LESSON_NOT_IN_COURSE',
      'La lección indicada no pertenece al curso, o falta el courseId.',
    );
  }
}

/**
 * Lanzado al intentar inscribirse a una sesión que ya no admite
 * inscripciones (CANCELLED o ENDED). Las inscripciones solo están
 * abiertas mientras la sesión está SCHEDULED o STARTED.
 */
export class SessionNotOpenForRegistrationError extends ZoomLiveError {
  constructor() {
    super('ZOOM_SESSION_NOT_OPEN_FOR_REGISTRATION', 'La sesión ya no admite inscripciones.');
  }
}

/**
 * Lanzado al pedir el enlace de entrada (`POST .../join`) sin estar inscrito
 * ni ser staff. Es el mismo gating que oculta el `joinUrl` (ADR-017), pero
 * aquí sí queremos un error explícito en vez de un NULL silencioso: el
 * usuario ha pulsado un botón y merece saber por qué no pasa.
 */
export class NotRegisteredError extends ZoomLiveError {
  constructor() {
    super('ZOOM_NOT_REGISTERED', 'Tienes que inscribirte antes de entrar a la clase.');
  }
}

/**
 * Lanzado al pedir la reconciliación de asistencia de una sesión que todavía
 * no puede tenerla (no ha empezado, o fue cancelada, o no tiene meeting en
 * Zoom con el que reconciliar).
 */
export class AttendanceNotAvailableError extends ZoomLiveError {
  constructor(reason: string) {
    super('ZOOM_ATTENDANCE_NOT_AVAILABLE', reason);
  }
}

export class ZoomApiError extends ZoomLiveError {
  constructor(
    reason: string,
    /** Status HTTP de la respuesta de Zoom, si la hubo. */
    public readonly status?: number,
    /** Código de error propio de Zoom (`code` del body JSON). */
    public readonly zoomCode?: number,
  ) {
    super('ZOOM_API_ERROR', `Error hablando con Zoom: ${reason}`, { detail: reason });
  }
}

/**
 * El email del host no corresponde a ningún usuario de la cuenta de Zoom.
 *
 * Zoom crea las reuniones con `POST /users/{hostEmail}/meetings`, así que el
 * host tiene que existir COMO USUARIO en la cuenta de Zoom del tenant — ser
 * formador en Didacta no basta. Sin este error el formador solo veía
 * «Error hablando con Zoom: … 404: {"code":1001,…}», que no dice qué hacer.
 */
export class ZoomHostNotFoundError extends ZoomLiveError {
  constructor(hostEmail: string) {
    super(
      'ZOOM_HOST_NOT_FOUND',
      `El email del host (${hostEmail}) no es un usuario de vuestra cuenta de Zoom, así que Zoom no deja crear la reunión a su nombre. Usa el email de alguien que tenga usuario en la cuenta de Zoom, o añádelo primero desde zoom.us → Gestión de usuarios.`,
      { detail: hostEmail },
    );
  }
}

/**
 * Lanzado cuando la firma del webhook (`X-Zm-Signature`) no valida contra
 * el secret configurado. Equivale a un 401: rechazamos el evento sin
 * tocar la base de datos.
 */
export class InvalidWebhookSignatureError extends ZoomLiveError {
  constructor() {
    super('ZOOM_INVALID_WEBHOOK_SIGNATURE', 'Firma de webhook inválida.');
  }
}
