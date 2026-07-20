/**
 * Cliente de SOLO LECTURA sobre el SDK de Stripe para mod.payment-connections.
 *
 * Distinto a propósito de los adapters de mod.billing / mod.subscriptions:
 *   - NO se importan cross-module (regla del contrato).
 *   - Solo expone métodos de lectura (retrieveAccount + listActiveSubscriptions).
 *     Una restricted key read-only no puede crear/cancelar nada, así que la
 *     superficie de escritura ni existe. Cancelar una suscripción se hace por
 *     deep-link al dashboard de Stripe desde la UI.
 *   - Multi-cuenta: una instancia por conexión, construida bajo demanda con la
 *     api key descifrada (NO una sola global desde env, como billing).
 */

import type Stripe from 'stripe';
import { StripeReadApiError, StripeReadKeyInvalidError } from './errors.js';

export interface StripeAccountInfo {
  id: string;
  email: string | null;
  country: string | null;
  businessName: string | null;
}

/** Una suscripción activa leída de Stripe, aplanada para reconciliar. */
export interface StripeSubscriberRecord {
  subscriptionId: string;
  status: string;
  customerId: string | null;
  email: string | null;
  name: string | null;
  priceId: string | null;
  productId: string | null;
  /** Nombre del producto Stripe = el TIER del usuario (cuando se sincroniza). */
  productName: string | null;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
  currentPeriodEnd: number | null;
  created: number;
}

/**
 * Una COMPRA PUNTUAL (pedido) leída del proveedor. Complementa a las
 * suscripciones: quien compró un "acceso lifetime" no tiene suscripción viva,
 * pero sí un pedido con los productos que adquirió — que es justo lo que el
 * aprobador necesita ver al decidir una solicitud de inscripción.
 */
export interface PurchaseRecord {
  orderId: string;
  orderNumber: string | null;
  /** Estado crudo del proveedor (completed, processing, refunded, cancelled…). */
  status: string;
  /** Importe total en la unidad MENOR (céntimos), como el resto del módulo. */
  total: number | null;
  currency: string | null;
  /** ISO 8601 de creación del pedido, si el proveedor lo da. */
  createdAt: string | null;
  /** Nombres de los productos comprados (líneas del pedido). */
  products: string[];
}

export interface ListActiveSubscriptionsOptions {
  /** Estados Stripe que cuentan como "activa". Default: active, trialing, past_due. */
  statuses?: string[];
  /** Tope defensivo de páginas por estado (100 subs/página). Default 50. */
  maxPages?: number;
}

export interface StripeSubscriptionsResult {
  subscribers: StripeSubscriberRecord[];
  /** True si se alcanzó el tope de páginas y puede haber más subs sin leer. */
  truncated: boolean;
}

export interface StripeReadAdapter {
  /** Valida la credencial y devuelve metadata no-secreta de la cuenta. */
  retrieveAccount(): Promise<StripeAccountInfo>;
  /** Lista (paginado) las suscripciones de los estados pedidos, con su customer. */
  listActiveSubscriptions(
    options?: ListActiveSubscriptionsOptions,
  ): Promise<StripeSubscriptionsResult>;
  /**
   * Busca las suscripciones activas de UN email concreto (lookup por-usuario que
   * usa el job de inscripción). Opcional: si el proveedor no lo implementa, el
   * caller lo omite. Devuelve [] si el email no tiene suscripción en esa cuenta.
   */
  findSubscriptionsByEmail?(email: string): Promise<StripeSubscriberRecord[]>;
  /**
   * Compras PUNTUALES (pedidos) de un email: el caso de los accesos "lifetime"
   * vendidos en su día, que no dejan suscripción viva. Opcional por proveedor:
   * hoy lo implementa WooCommerce (Stripe/PayPal, fase 2). Devuelve [] si el
   * email no tiene pedidos en esa cuenta.
   */
  findPurchasesByEmail?(email: string): Promise<PurchaseRecord[]>;
  /**
   * URL hospedada de la factura ABIERTA/impaga de una suscripción — el enlace
   * read-only para que el cliente pague/renueve. Opcional por proveedor. Devuelve
   * null si no hay factura abierta o el proveedor no lo soporta.
   */
  readOpenInvoiceUrl?(subscriptionId: string): Promise<string | null>;
  /**
   * Nombres de los planes/productos del CATÁLOGO del proveedor (no de los
   * suscriptores): permite crear tiers de planes que aún no tienen ningún
   * suscriptor. Opcional. Devuelve [] si no se soporta o no hay permiso.
   */
  listPlanCatalog?(): Promise<string[]>;
  /**
   * Crea una sesión del Customer Portal para que el CLIENTE gestione su
   * suscripción (cancelar, actualizar tarjeta, ver facturas) en el portal
   * hospedado del proveedor. Requiere una key con permiso de portal y el portal
   * activado en el dashboard. Opcional por proveedor: solo Stripe lo implementa
   * (PayPal/WooCommerce no tienen equivalente). Devuelve la URL de la sesión.
   */
  createBillingPortalSession?(customerId: string, returnUrl: string): Promise<string>;
}

const DEFAULT_STATUSES = ['active', 'trialing', 'past_due'];
const DEFAULT_MAX_PAGES = 50;
const PAGE_SIZE = 100;

/**
 * Implementación real basada en el SDK oficial de Stripe. Construir una por
 * conexión con la api key descifrada. En tests pasamos un adapter mockeado.
 */
export class StripeReadSdkAdapter implements StripeReadAdapter {
  private readonly client: Stripe;
  /** Cache de productId → nombre, para no re-pedir el mismo producto. */
  private readonly productNameCache = new Map<string, string | null>();

  constructor(apiKey: string, StripeCtor: new (key: string, opts?: Stripe.StripeConfig) => Stripe) {
    if (!apiKey) throw new StripeReadKeyInvalidError('clave de Stripe vacía');
    this.client = new StripeCtor(apiKey, {
      apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion,
      timeout: 10_000,
      maxNetworkRetries: 1,
    });
  }

  async retrieveAccount(): Promise<StripeAccountInfo> {
    try {
      const account = await this.client.accounts.retrieve();
      return {
        id: account.id,
        email: account.email ?? null,
        country: account.country ?? null,
        businessName:
          account.business_profile?.name ?? account.settings?.dashboard?.display_name ?? null,
      };
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  /**
   * Crea una sesión del Customer Portal de Stripe pre-autenticada para el
   * customer indicado. El cliente gestiona ahí su suscripción (cancelar,
   * actualizar tarjeta, ver facturas) según lo activado en el dashboard.
   */
  async createBillingPortalSession(customerId: string, returnUrl: string): Promise<string> {
    try {
      const session = await this.client.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });
      return session.url;
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  async listActiveSubscriptions(
    options?: ListActiveSubscriptionsOptions,
  ): Promise<StripeSubscriptionsResult> {
    const statuses = options?.statuses?.length ? options.statuses : DEFAULT_STATUSES;
    const maxPages =
      options?.maxPages && options.maxPages > 0 ? options.maxPages : DEFAULT_MAX_PAGES;
    const subscribers: StripeSubscriberRecord[] = [];
    let truncated = false;

    try {
      for (const status of statuses) {
        let startingAfter: string | undefined;
        let pages = 0;
        // Paginación manual con starting_after (cursor estable de Stripe).
        for (;;) {
          const resp = await this.client.subscriptions.list({
            status: status as Stripe.SubscriptionListParams.Status,
            limit: PAGE_SIZE,
            // Stripe NO permite expandir más de 4 niveles, así que expandimos
            // hasta el price (data.items.data.price) y el NOMBRE del producto lo
            // resolvemos aparte (fillProductNames) — es el "tier" del usuario.
            expand: ['data.customer', 'data.items.data.price'],
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          });
          for (const sub of resp.data) {
            subscribers.push(mapSubscription(sub));
          }
          pages += 1;
          if (!resp.has_more) break;
          if (pages >= maxPages) {
            truncated = true;
            break;
          }
          const last = resp.data[resp.data.length - 1];
          if (!last) break;
          startingAfter = last.id;
        }
      }
    } catch (err) {
      throw mapStripeError(err);
    }

    await this.fillProductNames(subscribers);
    return { subscribers, truncated };
  }

  async findSubscriptionsByEmail(email: string): Promise<StripeSubscriberRecord[]> {
    const out: StripeSubscriberRecord[] = [];
    try {
      const customers = await this.client.customers.list({ email, limit: 100 });
      for (const c of customers.data) {
        const subs = await this.client.subscriptions.list({
          customer: c.id,
          status: 'all',
          limit: 100,
          expand: ['data.items.data.price'],
        });
        // NO filtramos por estado: devolvemos TODAS (incluidas canceladas/impago/
        // incompletas) con su `status` crudo, para que el lookup de inscripción
        // pueda mostrarle al aprobador "Dada de baja" o "En impago" en lugar de un
        // falso "sin suscripción". La clasificación la hace classifySubscriptionStatus.
        for (const sub of subs.data) {
          const rec = mapSubscription(sub);
          rec.email = c.email ?? email;
          rec.customerId = c.id;
          rec.name = c.name ?? rec.name;
          out.push(rec);
        }
      }
    } catch (err) {
      throw mapStripeError(err);
    }
    await this.fillProductNames(out);
    return out;
  }

  /**
   * URL hospedada de la factura ABIERTA (impaga) de una suscripción: el enlace
   * para que el cliente pague/renueve. Solo lectura (la restricted key necesita
   * permiso de lectura de Facturas; si no lo tiene, devolvemos null en vez de
   * romper). null si no hay factura abierta.
   */
  async readOpenInvoiceUrl(subscriptionId: string): Promise<string | null> {
    if (!subscriptionId) return null;
    try {
      const invoices = await this.client.invoices.list({
        subscription: subscriptionId,
        status: 'open',
        limit: 1,
      });
      return invoices.data[0]?.hosted_invoice_url ?? null;
    } catch {
      // Best-effort: si la key no tiene permiso de Facturas o falla, no hay enlace.
      return null;
    }
  }

  /**
   * Nombres de los productos ACTIVOS del catálogo de Stripe (parte B del sync de
   * tiers): así aparecen como tier también los planes sin ningún suscriptor. Pide
   * `products.list({active:true})` paginado con tope defensivo. Best-effort: si la
   * key no tiene permiso de lectura de Productos o falla, devuelve [].
   */
  async listPlanCatalog(): Promise<string[]> {
    const names: string[] = [];
    try {
      let startingAfter: string | undefined;
      let pages = 0;
      for (;;) {
        const resp = await this.client.products.list({
          active: true,
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        for (const p of resp.data) {
          const name = p.name?.trim();
          if (name) names.push(name);
        }
        pages += 1;
        if (!resp.has_more || pages >= 20) break;
        const last = resp.data[resp.data.length - 1];
        if (!last) break;
        startingAfter = last.id;
      }
    } catch {
      return [];
    }
    return [...new Set(names)];
  }

  /**
   * Resuelve el nombre del producto de cada suscripción (no se puede expandir a
   * 5 niveles). Pide `products.retrieve` por cada productId único (cacheado),
   * con un tope defensivo. Si falla, deja el nickname del price como fallback.
   */
  private async fillProductNames(subscribers: StripeSubscriberRecord[]): Promise<void> {
    const ids = [
      ...new Set(subscribers.map((s) => s.productId).filter((x): x is string => !!x)),
    ].slice(0, 200);
    for (const id of ids) {
      if (this.productNameCache.has(id)) continue;
      try {
        const product = await this.client.products.retrieve(id);
        const name = !product.deleted ? ((product as Stripe.Product).name ?? null) : null;
        this.productNameCache.set(id, name);
      } catch {
        this.productNameCache.set(id, null);
      }
    }
    for (const s of subscribers) {
      const resolved = s.productId ? this.productNameCache.get(s.productId) : null;
      // Prioridad: nombre del producto > nickname del price (ya en s.productName).
      if (resolved) s.productName = resolved;
    }
  }
}

function mapSubscription(sub: Stripe.Subscription): StripeSubscriberRecord {
  const customer = sub.customer;
  let customerId: string | null = null;
  let email: string | null = null;
  let name: string | null = null;
  if (typeof customer === 'string') {
    customerId = customer;
  } else if (customer && !customer.deleted) {
    customerId = customer.id;
    email = customer.email ?? null;
    name = customer.name ?? null;
  } else if (customer) {
    customerId = customer.id;
  }

  const item = sub.items?.data?.[0];
  const price = item?.price ?? null;
  const product = price?.product ?? null;
  // El producto viene como id (string): su NOMBRE lo rellena fillProductNames.
  // Fallback inmediato sin llamada extra: el nickname del price, si existe.
  const productName = price?.nickname ?? null;

  return {
    subscriptionId: sub.id,
    status: sub.status,
    customerId,
    email,
    name,
    priceId: price?.id ?? null,
    productId: typeof product === 'string' ? product : (product?.id ?? null),
    productName,
    unitAmount: price?.unit_amount ?? null,
    currency: price?.currency ?? sub.currency ?? null,
    interval: price?.recurring?.interval ?? null,
    currentPeriodEnd: sub.current_period_end ?? null,
    created: sub.created,
  };
}

/**
 * Mapea errores del SDK a errores de dominio. Las claves inválidas o sin
 * permiso (401/403) → StripeReadKeyInvalidError; el resto → StripeReadApiError.
 * NUNCA incluimos la api key en el mensaje.
 */
function mapStripeError(err: unknown): PaymentConnectionsDomainError {
  const type = (err as { type?: string })?.type;
  const message = (err as Error)?.message ?? 'error desconocido';
  if (type === 'StripeAuthenticationError' || type === 'StripePermissionError') {
    // El hint de permisos es específico de Stripe → va en el reason (el mensaje
    // base del error ya es neutral de proveedor).
    return new StripeReadKeyInvalidError(
      `Stripe: ${message} (la clave necesita permisos de lectura: Customers + Subscriptions = Read)`,
    );
  }
  return new StripeReadApiError(`Stripe: ${message}`);
}

type PaymentConnectionsDomainError = StripeReadKeyInvalidError | StripeReadApiError;
