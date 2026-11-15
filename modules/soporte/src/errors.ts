/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Errores de dominio de mod.soporte. El host los traduce a HTTP por su `code`
 * (`apps/api/src/modules/soporte/soporte-error.filter.ts`) y la web los
 * traduce a es/en/pt también por `code` (catálogo `errors`). El `message` es
 * la frase española completa, que es el respaldo si el front no conoce el
 * code.
 *
 * Community usa un solo code por familia (`SOPORTE_TEXTO_INVALIDO` con
 * mensajes distintos). Aquí cada causa tiene el suyo: el mensaje no viaja
 * traducido, así que un code por familia dejaría la misma frase genérica para
 * «muy corto» y «muy largo» en inglés y portugués. Las CLASES son las mismas.
 */
export class SoporteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SoporteError';
  }
}

/** Ya ha enviado el máximo de tickets de las últimas 24 horas. */
export class LimiteDiarioError extends SoporteError {
  constructor(maximo: number) {
    super(
      'SOPORTE_LIMITE_DIARIO',
      `Has enviado ${maximo} tickets en las últimas 24 horas. Espera un poco antes de enviar otro.`,
    );
    this.name = 'LimiteDiarioError';
  }
}

/** Por qué no vale un texto, una nota o un cambio del equipo. */
export type MotivoTextoInvalido =
  | 'TEXTO_CORTO'
  | 'TEXTO_LARGO'
  | 'TIPO_INVALIDO'
  | 'NOTA_LARGA'
  | 'ESTADO_INVALIDO'
  | 'SIN_CAMBIOS';

const MENSAJE_TEXTO: Record<MotivoTextoInvalido, string> = {
  TEXTO_CORTO: 'Escribe al menos 5 caracteres.',
  TEXTO_LARGO: 'El texto admite como mucho 4000 caracteres.',
  TIPO_INVALIDO: 'Elige qué tipo de ticket es.',
  NOTA_LARGA: 'La nota interna admite como mucho 4000 caracteres.',
  ESTADO_INVALIDO: 'Ese estado no existe.',
  SIN_CAMBIOS: 'Indica el estado o la nota interna.',
};

/** El texto del ticket, su tipo, la nota interna o el cambio del equipo no valen. */
export class TextoInvalidoError extends SoporteError {
  constructor(public readonly motivo: MotivoTextoInvalido) {
    super(`SOPORTE_${motivo}`, MENSAJE_TEXTO[motivo]);
    this.name = 'TextoInvalidoError';
  }
}

/** Por qué no vale una captura. */
export type MotivoCapturaInvalida = 'TIPO' | 'VACIA' | 'ILEGIBLE' | 'PESADA' | 'NO_CASA';

const MENSAJE_CAPTURA: Record<MotivoCapturaInvalida, string> = {
  TIPO: 'La captura tiene que ser una imagen PNG, JPEG o WebP.',
  VACIA: 'La captura está vacía.',
  ILEGIBLE: 'La captura no se puede leer.',
  PESADA: 'La captura pesa más de 5 MB.',
  NO_CASA: 'El contenido de la captura no corresponde a una imagen de ese tipo.',
};

/** La captura no es una imagen admitida, está vacía o pesa demasiado. */
export class CapturaInvalidaError extends SoporteError {
  constructor(public readonly motivo: MotivoCapturaInvalida) {
    super(`SOPORTE_CAPTURA_${motivo}`, MENSAJE_CAPTURA[motivo]);
    this.name = 'CapturaInvalidaError';
  }
}

/** No existe, es de otra aula o quien mira no puede verlo. */
export class TicketNoEncontradoError extends SoporteError {
  constructor() {
    super('SOPORTE_NO_ENCONTRADO', 'Ticket no encontrado.');
    this.name = 'TicketNoEncontradoError';
  }
}

/** Solo quien administra el aula gestiona los tickets. */
export class SinPermisoError extends SoporteError {
  constructor() {
    super('SOPORTE_SIN_PERMISO', 'Solo quien administra el aula puede gestionar los tickets.');
    this.name = 'SinPermisoError';
  }
}

/** Todos los codes que puede dar el módulo (los usa el filtro HTTP y su test). */
export const SOPORTE_ERROR_CODES = [
  'SOPORTE_LIMITE_DIARIO',
  ...(Object.keys(MENSAJE_TEXTO) as MotivoTextoInvalido[]).map((m) => `SOPORTE_${m}`),
  ...(Object.keys(MENSAJE_CAPTURA) as MotivoCapturaInvalida[]).map((m) => `SOPORTE_CAPTURA_${m}`),
  'SOPORTE_NO_ENCONTRADO',
  'SOPORTE_SIN_PERMISO',
] as const;
