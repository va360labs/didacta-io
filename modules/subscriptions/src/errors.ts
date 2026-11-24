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
 * página `/join` del aula y una tienda externa que use la API), y sin esta
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

/**
 * El price pedido no es uno de los que el tenant ha vinculado a ese curso.
 * Antes no se comprobaba y el importe lo elegia el cliente.
 */
export class SubscriptionPriceNotForCourseError extends SubscriptionsError {
  constructor(priceId: string, courseId: string) {
    super(
      `El price ${priceId} no esta vinculado al curso ${courseId}`,
      'SUBSCRIPTIONS_PRICE_NOT_FOR_COURSE',
    );
  }
}

/**
 * El webhook llego antes que la fila local a la que se engancha (Stripe no
 * garantiza orden). Se lanza para que el reintento lo vuelva a traer; antes
 * estos eventos se descartaban y se perdian para siempre.
 */
export class WebhookOutOfOrderError extends SubscriptionsError {
  constructor(que: string) {
    super(
      `${que} llego antes que su suscripcion local; se reintentara`,
      'SUBSCRIPTIONS_WEBHOOK_OUT_OF_ORDER',
      { detail: que },
    );
  }
}

/**
 * El evento de Stripe toca una fila (suscripción, factura) o nombra un tenant
 * que NO es el tenant para el que el host lo verificó. La firma demuestra quién
 * envía, no a quién se refiere el contenido: un admin del aula B puede firmar
 * con SU secreto un evento que nombre una suscripción del aula A. Se rechaza
 * sin tocar nada.
 */
export class WebhookTenantMismatchError extends SubscriptionsError {
  constructor(que: string) {
    super(
      `El evento de Stripe no pertenece al tenant verificado (${que}).`,
      'SUBSCRIPTIONS_WEBHOOK_TENANT_MISMATCH',
      { detail: que },
    );
    this.name = 'WebhookTenantMismatchError';
  }
}

/**
 * Oferta al darse de baja: lo elegido (pausa o descuento) no está disponible
 * para esta suscripción ahora mismo (el aula no lo ofrece, la suscripción no
 * está al día, se cobra por años…). 409: la petición choca con el estado.
 */
export class RetentionNotEligibleError extends SubscriptionsError {
  constructor(que: string) {
    super(
      `Esta oferta no está disponible para tu suscripción (${que}).`,
      'SUBSCRIPTIONS_RETENTION_NOT_ELIGIBLE',
      { detail: que },
    );
    this.name = 'RetentionNotEligibleError';
  }
}

/** El descuento ya se usó (una vez por persona) o hubo una pausa hace menos de un año. */
export class RetentionAlreadyUsedError extends SubscriptionsError {
  constructor(que: 'discount' | 'pause') {
    super(
      que === 'discount'
        ? 'Ya aceptaste este descuento antes: es una vez por persona.'
        : 'Ya pausaste tu suscripción en los últimos 12 meses.',
      'SUBSCRIPTIONS_RETENTION_ALREADY_USED',
      { detail: que },
    );
    this.name = 'RetentionAlreadyUsedError';
  }
}

/** Configuración de la oferta fuera de los límites (meses, porcentaje). */
export class RetentionConfigInvalidError extends SubscriptionsError {
  constructor(campo: string) {
    super(
      `Configuración de la oferta no válida: ${campo}.`,
      'SUBSCRIPTIONS_RETENTION_CONFIG_INVALID',
      { detail: campo },
    );
    this.name = 'RetentionConfigInvalidError';
  }
}

/** Motivo de baja que no está en la lista. */
export class RetentionReasonInvalidError extends SubscriptionsError {
  constructor(reason: string) {
    super(`Motivo de baja no válido: ${reason}.`, 'SUBSCRIPTIONS_RETENTION_REASON_INVALID', {
      detail: reason,
    });
    this.name = 'RetentionReasonInvalidError';
  }
}

/** La suscripción ya está cancelada o con la baja programada: no hay nada que dar de baja. */
export class SubscriptionAlreadyLeavingError extends SubscriptionsError {
  constructor(id: string) {
    super(
      'Esta suscripción ya está cancelada o con la baja programada.',
      'SUBSCRIPTIONS_ALREADY_LEAVING',
      { detail: id },
    );
    this.name = 'SubscriptionAlreadyLeavingError';
  }
}

// ---------------- Niveles de la membresía ----------------

/** El nivel no existe en esta aula. */
export class MembershipTierNotFoundError extends SubscriptionsError {
  constructor(id: string) {
    super(`Nivel de membresía no encontrado: ${id}`, 'MEMBERSHIP_TIER_NOT_FOUND', { detail: id });
    this.name = 'MembershipTierNotFoundError';
  }
}

/** Datos del nivel no válidos (nombre vacío o repetido, segundo nivel gratis…). */
export class MembershipTierInvalidError extends SubscriptionsError {
  constructor(que: string) {
    super(`Nivel de membresía no válido: ${que}.`, 'MEMBERSHIP_TIER_INVALID', { detail: que });
    this.name = 'MembershipTierInvalidError';
  }
}

/**
 * El nivel ya tiene a gente dentro (planes vendidos o miembros gratis): no se
 * borra, se apaga. Así quien lo paga no pierde nada por un clic del creador.
 */
export class MembershipTierInUseError extends SubscriptionsError {
  constructor(id: string) {
    super('Este nivel ya tiene alumnos: apágalo en vez de borrarlo.', 'MEMBERSHIP_TIER_IN_USE', {
      detail: id,
    });
    this.name = 'MembershipTierInUseError';
  }
}

/** Un plan en un nivel gratis: el nivel gratis no se cobra. */
export class MembershipTierIsFreeError extends SubscriptionsError {
  constructor(id: string) {
    super('El nivel gratis no lleva planes de pago.', 'MEMBERSHIP_TIER_IS_FREE', { detail: id });
    this.name = 'MembershipTierIsFreeError';
  }
}

/** Ya hay otro plan con ese nombre en el aula (los nombres son únicos por aula). */
export class MembershipPlanNameTakenError extends SubscriptionsError {
  constructor(name: string) {
    super(`Ya hay un plan que se llama «${name}».`, 'MEMBERSHIP_PLAN_NAME_TAKEN', {
      detail: name,
    });
    this.name = 'MembershipPlanNameTakenError';
  }
}

/**
 * Cambio de nivel no permitido ahora: la membresía no está al día o en prueba
 * (impago, pausa, baja programada) o no hay membresía que cambiar. `reason`
 * dice cuál, para que la cuenta lo explique.
 */
export class MembershipPlanChangeNotAllowedError extends SubscriptionsError {
  constructor(
    public readonly reason:
      | 'no_membership'
      | 'not_active'
      | 'cancel_scheduled'
      | 'pause_scheduled'
      | 'same_plan'
      | 'currency_mismatch'
      | 'target_unavailable',
  ) {
    super(`No se puede cambiar de plan ahora (${reason}).`, 'MEMBERSHIP_PLAN_CHANGE_NOT_ALLOWED', {
      detail: reason,
    });
    this.name = 'MembershipPlanChangeNotAllowedError';
  }
}

/**
 * Stripe no pudo cobrar la diferencia al subir de nivel. La suscripción NO
 * cambia (`payment_behavior: error_if_incomplete`): sigue en su nivel.
 */
export class MembershipPlanChangePaymentFailedError extends SubscriptionsError {
  constructor(detail: string) {
    super(
      'No se pudo cobrar la diferencia: tu plan no ha cambiado.',
      'MEMBERSHIP_PLAN_CHANGE_PAYMENT_FAILED',
      { detail },
    );
    this.name = 'MembershipPlanChangePaymentFailedError';
  }
}
