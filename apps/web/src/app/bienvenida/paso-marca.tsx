'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useRef, useState, type DragEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authStorage } from '@/lib/auth-storage';
import { BRAND_REFERENCE_LIGHTNESS, hexToHsl, hslToHex } from '@/lib/color';
import {
  publishThemeUpdate,
  themingApi,
  type LogoDisplayMode,
  type TenantTheme,
} from '@/lib/theming';
import type { Academy } from '@/lib/academy';

/** Los mismos tipos que acepta `uploadLogoSchema` en la API. */
const TIPOS_LOGO = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/**
 * Muestras seleccionables. Curadas para que cualquiera dé un tema digno con la
 * curva de saturación por defecto; la barra de abajo permite afinar entre ellas.
 */
const MUESTRAS = [213, 262, 292, 340, 0, 25, 45, 152, 174, 197] as const;

async function aBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read'));
    reader.readAsDataURL(file);
  });
}

interface Props {
  academia: Academy | null;
  theme: TenantTheme | null;
  hue: number;
  onHue: (hue: number) => void;
  /** Saturación de la marca: 70 con las muestras curadas; la que salga del hex
   * pegado si el admin trae el código exacto de su marca. */
  sat: number;
  onSat: (sat: number) => void;
  /** Cómo se presenta la marca (solo logo / logo y nombre). Vive en la página
   * para que la cabecera del asistente lo refleje en vivo al elegirlo. */
  modo: LogoDisplayMode;
  onModo: (modo: LogoDisplayMode) => void;
  onTheme: (theme: TenantTheme) => void;
  /**
   * Sin título propio ni la pista de «Administración → Marca»: para cuando se
   * pinta dentro de otra pantalla (Ajustes del modo sencillo).
   */
  compact?: boolean;
}

/**
 * Paso «marca»: logo + color, con vista previa en vivo.
 *
 * El logo se sube en el momento (no al pulsar Continuar): es la recompensa
 * inmediata del paso — el encabezado del asistente pasa a ser el suyo — y evita
 * tener que retener un fichero en memoria entre pasos. El color, en cambio, se
 * persiste al continuar, porque mientras se juega con la barra no hay un valor
 * «elegido» todavía.
 */
export function PasoMarca({
  academia,
  theme,
  hue,
  onHue,
  sat,
  onSat,
  modo,
  onModo,
  onTheme,
  compact = false,
}: Props) {
  const t = useTranslations('bienvenida');
  const inputRef = useRef<HTMLInputElement>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [quitando, setQuitando] = useState(false);
  const [errorLogo, setErrorLogo] = useState<string | null>(null);
  const [arrastrando, setArrastrando] = useState(false);
  // Borrador del input hex: null = derivar de hue/sat; string = lo tecleado,
  // que manda hasta que una muestra o la barra vuelvan a elegir color.
  const [hexDraft, setHexDraft] = useState<string | null>(null);

  const logoUrl = theme?.logoUrl ?? null;

  async function subir(file: File) {
    setErrorLogo(null);
    if (!TIPOS_LOGO.includes(file.type)) {
      setErrorLogo(t('marcaLogoErrorTipo'));
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setErrorLogo(t('marcaLogoErrorPeso', { mb: (file.size / 1048576).toFixed(1) }));
      return;
    }
    const token = authStorage.getAccessToken();
    if (!token) return;
    setSubiendo(true);
    try {
      const data = await aBase64(file);
      const actualizado = await themingApi.uploadLogo(token, {
        data,
        filename: file.name,
        contentType: file.type,
      });
      onTheme(actualizado);
      // El resto de la app (y el encabezado del asistente) lo enseñan al momento.
      publishThemeUpdate(actualizado);
    } catch {
      setErrorLogo(t('marcaLogoErrorSubida'));
    } finally {
      setSubiendo(false);
    }
  }

  async function quitar() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setErrorLogo(null);
    setQuitando(true);
    try {
      const actualizado = await themingApi.removeLogo(token);
      onTheme(actualizado);
      publishThemeUpdate(actualizado);
    } catch {
      setErrorLogo(t('errorGuardar'));
    } finally {
      setQuitando(false);
    }
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setArrastrando(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void subir(file);
  }

  const inicial = (academia?.name ?? 'A').slice(0, 1).toUpperCase();

  return (
    <div className="space-y-6">
      {compact ? null : (
        <header className="space-y-1.5">
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('marcaTitulo')}</h1>
          <p className="text-text-muted">{t('marcaCuerpo')}</p>
        </header>
      )}

      {/* ------------------------------------------------ Logo */}
      <section className="space-y-2">
        <p className="text-sm font-medium">{t('marcaLogo')}</p>
        <input
          ref={inputRef}
          type="file"
          accept={TIPOS_LOGO.join(',')}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void subir(file);
            // Permite volver a elegir el mismo fichero tras un error.
            e.target.value = '';
          }}
        />
        {logoUrl ? (
          <div className="space-y-4 rounded-xl border border-border bg-surface-2 p-4">
            <div className="flex items-center gap-4">
              {/* A su ancho natural: embutir un logo horizontal en un cuadrado
                  lo hacía ilegible. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={logoUrl}
                alt=""
                className="h-12 w-auto max-w-[200px] rounded-lg bg-white object-contain p-1 shadow-sm"
              />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-sm font-medium text-success-700">
                  <Icon name="check" size={16} />
                  {t('marcaLogoSubido')}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={subiendo || quitando}
                  onClick={() => inputRef.current?.click()}
                >
                  {subiendo ? t('marcaLogoSubiendo') : t('marcaLogoCambiar')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={subiendo || quitando}
                  onClick={() => void quitar()}
                >
                  {quitando ? t('guardando') : t('marcaLogoQuitar')}
                </Button>
              </div>
            </div>

            {/* ¿Se enseña el nombre junto al logo, o el logo va solo? La
                elección manda en el sidebar del aula, /signin y todas las
                pantallas con marca. La vista previa de abajo la refleja. */}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t('marcaModo')}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {(
                  [
                    { valor: 'logo_only', titulo: 'marcaModoSolo', ayuda: 'marcaModoSoloAyuda' },
                    {
                      valor: 'logo_and_name',
                      titulo: 'marcaModoConNombre',
                      ayuda: 'marcaModoConNombreAyuda',
                    },
                  ] as const
                ).map((op) => {
                  const activo = modo === op.valor;
                  return (
                    <button
                      key={op.valor}
                      type="button"
                      aria-pressed={activo}
                      onClick={() => onModo(op.valor)}
                      className={`rounded-lg border p-3 text-left transition-colors ${
                        activo
                          ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500'
                          : 'border-border bg-surface hover:border-brand-300'
                      }`}
                    >
                      <span className="flex items-center gap-1.5 text-sm font-semibold">
                        {activo && <Icon name="check" size={14} className="text-brand-600" />}
                        {t(op.titulo)}
                      </span>
                      <span className="mt-0.5 block text-xs text-text-muted">{t(op.ayuda)}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          </div>
        ) : (
          <button
            type="button"
            disabled={subiendo}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setArrastrando(true);
            }}
            onDragLeave={() => setArrastrando(false)}
            onDrop={onDrop}
            className={`flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
              arrastrando
                ? 'border-brand-400 bg-brand-50'
                : 'border-border-strong bg-surface-2 hover:border-brand-300 hover:bg-brand-50/50'
            }`}
          >
            <span className="grid h-11 w-11 place-items-center rounded-full bg-brand-100 text-brand-700">
              <Icon name={subiendo ? 'clock' : 'image'} size={22} />
            </span>
            <span className="text-sm font-medium">
              {subiendo ? t('marcaLogoSubiendo') : t('marcaLogoArrastra')}
            </span>
            <span className="text-xs text-text-subtle">{t('marcaLogoFormatos')}</span>
          </button>
        )}
        {errorLogo && (
          <p role="alert" className="flex items-start gap-1.5 text-sm text-danger-700">
            <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
            {errorLogo}
          </p>
        )}
        {!logoUrl && !compact && (
          <p className="text-xs text-text-subtle">{t('marcaLogoOpcional')}</p>
        )}
      </section>

      {/* ------------------------------------------------ Color */}
      <section className="space-y-3">
        <div>
          <p className="text-sm font-medium">{t('marcaColor')}</p>
          <p className="text-xs text-text-subtle">{t('marcaColorAyuda')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {MUESTRAS.map((h) => {
            const activo = h === hue && sat === 70;
            return (
              <button
                key={h}
                type="button"
                aria-label={`hsl(${h})`}
                aria-pressed={activo}
                onClick={() => {
                  // Las muestras están curadas para la saturación por defecto:
                  // elegir una vuelve a 70 aunque antes se pegara un hex.
                  onHue(h);
                  onSat(70);
                  setHexDraft(null);
                }}
                className={`h-9 w-9 rounded-full transition-transform hover:scale-110 ${
                  activo ? 'ring-2 ring-offset-2 ring-brand-500 scale-110' : ''
                }`}
                style={{ backgroundColor: `hsl(${h} 70% 45%)` }}
              />
            );
          })}
        </div>
        <input
          type="range"
          min={0}
          max={360}
          value={hue}
          aria-label={t('marcaColorSlider')}
          onChange={(e) => {
            onHue(Number(e.target.value));
            setHexDraft(null);
          }}
          className="slider-hue w-full"
          style={{ ['--thumb-color' as string]: `hsl(${hue} ${sat}% 45%)` }}
        />
        {/* ¿Trae el código exacto de su marca? Se pega y listo: tono y
            saturación salen del hex; la luminosidad la pone el tema y el
            resultado se ve en la vista previa de abajo (feedback de usuarios). */}
        <div className="flex items-center gap-2 pt-1">
          <label htmlFor="marca-hex" className="text-sm text-text-muted">
            {t('marcaColorHex')}
          </label>
          <Input
            id="marca-hex"
            type="text"
            value={hexDraft ?? hslToHex(hue, sat, BRAND_REFERENCE_LIGHTNESS)}
            onChange={(e) => {
              const texto = e.target.value;
              setHexDraft(texto);
              const hsl = hexToHsl(texto);
              if (hsl) {
                onHue(hsl.h);
                onSat(hsl.s);
              }
            }}
            aria-invalid={hexDraft !== null && hexToHsl(hexDraft) === null}
            placeholder="#1E5AA8"
            className="max-w-36 font-mono"
          />
        </div>
      </section>

      {/* ------------------------------------------------ Vista previa */}
      <section aria-hidden="true" className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-text-subtle">{t('marcaVista')}</p>
        <div className="overflow-hidden rounded-xl border border-border shadow-sm">
          {/* Barra superior del aula, fiel al modo elegido: solo el logo a su
              ancho, o logo compacto + nombre. */}
          <div className="flex items-center gap-2 border-b border-border bg-white px-4 py-2.5">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt=""
                className={
                  modo === 'logo_only'
                    ? 'h-6 w-auto max-w-[150px] object-contain'
                    : 'h-6 w-auto max-w-[48px] object-contain'
                }
              />
            ) : (
              <span
                className="grid h-6 w-6 place-items-center rounded text-xs font-bold text-white"
                style={{ backgroundColor: `hsl(${hue} ${sat}% 45%)` }}
              >
                {inicial}
              </span>
            )}
            {(!logoUrl || modo === 'logo_and_name') && (
              <span className="text-sm font-semibold">{academia?.name}</span>
            )}
          </div>
          <div className="flex">
            {/* Barra lateral tintada con su color, como en el aula real. */}
            <div
              className="hidden w-28 shrink-0 flex-col gap-2 p-3 sm:flex"
              style={{ backgroundColor: `hsl(${hue} ${sat}% 12%)` }}
            >
              {[0.9, 0.45, 0.45].map((opacity, i) => (
                <div
                  key={i}
                  className="h-2 rounded-full bg-white"
                  style={{ opacity, width: `${80 - i * 15}%` }}
                />
              ))}
            </div>
            <div className="flex-1 space-y-3 bg-surface-2 p-4">
              <div className="h-2.5 w-2/5 rounded-full bg-border-strong" />
              <div className="rounded-lg border border-border bg-white p-3">
                <div
                  className="mb-2 h-1.5 w-16 rounded-full"
                  style={{ backgroundColor: `hsl(${hue} ${sat}% 45%)` }}
                />
                <p className="text-sm font-semibold">{t('marcaVistaCurso')}</p>
                <span
                  className="mt-2 inline-block rounded-lg px-3 py-1.5 text-xs font-semibold text-white"
                  style={{ backgroundColor: `hsl(${hue} ${sat}% 45%)` }}
                >
                  {t('marcaVistaBoton')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
