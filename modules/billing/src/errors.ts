/**
 * Errores del dominio mod.billing.
 *
 * Todos heredan de BillingError para que el ExceptionFilter de NestJS
 * (apps/api/src/modules/billing-error.filter.ts) los mapee a HTTP de forma
 * consistente. Los errores de Stripe SDK se envuelven aquí para no filtrar
 * detalles de implementación al cliente.
 */

export class BillingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

export class ProductNotFoundError extends BillingError {
  constructor(courseIdOrId: string) {
    super(`Producto no encontrado: ${courseIdOrId}`, 'BILLING_PRODUCT_NOT_FOUND');
    this.name = 'ProductNotFoundError';
  }
}

export class ProductAlreadyExistsError extends BillingError {
  constructor(courseId: string) {
    super(
      `Ya existe un producto activo para el curso ${courseId}. Edita el existente o desactívalo antes de crear uno nuevo.`,
      'BILLING_PRODUCT_ALREADY_EXISTS',
    );
    this.name = 'ProductAlreadyExistsError';
  }
}

export class ProductInactiveError extends BillingError {
  constructor(courseId: string) {
    super(`El producto del curso ${courseId} está desactivado.`, 'BILLING_PRODUCT_INACTIVE');
    this.name = 'ProductInactiveError';
  }
}

export class OrderNotFoundError extends BillingError {
  constructor(id: string) {
    super(`Orden no encontrada: ${id}`, 'BILLING_ORDER_NOT_FOUND');
    this.name = 'OrderNotFoundError';
  }
}

export class WebhookSignatureInvalidError extends BillingError {
  constructor(reason: string) {
    super(`Firma del webhook inválida: ${reason}`, 'BILLING_WEBHOOK_SIGNATURE_INVALID');
    this.name = 'WebhookSignatureInvalidError';
  }
}

export class StripeConfigMissingError extends BillingError {
  constructor(missing: 'secretKey' | 'webhookSecret') {
    super(
      `Configuración Stripe incompleta: falta ${missing === 'secretKey' ? 'STRIPE_SECRET_KEY' : 'STRIPE_WEBHOOK_SECRET'}.`,
      'BILLING_STRIPE_CONFIG_MISSING',
    );
    this.name = 'StripeConfigMissingError';
  }
}

export class StripeApiError extends BillingError {
  constructor(message: string) {
    super(`Error de Stripe API: ${message}`, 'BILLING_STRIPE_API_ERROR');
    this.name = 'StripeApiError';
  }
}
