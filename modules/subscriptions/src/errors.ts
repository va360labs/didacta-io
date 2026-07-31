/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Errores del dominio mod.subscriptions.
 *
 * Heredan de SubscriptionsError para que el filtro de NestJS
 * (apps/api/src/modules/subscriptions-error.filter.ts) los mapee a HTTP.
 * Los errores de Stripe SDK se envuelven aquí para no filtrar detalles de
 * implementación al cliente.
 */

export class SubscriptionsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SubscriptionsError';
  }
}

export class SubscriptionNotFoundError extends SubscriptionsError {
  constructor(id: string) {
    super(`Suscripción no encontrada: ${id}`, 'SUBSCRIPTIONS_NOT_FOUND');
    this.name = 'SubscriptionNotFoundError';
  }
}

export class SubscriptionAlreadyActiveError extends SubscriptionsError {
  constructor(courseId: string) {
    super(
      `Ya tienes una suscripción activa para el curso ${courseId}. Cancela la actual antes de crear otra.`,
      'SUBSCRIPTIONS_ALREADY_ACTIVE',
    );
    this.name = 'SubscriptionAlreadyActiveError';
  }
}

export class SubscriptionPriceNotRecurringError extends SubscriptionsError {
  constructor(priceId: string) {
    super(
      `El price ${priceId} no es recurring. mod.subscriptions sólo acepta prices recurring (interval=month|year). Para pago único usa mod.billing.`,
      'SUBSCRIPTIONS_PRICE_NOT_RECURRING',
    );
    this.name = 'SubscriptionPriceNotRecurringError';
  }
}

export class SubscriptionAccessDeniedError extends SubscriptionsError {
  constructor() {
    super('No tienes permiso para gestionar esta suscripción.', 'SUBSCRIPTIONS_ACCESS_DENIED');
    this.name = 'SubscriptionAccessDeniedError';
  }
}

export class WebhookSignatureInvalidError extends SubscriptionsError {
  constructor(reason: string) {
    super(`Firma del webhook inválida: ${reason}`, 'SUBSCRIPTIONS_WEBHOOK_SIGNATURE_INVALID');
    this.name = 'WebhookSignatureInvalidError';
  }
}

export class StripeConfigMissingError extends SubscriptionsError {
  constructor(missing: 'secretKey' | 'webhookSecret') {
    super(
      `Configuración Stripe incompleta: falta ${
        missing === 'secretKey' ? 'STRIPE_SECRET_KEY' : 'STRIPE_WEBHOOK_SECRET'
      }.`,
      'SUBSCRIPTIONS_STRIPE_CONFIG_MISSING',
    );
    this.name = 'StripeConfigMissingError';
  }
}

export class StripeApiError extends SubscriptionsError {
  constructor(message: string) {
    super(`Error de Stripe API: ${message}`, 'SUBSCRIPTIONS_STRIPE_API_ERROR');
    this.name = 'StripeApiError';
  }
}

export class MembershipPlanNotFoundError extends SubscriptionsError {
  constructor(planId: string) {
    super(`Plan de membresía no encontrado o inactivo: ${planId}`, 'MEMBERSHIP_PLAN_NOT_FOUND');
    this.name = 'MembershipPlanNotFoundError';
  }
}

export class MembershipPageInactiveError extends SubscriptionsError {
  constructor() {
    super(
      'La página de membresía no está activada. El admin puede activarla en Administración → Membresía.',
      'MEMBERSHIP_PAGE_INACTIVE',
    );
    this.name = 'MembershipPageInactiveError';
  }
}

export class MembershipConfigIncompleteError extends SubscriptionsError {
  constructor(detail: string) {
    super(`Membresía mal configurada: ${detail}`, 'MEMBERSHIP_CONFIG_INCOMPLETE');
    this.name = 'MembershipConfigIncompleteError';
  }
}

/** "Pagar ahora" sin una membresía en periodo de prueba que terminar. */
export class MembershipNotTrialingError extends SubscriptionsError {
  constructor() {
    super('No tienes una membresía en periodo de prueba que activar.', 'MEMBERSHIP_NOT_TRIALING');
    this.name = 'MembershipNotTrialingError';
  }
}
