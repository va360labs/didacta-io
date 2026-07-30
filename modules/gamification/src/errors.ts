/**
 * Errores de dominio de mod.gamification. El host los mapea a HTTP en
 * `apps/api/src/modules/gamification/gamification-error.filter.ts` por `code`.
 */
export class GamificationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'GamificationError';
  }
}

export class GamificationNotFoundError extends GamificationError {
  constructor(detail = 'No encontrado.') {
    super(detail, 'GAMIFICATION_NOT_FOUND');
    this.name = 'GamificationNotFoundError';
  }
}

export class GamificationValidationError extends GamificationError {
  constructor(detail: string) {
    super(detail, 'GAMIFICATION_VALIDATION');
    this.name = 'GamificationValidationError';
  }
}

/** El reto no admite entregas ahora mismo (borrador, cerrado o fuera de fechas). */
export class GamificationChallengeClosedError extends GamificationError {
  constructor(detail = 'Este reto no admite entregas ahora mismo.') {
    super(detail, 'GAMIFICATION_CHALLENGE_CLOSED');
    this.name = 'GamificationChallengeClosedError';
  }
}

/** Ya hay una entrega de esta persona para este reto: una por reto y persona. */
export class GamificationAlreadySubmittedError extends GamificationError {
  constructor() {
    super('Ya has entregado este reto.', 'GAMIFICATION_ALREADY_SUBMITTED');
    this.name = 'GamificationAlreadySubmittedError';
  }
}

/** La entrega ya fue revisada: revisar dos veces pagaría el reto dos veces. */
export class GamificationAlreadyReviewedError extends GamificationError {
  constructor() {
    super('Esta entrega ya fue revisada.', 'GAMIFICATION_ALREADY_REVIEWED');
    this.name = 'GamificationAlreadyReviewedError';
  }
}

/**
 * El beneficio no se puede pedir ahora: sin nivel suficiente, cupo agotado,
 * en periodo de espera o desactivado.
 */
export class GamificationPerkUnavailableError extends GamificationError {
  constructor(detail: string) {
    super(detail, 'GAMIFICATION_PERK_UNAVAILABLE');
    this.name = 'GamificationPerkUnavailableError';
  }
}

/** Choque de catálogo: la clave o los puntos del nivel ya están ocupados. */
export class GamificationConflictError extends GamificationError {
  constructor(detail: string) {
    super(detail, 'GAMIFICATION_CONFLICT');
    this.name = 'GamificationConflictError';
  }
}
