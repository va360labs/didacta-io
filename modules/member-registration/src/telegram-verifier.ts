/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { TelegramAuthDto, TelegramMembership } from './dto.js';
import type { TelegramGateConfig } from './settings.js';

// ─── Configuración ───────────────────────────────────────────────────────────
// El bot es config de TENANT (tenant_setting, con fallback a env legacy) y se
// resuelve en MemberRegistrationSettings. Este verificador recibe la config
// por llamada y NUNCA la loguea ni la incrusta en URLs que terminen en el log.

/** Drift máximo permitido del `auth_date` (segundos) — mitigación replay. */
const AUTH_DATE_MAX_DRIFT_SECONDS = 86400;
/** Timeout de la llamada a la API de Telegram. */
const TELEGRAM_API_TIMEOUT_MS = 5000;

/** Estados de `getChatMember` que cuentan como pertenencia al grupo. */
const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);
/** Estados de `getChatMember` que cuentan como NO pertenencia. */
const NON_MEMBER_STATUSES = new Set(['left', 'kicked']);

/** Forma mínima de la respuesta de la API de Telegram que consumimos. */
interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  result?: { status?: string };
}

/**
 * Puerto de logging del verificador (estructuralmente compatible con
 * nestjs-pino en el host). Solo se usa `warn` en los caminos de error.
 */
export interface TelegramVerifierLogger {
  warn(obj: unknown, msg?: string): void;
}

/**
 * Verificación de pertenencia al grupo de Telegram (verificador `telegram` del
 * flujo de inscripción).
 *
 * Dos responsabilidades:
 *  - `verifyLoginHash`: valida de forma timing-safe la firma del Telegram Login
 *    Widget (HMAC-SHA256 con secret = sha256(botToken)) y rechaza payloads
 *    viejos (anti-replay vía `auth_date`).
 *  - `getChatMember`: consulta la API de Telegram si un usuario pertenece al
 *    grupo del tenant, devolviendo el tri-estado `'true' | 'false' | 'unknown'`.
 *
 * Framework-agnóstico: el host lo expone en DI subclasándolo con @Injectable.
 */
export class TelegramVerifier {
  constructor(private readonly logger: TelegramVerifierLogger) {}

  /**
   * Verifica la firma del Telegram Login Widget de forma timing-safe.
   *
   * Algoritmo (https://core.telegram.org/widgets/login#checking-authorization):
   *  - secret = sha256(botToken) como Buffer crudo de 32 bytes.
   *  - data-check-string = todos los campos excepto `hash`, con valores a
   *    string, claves ordenadas alfabéticamente, unidas por salto de línea.
   *  - expected = HMAC-SHA256(secret, dcs) en hex, comparado timing-safe con
   *    el `hash` recibido.
   *  - Además rechaza si `auth_date` difiere más de 86400s del tiempo actual.
   *
   * Devuelve `true` si la firma es válida y reciente; `false` en cualquier otro
   * caso (sin tirar, para que el caller decida la respuesta HTTP).
   */
  verifyLoginHash(config: TelegramGateConfig, fields: TelegramAuthDto): boolean {
    if (!config.botToken) return false;
    if (!fields.hash) return false;

    // Anti-replay: el payload no puede ser más viejo (ni futuro) que el drift.
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(fields.auth_date)) return false;
    if (Math.abs(nowSeconds - fields.auth_date) > AUTH_DATE_MAX_DRIFT_SECONDS) {
      return false;
    }

    // data-check-string: campos != 'hash', valores a string, orden alfabético.
    const dcs = Object.entries(fields)
      .filter(([key, value]) => key !== 'hash' && value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)] as const)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    // secret = sha256(botToken) crudo (32 bytes), NO la representación hex.
    const secret = createHash('sha256').update(config.botToken).digest();
    const expected = createHmac('sha256', secret).update(dcs).digest('hex');

    // Comparación timing-safe: requiere mismo length para no tirar.
    if (fields.hash.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(fields.hash, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  /**
   * Consulta si un usuario de Telegram pertenece al grupo del tenant.
   *
   * Mapeo de la respuesta de `getChatMember`:
   *  - `ok` y status ∈ {creator, administrator, member} → `'true'`.
   *  - status ∈ {left, kicked}, o respuesta "user not found" → `'false'`.
   *  - cualquier error, timeout, respuesta no-ok o status desconocido →
   *    `'unknown'` (el caller decide si reintenta o degrada el flujo).
   *
   * NUNCA loguea la URL ni el token: solo el status HTTP / mensaje de error.
   */
  async getChatMember(
    config: TelegramGateConfig,
    telegramUserId: string,
  ): Promise<TelegramMembership> {
    if (!config.botToken || !config.groupId) return 'unknown';

    const url =
      `https://api.telegram.org/bot${config.botToken}/getChatMember` +
      `?chat_id=${encodeURIComponent(config.groupId)}&user_id=${encodeURIComponent(telegramUserId)}`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS) });
      if (!res.ok) {
        this.logger.warn(
          { status: res.status },
          'Telegram getChatMember devolvió un status HTTP no-ok',
        );
        return 'unknown';
      }

      const body = (await res.json()) as TelegramApiResponse;

      if (!body.ok) {
        // "user not found" / "PARTICIPANT_ID_INVALID" ⇒ el usuario no está.
        const description = (body.description ?? '').toLowerCase();
        if (
          description.includes('user not found') ||
          description.includes('participant_id_invalid')
        ) {
          return 'false';
        }
        this.logger.warn({ status: res.status }, 'Telegram getChatMember respondió ok=false');
        return 'unknown';
      }

      const status = body.result?.status;
      if (status && MEMBER_STATUSES.has(status)) return 'true';
      if (status && NON_MEMBER_STATUSES.has(status)) return 'false';
      return 'unknown';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({ error: message }, 'Telegram getChatMember falló (red/timeout)');
      return 'unknown';
    }
  }
}
