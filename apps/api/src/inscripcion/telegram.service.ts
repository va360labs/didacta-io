/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { TelegramAuthDto, TelegramMembership } from './inscripcion.dto';

// ─── Configuración (vía env, nunca hardcodeada — regla #3) ──────────────────
// El bot token y el group id viven SOLO en variables de entorno. NUNCA se
// loguean ni se incrustan en URLs que terminen en el log.
const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']?.trim();
const GROUP_ID = process.env['TELEGRAM_GROUP_ID']?.trim();
const BOT_USERNAME = process.env['TELEGRAM_BOT_USERNAME']?.trim();

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
 * Verificación de pertenencia al grupo de Telegram (gate de inscripción).
 *
 * Dos responsabilidades:
 *  - `verifyLoginHash`: valida de forma timing-safe la firma del Telegram Login
 *    Widget (HMAC-SHA256 con secret = sha256(BOT_TOKEN)) y rechaza payloads
 *    viejos (anti-replay vía `auth_date`).
 *  - `getChatMember`: consulta la API de Telegram si un usuario pertenece al
 *    grupo configurado, devolviendo el tri-estado `'true' | 'false' | 'unknown'`.
 *
 * Es CORE del host (no un módulo). Ver PRD "Inscripción de miembros".
 */
@Injectable()
export class TelegramService {
  constructor(private readonly logger: PinoLogger) {}

  /** `true` solo si hay token y group id configurados (la feature está activa). */
  isConfigured(): boolean {
    return Boolean(BOT_TOKEN) && Boolean(GROUP_ID);
  }

  /** Username del bot (sin `@`) para el Telegram Login Widget del frontend. */
  get botUsername(): string | null {
    return BOT_USERNAME ?? null;
  }

  /**
   * Verifica la firma del Telegram Login Widget de forma timing-safe.
   *
   * Algoritmo (https://core.telegram.org/widgets/login#checking-authorization):
   *  - secret = sha256(BOT_TOKEN) como Buffer crudo de 32 bytes.
   *  - data-check-string = todos los campos excepto `hash`, con valores a
   *    string, claves ordenadas alfabéticamente, unidas por salto de línea.
   *  - expected = HMAC-SHA256(secret, dcs) en hex, comparado timing-safe con
   *    el `hash` recibido.
   *  - Además rechaza si `auth_date` difiere más de 86400s del tiempo actual.
   *
   * Devuelve `true` si la firma es válida y reciente; `false` en cualquier otro
   * caso (sin tirar, para que el caller decida la respuesta HTTP).
   */
  verifyLoginHash(fields: TelegramAuthDto): boolean {
    if (!BOT_TOKEN) return false;
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

    // secret = sha256(BOT_TOKEN) crudo (32 bytes), NO la representación hex.
    const secret = createHash('sha256').update(BOT_TOKEN).digest();
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
   * Consulta si un usuario de Telegram pertenece al grupo configurado.
   *
   * Mapeo de la respuesta de `getChatMember`:
   *  - `ok` y status ∈ {creator, administrator, member} → `'true'`.
   *  - status ∈ {left, kicked}, o respuesta "user not found" → `'false'`.
   *  - cualquier error, timeout, respuesta no-ok o status desconocido →
   *    `'unknown'` (el caller decide si reintenta o degrada el flujo).
   *
   * NUNCA loguea la URL ni el token: solo el status HTTP / mensaje de error.
   */
  async getChatMember(telegramUserId: string): Promise<TelegramMembership> {
    if (!BOT_TOKEN || !GROUP_ID) return 'unknown';

    const url =
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember` +
      `?chat_id=${encodeURIComponent(GROUP_ID)}&user_id=${encodeURIComponent(telegramUserId)}`;

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
