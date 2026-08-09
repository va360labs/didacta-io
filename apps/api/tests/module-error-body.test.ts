/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * La FONTANERÍA del campo `detail`: de la clase de error del módulo al body
 * HTTP, pasando por el `ExceptionFilter`.
 *
 * `api-error-detail-contract.test.ts` comprueba que la clase de error RELLENA
 * el campo y que el catálogo lo PROMETE. Lo que falta entre esas dos mitades es
 * el tramo del medio: que el filtro que convierte la excepción en respuesta lo
 * EMITA. Ese tramo se escribía a mano en ~22 filtros idénticos, y bastaba con
 * que uno se olvidara para que el inglés siguiera perdiendo el dato en ese
 * módulo y solo en ese.
 *
 * Por eso el body lo compone un helper único (`common/module-error-body.ts`) y
 * lo que se prueba aquí es el helper + una muestra de filtros reales de las
 * cuatro formas que existen (body multilínea, body de una línea, body con
 * campos extra, y el de marketplace que hace `send()` inline).
 */

import { describe, expect, it } from 'vitest';
import { StripeApiError, WebhookSignatureInvalidError } from '@didacta/mod-billing';
import { ZoomApiError } from '@didacta/mod-zoom-live';
import { MaxAttemptsReachedError } from '@didacta/mod-assessments';
import { SpaceNotFoundError } from '@didacta/mod-community';
import { InvitationInvalidError } from '@didacta/mod-learning';
import { moduleErrorBody } from '../src/common/module-error-body';
import { BillingErrorFilter } from '../src/modules/billing/billing-error.filter';
import { ZoomLiveErrorFilter } from '../src/modules/zoom-live/zoom-live-error.filter';
import { AssessmentsErrorFilter } from '../src/modules/assessments/assessments-error.filter';
import { CommunityErrorFilter } from '../src/modules/community/community-error.filter';
import { LearningErrorFilter } from '../src/modules/learning-error.filter';

function makeHost(captured: { status?: number; body?: Record<string, unknown> }) {
  const reply = {
    status(s: number) {
      captured.status = s;
      return this;
    },
    send(b: Record<string, unknown>) {
      captured.body = b;
      return this;
    },
  };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => reply }),
  } as never;
}

function bodyOf(filter: { catch: (e: never, h: never) => void }, error: unknown) {
  const captured: { status?: number; body?: Record<string, unknown> } = {};
  filter.catch(error as never, makeHost(captured));
  return captured.body ?? {};
}

describe('moduleErrorBody', () => {
  it('emite `detail` cuando la excepción lo trae', () => {
    const body = moduleErrorBody(
      { code: 'X', message: 'Error de Stripe API: no such customer', detail: 'no such customer' },
      502,
    );
    expect(body).toEqual({
      statusCode: 502,
      code: 'X',
      message: 'Error de Stripe API: no such customer',
      detail: 'no such customer',
    });
  });

  it('CAMINO DEGRADADO: sin `detail`, el campo NO aparece en el body', () => {
    // Mandarlo en blanco sería peor que no mandarlo: el front lo daría por
    // presente e interpolaría «SMTP failed: » con el hueco a cero.
    for (const detail of [undefined, '', '   ']) {
      const body = moduleErrorBody({ code: 'X', message: 'msg', detail }, 400);
      expect(body, `detail=${JSON.stringify(detail)}`).not.toHaveProperty('detail');
    }
  });

  it('los campos extra del filtro se conservan junto al `detail`', () => {
    const body = moduleErrorBody({ code: 'X', message: 'm', detail: 'd' }, 400, {
      reasons: ['a', 'b'],
    });
    expect(body).toMatchObject({ detail: 'd', reasons: ['a', 'b'] });
  });
});

describe('los ExceptionFilter emiten el `detail` de su módulo', () => {
  const STRIPE = 'No such customer: cus_123';
  const ZOOM = '404: {"code":1001,"message":"User does not exist"}';

  it.each([
    // Diagnóstico de un sistema EXTERNO: es el caso grave.
    [new BillingErrorFilter(), new StripeApiError(STRIPE), 'BILLING_STRIPE_API_ERROR', STRIPE],
    [
      new BillingErrorFilter(),
      new WebhookSignatureInvalidError('No signatures found'),
      'BILLING_WEBHOOK_SIGNATURE_INVALID',
      'No signatures found',
    ],
    [new ZoomLiveErrorFilter(), new ZoomApiError(ZOOM), 'ZOOM_API_ERROR', ZOOM],
    // Dato del propio producto, y las otras formas de filtro.
    [
      new AssessmentsErrorFilter(),
      new MaxAttemptsReachedError(3),
      'MAX_ATTEMPTS_REACHED',
      // El límite viaja como STRING: si fuese number, ICU lo formatearía por
      // idioma y el español dejaría de rendir byte a byte.
      '3',
    ],
    [new CommunityErrorFilter(), new SpaceNotFoundError('general'), 'SPACE_NOT_FOUND', 'general'],
    [
      new LearningErrorFilter(),
      new InvitationInvalidError('token caducado'),
      'INVITATION_INVALID',
      'token caducado',
    ],
  ])('%# → el body lleva el detalle entero', (filter, error, code, detail) => {
    const body = bodyOf(filter as never, error);
    expect(body['code']).toBe(code);
    expect(body['detail']).toBe(detail);
    // Y el `message` español NO cambia: sigue llevando el dato incrustado, que
    // es el fallback honesto si el front no conoce el code.
    expect(String(body['message'])).toContain(detail);
  });

  it('un error del módulo sin dato interpolado no inventa `detail`', () => {
    const body = bodyOf(new AssessmentsErrorFilter() as never, {
      code: 'QUIZ_NOT_FOUND',
      message: 'El quiz solicitado no existe o no pertenece al tenant',
      name: 'AssessmentsError',
    });
    expect(body).not.toHaveProperty('detail');
  });
});
