/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { NotFoundException } from '@nestjs/common';
import { z } from 'zod';

/**
 * Lo común a los checkouts PÚBLICOS (ficha de un curso y membresía) para
 * pintar el pago DENTRO de la página de venta del aula.
 *
 * La página pide `uiMode: 'embedded'`. El servidor solo lo concede si sabe la
 * clave publicable de la cuenta que va a crear la sesión
 * (`ModuleRegistryService.resolveCheckoutPublishableKey`); si no, responde con
 * el redirect de siempre y la página navega a `url`. Así ninguna instalación
 * se queda sin poder cobrar por no tener la clave publicable puesta, y quien
 * no pide nada (clientes viejos, «Comprar curso» dentro del aula) sigue
 * exactamente igual.
 */
export const checkoutUiModeSchema = z.enum(['embedded', 'hosted']).optional();

/** Respuesta del checkout público: los dos caminos comparten `sessionId`. */
export type PublicCheckoutResponse =
  | {
      mode: 'embedded';
      sessionId: string;
      /** Siempre `null`: no hay página de Stripe a la que ir. */
      url: null;
      clientSecret: string;
      publishableKey: string;
      /**
       * Lo que cobrará la sesión creada y su moneda. La página enseña esto en
       * el resumen del pago (el precio pudo cambiar desde que se pintó).
       */
      amountTotal: number | null;
      currency: string | null;
    }
  | { mode: 'hosted'; sessionId: string; url: string };

/** Id de una Checkout Session (`cs_test_…` / `cs_live_…`), sin nada más. */
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,255}$/;

/**
 * Valida la forma del id que llega en la vuelta del pago. Cualquier otra cosa
 * es «no existe» (404) y no llega ni a la base ni a Stripe.
 */
export function ensureCheckoutSessionId(value: string): string {
  if (!SESSION_ID.test(value)) {
    throw new NotFoundException({
      message: 'Pago no encontrado.',
      code: 'CHECKOUT_SESSION_NOT_FOUND',
    });
  }
  return value;
}

/** El 404 de una sesión que no es de esta academia (o no existe). */
export function checkoutSessionNotFound(): NotFoundException {
  return new NotFoundException({
    message: 'Pago no encontrado.',
    code: 'CHECKOUT_SESSION_NOT_FOUND',
  });
}
