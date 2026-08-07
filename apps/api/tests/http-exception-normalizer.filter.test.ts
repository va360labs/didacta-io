import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  HttpExceptionNormalizerFilter,
  normalizeHttpExceptionBody,
} from '../src/common/http-exception-normalizer.filter';

function makeHost(captured: { status?: number; body?: unknown }) {
  const reply = {
    status(s: number) {
      captured.status = s;
      return this;
    },
    send(b: unknown) {
      captured.body = b;
      return this;
    },
  };
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getResponse: () => reply,
    }),
  } as never;
}

describe('normalizeHttpExceptionBody', () => {
  it('string plano → { statusCode, message } sin code', () => {
    const body = normalizeHttpExceptionBody(new NotFoundException('Curso no encontrado.'));
    expect(body).toEqual({ statusCode: 404, message: 'Curso no encontrado.', error: 'Not Found' });
    expect(body.code).toBeUndefined();
  });

  it('body objeto con code → lo preserva', () => {
    const body = normalizeHttpExceptionBody(
      new BadRequestException({ message: 'Email inválido.', code: 'AUTH_INVALID_EMAIL' }),
    );
    expect(body).toMatchObject({
      statusCode: 400,
      message: 'Email inválido.',
      code: 'AUTH_INVALID_EMAIL',
    });
  });

  it('body objeto con campos extra (issues, capability) → los preserva', () => {
    const body = normalizeHttpExceptionBody(
      new ConflictException({
        message: 'Slug en uso.',
        code: 'ADMIN_SLUG_TAKEN',
        issues: [{ path: 'slug' }],
      }),
    );
    expect(body).toMatchObject({
      statusCode: 409,
      code: 'ADMIN_SLUG_TAKEN',
      issues: [{ path: 'slug' }],
    });
  });

  it('message como array (class-validator style) → lo une en un string', () => {
    const body = normalizeHttpExceptionBody(
      new BadRequestException({ message: ['a requerido', 'b inválido'] }),
    );
    expect(body.message).toBe('a requerido; b inválido');
  });

  it('code no-string en el body → no emite code', () => {
    const body = normalizeHttpExceptionBody(
      new ForbiddenException({ message: 'No.', code: 42 as unknown as string }),
    );
    expect(body.code).toBeUndefined();
    expect(body.message).toBe('No.');
  });

  it('statusCode del body NO pisa al status real de la excepción', () => {
    const body = normalizeHttpExceptionBody(
      new UnauthorizedException({ message: 'Token caducado.', statusCode: 200 }),
    );
    expect(body.statusCode).toBe(401);
  });
});

describe('HttpExceptionNormalizerFilter', () => {
  const filter = new HttpExceptionNormalizerFilter();

  it('http: responde con el body normalizado y el status correcto', () => {
    const captured: { status?: number; body?: unknown } = {};
    filter.catch(
      new BadRequestException({ message: 'Dato inválido.', code: 'AUTH_BAD_INPUT' }),
      makeHost(captured),
    );
    expect(captured.status).toBe(400);
    expect(captured.body).toMatchObject({
      statusCode: 400,
      code: 'AUTH_BAD_INPUT',
      message: 'Dato inválido.',
    });
  });

  it('los codes vivos del front (mfa_required) pasan intactos', () => {
    const captured: { status?: number; body?: unknown } = {};
    filter.catch(
      new ForbiddenException({ message: 'MFA requerido.', code: 'mfa_required' }),
      makeHost(captured),
    );
    expect(captured.body).toMatchObject({ statusCode: 403, code: 'mfa_required' });
  });

  it('contexto no-http: relanza la excepción original', () => {
    const host = {
      getType: () => 'rpc',
      switchToHttp: () => ({ getResponse: vi.fn() }),
    } as never;
    const err = new NotFoundException('x');
    expect(() => filter.catch(err, host)).toThrowError(err);
  });
});
