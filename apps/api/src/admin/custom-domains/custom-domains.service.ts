/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * CustomDomainsService — CRUD de dominios personalizados por tenant.
 *
 * Persistencia: `tenant_setting` (module=tenancy, key=custom-domains,
 * isSecret=false). Reusamos la infraestructura existente para no añadir
 * migración Prisma — mismo patrón que `mfa-policy.service.ts`.
 *
 * Capability EE: `feat:custom_domains`. El gate vive en el controller a nivel
 * de cada endpoint; este service confía en que el caller ya pasó el guard.
 *
 * NOTA OPERACIONAL — verificación DNS:
 * En producción real, la transición `pending` → `verified` la dispara un
 * cron worker que resuelve CNAME + TXT del hostname y compara con el
 * `verificationToken` (DNS-01 challenge). En este piloto NO hacemos DNS
 * lookup — la verificación es manual: el caller pasa el token correcto al
 * endpoint /verify y forzamos el cambio de estado. Esto es suficiente para
 * exponer el flujo end-to-end y desbloquear la UI sin acoplarnos a un cron
 * que aún no existe. Documentado como TODO en el follow-up.
 */

import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaTenantConfigService } from '../../modules/prisma-tenant-config.service';
import {
  CUSTOM_DOMAINS_KEY,
  CUSTOM_DOMAINS_MODULE_NAME,
  defaultCustomDomainsConfig,
  resolveCnameTarget,
  type CustomDomain,
  type CustomDomainsConfig,
} from './custom-domains.types';

@Injectable()
export class CustomDomainsService {
  constructor(private readonly tenantConfig: PrismaTenantConfigService) {}

  /**
   * Devuelve la lista de dominios del tenant. Si no hay nada persistido,
   * devuelve la config por defecto (lista vacía) sin escribirla — los GETs
   * son idempotentes.
   */
  async listDomains(tenantId: string): Promise<CustomDomain[]> {
    const stored = await this.loadConfig(tenantId);
    return stored.domains;
  }

  /**
   * Añade un nuevo dominio en estado `pending`. Genera el `verificationToken`
   * (uuid v4) y resuelve el `cnameTarget` desde env.
   *
   * Reglas:
   *   - El hostname se almacena tal cual lo recibe el caller (ya viene
   *     normalizado a lowercase por el DTO).
   *   - Si ya existe un dominio con el mismo hostname para este tenant →
   *     409 Conflict.
   *   - El primer dominio del tenant arranca con la config por defecto
   *     (lista vacía); los siguientes se anexan.
   */
  async addDomain(
    tenantId: string,
    dto: { hostname: string },
    actor: { userId: string },
    now: Date = new Date(),
  ): Promise<CustomDomain> {
    const config = await this.loadConfig(tenantId);
    const exists = config.domains.find((d) => d.hostname === dto.hostname);
    if (exists) {
      throw new ConflictException({
        message: `El dominio ${dto.hostname} ya está registrado para este tenant.`,
        code: 'ADMIN_CUSTOM_DOMAIN_EXISTS',
        detail: dto.hostname,
      });
    }

    const domain: CustomDomain = {
      id: randomUUID(),
      hostname: dto.hostname,
      status: 'pending',
      cnameTarget: resolveCnameTarget(),
      verificationToken: randomUUID(),
      createdAt: now.toISOString(),
      verifiedAt: null,
    };

    const next: CustomDomainsConfig = {
      domains: [...config.domains, domain],
    };
    await this.persist(tenantId, next, actor.userId);
    return domain;
  }

  /**
   * Marca un dominio como `verified` si el `providedToken` coincide con el
   * `verificationToken` almacenado. El TODO real (cron de DNS-01) reemplaza
   * este check por una verificación de DNS efectiva.
   *
   * Errores:
   *   - 404 si no existe el id en este tenant.
   *   - 409 si el token no coincide (no diferenciamos errores de DNS vs token
   *     porque a nivel API es la misma "no pudimos validar").
   */
  async verifyDomain(
    tenantId: string,
    domainId: string,
    dto: { providedToken: string },
    actor: { userId: string },
    now: Date = new Date(),
  ): Promise<CustomDomain> {
    const config = await this.loadConfig(tenantId);
    const idx = config.domains.findIndex((d) => d.id === domainId);
    if (idx === -1) {
      throw new NotFoundException({
        message: `Dominio ${domainId} no encontrado.`,
        code: 'ADMIN_CUSTOM_DOMAIN_NOT_FOUND',
        detail: domainId,
      });
    }
    const current = config.domains[idx]!;
    if (current.verificationToken !== dto.providedToken) {
      throw new ConflictException({
        message: 'El token de verificación no coincide. Revisa el TXT record en tu DNS.',
        code: 'ADMIN_CUSTOM_DOMAIN_TOKEN_MISMATCH',
      });
    }
    const updated: CustomDomain = {
      ...current,
      status: 'verified',
      verifiedAt: now.toISOString(),
    };
    const nextDomains = [...config.domains];
    nextDomains[idx] = updated;
    await this.persist(tenantId, { domains: nextDomains }, actor.userId);
    return updated;
  }

  /**
   * Cambia el estado del dominio entre `verified` e `inactive` (no permite
   * volver a `pending` — eso lo hace `addDomain` desde cero).
   *
   * Útil para suspender temporalmente un dominio sin borrarlo (por ejemplo
   * durante una migración SSL).
   */
  async setActive(
    tenantId: string,
    domainId: string,
    dto: { status: 'verified' | 'inactive' },
    actor: { userId: string },
  ): Promise<CustomDomain> {
    const config = await this.loadConfig(tenantId);
    const idx = config.domains.findIndex((d) => d.id === domainId);
    if (idx === -1) {
      throw new NotFoundException({
        message: `Dominio ${domainId} no encontrado.`,
        code: 'ADMIN_CUSTOM_DOMAIN_NOT_FOUND',
        detail: domainId,
      });
    }
    const updated: CustomDomain = {
      ...config.domains[idx]!,
      status: dto.status,
    };
    const nextDomains = [...config.domains];
    nextDomains[idx] = updated;
    await this.persist(tenantId, { domains: nextDomains }, actor.userId);
    return updated;
  }

  /**
   * Borra un dominio del tenant. Devuelve el dominio eliminado para que el
   * caller pueda registrar el audit log con la info que ya no estará en DB.
   */
  async removeDomain(
    tenantId: string,
    domainId: string,
    actor: { userId: string },
  ): Promise<CustomDomain> {
    const config = await this.loadConfig(tenantId);
    const idx = config.domains.findIndex((d) => d.id === domainId);
    if (idx === -1) {
      throw new NotFoundException({
        message: `Dominio ${domainId} no encontrado.`,
        code: 'ADMIN_CUSTOM_DOMAIN_NOT_FOUND',
        detail: domainId,
      });
    }
    const removed = config.domains[idx]!;
    const nextDomains = config.domains.filter((d) => d.id !== domainId);
    await this.persist(tenantId, { domains: nextDomains }, actor.userId);
    return removed;
  }

  // ---------------------------------------------------------------------------
  // Helpers privados
  // ---------------------------------------------------------------------------

  private async loadConfig(tenantId: string): Promise<CustomDomainsConfig> {
    const stored = await this.tenantConfig.get<CustomDomainsConfig>(
      tenantId,
      CUSTOM_DOMAINS_MODULE_NAME,
      CUSTOM_DOMAINS_KEY,
    );
    if (!stored || !Array.isArray(stored.domains)) {
      return defaultCustomDomainsConfig();
    }
    return stored;
  }

  private async persist(
    tenantId: string,
    config: CustomDomainsConfig,
    actorId: string,
  ): Promise<void> {
    await this.tenantConfig.set<CustomDomainsConfig>(
      tenantId,
      CUSTOM_DOMAINS_MODULE_NAME,
      CUSTOM_DOMAINS_KEY,
      config,
      { isSecret: false, actorId },
    );
  }
}
