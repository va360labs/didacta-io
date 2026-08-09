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
import { TemplateInUseError } from '@didacta/mod-certificates';
import { CustomCssTooLargeError, LogoTooLargeError } from '@didacta/mod-theming';
import { GraderProviderError } from '@didacta/mod-ai-grader';
import { ChatProviderError, EmbeddingsProviderError } from '@didacta/mod-ai-tutor';
import { InvalidContentJsonError } from '@didacta/mod-ai-content';
import { ProviderUnavailableError } from '../src/ai/types/contracts';
import { moduleErrorBody } from '../src/common/module-error-body';
import { AiGraderErrorFilter } from '../src/modules/ai-grader/ai-grader-error.filter';
import { AiTutorErrorFilter } from '../src/modules/ai-tutor/ai-tutor-error.filter';
import { AiContentErrorFilter } from '../src/modules/ai-content/ai-content-error.filter';
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

  it('emite `params` cuando la excepción trae varios valores con nombre', () => {
    const body = moduleErrorBody(
      {
        code: 'AI_GRADER_PROVIDER_ERROR',
        message: 'Provider openai falló: timeout',
        params: { provider: 'openai', reason: 'timeout' },
      },
      502,
    );
    expect(body).toEqual({
      statusCode: 502,
      code: 'AI_GRADER_PROVIDER_ERROR',
      message: 'Provider openai falló: timeout',
      params: { provider: 'openai', reason: 'timeout' },
    });
  });

  it('CAMINO DEGRADADO: `params` a medias NO se emite (todo o nada)', () => {
    // Un solo hueco vacío haría que el front pintase «The AI provider  failed:
    // timeout». Sin el campo, degrada al `message` crudo —español, pero
    // completo—, que es la misma decisión que se tomó para `detail`.
    const PARCIALES: unknown[] = [
      undefined,
      {},
      { provider: 'openai', reason: '' },
      { provider: 'openai', reason: '   ' },
      { provider: 'openai', reason: 42 },
      { provider: 'openai', reason: null },
    ];
    for (const params of PARCIALES) {
      const body = moduleErrorBody(
        { code: 'X', message: 'm', params: params as Record<string, string> },
        502,
      );
      expect(body, `params=${JSON.stringify(params)}`).not.toHaveProperty('params');
    }
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

  it.each([
    // El `message` compone el número con la aritmética de JS («5242880»), sin
    // separador de miles. Si el `detail` viajara como number, ICU lo
    // formatearía por idioma («5.242.880» en es-ES) y la frase traducida
    // dejaría de ser byte a byte la que ya ve el admin español. El tipo
    // `detail?: string` lo impide en compilación; esto lo fija en runtime.
    [new TemplateInUseError(1200), 'TEMPLATE_IN_USE', '1200'],
    [new CustomCssTooLargeError(5242880), 'THEMING_CUSTOM_CSS_TOO_LARGE', '5242880'],
    // Y el que ya venía formateado como texto (MB con un decimal) tampoco se
    // recalcula: viaja tal cual lo compuso el backend.
    [new LogoTooLargeError(2 * 1024 * 1024), 'THEMING_LOGO_TOO_LARGE', '2.0'],
  ])('%# → el límite numérico viaja como string, sin formatear', (error, code, detail) => {
    const body = bodyOf(new AssessmentsErrorFilter() as never, error);
    expect(body['code']).toBe(code);
    expect(body['detail']).toBe(detail);
    expect(typeof body['detail']).toBe('string');
    expect(String(body['message'])).toContain(detail);
  });

  it.each([
    // Los 5 codes que `detail` NO podía cerrar: dos o más valores con copy
    // español entre medias. El filtro tiene que emitirlos CON NOMBRE, porque
    // colapsarlos en un `detail` único metería el «falló» español dentro de la
    // frase inglesa.
    [
      new AiGraderErrorFilter(),
      new GraderProviderError('openai', 'timeout'),
      'AI_GRADER_PROVIDER_ERROR',
      { provider: 'openai', reason: 'timeout' },
    ],
    [
      new AiTutorErrorFilter(),
      new ChatProviderError('anthropic', '429'),
      'AI_TUTOR_CHAT_PROVIDER_ERROR',
      { provider: 'anthropic', reason: '429' },
    ],
    [
      new AiTutorErrorFilter(),
      new EmbeddingsProviderError('voyage', 'reset'),
      'AI_TUTOR_EMBEDDINGS_PROVIDER_ERROR',
      { provider: 'voyage', reason: 'reset' },
    ],
    [
      new AiTutorErrorFilter(),
      new ProviderUnavailableError('openai', 503, 'upstream'),
      'AI_PROVIDER_UNAVAILABLE',
      // `statusCode` como STRING: con un number, ICU lo formatearía por idioma.
      { provider: 'openai', statusCode: '503', body: 'upstream' },
    ],
    [
      new AiContentErrorFilter(),
      new InvalidContentJsonError('QUIZ', 'falta questions'),
      'AI_CONTENT_INVALID_JSON',
      { type: 'QUIZ', reason: 'falta questions' },
    ],
  ])('%# → el body lleva los valores CON NOMBRE', (filter, error, code, params) => {
    const body = bodyOf(filter as never, error);
    expect(body['code']).toBe(code);
    expect(body['params']).toEqual(params);
    expect(body).not.toHaveProperty('detail');
    // Y el `message` español NO cambia: sigue llevando los datos incrustados.
    for (const value of Object.values(params)) {
      expect(String(body['message'])).toContain(value);
    }
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
