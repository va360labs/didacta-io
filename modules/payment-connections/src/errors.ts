/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Errores del dominio mod.payment-connections.
 *
 * Heredan de PaymentConnectionsError para que el filtro de NestJS
 * (apps/api/src/modules/payment-connections/payment-connections-error.filter.ts)
 * los mapee a HTTP. Los errores del SDK de Stripe se envuelven aquí para no
 * filtrar detalles de implementación (ni nunca la API key) al cliente.
 */

/**
 * Opciones de un error de dominio. `detail` es el diagnóstico CRUDO que el
 * `message` español lleva incrustado (lo que responde el proveedor de pago):
 * viaja como campo APARTE hasta el front para que el catálogo inglés no se lo
 * trague al traducir por `code`. Contrato completo en
 * `apps/api/src/common/module-error-body.ts`.
 */
export interface PaymentConnectionsErrorOptions {
  readonly detail?: string;
}

export class PaymentConnectionsError extends Error {
  readonly detail?: string;

  constructor(
    message: string,
    public readonly code: string,
    options?: PaymentConnectionsErrorOptions,
  ) {
    super(message);
    this.name = 'PaymentConnectionsError';
    this.detail = options?.detail;
  }
}

export class PaymentConnectionNotFoundError extends PaymentConnectionsError {
  constructor(id: string) {
    super(`Conexión de pago no encontrada: ${id}`, 'PAYMENT_CONNECTIONS_NOT_FOUND', {
      detail: id,
    });
    this.name = 'PaymentConnectionNotFoundError';
  }
}

export class PaymentConnectionAlreadyExistsError extends PaymentConnectionsError {
  constructor(displayName: string) {
    super(
      `Ya existe una conexión Stripe con el nombre "${displayName}". Usa un nombre distinto.`,
      'PAYMENT_CONNECTIONS_ALREADY_EXISTS',
      { detail: displayName },
    );
    this.name = 'PaymentConnectionAlreadyExistsError';
  }
}

export class PaymentConnectionProviderNotSupportedError extends PaymentConnectionsError {
  constructor(provider: string) {
    super(
      `Proveedor de pago no soportado: "${provider}". En esta versión solo se soporta "stripe" (PayPal en roadmap).`,
      'PAYMENT_CONNECTIONS_PROVIDER_NOT_SUPPORTED',
      { detail: provider },
    );
    this.name = 'PaymentConnectionProviderNotSupportedError';
  }
}

/**
 * Error de credencial/permiso de lectura. Lo comparten los tres lectores
 * (Stripe / PayPal / WooCommerce), así que el mensaje es NEUTRAL de proveedor: el
 * detalle específico (qué proveedor, qué permiso falta) lo aporta cada adaptador
 * en `reason`. Antes el texto decía "La clave de Stripe…" y mal-etiquetaba como
 * Stripe los fallos de PayPal/WooCommerce.
 */
export class StripeReadKeyInvalidError extends PaymentConnectionsError {
  constructor(reason: string) {
    super(
      `Credencial de la cuenta de pago inválida o sin permiso de lectura: ${reason}`,
      'PAYMENT_CONNECTIONS_STRIPE_KEY_INVALID',
      { detail: reason },
    );
    this.name = 'StripeReadKeyInvalidError';
  }
}

export class StripeReadApiError extends PaymentConnectionsError {
  constructor(message: string) {
    super(
      `Error leyendo de la cuenta de pago: ${message}`,
      'PAYMENT_CONNECTIONS_STRIPE_API_ERROR',
      {
        detail: message,
      },
    );
    this.name = 'StripeReadApiError';
  }
}

/**
 * El proveedor de la suscripción no ofrece un portal de gestión integrado
 * (PayPal/WooCommerce) o la suscripción no tiene customer asociado. El caller
 * debe caer al enlace de gestión del proveedor o a "contacta soporte".
 */
export class PaymentPortalUnavailableError extends PaymentConnectionsError {
  constructor(provider: string) {
    super(
      `El proveedor "${provider}" no ofrece un portal de gestión de suscripción integrado.`,
      'PAYMENT_CONNECTIONS_PORTAL_UNAVAILABLE',
      { detail: provider },
    );
    this.name = 'PaymentPortalUnavailableError';
  }
}

export class TierNotFoundError extends PaymentConnectionsError {
  constructor(id: string) {
    super(`Tier no encontrado: ${id}`, 'PAYMENT_CONNECTIONS_TIER_NOT_FOUND', { detail: id });
    this.name = 'TierNotFoundError';
  }
}

export class TierNameConflictError extends PaymentConnectionsError {
  constructor(name: string) {
    super(`Ya existe un tier con el nombre "${name}".`, 'PAYMENT_CONNECTIONS_TIER_NAME_CONFLICT', {
      detail: name,
    });
    this.name = 'TierNameConflictError';
  }
}
