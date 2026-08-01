'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch } from './api-client';

/**
 * Cliente del API de impagos (payment-flags) de la inscripción de miembros.
 *
 * Mismo patrón que `admin-users.ts`: las funciones reciben el `bearer` (access
 * token de la sesión, obtenido con `authStorage.getAccessToken()`) y lo pasan a
 * `apiFetch` como tercer argumento. Los endpoints viven bajo
 * `/api/v1/modules/member-registration/payment-flags` y requieren rol admin (el backend ya
 * gatea con su guard; el gating del front es sólo UX).
 */

export interface PaymentFlag {
  id: string;
  /** Clave principal desde F2.3 (null solo en filas legacy por telegramId). */
  email: string | null;
  /** User del tenant vinculado, si el email correspondía a uno. */
  userId: string | null;
  /** Clave LEGACY de la era del gate Telegram. */
  telegramId: string | null;
  name: string | null;
  isDelinquent: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListPaymentFlagsQuery {
  /** Texto libre: busca por email, telegram_id o nombre. */
  q?: string;
  /** Si true, sólo devuelve los marcados como impagos. */
  delinquentOnly?: boolean;
}

/** Payload de alta/edición manual de un flag. Al menos email o telegramId. */
export interface UpsertPaymentFlagDto {
  email?: string;
  telegramId?: string;
  name?: string | null;
  isDelinquent?: boolean;
  note?: string | null;
}

/** Fila del import CSV: email y/o telegram_id, nombre opcional. */
export interface ImportPaymentFlagRow {
  email?: string;
  telegramId?: string;
  name?: string | null;
  isDelinquent?: boolean;
  note?: string | null;
}

function withQuery(path: string, query: ListPaymentFlagsQuery): string {
  const usp = new URLSearchParams();
  if (query.q) usp.set('q', query.q);
  if (query.delinquentOnly) usp.set('delinquentOnly', 'true');
  const qs = usp.toString();
  return qs ? `${path}?${qs}` : path;
}

const BASE = '/api/v1/modules/member-registration/payment-flags';

export const paymentFlagsApi = {
  async list(bearer: string, query: ListPaymentFlagsQuery = {}): Promise<PaymentFlag[]> {
    return apiFetch<PaymentFlag[]>(withQuery(BASE, query), { method: 'GET' }, bearer);
  },
  async upsert(bearer: string, dto: UpsertPaymentFlagDto): Promise<{ id: string }> {
    return apiFetch<{ id: string }>(BASE, { method: 'POST', body: JSON.stringify(dto) }, bearer);
  },
  async remove(bearer: string, id: string): Promise<void> {
    await apiFetch<void>(`${BASE}/${id}`, { method: 'DELETE' }, bearer);
  },
  async import(bearer: string, rows: ImportPaymentFlagRow[]): Promise<{ imported: number }> {
    return apiFetch<{ imported: number }>(
      `${BASE}/import`,
      { method: 'POST', body: JSON.stringify({ rows }) },
      bearer,
    );
  },
};

/** ¿Parece un email? Validación laxa (el backend valida en serio con Zod). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parsea el contenido de un CSV (separador `;` o `,`) a filas de import.
 * Acepta tanto listas por EMAIL (export de facturación) como exportaciones de
 * Telegram por user_id. Devuelve `{ email?, telegramId?, name }` con
 * `isDelinquent=true` para cada fila válida.
 *
 * Reglas de parseo:
 *  - Detecta el separador mirando la cabecera (cuenta `;` vs `,`).
 *  - Mapea columnas por nombre de cabecera: `email` → email; `user_id`/
 *    `telegram_id`/`id` → telegramId; `display_name`/`first_name`/`name` →
 *    name. Sin cabecera reconocible, la primera columna es la clave (email o
 *    telegramId numérico, se autodetecta) y la segunda el nombre.
 *  - Ignora filas sin email válido ni telegramId numérico.
 */
export function parsePaymentFlagsCsv(text: string): ImportPaymentFlagRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const headerLine = lines[0]!;
  // Telegram exporta con ';'; otros editores usan ','. Elegimos el que más
  // aparece en la cabecera.
  const sep =
    (headerLine.match(/;/g)?.length ?? 0) >= (headerLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const splitRow = (line: string): string[] =>
    line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));

  const header = splitRow(headerLine).map((h) => h.toLowerCase());
  const emailIdx = header.findIndex((h) => h === 'email' || h === 'e-mail' || h === 'correo');
  const idIdx = header.findIndex((h) => h === 'user_id' || h === 'id' || h === 'telegram_id');
  const nameIdx = header.findIndex(
    (h) => h === 'display_name' || h === 'first_name' || h === 'name' || h === 'nombre',
  );
  const hasHeader = emailIdx !== -1 || idIdx !== -1;

  const dataLines = hasHeader ? lines.slice(1) : lines;
  const rows: ImportPaymentFlagRow[] = [];
  for (const line of dataLines) {
    const cols = splitRow(line);
    let email = (hasHeader && emailIdx !== -1 ? cols[emailIdx] : '')?.trim() ?? '';
    let telegramId = (hasHeader ? (idIdx !== -1 ? cols[idIdx] : '') : cols[0])?.trim() ?? '';
    // Sin cabecera: autodetecta si la primera columna es email o telegramId.
    if (!hasHeader && EMAIL_RE.test(telegramId)) {
      email = telegramId;
      telegramId = '';
    }
    if (!EMAIL_RE.test(email)) email = '';
    if (!/^\d+$/.test(telegramId)) telegramId = '';
    if (!email && !telegramId) continue;
    const rawName = hasHeader && nameIdx !== -1 ? cols[nameIdx] : cols[1];
    const name = rawName?.trim() || undefined;
    rows.push({
      ...(email ? { email } : {}),
      ...(telegramId ? { telegramId } : {}),
      name,
      isDelinquent: true,
    });
  }
  return rows;
}
