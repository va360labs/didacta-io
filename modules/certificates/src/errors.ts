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
