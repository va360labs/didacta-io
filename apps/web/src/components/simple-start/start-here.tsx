'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { START_HERE_CHANGED_EVENT } from '@/components/simple-shell/simple-shell';
import { ApiHttpError } from '@/lib/api-client';
import { formatCents, formatDateTime } from '@/lib/i18n/format';
import {
  parseAmount,
  saleState,
  simpleModeApi,
  type StartHereView,
  type StepId,
} from '@/lib/simple-mode';
import { cn } from '@/lib/utils';

/** Primer paso pendiente: el único que se abre. `null` = todos hechos. */
export function currentStep(steps: StartHereView['steps']): StepId | null {
  return steps.find((s) => !s.done)?.id ?? null;
}

/** ¿Se puede publicar ya? Hace falta curso con lección, precio y cobros. */
export function canPublish(steps: StartHereView['steps']): boolean {
  const done = new Set(steps.filter((s) => s.done).map((s) => s.id));
  return done.has('course') && done.has('price') && done.has('payments');
}

/**
 * «Empieza aquí»: la pantalla de inicio del creador hasta su primera venta.
 * Seis pasos marcados con datos reales; solo el siguiente está abierto, con
 * una frase de lo que consigue, un botón y «¿Cómo funciona?». Tras la primera
 * venta pasa a ser «Inicio»: ventas, alumnos y próximo directo.
 */
export function StartHere() {
  const t = useTranslations('modoSencillo.empieza');
  const tS = useTranslations('modoSencillo');
  const [view, setView] = useState<StartHereView | null>(null);
  const [error, setError] = useState(false);
  const [origin, setOrigin] = useState('');

  const load = useCallback(async () => {
    try {
      setView(await simpleModeApi.startHere());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    await load();
    window.dispatchEvent(new Event(START_HERE_CHANGED_EVENT));
  }, [load]);

  if (error) return <p className="text-text-muted">{t('error')}</p>;
  if (!view) return <div className="skeleton h-96 w-full max-w-3xl" />;

  const sold = view.sales.count > 0;
  const pending = view.steps.filter((s) => !s.done).length;
  const doneCount = view.steps.length - pending;
  const current = currentStep(view.steps);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      <section className="min-w-0 max-w-[720px]" data-testid="empieza-aqui">
        <h1 className="text-[26px] leading-tight font-extrabold tracking-tight text-text lg:text-[30px]">
          {sold ? t('celebra') : pending === 0 ? t('tituloListo') : t('titulo')}
        </h1>
        {!sold && pending > 0 ? (
          <p className="mt-1.5 text-text-muted">{t('sub', { n: pending })}</p>
        ) : null}
        <div
          className="mt-5 flex items-center gap-3"
          aria-label={t('progresoAria', { done: doneCount, total: view.steps.length })}
        >
          <div className="grid max-w-[360px] flex-1 grid-cols-6 gap-1">
            {view.steps.map((s) => (
              <span
                key={s.id}
                className={cn('h-1.5 rounded-full', s.done ? 'bg-brand-600' : 'bg-border')}
              />
            ))}
          </div>
          <strong className="text-sm text-text tabular-nums">
            {tS('shell.pasosHechos', { done: doneCount, total: view.steps.length })}
          </strong>
        </div>

        {sold ? <Resumen view={view} /> : null}

        <ol className="mt-5">
          {view.steps.map((s, i) => (
            <Step
              key={s.id}
              n={i + 1}
              id={s.id}
              done={s.done}
              open={s.id === current}
              view={view}
              onChange={refresh}
            />
          ))}
        </ol>
      </section>

      <aside className="min-w-0 lg:sticky lg:top-[140px]">
        <SaleLinkCard view={view} origin={origin} />
      </aside>
    </div>
  );
}

// ── Un paso ────────────────────────────────────────────────────────────────

function Step({
  n,
  id,
  done,
  open,
  view,
  onChange,
}: {
  n: number;
  id: StepId;
  done: boolean;
  open: boolean;
  view: StartHereView;
  onChange: () => Promise<void>;
}) {
  const t = useTranslations('modoSencillo.empieza');
  const [editing, setEditing] = useState(false);
  const offer = view.offer;
  const precio =
    offer && offer.amountCents > 0
      ? formatCents(offer.amountCents, offer.currency.toUpperCase())
      : '';
  const courseHref = view.firstCourseId
    ? `/formador/cursos/${view.firstCourseId}`
    : '/formador/cursos/nuevo';
  const addLessonHref = view.firstCourseId ? `${courseHref}?anadir=1` : courseHref;

  const result: Record<StepId, string> = {
    academy: t('pasos.academy.hecho', { nombre: view.academyName }),
    course: t('pasos.course.hecho', { titulo: offer?.courseTitle ?? '' }),
    price: precio,
    payments: t('pasos.payments.hecho'),
    publish: t('pasos.publish.hecho'),
    invite: t('pasos.invite.hecho', { n: view.students }),
  };
  const editHref: Partial<Record<StepId, string>> = {
    academy: '/admin/configuracion',
    course: courseHref,
    payments: view.paymentsSetupPath,
    invite: '/admin/usuarios/invitar',
  };

  if (done && !(id === 'price' && editing)) {
    return (
      <li
        className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-2.5 first:border-t-0"
        data-step={id}
        data-done="1"
      >
        <span className="mx-0.5 grid h-7 w-7 place-items-center rounded-full bg-brand-600 text-white">
          <Icon name="check" size={15} />
        </span>
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-[15px] font-semibold text-text-muted">
            {t(`pasos.${id}.titulo`)}
          </span>
          <span className="truncate text-sm text-text-subtle">{result[id]}</span>
        </div>
        {id === 'price' ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-sm font-semibold text-brand-600 hover:underline"
          >
            {t('cambiar')}
          </button>
        ) : editHref[id] ? (
          <Link
            href={editHref[id]!}
            className="text-sm font-semibold text-brand-600 hover:underline"
          >
            {id === 'course' ? t('editar') : t('cambiar')}
          </Link>
        ) : (
          <span />
        )}
      </li>
    );
  }

  if (!open && !editing) {
    return (
      <li
        className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 border-t border-border py-4 first:border-t-0"
        data-step={id}
      >
        <span className="grid h-8 w-8 place-items-center rounded-full border-[1.5px] border-border bg-surface text-sm font-bold text-text-subtle tabular-nums">
          {n}
        </span>
        <div>
          <h3 className="text-base font-semibold text-text-subtle">{t(`pasos.${id}.titulo`)}</h3>
          <p className="text-sm text-text-subtle">{t(`pasos.${id}.que`)}</p>
        </div>
      </li>
    );
  }

  return (
    <li
      className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 border-t border-border pt-4 pb-5 first:border-t-0"
      data-step={id}
      aria-current="step"
    >
      <span className="grid h-8 w-8 place-items-center rounded-full border-[1.5px] border-brand-600 bg-surface text-sm font-bold text-brand-600 ring-4 ring-brand-50 tabular-nums">
        {n}
      </span>
      <div className="min-w-0">
        <h3 className="flex min-h-8 items-center text-base font-bold text-text">
          {t(`pasos.${id}.titulo`)}
        </h3>
        <div className="mt-1.5 rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <p className="max-w-[60ch] text-text-muted">{t(`pasos.${id}.que`)}</p>
          <StepAction
            id={id}
            view={view}
            courseHref={addLessonHref}
            onChange={onChange}
            onDone={() => setEditing(false)}
          />
          {id === 'payments' ? (
            <HowItWorks
              items={[
                t('pasos.payments.ayuda1'),
                t('pasos.payments.ayuda2'),
                t('pasos.payments.ayuda3'),
              ]}
            />
          ) : id === 'course' || id === 'academy' ? (
            <HowItWorks items={[t(`pasos.${id}.ayuda`)]} />
          ) : null}
        </div>
      </div>
    </li>
  );
}

function StepAction({
  id,
  view,
  courseHref,
  onChange,
  onDone,
}: {
  id: StepId;
  view: StartHereView;
  courseHref: string;
  onChange: () => Promise<void>;
  onDone: () => void;
}) {
  const t = useTranslations('modoSencillo.empieza');
  const primary =
    'mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-5 text-[15px] font-semibold text-white hover:bg-brand-700 disabled:opacity-50';
  if (id === 'academy')
    return (
      <Link href="/admin/configuracion" className={primary}>
        <Icon name="palette" size={18} />
        {t('pasos.academy.boton')}
      </Link>
    );
  if (id === 'course')
    return (
      <Link href={courseHref} className={primary}>
        <Icon name="plus" size={18} />
        {t('pasos.course.boton')}
      </Link>
    );
  if (id === 'payments')
    return (
      <Link href={view.paymentsSetupPath} className={primary}>
        <Icon name="briefcase" size={18} />
        {t('pasos.payments.boton')}
      </Link>
    );
  if (id === 'price')
    return (
      <PriceForm
        view={view}
        onSaved={async () => {
          await onChange();
          onDone();
        }}
      />
    );
  if (id === 'publish') return <PublishButton view={view} onChange={onChange} />;
  return (
    <Link href="/admin/usuarios/invitar" className={primary}>
      <Icon name="mail" size={18} />
      {t('pasos.invite.boton')}
    </Link>
  );
}

function HowItWorks({ items }: { items: string[] }) {
  const t = useTranslations('modoSencillo.empieza');
  return (
    <details className="group mt-4 rounded-xl bg-bg-subtle px-3.5">
      <summary className="flex h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-text-muted">
        <Icon name="help" size={16} />
        {t('comoFunciona')}
        <span className="ml-auto transition-transform group-open:rotate-180">
          <Icon name="chevron-down" size={14} />
        </span>
      </summary>
      <ul className="grid list-disc gap-1.5 pb-3.5 pl-5 text-sm text-text-muted">
        {items.map((it) => (
          <li key={it}>{it}</li>
        ))}
      </ul>
    </details>
  );
}

function PriceForm({ view, onSaved }: { view: StartHereView; onSaved: () => Promise<void> }) {
  const t = useTranslations('modoSencillo');
  const offer = view.offer;
  const [monedas, setMonedas] = useState<string[]>([offer?.currency ?? 'eur']);
  const [moneda, setMoneda] = useState(offer?.currency ?? 'eur');
  const [importe, setImporte] = useState(
    offer && offer.amountCents > 0 ? String(offer.amountCents / 100).replace('.', ',') : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    simpleModeApi
      .currencies()
      .then((r) => setMonedas(r.currencies))
      .catch(() => undefined);
  }, []);
  async function save() {
    const cents = parseAmount(importe, moneda);
    if (!cents) return setError(t('alta.faltaPrecio'));
    setSaving(true);
    try {
      await simpleModeApi.updatePrice({ amountCents: cents, currency: moneda });
      await onSaved();
    } catch {
      setError(t('curso.error'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="mt-4">
      <div className="grid max-w-[360px] grid-cols-[minmax(0,1fr)_110px] gap-2">
        <input
          aria-label={t('alta.precio')}
          inputMode="decimal"
          value={importe}
          onChange={(e) => setImporte(e.target.value)}
          className="h-12 rounded-xl border border-border bg-surface px-3 text-xl font-bold text-text tabular-nums outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
        />
        <select
          aria-label={t('alta.moneda')}
          value={moneda}
          onChange={(e) => setMoneda(e.target.value)}
          className="h-12 rounded-xl border border-border bg-surface px-2 font-semibold text-text"
        >
          {monedas.map((m) => (
            <option key={m} value={m}>
              {m.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      {error ? <p className="mt-2 text-sm text-danger-700">{error}</p> : null}
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="mt-3 inline-flex h-11 items-center rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {t('empieza.pasos.price.guardar')}
      </button>
    </div>
  );
}

function PublishButton({ view, onChange }: { view: StartHereView; onChange: () => Promise<void> }) {
  const t = useTranslations('modoSencillo.empieza');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = canPublish(view.steps);
  async function publish() {
    setBusy(true);
    setError(null);
    try {
      await simpleModeApi.publish();
      await onChange();
    } catch (e) {
      const code = e instanceof ApiHttpError ? e.code : undefined;
      const known = [
        'SIMPLE_MODE_PAYMENTS_NOT_READY',
        'SIMPLE_MODE_NO_LESSONS',
        'SIMPLE_MODE_NO_PRICE',
      ];
      setError(
        code && known.includes(code)
          ? t(`errores.${code}` as 'errores.generico')
          : t('errores.generico'),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <button
        type="button"
        onClick={publish}
        disabled={busy || !ready}
        data-testid="publicar"
        className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-5 text-[15px] font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
      >
        <Icon name="globe" size={18} />
        {busy ? t('pasos.publish.publicando') : t('pasos.publish.boton')}
      </button>
      {!ready ? (
        <p className="mt-2 text-sm text-text-subtle">{t('pasos.publish.faltaAntes')}</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm font-semibold text-danger-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ── Enlace de venta ────────────────────────────────────────────────────────

/** Ruta del enlace de venta: la publicada o, si aún no, la que tendrá. */
export function plannedSalePath(view: StartHereView): string | null {
  if (view.salePath) return view.salePath;
  if (view.offer?.kind === 'membership') return '/unete';
  return view.offer?.courseSlug ? `/catalogo/${view.offer.courseSlug}` : null;
}

function SaleLinkCard({ view, origin }: { view: StartHereView; origin: string }) {
  const t = useTranslations('modoSencillo');
  const [copied, setCopied] = useState(false);
  const published = view.salePath !== null;
  // Publicado no basta: sin cobros conectados nadie puede pagar.
  const state = saleState(view);
  const onSale = state === 'on-sale';
  const path = plannedSalePath(view);
  const url = path ? `${origin}${path}` : '';
  const offer = view.offer;
  const precio =
    offer && offer.amountCents > 0
      ? formatCents(offer.amountCents, offer.currency.toUpperCase())
      : '';
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
      className="rounded-2xl border border-border bg-surface p-4 shadow-sm"
      data-testid="enlace-venta"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-bold whitespace-nowrap text-text">
          {t('empieza.enlace.titulo')}
        </h2>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap',
            onSale
              ? 'bg-success-50 text-success-700'
              : state === 'not-purchasable'
                ? 'bg-warning-50 text-warning-700'
                : 'bg-bg-subtle text-text-subtle',
          )}
        >
          <Icon name={onSale ? 'globe' : 'lock'} size={12} />
          {onSale
            ? t('empieza.enlace.aLaVenta')
            : state === 'not-purchasable'
              ? t('empieza.enlace.noComprable')
              : t('empieza.enlace.sinPublicar')}
        </span>
      </div>
      {url ? (
        <div
          className={cn(
            'mt-3 flex h-12 min-w-0 items-center gap-2 rounded-xl border px-3 text-[15px]',
            onSale
              ? 'border-border bg-bg-subtle text-text'
              : 'border-dashed border-border-strong bg-bg-subtle text-text-subtle',
          )}
          data-testid="enlace-url"
        >
          <Icon name={onSale ? 'link' : 'lock'} size={16} />
          <span className="truncate">{url.replace(/^https?:\/\//, '')}</span>
        </div>
      ) : null}
      {offer ? (
        <div className="mt-3 overflow-hidden rounded-xl border border-border">
          <div className="h-24 bg-[linear-gradient(135deg,hsl(var(--brand-h)_70%_88%),hsl(174_60%_86%))]" />
          <div className="flex items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <strong className="block truncate text-[15px] text-text">
                {offer.courseTitle ?? view.academyName}
              </strong>
              <span className="text-[13px] text-text-subtle">
                {offer.kind === 'course' ? t('alta.pagoUnico') : t('alta.alMes')}
              </span>
            </div>
            <span className="text-lg font-extrabold text-text tabular-nums">{precio}</span>
          </div>
        </div>
      ) : null}
      <div className="mt-3 grid gap-2">
        <button
          type="button"
          onClick={copy}
          disabled={!onSale}
          data-testid="copiar-enlace"
          className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-brand-600 px-3 text-[15px] font-semibold text-white hover:bg-brand-700 disabled:bg-bg-subtle disabled:text-text-disabled"
        >
          <Icon name="link" size={15} />
          {copied ? t('empieza.enlace.copiado') : t('empieza.enlace.copiar')}
        </button>
        {asStudent ? (
          <a
            href={asStudent}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-[15px] font-semibold text-text hover:border-border-strong"
          >
            <Icon name="eye" size={15} />
            {t('empieza.enlace.verAlumno')}
          </a>
        ) : null}
      </div>
      <p className="mt-2.5 text-[13px] text-text-subtle">
        {onSale
          ? t('empieza.enlace.notaDespues')
          : state === 'not-purchasable'
            ? t('empieza.enlace.notaNoComprable')
            : t('empieza.enlace.notaAntes')}
      </p>
    </section>
  );
}

// ── Tras la primera venta ──────────────────────────────────────────────────

function Resumen({ view }: { view: StartHereView }) {
  const t = useTranslations('modoSencillo.empieza');
  return (
    <div className="mt-6 grid gap-3">
      <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-border bg-surface sm:grid-cols-3">
        <div className="col-span-2 border-b border-border p-4 sm:col-span-1 sm:border-r sm:border-b-0">
          <div className="text-sm font-semibold text-text-muted">{t('resumen.ventas')}</div>
          <div className="mt-0.5 text-[28px] font-extrabold tracking-tight text-text tabular-nums">
            {view.sales.count}
          </div>
          <Link
            href="/admin/cobros"
            className="text-sm font-semibold text-brand-600 hover:underline"
          >
            {t('resumen.verVentas')}
          </Link>
        </div>
        <div className="border-r border-border p-4">
          <div className="text-sm font-semibold text-text-muted">{t('resumen.alumnos')}</div>
          <div className="mt-0.5 text-[28px] font-extrabold tracking-tight text-text tabular-nums">
            {view.students}
          </div>
        </div>
        <div className="p-4">
          <div className="text-sm font-semibold text-text-muted">{t('resumen.proximo')}</div>
          {view.nextLive ? (
            <div className="mt-1 text-sm text-text">
              <strong className="block truncate">{view.nextLive.topic}</strong>
              <span className="text-text-subtle">
                {formatDateTime(view.nextLive.startTime, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
            </div>
          ) : (
            <Link
              href="/formador/aula-virtual"
              className="mt-1 block text-sm font-semibold text-brand-600 hover:underline"
            >
              {t('resumen.programar')}
            </Link>
          )}
        </div>
      </div>
      {/* Referidos para todo: sugerencia en cuanto hay CUALQUIER cosa a la venta
          (curso suelto o membresía), no solo con membresía. */}
      {saleState(view) === 'on-sale' ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-2xl border border-brand-100 bg-brand-50/60 p-4"
          data-testid="empieza-sugerencia-referidos"
        >
          <span className="grid h-9 w-9 place-items-center rounded-full bg-brand-600 text-white">
            <Icon name="sparkles" size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <strong className="block text-[15px] text-text">{t('referidos.titulo')}</strong>
            <span className="text-sm text-text-muted">{t('referidos.texto')}</span>
          </div>
          <Link
            href="/admin/cobros#referidos"
            className="inline-flex h-10 items-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
          >
            {t('referidos.boton')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
