'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { formatDate, formatStripeMinor, regionNameFormatter } from '@/lib/i18n/format';
import {
  SALE_STATUSES,
  salesApi,
  type SaleRow,
  type SalesFilters,
  type SalesPage,
} from '@/lib/sales';
import { cn } from '@/lib/utils';
import { SaleDetailDialog } from './sale-detail-dialog';
import { StatusBadge } from './sale-status-badge';

const PAGE_SIZE = 25;
/** Cada cuánto se vuelve a mirar si hay ventas nuevas con la pestaña a la vista. */
export const SALES_POLL_MS = 60_000;

/**
 * Se vuelve a pedir lo mismo al volver a la pestaña y, con ella a la vista,
 * cada `SALES_POLL_MS`: una venta que entra mientras el creador mira «Ventas»
 * aparece sola (venta real: había que recargar). Pura en lo que importa: el
 * test la monta con un `document` de mentira.
 */
export function useRefreshWhenVisible(refresh: () => void, intervalMs = SALES_POLL_MS): void {
  const ref = useRef(refresh);
  ref.current = refresh;
  useEffect(() => {
    const visible = () => document.visibilityState === 'visible';
    const onFocus = () => {
      if (visible()) ref.current();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const timer = window.setInterval(() => {
      if (visible()) ref.current();
    }, intervalMs);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      window.clearInterval(timer);
    };
  }, [intervalMs]);
}

/** Avisa a quien pinta el resumen (lo vendido, en camino…) de que hay datos nuevos. */
export const SALES_REFRESHED_EVENT = 'didacta:ventas-actualizadas';

/**
 * «Todas tus ventas»: quién compró, qué, cuánto pagó, las comisiones, lo que
 * le llega al creador, en qué está y desde qué país, con búsqueda, filtros
 * (fechas, producto, estado), detalle de cada venta y exportación (CSV, Excel
 * y compradores) con los filtros puestos. Los mismos datos en el modo sencillo
 * y en el completo: todo sale de `GET /admin/sales`.
 */
export function SalesLedger({
  onChanged,
  hideWhenEmpty = false,
}: {
  onChanged?: () => void;
  /** Sin ventas (y sin filtros), no pinta nada: ya lo dice otra tarjeta. */
  hideWhenEmpty?: boolean;
}) {
  const t = useTranslations('modoSencilloVentas.datos');
  const locale = useLocale();
  const [filters, setFilters] = useState<SalesFilters>({});
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<SalesPage | null>(null);
  const [error, setError] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState(false);

  // La búsqueda se aplica al dejar de escribir.
  useEffect(() => {
    if ((filters.q ?? '') === query) return;
    const id = window.setTimeout(() => {
      setFilters((f) => ({ ...f, q: query }));
      setPage(1);
    }, 300);
    return () => window.clearTimeout(id);
  }, [query, filters.q]);

  const load = useCallback(async () => {
    try {
      setData(await salesApi.list(filters, page, PAGE_SIZE));
      setError(false);
    } catch {
      setError(true);
    }
  }, [filters, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useRefreshWhenVisible(() => {
    void load();
    window.dispatchEvent(new Event(SALES_REFRESHED_EVENT));
  });

  function setFilter(patch: Partial<SalesFilters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  }

  async function download(format: 'csv' | 'xlsx', view: 'sales' | 'buyers') {
    const key = `${view}-${format}`;
    setExporting(key);
    setExportError(false);
    try {
      const { blob, fileName } = await salesApi.export(filters, format, view);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setExportError(true);
    } finally {
      setExporting(null);
    }
  }

  const filtered = Boolean(
    filters.q || filters.from || filters.to || filters.product || filters.status,
  );
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const country = regionNameFormatter(locale);
  const platform = data?.platform ?? null;
  const showSettlement = Boolean(platform || data?.items.some((s) => s.settlement !== null));
  const money = (minor: number | null | undefined, currency: string | null | undefined) =>
    minor === null || minor === undefined || !currency
      ? '—'
      : formatStripeMinor(minor, currency, { exact: true, locale });

  if (hideWhenEmpty && !filtered && data && data.total === 0) return null;

  const input =
    'h-10 rounded-xl border border-border bg-surface px-3 text-sm text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100';

  return (
    <section
      className="min-w-0 rounded-2xl border border-border bg-surface"
      aria-labelledby="ventas-datos-titulo"
      data-testid="ventas-datos"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h2 id="ventas-datos-titulo" className="text-base font-bold text-text">
            {t('titulo')}
          </h2>
          <p className="text-sm text-text-muted">{t('sub')}</p>
        </div>
        <details className="group relative" data-testid="ventas-exportar">
          <summary className="inline-flex h-10 cursor-pointer list-none items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-semibold text-text hover:border-border-strong [&::-webkit-details-marker]:hidden">
            <Icon name="download-cloud" size={16} />
            {exporting ? t('exportando') : t('exportar')}
            <Icon name="chevron-down" size={14} />
          </summary>
          <div className="absolute right-0 z-20 mt-1 w-64 rounded-xl border border-border bg-surface p-1.5 shadow-lg">
            {(
              [
                ['sales', 'csv', t('exportarCsv'), 'exportar-csv'],
                ['sales', 'xlsx', t('exportarXlsx'), 'exportar-xlsx'],
                ['buyers', 'csv', t('exportarCompradores'), 'exportar-compradores'],
              ] as const
            ).map(([view, format, label, testId]) => (
              <button
                key={testId}
                type="button"
                disabled={exporting !== null}
                onClick={(e) => {
                  (
                    e.currentTarget.closest('details') as HTMLDetailsElement | null
                  )?.removeAttribute('open');
                  void download(format, view);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-semibold text-text hover:bg-bg-subtle disabled:opacity-50"
                data-testid={testId}
              >
                <Icon name="file" size={15} />
                {label}
              </button>
            ))}
            <p className="px-2.5 pt-1 pb-1.5 text-xs text-text-subtle">{t('exportarNota')}</p>
          </div>
        </details>
      </div>
      {exportError ? (
        <p role="alert" className="mx-4 mt-2 text-sm font-semibold text-danger-700">
          {t('exportarError')}
        </p>
      ) : null}

      {/* Filtros */}
      <div className="mt-3 flex flex-wrap items-end gap-2 px-4">
        <label className="relative min-w-[200px] flex-1">
          <span className="sr-only">{t('buscar')}</span>
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-subtle">
            <Icon name="search" size={15} />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('buscar')}
            aria-label={t('buscar')}
            className={cn(input, 'w-full pl-9')}
            data-testid="ventas-buscar"
          />
        </label>
        <label className="flex flex-col text-xs font-semibold text-text-muted">
          {t('desde')}
          <input
            type="date"
            value={filters.from ?? ''}
            onChange={(e) => setFilter({ from: e.target.value || undefined })}
            className={cn(input, 'mt-1')}
            data-testid="ventas-desde"
          />
        </label>
        <label className="flex flex-col text-xs font-semibold text-text-muted">
          {t('hasta')}
          <input
            type="date"
            value={filters.to ?? ''}
            onChange={(e) => setFilter({ to: e.target.value || undefined })}
            className={cn(input, 'mt-1')}
            data-testid="ventas-hasta"
          />
        </label>
        <label className="flex flex-col text-xs font-semibold text-text-muted">
          {t('producto')}
          <select
            value={filters.product ?? ''}
            onChange={(e) => setFilter({ product: e.target.value || undefined })}
            className={cn(input, 'mt-1 max-w-[220px] pr-2')}
            data-testid="ventas-producto"
          >
            <option value="">{t('todosProductos')}</option>
            {(data?.products ?? []).map((p) => (
              <option key={p.ref} value={p.ref}>
                {p.title ?? (p.kind === 'membership' ? t('membresia') : t('sinNombre'))}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-semibold text-text-muted">
          {t('estadoFiltro')}
          <select
            value={filters.status ?? ''}
            onChange={(e) =>
              setFilter({ status: (e.target.value || undefined) as SalesFilters['status'] })
            }
            className={cn(input, 'mt-1 pr-2')}
            data-testid="ventas-estado"
          >
            <option value="">{t('todosEstados')}</option>
            {SALE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`estado.${s}`)}
              </option>
            ))}
          </select>
        </label>
        {filtered ? (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setFilters({});
              setPage(1);
            }}
            className="h-10 px-1 text-sm font-semibold text-brand-600 hover:underline"
          >
            {t('limpiar')}
          </button>
        ) : null}
      </div>

      {/* Total de lo filtrado, por moneda (nunca se suman monedas). */}
      {data && data.total > 0 ? (
        <p className="mt-3 px-4 text-sm text-text-muted" data-testid="ventas-total">
          {t('total', { n: data.total })}
          {data.totals.map((c) => (
            <span key={c.currency}> · {money(c.amount, c.currency)}</span>
          ))}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="m-4 text-sm text-danger-700">
          {t('error')}
        </p>
      ) : !data ? (
        <div className="m-4 skeleton h-40" />
      ) : data.items.length === 0 ? (
        <p className="m-4 rounded-xl border border-dashed border-border-strong p-6 text-center text-sm text-text-muted">
          {filtered ? t('vacioFiltros') : t('vacio')}
        </p>
      ) : (
        <>
          {/* Escritorio: tabla. */}
          <div className="mt-3 hidden overflow-x-auto md:block">
            <table className="w-full text-sm" data-testid="ventas-tabla">
              <thead>
                <tr className="border-y border-border-soft text-left text-xs text-text-subtle">
                  <th className="px-4 py-2 font-medium">{t('col.fecha')}</th>
                  <th className="py-2 pr-3 font-medium">{t('col.comprador')}</th>
                  <th className="py-2 pr-3 font-medium">{t('col.producto')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('col.importe')}</th>
                  {showSettlement ? (
                    <th className="py-2 pr-3 text-right font-medium">{t('col.neto')}</th>
                  ) : null}
                  <th className="py-2 pr-3 font-medium">{t('col.estado')}</th>
                  <th className="py-2 pr-4 font-medium">{t('col.pais')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((sale) => (
                  <tr
                    key={sale.id}
                    onClick={() => setOpenId(sale.id)}
                    className="cursor-pointer border-b border-border-soft align-top hover:bg-bg-subtle"
                    data-testid="venta-fila"
                    data-sale-id={sale.id}
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-text-muted">
                      {formatDate(sale.at, {
                        locale,
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="max-w-[16rem] py-3 pr-3">
                      <BuyerCell sale={sale} onOpen={() => setOpenId(sale.id)} />
                    </td>
                    <td className="max-w-[16rem] py-3 pr-3">
                      <ProductCell sale={sale} money={money} />
                    </td>
                    <td className="py-3 pr-3 text-right font-semibold whitespace-nowrap text-text tabular-nums">
                      {money(sale.amount, sale.currency)}
                    </td>
                    {showSettlement ? (
                      <td className="py-3 pr-3 text-right whitespace-nowrap tabular-nums">
                        {sale.settlement ? (
                          <>
                            <span className="font-semibold text-text">
                              {sale.settlement.net === null
                                ? t('calculando')
                                : money(sale.settlement.net, sale.settlement.currency)}
                            </span>
                            {sale.settlement.cardFee !== null ? (
                              <span className="block text-xs text-text-subtle">
                                {t('comisionesTexto', {
                                  tarjeta: money(sale.settlement.cardFee, sale.settlement.currency),
                                  operador: platform?.operatorName ?? 'Didacta',
                                  plataforma: money(
                                    sale.settlement.platformFee,
                                    sale.settlement.currency,
                                  ),
                                })}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-text-subtle">—</span>
                        )}
                      </td>
                    ) : null}
                    <td className="py-3 pr-3">
                      <StatusBadge sale={sale} />
                    </td>
                    <td className="py-3 pr-4 whitespace-nowrap text-text-muted">
                      {sale.buyer.country ? country(sale.buyer.country) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Móvil: una ficha por venta. */}
          <ul className="mt-3 divide-y divide-border-soft border-t border-border-soft md:hidden">
            {data.items.map((sale) => (
              <li key={sale.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(sale.id)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-bg-subtle"
                  data-testid="venta-ficha"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-text">
                      {sale.buyer.name ??
                        (sale.buyer.deleted
                          ? t('cuentaEliminada')
                          : (sale.buyer.email ?? t('sinNombre')))}
                    </div>
                    <div className="truncate text-[13px] text-text-muted">
                      {sale.product.title ?? '—'}
                    </div>
                    <div className="text-[13px] text-text-subtle">
                      {formatDate(sale.at, { locale, dateStyle: 'medium' })}
                      {sale.buyer.country ? ` · ${country(sale.buyer.country)}` : ''}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-text tabular-nums">
                      {money(sale.amount, sale.currency)}
                    </div>
                    <StatusBadge sale={sale} />
                  </div>
                </button>
              </li>
            ))}
          </ul>

          {pages > 1 ? (
            <div className="flex items-center justify-between gap-3 border-t border-border-soft px-4 py-3 text-sm">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="h-9 rounded-lg border border-border px-3 font-semibold text-text disabled:opacity-40"
              >
                {t('anteriores')}
              </button>
              <span className="text-text-muted">{t('pagina', { page, pages })}</span>
              <button
                type="button"
                disabled={page >= pages}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                className="h-9 rounded-lg border border-border px-3 font-semibold text-text disabled:opacity-40"
              >
                {t('siguientes')}
              </button>
            </div>
          ) : (
            <div className="h-2" />
          )}
        </>
      )}

      {openId ? (
        <SaleDetailDialog
          saleId={openId}
          onClose={() => setOpenId(null)}
          onRefunded={() => {
            void load();
            onChanged?.();
          }}
        />
      ) : null}
    </section>
  );
}

function BuyerCell({ sale, onOpen }: { sale: SaleRow; onOpen: () => void }) {
  const t = useTranslations('modoSencilloVentas.datos');
  const name = sale.buyer.name ?? (sale.buyer.deleted ? t('cuentaEliminada') : t('sinNombre'));
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className="block max-w-full truncate text-left font-semibold text-text hover:text-brand-700 hover:underline"
        aria-label={t('verDetalle', { nombre: name })}
        data-testid="venta-comprador"
      >
        {name}
      </button>
      {sale.buyer.email ? (
        <span className="block truncate text-xs text-text-muted" data-testid="venta-correo">
          {sale.buyer.email}
        </span>
      ) : null}
    </div>
  );
}

function ProductCell({
  sale,
  money,
}: {
  sale: SaleRow;
  money: (minor: number | null | undefined, currency: string | null | undefined) => string;
}) {
  const t = useTranslations('modoSencilloVentas.datos');
  const type =
    sale.kind === 'order'
      ? t('tipo.order')
      : sale.product.kind === 'membership'
        ? t('tipo.membership')
        : t('tipo.subscription');
  return (
    <div className="min-w-0">
      <span className="block truncate font-medium text-text">
        {sale.product.title ?? '—'}
        {sale.product.option ? ` · ${sale.product.option}` : ''}
      </span>
      <span className="block text-xs text-text-subtle">{type}</span>
      {sale.coupon ? (
        <span className="mt-0.5 inline-block rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] font-semibold text-text-muted">
          {t('cupon', { importe: money(sale.coupon, sale.currency) })}
        </span>
      ) : null}
      {sale.referral ? (
        <span
          className="mt-0.5 ml-1 inline-block rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700"
          data-testid="venta-referido"
        >
          {t('traidaPor', { nombre: sale.referral.referrerName ?? sale.referral.code ?? '—' })}
        </span>
      ) : null}
      {sale.referralCredit ? (
        <span className="mt-0.5 ml-1 inline-block rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] font-semibold text-text-muted">
          {t('saldoReferidos', { importe: money(sale.referralCredit, sale.currency) })}
        </span>
      ) : null}
    </div>
  );
}
