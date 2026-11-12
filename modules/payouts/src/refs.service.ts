/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PrismaClient } from '@didacta/database';
import { PayoutsInvalidObjectRefError, PayoutsObjectRefConflictError } from './errors.js';

/**
 * Registro `objeto de Stripe → tenant` (`mod_payouts_object_ref`).
 *
 * En modo plataforma TODOS los tenants cobran en la misma cuenta de Stripe, así
 * que la firma de un webhook ya no dice de qué aula es el evento. El tenant
 * sale de este registro, que SOLO escribe nuestro servidor en el momento de
 * crear el objeto (la sesión de checkout, la cuenta conectada…). La metadata
 * del evento no decide nada: la puede escribir cualquiera que cree objetos en
 * la cuenta.
 *
 * Dos propiedades que no son negociables:
 *
 *  - Un objeto pertenece a UN tenant. Registrarlo otra vez con el mismo tenant
 *    y la misma clase es un reintento y no hace nada; con otro tenant u otra
 *    clase, lanza. Nunca se reasigna.
 *  - Si los ids de un evento apuntan a DOS tenants, no se elige: se devuelve
 *    `ambiguous` y quien llama archiva el evento sin efectos.
 *
 * RLS: `resolveTenant` busca entre todos los tenants, así que el host lo llama
 * bajo acceso global sancionado (`runGlobalWithoutTenant`). Dentro del contexto
 * de un tenant solo se ven sus propias filas.
 */

/** Módulo que creó el objeto. */
export const OBJECT_REF_SOURCES = ['billing', 'membership', 'subscriptions', 'payouts'] as const;
export type ObjectRefSource = (typeof OBJECT_REF_SOURCES)[number];

/** Clase de objeto de Stripe. */
export const OBJECT_REF_KINDS = [
  'account',
  'checkout_session',
  'payment_intent',
  'charge',
  'customer',
  'subscription',
  'invoice',
  'refund',
  'dispute',
  'transfer',
  'product',
  'price',
  'portal_configuration',
] as const;
export type ObjectRefKind = (typeof OBJECT_REF_KINDS)[number];

export interface ObjectRef {
  readonly stripeObjectId: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly source: string;
  readonly localRef: string | null;
  readonly parentObjectId: string | null;
  readonly livemode: boolean;
  readonly createdAt: Date;
}

export interface RegisterObjectRefInput {
  readonly tenantId: string;
  readonly stripeObjectId: string;
  readonly kind: ObjectRefKind;
  readonly source: ObjectRefSource;
  /** Id local al que apunta (orden, plan, suscripción…). */
  readonly localRef?: string | null;
  /** Objeto de Stripe del que cuelga. */
  readonly parentObjectId?: string | null;
  readonly livemode: boolean;
}

export type TenantResolution =
  /** Todos los ids registrados son del mismo tenant. */
  | { readonly status: 'resolved'; readonly tenantId: string; readonly refs: ObjectRef[] }
  /** Ningún id está registrado: evento «sin atribuir». */
  | { readonly status: 'unknown' }
  /** Los ids apuntan a más de un tenant: no se elige. */
  | { readonly status: 'ambiguous'; readonly tenantIds: string[]; readonly refs: ObjectRef[] };

/** `acct_1Abc`, `cs_test_a1B2`, `pi_3Xyz`… */
const STRIPE_OBJECT_ID = /^[a-z][a-z0-9]*_[A-Za-z0-9_]{1,250}$/;

export class RefsService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Registra un objeto a nombre de un tenant. Idempotente.
   *
   * Igual que el libro: `ON CONFLICT DO NOTHING` y comprobación posterior, en
   * vez de capturar la violación de unicidad (que abortaría la transacción del
   * que llama).
   */
  async register(input: RegisterObjectRefInput): Promise<{ created: boolean }> {
    if (!STRIPE_OBJECT_ID.test(input.stripeObjectId)) {
      throw new PayoutsInvalidObjectRefError('id de objeto');
    }
    if (!OBJECT_REF_KINDS.includes(input.kind)) {
      throw new PayoutsInvalidObjectRefError(`clase ${String(input.kind)}`);
    }
    if (!OBJECT_REF_SOURCES.includes(input.source)) {
      throw new PayoutsInvalidObjectRefError(`origen ${String(input.source)}`);
    }

    const { count } = await this.prisma.modPayoutsObjectRef.createMany({
      data: [
        {
          stripeObjectId: input.stripeObjectId,
          tenantId: input.tenantId,
          kind: input.kind,
          source: input.source,
          localRef: input.localRef ?? null,
          parentObjectId: input.parentObjectId ?? null,
          livemode: input.livemode,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) return { created: true };

    // Ya existía. Si RLS no deja verla (`null`), es de otro tenant.
    const existing = await this.prisma.modPayoutsObjectRef.findUnique({
      where: { stripeObjectId: input.stripeObjectId },
    });
    if (
      !existing ||
      existing.tenantId !== input.tenantId ||
      existing.kind !== input.kind ||
      existing.livemode !== input.livemode
    ) {
      throw new PayoutsObjectRefConflictError(input.stripeObjectId);
    }
    return { created: false };
  }

  /** Registra varios objetos del mismo evento, en orden. */
  async registerMany(inputs: readonly RegisterObjectRefInput[]): Promise<{ created: number }> {
    let created = 0;
    for (const input of inputs) {
      if ((await this.register(input)).created) created += 1;
    }
    return { created };
  }

  /** Filas registradas para esos ids (las que el contexto actual deja ver). */
  async findByIds(stripeObjectIds: readonly string[]): Promise<ObjectRef[]> {
    const ids = uniqueIds(stripeObjectIds);
    if (ids.length === 0) return [];
    return this.prisma.modPayoutsObjectRef.findMany({
      where: { stripeObjectId: { in: ids } },
      orderBy: { stripeObjectId: 'asc' },
    });
  }

  /**
   * ¿De qué tenant es un evento? Recibe TODOS los ids que nombra (el objeto y
   * sus padres: sesión, `pi_…`, cliente, suscripción…) y responde con uno de
   * tres resultados. Llamar bajo acceso global sancionado.
   */
  async resolveTenant(
    stripeObjectIds: ReadonlyArray<string | null | undefined>,
  ): Promise<TenantResolution> {
    const refs = await this.findByIds(
      stripeObjectIds.filter((id): id is string => typeof id === 'string'),
    );
    if (refs.length === 0) return { status: 'unknown' };
    const tenantIds = [...new Set(refs.map((ref) => ref.tenantId))].sort();
    if (tenantIds.length > 1) return { status: 'ambiguous', tenantIds, refs };
    return { status: 'resolved', tenantId: tenantIds[0]!, refs };
  }

  /**
   * Como `resolveTenant`, pero por los objetos registrados que CUELGAN de esos
   * ids (`parent_object_id`). Llamar bajo acceso global sancionado.
   */
  async resolveTenantByParents(
    parentObjectIds: ReadonlyArray<string | null | undefined>,
  ): Promise<TenantResolution> {
    const ids = uniqueIds(parentObjectIds.filter((id): id is string => typeof id === 'string'));
    if (ids.length === 0) return { status: 'unknown' };
    const refs = await this.prisma.modPayoutsObjectRef.findMany({
      where: { parentObjectId: { in: ids } },
      orderBy: { stripeObjectId: 'asc' },
    });
    if (refs.length === 0) return { status: 'unknown' };
    const tenantIds = [...new Set(refs.map((ref) => ref.tenantId))].sort();
    if (tenantIds.length > 1) return { status: 'ambiguous', tenantIds, refs };
    return { status: 'resolved', tenantId: tenantIds[0]!, refs };
  }

  /**
   * ¿Algún id es de un objeto de PLATAFORMA? Lo usan los webhooks heredados
   * (claves propias) para rechazar eventos que nombren objetos de este modo.
   * Llamar bajo acceso global sancionado.
   */
  async isPlatformObject(
    stripeObjectIds: ReadonlyArray<string | null | undefined>,
    opts: {
      /**
       * Ids LOCALES de la orden (`metadata.orderId`) que el evento nombra. Un
       * evento falsificado puede inventarse el `cs_…` y apuntar con la metadata
       * a una orden real cobrada por la plataforma: la orden también delata.
       */
      readonly checkoutLocalRefs?: ReadonlyArray<string | null | undefined>;
    } = {},
  ): Promise<boolean> {
    const ids = uniqueIds(stripeObjectIds.filter((id): id is string => typeof id === 'string'));
    const localRefs = uniqueIds(
      (opts.checkoutLocalRefs ?? []).filter((id): id is string => typeof id === 'string'),
    );
    if (ids.length === 0 && localRefs.length === 0) return false;
    const found = await this.prisma.modPayoutsObjectRef.findFirst({
      where: {
        OR: [
          ...(ids.length > 0 ? [{ stripeObjectId: { in: ids } }] : []),
          ...(localRefs.length > 0
            ? [{ kind: 'checkout_session', localRef: { in: localRefs } }]
            : []),
        ],
      },
      select: { stripeObjectId: true },
    });
    return found !== null;
  }

  /** Fila registrada de un objeto (la que el contexto actual deja ver). */
  async find(stripeObjectId: string): Promise<ObjectRef | null> {
    return this.prisma.modPayoutsObjectRef.findUnique({ where: { stripeObjectId } });
  }
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}
