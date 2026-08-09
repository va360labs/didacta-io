import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import es from '@/i18n/messages/es';
import en from '@/i18n/messages/en';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from './api-error';
import { labelOr } from './labels';

const tEs = createTranslator({ locale: 'es-ES', messages: es, namespace: 'errors' });
const tEn = createTranslator({ locale: 'en-US', messages: en, namespace: 'errors' });

function httpError(message: string, code?: string, detail?: string): ApiHttpError {
  return new ApiHttpError({ message, status: 400, code, detail });
}

describe('apiErrorMessage', () => {
  it('code conocido → mensaje traducido del catálogo', () => {
    const e = httpError('Se requiere verificación MFA.', 'mfa_required');
    expect(apiErrorMessage(e, tEn)).toBe('Two-step verification is required to continue.');
    expect(apiErrorMessage(e, tEs)).toBe('Se requiere verificación en dos pasos para continuar.');
  });

  it('code desconocido → fallback honesto al message del backend', () => {
    const e = httpError('Algo específico del backend.', 'CODE_QUE_NO_EXISTE');
    expect(apiErrorMessage(e, tEn)).toBe('Algo específico del backend.');
  });

  it('sin code → message del backend', () => {
    expect(apiErrorMessage(httpError('Curso no encontrado.'), tEn)).toBe('Curso no encontrado.');
  });

  it('code con punto (rompería el path de namespaces) → se ignora', () => {
    const e = httpError('Mensaje.', 'a.b');
    expect(apiErrorMessage(e, tEn)).toBe('Mensaje.');
  });

  it('Error genérico → su message', () => {
    expect(apiErrorMessage(new Error('boom'), tEn)).toBe('boom');
  });

  it('TypeError de red (Failed to fetch) → errors.unknown, nunca el mensaje del motor', () => {
    expect(apiErrorMessage(new TypeError('Failed to fetch'), tEn)).toBe(
      'Something went wrong. Please try again.',
    );
    expect(apiErrorMessage(new TypeError('Load failed'), tEs)).toBe(
      'Algo salió mal. Inténtalo de nuevo.',
    );
  });

  it('no-Error (throw raro) → errors.unknown', () => {
    expect(apiErrorMessage('cadena', tEn)).toBe('Something went wrong. Please try again.');
    expect(apiErrorMessage(undefined, tEs)).toBe('Algo salió mal. Inténtalo de nuevo.');
  });
});

// ============================================================================
// Codes que llevan diagnóstico de un sistema externo (`ApiError.detail`).
// El bug que cierran: el catálogo EN traducía la frase y BORRABA el detalle,
// así que el admin anglófono veía "Stripe rejected the key." sin saber por qué,
// mientras el español sí lo veía (no había key ES y caía al message crudo).
// ============================================================================
describe('apiErrorMessage con detalle estructurado', () => {
  const STRIPE_DETAIL = 'Invalid API Key provided: sk_test_***1234';

  it('el detalle de Stripe llega ENTERO en los dos idiomas', () => {
    const e = httpError(
      `Stripe rechazó la clave: ${STRIPE_DETAIL}`,
      'ADMIN_STRIPE_KEY_REJECTED',
      STRIPE_DETAIL,
    );
    expect(apiErrorMessage(e, tEn)).toBe(`Stripe rejected the key: ${STRIPE_DETAIL}`);
    expect(apiErrorMessage(e, tEs)).toBe(`Stripe rechazó la clave: ${STRIPE_DETAIL}`);
    // El español es byte a byte el mensaje crudo del backend (no cambia nada
    // de lo que ve hoy el admin español).
    expect(apiErrorMessage(e, tEs)).toBe(e.message);
  });

  it('el error del MTA llega entero en los dos idiomas', () => {
    const e = httpError('SMTP falló: auth failed', 'ADMIN_SMTP_TEST_FAILED', 'auth failed');
    expect(apiErrorMessage(e, tEn)).toBe('SMTP failed: auth failed');
    expect(apiErrorMessage(e, tEs)).toBe('SMTP falló: auth failed');
  });

  it('CAMINO DEGRADADO: code con detalle esperado pero SIN detail → message crudo', () => {
    // API vieja contra front nuevo, o un MTA que falla sin devolver texto.
    // Nunca la frase traducida con el hueco vacío ni la key en pantalla.
    const e = httpError('SMTP falló: sin detalle', 'ADMIN_SMTP_TEST_FAILED');
    expect(apiErrorMessage(e, tEn)).toBe('SMTP falló: sin detalle');
    expect(apiErrorMessage(e, tEn)).not.toContain('ADMIN_SMTP_TEST_FAILED');
    expect(apiErrorMessage(e, tEn)).not.toBe('SMTP failed: ');
  });

  it('CAMINO DEGRADADO: detail vacío o solo espacios cuenta como ausente', () => {
    for (const detail of ['', '   ']) {
      const e = httpError('Stripe rechazó la clave: x', 'ADMIN_STRIPE_KEY_REJECTED', detail);
      expect(apiErrorMessage(e, tEn)).toBe('Stripe rechazó la clave: x');
    }
  });

  it('un code SIN detalle esperado ignora el campo aunque venga', () => {
    const e = httpError('Se requiere verificación MFA.', 'mfa_required', 'ruido');
    expect(apiErrorMessage(e, tEn)).toBe('Two-step verification is required to continue.');
  });

  it('los dos catálogos declaran {detail} en TODOS los codes que lo interpolan', () => {
    // Si alguien añade un code a CODES_WITH_DETAIL y olvida una traducción,
    // el mensaje sale sin el diagnóstico o con la key cruda. Las keys van como
    // literales para que el augment de tipos del catálogo las valide en
    // compile-time además de en runtime.
    const rendered = [
      ['ADMIN_STRIPE_KEY_REJECTED es', tEs('ADMIN_STRIPE_KEY_REJECTED', { detail: 'ZZ' })],
      ['ADMIN_STRIPE_KEY_REJECTED en', tEn('ADMIN_STRIPE_KEY_REJECTED', { detail: 'ZZ' })],
      ['ADMIN_SMTP_TEST_FAILED es', tEs('ADMIN_SMTP_TEST_FAILED', { detail: 'ZZ' })],
      ['ADMIN_SMTP_TEST_FAILED en', tEn('ADMIN_SMTP_TEST_FAILED', { detail: 'ZZ' })],
    ] as const;
    for (const [label, text] of rendered) {
      expect(text, `${label} no interpola {detail}`).toContain('ZZ');
      // La key cruda en pantalla es el síntoma de un ICU que no resolvió.
      expect(text, `${label} pinta la key`).not.toContain('ADMIN_');
    }
  });
});

describe('labelOr', () => {
  it('key existente → traducción; ausente → fallback crudo', () => {
    expect(labelOr(tEn, 'mfa_required', 'raw')).toBe(
      'Two-step verification is required to continue.',
    );
    expect(labelOr(tEn, 'no.existe.esto', 'Etiqueta del módulo')).toBe('Etiqueta del módulo');
  });
});
