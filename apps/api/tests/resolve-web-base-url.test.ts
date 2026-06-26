import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveWebBaseUrl,
  resolveWebBaseUrlForAuthRedirect,
  type RequestLike,
} from '../src/common/resolve-web-base-url';

function makeReq(
  headers: Record<string, string | string[] | undefined>,
  protocol?: string,
): RequestLike {
  return { headers, protocol };
}

describe('resolveWebBaseUrl', () => {
  const ORIGINAL = process.env.WEB_PUBLIC_URL;

  beforeEach(() => {
    delete process.env.WEB_PUBLIC_URL;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.WEB_PUBLIC_URL;
    else process.env.WEB_PUBLIC_URL = ORIGINAL;
  });

  it('la env var WEB_PUBLIC_URL gana cuando es válida', () => {
    process.env.WEB_PUBLIC_URL = 'https://app.didacta.io';
    const req = makeReq({
      'x-forwarded-host': 'dev.didacta.io',
      'x-forwarded-proto': 'https',
    });
    expect(resolveWebBaseUrl(req)).toBe('https://app.didacta.io');
  });

  it('la env var gana también sin request', () => {
    process.env.WEB_PUBLIC_URL = 'https://app.didacta.io/';
    // recorta trailing slash
    expect(resolveWebBaseUrl()).toBe('https://app.didacta.io');
  });

  it('sin env, deriva de X-Forwarded-Proto + X-Forwarded-Host (Traefik)', () => {
    const req = makeReq({
      'x-forwarded-host': 'dev.didacta.io',
      'x-forwarded-proto': 'https',
      host: 'didacta-api:4000', // host interno NO debe ganar al X-Forwarded
    });
    expect(resolveWebBaseUrl(req)).toBe('https://dev.didacta.io');
  });

  it('sin env, sin X-Forwarded, usa host normal + protocol del request', () => {
    const req = makeReq({ host: 'mi-tenant.didacta.io' }, 'http');
    expect(resolveWebBaseUrl(req)).toBe('http://mi-tenant.didacta.io');
  });

  it('sin env, host normal sin protocol → asume https', () => {
    const req = makeReq({ host: 'mi-tenant.didacta.io' });
    expect(resolveWebBaseUrl(req)).toBe('https://mi-tenant.didacta.io');
  });

  it('X-Forwarded-Proto con lista ("https, http") toma el primero', () => {
    const req = makeReq({
      'x-forwarded-host': 'dev.didacta.io',
      'x-forwarded-proto': 'https, http',
    });
    expect(resolveWebBaseUrl(req)).toBe('https://dev.didacta.io');
  });

  it('headers como array (Node los puede entregar así) → toma el primero', () => {
    const req = makeReq({
      'x-forwarded-host': ['dev.didacta.io', 'otra.io'],
      'x-forwarded-proto': ['https'],
    });
    expect(resolveWebBaseUrl(req)).toBe('https://dev.didacta.io');
  });

  it('sin env y sin request → fallback localhost:3000 (dev)', () => {
    expect(resolveWebBaseUrl()).toBe('http://localhost:3000');
  });

  it('sin env y request sin host → fallback localhost:3000', () => {
    const req = makeReq({});
    expect(resolveWebBaseUrl(req)).toBe('http://localhost:3000');
  });

  it('env vacía se ignora → deriva del request', () => {
    process.env.WEB_PUBLIC_URL = '   ';
    const req = makeReq({ 'x-forwarded-host': 'dev.didacta.io', 'x-forwarded-proto': 'https' });
    expect(resolveWebBaseUrl(req)).toBe('https://dev.didacta.io');
  });

  it('env inválida (no http/https) se ignora → fallback localhost', () => {
    process.env.WEB_PUBLIC_URL = 'no-es-una-url';
    expect(resolveWebBaseUrl()).toBe('http://localhost:3000');
  });

  it('env con esquema no http (ftp) se ignora → deriva del request', () => {
    process.env.WEB_PUBLIC_URL = 'ftp://x.io';
    const req = makeReq({ 'x-forwarded-host': 'dev.didacta.io', 'x-forwarded-proto': 'https' });
    expect(resolveWebBaseUrl(req)).toBe('https://dev.didacta.io');
  });
});

describe('resolveWebBaseUrlForAuthRedirect (redirects que portan tokens)', () => {
  const ORIGINAL_URL = process.env.WEB_PUBLIC_URL;
  const ORIGINAL_ALLOW = process.env.WEB_PUBLIC_ALLOWED_HOSTS;

  beforeEach(() => {
    delete process.env.WEB_PUBLIC_URL;
    delete process.env.WEB_PUBLIC_ALLOWED_HOSTS;
  });

  afterEach(() => {
    if (ORIGINAL_URL === undefined) delete process.env.WEB_PUBLIC_URL;
    else process.env.WEB_PUBLIC_URL = ORIGINAL_URL;
    if (ORIGINAL_ALLOW === undefined) delete process.env.WEB_PUBLIC_ALLOWED_HOSTS;
    else process.env.WEB_PUBLIC_ALLOWED_HOSTS = ORIGINAL_ALLOW;
  });

  it('WEB_PUBLIC_URL gana sobre cualquier header', () => {
    process.env.WEB_PUBLIC_URL = 'https://aula.va360.academy';
    const req = makeReq({ 'x-forwarded-host': 'atacante.evil', 'x-forwarded-proto': 'https' });
    expect(resolveWebBaseUrlForAuthRedirect(req)).toBe('https://aula.va360.academy');
  });

  it('SEGURIDAD: sin env, un host NO allowlisted se IGNORA → localhost (no se exfiltran tokens)', () => {
    const req = makeReq({ 'x-forwarded-host': 'atacante.evil', 'x-forwarded-proto': 'https' });
    expect(resolveWebBaseUrlForAuthRedirect(req)).toBe('http://localhost:3000');
  });

  it('sin env, un host SÍ allowlisted se usa', () => {
    process.env.WEB_PUBLIC_ALLOWED_HOSTS = 'aula.va360.academy, dev.didacta.io';
    const req = makeReq({ 'x-forwarded-host': 'dev.didacta.io', 'x-forwarded-proto': 'https' });
    expect(resolveWebBaseUrlForAuthRedirect(req)).toBe('https://dev.didacta.io');
  });

  it('la allowlist es case-insensitive y tolera espacios', () => {
    process.env.WEB_PUBLIC_ALLOWED_HOSTS = '  AULA.VA360.Academy ';
    const req = makeReq({ host: 'aula.va360.academy' });
    expect(resolveWebBaseUrlForAuthRedirect(req)).toBe('https://aula.va360.academy');
  });

  it('host del request distinto al allowlisted → localhost', () => {
    process.env.WEB_PUBLIC_ALLOWED_HOSTS = 'aula.va360.academy';
    const req = makeReq({ host: 'didacta-api:4000' });
    expect(resolveWebBaseUrlForAuthRedirect(req)).toBe('http://localhost:3000');
  });

  it('sin env ni request → localhost', () => {
    expect(resolveWebBaseUrlForAuthRedirect()).toBe('http://localhost:3000');
  });
});
