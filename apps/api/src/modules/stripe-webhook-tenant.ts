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
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Devuelve el tenant para el que se procesa el evento, o lanza 403.
 * No tiene efectos cuando acepta; cuando rechaza, solo log + auditoría.
 */
export async function resolveStripeEventTenant(input: StripeEventTenantInput): Promise<string> {
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
