import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import es from '@/i18n/messages/es';
import en from '@/i18n/messages/en';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from './api-error';
import { labelOr } from './labels';

const tEs = createTranslator({ locale: 'es-ES', messages: es, namespace: 'errors' });
const tEn = createTranslator({ locale: 'en-US', messages: en, namespace: 'errors' });

function httpError(message: string, code?: string): ApiHttpError {
  return new ApiHttpError({ message, status: 400, code });
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

  it('no-Error (throw raro) → errors.unknown', () => {
    expect(apiErrorMessage('cadena', tEn)).toBe('Something went wrong. Please try again.');
    expect(apiErrorMessage(undefined, tEs)).toBe('Algo salió mal. Inténtalo de nuevo.');
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
