/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del CustomDomainsService — cuarto piloto License SDK.
 *
 * Foco en la lógica de negocio del service SIN tocar Postgres: usamos un
 * fake `PrismaTenantConfigService` que mantiene un Map en memoria por
 * (tenant, module, key). Esto valida ramas de error (404, 409 por hostname
 * duplicado, 409 por token incorrecto) y la persistencia del shape correcto.
 *
 * El gating EE NO se prueba aquí (eso lo hace el controller test); el
 * service confía en el guard del controller.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CustomDomainsService } from '../src/admin/custom-domains/custom-domains.service';
import {
  CUSTOM_DOMAINS_KEY,
  CUSTOM_DOMAINS_MODULE_NAME,
  resolveCnameTarget,
  type CustomDomainsConfig,
} from '../src/admin/custom-domains/custom-domains.types';

type FakeTenantConfig = ConstructorParameters<typeof CustomDomainsService>[0];

/**
 * Fake con storage in-memory por (tenantId, module, key). Devuelve undefined
 * si no se ha hecho `set` aún, igual que el real.
 */
function makeTenantConfig(): FakeTenantConfig & { _store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const k = (t: string, m: string, key: string) => `${t}::${m}::${key}`;
  const fake = {
    get: vi.fn(async (t: string, m: string, key: string) => store.get(k(t, m, key))),
    set: vi.fn(async (t: string, m: string, key: string, value: unknown) => {
      store.set(k(t, m, key), value);
    }),
    _store: store,
  };
  return fake as unknown as FakeTenantConfig & { _store: Map<string, unknown> };
}

const ACTOR = { userId: 'user-1' };
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

describe('CustomDomainsService', () => {
  let tenantConfig: FakeTenantConfig & { _store: Map<string, unknown> };
  let service: CustomDomainsService;

  beforeEach(() => {
    tenantConfig = makeTenantConfig();
    service = new CustomDomainsService(tenantConfig);
  });

  describe('listDomains', () => {
    it('devuelve lista vacía si el tenant no tiene nada persistido', async () => {
      const list = await service.listDomains(TENANT_A);
      expect(list).toEqual([]);
      // GET es idempotente: NO escribe defaults a DB.
      expect(tenantConfig.set).not.toHaveBeenCalled();
    });

    it('tolera storage corrupto (sin domains array) → defaults', async () => {
      // Si alguien escribió un payload inválido (no debería pasar pero
      // defendemos contra bugs históricos), service devuelve defaults.
      tenantConfig._store.set(`${TENANT_A}::${CUSTOM_DOMAINS_MODULE_NAME}::${CUSTOM_DOMAINS_KEY}`, {
        foo: 'bar',
      });
      const list = await service.listDomains(TENANT_A);
      expect(list).toEqual([]);
    });
  });

  describe('addDomain', () => {
    it('crea un dominio en estado pending con cnameTarget + verificationToken', async () => {
      const domain = await service.addDomain(TENANT_A, { hostname: 'acme.com' }, ACTOR);
      expect(domain.hostname).toBe('acme.com');
      expect(domain.status).toBe('pending');
      expect(domain.cnameTarget).toBe(resolveCnameTarget());
      expect(domain.verificationToken).toMatch(/^[0-9a-f-]{36}$/);
      expect(domain.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(domain.verifiedAt).toBeNull();
      expect(typeof domain.createdAt).toBe('string');
    });

    it('persiste con isSecret=false en module=tenancy/key=custom-domains', async () => {
      await service.addDomain(TENANT_A, { hostname: 'acme.com' }, ACTOR);
      expect(tenantConfig.set).toHaveBeenCalledWith(
        TENANT_A,
        CUSTOM_DOMAINS_MODULE_NAME,
        CUSTOM_DOMAINS_KEY,
        expect.objectContaining({ domains: expect.any(Array) }),
        expect.objectContaining({ isSecret: false, actorId: 'user-1' }),
      );
    });

    it('rechaza duplicados con ConflictException', async () => {
      await service.addDomain(TENANT_A, { hostname: 'acme.com' }, ACTOR);
      await expect(service.addDomain(TENANT_A, { hostname: 'acme.com' }, ACTOR)).rejects.toThrow(
        ConflictException,
      );
    });

    it('permite el mismo hostname en tenants distintos (aislamiento)', async () => {
      await service.addDomain(TENANT_A, { hostname: 'acme.com' }, ACTOR);
      const other = await service.addDomain(TENANT_B, { hostname: 'acme.com' }, ACTOR);
      expect(other.hostname).toBe('acme.com');
      const listB = await service.listDomains(TENANT_B);
      expect(listB).toHaveLength(1);
      const listA = await service.listDomains(TENANT_A);
      expect(listA).toHaveLength(1);
      expect(listA[0]!.id).not.toBe(other.id);
    });

    it('anexa al array existente sin pisar dominios anteriores', async () => {
      await service.addDomain(TENANT_A, { hostname: 'acme.com' }, ACTOR);
      await service.addDomain(TENANT_A, { hostname: 'learn.acme.com' }, ACTOR);
      const list = await service.listDomains(TENANT_A);
      expect(list).toHaveLength(2);
      expect(list.map((d) => d.hostname)).toEqual(['acme.com', 'learn.acme.com']);
    });
  });

  describe('verifyDomain', () => {
    it('cambia status a verified si el providedToken coincide', async () => {
      const domain = await service.addDomain(TENANT_A, { hostname: 'acme.com' }, ACTOR);
      const verified = await service.verifyDomain(
        TENANT_A,
        domain.id,
        { providedToken: domain.verificationToken },
        ACTOR,
      );
      expect(verified.status).toBe('verified');
      expect(verified.verifiedAt).not.toBeNull();
      expect(verified.id).toBe(domain.id);
    });

    it('lanza ConflictException si el token no coincide', async () => {
      const domain = await service.addDomain(TENANT_A, { hostname: 'acme.com' }, ACTOR);
      await expect(
        service.verifyDomain(TENANT_A, domain.id, { providedToken: 'token-falso' }, ACTOR),
      ).rejects.toThrow(ConflictException);
    });

    it('lanza NotFoundException si el id no existe', async () => {
      await expect(
        service.verifyDomain(
          TENANT_A,
          '00000000-0000-0000-0000-000000000000',
          { providedToken: 'cualquiera' },
          ACTOR,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('un dominio del tenant B no se ve desde el tenant A', async () => {
      const dB = await service.addDomain(TENANT_B, { hostname: 'beta.example.com' }, ACTOR);
      // Intento de verificar el dominio de B usando tenantId A → 404.
      await expect(
        service.verifyDomain(TENANT_A, dB.id, { providedToken: dB.verificationToken }, ACTOR),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('setActive', () => {
    it('permite pasar de verified → inactive y volver a verified', async () => {
      const domain = await service.addDomain(TENANT_A, { hostname: 'acme.com' }, ACTOR);
      await service.verifyDomain(
        TENANT_A,
        domain.id,
        { providedToken: domain.verificationToken },
        ACTOR,
      );
      const off = await service.setActive(TENANT_A, domain.id, { status: 'inactive' }, ACTOR);
      expect(off.status).toBe('inactive');
      const on = await service.setActive(TENANT_A, domain.id, { status: 'verified' }, ACTOR);
      expect(on.status).toBe('verified');
    });

    it('lanza NotFoundException si el id no existe', async () => {
      await expect(
        service.setActive(
          TENANT_A,
          '00000000-0000-0000-0000-000000000000',
          { status: 'inactive' },
          ACTOR,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('removeDomain', () => {
    it('elimina el dominio del array y devuelve el eliminado', async () => {
      const a = await service.addDomain(TENANT_A, { hostname: 'acme.com' }, ACTOR);
      await service.addDomain(TENANT_A, { hostname: 'learn.acme.com' }, ACTOR);
      const removed = await service.removeDomain(TENANT_A, a.id, ACTOR);
      expect(removed.hostname).toBe('acme.com');
      const list = await service.listDomains(TENANT_A);
      expect(list).toHaveLength(1);
      expect(list[0]!.hostname).toBe('learn.acme.com');
    });

    it('lanza NotFoundException si el id no existe', async () => {
      await expect(
        service.removeDomain(TENANT_A, '00000000-0000-0000-0000-000000000000', ACTOR),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('resolveCnameTarget', () => {
    it('por defecto devuelve cname.didacta.io', () => {
      expect(resolveCnameTarget({} as NodeJS.ProcessEnv)).toBe('cname.didacta.io');
    });

    it('respeta DIDACTA_CNAME_TARGET cuando está definida', () => {
      const target = resolveCnameTarget({
        DIDACTA_CNAME_TARGET: 'edge.example.test',
      } as unknown as NodeJS.ProcessEnv);
      expect(target).toBe('edge.example.test');
    });

    it('cae a default si la env var es empty string', () => {
      const target = resolveCnameTarget({
        DIDACTA_CNAME_TARGET: '   ',
      } as unknown as NodeJS.ProcessEnv);
      expect(target).toBe('cname.didacta.io');
    });
  });

  describe('persistencia → shape', () => {
    it('el JSON guardado tiene exactamente { domains: [...] }', async () => {
      const a = await service.addDomain(TENANT_A, { hostname: 'acme.com' }, ACTOR);
      const stored = tenantConfig._store.get(
        `${TENANT_A}::${CUSTOM_DOMAINS_MODULE_NAME}::${CUSTOM_DOMAINS_KEY}`,
      ) as CustomDomainsConfig;
      expect(Object.keys(stored)).toEqual(['domains']);
      expect(stored.domains).toHaveLength(1);
      expect(stored.domains[0]!.id).toBe(a.id);
    });
  });
});
