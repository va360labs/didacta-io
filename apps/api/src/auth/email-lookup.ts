/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * El email del login NO distingue mayúsculas.
 *
 * La clave única es `(tenant_id, email)` tal cual se guardó, y el login buscaba
 * el texto exacto. Quien escribía «Ana.Ruiz@example.com» (el móvil pone la
 * primera en mayúscula, o el navegador lo autocompleta así) recibía
 * «Credenciales inválidas» aunque la contraseña fuese buena, y «¿olvidaste tu
 * contraseña?» le contestaba que sí sin enviarle nada.
 *
 * Devuelve el email TAL COMO ESTÁ GUARDADO en el tenant, para usarlo después en
 * la búsqueda por clave única. Primero el texto exacto (el camino de siempre);
 * si no, sin distinguir mayúsculas, y solo si hay UNA coincidencia.
 *
 * ── Cuentas que ya existen y solo difieren en mayúsculas ─────────────────────
 *
 * Pueden existir: la unicidad de la BD distingue mayúsculas y varias altas
 * guardan el email como llega. Con dos filas «ana@…» y «Ana@…» en el mismo
 * tenant:
 *   - quien escribe una de las dos EXACTA entra en la suya, como hasta ahora;
 *   - quien escribe una tercera forma («ANA@…») no entra en ninguna: se
 *     devuelve lo escrito y el login falla igual que fallaba antes.
 * No se elige una al azar ni se fusionan cuentas — son de quien las creó, y
 * adivinar cuál quería abrir sería entregar una sesión a ciegas.
 *
 * Tiene que llamarse con el contexto del tenant ya abierto (`runAsTenant`):
 * con la RLS forzada, fuera de él la consulta no ve ninguna fila.
 */
export interface EmailLookupPrisma {
  user: {
    findUnique(args: {
      where: { tenantId_email: { tenantId: string; email: string } };
      select: { id: true };
    }): Promise<{ id: string } | null>;
    findMany(args: {
      where: { tenantId: string; email: { equals: string; mode: 'insensitive' } };
      select: { email: true };
      take: number;
    }): Promise<Array<{ email: string }>>;
  };
}

export async function storedEmailFor(
  prisma: EmailLookupPrisma,
  tenantId: string,
  email: string,
): Promise<string> {
  const exact = await prisma.user.findUnique({
    where: { tenantId_email: { tenantId, email } },
    select: { id: true },
  });
  if (exact) return email;
  const matches = await prisma.user.findMany({
    where: { tenantId, email: { equals: email, mode: 'insensitive' } },
    select: { email: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0]!.email : email;
}
