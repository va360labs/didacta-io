/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Prisma } from '@didacta/database';
import type { PayoutsDbPort, PayoutsLogger } from '../accounts.service.js';
import { PayoutsInvoiceNotFoundError } from '../errors.js';
import { isEuVatCountry } from '../tax/tax-ids.js';
import type {
  PayoutsCipher,
  PayoutsTaxProfileService,
  TaxAddress,
  TaxProfileFull,
} from '../tax/tax-profile.service.js';
import { renderInvoicePdf, type InvoicePdfItem } from './invoice-pdf.js';
import { madridDate, madridToday, monthPeriod, type MonthKey } from './periods.js';
import {
  regimeMention,
  spanishSpecialTerritory,
  splitVatIncluded,
  vatRateBpsFor,
  vatRegimeFor,
  type VatRegime,
} from './vat.js';

/**
 * Factura mensual de la comisión del operador al creador.
 *
 * Cada mes, por creador (aula) y moneda, UNA factura con la comisión de las
 * ventas del mes (asientos `PLATFORM_FEE` del libro) menos lo devuelto por
 * reembolsos de esas mismas ventas (`PLATFORM_FEE_REFUND`). La comisión lleva
 * el IVA INCLUIDO: se desglosa según dónde está el creador (`vat.ts`).
 *
 * Reglas que no se negocian:
 *
 *  1. **Cada asiento se factura una sola vez.** Una línea guarda el asiento
 *     que consume (`consumes_ledger_entry_id`, único): dos procesos a la vez
 *     no pueden facturar lo mismo (el segundo choca y se descarta entero).
 *  2. **Una factura por mes, aula y moneda.** El hueco (`slot`) es único por
 *     aula: repetir el proceso no duplica. Lo que se selle tarde (una venta
 *     del día 31 que Stripe confirma el 1) entra en la factura del mes
 *     siguiente: el proceso coge todo lo no facturado hasta el fin del mes.
 *  3. **Numeración correlativa sin huecos.** El número sale de un contador por
 *     serie que se avanza en la MISMA transacción que inserta la factura: si
 *     algo falla (el PDF, una carrera), se deshace todo y el número no se gasta.
 *     El cerrojo de la fila del contador ordena a los emisores concurrentes.
 *  4. **Inmutable.** Un trigger de `rls.sql` impide cambiar o borrar una
 *     factura emitida. Las correcciones son rectificativas, con su serie:
 *       - devoluciones de comisión de ventas YA facturadas en un mes anterior
 *         (reembolsos que cruzan meses) → una rectificativa por mes y moneda
 *         que enumera las facturas que rectifica (RD 1619/2012, art. 15.4);
 *       - una factura emitida con datos del destinatario incompletos, o con
 *         IVA español a un empresario de la UE cuyo NIF-IVA se valida después,
 *         se SUSTITUYE por una rectificativa con los datos buenos (art. 15.1).
 *  5. **Sin datos fiscales, la factura sale igual.** El IVA se devenga con la
 *     venta (art. 75 LIVA) y la factura a un empresario se expide antes del
 *     día 16 del mes siguiente (art. 11 RD 1619/2012): esperar a que el
 *     creador complete sus datos incumpliría el plazo. Sale con lo que hay
 *     («pendientes de completar») y, al completarlos, se sustituye.
 *  6. **NIF-IVA pendiente de VIES.** Si VIES no responde, se reintenta cada día
 *     hasta el día `vatPendingGraceDay` (10 por defecto); pasado, se factura
 *     con IVA español (prudente) y se sustituye si luego se valida.
 */

export interface InvoiceIssuer {
  readonly name: string;
  readonly taxId: string;
  readonly vatId: string | null;
  readonly address: TaxAddress;
  readonly country: string;
  readonly email: string | null;
}

export interface InvoicingConfig {
  readonly issuer: InvoiceIssuer;
  /** Prefijo de la serie: `DC` → `DC-2026-000001` y `DCR-2026-000001`. */
  readonly seriesPrefix: string;
  /** «Didacta Cloud». */
  readonly serviceName: string;
  readonly livemode: boolean;
}

export interface InvoicesServiceOptions {
  readonly now?: () => Date;
  readonly logger?: PayoutsLogger;
  /** Último día del mes siguiente en que se espera a VIES antes de facturar con IVA. */
  readonly vatPendingGraceDay?: number;
  /** Nombre del aula si el creador aún no ha dado su nombre fiscal. */
  readonly fallbackName?: (tenantId: string) => Promise<string | null>;
  /** Solo tests: se llama tras reservar el número y antes de confirmar. */
  readonly beforeCommit?: (fullNumber: string) => Promise<void> | void;
}

export type IssueOutcome =
  | {
      readonly outcome: 'issued';
      readonly invoiceId: string;
      readonly fullNumber: string;
      readonly currency: string;
      readonly kind: 'ORDINARY' | 'RECTIFYING';
    }
  | { readonly outcome: 'nothing'; readonly currency?: string }
  | { readonly outcome: 'already_issued'; readonly currency: string; readonly slot: string }
  | { readonly outcome: 'postponed'; readonly reason: 'vat_pending' }
  | { readonly outcome: 'skipped'; readonly currency: string; readonly reason: 'vat_needs_eur' }
  | { readonly outcome: 'busy'; readonly currency: string; readonly slot: string };

export interface InvoiceRunReport {
  readonly month: MonthKey;
  readonly tenants: number;
  readonly issued: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly errors: number;
  readonly invoiceIds: readonly string[];
}

/** Lo que ve el creador en «Tus facturas». Sin NIF ni dirección. */
export interface InvoiceView {
  readonly id: string;
  readonly kind: 'ORDINARY' | 'RECTIFYING';
  readonly fullNumber: string;
  readonly issueDate: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: string;
  readonly regime: VatRegime;
  readonly vatRateBps: number;
  readonly total: number;
  readonly taxBase: number;
  readonly vatAmount: number;
  readonly recipientComplete: boolean;
  readonly rectifies: ReadonlyArray<{ readonly fullNumber: string; readonly issueDate: string }>;
  readonly replacedBy: string | null;
  readonly items: number;
  readonly emailedAt: string | null;
  readonly livemode: boolean;
}

/** Contenido del bloque cifrado de una factura. */
interface InvoiceDocument {
  readonly recipient: { taxId: string | null; vatId: string | null; address: TaxAddress | null };
  readonly pdf: string;
}

type LedgerRow = {
  id: string;
  accountId: string;
  saleId: string | null;
  type: string;
  amount: number;
  currency: string;
  occurredAt: Date;
};

interface DraftItem {
  readonly ledgerEntryId: string;
  readonly consumes: boolean;
  readonly saleId: string | null;
  readonly type: 'COMMISSION' | 'COMMISSION_REFUND';
  readonly occurredAt: Date;
  readonly description: string | null;
  readonly saleGross: number | null;
  readonly amount: number;
  readonly originalInvoiceId: string | null;
  readonly originalInvoiceNumber: string | null;
  readonly originalInvoiceIssueDate: string | null;
}

interface Recipient {
  readonly legalName: string;
  readonly country: string;
  readonly entityType: string;
  readonly complete: boolean;
  readonly taxId: string | null;
  readonly vatId: string | null;
  readonly address: TaxAddress | null;
  readonly vatStatus: TaxProfileFull['vatStatus'];
}

const SILENT: PayoutsLogger = { warn: () => undefined };

export class PayoutsInvoicesService {
  private readonly now: () => Date;
  private readonly logger: PayoutsLogger;
  private readonly graceDay: number;

  constructor(
    private readonly db: PayoutsDbPort,
    private readonly cipher: PayoutsCipher,
    private readonly taxProfiles: Pick<PayoutsTaxProfileService, 'full' | 'refreshVat'>,
    readonly config: InvoicingConfig,
    private readonly options: InvoicesServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? SILENT;
    this.graceDay = options.vatPendingGraceDay ?? 10;
  }

  // ── Proceso mensual ────────────────────────────────────────────────────

  /**
   * Factura un mes: a todas las aulas con comisiones sin facturar hasta el
   * fin de ese mes (o solo a `tenantId`). Idempotente. Un fallo con un aula no
   * para las demás.
   */
  async runMonth(
    month: MonthKey,
    options: { readonly tenantId?: string } = {},
  ): Promise<InvoiceRunReport> {
    const period = monthPeriod(month);
    const tenants = options.tenantId
      ? [options.tenantId]
      : await this.db.global(async (tx) => {
          const rows = await tx.$queryRaw<Array<{ tenant_id: string }>>`
            SELECT DISTINCT e.tenant_id::text AS tenant_id
              FROM mod_payouts_ledger_entry e
             WHERE e.type IN ('PLATFORM_FEE', 'PLATFORM_FEE_REFUND')
               AND e.occurred_at < ${period.end}
               AND NOT EXISTS (
                 SELECT 1 FROM mod_payouts_invoice_item i WHERE i.consumes_ledger_entry_id = e.id
               )
            UNION
            SELECT DISTINCT f.tenant_id::text AS tenant_id
              FROM mod_payouts_invoice f
             WHERE f.replaced_by_id IS NULL
               AND (f.recipient_complete = false OR f.regime = 'ES_VAT_EU_NO_VAT_ID')`;
          return rows.map((r) => r.tenant_id);
        });
    const outcomes: Record<string, number> = {};
    const invoiceIds: string[] = [];
    let errors = 0;
    for (const tenantId of tenants) {
      try {
        for (const result of await this.issueForTenant(tenantId, month)) {
          outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
          if (result.outcome === 'issued') invoiceIds.push(result.invoiceId);
        }
        for (const result of await this.issueSubstitutions(tenantId)) {
          outcomes[`substitution_${result.outcome}`] =
            (outcomes[`substitution_${result.outcome}`] ?? 0) + 1;
          if (result.outcome === 'issued') invoiceIds.push(result.invoiceId);
        }
      } catch (err) {
        errors += 1;
        this.logger.error?.(
          { alert: 'payouts.invoice_failed', tenantId, month, err: (err as Error).message },
          'payouts.invoice_failed: no se pudo facturar un aula (se reintenta en la próxima pasada)',
        );
      }
    }
    return {
      month,
      tenants: tenants.length,
      issued: invoiceIds.length,
      outcomes,
      errors,
      invoiceIds,
    };
  }

  /**
   * Solo las sustituciones (datos completados o NIF-IVA validado), para todas
   * las aulas que tienen alguna factura pendiente de sustituir. Es lo que hace
   * el proceso diario fuera del plazo de emisión del mes.
   */
  async runSubstitutions(): Promise<{ readonly issued: number; readonly invoiceIds: string[] }> {
    const tenants = await this.db.global(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ tenant_id: string }>>`
        SELECT DISTINCT tenant_id::text AS tenant_id
          FROM mod_payouts_invoice
         WHERE replaced_by_id IS NULL
           AND (recipient_complete = false OR regime = 'ES_VAT_EU_NO_VAT_ID')`;
      return rows.map((r) => r.tenant_id);
    });
    const invoiceIds: string[] = [];
    for (const tenantId of tenants) {
      try {
        for (const result of await this.issueSubstitutions(tenantId)) {
          if (result.outcome === 'issued') invoiceIds.push(result.invoiceId);
        }
      } catch (err) {
        this.logger.error?.(
          { alert: 'payouts.invoice_failed', tenantId, err: (err as Error).message },
          'payouts.invoice_failed: no se pudo sustituir una factura (se reintenta mañana)',
        );
      }
    }
    return { issued: invoiceIds.length, invoiceIds };
  }

  /**
   * La factura del mes (y la rectificativa por devoluciones, si toca) de un
   * aula, una por moneda.
   */
  async issueForTenant(tenantId: string, month: MonthKey): Promise<IssueOutcome[]> {
    const period = monthPeriod(month);
    let recipient = await this.recipient(tenantId);
    // NIF-IVA de la UE aún sin comprobar: se reintenta VIES y, mientras quede
    // margen hasta el plazo, se espera.
    if (
      recipient.vatId &&
      recipient.country !== 'ES' &&
      isEuVatCountry(recipient.country) &&
      recipient.vatStatus === 'pending'
    ) {
      await this.taxProfiles.refreshVat(tenantId, { force: true });
      recipient = await this.recipient(tenantId);
      if (recipient.vatStatus === 'pending' && madridDate(this.now()).day < this.graceDay) {
        return [{ outcome: 'postponed', reason: 'vat_pending' }];
      }
    }

    const entries = await this.db.inTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<LedgerRow[]>`
        SELECT e.id::text AS id, e.account_id::text AS "accountId", e.sale_id::text AS "saleId",
               e.type::text AS type, e.amount, e.currency, e.occurred_at AS "occurredAt"
          FROM mod_payouts_ledger_entry e
         WHERE e.tenant_id = ${tenantId}::uuid
           AND e.type IN ('PLATFORM_FEE', 'PLATFORM_FEE_REFUND')
           AND e.occurred_at < ${period.end}
           AND NOT EXISTS (
             SELECT 1 FROM mod_payouts_invoice_item i WHERE i.consumes_ledger_entry_id = e.id
           )
         ORDER BY e.occurred_at ASC, e.id ASC`,
    );
    if (entries.length === 0) return [{ outcome: 'nothing' }];

    const byCurrency = new Map<string, LedgerRow[]>();
    for (const entry of entries) {
      const list = byCurrency.get(entry.currency) ?? [];
      list.push(entry);
      byCurrency.set(entry.currency, list);
    }

    const results: IssueOutcome[] = [];
    for (const [currency, list] of [...byCurrency.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const { ordinary, refunds } = await this.classify(tenantId, list);
      if (ordinary.length > 0) {
        results.push(
          await this.issue(tenantId, {
            kind: 'ORDINARY',
            slot: `ord:${month}:${currency}`,
            currency,
            period,
            items: ordinary,
            recipient,
            accountId: lastAccount(list),
            rectifies: [],
            reason: null,
          }),
        );
      }
      if (refunds.length > 0) {
        const originals = uniqueOriginals(refunds);
        results.push(
          await this.issue(tenantId, {
            kind: 'RECTIFYING',
            slot: `ref:${month}:${currency}`,
            currency,
            period,
            items: refunds,
            recipient,
            accountId: lastAccount(list),
            rectifies: originals,
            reason:
              'Devolución de la comisión por reembolsos (o reclamaciones) de ventas ya facturadas.',
          }),
        );
      }
    }
    return results;
  }

  /**
   * Sustituye por una rectificativa cada factura emitida con datos del
   * destinatario incompletos (si ya están completos) o con IVA español a un
   * empresario de la UE cuyo NIF-IVA ya es válido.
   */
  async issueSubstitutions(tenantId: string): Promise<IssueOutcome[]> {
    const recipient = await this.recipient(tenantId);
    if (!recipient.complete) return [];
    const candidates = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsInvoice.findMany({
        where: {
          tenantId,
          replacedById: null,
          OR: [
            { recipientComplete: false },
            ...(recipient.vatStatus === 'valid'
              ? [{ regime: 'ES_VAT_EU_NO_VAT_ID' as const }]
              : []),
          ],
        },
        include: { items: true },
        orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
      }),
    );
    const results: IssueOutcome[] = [];
    for (const original of candidates) {
      const reason = !original.recipientComplete
        ? 'Sustituye íntegramente a la factura rectificada: se completan los datos del destinatario.'
        : 'Sustituye íntegramente a la factura rectificada: el destinatario acredita un NIF-IVA válido en VIES (inversión del sujeto pasivo).';
      results.push(
        await this.issue(tenantId, {
          kind: 'RECTIFYING',
          slot: `sub:${original.id}`,
          currency: original.currency,
          period: {
            firstDay: original.periodStart,
            lastDay: original.periodEnd,
          },
          items: original.items.map((item) => ({
            ledgerEntryId: item.ledgerEntryId,
            consumes: false,
            saleId: item.saleId,
            type: item.type as DraftItem['type'],
            occurredAt: item.occurredAt,
            description: item.description,
            saleGross: item.saleGross,
            amount: item.amount,
            originalInvoiceId: item.originalInvoiceId,
            originalInvoiceNumber: null,
            originalInvoiceIssueDate: null,
          })),
          recipient,
          accountId: original.accountId,
          rectifies: [
            {
              id: original.id,
              fullNumber: original.fullNumber,
              issueDate: isoDay(original.issueDate),
            },
          ],
          reason,
          replaces: original.id,
        }),
      );
    }
    return results;
  }

  // ── Consulta ───────────────────────────────────────────────────────────

  async list(tenantId: string): Promise<InvoiceView[]> {
    const rows = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsInvoice.findMany({
        where: { tenantId },
        orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
        take: 240,
        include: { _count: { select: { items: true } } },
      }),
    );
    const numberById = new Map(rows.map((r) => [r.id, r.fullNumber]));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      fullNumber: row.fullNumber,
      issueDate: isoDay(row.issueDate),
      periodStart: isoDay(row.periodStart),
      periodEnd: isoDay(row.periodEnd),
      currency: row.currency,
      regime: row.regime,
      vatRateBps: row.vatRateBps,
      total: row.total,
      taxBase: row.taxBase,
      vatAmount: row.vatAmount,
      recipientComplete: row.recipientComplete,
      rectifies: (row.rectifies as Array<{ fullNumber: string; issueDate: string }>).map((r) => ({
        fullNumber: r.fullNumber,
        issueDate: r.issueDate,
      })),
      replacedBy: row.replacedById ? (numberById.get(row.replacedById) ?? null) : null,
      items: row._count.items,
      emailedAt: row.emailedAt?.toISOString() ?? null,
      livemode: row.livemode,
    }));
  }

  /** El PDF tal como se emitió. 404 si no es de esta aula. */
  async pdf(tenantId: string, invoiceId: string): Promise<{ fileName: string; pdf: Buffer }> {
    if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) throw new PayoutsInvoiceNotFoundError();
    const row = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsInvoice.findFirst({ where: { id: invoiceId, tenantId } }),
    );
    if (!row) throw new PayoutsInvoiceNotFoundError();
    const document = this.decryptDocument(row);
    return { fileName: `${row.fullNumber}.pdf`, pdf: Buffer.from(document.pdf, 'base64') };
  }

  /** Facturas emitidas cuyo correo aún no salió (acceso global sancionado). */
  async pendingEmails(limit = 50): Promise<Array<{ id: string; tenantId: string }>> {
    return this.db.global((tx) =>
      tx.modPayoutsInvoice.findMany({
        where: { emailedAt: null, emailAttempts: { lt: 5 } },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: { id: true, tenantId: true },
      }),
    );
  }

  /** Datos para el correo de una factura (sin lo cifrado salvo el PDF). */
  async forEmail(
    tenantId: string,
    invoiceId: string,
  ): Promise<{ view: InvoiceView; fileName: string; pdf: Buffer } | null> {
    const views = await this.list(tenantId);
    const view = views.find((v) => v.id === invoiceId);
    if (!view) return null;
    const { fileName, pdf } = await this.pdf(tenantId, invoiceId);
    return { view, fileName, pdf };
  }

  async markEmailed(tenantId: string, invoiceId: string, ok: boolean): Promise<void> {
    await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsInvoice.updateMany({
        where: { id: invoiceId, tenantId, emailedAt: null },
        data: ok
          ? { emailedAt: this.now(), emailAttempts: { increment: 1 } }
          : { emailAttempts: { increment: 1 } },
      }),
    );
  }

  // ── Emisión ────────────────────────────────────────────────────────────

  /**
   * Separa las líneas de un aula y moneda: comisiones y devoluciones de
   * comisiones aún no facturadas van a la ordinaria; las devoluciones de
   * comisiones que YA se facturaron, a la rectificativa.
   */
  private async classify(
    tenantId: string,
    entries: readonly LedgerRow[],
  ): Promise<{ ordinary: DraftItem[]; refunds: DraftItem[] }> {
    const saleIds = [...new Set(entries.map((e) => e.saleId).filter((id): id is string => !!id))];
    const { sales, charged } = await this.db.inTenant(tenantId, async (tx) => ({
      sales: await tx.modPayoutsSale.findMany({
        where: { tenantId, id: { in: saleIds } },
        select: { id: true, description: true, gross: true, presentmentAmount: true },
      }),
      // Comisiones de esas ventas ya facturadas (la factura más reciente que
      // cobró comisión de cada venta).
      charged: await tx.modPayoutsInvoiceItem.findMany({
        where: {
          tenantId,
          saleId: { in: saleIds },
          type: 'COMMISSION',
          consumesLedgerEntryId: { not: null },
        },
        select: {
          saleId: true,
          invoiceId: true,
          invoice: { select: { fullNumber: true, issueDate: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    }));
    const saleById = new Map(sales.map((s) => [s.id, s]));
    const originalBySale = new Map<string, { id: string; fullNumber: string; issueDate: string }>();
    for (const item of charged) {
      if (item.saleId && !originalBySale.has(item.saleId)) {
        originalBySale.set(item.saleId, {
          id: item.invoiceId,
          fullNumber: item.invoice.fullNumber,
          issueDate: isoDay(item.invoice.issueDate),
        });
      }
    }
    const ordinary: DraftItem[] = [];
    const refunds: DraftItem[] = [];
    for (const entry of entries) {
      const sale = entry.saleId ? saleById.get(entry.saleId) : undefined;
      const base = {
        ledgerEntryId: entry.id,
        consumes: true,
        saleId: entry.saleId,
        occurredAt: entry.occurredAt,
        description: sale?.description ?? null,
        saleGross: sale?.gross ?? null,
        // El libro va desde el lado del creador: la comisión resta (−), su
        // devolución suma (+). En la factura, al revés.
        amount: -entry.amount,
      };
      if (entry.type === 'PLATFORM_FEE') {
        ordinary.push({
          ...base,
          type: 'COMMISSION',
          originalInvoiceId: null,
          originalInvoiceNumber: null,
          originalInvoiceIssueDate: null,
        });
        continue;
      }
      const original = entry.saleId ? originalBySale.get(entry.saleId) : undefined;
      if (original) {
        refunds.push({
          ...base,
          type: 'COMMISSION_REFUND',
          originalInvoiceId: original.id,
          originalInvoiceNumber: original.fullNumber,
          originalInvoiceIssueDate: original.issueDate,
        });
      } else {
        ordinary.push({
          ...base,
          type: 'COMMISSION_REFUND',
          originalInvoiceId: null,
          originalInvoiceNumber: null,
          originalInvoiceIssueDate: null,
        });
      }
    }
    return { ordinary, refunds };
  }

  private async issue(
    tenantId: string,
    draft: {
      kind: 'ORDINARY' | 'RECTIFYING';
      slot: string;
      currency: string;
      period: { firstDay: Date; lastDay: Date };
      items: DraftItem[];
      recipient: Recipient;
      accountId: string;
      rectifies: Array<{ id: string; fullNumber: string; issueDate: string }>;
      reason: string | null;
      replaces?: string;
    },
  ): Promise<IssueOutcome> {
    const regime = vatRegimeFor({
      country: draft.recipient.country,
      postalCode: draft.recipient.address?.postalCode ?? null,
      vatStatus: draft.recipient.vatStatus,
    });
    const vatRateBps = vatRateBpsFor(regime);
    if (vatRateBps > 0 && draft.currency !== 'eur') {
      // RD 1619/2012, art. 10.1: la cuota se expresa en euros. Un creador con
      // IVA español cobra en euros (cuenta de la zona euro); si no, se avisa.
      this.logger.error?.(
        { alert: 'payouts.invoice_needs_eur_rate', tenantId, currency: draft.currency, regime },
        'payouts.invoice_needs_eur_rate: factura con IVA en una moneda que no es el euro — no se emite',
      );
      return { outcome: 'skipped', currency: draft.currency, reason: 'vat_needs_eur' };
    }
    const total = draft.items.reduce((sum, item) => sum + item.amount, 0);
    const { taxBase, vatAmount } = splitVatIncluded(total, vatRateBps);
    const now = this.now();
    const issueDate = madridToday(now);
    const year = issueDate.getUTCFullYear();
    const prefix = `${this.config.seriesPrefix}${this.config.livemode ? '' : 'T'}`;
    const series = `${draft.kind === 'ORDINARY' ? prefix : `${prefix}R`}-${year}`;
    const territory =
      draft.recipient.country === 'ES'
        ? spanishSpecialTerritory(draft.recipient.address?.postalCode)
        : null;

    try {
      return await this.db.inTenant(tenantId, async (tx) => {
        const existing = await tx.modPayoutsInvoice.findFirst({
          where: { tenantId, slot: draft.slot },
          select: { id: true },
        });
        if (existing) {
          return { outcome: 'already_issued', currency: draft.currency, slot: draft.slot } as const;
        }
        const counter = await tx.$queryRaw<Array<{ last_number: number }>>`
          INSERT INTO mod_payouts_invoice_counter (series, last_number, updated_at)
          VALUES (${series}, 1, now())
          ON CONFLICT (series) DO UPDATE
            SET last_number = mod_payouts_invoice_counter.last_number + 1, updated_at = now()
          RETURNING last_number`;
        const number = Number(counter[0]!.last_number);
        const fullNumber = `${series}-${String(number).padStart(6, '0')}`;
        const pdf = await renderInvoicePdf({
          kind: draft.kind,
          fullNumber,
          issueDate,
          periodFirstDay: draft.period.firstDay,
          periodLastDay: draft.period.lastDay,
          currency: draft.currency,
          regime,
          vatRateBps,
          total,
          taxBase,
          vatAmount,
          issuer: {
            name: this.config.issuer.name,
            taxId: this.config.issuer.taxId,
            vatId: this.config.issuer.vatId,
            address: this.config.issuer.address,
            country: this.config.issuer.country,
            email: this.config.issuer.email,
          },
          recipient: {
            name: draft.recipient.legalName,
            taxId: draft.recipient.taxId,
            vatId: draft.recipient.vatId,
            address: draft.recipient.address,
            country: draft.recipient.country,
            complete: draft.recipient.complete,
          },
          serviceName: this.config.serviceName,
          items: draft.items.map(
            (item): InvoicePdfItem => ({
              date: item.occurredAt,
              // El rótulo («Devolución de comisión», «Venta») lo pone el PDF en
              // los idiomas de la factura.
              description: item.description ?? null,
              commissionRefund: item.type === 'COMMISSION_REFUND',
              saleGross: item.saleGross,
              amount: item.amount,
              originalInvoice: item.originalInvoiceNumber,
            }),
          ),
          rectifies: draft.rectifies,
          rectificationReason: draft.reason,
          mention: regimeMention(regime, territory),
          livemode: this.config.livemode,
        });
        const document: InvoiceDocument = {
          recipient: {
            taxId: draft.recipient.taxId,
            vatId: draft.recipient.vatId,
            address: draft.recipient.address,
          },
          pdf: pdf.toString('base64'),
        };
        const encrypted = this.cipher.encrypt(JSON.stringify(document));
        const invoice = await tx.modPayoutsInvoice.create({
          data: {
            tenantId,
            accountId: draft.accountId,
            kind: draft.kind,
            series,
            number,
            fullNumber,
            slot: draft.slot,
            issueDate,
            periodStart: draft.period.firstDay,
            periodEnd: draft.period.lastDay,
            currency: draft.currency,
            regime,
            vatRateBps,
            total,
            taxBase,
            vatAmount,
            issuer: JSON.parse(JSON.stringify(this.config.issuer)) as Prisma.InputJsonObject,
            recipientLegalName: draft.recipient.legalName,
            recipientCountry: draft.recipient.country,
            recipientEntityType: draft.recipient.entityType,
            recipientComplete: draft.recipient.complete,
            rectifies: draft.rectifies,
            rectificationReason: draft.reason,
            documentCipher: encrypted.cipher,
            documentIv: encrypted.iv,
            documentTag: encrypted.tag,
            livemode: this.config.livemode,
          },
          select: { id: true },
        });
        await tx.modPayoutsInvoiceItem.createMany({
          data: draft.items.map((item) => ({
            tenantId,
            invoiceId: invoice.id,
            saleId: item.saleId,
            ledgerEntryId: item.ledgerEntryId,
            consumesLedgerEntryId: item.consumes ? item.ledgerEntryId : null,
            type: item.type,
            occurredAt: item.occurredAt,
            description: item.description,
            saleGross: item.saleGross,
            amount: item.amount,
            originalInvoiceId: item.originalInvoiceId,
          })),
        });
        if (draft.replaces) {
          const { count } = await tx.modPayoutsInvoice.updateMany({
            where: { id: draft.replaces, tenantId, replacedById: null },
            data: { replacedById: invoice.id },
          });
          if (count !== 1) throw new Error(`la factura ${draft.replaces} ya estaba sustituida`);
        }
        await this.options.beforeCommit?.(fullNumber);
        this.logger.log?.(
          {
            tenantId,
            fullNumber,
            total,
            currency: draft.currency,
            regime,
            items: draft.items.length,
          },
          'payouts.invoice: factura emitida',
        );
        return {
          outcome: 'issued',
          invoiceId: invoice.id,
          fullNumber,
          currency: draft.currency,
          kind: draft.kind,
        } as const;
      });
    } catch (err) {
      // Otro proceso facturó lo mismo a la vez (hueco o asiento ya usados): esta
      // transacción se deshizo entera, sin gastar número.
      if (isUniqueViolation(err)) {
        return { outcome: 'busy', currency: draft.currency, slot: draft.slot };
      }
      throw err;
    }
  }

  private async recipient(tenantId: string): Promise<Recipient> {
    const profile = await this.taxProfiles.full(tenantId);
    if (profile) {
      return {
        legalName: profile.legalName,
        country: profile.country,
        entityType: profile.entityType,
        complete: profile.complete,
        taxId: profile.taxId,
        vatId: profile.vatId,
        address: profile.address,
        vatStatus: profile.vatStatus,
      };
    }
    const account = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsAccount.findFirst({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        select: { country: true, entityType: true },
      }),
    );
    const name = (await this.options.fallbackName?.(tenantId)) ?? null;
    return {
      legalName: name?.trim() || 'Creador',
      country: account?.country ?? 'ES',
      entityType: account?.entityType ?? 'individual',
      complete: false,
      taxId: null,
      vatId: null,
      address: null,
      vatStatus: 'not_applicable',
    };
  }

  private decryptDocument(row: {
    documentCipher: Uint8Array;
    documentIv: Uint8Array;
    documentTag: Uint8Array;
  }): InvoiceDocument {
    return JSON.parse(
      this.cipher.decrypt({
        cipher: Buffer.from(row.documentCipher),
        iv: Buffer.from(row.documentIv),
        tag: Buffer.from(row.documentTag),
      }),
    ) as InvoiceDocument;
  }
}

function lastAccount(entries: readonly LedgerRow[]): string {
  return entries[entries.length - 1]!.accountId;
}

function uniqueOriginals(
  items: readonly DraftItem[],
): Array<{ id: string; fullNumber: string; issueDate: string }> {
  const seen = new Map<string, { id: string; fullNumber: string; issueDate: string }>();
  for (const item of items) {
    if (item.originalInvoiceId && item.originalInvoiceNumber && !seen.has(item.originalInvoiceId)) {
      seen.set(item.originalInvoiceId, {
        id: item.originalInvoiceId,
        fullNumber: item.originalInvoiceNumber,
        issueDate: item.originalInvoiceIssueDate ?? '',
      });
    }
  }
  return [...seen.values()];
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 'P2002') return true;
  // `$queryRaw` dentro de la transacción: el error de Postgres viene envuelto.
  const message = (err as Error)?.message ?? '';
  return /23505|unique constraint/i.test(message);
}
