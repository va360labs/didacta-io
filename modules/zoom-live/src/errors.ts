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

export class ZoomApiError extends ZoomLiveError {
  constructor(reason: string) {
    super('ZOOM_API_ERROR', `Error hablando con Zoom: ${reason}`);
  }
}
