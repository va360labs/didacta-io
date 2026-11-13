'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PaymentsConnectCard } from '@/components/admin/payments-connect-card';
import { Icon } from '@/components/icon';
import { START_HERE_CHANGED_EVENT } from '@/components/simple-shell/simple-shell';
import { adminModulesApi } from '@/lib/admin-modules';
import { authStorage } from '@/lib/auth-storage';
import { formatCents, formatDate } from '@/lib/i18n/format';
import { meApi } from '@/lib/me';
import {
  derivePayoutsCardView,
  feePercent,
  formatStripeAmount,
  payoutsApi,
  saleStatusView,
  type PayoutsSaleDto,
  type PayoutsStatusDto,
  type PayoutsSummaryDto,
} from '@/lib/payouts';
import { referralsAdminApi, type AdminCommissionRow, type ReferralsConfig } from '@/lib/referrals';
import { CashPayoutsAdmin } from './cash-payouts-admin';
import { fetchTenantContext } from '@/lib/tenant-context';
import { getPublicCatalog } from '@/lib/catalog';
import { parseAmount, saleState, simpleModeApi, type StartHereView } from '@/lib/simple-mode';
import { cn } from '@/lib/utils';
import { bpsToPercentInput, percentToBps, primaryCurrency, referralSales } from './sales-math';

const TONE: Record<string, string> = {
  neutral: 'bg-bg-subtle text-text-muted',
  info: 'bg-brand-50 text-brand-700',
  success: 'bg-success-50 text-success-700',
  warning: 'bg-warning-50 text-warning-700',
  danger: 'bg-danger-50 text-danger-700',
};

/**
 * «Ventas» del MODO SENCILLO: lo vendido y lo que llega al banco, el enlace de
 * venta con su precio, las últimas ventas y los referidos («Tus alumnos venden
 * por ti»). Todo con datos reales de cobros (`mod.payouts`), del modo sencillo
 * y del programa de referidos; lo técnico sigue en la vista completa
 * (`?completo=1` en la misma ruta).
 *
 * `platform`: Didacta Cloud cobra por la plataforma (/admin/cobros).
 * `own`: el aula cobra con su propia cuenta (/admin/membresia sin cobros de
 * plataforma): no hay resumen de cobros, solo enlace, precio y referidos.
 */
export function SimpleSales({
  mode,
  completeHref,
  returnAction = null,
  onReturnHandled,
}: {
  mode: 'platform' | 'own';
  /** La vista completa de la misma ruta. */
  completeHref: string;
  returnAction?: 'sync' | 'renew' | null;
  onReturnHandled?: () => void;
}) {
  const t = useTranslations('modoSencilloVentas');
  const tPagos = useTranslations('adminPagos.payouts.sales');
  const [view, setView] = useState<StartHereView | null>(null);
  const [status, setStatus] = useState<PayoutsStatusDto | null>(null);
  const [summary, setSummary] = useState<PayoutsSummaryDto | null>(null);
  const [sales, setSales] = useState<PayoutsSaleDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const [v, st, sum, page] = await Promise.all([
        simpleModeApi.startHere(),
        mode === 'platform' ? payoutsApi.status().catch(() => null) : Promise.resolve(null),
        mode === 'platform' ? payoutsApi.summary().catch(() => null) : Promise.resolve(null),
        mode === 'platform' ? payoutsApi.sales(1, 6).catch(() => null) : Promise.resolve(null),
      ]);
      setView(v);
      setStatus(st);
      setSummary(sum);
      setSales(page?.items ?? []);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoaded(true);
    }
  }, [mode]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded) return <div className="skeleton h-96 w-full max-w-4xl" />;
  if (error || !view) return <p className="text-text-muted">{t('error')}</p>;

  const headline = primaryCurrency(summary);
  // Con la plataforma encendida, un aula que pegó sus claves (`own-keys`)
  // también cobra: no se le pide conectar nada.
  const cardKind = mode === 'own' ? 'own-keys' : derivePayoutsCardView(status).kind;
  const ready = cardKind === 'ready' || cardKind === 'own-keys';

  return (
    <div className="mx-auto max-w-[1080px]" data-testid="ventas-sencillo">
      <h1 className="text-[26px] leading-tight font-extrabold tracking-tight text-text lg:text-[30px]">
        {t('titulo')}
      </h1>
      <p className="mt-1.5 text-text-muted">{t('sub')}</p>

      {/* Dos columnas: a la izquierda cobros, resumen y ventas; a la derecha,
          en la misma fila, el enlace de venta y el precio. */}
      <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-5">
          {/* Cobros: si no están listos, lo primero es conectarlos. */}
          {mode === 'platform' && !ready ? (
            <section>
              <h2 className="text-base font-bold text-text">{t('cobros.conectarTitulo')}</h2>
              <p className="mt-1 text-sm text-text-muted">{t('cobros.conectarTexto')}</p>
              <div className="mt-3">
                <PaymentsConnectCard
                  whenPlatformOff={null}
                  returnAction={returnAction}
                  onReturnHandled={() => {
                    onReturnHandled?.();
                    void load();
                    // Al volver de Stripe los cobros pueden quedar listos: el
                    // contador de «Empieza aquí» de la barra se queda viejo si
                    // no se le avisa.
                    window.dispatchEvent(new Event(START_HERE_CHANGED_EVENT));
                  }}
                />
              </div>
            </section>
          ) : (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="grid h-5 w-5 place-items-center rounded-full bg-success-50 text-success-700">
                  <Icon name="check" size={12} />
                </span>
                {cardKind === 'ready' ? t('cobros.listos') : t('cobros.propios')}
              </span>
              <Link href={completeHref} className="font-semibold text-brand-600 hover:underline">
                {t('cobros.detalles')}
              </Link>
            </p>
          )}
          {/* Resumen o estado vacío (solo con cobros de plataforma hay cifras). */}
          {mode === 'platform' ? (
            headline ? (
              <section
                aria-label={t('resumen.vendido')}
                className="grid grid-cols-2 overflow-hidden rounded-2xl border border-border bg-surface lg:grid-cols-3"
              >
                <div className="col-span-2 border-b border-border p-4 lg:col-span-1 lg:border-r lg:border-b-0 lg:p-5">
                  <div className="text-sm font-semibold text-text-muted">
                    {t('resumen.vendido')}
                  </div>
                  <div className="mt-0.5 text-[28px] font-extrabold tracking-tight text-text tabular-nums">
                    {formatStripeAmount(headline.gross, headline.currency)}
                  </div>
                  <div className="text-[13px] text-text-subtle">
                    {t('resumen.ventas', { n: headline.salesCount })}
                  </div>
                </div>
                <div className="border-r border-border p-4 lg:p-5">
                  <div className="text-sm font-semibold text-text-muted">
                    {t('resumen.enBanco')}
                  </div>
                  <div className="mt-0.5 text-[21px] font-extrabold tracking-tight text-text tabular-nums lg:text-[28px]">
                    {formatStripeAmount(headline.received, headline.currency)}
                  </div>
                </div>
                <div className="p-4 lg:p-5">
                  <div className="text-sm font-semibold text-text-muted">
                    {t('resumen.enCamino')}
                  </div>
                  <div className="mt-0.5 text-[21px] font-extrabold tracking-tight text-text tabular-nums lg:text-[28px]">
                    {formatStripeAmount(headline.pending, headline.currency)}
                  </div>
                  <div className="text-[13px] text-text-subtle">{t('resumen.enCaminoNota')}</div>
                </div>
              </section>
            ) : (
              <section className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border-strong bg-surface p-6 sm:flex-row sm:items-center">
                <span
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700"
                  aria-hidden
                >
                  <Icon name="briefcase" size={22} />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-bold text-text">{t('vacio.titulo')}</h2>
                  <p className="mt-0.5 max-w-[60ch] text-sm text-text-muted">{t('vacio.texto')}</p>
                </div>
                {!ready ? null : view.salePath ? (
                  <a
                    href="#enlace"
                    className="inline-flex h-10 items-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
                  >
                    {t('vacio.botonCompartir')}
                  </a>
                ) : (
                  <Link
                    href="/empieza"
                    className="inline-flex h-10 items-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
                  >
                    {t('vacio.botonPublicar')}
                  </Link>
                )}
              </section>
            )
          ) : null}
          {mode === 'platform' && sales.length > 0 ? (
            <section
              className="min-w-0 rounded-2xl border border-border bg-surface"
              aria-label={t('lista.titulo')}
            >
              <div className="flex items-center justify-between px-4 pt-4 pb-1">
                <h2 className="text-base font-bold text-text">{t('lista.titulo')}</h2>
                <Link
                  href={completeHref}
                  className="text-sm font-bold text-brand-600 hover:underline"
                >
                  {t('lista.verTodas')}
                </Link>
              </div>
              <ul>
                {sales.map((s) => {
                  const st = saleStatusView(s);
                  return (
                    <li
                      key={s.id}
                      className="flex items-center gap-3 border-t border-border-soft px-4 py-3 first:border-t-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold text-text">
                          {s.description ?? t('lista.sinDescripcion')}
                        </div>
                        {s.chargedAt ? (
                          <div className="text-[13px] text-text-subtle">
                            {formatDate(s.chargedAt, { dateStyle: 'medium' })}
                          </div>
                        ) : null}
                      </div>
                      <div className="text-right">
                        <div className="font-bold text-text tabular-nums">
                          {formatStripeAmount(s.presentmentAmount, s.presentmentCurrency)}
                        </div>
                        <span
                          className={cn(
                            'mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold',
                            TONE[st.tone],
                          )}
                        >
                          {tPagos(`status.${st.key}`)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : mode !== 'platform' && view ? (
            // Con la cuenta de pagos propia no hay lista de cobros de la
            // plataforma: el número de ventas real (pedidos pagados y
            // suscripciones) y el detalle en el panel de negocio.
            <section
              className="min-w-0 rounded-2xl border border-border bg-surface p-5"
              aria-label={t('propias.titulo')}
            >
              <div className="text-sm font-semibold text-text-muted">{t('propias.titulo')}</div>
              <div className="mt-1 text-[32px] leading-none font-extrabold tracking-tight text-text tabular-nums">
                {view.sales.count}
              </div>
              <p className="mt-2 max-w-[52ch] text-sm text-text-muted">
                {view.sales.count > 0 ? t('propias.texto') : t('propias.vacio')}
              </p>
              <Link
                href="/admin?tab=negocio"
                className="mt-3 inline-block text-sm font-bold text-brand-600 hover:underline"
              >
                {t('propias.detalle')}
              </Link>
            </section>
          ) : null}
        </div>

        <SaleLinkCard
          view={view}
          feeBps={summary?.feeBps ?? status?.feeBps ?? null}
          onPriceChanged={load}
        />
      </div>

      <ReferralsSection />
    </div>
  );
}

// ── Enlace y precio ────────────────────────────────────────────────────────

function SaleLinkCard({
  view,
  feeBps,
  onPriceChanged,
}: {
  view: StartHereView;
  feeBps: number | null;
  onPriceChanged: () => Promise<void>;
}) {
  const t = useTranslations('modoSencilloVentas.enlace');
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const offer = view.offer;
  const published = view.salePath !== null;
  // Publicado no basta: sin cobros conectados nadie puede pagar.
  const state = saleState(view);
  const onSale = state === 'on-sale';
  const path =
    view.salePath ??
    (offer?.kind === 'membership'
      ? '/unete'
      : offer?.courseSlug
        ? `/catalogo/${offer.courseSlug}`
        : null);
  const url = path ? `${origin}${path}` : '';
  const asStudent = published ? path : offer?.courseSlug ? `/cursos/${offer.courseSlug}` : null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* el enlace sigue a la vista */
    }
  }

  return (
    <section
      id="enlace"
      className="rounded-2xl border border-border bg-surface p-4"
      aria-label={t('titulo')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold whitespace-nowrap text-text">{t('titulo')}</h2>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap',
            onSale
              ? 'bg-success-50 text-success-700'
              : state === 'not-purchasable'
                ? 'bg-warning-50 text-warning-700'
                : 'bg-bg-subtle text-text-subtle',
          )}
          data-testid="estado-venta"
        >
          <Icon name={onSale ? 'globe' : 'lock'} size={12} />
          {onSale
            ? t('aLaVenta')
            : state === 'not-purchasable'
              ? t('noComprable')
              : t('sinPublicar')}
        </span>
      </div>
      {url ? (
        <div className="mt-3 flex h-12 min-w-0 items-center gap-2 rounded-xl border border-border bg-bg-subtle px-3 text-[15px] text-text">
          <Icon name={onSale ? 'link' : 'lock'} size={16} />
          <span className="truncate">{url.replace(/^https?:\/\//, '')}</span>
        </div>
      ) : null}
      {state === 'not-purchasable' ? (
        <p className="mt-2 text-[13px] text-warning-700">{t('notaNoComprable')}</p>
      ) : null}
      <div className="mt-3 grid gap-2">
        <button
          type="button"
          onClick={copy}
          disabled={!onSale}
          className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-brand-600 px-3 text-[15px] font-semibold text-white hover:bg-brand-700 disabled:bg-bg-subtle disabled:text-text-disabled"
        >
          <Icon name="link" size={15} />
          {copied ? t('copiado') : t('copiar')}
        </button>
        {asStudent ? (
          <a
            href={asStudent}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-[15px] font-semibold text-text hover:border-border-strong"
          >
            <Icon name="eye" size={15} />
            {t('verAlumno')}
          </a>
        ) : null}
      </div>
      {!published ? <p className="mt-2 text-[13px] text-text-subtle">{t('notaAntes')}</p> : null}

      {offer ? (
        <div className="mt-4 border-t border-border pt-4">
          {editing ? (
            <PriceForm
              view={view}
              onCancel={() => setEditing(false)}
              onSaved={async () => {
                setEditing(false);
                await onPriceChanged();
              }}
            />
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm text-text-muted">{t('precio')}</div>
                <div className="font-bold text-text tabular-nums">
                  {offer.amountCents > 0
                    ? formatCents(offer.amountCents, offer.currency.toUpperCase())
                    : '-'}{' '}
                  <span className="font-normal text-text-muted">
                    {offer.kind === 'course' ? t('pagoUnico') : t('alMes')}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-sm font-bold text-brand-600 hover:underline"
              >
                {t('cambiar')}
              </button>
            </div>
          )}
          {feeBps !== null ? (
            <p className="mt-3 text-[13px] text-text-subtle">
              {t('comision', { percent: feePercent(feeBps) })}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PriceForm({
  view,
  onCancel,
  onSaved,
}: {
  view: StartHereView;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('modoSencilloVentas.enlace');
  const offer = view.offer!;
  const [currencies, setCurrencies] = useState<string[]>([offer.currency]);
  const [currency, setCurrency] = useState(offer.currency);
  const [amount, setAmount] = useState(
    offer.amountCents > 0 ? String(offer.amountCents / 100).replace('.', ',') : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    simpleModeApi
      .currencies()
      .then((r) => setCurrencies(r.currencies))
      .catch(() => undefined);
  }, []);
  async function save() {
    const cents = parseAmount(amount, currency);
    if (!cents) return setError(t('precioInvalido'));
    setSaving(true);
    setError(null);
    try {
      await simpleModeApi.updatePrice({ amountCents: cents, currency });
      await onSaved();
    } catch {
      setError(t('precioError'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-2">
        <input
          aria-label={t('precio')}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="h-11 rounded-xl border border-border bg-surface px-3 text-lg font-bold text-text tabular-nums outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
        />
        <select
          aria-label={t('precio')}
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          className="h-11 rounded-xl border border-border bg-surface px-2 font-semibold text-text"
        >
          {currencies.map((c) => (
            <option key={c} value={c}>
              {c.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      {error ? <p className="mt-2 text-sm text-danger-700">{error}</p> : null}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex h-10 items-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {t('guardar')}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-semibold text-text-muted">
          {t('cancelar')}
        </button>
      </div>
    </div>
  );
}

// ── Referidos ──────────────────────────────────────────────────────────────

function ReferralsSection() {
  const t = useTranslations('modoSencilloVentas.referidos');
  const [moduleOn, setModuleOn] = useState<boolean | null>(null);
  // El programa paga comisión por TODO lo que se vende (cuotas de la membresía
  // y cursos sueltos). Sin nada a la venta, los enlaces de los alumnos no
  // llevarían a ninguna página que venda: no se enseña como activo.
  const [somethingOnSale, setSomethingOnSale] = useState<boolean | null>(null);
  const [config, setConfig] = useState<ReferralsConfig | null>(null);
  const [rows, setRows] = useState<AdminCommissionRow[]>([]);
  const [percent, setPercent] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const token = authStorage.getAccessToken();
    const mods = token ? await meApi.getMyModules(token).catch(() => null) : null;
    const on = mods ? mods.activeModules.includes('mod.referrals') : false;
    const [ctx, catalog] = await Promise.all([
      fetchTenantContext().catch(() => null),
      getPublicCatalog().catch(() => ({ courses: [] })),
    ]);
    setSomethingOnSale(ctx?.tenant?.membershipPageActive === true || catalog.courses.length > 0);
    setModuleOn(on);
    if (!on) return;
    const [cfg, list] = await Promise.all([
      referralsAdminApi.getConfig().catch(() => null),
      referralsAdminApi.listCommissions().catch(() => null),
    ]);
    setConfig(cfg);
    if (cfg) setPercent(bpsToPercentInput(cfg.commissionBps));
    setRows(list?.commissions ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function turnOn() {
    setBusy(true);
    setMessage(null);
    try {
      if (!moduleOn) {
        await adminModulesApi.enable('mod.referrals');
        window.dispatchEvent(new Event('didacta:modules-changed'));
      }
      await referralsAdminApi.updateConfig({ active: true });
      await load();
    } catch {
      setMessage({ ok: false, text: t('error') });
    } finally {
      setBusy(false);
    }
  }

  async function save(active: boolean) {
    const bps = percentToBps(percent);
    if (bps === null) return setMessage({ ok: false, text: t('porcentajeInvalido') });
    setBusy(true);
    setMessage(null);
    try {
      setConfig(await referralsAdminApi.updateConfig({ active, commissionBps: bps }));
      setMessage({ ok: true, text: t('guardado') });
    } catch {
      setMessage({ ok: false, text: t('error') });
    } finally {
      setBusy(false);
    }
  }

  if (moduleOn === null || somethingOnSale === null) return null;
  if (!somethingOnSale) {
    return (
      <section
        id="referidos"
        className="mt-8 scroll-mt-32 flex flex-wrap items-start gap-4 rounded-2xl border border-dashed border-border-strong bg-surface p-5"
        aria-label={t('titulo')}
        data-testid="referidos-nada-a-la-venta"
      >
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-bg-subtle text-text-muted"
          aria-hidden
        >
          <Icon name="sparkles" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-text">{t('titulo')}</h2>
          <p className="mt-1 max-w-[62ch] text-sm text-text-muted">{t('nadaALaVenta')}</p>
        </div>
      </section>
    );
  }
  const traidas = referralSales(rows);
  const active = Boolean(moduleOn && config?.active);

  async function toggleCredit(allowCreditRedemption: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      setConfig(await referralsAdminApi.updateConfig({ allowCreditRedemption }));
      setMessage({ ok: true, text: t('guardado') });
    } catch {
      setMessage({ ok: false, text: t('error') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      id="referidos"
      className="mt-8 scroll-mt-32 rounded-2xl border border-border bg-surface p-5"
      aria-label={t('titulo')}
    >
      <div className="flex flex-wrap items-start gap-4">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-600 text-white"
          aria-hidden
        >
          <Icon name="sparkles" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold text-text">{t('titulo')}</h2>
            {moduleOn && config ? (
              <span
                className={cn(
                  'rounded-full px-2.5 py-0.5 text-xs font-bold',
                  active ? 'bg-success-50 text-success-700' : 'bg-bg-subtle text-text-subtle',
                )}
              >
                {active ? t('activo') : t('inactivo')}
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-[65ch] text-sm text-text-muted">{t('texto')}</p>
        </div>
      </div>

      {!active && !(moduleOn && config) ? (
        <button
          type="button"
          onClick={turnOn}
          disabled={busy}
          className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Icon name="sparkles" size={17} />
          {busy ? t('activando') : t('activar')}
        </button>
      ) : (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="ref-pct" className="block text-sm font-semibold text-text">
              {t('porcentaje')}
            </label>
            <input
              id="ref-pct"
              inputMode="decimal"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              className="mt-1.5 h-11 w-28 rounded-xl border border-border bg-surface px-3 text-lg font-bold text-text tabular-nums outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
            />
          </div>
          <button
            type="button"
            onClick={() => void save(active)}
            disabled={busy}
            className="inline-flex h-11 items-center rounded-xl bg-brand-600 px-4 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {t('guardar')}
          </button>
          <button
            type="button"
            onClick={() => void save(!active)}
            disabled={busy}
            className="inline-flex h-11 items-center rounded-xl border border-border bg-surface px-4 font-semibold text-text hover:border-border-strong disabled:opacity-50"
          >
            {active ? t('apagar') : t('encender')}
          </button>
        </div>
      )}
      {moduleOn && config ? (
        <div
          className="mt-4 flex max-w-[65ch] items-start gap-3 rounded-xl border border-border p-3"
          data-testid="referidos-opcion-descuento"
        >
          <input
            id="ref-descuento"
            type="checkbox"
            checked={config.allowCreditRedemption !== false}
            disabled={busy}
            onChange={(e) => void toggleCredit(e.target.checked)}
            aria-describedby="ref-descuento-texto"
            className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-brand-600"
          />
          <div className="min-w-0">
            <label
              htmlFor="ref-descuento"
              className="block cursor-pointer text-sm font-semibold text-text"
            >
              {t('descuentoTitulo')}
            </label>
            <p id="ref-descuento-texto" className="text-sm text-text-muted">
              {t('descuentoTexto')}
            </p>
          </div>
        </div>
      ) : null}
      {message ? (
        <p
          role="status"
          className={cn(
            'mt-2 text-sm font-semibold',
            message.ok ? 'text-success-700' : 'text-danger-700',
          )}
        >
          {message.text}
        </p>
      ) : null}

      {moduleOn && config ? (
        <div className="mt-6 border-t border-border pt-4">
          <h3 className="text-base font-bold text-text">{t('ventasTitulo')}</h3>
          {traidas.count === 0 ? (
            <p className="mt-1 text-sm text-text-muted">{t('ventasVacio')}</p>
          ) : (
            <>
              <p className="mt-1 text-sm text-text-muted">
                {t('ventasResumen', { n: traidas.count })}
                {traidas.byCurrency
                  .map((c) => ` · ${formatCents(c.base, c.currency.toUpperCase())}`)
                  .join('')}
              </p>
              <ul className="mt-2">
                {rows.slice(0, 5).map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-3 border-t border-border-soft py-2.5 text-sm first:border-t-0"
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold text-text">
                        {r.kind === 'ADJUSTMENT'
                          ? t('ajuste')
                          : r.kind === 'CREDIT_RETURN'
                            ? t('saldoDevuelto')
                            : t('pago', {
                                base: formatCents(r.baseAmountCents, r.currency.toUpperCase()),
                              })}
                      </span>
                      <span className="text-[13px] text-text-subtle">
                        {formatDate(r.createdAt, { dateStyle: 'medium' })} ·{' '}
                        {t('comisionDe', {
                          amount: formatCents(r.amountCents, r.currency.toUpperCase()),
                        })}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] font-bold text-text-muted">
                      {t(`estado.${r.status}`)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <Link
            href="/admin/referidos"
            className="mt-3 inline-block text-sm font-semibold text-brand-600 hover:underline"
          >
            {t('verDetalle')}
          </Link>
        </div>
      ) : null}
      {moduleOn && config ? <CashPayoutsAdmin /> : null}
    </section>
  );
}
