export class CertificatesError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CertificatesError';
  }
}

export class CertificateNotFoundError extends CertificatesError {
  constructor() {
    super('CERTIFICATE_NOT_FOUND', 'Certificado no encontrado');
  }
}

export class CertificateAlreadyIssuedError extends CertificatesError {
  constructor() {
    super('CERTIFICATE_ALREADY_ISSUED', 'Ya existe un certificado emitido para esta matriculación');
  }
}

export class TemplateNotFoundError extends CertificatesError {
  constructor() {
    super('TEMPLATE_NOT_FOUND', 'Plantilla de certificado no encontrada');
  }
}

export class TemplateNameTakenError extends CertificatesError {
  constructor(name: string) {
    super('TEMPLATE_NAME_TAKEN', `Ya existe una plantilla con nombre "${name}" en este tenant.`);
  }
}

export class TemplateInUseError extends CertificatesError {
  constructor(public readonly courseCount: number) {
    super(
      'TEMPLATE_IN_USE',
      `No se puede eliminar: ${courseCount} curso(s) están usando esta plantilla.`,
    );
  }
}

export class TemplateIsDefaultError extends CertificatesError {
  constructor() {
    super(
      'TEMPLATE_IS_DEFAULT',
      'No se puede eliminar la plantilla default. Marcá otra como default antes.',
    );
  }
}
