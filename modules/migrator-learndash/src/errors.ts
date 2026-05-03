/**
 * Errores tipados del módulo migrator-learndash.
 * El controller usa el ErrorFilter para mappearlos a HTTP status.
 */

export class MigratorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

// ---- Bloqueantes (abort job) ----

export class CapabilityMissingError extends MigratorError {
  constructor(capability: string) {
    super(`tu plan no incluye la capacidad '${capability}'`, 'CAPABILITY_MISSING');
  }
}

export class TenantNotFoundError extends MigratorError {
  constructor(tenantId: string) {
    super(`tenant ${tenantId} no existe`, 'TENANT_NOT_FOUND');
  }
}

export class SchemaIncompatibleError extends MigratorError {
  constructor(detail: string) {
    super(`schema incompatible: ${detail}`, 'SCHEMA_INCOMPATIBLE');
  }
}

export class JobNotFoundError extends MigratorError {
  constructor(jobId: string) {
    super(`job ${jobId} no encontrado`, 'JOB_NOT_FOUND');
  }
}

export class JobAlreadyRunningError extends MigratorError {
  constructor() {
    super('ya hay una migración en curso para este tenant', 'JOB_ALREADY_RUNNING');
  }
}

export class JobNotCancellableError extends MigratorError {
  constructor(status: string) {
    super(`el job en estado '${status}' no se puede cancelar`, 'JOB_NOT_CANCELLABLE');
  }
}

export class DependencyModuleMissingError extends MigratorError {
  constructor(moduleName: string) {
    super(`módulo dependiente '${moduleName}' no está instalado`, 'DEPENDENCY_MODULE_MISSING');
  }
}

// ---- De datos (DLQ, no abortan) ----

export class MalformedPayloadError extends MigratorError {
  constructor(detail: string) {
    super(`payload malformado: ${detail}`, 'MALFORMED_PAYLOAD');
  }
}

export class MissingDependencyError extends MigratorError {
  constructor(detail: string) {
    super(`dependencia ausente: ${detail}`, 'MISSING_DEPENDENCY');
  }
}

export class DuplicateEmailError extends MigratorError {
  constructor(email: string) {
    super(`email duplicado: ${email}`, 'DUPLICATE_EMAIL');
  }
}

// ---- Recuperables (retry automático) ----

export class TransientUpstreamError extends MigratorError {
  constructor(detail: string, cause?: unknown) {
    super(`error transitorio del origen: ${detail}`, 'TRANSIENT_UPSTREAM', cause);
  }
}

// ---- Mapping a HTTP status ----

export function mapErrorToHttpStatus(err: MigratorError): number {
  switch (err.code) {
    case 'CAPABILITY_MISSING':
      return 402; // Payment Required
    case 'TENANT_NOT_FOUND':
      return 404;
    case 'JOB_NOT_FOUND':
      return 404;
    case 'JOB_ALREADY_RUNNING':
      return 409;
    case 'JOB_NOT_CANCELLABLE':
      return 409;
    case 'DEPENDENCY_MODULE_MISSING':
      return 412; // Precondition Failed
    case 'SCHEMA_INCOMPATIBLE':
      return 412;
    case 'TRANSIENT_UPSTREAM':
      return 502; // Bad Gateway
    case 'MALFORMED_PAYLOAD':
    case 'MISSING_DEPENDENCY':
    case 'DUPLICATE_EMAIL':
      return 400;
    default:
      return 500;
  }
}
