/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Errores del dominio mod.billing.
 *
 * Todos heredan de BillingError para que el ExceptionFilter de NestJS
 * (apps/api/src/modules/billing-error.filter.ts) los mapee a HTTP de forma
 * consistente. Los errores de Stripe SDK se envuelven aquí para no filtrar
 * detalles de implementación al cliente.
 */

/**
 * Opciones de un error de dominio. `detail` es el diagnóstico CRUDO que el
 * `message` español lleva incrustado (la respuesta de Stripe, la del MTA, la del
 * proveedor de IA): viaja como campo APARTE hasta el front para que el catálogo
 * inglés no se lo trague al traducir por `code`. Contrato completo en
 * `apps/api/src/common/module-error-body.ts`.
 */
export interface BillingErrorOptions {
  readonly detail?: string;
}

export class BillingError extends Error {
  readonly detail?: string;

  constructor(
    message: string,
    public readonly code: string,
    options?: BillingErrorOptions,
  ) {
    super(message);
    this.name = 'BillingError';
    this.detail = options?.detail;
  }
}

export class ProductNotFoundError extends BillingError {
  constructor(courseIdOrId: string) {
    super(`Producto no encontrado: ${courseIdOrId}`, 'BILLING_PRODUCT_NOT_FOUND', {
      detail: courseIdOrId,
    });
    this.name = 'ProductNotFoundError';
  }
}

export class ProductAlreadyExistsError extends BillingError {
  constructor(courseId: string) {
    super(
      `Ya existe un producto activo para el curso ${courseId}. Edita el existente o desactívalo antes de crear uno nuevo.`,
      'BILLING_PRODUCT_ALREADY_EXISTS',
      { detail: courseId },
    );
    this.name = 'ProductAlreadyExistsError';
  }
}

export class ProductInactiveError extends BillingError {
  constructor(courseId: string) {
    super(`El producto del curso ${courseId} está desactivado.`, 'BILLING_PRODUCT_INACTIVE', {
      detail: courseId,
    });
    this.name = 'ProductInactiveError';
  }
}

export class OrderNotFoundError extends BillingError {
  constructor(id: string) {
    super(`Orden no encontrada: ${id}`, 'BILLING_ORDER_NOT_FOUND', { detail: id });
    this.name = 'OrderNotFoundError';
  }
}

export class WebhookSignatureInvalidError extends BillingError {
  constructor(reason: string) {
    super(`Firma del webhook inválida: ${reason}`, 'BILLING_WEBHOOK_SIGNATURE_INVALID', {
      detail: reason,
    });
    this.name = 'WebhookSignatureInvalidError';
  }
}

export class StripeConfigMissingError extends BillingError {
  constructor(missing: 'secretKey' | 'webhookSecret') {
    const envVar = missing === 'secretKey' ? 'STRIPE_SECRET_KEY' : 'STRIPE_WEBHOOK_SECRET';
    super(`Configuración Stripe incompleta: falta ${envVar}.`, 'BILLING_STRIPE_CONFIG_MISSING', {
      detail: envVar,
    });
    this.name = 'StripeConfigMissingError';
  }
}

export class StripeApiError extends BillingError {
  constructor(message: string) {
    super(`Error de Stripe API: ${message}`, 'BILLING_STRIPE_API_ERROR', { detail: message });
    this.name = 'StripeApiError';
  }
}
