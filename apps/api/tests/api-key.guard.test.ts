import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ALLOWED_API_KEY_SCOPES, grantableApiKeyScopes } from '../src/auth/api-key-scopes';
import { JwtOrApiKeyGuard } from '../src/auth/api-key.guard';
import type { ApiKeyService } from '../src/auth/api-key.service';
import { ApiScopeGuard } from '../src/auth/api-scope.guard';
import type { SessionClaims, TokenService } from '../src/auth/token.service';

/**
 * `JwtOrApiKeyGuard` vuelca los scopes de la API key en `request.user.roles`.
 *
 * Mientras `POST /auth/api-keys` aceptó scopes de texto libre, cualquiera podía
 * guardarse una key con `scopes = ['tenant_admin']`. Cerrar la creación no
 * borra esas filas: siguen en la base de datos de cada instalación que haya
 * corrido una versión anterior. Lo que aquí se fija es que YA NO PUEDEN
 * convertirse en un rol, sin tocar datos.
 */

function makeGuard(storedScopes: string[]) {
  const apiKeys = {
    findValidByToken: vi.fn(async () => ({
      id: 'key-1',
      tenantId: 'tenant-A',
      userId: 'alumno-1',
      scopes: storedScopes,
    })),
  } as unknown as ApiKeyService;
  const reflector = { getAllAndOverride: vi.fn(() => undefined) } as unknown as Reflector;
  return new JwtOrApiKeyGuard({} as TokenService, apiKeys, reflector);
}

async function claimsFor(storedScopes: string[]): Promise<SessionClaims> {
  const req: { headers: Record<string, string>; user?: SessionClaims } = {
    headers: { authorization: 'ApiKey lmsk_antigua' },
  };
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  expect(await makeGuard(storedScopes).canActivate(ctx)).toBe(true);
  return req.user!;
}

describe('JwtOrApiKeyGuard · una key antigua no escala', () => {
  it.each([['tenant_admin'], ['super_admin'], ['formador'], ['auditor']])(
    'una key guardada con el «scope» %s no otorga ese rol',
    async (role) => {
      const user = await claimsFor([role]);
      expect(user.roles).not.toContain(role);
      expect(user.roles).toEqual([]);
    },
  );

  it('de una key mezclada sobreviven los scopes legítimos y cae el resto', async () => {
    const user = await claimsFor([
      'tenant_admin',
      'enrollments:write',
      'super_admin',
      'inventado:write',
      'courses:read',
    ]);
    expect(user.roles).toEqual(['enrollments:write', 'courses:read']);
    // La identidad no cambia: sigue siendo la key de ese usuario en ese tenant.
    expect(user.sub).toBe('alumno-1');
    expect(user.tenantId).toBe('tenant-A');
  });

  it('una key normal conserva todos sus scopes (el filtro no rompe las buenas)', async () => {
    const user = await claimsFor([...ALLOWED_API_KEY_SCOPES]);
    expect(user.roles).toEqual([...ALLOWED_API_KEY_SCOPES]);
  });

  /**
   * El caso completo, con el segundo guard detrás: un endpoint que exige un
   * scope que la key antigua DICE tener pero que no está en el catálogo.
   */
  it('un scope fuera del catálogo tampoco abre un endpoint que lo exija', async () => {
    const user = await claimsFor(['inventado:write']);
    const scopeGuard = new ApiScopeGuard({
      getAllAndOverride: vi.fn(() => ['inventado:write']),
    } as unknown as Reflector);
    const ctx = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
    expect(() => scopeGuard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});

describe('grantableApiKeyScopes', () => {
  it('no confunde un nombre de rol con un scope aunque el catálogo crezca', () => {
    // Ningún scope del catálogo puede coincidir con un rol del sistema: si un
    // día alguien añade `tenant_admin` a la lista, este test lo dice.
    // Los roles que siembra `packages/database/src/seed.ts`.
    const ROLES = [
      'super_admin',
      'tenant_admin',
      'formador',
      'alumno',
      'auditor',
      'empresa_manager',
    ];
    for (const role of ROLES) expect(ALLOWED_API_KEY_SCOPES).not.toContain(role);
    expect(grantableApiKeyScopes(ROLES)).toEqual([]);
  });
});
