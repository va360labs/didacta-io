/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Orquesta la licencia desde `/admin/licencia`: precedencia env > BD (§1 de
 * `work/migracion-env-a-panel.md`), validación en vivo antes de persistir, y
 * recarga del `LicenseService` global tras cada cambio — sin esto, guardar
 * desde el panel no surtiría efecto hasta reiniciar el contenedor (el
 * bloqueador descrito en §B1 del mismo documento).
 *
 * No hay renovación automática ni servidor de licencias aquí — eso es el
 * "motor" de `work/motor-licencias-propuesta.md` (L1-L4), decisión de
 * producto aparte. Esto es L0: el JWT actual, gestionable desde el panel.
 */

import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { LicenseService, type LicenseState } from '@didacta/license-sdk';
import { PrismaInstanceConfigService } from '../modules/prisma-instance-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSanctionedGlobalAccess } from '../tenancy/tenant-context.storage';

const SCOPE = 'license';
const KEY = 'key';

export interface AdminLicenseStatusDto {
  status: LicenseState['status'];
  source: LicenseState['source'];
  /** True si `DIDACTA_LICENSE_KEY` está fijada por env — el panel pasa a solo lectura. */
  managedByEnv: boolean;
  hasKeyConfigured: boolean;
  updatedAt: string | null;
  licenseId?: string;
  customerId?: string;
  organizationId?: string;
  organizationName?: string;
  plan?: string;
  edition?: 'community' | 'enterprise' | 'cloud';
  issuedAt?: string;
  expiresAt?: string;
  capabilities: string[];
  warnings: string[];
  loadedAt: string;
}

@Injectable()
export class LicenseAdminService {
  constructor(
    private readonly license: LicenseService,
    private readonly settings: PrismaInstanceConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private envKey(): string | null {
    return process.env['DIDACTA_LICENSE_KEY']?.trim() || null;
  }

  private allowDevBypass(): boolean {
    return process.env['DIDACTA_DEV_BYPASS'] === 'true';
  }

  /**
   * Re-resuelve la key vigente (env > BD) y recarga `LicenseService`. Barato:
   * la verificación ES256 es local, sin red — se puede llamar en cada GET
   * para que el estado (active/grace/expired) nunca quede obsoleto entre
   * visitas al panel, sin necesitar un worker en background.
   */
  async reload(): Promise<LicenseState> {
    const envKey = this.envKey();
    if (envKey) {
      return this.license.load({
        key: envKey,
        source: 'env',
        allowDevBypass: this.allowDevBypass(),
      });
    }
    const dbKey = (await this.settings.get<string>(SCOPE, KEY)) ?? null;
    return this.license.load({
      key: dbKey,
      source: dbKey ? 'admin-panel' : undefined,
      allowDevBypass: this.allowDevBypass(),
    });
  }

  async getStatus(): Promise<AdminLicenseStatusDto> {
    const state = await this.reload();
    return this.toDto(state);
  }

  async setKey(key: string, actorId: string): Promise<AdminLicenseStatusDto> {
    if (this.envKey()) {
      throw new ConflictException(
        'La licencia está fijada por la variable de entorno DIDACTA_LICENSE_KEY del operador — no se puede editar desde el panel.',
      );
    }
    const trimmed = key.trim();
    if (!trimmed) throw new BadRequestException('La clave no puede estar vacía.');

    // Valida ANTES de persistir: una key inválida no debe pisar la anterior.
    const state = await this.license.load({
      key: trimmed,
      source: 'admin-panel',
      allowDevBypass: this.allowDevBypass(),
    });
    if (state.status === 'invalid') {
      throw new BadRequestException(
        `Licencia inválida: ${state.warnings.join(' | ') || 'firma o payload no reconocidos'}`,
      );
    }

    await this.settings.set(SCOPE, KEY, trimmed, { isSecret: true, actorId });
    return this.toDto(state);
  }

  async clearKey(actorId: string): Promise<AdminLicenseStatusDto> {
    if (this.envKey()) {
      throw new ConflictException(
        'La licencia está fijada por la variable de entorno DIDACTA_LICENSE_KEY del operador — no se puede borrar desde el panel.',
      );
    }
    await this.settings.delete(SCOPE, KEY, { actorId });
    const state = await this.reload();
    return this.toDto(state);
  }

  private async toDto(state: LicenseState): Promise<AdminLicenseStatusDto> {
    const meta = (await this.settings.list(SCOPE)).find((m) => m.key === KEY);
    const subj = state.subject;
    const domainWarnings = await this.checkAllowedDomains(state);
    return {
      status: state.status,
      source: state.source,
      managedByEnv: Boolean(this.envKey()),
      hasKeyConfigured: Boolean(meta?.hasValue),
      updatedAt: meta?.updatedAt.toISOString() ?? null,
      licenseId: subj?.licenseId,
      customerId: subj?.customerId,
      organizationId: subj?.organizationId,
      organizationName: subj?.organizationName,
      plan: subj?.plan,
      edition: subj?.edition,
      issuedAt: subj?.issuedAt?.toISOString(),
      expiresAt: subj?.expiresAt?.toISOString(),
      capabilities: subj?.capabilities ?? [],
      warnings: [...state.warnings, ...domainWarnings],
      loadedAt: state.loadedAt.toISOString(),
    };
  }

  /**
   * L1 de `work/motor-licencias-propuesta.md` §3.7: cablea
   * `constraints.allowedDomains` (declarado en el schema del SDK desde el
   * principio, nunca comprobado — H3). Modo WARNING únicamente: un dominio
   * mal declarado no debe bloquear una instalación Enterprise en producción,
   * solo avisar. No vive en `license-sdk` porque el SDK es agnóstico de
   * framework/Prisma — el cruce con `TenantDomain` vive aquí.
   */
  private async checkAllowedDomains(state: LicenseState): Promise<string[]> {
    const allowed = state.payload?.didacta.constraints?.allowedDomains;
    if (!allowed || allowed.length === 0) return [];

    const allowedSet = new Set(allowed.map((d) => d.toLowerCase()));
    const domains = await runSanctionedGlobalAccess(() =>
      this.prisma.tenantDomain.findMany({
        where: { isVerified: true },
        select: { hostname: true },
      }),
    );
    const uncovered = domains
      .map((d) => d.hostname)
      .filter((hostname) => !allowedSet.has(hostname.toLowerCase()));
    if (uncovered.length === 0) return [];

    return [
      `Esta instalación tiene dominio(s) verificado(s) fuera de los declarados en la licencia (${uncovered.join(', ')}). No bloquea nada — solo revisa que tu licencia cubra los dominios reales.`,
    ];
  }
}
