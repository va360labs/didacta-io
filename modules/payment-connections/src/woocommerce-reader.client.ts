/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
  PurchaseRecord,
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
/**
 * Cota de páginas del barrido por email de facturación (path B del lookup). WC no
 * filtra /subscriptions por email, así que hay que escanear y filtrar; acotamos
 * para que el job de fondo nunca cuelgue en tiendas con muchísimas suscripciones.
 */
const LOOKUP_MAX_PAGES = 20;
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
    const target = email.trim().toLowerCase();
    // Dedup por id: una misma suscripción puede aparecer por ambos paths.
    const byId = new Map<string, StripeSubscriberRecord>();
    const collect = (row: WooSubscription) => {
      const rec = mapSubscription(row);
      if (!byId.has(rec.subscriptionId)) byId.set(rec.subscriptionId, rec);
    };
    try {
      // PATH A — por email de CUENTA WP: email → customer_id → sus suscripciones.
      // Barato y exacto para clientes registrados cuyo email de cuenta coincide.
      const custResp = await this.get(`/customers?email=${encodeURIComponent(email)}`);
      if (custResp.status === 401 || custResp.status === 403) {
        throw new StripeReadKeyInvalidError(`WooCommerce ${custResp.status} al buscar el cliente`);
      }
      if (custResp.ok) {
        const customers = (await custResp.json()) as Array<{ id: number }>;
        for (const c of customers) {
          for (const status of WC_LOOKUP_STATUSES) {
            const subResp = await this.get(
              `/subscriptions?customer=${c.id}&status=${status}&per_page=${PER_PAGE}`,
            );
            if (subResp.status === 404) break; // plugin ausente
            if (!subResp.ok) continue;
            for (const row of (await subResp.json()) as WooSubscription[]) collect(row);
          }
        }
      }

      // PATH B — por email de FACTURACIÓN. `/customers?email=` solo mira el email
      // de la CUENTA WP, así que NO detecta (a) compras de INVITADO (customer_id 0,
      // sin cuenta) ni (b) suscripciones cuyo email de facturación ≠ email de la
      // cuenta (el caso típico: el buscador de WooCommerce sí las encuentra porque
      // busca por facturación). WC no filtra /subscriptions por email, así que
      // escaneamos por estado y filtramos por billing.email exacto.
      for (const status of WC_LOOKUP_STATUSES) {
        let page = 1;
        for (;;) {
          const resp = await this.get(
            `/subscriptions?status=${status}&per_page=${PER_PAGE}&page=${page}`,
          );
          if (resp.status === 404) break; // plugin ausente
          if (resp.status === 401 || resp.status === 403) {
            throw new StripeReadKeyInvalidError(
              `WooCommerce ${resp.status} al listar suscripciones`,
            );
          }
          if (!resp.ok) break;
          const rows = (await resp.json()) as WooSubscription[];
          for (const row of rows) {
            if ((row.billing?.email ?? '').trim().toLowerCase() === target) collect(row);
          }
          const totalPages = Number(resp.headers.get('X-WP-TotalPages') ?? '1') || 1;
          if (page >= totalPages || rows.length === 0 || page >= LOOKUP_MAX_PAGES) break;
          page += 1;
        }
      }

      return [...byId.values()];
    } catch (err) {
      if (err instanceof StripeReadKeyInvalidError || err instanceof StripeReadApiError) throw err;
      throw new StripeReadApiError((err as Error).message ?? 'error');
    }
  }

  /**
   * Compras PUNTUALES (pedidos) de un email — el caso de los accesos "lifetime"
   * que no dejan suscripción viva.
   *
   * Dos vías, como el lookup de suscripciones, pero MÁS BARATAS: `/orders` sí
   * acepta `search` de forma nativa, así que no hay que escanear la tienda entera.
   *   PATH A — email → customer_id → sus pedidos (cliente registrado).
   *   PATH B — `?search=<email>` para compras de INVITADO o con email de
   *            facturación distinto. `search` es difuso, así que filtramos por
   *            `billing.email` exacto antes de aceptar la fila.
   * Se piden TODOS los estados (`status=any`): un pedido reembolsado o cancelado
   * también le interesa al aprobador, no se oculta.
   */
  async findPurchasesByEmail(email: string): Promise<PurchaseRecord[]> {
    const target = email.trim().toLowerCase();
    const byId = new Map<string, PurchaseRecord>();
    const collect = (row: WooOrder) => {
      const rec = mapOrder(row);
      if (!byId.has(rec.orderId)) byId.set(rec.orderId, rec);
    };

    /** Pagina una query de /orders acumulando resultados. `strict` filtra por email. */
    const drain = async (query: string, strict: boolean): Promise<void> => {
      let page = 1;
      for (;;) {
        const resp = await this.get(
          `/orders?${query}&status=any&per_page=${PER_PAGE}&page=${page}`,
        );
        if (resp.status === 401 || resp.status === 403) {
          throw new StripeReadKeyInvalidError(`WooCommerce ${resp.status} al listar pedidos`);
        }
        if (!resp.ok) break;
        const rows = (await resp.json()) as WooOrder[];
        for (const row of rows) {
          if (strict && (row.billing?.email ?? '').trim().toLowerCase() !== target) continue;
          collect(row);
        }
        const totalPages = Number(resp.headers.get('X-WP-TotalPages') ?? '1') || 1;
        if (page >= totalPages || rows.length === 0 || page >= LOOKUP_MAX_PAGES) break;
        page += 1;
      }
    };

    try {
      // PATH A — cliente registrado con ese email de cuenta.
      const custResp = await this.get(`/customers?email=${encodeURIComponent(email)}`);
      if (custResp.status === 401 || custResp.status === 403) {
        throw new StripeReadKeyInvalidError(`WooCommerce ${custResp.status} al buscar el cliente`);
      }
      if (custResp.ok) {
        const customers = (await custResp.json()) as Array<{ id: number }>;
        for (const c of customers) {
          await drain(`customer=${c.id}`, false);
        }
      }

      // PATH B — invitado o email de facturación distinto del de la cuenta.
      await drain(`search=${encodeURIComponent(email)}`, true);

      return [...byId.values()];
    } catch (err) {
      if (err instanceof StripeReadKeyInvalidError || err instanceof StripeReadApiError) throw err;
      throw new StripeReadApiError((err as Error).message ?? 'error');
    }
  }

  /**
   * Catálogo de productos de la tienda con el/los curso(s) de LearnDash que
   * vende cada uno (meta `_related_course`).
   *
   * Lo consume el sincronizador de precios: en la tienda vive el precio real de
   * cada curso suelto. Un producto que vende VARIOS cursos es un pack (la
   * membresía) y el llamador debe ignorarlo para el precio individual.
   */
  async listCatalogProducts(): Promise<WooCatalogProduct[]> {
    const out: WooCatalogProduct[] = [];
    let page = 1;
    for (;;) {
      const resp = await this.get(`/products?status=publish&per_page=${PER_PAGE}&page=${page}`);
      if (resp.status === 401 || resp.status === 403) {
        throw new StripeReadKeyInvalidError(`WooCommerce ${resp.status} al listar productos`);
      }
      if (!resp.ok) throw new StripeReadApiError(`WooCommerce products devolvió ${resp.status}`);
      const rows = (await resp.json()) as WooProduct[];
      for (const row of rows) {
        const cursos = cursosDe(row.meta_data);
        // Producto VARIABLE: el vínculo con los cursos no está en el padre sino
        // en cada variante ("Curso", "Curso Intermedio", "Curso Avanzado"), y
        // cada una puede dar acceso a un conjunto distinto. Si no bajáramos a
        // las variantes, estos productos parecerían no vender ningún curso.
        if (esVariable(row.type) && cursos.length === 0) {
          const variantes = await this.listVariations(row.id);
          for (const v of variantes) {
            out.push({
              id: `${row.id}:${v.id}`,
              name: `${row.name ?? ''}${v.nombre ? ` — ${v.nombre}` : ''}`,
              type: 'simple',
              price: v.price,
              regularPrice: v.regularPrice,
              salePrice: v.salePrice,
              relatedCourseIds: v.cursos,
            });
          }
          continue;
        }
        out.push({
          id: String(row.id),
          name: row.name ?? '',
          type: row.type ?? 'simple',
          price: row.price ?? null,
          regularPrice: row.regular_price ?? null,
          salePrice: row.sale_price ?? null,
          relatedCourseIds: cursos,
        });
      }
      const totalPages = Number(resp.headers.get('X-WP-TotalPages') ?? '1') || 1;
      if (page >= totalPages || rows.length === 0 || page >= DEFAULT_MAX_PAGES) break;
      page += 1;
    }
    return out;
  }

  /** Variantes de un producto variable, con su precio y sus cursos. */
  private async listVariations(productId: number): Promise<
    Array<{
      id: string;
      nombre: string;
      price: string | null;
      regularPrice: string | null;
      salePrice: string | null;
      cursos: string[];
    }>
  > {
    const resp = await this.get(`/products/${productId}/variations?per_page=${PER_PAGE}`);
    if (!resp.ok) return [];
    const rows = (await resp.json()) as WooVariation[];
    return rows.map((v) => ({
      id: String(v.id),
      nombre: (v.attributes ?? [])
        .map((a) => a.option)
        .filter(Boolean)
        .join(' / '),
      price: v.price ?? null,
      regularPrice: v.regular_price ?? null,
      salePrice: v.sale_price ?? null,
      cursos: cursosDe(v.meta_data),
    }));
  }

  /**
   * Barrido completo del histórico de pedidos, para el espejo.
   *
   * `findPurchasesByEmail` existe para responder «¿qué compró esta persona?» en
   * el momento; sirve para uno y es carísimo para todos (una tanda de llamadas
   * por email — con 535 compradores, inviable). Esto pagina la tienda entera:
   * 871 pedidos son 9 peticiones.
   *
   * Devuelve las líneas con `productId` y `productType` para que la
   * clasificación pueda apoyarse en lo que declara la tienda y no solo en el
   * nombre del producto.
   */
  async listAllOrders(
    options: { modifiedAfter?: Date; onPage?: (acumulados: number) => void } = {},
  ): Promise<ExternalOrderRecord[]> {
    const out: ExternalOrderRecord[] = [];
    const after = options.modifiedAfter
      ? `&modified_after=${encodeURIComponent(options.modifiedAfter.toISOString().slice(0, 19))}`
      : '';

    for (let page = 1; page <= MAX_ORDER_PAGES; page++) {
      const res = await this.get(`/orders?status=any&per_page=${PER_PAGE}&page=${page}${after}`);
      if (!res.ok) {
        throw new Error(`WooCommerce: /orders devolvió ${res.status} en la página ${page}`);
      }
      const rows = (await res.json()) as WooOrderFull[];
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) out.push(mapFullOrder(row));
      options.onPage?.(out.length);
      if (rows.length < PER_PAGE) break;
    }
    return out;
  }

  /** Tipo de cada producto del catálogo (`simple`, `subscription`, …) por id. */
  async productTypesById(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (let page = 1; page <= MAX_ORDER_PAGES; page++) {
      const res = await this.get(`/products?per_page=${PER_PAGE}&page=${page}&status=any`);
      if (!res.ok) break;
      const rows = (await res.json()) as Array<{ id: number; type?: string }>;
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const p of rows) if (p.type) map.set(String(p.id), p.type);
      if (rows.length < PER_PAGE) break;
    }
    return map;
  }

  private get(path: string): Promise<Response> {
    return this.fetchFn(`${this.base}${path}`, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}

/** Tope de páginas del barrido: 50 × 100 = 5.000 pedidos. Cortafuegos anti-bucle. */
const MAX_ORDER_PAGES = 50;

/** Pedido completo del espejo, con lo necesario para clasificarlo y mostrarlo. */
export interface ExternalOrderRecord {
  externalId: string;
  orderNumber: string | null;
  status: string;
  /** Céntimos. Null si la tienda manda un total ilegible. */
  total: number | null;
  currency: string;
  customerEmail: string;
  customerName: string | null;
  placedAt: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  items: ExternalOrderItem[];
}

export interface ExternalOrderItem {
  name: string;
  productId: string | null;
  /** Céntimos. */
  total: number | null;
  quantity: number;
}

interface WooOrderFull extends WooOrder {
  date_paid_gmt?: string | null;
  date_modified_gmt?: string | null;
  billing?: { email?: string; first_name?: string; last_name?: string; company?: string };
  refunds?: Array<{ id: number }>;
  line_items?: Array<{ name?: string; product_id?: number; total?: string; quantity?: number }>;
}

function centsOf(value: string | undefined | null): number | null {
  if (value == null) return null;
  const n = Math.round(parseFloat(value) * 100);
  return Number.isNaN(n) ? null : n;
}

/** WooCommerce da las fechas GMT sin sufijo; sin la `Z` se leen como locales. */
function isoOf(gmt: string | null | undefined): string | null {
  return gmt ? `${gmt}Z` : null;
}

/**
 * Convierte el payload de un pedido de WooCommerce al registro del espejo.
 *
 * Se exporta para que el webhook use EXACTAMENTE el mismo mapeo que el barrido:
 * el cuerpo que manda Woo en `order.created` tiene la misma forma que el de
 * `/orders`. Si cada camino mapeara por su cuenta, una compra nueva y una
 * reimportación acabarían escribiendo filas distintas para el mismo pedido.
 */
export function mapWooOrderPayload(payload: unknown): ExternalOrderRecord | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as WooOrderFull;
  if (row.id == null) return null;
  return mapFullOrder(row);
}

function mapFullOrder(row: WooOrderFull): ExternalOrderRecord {
  const nombre = [row.billing?.first_name, row.billing?.last_name]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ');

  return {
    externalId: String(row.id),
    orderNumber: row.number ?? null,
    status: row.status ?? 'unknown',
    total: centsOf(row.total),
    currency: (row.currency ?? 'EUR').toLowerCase(),
    customerEmail: (row.billing?.email ?? '').trim().toLowerCase(),
    customerName: nombre || (row.billing?.company ?? '').trim() || null,
    placedAt: isoOf(row.date_created_gmt) ?? row.date_created ?? null,
    paidAt: isoOf(row.date_paid_gmt),
    // WooCommerce no da fecha de devolución en el pedido; el estado `refunded`
    // es la señal, y la fecha se aproxima con la última modificación.
    refundedAt: row.status === 'refunded' ? isoOf(row.date_modified_gmt) : null,
    items: (row.line_items ?? []).map((li) => ({
      name: (li.name ?? '').trim(),
      productId: li.product_id != null ? String(li.product_id) : null,
      total: centsOf(li.total),
      quantity: li.quantity ?? 1,
    })),
  };
}

/** Pedido de WooCommerce (subconjunto que consumimos de /wp-json/wc/v3/orders). */
interface WooOrder {
  id: number;
  number?: string;
  status?: string;
  currency?: string;
  total?: string;
  date_created?: string;
  date_created_gmt?: string;
  billing?: { email?: string };
  line_items?: Array<{ name?: string }>;
}

function mapOrder(row: WooOrder): PurchaseRecord {
  const total = row.total != null ? Math.round(parseFloat(row.total) * 100) : null;
  // WC da `date_created_gmt` sin sufijo Z; lo normalizamos a ISO con zona.
  const gmt = row.date_created_gmt ? `${row.date_created_gmt}Z` : null;
  const created = gmt ?? row.date_created ?? null;
  return {
    orderId: String(row.id),
    orderNumber: row.number ?? null,
    status: row.status ?? 'unknown',
    total: total != null && !Number.isNaN(total) ? total : null,
    currency: row.currency ?? null,
    createdAt: created,
    products: (row.line_items ?? [])
      .map((li) => (li.name ?? '').trim())
      .filter((n) => n.length > 0),
  };
}

/** Producto del catálogo con su vínculo a cursos de LearnDash. */
export interface WooCatalogProduct {
  id: string;
  name: string;
  /** 'simple' = pago único; 'subscription'/'variable' = otra cosa. */
  type: string;
  /** Precio EFECTIVO (ya refleja si hay oferta vigente). */
  price: string | null;
  regularPrice: string | null;
  salePrice: string | null;
  /** IDs de curso de LearnDash que otorga. Vacío = no vende cursos. */
  relatedCourseIds: string[];
}

interface WooVariation {
  id: number;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  attributes?: Array<{ option?: string }>;
  meta_data?: Array<{ key: string; value: unknown }>;
}

/** Lee el vínculo con cursos de LearnDash del meta `_related_course`. */
function cursosDe(meta: Array<{ key: string; value: unknown }> | undefined): string[] {
  const rel = (meta ?? []).find((m) => m.key === '_related_course');
  return Array.isArray(rel?.value)
    ? rel.value.map((v) => String(v)).filter((v) => v && v !== '0')
    : [];
}

function esVariable(tipo: string | undefined): boolean {
  return tipo === 'variable' || tipo === 'variable-subscription';
}

interface WooProduct {
  id: number;
  name?: string;
  type?: string;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  meta_data?: Array<{ key: string; value: unknown }>;
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
