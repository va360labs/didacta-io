/**
 * Errores de dominio de mod.resources. El host los mapea a HTTP en
 * `apps/api/src/modules/resources/resources-error.filter.ts` por `code`.
 */
export class ResourcesError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ResourcesError';
  }
}

export class ResourcesNotFoundError extends ResourcesError {
  constructor() {
    super('Recurso no encontrado.', 'RESOURCES_NOT_FOUND');
    this.name = 'ResourcesNotFoundError';
  }
}

export class ResourcesValidationError extends ResourcesError {
  constructor(detail: string) {
    super(detail, 'RESOURCES_VALIDATION');
    this.name = 'ResourcesValidationError';
  }
}
