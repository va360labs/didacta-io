/**
 * Lector de SOLO LECTURA de WooCommerce Subscriptions (WordPress) para
 * mod.payment-connections.
 *
 * Usa la WooCommerce REST API v3 + el endpoint del plugin WooCommerce
 * Subscriptions (`/wp-json/wc/v3/subscriptions`). Auth: Basic (consumer key /
 * secret) sobre HTTPS. Implementa el mismo contrato (`StripeReadAdapter`) que
 * los lectores de Stripe/PayPal, así reconcile/sync/lookup son agnósticos del
 * proveedor. El "tier" = `line_items[0].name` (nombre del producto suscrito).
 *
 * Requiere el plugin WooCommerce Subscriptions (si no, /subscriptions → 404) y
 * HTTPS (Basic Auth sin TLS no es seguro y WC usaría OAuth1).
 */

import { StripeReadApiError, StripeReadKeyInvalidError } from './errors.js';
import type {
  ListActiveSubscriptionsOptions,
  StripeAccountInfo,
  StripeReadAdapter,
  StripeSubscriberRecord,
  StripeSubscriptionsResult,
} from './stripe-reader.client.js';

export interface WooCommerceReaderCredentials {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

type FetchFn = typeof fetch;

/** Estados WooCommerce que cuentan como "suscrito" hoy. */
const WC_ACTIVE_STATUSES = ['active', 'on-hold'];
/**
 * Estados consultados en el lookup de inscripción (no solo los vigentes): incluye
 * bajas e impagos para poder mostrarle al aprobador el estado real en lugar de
 * ocultar la suscripción. `on-hold`/`pending-cancel`/`cancelled`/`expired`/`pending`.
 */
const WC_LOOKUP_STATUSES = [
  'active',
  'on-hold',
  'pending-cancel',
  'cancelled',
  'expired',
  'pending',
];
const PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 50;
/** Aborta cada request a los 10s (como Stripe) para que el job de fondo nunca cuelgue. */
const REQUEST_TIMEOUT_MS = 10_000;

export class WooCommerceReadSdkAdapter implements StripeReadAdapter {
  private readonly base: string;
  private readonly authHeader: string;

  constructor(
    private readonly creds: WooCommerceReaderCredentials,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    if (!creds.storeUrl || !creds.consumerKey || !creds.consumerSecret) {
      throw new StripeReadKeyInvalidError(
        'faltan storeUrl/consumerKey/consumerSecret de WooCommerce',
      );
    }
    const url = creds.storeUrl.trim().replace(/\/+$/, '');
    if (!/^https:\/\//i.test(url)) {
      throw new StripeReadKeyInvalidError('la URL de la tienda WooCommerce debe ser https://');
    }
    this.base = `${url}/wp-json/wc/v3`;
    this.authHeader =
      'Basic ' + Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64');
  }

  async retrieveAccount(): Promise<StripeAccountInfo> {
    // system_status requiere permiso read → valida las credenciales (200 ok).
    const resp = await this.get('/system_status');
    if (resp.status === 401 || resp.status === 403) {
      throw new StripeReadKeyInvalidError(
        `WooCommerce ${resp.status} (claves inválidas o sin permiso read)`,
      );
    }
    if (!resp.ok) {
      throw new StripeReadApiError(`WooCommerce system_status devolvió ${resp.status}`);
    }
    const json = (await resp.json().catch(() => ({}))) as {
      settings?: { title?: string };
      environment?: { site_url?: string };
    };
    return {
      id: json.environment?.site_url ?? this.base,
      email: null,
      country: null,
      businessName: json.settings?.title ?? null,
    };
  }

  async listActiveSubscriptions(
    options?: ListActiveSubscriptionsOptions,
  ): Promise<StripeSubscriptionsResult> {
    const maxPages =
      options?.maxPages && options.maxPages > 0 ? options.maxPages : DEFAULT_MAX_PAGES;
    const byId = new Map<string, StripeSubscriberRecord>();
    let truncated = false;

    try {
      for (const status of WC_ACTIVE_STATUSES) {
        let page = 1;
        for (;;) {
          const resp = await this.get(
            `/subscriptions?status=${status}&per_page=${PER_PAGE}&page=${page}`,
          );
          if (resp.status === 404) {
            // El plugin WooCommerce Subscriptions no está instalado.
            throw new StripeReadApiError(
              'WooCommerce: el endpoint /subscriptions no existe (¿falta el plugin WooCommerce Subscriptions?)',
            );
          }
          if (resp.status === 401 || resp.status === 403) {
            throw new StripeReadKeyInvalidError(
              `WooCommerce ${resp.status} al listar suscripciones`,
            );
          }
          if (!resp.ok)
            throw new StripeReadApiError(`WooCommerce subscriptions devolvió ${resp.status}`);

          const rows = (await resp.json()) as WooSubscription[];
          for (const row of rows) {
            const rec = mapSubscription(row);
            if (!byId.has(rec.subscriptionId)) byId.set(rec.subscriptionId, rec);
          }
          const totalPages = Number(resp.headers.get('X-WP-TotalPages') ?? '1') || 1;
          if (page >= totalPages || rows.length === 0) break;
          if (page >= maxPages) {
            truncated = true;
            break;
          }
          page += 1;
        }
        if (truncated) break;
      }
    } catch (err) {
      if (err instanceof StripeReadKeyInvalidError || err instanceof StripeReadApiError) throw err;
      throw new StripeReadApiError((err as Error).message ?? 'error');
    }

    return { subscribers: [...byId.values()], truncated };
  }

  async findSubscriptionsByEmail(email: string): Promise<StripeSubscriberRecord[]> {
    try {
      // 1) email → customer_id (WC no filtra /subscriptions por email).
      const custResp = await this.get(`/customers?email=${encodeURIComponent(email)}`);
      if (custResp.status === 401 || custResp.status === 403) {
        throw new StripeReadKeyInvalidError(`WooCommerce ${custResp.status} al buscar el cliente`);
      }
      if (!custResp.ok) return [];
      const customers = (await custResp.json()) as Array<{ id: number }>;
      if (!customers.length) return [];

      const out: StripeSubscriberRecord[] = [];
      for (const c of customers) {
        for (const status of WC_LOOKUP_STATUSES) {
          const subResp = await this.get(
            `/subscriptions?customer=${c.id}&status=${status}&per_page=${PER_PAGE}`,
          );
          if (subResp.status === 404) break; // plugin ausente
          if (!subResp.ok) continue;
          const rows = (await subResp.json()) as WooSubscription[];
          for (const row of rows) out.push(mapSubscription(row));
        }
      }
      return out;
    } catch (err) {
      if (err instanceof StripeReadKeyInvalidError || err instanceof StripeReadApiError) throw err;
      throw new StripeReadApiError((err as Error).message ?? 'error');
    }
  }

  private get(path: string): Promise<Response> {
    return this.fetchFn(`${this.base}${path}`, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}

interface WooSubscription {
  id: number;
  status?: string;
  customer_id?: number;
  currency?: string;
  total?: string;
  billing_period?: string;
  billing_interval?: number;
  billing?: { first_name?: string; last_name?: string; email?: string };
  line_items?: Array<{ name?: string; product_id?: number }>;
}

function mapSubscription(row: WooSubscription): StripeSubscriberRecord {
  const billing = row.billing ?? {};
  const fullName = [billing.first_name, billing.last_name].filter(Boolean).join(' ').trim() || null;
  const planName = row.line_items?.[0]?.name ?? null;
  const total = row.total != null ? Math.round(parseFloat(row.total) * 100) : null;
  return {
    subscriptionId: String(row.id),
    status: row.status ?? 'active',
    customerId: row.customer_id != null ? String(row.customer_id) : null,
    email: billing.email ?? null,
    name: fullName,
    priceId: null,
    productId:
      row.line_items?.[0]?.product_id != null ? String(row.line_items[0]!.product_id) : null,
    productName: planName,
    unitAmount: total != null && !Number.isNaN(total) ? total : null,
    currency: row.currency ?? null,
    interval: row.billing_period ?? null,
    currentPeriodEnd: null,
    created: 0,
  };
}
