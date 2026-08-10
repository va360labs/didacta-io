/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente HTTP del controlador admin de SMTP per-tenant (alpha.75: backend en
 * `apps/api/src/admin/admin-smtp.controller.ts`).
 *
 * Wrappea los 3 endpoints dedicados:
 *
 *  - `GET /api/v1/admin/tenant-settings/smtp` → DTO plano sin password.
 *  - `PUT /api/v1/admin/tenant-settings/smtp` → upsert. `password` opcional:
 *    si viene vacío se conserva el guardado. Reset de `verifiedAt`.
 *  - `POST /api/v1/admin/tenant-settings/smtp/test` → envía email de prueba.
 *    Si éxito → 200 + marca `verifiedAt`. Si falla → 400 con mensaje del MTA.
 *
 * Se separa de `tenant-settings.ts` porque ese cliente trabaja contra el
 * almacenamiento genérico `tenant_setting{moduleName,key,value,isSecret}`,
 * mientras que admin-smtp expone un contrato DTO plano específico (host,
 * port, secure, username, password, fromEmail, fromName).
 */

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface AdminSmtpDto {
  host: string | null;
  port: number | null;
  secure: boolean | null;
  username: string | null;
  /** True si hay password guardado (el cleartext nunca sale de la API). */
  hasPassword: boolean;
  fromEmail: string | null;
  fromName: string | null;
  /** ISO8601 del último envío de prueba exitoso, o null si nunca verificado. */
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  /** True si el tenant tiene config propia; false si solo hereda el fallback global. */
  hasTenantConfig: boolean;
  /** True si el despliegue tiene env globales que sirven de fallback. */
  hasGlobalFallback: boolean;
}

export interface AdminSmtpUpsertPayload {
  host: string;
  port: number;
  /** Si se omite, el backend infiere por puerto (465 → true, resto → false). */
  secure?: boolean;
  username: string;
  /** Opcional: si viene vacío o ausente, se conserva el password guardado. */
  password?: string;
  fromEmail: string;
  fromName?: string;
}

export interface AdminSmtpTestResult {
  ok: true;
  sentTo: string;
  messageId?: string;
  verifiedAt: string;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return token;
}

export const adminSmtpApi = {
  async get(): Promise<AdminSmtpDto> {
    return apiFetch<AdminSmtpDto>(
      '/api/v1/admin/tenant-settings/smtp',
      { method: 'GET' },
      withAuth(),
    );
  },
  async upsert(payload: AdminSmtpUpsertPayload): Promise<AdminSmtpDto> {
    return apiFetch<AdminSmtpDto>(
      '/api/v1/admin/tenant-settings/smtp',
      { method: 'PUT', body: JSON.stringify(payload) },
      withAuth(),
    );
  },
  /**
   * Envía el email REAL de una plantilla (con el override del tenant si lo
   * tiene) a una dirección. Sirve para ver cómo queda antes de que salga a
   * cientos de personas — distinto del test de SMTP, que manda un texto fijo
   * solo para validar credenciales.
   */
  async testTemplate(args: {
    toEmail: string;
    templateKey: string;
    variables?: Record<string, string>;
  }): Promise<{ ok: true; sentTo: string; subject: string | null; messageId?: string }> {
    return apiFetch<{ ok: true; sentTo: string; subject: string | null; messageId?: string }>(
      '/api/v1/admin/tenant-settings/smtp/test-template',
      { method: 'POST', body: JSON.stringify(args) },
      withAuth(),
    );
  },
  async test(toEmail: string): Promise<AdminSmtpTestResult> {
    return apiFetch<AdminSmtpTestResult>(
      '/api/v1/admin/tenant-settings/smtp/test',
      { method: 'POST', body: JSON.stringify({ toEmail }) },
      withAuth(),
    );
  },
  /**
   * Elimina la config SMTP del tenant. No hay endpoint dedicado en
   * admin-smtp; se borran las dos rows de `tenant_setting` (smtp + smtp_meta)
   * usando el controlador genérico. Tras esto, si hay env globales el server
   * cae al fallback; si no, los emails dejan de enviarse.
   */
  async remove(): Promise<void> {
    const bearer = withAuth();
    await apiFetch<{ ok: true }>(
      '/api/v1/tenant-settings/notifications/smtp',
      { method: 'DELETE' },
      bearer,
    ).catch((err) => {
      // Si la row no existía igualmente seguimos: el caller pidió un reset.
      if (err instanceof ApiHttpError && err.status === 404) return { ok: true } as const;
      throw err;
    });
    await apiFetch<{ ok: true }>(
      '/api/v1/tenant-settings/notifications/smtp_meta',
      { method: 'DELETE' },
      bearer,
    ).catch((err) => {
      if (err instanceof ApiHttpError && err.status === 404) return { ok: true } as const;
      throw err;
    });
  },
};

export type AdminSmtpStatus = 'verified' | 'configured-unverified' | 'fallback' | 'none';

/**
 * Deriva el estado del banner a partir del DTO. Centralizado para que el
 * componente y los tests compartan la lógica.
 *
 *  - `verified`: tenant tiene su propia config y ya pasó el test de envío.
 *  - `configured-unverified`: tenant tiene config pero `verifiedAt` es null
 *    (recién guardado o cambió un campo y se reseteó la verificación).
 *  - `fallback`: tenant NO tiene config, pero el host expone env globales y
 *    los emails salen por ahí.
 *  - `none`: tenant NO tiene config y tampoco hay fallback global — sin
 *    SMTP los emails de activación / reset de password no se envían.
 */
export function deriveSmtpStatus(dto: AdminSmtpDto): AdminSmtpStatus {
  if (dto.hasTenantConfig && dto.verifiedAt) return 'verified';
  if (dto.hasTenantConfig) return 'configured-unverified';
  if (dto.hasGlobalFallback) return 'fallback';
  return 'none';
}

/**
 * ¿Hay que enseñar el aviso de "no hay salida de correo" en el shell?
 *
 * Vive aquí y no dentro del componente para poder fijarlo con tests: la regla
 * que más fácil se rompe al retocar el banner es la de a quién se le enseña.
 *
 *  - Solo a quien puede arreglarlo (`super_admin` / `tenant_admin`). Un alumno
 *    no configura un SMTP; enseñárselo solo le diría que la plataforma está
 *    rota. Y el endpoint que alimenta esto es admin-only, así que consultarlo
 *    con otro rol sería un 403 por cada carga de página.
 *  - Solo en el estado `none`. Con `fallback` el correo sale por las env
 *    globales del despliegue, y con el tenant configurado —aunque no se haya
 *    verificado aún— hay una salida: avisar ahí sería mentir.
 */
export function shouldShowSmtpBanner(roles: readonly string[], status: AdminSmtpStatus): boolean {
  const puedeArreglarlo = roles.some((r) => r === 'super_admin' || r === 'tenant_admin');
  return puedeArreglarlo && status === 'none';
}
