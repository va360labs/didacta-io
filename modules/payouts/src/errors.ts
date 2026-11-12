/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Errores del dominio mod.payouts.
 *
 * Heredan de PayoutsError para que el filtro de NestJS del host
 * (`apps/api/src/modules/payouts/payouts-error.filter.ts`, etapa E2) los mapee
 * a HTTP con códigos estables.
 */

/**
 * Opciones de un error de dominio. `detail` es el dato que el `message` español
 * lleva incrustado: viaja como campo APARTE hasta el front para que el catálogo
 * inglés no se lo trague al traducir por `code`. Contrato completo en
 * `apps/api/src/common/module-error-body.ts`.
 */
export interface PayoutsErrorOptions {
  readonly detail?: string;
}

export class PayoutsError extends Error {
  readonly detail?: string;

  constructor(
    message: string,
    public readonly code: string,
    options?: PayoutsErrorOptions,
  ) {
    super(message);
    this.name = 'PayoutsError';
    this.detail = options?.detail;
  }
}

/** Un importe no es un entero válido en unidad mínima (o se sale de rango). */
export class PayoutsInvalidAmountError extends PayoutsError {
  constructor(what: string) {
    super(`Importe no válido: ${what}`, 'PAYOUTS_INVALID_AMOUNT', { detail: what });
    this.name = 'PayoutsInvalidAmountError';
  }
}

/** La comisión del operador no es un entero entre 0 y 3000 puntos básicos. */
export class PayoutsInvalidFeeBpsError extends PayoutsError {
  constructor(value: unknown) {
    const shown = String(value);
    super(
      `Comisión no válida: ${shown}. Debe ser un entero entre 0 y 3000 puntos básicos.`,
      'PAYOUTS_INVALID_FEE_BPS',
      { detail: shown },
    );
    this.name = 'PayoutsInvalidFeeBpsError';
  }
}

/** La divisa no es un código ISO 4217 de tres letras. */
export class PayoutsInvalidCurrencyError extends PayoutsError {
  constructor(value: unknown) {
    const shown = String(value);
    super(`Divisa no válida: ${shown}`, 'PAYOUTS_INVALID_CURRENCY', { detail: shown });
    this.name = 'PayoutsInvalidCurrencyError';
  }
}

/** La firma del webhook de Stripe no es válida para ninguno de los secretos. */
export class PayoutsWebhookSignatureInvalidError extends PayoutsError {
  constructor(reason: string) {
    super(`Firma del webhook inválida: ${reason}`, 'PAYOUTS_WEBHOOK_SIGNATURE_INVALID', {
      detail: reason,
    });
    this.name = 'PayoutsWebhookSignatureInvalidError';
  }
}

/**
 * Un objeto de Stripe ya está registrado a nombre de OTRO tenant (o con otra
 * clase de objeto). El registro es la única fuente del tenant de un evento de
 * plataforma: un conflicto no se resuelve en silencio, se rechaza.
 */
export class PayoutsObjectRefConflictError extends PayoutsError {
  constructor(stripeObjectId: string) {
    super(
      `El objeto de Stripe ${stripeObjectId} ya está registrado con otro tenant u otra clase.`,
      'PAYOUTS_REF_CONFLICT',
      { detail: stripeObjectId },
    );
    this.name = 'PayoutsObjectRefConflictError';
  }
}

/**
 * Se reutilizó una `idempotency_key` del libro para un asiento DISTINTO (otro
 * tenant, cuenta, tipo, importe o divisa). Reintentar el mismo asiento es
 * legítimo y no lanza; esto es un fallo de programación y no debe tragarse.
 */
export class PayoutsLedgerIdempotencyConflictError extends PayoutsError {
  constructor(idempotencyKey: string) {
    super(
      `La clave de idempotencia ${idempotencyKey} ya existe en el libro con otro contenido.`,
      'PAYOUTS_LEDGER_IDEMPOTENCY_CONFLICT',
      { detail: idempotencyKey },
    );
    this.name = 'PayoutsLedgerIdempotencyConflictError';
  }
}

/** La clave de idempotencia de un asiento está vacía o es demasiado larga. */
export class PayoutsInvalidIdempotencyKeyError extends PayoutsError {
  constructor() {
    super(
      'Clave de idempotencia no válida: vacía o de más de 255 caracteres.',
      'PAYOUTS_IDEMPOTENCY_KEY_INVALID',
    );
    this.name = 'PayoutsInvalidIdempotencyKeyError';
  }
}

/** El registro recibió algo que no es un id de objeto de Stripe o una clase conocida. */
export class PayoutsInvalidObjectRefError extends PayoutsError {
  constructor(what: string) {
    super(`Referencia de objeto de Stripe no válida: ${what}`, 'PAYOUTS_REF_INVALID', {
      detail: what,
    });
    this.name = 'PayoutsInvalidObjectRefError';
  }
}

/**
 * El país del creador no está en la lista de países admitidos de la
 * plataforma, o Stripe rechazó crear la cuenta por el país. Las dos cosas son
 * lo mismo para el creador: «todavía no podemos pagar a cuentas de {país}».
 * `detail` lleva el código ISO del país.
 */
export class PayoutsCountryUnsupportedError extends PayoutsError {
  constructor(country: string) {
    super(`Todavía no se puede pagar a cuentas de ${country}.`, 'PAYOUTS_COUNTRY_UNSUPPORTED', {
      detail: country,
    });
    this.name = 'PayoutsCountryUnsupportedError';
  }
}

/** El tipo de titular no es `individual` (particular/autónomo) ni `company`. */
export class PayoutsInvalidEntityTypeError extends PayoutsError {
  constructor(value: unknown) {
    const shown = String(value);
    super(
      `Tipo de titular no válido: ${shown}. Debe ser individual o company.`,
      'PAYOUTS_ENTITY_TYPE_INVALID',
      { detail: shown },
    );
    this.name = 'PayoutsInvalidEntityTypeError';
  }
}

/** El tenant no tiene ninguna cuenta conectada viva. */
export class PayoutsAccountNotFoundError extends PayoutsError {
  constructor() {
    super('Esta academia todavía no ha conectado sus cobros.', 'PAYOUTS_ACCOUNT_NOT_FOUND');
    this.name = 'PayoutsAccountNotFoundError';
  }
}

/**
 * Ya hay un alta empezada con OTRO país u otro tipo de titular. El país de una
 * cuenta de Stripe no se puede cambiar: no se crea una segunda cuenta a
 * escondidas. `detail` lleva el país de la cuenta que ya existe.
 */
export class PayoutsAccountAlreadyStartedError extends PayoutsError {
  constructor(existingCountry: string) {
    super(
      `Ya hay un alta de cobros empezada para ${existingCountry}. Termínala desde «Completar».`,
      'PAYOUTS_ACCOUNT_ALREADY_STARTED',
      { detail: existingCountry },
    );
    this.name = 'PayoutsAccountAlreadyStartedError';
  }
}

/**
 * La cuenta existe pero aún no ha terminado el alta: Stripe no da acceso a su
 * panel («Cannot create a login link for an account that has not completed
 * onboarding»).
 */
export class PayoutsAccountOnboardingIncompleteError extends PayoutsError {
  constructor() {
    super(
      'Termina de conectar tus cobros para poder ver tus pagos en Stripe.',
      'PAYOUTS_ACCOUNT_ONBOARDING_INCOMPLETE',
    );
    this.name = 'PayoutsAccountOnboardingIncompleteError';
  }
}

/** El evento del webhook no es JSON o no tiene la forma de un evento de Stripe. */
export class PayoutsWebhookPayloadInvalidError extends PayoutsError {
  constructor(what: string) {
    super(`Evento de Stripe no válido: ${what}`, 'PAYOUTS_WEBHOOK_PAYLOAD_INVALID', {
      detail: what,
    });
    this.name = 'PayoutsWebhookPayloadInvalidError';
  }
}

/**
 * El evento es de prueba y la clave de plataforma de producción, o al revés.
 * No es un fallo de firma (la firma es buena): es un endpoint mal cableado.
 */
export class PayoutsWebhookLivemodeMismatchError extends PayoutsError {
  constructor(eventLivemode: boolean) {
    super(
      `El evento es de modo ${eventLivemode ? 'real' : 'prueba'} y la plataforma está en el otro modo.`,
      'PAYOUTS_WEBHOOK_LIVEMODE_MISMATCH',
      { detail: eventLivemode ? 'live' : 'test' },
    );
    this.name = 'PayoutsWebhookLivemodeMismatchError';
  }
}

/**
 * El tenant cobra a través de la plataforma pero su cuenta conectada todavía no
 * puede vender (sin conectar, alta a medias, restringida o desconectada). Se
 * responde ANTES de crear la orden y la sesión: no se manda a nadie a pagar.
 */
export class PayoutsNotReadyError extends PayoutsError {
  constructor(public readonly reason: string) {
    super(
      'Esta academia todavía no puede cobrar: tiene que terminar de conectar sus cobros.',
      'PAYOUTS_NOT_READY',
      { detail: reason },
    );
    this.name = 'PayoutsNotReadyError';
  }
}

/**
 * Lo que dice Stripe de un cobro no permite anotar la venta: un cargo sin
 * cuenta conectada del tenant, o una sesión cobrada sin cargo. No bloquea el
 * acceso del alumno; lo recoge el conciliador.
 */
export class PayoutsSaleUnrecordableError extends PayoutsError {
  constructor(what: string) {
    super(`No se puede anotar la venta: ${what}`, 'PAYOUTS_SALE_UNRECORDABLE', { detail: what });
    this.name = 'PayoutsSaleUnrecordableError';
  }
}

/** La clave de Stripe de plataforma no tiene el formato esperado. */
export class PlatformStripeConfigError extends PayoutsError {
  constructor(what: string) {
    super(`Configuración de Stripe de plataforma no válida: ${what}`, 'PAYOUTS_STRIPE_CONFIG', {
      detail: what,
    });
    this.name = 'PlatformStripeConfigError';
  }
}

export interface PlatformStripeApiErrorInfo {
  /** Estado HTTP de la respuesta (0 si no hubo respuesta: red, tiempo agotado). */
  readonly status: number;
  /** `error.type` de Stripe (`invalid_request_error`, `api_error`…). */
  readonly type?: string;
  /** `error.code` de Stripe (`balance_insufficient`, `resource_missing`…). */
  readonly stripeCode?: string;
  /** Cabecera `Request-Id`, para dársela a soporte de Stripe. */
  readonly requestId?: string;
  /** Método y ruta de la llamada (sin parámetros: pueden llevar datos). */
  readonly operation: string;
  /** `error.param` de Stripe: el campo que rechazó (`defaults.profile.business_url`…). */
  readonly param?: string;
}

/**
 * Stripe respondió con error (o no respondió). El `message` literal de Stripe
 * va en `detail`: E2 lo necesita para traducir los rechazos por país, que
 * Stripe solo distingue por el texto.
 */
export class PlatformStripeApiError extends PayoutsError {
  readonly status: number;
  readonly type?: string;
  readonly stripeCode?: string;
  readonly requestId?: string;
  readonly operation: string;
  readonly param?: string;

  constructor(stripeMessage: string, info: PlatformStripeApiErrorInfo) {
    super(`Error de Stripe (${info.operation}): ${stripeMessage}`, 'PAYOUTS_STRIPE_API_ERROR', {
      detail: stripeMessage,
    });
    this.name = 'PlatformStripeApiError';
    this.status = info.status;
    this.type = info.type;
    this.stripeCode = info.stripeCode;
    this.requestId = info.requestId;
    this.operation = info.operation;
    this.param = info.param;
  }

  /** ¿Tiene sentido reintentar? (sin respuesta, 409 de bloqueo, 429 o 5xx). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 409 || this.status === 429 || this.status >= 500;
  }
}
