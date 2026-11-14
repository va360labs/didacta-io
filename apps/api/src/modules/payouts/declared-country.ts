/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * País del banco que el creador DECLARÓ al darse de alta en Didacta Cloud
 * (`payoutsCountry` de `POST /admin/tenants`).
 *
 * Es lo que dijo, NO algo verificado: el país que cuenta para pagarle es el de
 * su cuenta conectada, que valida Stripe en el alta. Este dato solo sirve para
 * no preseleccionarle un país que no es el suyo en la tarjeta de cobros y para
 * decirle a tiempo, en «Empieza aquí», que todavía no se le puede pagar.
 *
 * Valores: un código ISO 3166-1 alfa-2 en mayúsculas (cualquiera, admitido o
 * no) o `OTHER` («su banco está fuera de la lista que se le ofreció, sin decir
 * cuál»). Se guarda como ajuste del aula (`tenant_setting payouts/declared_country`),
 * sin migración y bajo el RLS del aula. Sin el campo en el alta, no hay ajuste
 * y todo funciona como antes.
 *
 * Vive aquí y no dentro de `PayoutsModule` porque lo escribe el alta de
 * tenants (que existe siempre) y lo lee el estado de cobros (que solo existe
 * con el modo plataforma): son funciones sueltas, sin Nest.
 */

export const PAYOUTS_DECLARED_COUNTRY_SETTING = {
  moduleName: 'payouts',
  key: 'declared_country',
} as const;

/** «Mi banco está en otro país» (fuera de la lista que se le ofreció). */
export const DECLARED_COUNTRY_OTHER = 'OTHER';

/**
 * Valor declarado normalizado (`br` → `BR`, `other` → `OTHER`), o `null` si
 * no es ni un código de dos letras ni `OTHER` (`ESP`, `XX1`…). No se contrasta
 * con la lista oficial de ISO: dos letras valen (Cloud no manda `EU`; si
 * llegara, la web lo trataría como un país no admitido, que es lo prudente).
 */
export function normalizeDeclaredCountry(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toUpperCase();
  if (value === DECLARED_COUNTRY_OTHER) return value;
  return /^[A-Z]{2}$/.test(value) ? value : null;
}

/** Lo mínimo de Prisma para guardar el ajuste (dentro de la transacción del alta). */
export interface DeclaredCountryWriter {
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

/** Lo mínimo de Prisma para leer el ajuste (bajo el RLS del aula). */
export interface DeclaredCountryReader {
  tenantSetting: {
    findUnique(args: {
      where: { tenantId_moduleName_key: { tenantId: string; moduleName: string; key: string } };
      select: { valueJson: true };
    }): Promise<{ valueJson: unknown } | null>;
  };
}

export async function writeDeclaredCountry(
  prisma: DeclaredCountryWriter,
  tenantId: string,
  country: string,
  actorId: string | null = null,
): Promise<void> {
  const { moduleName, key } = PAYOUTS_DECLARED_COUNTRY_SETTING;
  await prisma.tenantSetting.upsert({
    where: { tenantId_moduleName_key: { tenantId, moduleName, key } },
    create: {
      tenantId,
      moduleName,
      key,
      valueJson: country,
      isSecret: false,
      updatedById: actorId,
    },
    update: { valueJson: country, updatedById: actorId },
  });
}

/**
 * El país declarado del aula, o `null` si no lo tiene, si el valor guardado no
 * es válido o si no se puede leer: sin él, la web hace lo de antes (región del
 * navegador). Un fallo aquí no puede tumbar el estado de cobros.
 */
export async function readDeclaredCountry(
  prisma: DeclaredCountryReader,
  tenantId: string,
): Promise<string | null> {
  const { moduleName, key } = PAYOUTS_DECLARED_COUNTRY_SETTING;
  try {
    const row = await prisma.tenantSetting.findUnique({
      where: { tenantId_moduleName_key: { tenantId, moduleName, key } },
      select: { valueJson: true },
    });
    return normalizeDeclaredCountry(row?.valueJson);
  } catch {
    return null;
  }
}
