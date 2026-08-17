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

/**
 * Opciones de un error de dominio. `detail` es el diagnóstico CRUDO que el
 * `message` español lleva incrustado (la respuesta de Stripe, la del MTA): viaja
 * como campo APARTE hasta el front para que el catálogo inglés no se lo trague
 * al traducir por `code`. Contrato completo en
 * `apps/api/src/common/module-error-body.ts`.
 */
export interface SubscriptionsErrorOptions {
  readonly detail?: string;
}

export class SubscriptionsError extends Error {
  readonly detail?: string;

  constructor(
    message: string,
    public readonly code: string,
    options?: SubscriptionsErrorOptions,
  ) {
    super(message);
    this.name = 'SubscriptionsError';
    this.detail = options?.detail;
  }
}

export class SubscriptionNotFoundError extends SubscriptionsError {
  constructor(id: string) {
    super(`Suscripción no encontrada: ${id}`, 'SUBSCRIPTIONS_NOT_FOUND', { detail: id });
    this.name = 'SubscriptionNotFoundError';
  }
}

export class SubscriptionAlreadyActiveError extends SubscriptionsError {
  constructor(courseId: string) {
    super(
      `Ya tienes una suscripción activa para el curso ${courseId}. Cancela la actual antes de crear otra.`,
      'SUBSCRIPTIONS_ALREADY_ACTIVE',
      { detail: courseId },
    );
    this.name = 'SubscriptionAlreadyActiveError';
  }
}

export class SubscriptionPriceNotRecurringError extends SubscriptionsError {
  constructor(priceId: string) {
    super(
      `El price ${priceId} no es recurring. mod.subscriptions sólo acepta prices recurring (interval=month|year). Para pago único usa mod.billing.`,
      'SUBSCRIPTIONS_PRICE_NOT_RECURRING',
      { detail: priceId },
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
    super(`Firma del webhook inválida: ${reason}`, 'SUBSCRIPTIONS_WEBHOOK_SIGNATURE_INVALID', {
      detail: reason,
    });
    this.name = 'WebhookSignatureInvalidError';
  }
}

export class StripeConfigMissingError extends SubscriptionsError {
  constructor(missing: 'secretKey' | 'webhookSecret') {
    const envVar = missing === 'secretKey' ? 'STRIPE_SECRET_KEY' : 'STRIPE_WEBHOOK_SECRET';
    super(
      `Configuración Stripe incompleta: falta ${envVar}.`,
      'SUBSCRIPTIONS_STRIPE_CONFIG_MISSING',
      { detail: envVar },
    );
    this.name = 'StripeConfigMissingError';
  }
}

export class StripeApiError extends SubscriptionsError {
  constructor(message: string) {
    super(`Error de Stripe API: ${message}`, 'SUBSCRIPTIONS_STRIPE_API_ERROR', {
      detail: message,
    });
    this.name = 'StripeApiError';
  }
}

/** Periodicidad de plan fuera de rango: Stripe no factura periodos de más de un año. */
export class MembershipPlanIntervalInvalidError extends SubscriptionsError {
  constructor(intervalMonths: number) {
    super(
      `Periodicidad inválida: ${intervalMonths} meses. Usa un entero entre 1 y 12 (Stripe no admite periodos de facturación de más de un año).`,
      'MEMBERSHIP_PLAN_INTERVAL_INVALID',
      // String() a propósito: si ICU recibiera un number lo formatearía con
      // separador de miles por idioma y el ES dejaría de rendir byte a byte.
      { detail: String(intervalMonths) },
    );
    this.name = 'MembershipPlanIntervalInvalidError';
  }
}

export class MembershipPlanNotFoundError extends SubscriptionsError {
  constructor(planId: string) {
    super(`Plan de membresía no encontrado o inactivo: ${planId}`, 'MEMBERSHIP_PLAN_NOT_FOUND', {
      detail: planId,
    });
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
    super(`Membresía mal configurada: ${detail}`, 'MEMBERSHIP_CONFIG_INCOMPLETE', { detail });
    this.name = 'MembershipConfigIncompleteError';
  }
}

/**
 * Ya hay una membresía viva para ese email: no se abre un segundo checkout.
 *
 * Existe porque la membresía puede venderse desde más de un escaparate (la
 * página `/unete` del aula y una tienda externa que use la API), y sin esta
 * comprobación la misma persona acaba con dos suscripciones cobrándose a la vez
 * y una sola de ellas dándole acceso. El `detail` lleva el estado de la que ya
 * tiene, que es lo que necesita el front para decidir si mandarla a su cuenta
 * (activa) o a actualizar el método de pago (impago).
 */
export class MembershipAlreadySubscribedError extends SubscriptionsError {
  constructor(status: string) {
    super(
      'Ya tienes una membresía en curso con este correo. Gestiónala desde tu cuenta en vez de contratar otra.',
      'MEMBERSHIP_ALREADY_SUBSCRIBED',
      { detail: status },
    );
    this.name = 'MembershipAlreadySubscribedError';
  }
}

/** "Pagar ahora" sin una membresía en periodo de prueba que terminar. */
export class MembershipNotTrialingError extends SubscriptionsError {
  constructor() {
    super('No tienes una membresía en periodo de prueba que activar.', 'MEMBERSHIP_NOT_TRIALING');
    this.name = 'MembershipNotTrialingError';
  }
}
