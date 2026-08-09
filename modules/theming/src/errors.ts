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
export interface ThemingErrorOptions {
  readonly detail?: string;
}

export class ThemingError extends Error {
  readonly detail?: string;

  constructor(
    public readonly code: string,
    message: string,
    options?: ThemingErrorOptions,
  ) {
    super(message);
    this.name = 'ThemingError';
    this.detail = options?.detail;
  }
}

export class InvalidHueError extends ThemingError {
  constructor() {
    super('THEMING_INVALID_HUE', 'El hue del color primario debe estar entre 0 y 360.');
  }
}

export class InvalidSaturationError extends ThemingError {
  constructor() {
    super(
      'THEMING_INVALID_SATURATION',
      'La saturación del color primario debe estar entre 0 y 100.',
    );
  }
}

export class UnsupportedFontError extends ThemingError {
  constructor(font: string, allowed: readonly string[]) {
    super(
      'THEMING_UNSUPPORTED_FONT',
      `La fuente "${font}" no está en la whitelist. Permitidas: ${allowed.join(', ')}.`,
    );
  }
}

export class CustomCssTooLargeError extends ThemingError {
  constructor(maxBytes: number) {
    super(
      'THEMING_CUSTOM_CSS_TOO_LARGE',
      `El CSS personalizado excede el máximo permitido de ${maxBytes} bytes.`,
      // String() a propósito: si ICU recibiera un number lo formatearía con
      // separador de miles por idioma y el ES dejaría de rendir byte a byte.
      { detail: String(maxBytes) },
    );
  }
}

export class CustomCssUnsafeError extends ThemingError {
  constructor(reason: string) {
    super(
      'THEMING_CUSTOM_CSS_UNSAFE',
      `El CSS personalizado contiene código no permitido: ${reason}.`,
      { detail: reason },
    );
  }
}

export class FooterHtmlTooLargeError extends ThemingError {
  constructor(maxBytes: number) {
    super(
      'THEMING_FOOTER_HTML_TOO_LARGE',
      `El HTML del footer excede el máximo permitido de ${maxBytes} bytes.`,
      // String() a propósito: si ICU recibiera un number lo formatearía con
      // separador de miles por idioma y el ES dejaría de rendir byte a byte.
      { detail: String(maxBytes) },
    );
  }
}

export class SigninCopyTooLongError extends ThemingError {
  constructor(field: 'signinHeadline' | 'signinSubheadline', maxChars: number) {
    super(
      'THEMING_SIGNIN_COPY_TOO_LONG',
      `El texto de "${field}" supera los ${maxChars} caracteres y rompería el panel de acceso.`,
    );
  }
}

export class InvalidUrlError extends ThemingError {
  constructor(field: string) {
    super('THEMING_INVALID_URL', `La URL de "${field}" no es válida o no usa https.`, {
      detail: field,
    });
  }
}

export class LogoTooLargeError extends ThemingError {
  constructor(maxBytes: number) {
    // El límite ya viaja formateado como texto: ICU no debe reformatearlo (ver
    // nota de String() en los demás límites numéricos).
    const maxMb = (maxBytes / 1024 / 1024).toFixed(1);
    super('THEMING_LOGO_TOO_LARGE', `El logo excede el máximo permitido de ${maxMb} MB.`, {
      detail: maxMb,
    });
  }
}

export class LogoNotFoundError extends ThemingError {
  constructor() {
    super('THEMING_LOGO_NOT_FOUND', 'Este tenant no tiene un logo subido.');
  }
}

export class UnsupportedLogoTypeError extends ThemingError {
  constructor(contentType: string, allowed: readonly string[]) {
    super(
      'THEMING_UNSUPPORTED_LOGO_TYPE',
      `El tipo "${contentType}" no está permitido para el logo. Permitidos: ${allowed.join(', ')}.`,
    );
  }
}

export class EmptyLogoError extends ThemingError {
  constructor() {
    super('THEMING_EMPTY_LOGO', 'El archivo del logo está vacío o el base64 es inválido.');
  }
}
