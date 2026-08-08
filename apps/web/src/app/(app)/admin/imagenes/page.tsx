'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import {
  adminImagesApi,
  formatBytes,
  type AnalyzedImage,
  type ImageSource,
  type SkipReason,
} from '@/lib/admin-images';

/**
 * Reoptimización del histórico de imágenes del tenant.
 *
 * Las imágenes nuevas se optimizan solas en la capa de storage, así que esta
 * pantalla solo mira atrás: avatares, portadas, logo y fotos de posts que se
 * subieron en crudo. Muestra el ahorro ANTES de tocar nada — reoptimizar
 * reescribe filas de varios módulos y el admin merece ver qué va a pasar.
 */

/** Tope por lote en el backend. Se envía de 50 en 50. */
const BATCH = 50;

/** Valores del filtro; el label de cada uno vive en `adminMarca.imageFilter`. */
const FILTER_VALUES: Array<ImageSource | 'todas'> = [
  'todas',
  'avatar',
  'curso',
  'coleccion',
  'post',
  'logo',
];

/**
 * Mapa del enum del API (con guiones) a la key camelCase del catálogo
 * (`adminMarca.skipReason.<key>`). Solo keys, nunca copy.
 */
const SKIP_KEYS: Record<
  Exclude<SkipReason, null>,
  'externa' | 'noEncontrada' | 'noRaster' | 'yaOptima'
> = {
  externa: 'externa',
  'no-encontrada': 'noEncontrada',
  'no-raster': 'noRaster',
  'ya-optima': 'yaOptima',
};

type RowState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; previousSize: number; size: number }
  | { kind: 'error'; message: string };

function rowKey(img: { source: string; ownerId: string; url: string }): string {
  return `${img.source}:${img.ownerId}:${img.url}`;
}

export default function AdminImagenesPage() {
  const t = useTranslations('adminMarca');
  const tErrors = useTranslations('errors');
  const [inventory, setInventory] = useState<AnalyzedImage[] | null>(null);
  const [totals, setTotals] = useState<{ current: number; optimized: number; count: number }>({
    current: 0,
    optimized: 0,
    count: 0,
  });
  const [truncated, setTruncated] = useState(false);
  const [filter, setFilter] = useState<ImageSource | 'todas'>('todas');
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roles = useMemo(() => authStorage.getSession()?.user.roles ?? [], []);
  const canManage = roles.includes('super_admin') || roles.includes('tenant_admin');

  const cargar = useCallback(async () => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const inv = await adminImagesApi.inventory(token);
      setInventory(inv.items);
      setTotals({
        current: inv.currentBytes,
        optimized: inv.optimizedBytes,
        count: inv.optimizable,
      });
      setTruncated(inv.truncated);
      setStates({});
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('imagenes.analyzeError'),
      );
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (canManage) void cargar();
  }, [canManage, cargar]);

  const visibles = useMemo(
    () => (inventory ?? []).filter((i) => filter === 'todas' || i.source === filter),
    [inventory, filter],
  );

  /** Las que se pueden mejorar dentro del filtro actual y no se hicieron ya. */
  const pendientes = useMemo(
    () =>
      visibles.filter(
        (i) => i.skipReason === null && (states[rowKey(i)]?.kind ?? 'idle') !== 'done',
      ),
    [visibles, states],
  );

  async function optimizar(refs: AnalyzedImage[]): Promise<void> {
    const token = authStorage.getAccessToken();
    if (!token || refs.length === 0) return;
    setRunning(true);
    setError(null);
    setStates((s) => {
      const next = { ...s };
      for (const r of refs) next[rowKey(r)] = { kind: 'running' };
      return next;
    });

    try {
      // En tandas: cada imagen se descarga, recomprime y reescribe, así que un
      // "optimizar todas" con cientos de imágenes de golpe tumbaría el request.
      for (let i = 0; i < refs.length; i += BATCH) {
        const tanda = refs.slice(i, i + BATCH);
        const { results } = await adminImagesApi.optimize(
          token,
          tanda.map((r) => ({
            source: r.source,
            ownerId: r.ownerId,
            label: r.label,
            url: r.url,
          })),
        );
        setStates((s) => {
          const next = { ...s };
          results.forEach((res, idx) => {
            const ref = tanda[idx]!;
            next[rowKey(ref)] = res.ok
              ? {
                  kind: 'done',
                  previousSize: res.previousSize ?? 0,
                  size: res.size ?? 0,
                }
              : { kind: 'error', message: res.error ?? t('imagenes.optimizeItemError') };
          });
          return next;
        });
      }
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('imagenes.optimizeError'),
      );
      setStates((s) => {
        const next = { ...s };
        for (const r of refs) {
          if (next[rowKey(r)]?.kind === 'running') {
            next[rowKey(r)] = { kind: 'error', message: t('imagenes.interrupted') };
          }
        }
        return next;
      });
    } finally {
      setRunning(false);
    }
  }

  const ahorroReal = useMemo(
    () =>
      Object.values(states).reduce(
        (acc, st) => (st.kind === 'done' ? acc + (st.previousSize - st.size) : acc),
        0,
      ),
    [states],
  );

  if (!canManage) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-danger-700">{t('imagenes.forbidden')}</CardContent>
      </Card>
    );
  }

  const ahorroPrevisto = totals.current - totals.optimized;

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('imagenes.title')}</h1>
        <p className="mt-1 max-w-2xl text-text-muted">{t('imagenes.description')}</p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Metrica valor={loading ? null : totals.count} etiqueta={t('imagenes.metricOptimizable')} />
        <Metrica
          valor={loading ? null : ahorroPrevisto}
          etiqueta={t('imagenes.metricForecast')}
          formato="bytes"
          detalle={
            totals.current > 0
              ? `${formatBytes(totals.current)} → ${formatBytes(totals.optimized)}`
              : undefined
          }
        />
        <Metrica
          valor={ahorroReal}
          etiqueta={t('imagenes.metricAchieved')}
          formato="bytes"
          detalle={t('imagenes.metricSession')}
        />
      </div>

      {truncated ? (
        <div className="rounded-lg border border-warning-100 bg-warning-50 p-3 text-sm text-warning-700">
          {t('imagenes.truncated')}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle>{t('imagenes.inventoryTitle')}</CardTitle>
              <CardDescription>
                {inventory === null
                  ? t('imagenes.analyzing')
                  : t('imagenes.inventorySummary', {
                      count: visibles.length,
                      pending: String(pendientes.length),
                    })}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => void cargar()}
                disabled={running}
              >
                {t('imagenes.reanalyze')}
              </Button>
              <Button
                type="button"
                onClick={() => void optimizar(pendientes)}
                disabled={running || pendientes.length === 0}
              >
                {running
                  ? t('imagenes.optimizing')
                  : t('imagenes.optimizeAll', { count: String(pendientes.length) })}
              </Button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {FILTER_VALUES.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  filter === value
                    ? 'border-brand-500 bg-brand-50 text-brand-700'
                    : 'border-border text-text-muted hover:border-border-strong hover:text-text'
                }`}
              >
                {t(`imageFilter.${value}`)}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {inventory === null ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton h-14 w-full" />
              ))}
            </div>
          ) : visibles.length === 0 ? (
            <p className="text-sm text-text-subtle">{t('imagenes.emptyCategory')}</p>
          ) : (
            <ul className="divide-y divide-border-soft">
              {visibles.map((img) => {
                const st = states[rowKey(img)] ?? { kind: 'idle' };
                const mejorable = img.skipReason === null;
                return (
                  <li key={rowKey(img)} className="flex items-center gap-3 py-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt=""
                      className="h-12 w-20 shrink-0 rounded-md border border-border bg-bg-subtle object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text">{img.label}</p>
                      <p className="truncate text-xs text-text-subtle">
                        <span className="text-text-muted">{t(`imageSource.${img.source}`)}</span>
                        {' · '}
                        <Estado img={img} state={st} />
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void optimizar([img])}
                      disabled={
                        !mejorable || running || st.kind === 'running' || st.kind === 'done'
                      }
                    >
                      {st.kind === 'running' ? t('imagenes.optimizing') : t('imagenes.optimizeOne')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function Estado({ img, state }: { img: AnalyzedImage; state: RowState }) {
  const t = useTranslations('adminMarca');
  if (state.kind === 'running') return <span>{t('imagenes.optimizing')}</span>;
  if (state.kind === 'done') {
    return (
      <span className="text-success-700">
        {t('imagenes.optimizedResult', {
          before: formatBytes(state.previousSize),
          after: formatBytes(state.size),
        })}
      </span>
    );
  }
  if (state.kind === 'error') return <span className="text-danger-700">{state.message}</span>;
  if (img.skipReason) {
    return (
      <span>
        {t(`skipReason.${SKIP_KEYS[img.skipReason]}`)}
        {img.currentSize !== null ? ` · ${formatBytes(img.currentSize)}` : ''}
      </span>
    );
  }
  return (
    <span>
      {formatBytes(img.currentSize ?? 0)} → {formatBytes(img.optimizedSize ?? 0)}
    </span>
  );
}

function Metrica({
  valor,
  etiqueta,
  detalle,
  formato = 'numero',
}: {
  valor: number | null;
  etiqueta: string;
  detalle?: string;
  formato?: 'numero' | 'bytes';
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="font-display text-2xl font-bold tracking-tight text-text">
          {valor === null ? (
            <span className="skeleton inline-block h-7 w-20" />
          ) : formato === 'bytes' ? (
            formatBytes(Math.max(0, valor))
          ) : (
            valor
          )}
        </div>
        <div className="mt-1 text-sm text-text-muted">{etiqueta}</div>
        {detalle ? <div className="mt-0.5 text-xs text-text-subtle">{detalle}</div> : null}
      </CardContent>
    </Card>
  );
}
