export class ZoomLiveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ZoomLiveError';
  }
}

export class SessionNotFoundError extends ZoomLiveError {
  constructor(sessionId: string) {
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
    super('ZOOM_COURSE_NOT_IN_TENANT', `El curso ${courseId} no pertenece a este tenant.`);
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
  constructor(reason: string) {
    super('ZOOM_API_ERROR', `Error hablando con Zoom: ${reason}`);
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
