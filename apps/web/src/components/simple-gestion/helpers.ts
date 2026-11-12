/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { wallTimeToIso } from '@/modules/zoom-live/wall-time';

/**
 * Lógica pura del bloque «Gestión» del modo sencillo (directos, alumnos,
 * ajustes). Separada de los componentes para poder probarla sin navegador.
 */

/** ¿Es un enlace de videollamada aceptable? Solo `https://` con host. */
export function isHttpsUrl(raw: string): boolean {
  const v = raw.trim();
  if (!v.toLowerCase().startsWith('https://')) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname.includes('.');
  } catch {
    return false;
  }
}

/**
 * Fecha (`YYYY-MM-DD`) y hora (`HH:mm`) de pared en la zona del creador al
 * instante ISO que pide la API. `null` si falta algo.
 */
export function buildStartIso(date: string, time: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  return wallTimeToIso(`${date}T${time}`, timeZone);
}

/** Lo mínimo de una clase para decidir si aún está por delante. */
export interface LiveLike {
  status: string;
  startTime: string;
  durationMinutes: number;
}

/**
 * Próximas clases: programadas o en curso que no han terminado, de la más
 * cercana a la más lejana.
 */
export function upcoming<T extends LiveLike>(list: readonly T[], now: Date = new Date()): T[] {
  return list
    .filter((s) => s.status === 'SCHEDULED' || s.status === 'STARTED')
    .filter((s) => new Date(s.startTime).getTime() + s.durationMinutes * 60_000 >= now.getTime())
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

/** Enlace para compartir: el de venta si ya se publicó; `null` si aún no. */
export function shareUrl(origin: string, salePath: string | null | undefined): string | null {
  if (!salePath) return null;
  return `${origin.replace(/\/+$/, '')}${salePath}`;
}

/** Alumnos: fuera el equipo (quien administra o forma no es alumno). */
const STAFF = new Set(['super_admin', 'tenant_admin', 'formador']);
export function onlyStudents<T extends { roles: string[] }>(users: readonly T[]): T[] {
  return users.filter((u) => !u.roles.some((r) => STAFF.has(r)));
}

/** La vista completa de Ajustes se fuerza con `?completo=1` o con un `?tab=` (enlace a una sección avanzada). */
export function wantsFullSettings(params: { get(name: string): string | null } | null): boolean {
  if (!params) return false;
  return params.get('completo') === '1' || Boolean(params.get('tab')?.trim());
}
