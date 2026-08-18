'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Pestaña «Compras» de /cuenta: lo que el alumno compró en la tienda del centro.
 *
 * ── Por qué esto vive aquí y no en la web de quien vende ────────────────────
 * Cuando el centro monta su propia tienda, el alumno acaba con las clases en un
 * sitio y el historial de compra en otro. Esa segunda pantalla hay que
 * construirla dos veces y mantenerla sincronizada a mano, y la primera vez que
 * alguien reembolsa un pedido las dos dejan de decir lo mismo.
 *
 * La tienda deja aquí el pedido (`POST /integrations/orders`) y esta pestaña lo
 * enseña. Es una sola verdad, y la tienda puede leerla de vuelta para pintar su
 * propia zona de cliente sin consultar su base de datos.
 *
 * ── Lo que NO hace ─────────────────────────────────────────────────────────
 * **Didacta no factura.** No se genera ningún documento aquí: de la factura se
 * guardan su número, su fecha y un enlace al PDF que sirve quien la emitió. Si
 * la tienda todavía no la ha emitido —lo normal en los primeros minutos tras
 * comprar— se dice así, y no se esconde la fila: quien acaba de pagar necesita
 * ver su pedido AHORA, aunque la factura tarde.
 *
 * La pestaña **no se enseña si no hay ninguna compra**, que es el caso de
 * cualquier instalación sin tienda externa.
 */

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { formatCents, formatDate } from '@/lib/i18n/format';
import { myPurchasesApi, type Purchase } from '@/lib/my-purchases';

/** Estado → variante del badge. Clave abierta: un estado nuevo cae en `muted`. */
const ESTADO_VARIANTE: Record<string, 'success' | 'muted' | 'warning' | 'danger'> = {
  PAID: 'success',
  REFUNDED: 'muted',
  PARTIALLY_REFUNDED: 'warning',
  CANCELLED: 'danger',
};

/**
 * La clave del catálogo, tabulada en vez de compuesta.
 *
 * Es tabla abierta como la de arriba: un estado que esta versión del aula no
 * conozca —porque la tienda lo mande antes de que aquí se traduzca— se enseña
 * en crudo en vez de pintar la clave sin resolver.
 */
const ESTADO_CLAVE = {
  PAID: 'compras.estado.PAID',
  REFUNDED: 'compras.estado.REFUNDED',
  PARTIALLY_REFUNDED: 'compras.estado.PARTIALLY_REFUNDED',
  CANCELLED: 'compras.estado.CANCELLED',
} as const;

/**
 * Carga mis compras.
 *
 * Se expone como hook para que /cuenta pueda decidir **si enseña la pestaña**
 * antes de que nadie la pulse: una pestaña vacía en toda instalación que no
 * venda desde fuera es ruido permanente en el perfil de todo el mundo.
 */
export function useMyPurchases() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<Purchase[]>([]);

  const load = useCallback(async () => {
    const token = authStorage.getAccessToken();
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const data = await myPurchasesApi.list(token);
      setOrders(data.orders);
      setError(null);
    } catch (e) {
      // Un fallo aquí NO puede tumbar el perfil: las compras son una sección
      // más de /cuenta, y quien viene a cambiar su contraseña tiene derecho a
      // hacerlo aunque esta lista no cargue.
      setError(e instanceof ApiHttpError ? e.message : 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { loading, error, orders };
}

function Linea({ orden }: { orden: Purchase }) {
  const t = useTranslations('cuentaComponentes');
  const moneda = orden.currency.toUpperCase();
  const variante = ESTADO_VARIANTE[orden.status] ?? 'muted';
  const claveEstado = ESTADO_CLAVE[orden.status as keyof typeof ESTADO_CLAVE];

  return (
    <li className="flex flex-wrap items-start justify-between gap-4 border-b border-border py-4 last:border-0">
      <div className="min-w-[16rem] flex-1">
        <p className="font-medium text-text">
          {orden.lines.length > 0
            ? orden.lines.map((l) => l.name).join(' · ')
            : t('compras.pedidoSinDetalle')}
        </p>
        <p className="mt-1 text-sm text-text-muted">
          {formatDate(orden.placedAt, { day: 'numeric', month: 'long', year: 'numeric' })} ·{' '}
          {orden.reference}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Badge variant={variante}>{claveEstado ? t(claveEstado) : orden.status}</Badge>
        <span className="tabular-nums font-medium text-text">
          {formatCents(orden.amountCents, moneda)}
        </span>
        {orden.invoice?.url ? (
          <a
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
            href={orden.invoice.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="file" className="size-4" aria-hidden />
            {t('compras.factura', { numero: orden.invoice.number })}
          </a>
        ) : orden.invoice ? (
          <span className="text-sm text-text-muted">
            {t('compras.factura', { numero: orden.invoice.number })}
          </span>
        ) : (
          <span className="text-sm text-text-muted">{t('compras.sinFactura')}</span>
        )}
      </div>
    </li>
  );
}

export function PurchasesTab({ state }: { state: ReturnType<typeof useMyPurchases> }) {
  const t = useTranslations('cuentaComponentes');
  const { loading, error, orders } = state;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('compras.titulo')}</CardTitle>
        <CardDescription>{t('compras.descripcion')}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : error ? (
          <p className="text-sm text-text-muted">
            {error === 'error' ? t('compras.errorCarga') : error}
          </p>
        ) : orders.length === 0 ? (
          <p className="text-sm text-text-muted">{t('compras.vacio')}</p>
        ) : (
          <ul className="-my-1">
            {orders.map((o) => (
              <Linea key={o.id} orden={o} />
            ))}
          </ul>
        )}
        {/* La aclaración importa: sin ella, alguien pide aquí una factura que
            este sistema no emite ni puede emitir. */}
        {!loading && orders.length > 0 && (
          <p className="mt-5 text-xs text-text-muted">{t('compras.nota')}</p>
        )}
      </CardContent>
    </Card>
  );
}
