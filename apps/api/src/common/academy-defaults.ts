/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Idioma y zona horaria «del aula».
 *
 * Los textos que el servidor escribe para TODOS (el anuncio de un directo en la
 * comunidad, los espacios sembrados, el nombre por defecto de la clave del
 * agente), los correos a quien no tiene idioma propio y lo que ve quien entra
 * sin cookie ni perfil necesitan un idioma; los datos con los que nace un
 * alumno al que todavía no se le ha preguntado nada, una zona horaria.
 *
 * - Idioma: el AJUSTE del aula (`tenant_setting academy/locale`), que se elige
 *   en el alta de 3 preguntas, en Ajustes o al aprovisionar el aula desde
 *   Didacta Cloud. Para las aulas sin ajuste queda la deducción de antes, solo
 *   como respaldo: el idioma que eligió la creadora al montar el aula (alta en
 *   3 preguntas del modo sencillo, `tenant_setting simple-mode/state.locale`);
 *   si no lo hay, el del perfil de la primera persona que la administra; si
 *   tampoco, español (`HUB_DEFAULT_LOCALE`, el idioma por defecto de todo lo
 *   demás). La misma regla está en SQL en `packages/database/prisma/seed.sql`
 *   (espacios de sistema): si cambia aquí, cambia allí; lo vigila
 *   `seed-system-spaces.integration.test.ts`.
 * - Zona horaria: la del perfil de la primera persona que la administra si no
 *   es UTC (UTC es el valor por defecto de la columna, no una elección); si no,
 *   la del último directo programado (esa sí la elige el formulario); si
 *   tampoco, `null` (quien llama decide: normalmente UTC).
 *
 * Las lecturas son de mejor esfuerzo: ante cualquier fallo devuelven el valor
 * por defecto. Una alta o un anuncio nunca se caen por no saber el idioma.
 */

/**
 * Idiomas que puede tener un aula: los que tienen catálogo en la web
 * (`messages/<código>`) y en los correos (plantillas del hub). Se guarda el
 * código del catálogo, no el tag completo: un aula en portugués de Brasil
 * guarda `pt` (`toAcademyLocale('pt-BR')` → `'pt'`) y formatea sus fechas con
 * `pt-BR` (`academyDateLocale`). El ajuste, el endpoint, el aprovisionamiento y
 * el script de migración leen esta lista.
 */
export const ACADEMY_LOCALES = ['es', 'en', 'pt'] as const;

export type AcademyLocale = (typeof ACADEMY_LOCALES)[number];

/** Dónde se guarda el idioma del aula: un ajuste del aula, sin columna nueva. */
export const ACADEMY_LOCALE_SETTING = { moduleName: 'academy', key: 'locale' } as const;

/**
 * De dónde salió el idioma: `setting` es el ajuste explícito; los otros tres son
 * la deducción de respaldo para aulas sin ajuste.
 */
export type AcademyLocaleSource = 'setting' | 'simple-mode' | 'admin' | 'default';

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
  return (ACADEMY_LOCALES as readonly string[]).includes(base ?? '')
    ? (base as AcademyLocale)
    : null;
}

/**
 * Tag completo para formatear fechas en el idioma del aula. Es también el tag
 * de perfil con el que nace un usuario del aula (`newUserLocale`), así que tiene
 * que ser uno de `PROFILE_LOCALES`.
 */
const ACADEMY_DATE_LOCALE: Record<AcademyLocale, string> = {
  es: 'es-ES',
  en: 'en-US',
  pt: 'pt-BR',
};

export function academyDateLocale(locale: AcademyLocale): string {
  return ACADEMY_DATE_LOCALE[locale] ?? 'es-ES';
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

async function readSetting(
  prisma: AcademyDefaultsPrisma,
  tenantId: string,
  moduleName: string,
  key: string,
): Promise<unknown> {
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_moduleName_key: { tenantId, moduleName, key } },
    select: { valueJson: true },
  });
  return row?.valueJson;
}

/** El ajuste explícito del aula, o `null` si no lo tiene (o no se puede leer). */
export async function explicitAcademyLocale(
  prisma: AcademyDefaultsPrisma,
  tenantId: string,
): Promise<AcademyLocale | null> {
  try {
    return toAcademyLocale(
      await readSetting(
        prisma,
        tenantId,
        ACADEMY_LOCALE_SETTING.moduleName,
        ACADEMY_LOCALE_SETTING.key,
      ),
    );
  } catch {
    return null;
  }
}

/**
 * La deducción de antes (sin mirar el ajuste): el idioma del alta en 3
 * preguntas, el del perfil de quien administra, o español. Es el respaldo de
 * las aulas sin ajuste y lo que propone el script que se lo fija a las que ya
 * existían.
 */
export async function deducedAcademyLocale(
  prisma: AcademyDefaultsPrisma,
  tenantId: string,
): Promise<{ locale: AcademyLocale; source: Exclude<AcademyLocaleSource, 'setting'> }> {
  try {
    const state = await readSetting(prisma, tenantId, 'simple-mode', 'state');
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      const chosen = toAcademyLocale((state as Record<string, unknown>).locale);
      if (chosen) return { locale: chosen, source: 'simple-mode' };
    }
  } catch {
    // Sin ajuste legible: se sigue con el perfil de quien administra.
  }
  try {
    for (const a of await admins(prisma, tenantId)) {
      const l = toAcademyLocale(a.locale);
      if (l) return { locale: l, source: 'admin' };
    }
  } catch {
    // Camino degradado: el idioma por defecto.
  }
  return { locale: 'es', source: 'default' };
}

/** Idioma del aula y de dónde sale: el ajuste y, si no lo hay, la deducción. */
export async function resolveAcademyLocale(
  prisma: AcademyDefaultsPrisma,
  tenantId: string,
): Promise<{ locale: AcademyLocale; source: AcademyLocaleSource }> {
  const explicit = await explicitAcademyLocale(prisma, tenantId);
  if (explicit) return { locale: explicit, source: 'setting' };
  return deducedAcademyLocale(prisma, tenantId);
}

export async function academyLocale(
  prisma: AcademyDefaultsPrisma,
  tenantId: string,
): Promise<AcademyLocale> {
  return (await resolveAcademyLocale(prisma, tenantId)).locale;
}

/** Lo mínimo de Prisma para guardar el ajuste (bajo el RLS del aula). */
export interface AcademyLocaleWriter {
  tenantSetting: {
    upsert(args: {
      where: { tenantId_moduleName_key: { tenantId: string; moduleName: string; key: string } };
      create: {
        tenantId: string;
        moduleName: string;
        key: string;
        valueJson: string;
        isSecret: boolean;
        updatedById: string | null;
      };
      update: { valueJson: string; updatedById: string | null };
    }): Promise<unknown>;
  };
}

/** Fija el idioma del aula (el ajuste explícito). */
export async function writeAcademyLocale(
  prisma: AcademyLocaleWriter,
  tenantId: string,
  locale: AcademyLocale,
  actorId: string | null = null,
): Promise<void> {
  const { moduleName, key } = ACADEMY_LOCALE_SETTING;
  await prisma.tenantSetting.upsert({
    where: { tenantId_moduleName_key: { tenantId, moduleName, key } },
    create: {
      tenantId,
      moduleName,
      key,
      valueJson: locale,
      isSecret: false,
      updatedById: actorId,
    },
    update: { valueJson: locale, updatedById: actorId },
  });
}

/** Tags de perfil que la API persiste (`ALLOWED_LOCALES` de `me.controller.ts`). */
const PROFILE_LOCALES: readonly string[] = ['es-ES', 'es-AR', 'en-US', 'pt-BR'];

/**
 * Idioma con el que nace un usuario creado por el servidor: el del navegador si
 * lo manda y es uno de los del perfil; si no, el del aula. Así los correos que
 * recibe antes de entrar (bienvenida, compra, invitación) llegan en el idioma
 * del aula y no en el valor por defecto de la columna.
 */
export async function newUserLocale(
  prisma: AcademyDefaultsPrisma,
  tenantId: string,
  browserLocale?: string | null,
): Promise<string> {
  if (browserLocale && PROFILE_LOCALES.includes(browserLocale)) return browserLocale;
  return academyDateLocale(await academyLocale(prisma, tenantId));
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
