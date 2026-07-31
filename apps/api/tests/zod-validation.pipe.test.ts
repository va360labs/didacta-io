import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../src/auth/zod-validation.pipe';

interface ErrorBody {
  message: string;
  issues: Array<{ path: string; message: string; code: string }>;
}

function bodyOf(fn: () => unknown): ErrorBody {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as ErrorBody;
  }
  throw new Error('no lanzó');
}

describe('ZodValidationPipe', () => {
  it('devuelve el dato parseado cuando es válido', () => {
    const pipe = new ZodValidationPipe(z.object({ name: z.string() }));
    expect(pipe.transform({ name: 'ok' })).toEqual({ name: 'ok' });
  });

  it('el message del error lleva el detalle real del issue (no el genérico)', () => {
    const schema = z.object({
      documentId: z.string().refine(() => false, {
        message: 'Documento de identidad inválido (esperado DNI o NIE español).',
      }),
    });
    const body = bodyOf(() => new ZodValidationPipe(schema).transform({ documentId: 'X1234' }));
    expect(body.message).toContain('Documento de identidad inválido');
    expect(body.message).not.toBe('Validación fallida');
    expect(body.issues[0]!.path).toBe('documentId');
  });

  it('junta varios issues con separador y los expone en issues[]', () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const body = bodyOf(() => new ZodValidationPipe(schema).transform({ a: 1, b: 'x' }));
    expect(body.issues).toHaveLength(2);
    expect(body.message).toContain(' · ');
  });

  it('cae al genérico si no hubiera mensajes (defensa)', () => {
    // Un issue sin message no debería ocurrir con Zod, pero el fallback protege.
    const schema = z.string();
    const body = bodyOf(() => new ZodValidationPipe(schema).transform(123));
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
  });
});
