/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { ClientContext } from '../auth/client-context';
import { runAsTenant } from '../tenancy/tenant-context.storage';

/**
 * Piezas comunes de los webhooks ENTRANTES firmados con un secreto por tenant
 * (Stripe, Zoom): comparar secretos y dejar rastro de un evento que nombra a
 * otra aula.
 *
 * El principio que comparten: una firma válida demuestra quién ENVÍA —quien
 * conoce el secreto del tenant del dominio—, no a quién se refiere el
 * contenido. El contenido lo escribe el que firma. Así que el evento se procesa
 * para un tenant solo si la firma se verificó con el secreto de ESE tenant.
 */

/** Comparación en tiempo constante (sobre el hash: los secretos pueden medir distinto). */
export function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Acción de auditoría del rechazo. Estable: es por lo que se busca. */
export const WEBHOOK_FOREIGN_TENANT_AUDIT_ACTION = 'security.webhook.tenant_mismatch';

export type WebhookAuditWriter = (entry: {
  tenantId: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}) => Promise<void>;

export interface WebhookRejectionLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Registra un webhook con firma válida que nombra a otra aula: log de error
 * (para el operador de la instancia) + entrada en la auditoría del tenant que
 * firmó. No lanza nunca: quien llama rechaza la petición pase lo que pase aquí.
 *
 * Se audita en el tenant que FIRMÓ porque es el único del que hay prueba de que
 * participa. Escribir en la auditoría de la víctima sería justo lo que se
 * evita: un efecto en un aula provocado desde otra.
 */
export async function reportForeignTenantWebhook(args: {
  provider: 'stripe' | 'zoom';
  code: string;
  verifiedTenantId: string;
  /** Lo que el evento nombraba o tocaba. Viene de fuera: se acota. */
  claimedTenantIds: readonly string[];
  eventId: string;
  eventType: string;
  extra?: Record<string, unknown>;
  audit: WebhookAuditWriter;
  logger: WebhookRejectionLogger;
  host?: string;
  client?: ClientContext;
}): Promise<void> {
  const detail = {
    provider: args.provider,
    eventId: args.eventId.slice(0, 255),
    eventType: args.eventType.slice(0, 100),
    verifiedTenantId: args.verifiedTenantId,
    claimedTenantIds: args.claimedTenantIds.slice(0, 5).map((t) => t.slice(0, 64)),
    host: args.host ? args.host.slice(0, 255) : null,
    ip: args.client?.ip ?? null,
    ...args.extra,
  };
  args.logger.error(
    { ...detail, code: args.code },
    'WEBHOOK SOSPECHOSO: evento con firma válida que nombra a OTRA aula. Rechazado sin procesar. Quien firma conoce el secreto de webhook del tenant verificado.',
  );
  try {
    await runAsTenant(args.verifiedTenantId, () =>
      args.audit({
        tenantId: args.verifiedTenantId,
        actorId: null,
        action: WEBHOOK_FOREIGN_TENANT_AUDIT_ACTION,
        resourceType: `${args.provider}_webhook`,
        resourceId: detail.eventId,
        metadata: detail,
        ip: args.client?.ip ?? undefined,
        userAgent: args.client?.userAgent ?? undefined,
      }),
    );
  } catch (err) {
    args.logger.error(
      { err, eventId: detail.eventId },
      'No se pudo auditar el webhook sospechoso (el rechazo se mantiene).',
    );
  }
}
