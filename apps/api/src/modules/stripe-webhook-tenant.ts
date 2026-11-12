/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ForbiddenException } from '@nestjs/common';
import type { ClientContext } from '../auth/client-context';
import { runAsTenant } from '../tenancy/tenant-context.storage';
import type { ResolvedStripeCredentials } from './tenant-stripe-resolver.service';
import {
  reportForeignTenantWebhook,
  sameSecret,
  type WebhookAuditWriter,
  type WebhookRejectionLogger,
} from './webhook-foreign-tenant';

/**
 * Para qué tenant se procesa un evento de Stripe ya verificado.
 *
 * ── El fallo que cierra ─────────────────────────────────────────────────────
 *
 * Los webhooks de Stripe eligen el secreto con el que verifican la firma por el
 * DOMINIO de la petición —que lo pone quien llama— y cada tenant configura sus
 * propias credenciales desde Administración → Pagos. O sea: el administrador
 * del aula B conoce un secreto con el que este servidor da por buena una firma.
 *
 * Una firma válida demuestra QUIÉN envía el evento. No dice nada de a quién se
 * refiere su contenido. Y el contenido —la `metadata.tenantId`, el id de la
 * orden, el de la suscripción, el de la factura— lo escribe el que firma. Antes
 * el evento se procesaba para el tenant que saliera de ahí: B firmaba con su
 * secreto un `checkout.session.completed` que nombraba al aula A y obtenía en A
 * una membresía ACTIVE y un pedido COMPLETED sin pagar un euro.
 *
 * ── La regla ───────────────────────────────────────────────────────────────
 *
 * Un evento se procesa para un tenant SOLO si la firma se verificó con las
 * credenciales de Stripe de ese tenant. Dos casos:
 *
 *  1. El evento no nombra a nadie, o nombra al tenant del dominio → se procesa
 *     para el tenant del dominio. Es el caso normal.
 *
 *  2. El evento nombra a OTRO tenant. Solo pasa si ese otro tenant resuelve a
 *     la MISMA clave secreta de Stripe que el tenant que verificó la firma: los
 *     dos cobran con la misma cuenta, así que quien firma ya es, a efectos de
 *     pagos, la misma parte. Es lo que mantiene vivo el despliegue heredado de
 *     varias aulas del mismo dueño sobre las `STRIPE_*` de instancia, donde
 *     Stripe tiene UN solo endpoint (un solo secreto de firma) apuntando al
 *     dominio de una de ellas y se reparte por metadata. Un atacante no puede
 *     fabricar esta coincidencia: tendría que conocer la clave secreta de la
 *     víctima, y con ella ya no necesita este webhook para nada.
 *
 * Cualquier otra cosa —otro tenant con otra cuenta, dos tenants distintos en
 * un mismo evento, un id que no es un UUID— se rechaza con 403, se registra
 * como intento sospechoso y no crea ni modifica nada.
 */

export interface StripeEventTenantInput {
  /** Qué endpoint lo recibe; solo para el rastro. */
  endpoint: 'billing' | 'subscriptions';
  /** `code` del cuerpo del 403 (cada controlador conserva su prefijo). */
  errorCode: string;
  /** Tenant resuelto por el dominio: el dueño del secreto que verificó la firma. */
  verifiedTenantId: string;
  /** Credenciales con las que se verificó la firma. */
  verified: ResolvedStripeCredentials;
  /**
   * Todos los tenants que el evento nombra (metadata) o toca (dueños de las
   * filas que el procesado iría a buscar por id), de todos los módulos que lo
   * van a procesar. Ver `resolveWebhookTenantClaims` de cada módulo.
   */
  claims: ReadonlyArray<string | null | undefined>;
  event: { id: string; type: string };
  /** Credenciales de Stripe de un tenant cualquiera (`TenantStripeResolverService.resolve`). */
  resolveCredentials: (tenantId: string) => Promise<ResolvedStripeCredentials | null>;
  /** Auditoría del tenant que firmó. Un fallo aquí no puede tapar el rechazo. */
  audit: WebhookAuditWriter;
  logger: WebhookRejectionLogger;
  host?: string;
  client?: ClientContext;
  /**
   * Solo con el modo plataforma encendido: ¿nombra el evento un objeto que
   * cobró la PLATAFORMA (sesión, PaymentIntent, cargo, cliente… registrados en
   * `mod_payouts_object_ref`, o la orden local de una de esas sesiones)?
   *
   * Esos eventos solo los firma Stripe con el secreto del operador y entran por
   * el webhook de plataforma. Por un endpoint heredado los firma un aula con
   * SUS claves: aunque fuera su propia venta, completaría una orden que la
   * plataforma no ha cobrado. Se rechazan con 403 antes de tocar nada.
   */
  namesPlatformObject?: () => Promise<boolean>;
  /** `code` del 403 por objeto de plataforma (por defecto, `errorCode`). */
  platformObjectErrorCode?: string;
}

/** Acción de auditoría del rechazo por objeto de plataforma. */
export const WEBHOOK_PLATFORM_OBJECT_AUDIT_ACTION = 'security.webhook.platform_object';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Devuelve el tenant para el que se procesa el evento, o lanza 403.
 * No tiene efectos cuando acepta; cuando rechaza, solo log + auditoría.
 */
export async function resolveStripeEventTenant(input: StripeEventTenantInput): Promise<string> {
  // Regla de la plataforma, la primera: ni siquiera el aula dueña de la venta
  // puede firmar con sus claves un evento sobre lo que cobró el operador.
  if (input.namesPlatformObject && (await input.namesPlatformObject())) {
    await reportPlatformObjectWebhook(input);
    throw new ForbiddenException({
      message:
        'Este evento es de un cobro hecho a través de la plataforma: solo se acepta por el webhook de la plataforma.',
      code: input.platformObjectErrorCode ?? input.errorCode,
    });
  }

  const named = [...new Set(input.claims.filter((c): c is string => Boolean(c)))];
  const foreign = named.filter((t) => t !== input.verifiedTenantId);

  // Caso 1: nada ajeno. El evento es del tenant del dominio (o de nadie).
  if (foreign.length === 0) return input.verifiedTenantId;

  // Caso 2: nombra a UN solo tenant, distinto, que cobra con la misma cuenta.
  if (named.length === 1) {
    const other = named[0]!;
    if (await sharesStripeAccount(input, other)) return other;
  }

  await reportForeignTenantWebhook({
    provider: 'stripe',
    code: input.errorCode,
    verifiedTenantId: input.verifiedTenantId,
    claimedTenantIds: named,
    eventId: input.event.id,
    eventType: input.event.type,
    extra: { endpoint: input.endpoint, credentialsSource: input.verified.source },
    audit: input.audit,
    logger: input.logger,
    host: input.host,
    client: input.client,
  });
  throw new ForbiddenException({
    message: 'Este webhook solo acepta eventos del aula a la que pertenece este dominio.',
    code: input.errorCode,
  });
}

/** Rastro del rechazo: log de error y auditoría en el aula que firmó. */
async function reportPlatformObjectWebhook(input: StripeEventTenantInput): Promise<void> {
  const detail = {
    provider: 'stripe',
    endpoint: input.endpoint,
    eventId: input.event.id.slice(0, 255),
    eventType: input.event.type.slice(0, 100),
    verifiedTenantId: input.verifiedTenantId,
    credentialsSource: input.verified.source,
    host: input.host ? input.host.slice(0, 255) : null,
    ip: input.client?.ip ?? null,
  };
  input.logger.error(
    { ...detail, code: input.platformObjectErrorCode ?? input.errorCode },
    'WEBHOOK SOSPECHOSO: evento firmado con las claves de un aula que nombra un cobro de la PLATAFORMA. Rechazado sin procesar.',
  );
  try {
    await runAsTenant(input.verifiedTenantId, () =>
      input.audit({
        tenantId: input.verifiedTenantId,
        actorId: null,
        action: WEBHOOK_PLATFORM_OBJECT_AUDIT_ACTION,
        resourceType: 'stripe_webhook',
        resourceId: detail.eventId,
        metadata: detail,
        ip: input.client?.ip ?? undefined,
        userAgent: input.client?.userAgent ?? undefined,
      }),
    );
  } catch (err) {
    input.logger.error(
      { err, eventId: detail.eventId },
      'No se pudo auditar el webhook sospechoso (el rechazo se mantiene).',
    );
  }
}

async function sharesStripeAccount(input: StripeEventTenantInput, other: string): Promise<boolean> {
  // El id viene del evento: lo escribe quien firma. Antes de usarlo como
  // contexto de tenant (acaba en un `::uuid` de Postgres) se le exige la forma.
  if (!UUID_RE.test(other)) return false;
  let otherCredentials: ResolvedStripeCredentials | null;
  try {
    otherCredentials = await runAsTenant(other, () => input.resolveCredentials(other));
  } catch {
    // Config ilegible del otro tenant: no se puede demostrar que comparta
    // cuenta, así que no la comparte.
    return false;
  }
  if (!otherCredentials) return false;
  return sameSecret(otherCredentials.credentials.secretKey, input.verified.credentials.secretKey);
}
