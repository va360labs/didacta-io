'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Cuando alguien quiere irse»: qué se le ofrece a quien pulsa «Darme de
 * baja». Una sola tarjeta para el modo sencillo (Ajustes) y el completo
 * (Membresía): la misma API (`/membership/admin/retention`), sin duplicar.
 *
 * El motivo se pregunta siempre; aquí solo se decide la oferta: pausa (con
 * meses máximos) y descuento (% y meses). Los desplegables limitan a valores
 * con sentido; la API vuelve a comprobar los límites.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Switch } from '@/components/ui/switch';
import {
  DISCOUNT_MONTH_OPTIONS,
  DISCOUNT_PERCENT_OPTIONS,
  PAUSE_MAX_OPTIONS,
  retentionApi,
  type RetentionConfig,
} from '@/lib/retention';

const SELECT =
  'h-11 rounded-xl border border-border bg-surface px-3 text-[15px] font-semibold text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100 disabled:opacity-50';

export function RetentionSettingsCard({ id }: { id?: string }) {
  const t = useTranslations('bajaRetencion.ajustes');
  const [config, setConfig] = useState<RetentionConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    retentionApi
      .get()
      .then(setConfig)
      .catch(() => setError(t('error')));
  }, [t]);

  function change(patch: Partial<RetentionConfig>) {
    setConfig((c) => (c ? { ...c, ...patch } : c));
    setSaved(false);
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      setConfig(await retentionApi.update(config));
      setSaved(true);
    } catch {
      setError(t('error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      id={id}
      className="rounded-2xl border border-border bg-surface p-4 sm:p-6"
      data-testid="retencion-ajustes"
    >
      <h2 className="text-lg font-bold text-text">{t('titulo')}</h2>
      <p className="mt-1 max-w-[60ch] text-sm text-text-muted">{t('texto')}</p>

      {config === null && !error ? <div className="skeleton mt-4 h-28 w-full" /> : null}

      {config ? (
        <div className="mt-5 space-y-6">
          <div>
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="retencion-pausa" className="font-semibold text-text">
                {t('pausa')}
              </label>
              <Switch
                id="retencion-pausa"
                checked={config.pauseEnabled}
                onCheckedChange={(v) => change({ pauseEnabled: v })}
                label={t('pausa')}
                data-testid="retencion-pausa"
              />
            </div>
            <p className="mt-1 max-w-[60ch] text-sm text-text-subtle">{t('pausaAyuda')}</p>
            <div className="mt-3 flex items-center gap-3">
              <label htmlFor="retencion-pausa-max" className="text-sm font-semibold text-text">
                {t('pausaMax')}
              </label>
              <select
                id="retencion-pausa-max"
                value={config.pauseMaxMonths}
                disabled={!config.pauseEnabled}
                onChange={(e) => change({ pauseMaxMonths: Number(e.target.value) })}
                className={SELECT}
              >
                {PAUSE_MAX_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {t('meses', { n: m })}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="retencion-descuento" className="font-semibold text-text">
                {t('descuento')}
              </label>
              <Switch
                id="retencion-descuento"
                checked={config.discountEnabled}
                onCheckedChange={(v) => change({ discountEnabled: v })}
                label={t('descuento')}
                data-testid="retencion-descuento"
              />
            </div>
            <p className="mt-1 max-w-[60ch] text-sm text-text-subtle">{t('descuentoAyuda')}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <label htmlFor="retencion-pct" className="text-sm font-semibold text-text">
                {t('porcentaje')}
              </label>
              <select
                id="retencion-pct"
                value={config.discountPercent}
                disabled={!config.discountEnabled}
                onChange={(e) => change({ discountPercent: Number(e.target.value) })}
                className={SELECT}
              >
                {withCurrent(DISCOUNT_PERCENT_OPTIONS, config.discountPercent).map((p) => (
                  <option key={p} value={p}>
                    {t('pct', { n: p })}
                  </option>
                ))}
              </select>
              <label htmlFor="retencion-meses" className="text-sm font-semibold text-text">
                {t('durante')}
              </label>
              <select
                id="retencion-meses"
                value={config.discountMonths}
                disabled={!config.discountEnabled}
                onChange={(e) => change({ discountMonths: Number(e.target.value) })}
                className={SELECT}
              >
                {withCurrent(DISCOUNT_MONTH_OPTIONS, config.discountMonths).map((m) => (
                  <option key={m} value={m}>
                    {t('meses', { n: m })}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 text-sm font-semibold text-danger-700">
          {error}
        </p>
      ) : null}

      {config ? (
        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            data-testid="retencion-guardar"
            className="h-11 rounded-xl bg-brand-600 px-6 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? t('guardando') : t('guardar')}
          </button>
          {saved ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-success-700">
              <Icon name="check" size={16} />
              {t('guardado')}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Las opciones del desplegable, con el valor guardado aunque no sea una de ellas. */
function withCurrent(options: readonly number[], current: number): number[] {
  return options.includes(current) ? [...options] : [...options, current].sort((a, b) => a - b);
}
