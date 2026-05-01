/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * LicenseService — singleton que carga la licencia al boot, expone el estado
 * y los métodos de gating. Estado distinto a la API de jose porque expresa el
 * ciclo de vida de la licencia (community/active/grace/expired/invalid/dev).
 *
 * Implementación deliberadamente sin decorators de Nest aquí: este archivo es
 * agnóstico de framework. La integración con Nest vive en `nest.ts`/`guards.ts`.
 */

import {
  CapabilityRequiredError,
  type LicensePayload,
  type LicenseState,
  type LicenseStatus,
  type LicenseSubject,
} from './types.js';
import { ALL_CAPABILITIES, LICENSE_CAPABILITIES, type LicenseCapability } from './capabilities.js';
import { verifyLicense } from './verifier.js';

const COMMUNITY_STATE: LicenseState = {
  status: 'community',
  loadedAt: new Date(0),
  source: 'unknown',
  warnings: [],
};

export interface LoadOptions {
  /** El JWT firmado de la licencia. */
  key?: string | null;
  /**
   * Si está activo y `NODE_ENV !== 'production'`, el SDK entra en modo `dev`
   * con todas las capabilities habilitadas. Sembrarlo desde `DIDACTA_DEV_BYPASS=true`
   * en el `.env.local` del dev.
   */
  allowDevBypass?: boolean;
  /** Source informativo para diagnostics. */
  source?: LicenseState['source'];
  /** Override de fecha actual (tests). */
  now?: () => Date;
}

export class LicenseService {
  private state: LicenseState = { ...COMMUNITY_STATE };
  private nowFn: () => Date = () => new Date();

  async load(options: LoadOptions = {}): Promise<LicenseState> {
    if (options.now) this.nowFn = options.now;
    const now = this.nowFn();

    // Sin key: estado community puro.
    if (!options.key) {
      this.state = {
        status: 'community',
        loadedAt: now,
        source: options.source ?? 'env',
        warnings: [],
      };
      return this.state;
    }

    // Dev bypass: solo si no es producción.
    if (options.allowDevBypass && process.env.NODE_ENV !== 'production') {
      this.state = {
        status: 'dev',
        loadedAt: now,
        source: 'dev-bypass',
        warnings: [
          'DEV BYPASS ACTIVE — all Enterprise capabilities are enabled. Never enable in production.',
        ],
        // En dev, sintetizamos un payload que cumple el schema con todas las capabilities.
        payload: this.synthesizeDevPayload(now),
        subject: this.synthesizeDevSubject(now),
      };
      return this.state;
    }

    // Verificación criptográfica.
    let payload: LicensePayload;
    try {
      payload = await verifyLicense(options.key);
    } catch (err) {
      this.state = {
        status: 'invalid',
        loadedAt: now,
        source: options.source ?? 'env',
        warnings: [`License invalid: ${(err as Error).message}`],
      };
      return this.state;
    }

    const expiresAt = new Date(payload.didacta.expiresAt);
    const issuedAt = new Date(payload.didacta.issuedAt);
    const grace = (payload.didacta.gracePeriodDays ?? 30) * 24 * 60 * 60 * 1000;

    let status: LicenseStatus = 'active';
    const warnings: string[] = [];

    const millisToExpiry = expiresAt.getTime() - now.getTime();
    if (millisToExpiry < 0) {
      const millisAfterExpiry = -millisToExpiry;
      if (millisAfterExpiry < grace) {
        status = 'grace';
        const daysLeftInGrace = Math.ceil((grace - millisAfterExpiry) / 86_400_000);
        warnings.push(
          `License expired on ${payload.didacta.expiresAt}. Currently in grace period (${daysLeftInGrace} day(s) remaining).`,
        );
      } else {
        status = 'expired';
        warnings.push(
          `License expired on ${payload.didacta.expiresAt} and is past the ${payload.didacta.gracePeriodDays}-day grace period.`,
        );
      }
    } else if (millisToExpiry < 30 * 86_400_000) {
      const daysLeft = Math.ceil(millisToExpiry / 86_400_000);
      warnings.push(
        `License expires in ${daysLeft} day(s) (${payload.didacta.expiresAt}). Renew soon.`,
      );
    }

    const subject: LicenseSubject = {
      licenseId: payload.didacta.licenseId,
      customerId: payload.didacta.customerId,
      organizationId: payload.didacta.organizationId,
      organizationName: payload.didacta.organizationName,
      plan: payload.didacta.plan,
      edition: payload.didacta.edition,
      issuedAt,
      expiresAt,
      capabilities: payload.didacta.capabilities,
    };

    this.state = {
      status,
      loadedAt: now,
      source: options.source ?? 'env',
      payload,
      subject,
      warnings,
    };
    return this.state;
  }

  getState(): LicenseState {
    return this.state;
  }

  getStatus(): LicenseStatus {
    return this.state.status;
  }

  getSubject(): LicenseSubject | undefined {
    return this.state.subject;
  }

  /**
   * Devuelve true si la capability está activa.
   *
   * Reglas:
   * - `dev` → siempre true.
   * - `community` / `invalid` / `expired` → false.
   * - `active` / `grace` → true si la capability está en el payload.
   */
  isCapabilityEnabled(capability: LicenseCapability | string): boolean {
    const status = this.state.status;
    if (status === 'dev') return true;
    if (status === 'community' || status === 'invalid' || status === 'expired') {
      return false;
    }
    return this.state.subject?.capabilities.includes(capability) ?? false;
  }

  /**
   * Lanza CapabilityRequiredError si la capability no está activa.
   * Útil para sembrar gating en services sin decorator.
   */
  requireCapability(capability: LicenseCapability | string): void {
    if (!this.isCapabilityEnabled(capability)) {
      throw new CapabilityRequiredError(capability);
    }
  }

  /** Devuelve la lista completa de capabilities activas en este momento. */
  listActiveCapabilities(): readonly string[] {
    if (this.state.status === 'dev') return ALL_CAPABILITIES;
    if (
      this.state.status === 'community' ||
      this.state.status === 'invalid' ||
      this.state.status === 'expired'
    ) {
      return [];
    }
    return this.state.subject?.capabilities ?? [];
  }

  // ─── Internals ────────────────────────────────────────────────────

  private synthesizeDevPayload(now: Date): LicensePayload {
    const exp = new Date(now.getTime() + 365 * 86_400_000);
    return {
      iss: 'didacta.io',
      aud: 'didacta-runtime',
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(exp.getTime() / 1000),
      didacta: {
        licenseId: 'lic_dev_bypass',
        customerId: 'cus_dev',
        organizationId: 'org_dev',
        organizationName: 'Development Bypass',
        product: 'didacta',
        plan: 'dev',
        edition: 'enterprise',
        issuedAt: now.toISOString(),
        expiresAt: exp.toISOString(),
        gracePeriodDays: 30,
        capabilities: [...ALL_CAPABILITIES],
      },
    };
  }

  private synthesizeDevSubject(now: Date): LicenseSubject {
    const expiresAt = new Date(now.getTime() + 365 * 86_400_000);
    return {
      licenseId: 'lic_dev_bypass',
      customerId: 'cus_dev',
      organizationId: 'org_dev',
      organizationName: 'Development Bypass',
      plan: 'dev',
      edition: 'enterprise',
      issuedAt: now,
      expiresAt,
      capabilities: [...ALL_CAPABILITIES],
    };
  }
}

export { LICENSE_CAPABILITIES };
