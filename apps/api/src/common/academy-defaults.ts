/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Idioma y zona horaria «del aula».
 *
 * El aula no tiene una columna propia para ninguno de los dos, y los textos que
 * el servidor escribe para TODOS (el anuncio de un directo en la comunidad, el
 * nombre por defecto de la clave del agente) o los datos con los que nace un
 * alumno al que todavía no se le ha preguntado nada (su zona horaria) necesitan
 * uno. Se deducen de lo que el aula ya sabe, sin estado nuevo:
 *
 * - Idioma: el que eligió la creadora al montar el aula (alta en 3 preguntas del
 *   modo sencillo, `tenant_setting simple-mode/state.locale`); si no lo hay, el
 *   del perfil de la primera persona que la administra; si tampoco, español
 *   (`HUB_DEFAULT_LOCALE`, el idioma por defecto de todo lo demás). La misma
 *   regla está en SQL en `packages/database/prisma/seed.sql` (espacios de
 *   sistema): si cambia aquí, cambia allí; lo vigila
 *   `seed-system-spaces.integration.test.ts`.
 * - Zona horaria: la del perfil de la primera persona que la administra si no
 *   es UTC (UTC es el valor por defecto de la columna, no una elección); si no,
 *   la del último directo programado (esa sí la elige el formulario); si
 *   tampoco, `null` (quien llama decide: normalmente UTC).
 *
 * Las dos son de mejor esfuerzo: ante cualquier fallo de lectura devuelven el
 * valor por defecto. Una alta o un anuncio nunca se caen por no saber el idioma.
 * El portugués no tiene catálogo en el aula: solo hay `es` y `en`.
 */

export type AcademyLocale = 'es' | 'en';

/** Lo mínimo de Prisma que hace falta (las llamadas corren bajo el RLS del aula). */
export interface AcademyDefaultsPrisma {
  tenantSetting: {
    findUnique(args: {
      where: { tenantId_moduleName_key: { tenantId: string; moduleName: string; key: string } };
      select: { valueJson: true };
    }): Promise<{ valueJson: unknown } | null>;
  };
  user: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: { createdAt: 'asc' };
      take: number;
      select: { locale: true; timezone: true };
    }): Promise<Array<{ locale: string; timezone: string }>>;
  };
  modZoomSession?: {
    findFirst(args: {
      where: { tenantId: string };
      orderBy: { createdAt: 'desc' };
      select: { timezone: true };
    }): Promise<{ timezone: string } | null>;
  };
}

/** Normaliza un tag de idioma cualquiera a uno de los catálogos del aula. */
export function toAcademyLocale(raw: unknown): AcademyLocale | null {
  if (typeof raw !== 'string') return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  if (base === 'en') return 'en';
  if (base === 'es') return 'es';
  return null;
}

/** Tag completo para formatear fechas en el idioma del aula. */
export function academyDateLocale(locale: AcademyLocale): string {
  return locale === 'en' ? 'en-US' : 'es-ES';
}

/** ¿Es una zona IANA que `Intl` reconoce? (UTC incluida). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim().length < 2 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const ADMIN_ROLE = 'tenant_admin';

async function admins(
  prisma: AcademyDefaultsPrisma,
  tenantId: string,
): Promise<Array<{ locale: string; timezone: string }>> {
  return prisma.user.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: 'ACTIVE',
      roles: { some: { role: { name: ADMIN_ROLE } } },
    },
    orderBy: { createdAt: 'asc' },
    take: 5,
    select: { locale: true, timezone: true },
  });
}

export async function academyLocale(
  prisma: AcademyDefaultsPrisma,
  tenantId: string,
): Promise<AcademyLocale> {
  try {
    const row = await prisma.tenantSetting.findUnique({
      where: { tenantId_moduleName_key: { tenantId, moduleName: 'simple-mode', key: 'state' } },
      select: { valueJson: true },
    });
    const state = row?.valueJson;
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      const chosen = toAcademyLocale((state as Record<string, unknown>).locale);
      if (chosen) return chosen;
    }
  } catch {
    // Sin ajuste legible: se sigue con el perfil de quien administra.
  }
  try {
    for (const a of await admins(prisma, tenantId)) {
      const l = toAcademyLocale(a.locale);
      if (l) return l;
    }
  } catch {
    // Camino degradado: el idioma por defecto.
  }
  return 'es';
}

export async function academyTimeZone(
  prisma: AcademyDefaultsPrisma,
  tenantId: string,
): Promise<string | null> {
  try {
    for (const a of await admins(prisma, tenantId)) {
      if (a.timezone !== 'UTC' && isValidTimeZone(a.timezone)) return a.timezone;
    }
  } catch {
    // Se prueba con los directos.
  }
  try {
    const live = await prisma.modZoomSession?.findFirst({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: { timezone: true },
    });
    if (live && isValidTimeZone(live.timezone)) return live.timezone;
  } catch {
    // Sin directos legibles: no hay zona del aula.
  }
  return null;
}

/**
 * Zona con la que nace un usuario nuevo: la de su navegador si la manda y es
 * válida; si no, la del aula; si tampoco, UTC (el default de la columna).
 */
export async function newUserTimeZone(
  prisma: AcademyDefaultsPrisma,
  tenantId: string,
  browserTimeZone?: string | null,
): Promise<string> {
  if (isValidTimeZone(browserTimeZone)) return browserTimeZone;
  return (await academyTimeZone(prisma, tenantId)) ?? 'UTC';
}
