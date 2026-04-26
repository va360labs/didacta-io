export class ThemingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ThemingError';
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
    );
  }
}

export class CustomCssUnsafeError extends ThemingError {
  constructor(reason: string) {
    super(
      'THEMING_CUSTOM_CSS_UNSAFE',
      `El CSS personalizado contiene código no permitido: ${reason}.`,
    );
  }
}

export class FooterHtmlTooLargeError extends ThemingError {
  constructor(maxBytes: number) {
    super(
      'THEMING_FOOTER_HTML_TOO_LARGE',
      `El HTML del footer excede el máximo permitido de ${maxBytes} bytes.`,
    );
  }
}

export class InvalidUrlError extends ThemingError {
  constructor(field: string) {
    super('THEMING_INVALID_URL', `La URL de "${field}" no es válida o no usa https.`);
  }
}
