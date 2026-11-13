'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Image from 'next/image';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { authStorage } from '@/lib/auth-storage';
import { formatCents } from '@/lib/i18n/format';
import { parseAmount, simpleModeApi, suggestCurrency } from '@/lib/simple-mode';
import { useTenantContext } from '@/lib/tenant-context';
import { cn } from '@/lib/utils';

type Offer = 'course' | 'membership';

/**
 * Alta en 3 preguntas del MODO SENCILLO (sustituye al asistente de 12
 * pantallas): nombre de la academia, qué vende (curso o membresía, con su
 * nombre) y cuánto cuesta. Al terminar quedan creados el curso en borrador o
 * el plan, los espacios básicos y un post de bienvenida, y lleva a «Empieza
 * aquí». A la derecha (debajo en el móvil), cómo lo verán los alumnos.
 */
export function AltaSencilla() {
  const t = useTranslations('modoSencillo.alta');
  const locale = useLocale();
  const { tenant } = useTenantContext();
  const [host, setHost] = useState('');
  useEffect(() => setHost(window.location.host), []);
  const [paso, setPaso] = useState<1 | 2 | 3>(1);
  const [nombre, setNombre] = useState('');
  const [oferta, setOferta] = useState<Offer>('course');
  const [titulo, setTitulo] = useState('');
  const [importe, setImporte] = useState('');
  const [monedas, setMonedas] = useState<string[]>(['eur']);
  const [moneda, setMoneda] = useState('eur');
  const [error, setError] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);

  // Si el nombre del aula no es el autogenerado (el slug), se propone.
  useEffect(() => {
    if (tenant?.name && tenant.name !== tenant.slug && !nombre) setNombre(tenant.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant?.name]);

  useEffect(() => {
    simpleModeApi
      .currencies()
      .then((r) => {
        setMonedas(r.currencies);
        setMoneda(
          r.settlementCurrency ?? suggestCurrency(navigator.language || locale, r.currencies),
        );
      })
      .catch(() => undefined);
  }, [locale]);

  const cents = parseAmount(importe, moneda);
  const precio = cents ? formatCents(cents, moneda.toUpperCase()) : '';
  const tituloVisible = titulo.trim() || (oferta === 'course' ? t('tuCurso') : t('tuMembresia'));

  function siguiente(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    if (paso === 1) {
      if (!nombre.trim()) return setError(t('faltaNombre'));
      return setPaso(2);
    }
    if (paso === 2) return setPaso(3);
    void crear();
  }

  async function crear() {
    if (!cents) return setError(t('faltaPrecio'));
    setCreando(true);
    try {
      await simpleModeApi.quickStart({
        academyName: nombre.trim(),
        offer: oferta,
        title: titulo.trim() || undefined,
        amountCents: cents,
        currency: moneda,
        locale: locale.startsWith('en') ? 'en' : 'es',
      });
      // El servidor ya dio por hechos el perfil y el asistente: la sesión de la
      // pestaña lo refleja para que el shell no vuelva a mandar aquí.
      const session = authStorage.getSession();
      if (session) {
        session.user.onboardingCompletedAt =
          session.user.onboardingCompletedAt ?? new Date().toISOString();
        session.user.name = session.user.name ?? nombre.trim();
        authStorage.saveSession(session);
      }
      window.sessionStorage.setItem('didacta:academia-lista', '1');
      // Carga completa: la cabecera recoge el nombre nuevo de la academia (el
      // contexto del aula se cachea en memoria).
      window.location.assign('/start');
    } catch {
      setError(t('error'));
      setCreando(false);
    }
  }

  const nombreMoneda = useMemo(() => moneda.toUpperCase(), [moneda]);

  return (
    <div className="fixed inset-0 z-(--z-modal) grid overflow-auto bg-surface lg:grid-cols-2">
      <form
        onSubmit={siguiente}
        className="flex min-h-dvh flex-col px-5 pt-5 pb-8 lg:min-h-0 lg:px-16 lg:pt-8"
      >
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[15px] font-extrabold text-text-muted">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-[#1E5AA8]">
              <Image src="/brand/anagrama.png" alt="" width={14} height={14} />
            </span>
            Didacta
          </span>
          <span className="text-sm font-semibold text-text-subtle">
            {t('pregunta', { n: paso })}
          </span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-1.5" aria-hidden>
          {[1, 2, 3].map((n) => (
            <span
              key={n}
              className={cn('h-1.5 rounded-full', n <= paso ? 'bg-text' : 'bg-border')}
            />
          ))}
        </div>

        <div className="mt-9 w-full max-w-[520px] lg:mt-[12vh]">
          {paso === 1 ? (
            <>
              <h1 className="text-[30px] leading-tight font-extrabold tracking-tight text-text lg:text-[40px]">
                {t('q1')}
              </h1>
              <p className="mt-2 text-base text-text-muted">{t('q1Ayuda')}</p>
              <label htmlFor="alta-nombre" className="mt-7 block text-sm font-semibold text-text">
                {t('q1Label')}
              </label>
              <input
                id="alta-nombre"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder={t('q1Placeholder')}
                maxLength={120}
                className="mt-1.5 h-14 w-full rounded-xl border border-border bg-surface px-4 text-[19px] font-semibold text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
              />
              {host ? (
                <p className="mt-3 flex items-center gap-1.5 text-sm text-text-subtle">
                  <Icon name="globe" size={15} />
                  {t('direccion', { host: host.replace(/:\d+$/, '') })}
                </p>
              ) : null}
            </>
          ) : paso === 2 ? (
            <>
              <h1 className="text-[30px] leading-tight font-extrabold tracking-tight text-text lg:text-[40px]">
                {t('q2')}
              </h1>
              <p className="mt-2 text-base text-text-muted">{t('q2Ayuda')}</p>
              <div role="radiogroup" aria-label={t('q2')} className="mt-7 grid gap-3">
                {(['course', 'membership'] as const).map((o) => {
                  const on = oferta === o;
                  return (
                    <button
                      key={o}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setOferta(o)}
                      className={cn(
                        'grid grid-cols-[44px_1fr_22px] items-center gap-4 rounded-2xl border-[1.5px] p-4 text-left transition-colors',
                        on
                          ? 'border-text ring-4 ring-bg-subtle'
                          : 'border-border hover:border-border-strong',
                      )}
                    >
                      <span
                        className={cn(
                          'grid h-11 w-11 place-items-center rounded-xl',
                          on ? 'bg-text text-surface' : 'bg-bg-subtle text-text-muted',
                        )}
                      >
                        <Icon name={o === 'course' ? 'book' : 'calendar'} size={22} />
                      </span>
                      <span>
                        <span className="block text-base font-bold text-text">
                          {o === 'course' ? t('curso') : t('membresia')}
                        </span>
                        <span className="block text-sm text-text-muted">
                          {o === 'course' ? t('cursoAyuda') : t('membresiaAyuda')}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'h-[22px] w-[22px] rounded-full border-2',
                          on ? 'border-[7px] border-text' : 'border-border-strong',
                        )}
                      />
                    </button>
                  );
                })}
              </div>
              <label htmlFor="alta-titulo" className="mt-6 block text-sm font-semibold text-text">
                {oferta === 'course' ? t('tituloCurso') : t('tituloMembresia')}
              </label>
              <input
                id="alta-titulo"
                value={titulo}
                onChange={(e) => setTitulo(e.target.value)}
                placeholder={
                  oferta === 'course'
                    ? t('tituloPlaceholderCurso')
                    : t('tituloPlaceholderMembresia')
                }
                maxLength={160}
                className="mt-1.5 h-12 w-full rounded-xl border border-border bg-surface px-4 text-base text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
              />
            </>
          ) : (
            <>
              <h1 className="text-[30px] leading-tight font-extrabold tracking-tight text-text lg:text-[40px]">
                {t('q3')}
              </h1>
              <p className="mt-2 text-base text-text-muted">
                {oferta === 'course'
                  ? t('q3AyudaCurso', { titulo: tituloVisible })
                  : t('q3AyudaMembresia', { titulo: tituloVisible })}
              </p>
              <div className="mt-7 grid grid-cols-[minmax(0,1fr)_132px] gap-2.5">
                <div>
                  <label htmlFor="alta-importe" className="block text-sm font-semibold text-text">
                    {t('precio')}
                  </label>
                  <input
                    id="alta-importe"
                    inputMode="decimal"
                    value={importe}
                    onChange={(e) => setImporte(e.target.value)}
                    placeholder="49"
                    className="mt-1.5 h-16 w-full rounded-xl border border-border bg-surface px-4 text-[30px] font-extrabold tracking-tight text-text tabular-nums outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100"
                  />
                </div>
                <div>
                  <label htmlFor="alta-moneda" className="block text-sm font-semibold text-text">
                    {t('moneda')}
                  </label>
                  <select
                    id="alta-moneda"
                    value={moneda}
                    onChange={(e) => setMoneda(e.target.value)}
                    className="mt-1.5 h-16 w-full rounded-xl border border-border bg-surface px-3 text-base font-semibold text-text outline-none focus:border-brand-600"
                  >
                    {monedas.map((m) => (
                      <option key={m} value={m}>
                        {m.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="mt-3 text-sm text-text-muted">
                {t('monedaAyuda', { moneda: nombreMoneda })}
              </p>
              <details className="mt-4 rounded-xl bg-bg-subtle px-4">
                <summary className="flex h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-text-muted">
                  <Icon name="help" size={16} />
                  {t('cuantoQueda')}
                </summary>
                <p className="pb-4 text-sm text-text-muted">{t('cuantoQuedaTexto')}</p>
              </details>
            </>
          )}

          {error ? (
            <p role="alert" className="mt-4 text-sm font-semibold text-danger-700">
              {error}
            </p>
          ) : null}

          <div className="mt-8 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setPaso((p) => (p > 1 ? ((p - 1) as 1 | 2) : p))}
              className={cn(
                'flex h-13 items-center gap-1.5 text-[15px] font-semibold text-text-muted',
                paso === 1 && 'invisible',
              )}
            >
              <Icon name="arrow-left" size={16} />
              {t('atras')}
            </button>
            <button
              type="submit"
              disabled={creando}
              className="h-13 rounded-xl bg-text px-6 text-base font-bold text-surface transition-transform active:translate-y-px disabled:opacity-60"
            >
              {paso < 3 ? t('siguiente') : creando ? t('creando') : t('crear')}
            </button>
          </div>
        </div>
      </form>

      <aside
        className="flex items-center justify-center border-t border-border bg-bg-subtle p-5 lg:border-t-0 lg:border-l lg:p-12"
        aria-label={t('vista')}
      >
        <div className="w-full max-w-[440px]">
          <p className="mb-3 flex items-center gap-1.5 text-[13px] font-semibold text-text-subtle">
            <Icon name="eye" size={15} />
            {t('vista')}
          </p>
          <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-lg">
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#1E5AA8]">
                <Image src="/brand/anagrama.png" alt="" width={16} height={16} />
              </span>
              <strong className="truncate text-[15px] text-text">
                {nombre.trim() || t('q1Label')}
              </strong>
            </div>
            <div className="bg-bg-subtle p-4">
              <div className="overflow-hidden rounded-xl border border-border bg-surface">
                <div className="h-28 bg-[linear-gradient(135deg,hsl(var(--brand-h)_70%_88%),hsl(174_60%_86%))] lg:h-36" />
                <div className="p-3.5">
                  <strong className="block text-[17px] text-text">
                    {paso >= 2 ? tituloVisible : t('tuCurso')}
                  </strong>
                  <span className="text-[13px] text-text-subtle">
                    {oferta === 'course' ? t('pagoUnico') : t('alMes')}
                  </span>
                </div>
                <div className="flex items-center justify-between px-3.5 pb-3.5">
                  <span className="text-xl font-extrabold text-text tabular-nums">
                    {paso >= 3 && precio ? precio : t('precio')}
                  </span>
                  <span className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white">
                    {oferta === 'course' ? t('comprar') : t('unirme')}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
