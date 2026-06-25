'use client';

import { apiFetch } from './api-client';

/**
 * Cliente del API de impagos (payment-flags) de la inscripción de miembros.
 *
 * Mismo patrón que `admin-users.ts`: las funciones reciben el `bearer` (access
 * token de la sesión, obtenido con `authStorage.getAccessToken()`) y lo pasan a
 * `apiFetch` como tercer argumento. Los endpoints viven bajo
 * `/api/v1/inscripcion/payment-flags` y requieren rol admin (el backend ya
 * gatea con su guard; el gating del front es sólo UX).
 */

export interface PaymentFlag {
  id: string;
  telegramId: string;
  name: string | null;
  isDelinquent: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListPaymentFlagsQuery {
  /** Texto libre: busca por telegram_id o nombre. */
  q?: string;
  /** Si true, sólo devuelve los marcados como impagos. */
  delinquentOnly?: boolean;
}

/** Payload de alta/edición manual de un flag. */
export interface UpsertPaymentFlagDto {
  telegramId: string;
  name?: string | null;
  isDelinquent?: boolean;
  note?: string | null;
}

/** Fila del import CSV: telegram_id obligatorio, nombre opcional. */
export interface ImportPaymentFlagRow {
  telegramId: string;
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

const BASE = '/api/v1/inscripcion/payment-flags';

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

/**
 * Parsea el contenido de un CSV exportado de Telegram (separador `;` o `,`) a
 * filas de import. Devuelve `{ telegramId, name }` con `isDelinquent=true` para
 * cada fila válida.
 *
 * Reglas de parseo:
 *  - Detecta el separador mirando la cabecera (cuenta `;` vs `,`).
 *  - Mapea columnas por nombre de cabecera: `user_id` → telegramId;
 *    `display_name`/`first_name` → name. Si no hay cabecera reconocible, asume
 *    que la primera columna es el telegramId y la segunda el nombre.
 *  - Ignora filas sin telegramId numérico.
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
  const idIdx = header.findIndex((h) => h === 'user_id' || h === 'id' || h === 'telegram_id');
  const nameIdx = header.findIndex(
    (h) => h === 'display_name' || h === 'first_name' || h === 'name',
  );
  const hasHeader = idIdx !== -1;

  const dataLines = hasHeader ? lines.slice(1) : lines;
  const rows: ImportPaymentFlagRow[] = [];
  for (const line of dataLines) {
    const cols = splitRow(line);
    const telegramId = (hasHeader ? cols[idIdx] : cols[0])?.trim() ?? '';
    if (!/^\d+$/.test(telegramId)) continue;
    const rawName = hasHeader && nameIdx !== -1 ? cols[nameIdx] : cols[1];
    const name = rawName?.trim() || undefined;
    rows.push({ telegramId, name, isDelinquent: true });
  }
  return rows;
}
