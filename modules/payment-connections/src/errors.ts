/**
 * Errores del dominio mod.payment-connections.
 *
 * Heredan de PaymentConnectionsError para que el filtro de NestJS
 * (apps/api/src/modules/payment-connections/payment-connections-error.filter.ts)
 * los mapee a HTTP. Los errores del SDK de Stripe se envuelven aquí para no
 * filtrar detalles de implementación (ni nunca la API key) al cliente.
 */

export class PaymentConnectionsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'PaymentConnectionsError';
  }
}

export class PaymentConnectionNotFoundError extends PaymentConnectionsError {
  constructor(id: string) {
    super(`Conexión de pago no encontrada: ${id}`, 'PAYMENT_CONNECTIONS_NOT_FOUND');
    this.name = 'PaymentConnectionNotFoundError';
  }
}

export class PaymentConnectionAlreadyExistsError extends PaymentConnectionsError {
  constructor(displayName: string) {
    super(
      `Ya existe una conexión Stripe con el nombre "${displayName}". Usa un nombre distinto.`,
      'PAYMENT_CONNECTIONS_ALREADY_EXISTS',
    );
    this.name = 'PaymentConnectionAlreadyExistsError';
  }
}

export class PaymentConnectionProviderNotSupportedError extends PaymentConnectionsError {
  constructor(provider: string) {
    super(
      `Proveedor de pago no soportado: "${provider}". En esta versión solo se soporta "stripe" (PayPal en roadmap).`,
      'PAYMENT_CONNECTIONS_PROVIDER_NOT_SUPPORTED',
    );
    this.name = 'PaymentConnectionProviderNotSupportedError';
  }
}

export class StripeReadKeyInvalidError extends PaymentConnectionsError {
  constructor(reason: string) {
    super(
      `La clave de Stripe no es válida o no tiene permisos de lectura (Customers + Subscriptions = Read): ${reason}`,
      'PAYMENT_CONNECTIONS_STRIPE_KEY_INVALID',
    );
    this.name = 'StripeReadKeyInvalidError';
  }
}

export class StripeReadApiError extends PaymentConnectionsError {
  constructor(message: string) {
    super(`Error leyendo de la Stripe API: ${message}`, 'PAYMENT_CONNECTIONS_STRIPE_API_ERROR');
    this.name = 'StripeReadApiError';
  }
}

export class TierNotFoundError extends PaymentConnectionsError {
  constructor(id: string) {
    super(`Tier no encontrado: ${id}`, 'PAYMENT_CONNECTIONS_TIER_NOT_FOUND');
    this.name = 'TierNotFoundError';
  }
}

export class TierNameConflictError extends PaymentConnectionsError {
  constructor(name: string) {
    super(`Ya existe un tier con el nombre "${name}".`, 'PAYMENT_CONNECTIONS_TIER_NAME_CONFLICT');
    this.name = 'TierNameConflictError';
  }
}
