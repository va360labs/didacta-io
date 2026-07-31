/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * MfaPolicyService — CRUD de la política MFA tenant-wide + evaluación en login.
 *
 * Persistencia: `tenant_setting` (module=auth, key=mfa-policy, isSecret=false).
 * Reusamos la infraestructura existente para no añadir migración de schema.
 *
 * Capability EE: `feat:mfa.enforcement`. El gate vive en el controller (PUT) y
 * en `evaluateLoginPolicy` (lectura segura — failsafe si la licencia caduca).
 */

import { Injectable } from '@nestjs/common';
import { LicenseService, LICENSE_CAPABILITIES } from '@didacta/license-sdk';
import { PrismaTenantConfigService } from '../../modules/prisma-tenant-config.service';
import {
  defaultMfaPolicy,
  MFA_POLICY_KEY,
  MFA_POLICY_MODULE_NAME,
  type MfaPolicyOutcome,
  type MfaPolicyState,
} from './mfa-policy.types';

/**
 * Roles administrativos para los que MFA YA es obligatorio en plan Community
 * (heredado de LMS-109). La política tenant-wide solo añade enforcement al
 * resto de usuarios cuando `requiredForAll=true` y la capability EE está activa.
 *
 * Ojo: esta lista debe coincidir con `auth.service.ts:ADMIN_ROLES` y con
 * `jwt-auth.guard.ts:ADMIN_ROLES_REQUIRING_MFA`. No la centralizamos en un
 * único módulo todavía (eso es Fase 2) — por ahora la triplicamos a propósito
 * para no acoplar este piloto al kernel de auth.
 */
const ADMIN_ROLES_REQUIRING_MFA = new Set(['super_admin', 'tenant_admin']);

const ONE_DAY_MS = 86_400_000;

/** URL relativa del flujo de setup MFA en el frontend. */
const MFA_SETUP_URL = '/mfa/setup';

@Injectable()
export class MfaPolicyService {
  constructor(
    private readonly tenantConfig: PrismaTenantConfigService,
    private readonly license: LicenseService,
  ) {}

  /**
   * Devuelve la política activa del tenant. Si no hay valor persistido,
   * devuelve los defaults (NO los persiste — los GETs son idempotentes).
   *
   * Incluye también un campo derivado `enforcementActive` que indica si
   * la capability EE está activa Y la política tiene `requiredForAll=true`.
   * Los clientes lo usan para mostrar UI distinta.
   */
  async getPolicy(tenantId: string): Promise<{
    policy: MfaPolicyState;
    enforcementActive: boolean;
    capability: string;
    licensed: boolean;
  }> {
    const stored = await this.tenantConfig.get<MfaPolicyState>(
      tenantId,
      MFA_POLICY_MODULE_NAME,
      MFA_POLICY_KEY,
    );
    const policy = stored ?? defaultMfaPolicy();
    const licensed = this.license.isCapabilityEnabled(LICENSE_CAPABILITIES.MFA_ENFORCEMENT);
    return {
      policy,
      enforcementActive: licensed && policy.requiredForAll,
      capability: LICENSE_CAPABILITIES.MFA_ENFORCEMENT,
      licensed,
    };
  }

  /**
   * Persiste una nueva política. El gate de capability EE lo aplica el
   * controller con @RequiresCapability — este service confía en que el
   * caller ya pasó el guard.
   *
   * Devuelve el estado normalizado para que el caller lo retorne al cliente.
   */
  async updatePolicy(
    tenantId: string,
    dto: { requiredForAll: boolean; gracePeriodDays: number },
    actor: { userId: string },
    now: Date = new Date(),
  ): Promise<MfaPolicyState> {
    const next: MfaPolicyState = {
      requiredForAll: dto.requiredForAll,
      gracePeriodDays: dto.gracePeriodDays,
      updatedAt: now.toISOString(),
      updatedBy: actor.userId,
    };
    await this.tenantConfig.set<MfaPolicyState>(
      tenantId,
      MFA_POLICY_MODULE_NAME,
      MFA_POLICY_KEY,
      next,
      { isSecret: false, actorId: actor.userId },
    );
    return next;
  }

  /**
   * Evalúa la política para un usuario concreto en el momento del login.
   * Centraliza la lógica para que `auth.service.signin/signup` solo decida
   * qué hacer con el outcome.
   *
   * Reglas (en orden):
   *   1. Si la capability EE NO está activa → allow (failsafe).
   *   2. Si la política `requiredForAll=false` → allow.
   *   3. Si el usuario ya tiene `mfaEnabled=true` → allow.
   *   4. Si el usuario es admin (super_admin / tenant_admin) → allow aquí
   *      (su MFA se exige por el flujo separado de LMS-109; no lo duplicamos).
   *   5. Si todavía estamos dentro del grace period → warn.
   *   6. Si pasó el grace period → block.
   */
  async evaluateLoginPolicy(
    tenantId: string,
    user: { mfaEnabled: boolean; roles: readonly string[] },
    now: Date = new Date(),
  ): Promise<MfaPolicyOutcome> {
    const licensed = this.license.isCapabilityEnabled(LICENSE_CAPABILITIES.MFA_ENFORCEMENT);
    if (!licensed) return { outcome: 'allow' };

    const stored = await this.tenantConfig.get<MfaPolicyState>(
      tenantId,
      MFA_POLICY_MODULE_NAME,
      MFA_POLICY_KEY,
    );
    if (!stored || !stored.requiredForAll) return { outcome: 'allow' };

    if (user.mfaEnabled) return { outcome: 'allow' };

    if (user.roles.some((r) => ADMIN_ROLES_REQUIRING_MFA.has(r))) {
      // Admins ya están cubiertos por LMS-109. No queremos duplicar el
      // bloqueo desde dos sitios distintos: la política tenant-wide solo
      // afecta al resto del tenant.
      return { outcome: 'allow' };
    }

    const updatedAtMs = new Date(stored.updatedAt).getTime();
    const graceEndMs = updatedAtMs + stored.gracePeriodDays * ONE_DAY_MS;
    const nowMs = now.getTime();

    if (nowMs <= graceEndMs) {
      return {
        outcome: 'warn',
        gracePeriodDays: stored.gracePeriodDays,
        gracePeriodExpiresAt: new Date(graceEndMs).toISOString(),
        setupUrl: MFA_SETUP_URL,
      };
    }

    return {
      outcome: 'block',
      gracePeriodDays: stored.gracePeriodDays,
      gracePeriodExpiredAt: new Date(graceEndMs).toISOString(),
      setupUrl: MFA_SETUP_URL,
    };
  }
}
