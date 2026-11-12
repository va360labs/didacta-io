/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash } from 'node:crypto';
import type { PayoutsDbPort, PayoutsLogger, PayoutsTx } from '../accounts.service.js';
import { PayoutsTaxProfileInvalidError } from '../errors.js';
import type { ConnectedAccountsApi } from '../stripe/accounts-api.js';
import { checkTaxId, checkVatId, isEuVatCountry, taxIdHint } from './tax-ids.js';
import type { ViesClient } from './vies.js';

/**
 * Datos fiscales del creador (piezas legales del lanzamiento de Cloud).
 *
 * Para qué:
 *  - La factura mensual de la comisión (RD 1619/2012, art. 6) tiene que
 *    identificar al destinatario: nombre o razón social, NIF y domicilio.
 *  - DAC7 (Directiva 2021/514; Ley 13/2023 y RD 117/2024) obliga al operador a
 *    recoger y verificar nombre, dirección, NIF y, si es persona física, la
 *    fecha de nacimiento.
 *  - El NIF-IVA de una empresa de otra parte de la UE, válido en VIES, es lo
 *    que permite facturar sin IVA (inversión del sujeto pasivo).
 *
 * Qué hace:
 *  - Propone lo que Stripe ya tiene de la cuenta conectada (nombre, dirección,
 *    fecha de nacimiento): el creador solo escribe lo que falta (el NIF, que
 *    Stripe no deja leer).
 *  - Valida la forma (NIF español con su control) y comprueba el NIF-IVA en
 *    VIES con caché: el resultado vale 30 días para ESE número. Si VIES no
 *    responde, queda «pendiente» y se reintenta; nunca bloquea.
 *  - Guarda lo identificativo CIFRADO (puerto `PayoutsCipher`, que el host
 *    implementa con `SecretCipherService`). Nada de esto va a los logs.
 *  - Con los datos completos, libera las ventas retenidas por faltarlos.
 */

export type TaxEntityType = 'individual' | 'company';
export type VatStatus = 'valid' | 'invalid' | 'pending' | 'not_applicable';

export interface TaxAddress {
  readonly line1: string;
  readonly line2?: string | null;
  readonly postalCode: string;
  readonly city: string;
  readonly region?: string | null;
}

/** Lo que manda el creador desde «Datos fiscales». */
export interface TaxProfileInput {
  readonly entityType: TaxEntityType;
  readonly legalName: string;
  /** ISO 3166-1 alfa-2. */
  readonly country: string;
  /** Sin él se conserva el guardado (el formulario no lo vuelve a enseñar). */
  readonly taxId?: string | null;
  /** `''` lo borra; ausente lo conserva. */
  readonly vatId?: string | null;
  readonly address: TaxAddress;
  /** `AAAA-MM-DD`. Obligatoria para personas físicas (DAC7). */
  readonly birthDate?: string | null;
}

/** El bloque cifrado. */
export interface TaxSensitiveData {
  readonly taxId: string | null;
  readonly vatId: string | null;
  readonly address: TaxAddress | null;
  readonly birthDate: string | null;
}

/** Todo, descifrado: solo para la factura (nunca sale a la web entero). */
export interface TaxProfileFull extends TaxSensitiveData {
  readonly entityType: TaxEntityType;
  readonly legalName: string;
  readonly country: string;
  readonly vatStatus: VatStatus;
  readonly vatConsultation: string | null;
  readonly complete: boolean;
}

/** Cifrado simétrico que pone el host (`SecretCipherService`). */
export interface PayoutsCipher {
  encrypt(plaintext: string): { cipher: Buffer; iv: Buffer; tag: Buffer };
  decrypt(payload: { cipher: Buffer; iv: Buffer; tag: Buffer }): string;
}

/** Campo que falta o no vale → motivo. Es lo que ve la web. */
export type TaxFieldProblems = Partial<Record<TaxField, string>>;
export type TaxField =
  | 'entityType'
  | 'legalName'
  | 'country'
  | 'taxId'
  | 'vatId'
  | 'address.line1'
  | 'address.postalCode'
  | 'address.city'
  | 'birthDate';

/** Lo que devuelve `GET /modules/payouts/tax-profile`. Sin NIF en claro. */
export interface TaxProfileView {
  /** `missing`: aún no ha dado nada; `incomplete`; `complete`. */
  readonly status: 'missing' | 'incomplete' | 'complete';
  /** ¿Se retienen las transferencias mientras no esté completo? */
  readonly required: boolean;
  readonly profile: {
    readonly entityType: TaxEntityType;
    readonly legalName: string;
    readonly country: string;
    /** «678Z». El NIF entero nunca vuelve a la web. */
    readonly taxIdHint: string | null;
    readonly vatIdHint: string | null;
    readonly vatStatus: VatStatus;
    readonly vatCheckedAt: string | null;
    readonly address: TaxAddress | null;
    readonly birthDate: string | null;
    readonly confirmedAt: string | null;
  } | null;
  /** Borrador con lo que ya sabe Stripe (solo si no hay perfil guardado). */
  readonly prefill: {
    readonly entityType: TaxEntityType | null;
    readonly legalName: string | null;
    readonly country: string | null;
    readonly address: TaxAddress | null;
    readonly birthDate: string | null;
  } | null;
  /** Lo que falta para estar completo. */
  readonly missing: readonly TaxField[];
  /** Ventas retenidas ahora mismo por faltar estos datos. */
  readonly heldSales: number;
}

export interface TaxProfileServiceOptions {
  readonly now?: () => Date;
  readonly logger?: PayoutsLogger;
  /** ¿Se retienen las transferencias sin datos completos? (por defecto, sí). */
  readonly required?: boolean;
  /** Cuánto vale una comprobación de VIES para el mismo número. */
  readonly vatCacheMs?: number;
}

/** Prefijo de `last_error` de una venta retenida por esto. */
export const TAX_PROFILE_HOLD_REASON = 'tax_profile_incomplete';

const DAY = 24 * 60 * 60 * 1000;
const SILENT: PayoutsLogger = { warn: () => undefined };

type ProfileRow = Awaited<ReturnType<PayoutsTx['modPayoutsTaxProfile']['findFirstOrThrow']>>;

export class PayoutsTaxProfileService {
  private readonly now: () => Date;
  private readonly logger: PayoutsLogger;
  readonly required: boolean;
  private readonly vatCacheMs: number;

  constructor(
    private readonly db: PayoutsDbPort,
    private readonly cipher: PayoutsCipher,
    private readonly vies: ViesClient,
    private readonly accounts: Pick<ConnectedAccountsApi, 'retrieve'> | null,
    options: TaxProfileServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? SILENT;
    this.required = options.required ?? true;
    this.vatCacheMs = options.vatCacheMs ?? 30 * DAY;
  }

  // ── Lectura ────────────────────────────────────────────────────────────

  async view(tenantId: string): Promise<TaxProfileView> {
    const { row, heldSales } = await this.db.inTenant(tenantId, async (tx) => ({
      row: await tx.modPayoutsTaxProfile.findFirst({ where: { tenantId } }),
      heldSales: await tx.modPayoutsSale.count({
        where: {
          tenantId,
          status: 'HELD',
          lastError: { startsWith: `${TAX_PROFILE_HOLD_REASON}:` },
        },
      }),
    }));
    if (!row) {
      const prefill = await this.prefillFromStripe(tenantId);
      return {
        status: 'missing',
        required: this.required,
        profile: null,
        prefill,
        missing: missingFields({
          entityType: prefill?.entityType ?? null,
          legalName: prefill?.legalName ?? '',
          country: prefill?.country ?? '',
          taxId: null,
          vatId: null,
          address: prefill?.address ?? null,
          birthDate: prefill?.birthDate ?? null,
        }),
        heldSales,
      };
    }
    const data = this.decryptRow(row);
    return {
      status: row.complete ? 'complete' : 'incomplete',
      required: this.required,
      profile: {
        entityType: row.entityType as TaxEntityType,
        legalName: row.legalName,
        country: row.country,
        taxIdHint: row.taxIdHint,
        vatIdHint: data.vatId ? taxIdHint(data.vatId) : null,
        vatStatus: row.vatStatus as VatStatus,
        vatCheckedAt: row.vatCheckedAt?.toISOString() ?? null,
        address: data.address,
        birthDate: data.birthDate,
        confirmedAt: row.confirmedAt?.toISOString() ?? null,
      },
      prefill: null,
      missing: missingFields({
        entityType: row.entityType as TaxEntityType,
        legalName: row.legalName,
        country: row.country,
        taxId: data.taxId,
        vatId: data.vatId,
        address: data.address,
        birthDate: data.birthDate,
      }),
      heldSales,
    };
  }

  /** Todo descifrado (para emitir una factura). `null` si no hay perfil. */
  async full(tenantId: string, tx?: PayoutsTx): Promise<TaxProfileFull | null> {
    const read = (t: PayoutsTx) => t.modPayoutsTaxProfile.findFirst({ where: { tenantId } });
    const row = tx ? await read(tx) : await this.db.inTenant(tenantId, read);
    if (!row) return null;
    return {
      ...this.decryptRow(row),
      entityType: row.entityType as TaxEntityType,
      legalName: row.legalName,
      country: row.country,
      vatStatus: row.vatStatus as VatStatus,
      vatConsultation: row.vatConsultation,
      complete: row.complete,
    };
  }

  /**
   * ¿Se puede transferir a este creador? `null` = sí. Con el requisito
   * apagado, siempre sí.
   */
  async transferBlockReason(tenantId: string): Promise<string | null> {
    if (!this.required) return null;
    const row = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsTaxProfile.findFirst({ where: { tenantId }, select: { complete: true } }),
    );
    return row?.complete ? null : TAX_PROFILE_HOLD_REASON;
  }

  // ── Escritura ──────────────────────────────────────────────────────────

  /**
   * Guarda (o corrige) los datos. Valida todo y, si algo no vale, lanza
   * `PayoutsTaxProfileInvalidError` con cada campo y su motivo sin escribir
   * nada. Comprueba el NIF-IVA en VIES (con caché). Devuelve la vista y si
   * con esto quedó completo por primera vez o tras faltar algo.
   */
  async save(
    tenantId: string,
    input: TaxProfileInput,
    actorId: string | null,
  ): Promise<{ view: TaxProfileView; becameComplete: boolean; releasedSales: number }> {
    const existing = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsTaxProfile.findFirst({ where: { tenantId } }),
    );
    const previous = existing ? this.decryptRow(existing) : null;
    const country = (input.country ?? '').trim().toUpperCase();
    const entityType = input.entityType;

    const problems: TaxFieldProblems = {};
    if (entityType !== 'individual' && entityType !== 'company') problems.entityType = 'invalid';
    const legalName = (input.legalName ?? '').replace(/\s+/g, ' ').trim();
    if (legalName.length < 2 || legalName.length > 200) problems.legalName = 'required';
    if (!/^[A-Z]{2}$/.test(country)) problems.country = 'invalid';

    // NIF: el nuevo si lo manda; si no, el guardado (se revalida por si cambió
    // el país o el tipo).
    const rawTaxId = input.taxId?.trim() ? input.taxId : (previous?.taxId ?? null);
    let taxId: string | null = null;
    if (problems.country === undefined && problems.entityType === undefined) {
      const check = checkTaxId(country, entityType, rawTaxId);
      if (check.ok) taxId = check.value;
      else problems.taxId = check.reason;
    }

    let vatId: string | null = null;
    const rawVat =
      input.vatId === undefined ? (previous?.vatId ?? null) : input.vatId?.trim() || null;
    if (rawVat && problems.country === undefined) {
      if (!isEuVatCountry(country)) {
        problems.vatId = 'not_eu';
      } else {
        const check = checkVatId(country, rawVat);
        if (check.ok) vatId = check.value;
        else problems.vatId = check.reason;
      }
    }

    const address = normalizeAddress(input.address);
    if (!address.line1) problems['address.line1'] = 'required';
    if (!address.postalCode) problems['address.postalCode'] = 'required';
    if (!address.city) problems['address.city'] = 'required';

    let birthDate: string | null = null;
    if (entityType === 'individual') {
      const check = checkBirthDate(input.birthDate ?? null, this.now());
      if (check.ok) birthDate = check.value;
      else problems.birthDate = check.reason;
    }

    if (Object.keys(problems).length > 0) throw new PayoutsTaxProfileInvalidError(problems);

    // NIF-IVA en VIES, con caché por número.
    const vat = await this.vatState(existing, vatId);
    const sensitive: TaxSensitiveData = { taxId, vatId, address, birthDate };
    const encrypted = this.cipher.encrypt(JSON.stringify(sensitive));
    const now = this.now();
    const complete =
      missingFields({
        entityType,
        legalName,
        country,
        taxId,
        vatId,
        address,
        birthDate,
      }).length === 0;

    const data = {
      entityType,
      legalName,
      country,
      sensitiveCipher: encrypted.cipher,
      sensitiveIv: encrypted.iv,
      sensitiveTag: encrypted.tag,
      taxIdHint: taxId ? taxIdHint(taxId) : null,
      hasVatId: vatId !== null,
      vatStatus: vat.status,
      vatCheckedAt: vat.checkedAt,
      vatCheckedHash: vat.hash,
      vatConsultation: vat.consultation,
      complete,
      confirmedBy: actorId,
      confirmedAt: now,
    };
    const wasComplete = existing?.complete === true;
    const released = await this.db.inTenant(tenantId, async (tx) => {
      await tx.modPayoutsTaxProfile.upsert({
        where: { tenantId },
        create: { tenantId, ...data },
        update: data,
      });
      return complete ? releaseHeld(tx, tenantId, now) : 0;
    });
    if (released > 0) {
      this.logger.log?.(
        { tenantId, released },
        'payouts.tax: datos fiscales completos — se liberan las ventas retenidas',
      );
    }
    return {
      view: await this.view(tenantId),
      becameComplete: complete && !wasComplete,
      releasedSales: released,
    };
  }

  /**
   * Vuelve a preguntar a VIES por los perfiles con el NIF-IVA pendiente (o
   * caducado). Lo llaman el worker de facturas y la emisión. Devuelve el
   * estado resultante de ese tenant.
   */
  async refreshVat(
    tenantId: string,
    options: { readonly force?: boolean } = {},
  ): Promise<VatStatus> {
    const row = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsTaxProfile.findFirst({ where: { tenantId } }),
    );
    if (!row) return 'not_applicable';
    const data = this.decryptRow(row);
    if (!data.vatId) return row.vatStatus as VatStatus;
    const vat = await this.vatState(row, data.vatId, { force: options.force === true });
    await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsTaxProfile.updateMany({
        where: { tenantId, id: row.id },
        data: {
          vatStatus: vat.status,
          vatCheckedAt: vat.checkedAt,
          vatCheckedHash: vat.hash,
          vatConsultation: vat.consultation,
        },
      }),
    );
    return vat.status;
  }

  // ── Internas ───────────────────────────────────────────────────────────

  private async vatState(
    existing: ProfileRow | null,
    vatId: string | null,
    options: { readonly force?: boolean } = {},
  ): Promise<{
    status: VatStatus;
    checkedAt: Date | null;
    hash: string | null;
    consultation: string | null;
  }> {
    if (!vatId)
      return { status: 'not_applicable', checkedAt: null, hash: null, consultation: null };
    const hash = sha256(vatId);
    const now = this.now();
    if (
      !options.force &&
      existing &&
      existing.vatCheckedHash === hash &&
      (existing.vatStatus === 'valid' || existing.vatStatus === 'invalid') &&
      existing.vatCheckedAt &&
      now.getTime() - existing.vatCheckedAt.getTime() < this.vatCacheMs
    ) {
      return {
        status: existing.vatStatus as VatStatus,
        checkedAt: existing.vatCheckedAt,
        hash,
        consultation: existing.vatConsultation,
      };
    }
    const result = await this.vies.check(vatId.slice(0, 2), vatId.slice(2));
    if (result.status === 'unavailable') {
      this.logger.warn(
        { detail: result.detail },
        'payouts.tax: VIES no responde — el NIF-IVA queda pendiente de comprobar',
      );
      // Una comprobación válida anterior del MISMO número sigue sirviendo
      // mientras VIES no responda (art. 18 Reglamento 282/2011: el proveedor
      // puede fiarse de la validación que obtuvo).
      if (existing && existing.vatCheckedHash === hash && existing.vatStatus === 'valid') {
        return {
          status: 'valid',
          checkedAt: existing.vatCheckedAt,
          hash,
          consultation: existing.vatConsultation,
        };
      }
      return { status: 'pending', checkedAt: null, hash, consultation: null };
    }
    return {
      status: result.status,
      checkedAt: result.checkedAt,
      hash,
      consultation: result.consultation,
    };
  }

  private decryptRow(row: ProfileRow): TaxSensitiveData {
    const plain = this.cipher.decrypt({
      cipher: Buffer.from(row.sensitiveCipher),
      iv: Buffer.from(row.sensitiveIv),
      tag: Buffer.from(row.sensitiveTag),
    });
    const parsed = JSON.parse(plain) as Partial<TaxSensitiveData>;
    return {
      taxId: parsed.taxId ?? null,
      vatId: parsed.vatId ?? null,
      address: parsed.address ?? null,
      birthDate: parsed.birthDate ?? null,
    };
  }

  /** Lo que Stripe ya sabe del creador. Nunca lanza: sin Stripe, sin borrador. */
  private async prefillFromStripe(tenantId: string): Promise<TaxProfileView['prefill']> {
    if (!this.accounts) return null;
    const account = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsAccount.findFirst({
        where: { tenantId, stripeAccountId: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { stripeAccountId: true, country: true, entityType: true },
      }),
    );
    if (!account?.stripeAccountId) return null;
    try {
      const raw = (await this.accounts.retrieve(
        account.stripeAccountId,
      )) as unknown as StripeIdentity;
      return identityFromStripe(raw, account.country, account.entityType);
    } catch (err) {
      this.logger.warn(
        { tenantId, err: (err as Error).message },
        'payouts.tax: no se pudo leer la cuenta de Stripe para proponer los datos',
      );
      return {
        entityType: account.entityType === 'company' ? 'company' : 'individual',
        legalName: null,
        country: account.country,
        address: null,
        birthDate: null,
      };
    }
  }
}

/** La parte de `GET /v1/accounts/{id}` con la identidad (la que Stripe deja leer). */
interface StripeIdentity {
  readonly country?: string | null;
  readonly business_type?: string | null;
  readonly individual?: {
    readonly first_name?: string | null;
    readonly last_name?: string | null;
    readonly dob?: { day?: number | null; month?: number | null; year?: number | null } | null;
    readonly address?: StripeAddress | null;
  } | null;
  readonly company?: {
    readonly name?: string | null;
    readonly address?: StripeAddress | null;
  } | null;
}
interface StripeAddress {
  readonly line1?: string | null;
  readonly line2?: string | null;
  readonly postal_code?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
}

/** Puro (lo fijan los tests con la respuesta real del sandbox). */
export function identityFromStripe(
  raw: StripeIdentity,
  fallbackCountry: string,
  fallbackEntity: string,
): NonNullable<TaxProfileView['prefill']> {
  const entityType: TaxEntityType =
    (raw.business_type ?? fallbackEntity) === 'company' ? 'company' : 'individual';
  const country = (raw.country ?? fallbackCountry ?? '').toUpperCase() || null;
  const fromAddress = (a: StripeAddress | null | undefined): TaxAddress | null =>
    a && (a.line1 || a.city || a.postal_code)
      ? {
          line1: a.line1 ?? '',
          line2: a.line2 ?? null,
          postalCode: a.postal_code ?? '',
          city: a.city ?? '',
          region: a.state ?? null,
        }
      : null;
  if (entityType === 'company') {
    return {
      entityType,
      legalName: raw.company?.name?.trim() || null,
      country,
      address: fromAddress(raw.company?.address),
      birthDate: null,
    };
  }
  const name = [raw.individual?.first_name, raw.individual?.last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ');
  const dob = raw.individual?.dob;
  const birthDate =
    dob?.year && dob.month && dob.day
      ? `${String(dob.year).padStart(4, '0')}-${String(dob.month).padStart(2, '0')}-${String(dob.day).padStart(2, '0')}`
      : null;
  return {
    entityType,
    legalName: name || null,
    country,
    address: fromAddress(raw.individual?.address),
    birthDate,
  };
}

/** Qué falta para la factura y DAC7. Puro. */
export function missingFields(p: {
  readonly entityType: TaxEntityType | null;
  readonly legalName: string;
  readonly country: string;
  readonly taxId: string | null;
  readonly vatId: string | null;
  readonly address: TaxAddress | null;
  readonly birthDate: string | null;
}): TaxField[] {
  const out: TaxField[] = [];
  if (p.entityType !== 'individual' && p.entityType !== 'company') out.push('entityType');
  if (!p.legalName || p.legalName.trim().length < 2) out.push('legalName');
  if (!/^[A-Z]{2}$/.test(p.country ?? '')) out.push('country');
  if (!p.taxId) out.push('taxId');
  if (!p.address?.line1?.trim()) out.push('address.line1');
  if (!p.address?.postalCode?.trim()) out.push('address.postalCode');
  if (!p.address?.city?.trim()) out.push('address.city');
  if (p.entityType === 'individual' && !p.birthDate) out.push('birthDate');
  return out;
}

function normalizeAddress(a: TaxAddress | null | undefined): TaxAddress {
  const clean = (v: string | null | undefined, max: number) =>
    (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return {
    line1: clean(a?.line1, 200),
    line2: clean(a?.line2, 200) || null,
    postalCode: clean(a?.postalCode, 20).toUpperCase(),
    city: clean(a?.city, 120),
    region: clean(a?.region, 120) || null,
  };
}

/** `AAAA-MM-DD` real, en el pasado y de alguien mayor de edad. */
export function checkBirthDate(
  raw: string | null,
  now: Date,
): { ok: true; value: string } | { ok: false; reason: 'required' | 'invalid' | 'underage' } {
  if (!raw?.trim()) return { ok: false, reason: 'required' };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return { ok: false, reason: 'invalid' };
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return { ok: false, reason: 'invalid' };
  }
  if (y < 1900 || date.getTime() > now.getTime()) return { ok: false, reason: 'invalid' };
  const adult = new Date(Date.UTC(y + 18, m - 1, d));
  if (adult.getTime() > now.getTime()) return { ok: false, reason: 'underage' };
  return { ok: true, value: match[0] };
}

/** Las ventas retenidas por faltar estos datos vuelven a la cola YA. */
async function releaseHeld(tx: PayoutsTx, tenantId: string, now: Date): Promise<number> {
  const { count } = await tx.modPayoutsSale.updateMany({
    where: {
      tenantId,
      status: 'HELD',
      stripeTransferId: null,
      lastError: { startsWith: `${TAX_PROFILE_HOLD_REASON}:` },
    },
    data: { nextAttemptAt: now },
  });
  return count;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
