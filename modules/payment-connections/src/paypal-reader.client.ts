/**
 * Lector de SOLO LECTURA de PayPal para mod.payment-connections.
 *
 * PayPal NO tiene un endpoint para listar todas las suscripciones de una cuenta
 * (confirmado). La vía es la Transaction Search API: se escanean las
 * transacciones por ventanas de fecha (≤31 días, hasta 3 años atrás) y se filtran
 * los pagos recurrentes (paypal_reference_id_type ∈ {SUB,PAP} o event code
 * T0002/T0003), deduplicando por el id de suscripción/acuerdo.
 *
 * Implementa el mismo contrato de lectura (`StripeReadAdapter`) que el lector de
 * Stripe, así el resto del módulo (reconcile/sync) es agnóstico del proveedor.
 * El permiso "Transaction Search" debe estar habilitado en la REST app de PayPal.
 */

import { StripeReadApiError, StripeReadKeyInvalidError } from './errors.js';
import type {
  ListActiveSubscriptionsOptions,
  StripeAccountInfo,
  StripeReadAdapter,
  StripeSubscriberRecord,
  StripeSubscriptionsResult,
} from './stripe-reader.client.js';

export interface PayPalReaderCredentials {
  clientId: string;
  clientSecret: string;
  environment: 'sandbox' | 'live';
}

type FetchFn = typeof fetch;

const RECURRING_REF_TYPES = new Set(['SUB', 'PAP']);
const RECURRING_EVENT_CODES = new Set(['T0002', 'T0003']);
const WINDOW_DAYS = 31;
/** Cubre suscripciones activas (anuales + mensuales) sin escanear los 3 años completos. */
const DEFAULT_LOOKBACK_MONTHS = 13;
/** Los datos tardan ~3h en aparecer en Transaction Search. */
const LATENCY_MS = 3 * 60 * 60 * 1000;
const PAGE_SIZE = 500;
/** Aborta cada request a los 10s (como Stripe) para que el job de fondo nunca cuelgue. */
const REQUEST_TIMEOUT_MS = 10_000;

export class PayPalReadSdkAdapter implements StripeReadAdapter {
  private readonly base: string;

  constructor(
    private readonly creds: PayPalReaderCredentials,
    private readonly fetchFn: FetchFn = fetch,
    private readonly lookbackMonths: number = DEFAULT_LOOKBACK_MONTHS,
  ) {
    if (!creds.clientId || !creds.clientSecret) {
      throw new StripeReadKeyInvalidError('faltan clientId/clientSecret de PayPal');
    }
    this.base =
      creds.environment === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
  }

  async retrieveAccount(): Promise<StripeAccountInfo> {
    // Obtener el token valida las credenciales. PayPal no expone email/nombre de
    // la cuenta vía client_credentials, así que usamos el app_id como id.
    const tok = await this.getToken();
    return {
      id: tok.appId ?? `paypal:${this.creds.environment}`,
      email: null,
      country: null,
      businessName: null,
    };
  }

  async listActiveSubscriptions(
    options?: ListActiveSubscriptionsOptions,
  ): Promise<StripeSubscriptionsResult> {
    const token = (await this.getToken()).value;
    const maxPages = options?.maxPages && options.maxPages > 0 ? options.maxPages : 50;
    const byKey = new Map<string, StripeSubscriberRecord>();
    let truncated = false;
    let pagesUsed = 0;

    const end = new Date(Date.now() - LATENCY_MS);
    const start = new Date(end);
    start.setMonth(start.getMonth() - this.lookbackMonths);

    try {
      // Ventanas de ≤31 días, de la más reciente a la más antigua.
      let winEnd = new Date(end);
      while (winEnd > start) {
        const winStart = new Date(winEnd);
        winStart.setDate(winStart.getDate() - WINDOW_DAYS);
        const from = winStart < start ? start : winStart;

        let page = 1;
        for (;;) {
          const url = new URL(`${this.base}/v1/reporting/transactions`);
          url.searchParams.set('start_date', isoSec(from));
          url.searchParams.set('end_date', isoSec(winEnd));
          url.searchParams.set('fields', 'transaction_info,payer_info');
          url.searchParams.set('page_size', String(PAGE_SIZE));
          url.searchParams.set('page', String(page));

          const resp = await this.fetchWithTimeout(url.toString(), {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (resp.status === 401 || resp.status === 403) {
            throw new StripeReadKeyInvalidError(
              `PayPal reporting ${resp.status} (¿falta el permiso "Transaction Search" en la app?)`,
            );
          }
          if (!resp.ok) {
            throw new StripeReadApiError(`PayPal reporting devolvió ${resp.status}`);
          }
          const json = (await resp.json()) as PayPalTxnResponse;
          for (const tx of json.transaction_details ?? []) {
            const rec = mapTxn(tx);
            if (!rec) continue;
            const key = rec.subscriptionId || rec.email;
            if (!key) continue;
            const prev = byKey.get(key);
            if (!prev || rec.created > prev.created) byKey.set(key, rec);
          }
          pagesUsed += 1;
          const totalPages = json.total_pages ?? 1;
          if (page >= totalPages) break;
          if (pagesUsed >= maxPages) {
            truncated = true;
            break;
          }
          page += 1;
        }
        if (truncated) break;
        // Siguiente ventana, 1s antes del inicio de ésta.
        winEnd = new Date(from.getTime() - 1000);
      }
    } catch (err) {
      if (err instanceof StripeReadKeyInvalidError || err instanceof StripeReadApiError) throw err;
      throw new StripeReadApiError((err as Error).message ?? 'error');
    }

    return { subscribers: [...byKey.values()], truncated };
  }

  async findSubscriptionsByEmail(email: string): Promise<StripeSubscriberRecord[]> {
    // PayPal no permite filtrar por email; escaneamos (Transaction Search) y
    // filtramos por el email del pagador.
    const target = email.trim().toLowerCase();
    const { subscribers } = await this.listActiveSubscriptions();
    return subscribers.filter((s) => (s.email ?? '').trim().toLowerCase() === target);
  }

  /** Igual que `fetchFn` pero con AbortSignal de 10s: PayPal no se cuelga el job. */
  private fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    return this.fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  private async getToken(): Promise<{ value: string; appId: string | null }> {
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString(
      'base64',
    );
    const resp = await this.fetchWithTimeout(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new StripeReadKeyInvalidError('credenciales de PayPal inválidas');
    }
    if (!resp.ok) {
      throw new StripeReadApiError(`PayPal token endpoint devolvió ${resp.status}`);
    }
    const json = (await resp.json()) as { access_token?: string; app_id?: string };
    if (!json.access_token) {
      throw new StripeReadKeyInvalidError('PayPal no devolvió access_token');
    }
    return { value: json.access_token, appId: json.app_id ?? null };
  }
}

interface PayPalTxnResponse {
  transaction_details?: PayPalTxn[];
  page?: number;
  total_items?: number;
  total_pages?: number;
}

interface PayPalTxn {
  transaction_info?: {
    transaction_id?: string;
    paypal_reference_id?: string;
    paypal_reference_id_type?: string;
    transaction_event_code?: string;
    transaction_initiation_date?: string;
    transaction_amount?: { currency_code?: string; value?: string };
  };
  payer_info?: {
    account_id?: string;
    email_address?: string;
    payer_name?: { given_name?: string; surname?: string; alternate_full_name?: string };
  };
}

function mapTxn(tx: PayPalTxn): StripeSubscriberRecord | null {
  const ti = tx.transaction_info ?? {};
  const pi = tx.payer_info ?? {};
  const refType = ti.paypal_reference_id_type;
  const eventCode = ti.transaction_event_code;
  const isRecurring =
    (!!refType && RECURRING_REF_TYPES.has(refType)) ||
    (!!eventCode && RECURRING_EVENT_CODES.has(eventCode));
  if (!isRecurring) return null;

  const joined = [pi.payer_name?.given_name, pi.payer_name?.surname]
    .filter(Boolean)
    .join(' ')
    .trim();
  const name = (pi.payer_name?.alternate_full_name ?? joined) || null;

  const amountStr = ti.transaction_amount?.value;
  const parsed = amountStr != null ? Math.round(parseFloat(amountStr) * 100) : null;
  const created = ti.transaction_initiation_date ? Date.parse(ti.transaction_initiation_date) : 0;

  return {
    subscriptionId: ti.paypal_reference_id ?? ti.transaction_id ?? '',
    status: 'active',
    customerId: pi.account_id ?? null,
    email: pi.email_address ?? null,
    name,
    priceId: null,
    productId: null,
    // Transaction Search NO trae el nombre del plan. Follow-up: resolverlo vía
    // Subscriptions API (GET /v1/billing/subscriptions/{id} → plan_id →
    // /v1/billing/plans/{plan_id}.name) si la app tiene ese permiso. Mientras
    // tanto, el aprobador ve el importe (unitAmount/currency) como desambiguador.
    productName: null,
    unitAmount: parsed != null && !Number.isNaN(parsed) ? parsed : null,
    currency: ti.transaction_amount?.currency_code ?? null,
    interval: null,
    currentPeriodEnd: null,
    created: Number.isFinite(created) ? created : 0,
  };
}

/** ISO8601 con segundos (sin milisegundos), formato que acepta Transaction Search. */
function isoSec(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
