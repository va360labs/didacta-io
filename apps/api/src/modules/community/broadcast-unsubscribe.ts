/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadAuthConfig } from '../../auth/auth.config';

/**
 * Token de baja de los correos de la comunidad (avisos masivos y resumen
 * semanal). Formato `base64url(payload).base64url(hmac)` con payload
 * `{ t: tenantId, u: userId }` firmado HMAC-SHA256. Sin expiración (un enlace
 * de baja no debe caducar). Lo firman los workers de avisos y del resumen (al
 * meter el enlace en cada email) y lo verifica el endpoint público de
 * unsubscribe.
 *
 * Se firma SOLO con `AUTH_SECRET`, leído con la misma validación que el
 * arranque de auth (`loadAuthConfig`): sin él, o con menos de 32 caracteres,
 * LANZA en vez de caer a otra clave. Antes había respaldo a
 * `TENANT_SETTINGS_ENC_KEY` y, en último término, a una cadena fija escrita en
 * el código de un repositorio público: con ella cualquiera podía fabricar el
 * enlace de baja de cualquier usuario de cualquier instalación que arrancase
 * este código sin el secreto puesto.
 *
 * Los enlaces ya enviados siguen valiendo: la API no arranca sin `AUTH_SECRET`
 * (lo exige `TokenService`), así que en una instalación en marcha siempre se
 * han firmado con él.
 */
function secret(): string {
  return loadAuthConfig().jwtSecret;
}

export function signUnsubscribeToken(tenantId: string, userId: string): string {
  const data = Buffer.from(JSON.stringify({ t: tenantId, u: userId }), 'utf8').toString(
    'base64url',
  );
  const sig = createHmac('sha256', secret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/**
 * Enlace de baja de los correos de la comunidad, para el pie del correo y la
 * cabecera `List-Unsubscribe`. Es UNO para avisos y resumen semanal: darse de
 * baja de uno es darse de baja de los dos.
 *
 * `webBase` es la dirección pública del aula DEL TENANT. Sin ella devuelve ''
 * y la plantilla omite el bloque: un enlace relativo en un correo no lleva a
 * ningún sitio.
 */
export function communityUnsubscribeUrl(webBase: string, tenantId: string, userId: string): string {
  const base = webBase.trim().replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/api/v1/modules/community/unsubscribe?token=${signUnsubscribeToken(tenantId, userId)}`;
}

export function verifyUnsubscribeToken(token: string): { tenantId: string; userId: string } | null {
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = createHmac('sha256', secret()).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as {
      t?: string;
      u?: string;
    };
    if (!payload.t || !payload.u) return null;
    return { tenantId: payload.t, userId: payload.u };
  } catch {
    return null;
  }
}
