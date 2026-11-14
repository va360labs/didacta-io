/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash } from 'node:crypto';
import type { PayoutsDbPort, PayoutsLogger } from './accounts.service.js';
import { PlatformStripeApiError } from './errors.js';
import {
  sanitizeStatementDescriptor,
  sanitizeStatementDescriptorPrefix,
  type ConnectedAccountsApi,
  type UpdateAccountBrandingInput,
} from './stripe/accounts-api.js';

/**
 * La MARCA DEL AULA en su cuenta conectada.
 *
 * Con `on_behalf_of`, quien figura como comercio en la pantalla de pago de
 * Stripe, en sus recibos y en el extracto del banco es la cuenta conectada del
 * creador, no la plataforma. Sin esto el comprador veía «Academia Prueba ES»
 * (lo que Stripe dedujo del alta) o nada: ni el logo ni el color del aula en la
 * que acababa de decidir comprar.
 *
 * Qué se sincroniza (`POST /v1/accounts/{id}`, válido también para las cuentas
 * creadas por v2):
 *
 *  - `settings.branding.icon` — el logo del aula en cuadrado (Stripe lo pinta
 *    junto al nombre del comercio);
 *  - `settings.branding.logo` — SOLO si el logo del aula ya lleva el nombre
 *    (modo «solo logo»): Stripe lo enseña EN LUGAR del nombre, y un símbolo
 *    sin letras dejaría la pantalla sin saber de quién es;
 *  - `primary_color` / `secondary_color` — el color del aula;
 *  - `business_profile.name` — el nombre del aula, el que Stripe enseña como
 *    vendedor («Paga de forma segura en …») y en sus recibos;
 *  - `settings.payments.statement_descriptor` y el prefijo de las tarjetas —
 *    el nombre del aula, saneado a lo que admite Stripe (5–22 y 2–10
 *    caracteres latinos, al menos una letra, sin `< > \ ' " *`).
 *
 * Idempotente y barato: la huella de lo aplicado viaja en los metadatos de la
 * cuenta (`didacta_branding`). Si coincide con la de ahora, no se sube nada ni
 * se escribe nada. No hace falta tabla nueva: la verdad de lo aplicado está
 * donde se aplica.
 *
 * Nunca rompe una venta ni un alta: cualquier fallo se registra y se devuelve
 * como `{ applied: false }`. Si Stripe rechaza el descriptor (p. ej. por no
 * parecerse al nombre del negocio), se reintenta sin él para que al menos la
 * marca quede puesta.
 */

/** Una imagen ya preparada para Stripe (PNG o JPEG, ≥128 px, <512 KB). */
export interface PayoutsBrandImage {
  readonly bytes: Uint8Array;
  readonly contentType: 'image/png' | 'image/jpeg';
}

/** Lo que el host sabe de la marca del aula. */
export interface PayoutsBrandInput {
  /** Nombre del aula (lo que ve el alumno). */
  readonly name: string;
  /** `#rrggbb`, o `null` (no se toca). */
  readonly primaryColor: string | null;
  readonly secondaryColor: string | null;
  /** El logo en cuadrado; `null` = sin logo (se quita el que hubiera). */
  readonly icon: PayoutsBrandImage | null;
  /** El logo con nombre (modo «solo logo»); `null` = que Stripe pinte el nombre. */
  readonly logo: PayoutsBrandImage | null;
}

export type PayoutsBrandingResult =
  | { readonly applied: true; readonly changed: boolean; readonly fingerprint: string }
  | { readonly applied: false; readonly reason: string };

/** Metadato de la cuenta con la huella de la marca aplicada. */
export const BRANDING_METADATA_KEY = 'didacta_branding';

const HEX = /^#[0-9a-f]{6}$/;

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Lo que de verdad se manda a Stripe, ya saneado. */
export interface PreparedBranding {
  readonly businessName: string | null;
  readonly statementDescriptor: string | null;
  readonly statementDescriptorPrefix: string | null;
  readonly primaryColor: string | null;
  readonly secondaryColor: string | null;
  readonly iconSha: string | null;
  readonly logoSha: string | null;
  readonly fingerprint: string;
}

export function prepareBranding(input: PayoutsBrandInput): PreparedBranding {
  const color = (value: string | null) => {
    const lower = value?.trim().toLowerCase() ?? null;
    return lower && HEX.test(lower) ? lower : null;
  };
  const businessName = input.name.replace(/\s+/g, ' ').trim().slice(0, 100) || null;
  const statementDescriptor = sanitizeStatementDescriptor(input.name);
  const statementDescriptorPrefix = sanitizeStatementDescriptorPrefix(input.name);
  const primaryColor = color(input.primaryColor);
  const secondaryColor = color(input.secondaryColor);
  const iconSha = input.icon ? sha256(input.icon.bytes) : null;
  const logoSha = input.logo ? sha256(input.logo.bytes) : null;
  const fingerprint = sha256(
    JSON.stringify({
      v: 2,
      businessName,
      statementDescriptor,
      statementDescriptorPrefix,
      primaryColor,
      secondaryColor,
      iconSha,
      logoSha,
    }),
  ).slice(0, 32);
  return {
    businessName,
    statementDescriptor,
    statementDescriptorPrefix,
    primaryColor,
    secondaryColor,
    iconSha,
    logoSha,
    fingerprint,
  };
}

const SILENT: PayoutsLogger = { warn: () => undefined, log: () => undefined };

/**
 * ¿El error de Stripe es por el descriptor del extracto o por el nombre del
 * comercio? (Stripe puede no dejar cambiarlos según el estado de la cuenta.)
 */
function isIdentityRejection(err: unknown): boolean {
  return (
    err instanceof PlatformStripeApiError &&
    err.status === 400 &&
    /statement_descriptor|business_profile/.test(
      `${err.param ?? ''} ${err.detail ?? ''} ${err.message}`,
    )
  );
}

export class PayoutsBrandingService {
  private readonly logger: PayoutsLogger;

  constructor(
    private readonly db: PayoutsDbPort,
    private readonly api: ConnectedAccountsApi,
    options: { readonly logger?: PayoutsLogger } = {},
  ) {
    this.logger = options.logger ?? SILENT;
  }

  /**
   * Aplica la marca a la cuenta conectada viva del tenant, si la hay y si ha
   * cambiado. No lanza nunca.
   */
  async sync(tenantId: string, input: PayoutsBrandInput): Promise<PayoutsBrandingResult> {
    try {
      const row = await this.db.inTenant(tenantId, (tx) =>
        tx.modPayoutsAccount.findFirst({
          where: { tenantId, closedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { stripeAccountId: true },
        }),
      );
      const accountId = row?.stripeAccountId ?? null;
      if (!accountId) return { applied: false, reason: 'no_account' };

      const prepared = prepareBranding(input);
      const remote = await this.api.retrieve(accountId);
      if (remote.metadata?.[BRANDING_METADATA_KEY] === prepared.fingerprint) {
        return { applied: true, changed: false, fingerprint: prepared.fingerprint };
      }

      const iconFileId = input.icon
        ? await this.api.uploadBrandFile({
            purpose: 'business_icon',
            bytes: input.icon.bytes,
            filename: input.icon.contentType === 'image/png' ? 'icono.png' : 'icono.jpg',
            contentType: input.icon.contentType,
          })
        : null;
      const logoFileId = input.logo
        ? await this.api.uploadBrandFile({
            purpose: 'business_logo',
            bytes: input.logo.bytes,
            filename: input.logo.contentType === 'image/png' ? 'logo.png' : 'logo.jpg',
            contentType: input.logo.contentType,
          })
        : null;

      const update: UpdateAccountBrandingInput = {
        // Sin imagen en el aula: se quita la que hubiera (cadena vacía). Si el
        // cliente no sabe subir ficheros, la imagen ni se toca.
        iconFileId: input.icon ? iconFileId : '',
        logoFileId: input.logo ? logoFileId : '',
        primaryColor: prepared.primaryColor,
        secondaryColor: prepared.secondaryColor,
        statementDescriptor: prepared.statementDescriptor,
        statementDescriptorPrefix: prepared.statementDescriptorPrefix,
        businessName: prepared.businessName,
        metadata: { [BRANDING_METADATA_KEY]: prepared.fingerprint },
      };
      try {
        await this.api.updateBranding(accountId, update);
      } catch (err) {
        if (!isIdentityRejection(err)) throw err;
        this.logger.warn(
          { tenantId, stripeAccountId: accountId, err: describe(err) },
          'mod.payouts: Stripe rechaza el nombre o el descriptor del extracto; se aplica la marca sin ellos',
        );
        await this.api.updateBranding(accountId, {
          ...update,
          statementDescriptor: null,
          statementDescriptorPrefix: null,
          businessName: null,
        });
      }
      this.logger.log?.(
        { tenantId, stripeAccountId: accountId, fingerprint: prepared.fingerprint },
        'mod.payouts: marca del aula aplicada a su cuenta conectada',
      );
      return { applied: true, changed: true, fingerprint: prepared.fingerprint };
    } catch (err) {
      this.logger.warn(
        { tenantId, err: describe(err) },
        'mod.payouts: no se pudo aplicar la marca del aula a su cuenta conectada',
      );
      return { applied: false, reason: describe(err) };
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof PlatformStripeApiError) {
    return `${err.operation}: ${err.detail ?? err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
