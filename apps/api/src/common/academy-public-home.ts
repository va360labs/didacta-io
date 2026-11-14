/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Ajuste del aula «Página pública de la academia».
 *
 * Decide qué ve quien entra SIN sesión en la raíz del dominio del aula (`/`):
 *
 *  - activada: la portada pública (nombre, portada, descripción, quién la
 *    lleva y las opciones de acceso con lo que el aula tiene a la venta);
 *  - desactivada: lo de siempre, directo a la pantalla de acceso.
 *
 * Vive en `tenant_setting` (`academy/public-home`, `{ enabled }`), sin columna
 * nueva, junto al idioma del aula. Si nadie lo ha tocado, manda el MODO del
 * aula: activada en el modo sencillo (las aulas de Didacta Cloud, que venden
 * desde el primer día) y desactivada en el completo, para no cambiarles la
 * entrada a las aulas que ya existían. Como el valor por defecto se calcula y
 * no se guarda, no hace falta tocar ninguna fila al desplegar.
 */

export const ACADEMY_PUBLIC_HOME_SETTING = { moduleName: 'academy', key: 'public-home' } as const;

/** `setting` si alguien lo eligió; `default` si sale del modo del aula. */
export type PublicHomeSource = 'setting' | 'default';

export interface PublicHomeState {
  enabled: boolean;
  source: PublicHomeSource;
}

/** Lo mínimo de Prisma para leer el ajuste (bajo el RLS del aula). */
export interface PublicHomeReader {
  tenantSetting: {
    findUnique(args: {
      where: { tenantId_moduleName_key: { tenantId: string; moduleName: string; key: string } };
      select: { valueJson: true };
    }): Promise<{ valueJson: unknown } | null>;
  };
  tenant: {
    findUnique(args: {
      where: { id: string };
      select: { simpleMode: true };
    }): Promise<{ simpleMode: boolean } | null>;
  };
}

/** Lo mínimo de Prisma para guardar el ajuste (bajo el RLS del aula). */
export interface PublicHomeWriter {
  tenantSetting: {
    upsert(args: {
      where: { tenantId_moduleName_key: { tenantId: string; moduleName: string; key: string } };
      create: {
        tenantId: string;
        moduleName: string;
        key: string;
        valueJson: { enabled: boolean };
        isSecret: boolean;
        updatedById: string | null;
      };
      update: { valueJson: { enabled: boolean }; updatedById: string | null };
    }): Promise<unknown>;
  };
}

/**
 * El valor guardado, o `null` si no hay uno válido. Acepta `{ enabled }` (lo
 * que se escribe) y un booleano suelto (por si alguien lo pone a mano).
 */
export function parsePublicHomeSetting(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const enabled = (raw as Record<string, unknown>).enabled;
    if (typeof enabled === 'boolean') return enabled;
  }
  return null;
}

/** El valor por defecto: activada solo en el modo sencillo. */
export function defaultPublicHome(simpleMode: boolean | null | undefined): boolean {
  return simpleMode === true;
}

/**
 * Estado del ajuste del aula. De mejor esfuerzo: ante un fallo de lectura se
 * queda en «desactivada», que es la entrada de siempre (fallar hacia lo que
 * había, nunca hacia una página nueva).
 */
export async function resolvePublicHome(
  prisma: PublicHomeReader,
  tenantId: string,
): Promise<PublicHomeState> {
  try {
    const { moduleName, key } = ACADEMY_PUBLIC_HOME_SETTING;
    const row = await prisma.tenantSetting.findUnique({
      where: { tenantId_moduleName_key: { tenantId, moduleName, key } },
      select: { valueJson: true },
    });
    const explicit = parsePublicHomeSetting(row?.valueJson);
    if (explicit !== null) return { enabled: explicit, source: 'setting' };
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { simpleMode: true },
    });
    return { enabled: defaultPublicHome(tenant?.simpleMode), source: 'default' };
  } catch {
    return { enabled: false, source: 'default' };
  }
}

/** Fija el ajuste del aula (el valor explícito, que ya no sigue al modo). */
export async function writePublicHome(
  prisma: PublicHomeWriter,
  tenantId: string,
  enabled: boolean,
  actorId: string | null = null,
): Promise<void> {
  const { moduleName, key } = ACADEMY_PUBLIC_HOME_SETTING;
  await prisma.tenantSetting.upsert({
    where: { tenantId_moduleName_key: { tenantId, moduleName, key } },
    create: {
      tenantId,
      moduleName,
      key,
      valueJson: { enabled },
      isSecret: false,
      updatedById: actorId,
    },
    update: { valueJson: { enabled }, updatedById: actorId },
  });
}
