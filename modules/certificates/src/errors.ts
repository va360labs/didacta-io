/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Opciones de un error de dominio. `detail` es el dato que el `message` español
 * lleva incrustado y que el catálogo inglés se tragaba al traducir por `code`:
 * viaja como campo APARTE hasta el front. Contrato completo en
 * `apps/api/src/common/module-error-body.ts`.
 */
export interface CertificatesErrorOptions {
  readonly detail?: string;
}

export class CertificatesError extends Error {
  readonly detail?: string;

  constructor(
    public readonly code: string,
    message: string,
    options?: CertificatesErrorOptions,
  ) {
    super(message);
    this.name = 'CertificatesError';
    this.detail = options?.detail;
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
    super('TEMPLATE_NAME_TAKEN', `Ya existe una plantilla con nombre "${name}" en este tenant.`, {
      detail: name,
    });
  }
}

export class TemplateInUseError extends CertificatesError {
  constructor(public readonly courseCount: number) {
    super(
      'TEMPLATE_IN_USE',
      `No se puede eliminar: ${courseCount} curso(s) están usando esta plantilla.`,
      // String() a propósito: si ICU recibiera un number lo formatearía con
      // separador de miles por idioma y el ES dejaría de rendir byte a byte.
      { detail: String(courseCount) },
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
