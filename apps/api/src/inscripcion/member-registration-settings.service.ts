/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaTenantConfigService } from '../modules/prisma-tenant-config.service';

// ============================================================================
// Settings por TENANT del flujo de inscripción de miembros. Sustituyen a las
// variables de entorno de instancia (TELEGRAM_* y MEMBER_APPROVAL_EMAIL), que
// quedan como fallback global del despliegue — misma cascada tenant → env →
// none que TenantSmtpResolverService. El scope coincide con el slug del futuro
// módulo (D13: mod.member-registration).
// ============================================================================

/** Scope en `tenant_setting` (namespace del futuro módulo). */
export const MEMBER_REGISTRATION_SCOPE = 'member-registration';
/** Key del bot de Telegram (SECRETO: el token se cifra at-rest). */
export const TELEGRAM_SETTING_KEY = 'telegram';
/** Key de la política de verificación (plana). */
export const VERIFICATION_SETTING_KEY = 'verification';
/** Key del aprobador de solicitudes (plana). */
export const APPROVAL_SETTING_KEY = 'approval';

/** Verificadores componibles soportados. El orden define los pasos del wizard. */
export const MEMBER_VERIFIERS = ['telegram', 'otp'] as const;
export type MemberVerifier = (typeof MEMBER_VERIFIERS)[number];

/** Config del bot de Telegram del tenant (gate opcional de inscripción). */
export interface TelegramGateConfig {
  botToken: string;
  groupId: string;
  /** Username del bot (sin `@`) para el Login Widget. */
  botUsername: string | null;
}

/** Política de verificación del registro de miembros del tenant. */
export interface RegistrationPolicy {
  /** false = registro CERRADO: solo el admin da de alta. */
  enabled: boolean;
  /** Verificadores exigidos ([] = registro libre, solo aprobación manual). */
  verifiers: MemberVerifier[];
}

/** Política resuelta junto con su operatividad real. */
export interface EffectiveRegistrationPolicy extends RegistrationPolicy {
  /**
   * false cuando un verificador exigido no puede ejercitarse (p.ej. `telegram`
   * sin bot configurado). El flujo queda INDISPONIBLE (fail-closed) en vez de
   * degradarse saltándose el verificador.
   */
  operational: boolean;
  /** Username del bot si `telegram` está exigido y configurado; null si no. */
  botUsername: string | null;
}

/**
 * Resolutor de settings del flujo de inscripción por tenant.
 *
 * Cascada por clave (patrón TenantSmtpResolverService):
 * 1. `tenant_setting` scope `member-registration` (bot como secreto cifrado).
 * 2. Env global del despliegue (`TELEGRAM_*`, `MEMBER_APPROVAL_EMAIL`) como
 *    fallback legacy para instalaciones mono-tenant ya desplegadas.
 * 3. Sin nada → la feature queda desactivada para ese tenant.
 *
 * Errores de descifrado (clave rotada) se tratan como "tenant sin setting" y
 * caen al fallback: un problema operativo de claves no debe tirar el flujo.
 * NUNCA se loguean tokens ni emails de aprobador.
 */
@Injectable()
export class MemberRegistrationSettingsService {
  private readonly logger = new Logger(MemberRegistrationSettingsService.name);

  constructor(private readonly tenantConfig: PrismaTenantConfigService) {}

  /** Config del bot de Telegram del tenant, o null si no hay (setting ni env). */
  async resolveTelegram(tenantId: string): Promise<TelegramGateConfig | null> {
    const raw = await this.safeGet(tenantId, TELEGRAM_SETTING_KEY);
    const fromSetting = this.parseTelegram(raw);
    if (fromSetting) return fromSetting;

    const botToken = process.env['TELEGRAM_BOT_TOKEN']?.trim();
    const groupId = process.env['TELEGRAM_GROUP_ID']?.trim();
    if (!botToken || !groupId) return null;
    return {
      botToken,
      groupId,
      botUsername: process.env['TELEGRAM_BOT_USERNAME']?.trim() || null,
    };
  }

  /**
   * Política de verificación del tenant. Sin setting explícito, el default
   * preserva el comportamiento histórico: si hay bot de Telegram resoluble,
   * el flujo exige telegram+otp; si no, el registro queda cerrado.
   */
  async resolvePolicy(tenantId: string): Promise<RegistrationPolicy> {
    const raw = await this.safeGet(tenantId, VERIFICATION_SETTING_KEY);
    const parsed = this.parsePolicy(raw);
    if (parsed) return parsed;

    const telegram = await this.resolveTelegram(tenantId);
    return telegram
      ? { enabled: true, verifiers: ['telegram', 'otp'] }
      : { enabled: false, verifiers: [] };
  }

  /**
   * Política + operatividad: el flujo solo está disponible si está habilitado
   * Y todos los verificadores exigidos pueden ejercitarse hoy.
   */
  async resolveEffectivePolicy(tenantId: string): Promise<EffectiveRegistrationPolicy> {
    const policy = await this.resolvePolicy(tenantId);
    if (!policy.verifiers.includes('telegram')) {
      return { ...policy, operational: policy.enabled, botUsername: null };
    }
    const telegram = await this.resolveTelegram(tenantId);
    if (!telegram) {
      // Fail-closed: exigir telegram sin bot configurado deja el flujo caído,
      // nunca degradado a "sin verificación".
      return { ...policy, operational: false, botUsername: null };
    }
    return { ...policy, operational: policy.enabled, botUsername: telegram.botUsername };
  }

  /** Email del aprobador de solicitudes del tenant (setting → env → null). */
  async resolveApproverEmail(tenantId: string): Promise<string | null> {
    const raw = await this.safeGet(tenantId, APPROVAL_SETTING_KEY);
    if (raw && typeof raw === 'object') {
      const email = (raw as { email?: unknown }).email;
      if (typeof email === 'string' && email.trim()) return email.trim();
    }
    return process.env['MEMBER_APPROVAL_EMAIL']?.trim() || null;
  }

  // -------------------- helpers --------------------

  private async safeGet(tenantId: string, key: string): Promise<unknown> {
    try {
      return await this.tenantConfig.get(tenantId, MEMBER_REGISTRATION_SCOPE, key);
    } catch (err) {
      this.logger.warn(
        `[member-registration] no se pudo leer el setting ${key} del tenant ${tenantId}: ` +
          `${(err as Error).message.slice(0, 200)}. Se usa el fallback (env/default).`,
      );
      return undefined;
    }
  }

  private parseTelegram(raw: unknown): TelegramGateConfig | null {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Record<string, unknown>;
    const botToken = typeof value['botToken'] === 'string' ? value['botToken'].trim() : '';
    const groupId = typeof value['groupId'] === 'string' ? value['groupId'].trim() : '';
    if (!botToken || !groupId) return null;
    const botUsername =
      typeof value['botUsername'] === 'string' && value['botUsername'].trim()
        ? value['botUsername'].trim().replace(/^@/, '')
        : null;
    return { botToken, groupId, botUsername };
  }

  private parsePolicy(raw: unknown): RegistrationPolicy | null {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Record<string, unknown>;
    if (typeof value['enabled'] !== 'boolean') return null;
    const list = Array.isArray(value['verifiers']) ? value['verifiers'] : [];
    // Solo verificadores conocidos, sin duplicados, en el orden canónico del
    // wizard (telegram antes que otp) — el orden guardado no importa.
    const verifiers = MEMBER_VERIFIERS.filter((v) => list.includes(v));
    return { enabled: value['enabled'], verifiers };
  }
}
