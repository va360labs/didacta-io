'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { EeGate, LICENSE_CAPABILITIES } from '@didacta/license-sdk/react';
import { Icon } from '@/components/icon';
import {
  AboutField,
  CoverField,
  SocialLinksField,
  draftsFromLinks,
  linksFromDrafts,
  type LinkDraft,
} from '@/components/academy-profile-fields';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { BRAND_REFERENCE_LIGHTNESS, hexToHsl, hslToHex } from '@/lib/color';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { markupOr } from '@/lib/i18n/labels';
import {
  publishThemeUpdate,
  themingApi,
  type LogoDisplayMode,
  type TenantTheme,
} from '@/lib/theming';

const DISPLAY_FONTS = [
  'Sora',
  'Inter',
  'Manrope',
  'Space Grotesk',
  'DM Sans',
  'Plus Jakarta Sans',
  'Outfit',
  'Lexend',
] as const;

const BODY_FONTS = [
  'Inter',
  'Manrope',
  'DM Sans',
  'IBM Plex Sans',
  'Source Sans 3',
  'Plus Jakarta Sans',
  'Outfit',
  'Nunito Sans',
] as const;

/**
 * Placeholder del textarea del footer si el catálogo degrada.
 *
 * `t.markup` NO lanza cuando el mensaje trae una etiqueta que este call-site no
 * declara: `use-intl` cae en `getMessageFallback`, que sin override devuelve la
 * RUTA DE LA KEY — el admin vería `adminMarca.branding.footerPlaceholder` dentro
 * del campo. Constante nombrada, no un default implícito (ver `markupOr`).
 */
const FOOTER_PLACEHOLDER_FALLBACK = "<p>© Tu Organización · <a href='...'>Privacidad</a></p>";

interface FormState {
  brandHue: number;
  brandSaturation: number;
  displayFontFamily: string;
  bodyFontFamily: string;
  logoUrl: string;
  logoDisplayMode: LogoDisplayMode;
  faviconUrl: string;
  customCss: string;
  footerHtml: string;
  signinHeadline: string;
  signinSubheadline: string;
  /** Descripción de la academia en su comunidad. */
  about: string;
  /** Enlaces sociales tal cual se están escribiendo. */
  links: LinkDraft[];
}

function themeToForm(t: TenantTheme): FormState {
  return {
    brandHue: t.brandHue,
    brandSaturation: t.brandSaturation,
    displayFontFamily: t.displayFontFamily,
    bodyFontFamily: t.bodyFontFamily,
    logoUrl: t.logoUrl ?? '',
    logoDisplayMode: t.logoDisplayMode ?? 'logo_only',
    faviconUrl: t.faviconUrl ?? '',
    customCss: t.customCss ?? '',
    footerHtml: t.footerHtml ?? '',
    signinHeadline: t.signinHeadline ?? '',
    signinSubheadline: t.signinSubheadline ?? '',
    about: t.about ?? '',
    links: draftsFromLinks(t.socialLinks ?? []),
  };
}

export default function BrandingPage() {
  const t = useTranslations('adminMarca');
  const tErrors = useTranslations('errors');
  const [theme, setTheme] = useState<TenantTheme | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [resetStatus, setResetStatus] = useState<'idle' | 'resetting'>('idle');
  // Borrador del input hex. null = «derívalo de los sliders» (hslToHex del
  // brand-500 actual); un string = lo que el admin está tecleando, que se
  // respeta tal cual hasta que un slider vuelva a mandar. Sin useEffect: los
  // dos caminos de escritura actualizan el borrador explícitamente.
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  // Tras un intento de guardar con enlaces malos se marcan todos, no solo los tocados.
  const [linksChecked, setLinksChecked] = useState(false);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    void (async () => {
      try {
        const fresh = await themingApi.getMine(token);
        setTheme(fresh);
        setForm(themeToForm(fresh));
      } catch (e) {
        setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('branding.loadError'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Preview live: aplicamos los cambios del form a un <style> local sin
  // tocar el global hasta que se guarde — así el admin ve cómo queda antes
  // de impactar a otros usuarios del tenant.
  const previewStyle = useMemo(() => {
    if (!form) return '';
    return [
      ':root {',
      `  --brand-h: ${form.brandHue};`,
      `  --brand-s: ${form.brandSaturation}%;`,
      `  --font-display: '${form.displayFontFamily}', system-ui, sans-serif;`,
      `  --font-sans: '${form.bodyFontFamily}', system-ui, sans-serif;`,
      '}',
    ].join('\n');
  }, [form]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!form || !theme) return;
    const token = authStorage.getAccessToken();
    if (!token) return;
    const enlaces = linksFromDrafts(form.links);
    if (enlaces.invalid) {
      setLinksChecked(true);
      setStatus('error');
      setError(t('academyProfile.linksInvalid'));
      return;
    }
    setStatus('saving');
    setError(null);
    try {
      const updated = await themingApi.update(token, {
        brandHue: form.brandHue,
        brandSaturation: form.brandSaturation,
        displayFontFamily: form.displayFontFamily,
        bodyFontFamily: form.bodyFontFamily,
        logoUrl: form.logoUrl.trim() || null,
        logoDisplayMode: form.logoDisplayMode,
        faviconUrl: form.faviconUrl.trim() || null,
        customCss: form.customCss.trim() || null,
        footerHtml: form.footerHtml.trim() || null,
        signinHeadline: form.signinHeadline.trim() || null,
        signinSubheadline: form.signinSubheadline.trim() || null,
        about: form.about.trim() || null,
        socialLinks: enlaces.links,
      });
      setTheme(updated);
      setForm(themeToForm(updated));
      setHexDraft(null);
      setLinksChecked(false);
      publishThemeUpdate(updated);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (e) {
      setStatus('error');
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('branding.saveError'));
    }
  }

  async function handleReset() {
    if (!confirm(t('branding.resetConfirm'))) return;
    const token = authStorage.getAccessToken();
    if (!token) return;
    setResetStatus('resetting');
    try {
      const fresh = await themingApi.reset(token);
      setTheme(fresh);
      setForm(themeToForm(fresh));
      setHexDraft(null);
      publishThemeUpdate(fresh);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('branding.resetError'));
    } finally {
      setResetStatus('idle');
    }
  }

  if (error && !form) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-2xl font-bold">{t('branding.title')}</h1>
        <Card>
          <CardContent className="p-6">
            <p className="text-danger-700">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!form) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-2xl font-bold">{t('branding.title')}</h1>
        <div className="space-y-3">
          <div className="skeleton h-32 w-full" />
          <div className="skeleton h-48 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <style dangerouslySetInnerHTML={{ __html: previewStyle }} />

      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('branding.title')}</h1>
          <p className="mt-1 text-text-muted">
            {t.rich('branding.headerDescription', {
              strong: (chunks) => <span className="font-semibold">{chunks}</span>,
            })}
          </p>
        </div>
        <Button variant="ghost" onClick={handleReset} disabled={resetStatus === 'resetting'}>
          {resetStatus === 'resetting' ? t('branding.resetting') : t('branding.resetButton')}
        </Button>
      </header>

      <form onSubmit={handleSave} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('branding.colorTitle')}</CardTitle>
              <CardDescription>{t('branding.colorDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Código hex de la marca (feedback de onboarding): del hex se
                  toman tono y saturación; la luminosidad la fija la escala del
                  tema, así que el resultado exacto se mira en la vista previa. */}
              <div>
                <Label htmlFor="brandHex">{t('branding.hexLabel')}</Label>
                <div className="mt-2 flex items-center gap-3">
                  <Input
                    id="brandHex"
                    type="text"
                    value={
                      hexDraft ??
                      hslToHex(form.brandHue, form.brandSaturation, BRAND_REFERENCE_LIGHTNESS)
                    }
                    onChange={(e) => {
                      const texto = e.target.value;
                      setHexDraft(texto);
                      const hsl = hexToHsl(texto);
                      if (hsl) {
                        setForm((f) => f && { ...f, brandHue: hsl.h, brandSaturation: hsl.s });
                      }
                    }}
                    aria-invalid={hexDraft !== null && hexToHsl(hexDraft) === null}
                    placeholder="#1E5AA8"
                    className="max-w-44 font-mono"
                  />
                  <span
                    aria-hidden="true"
                    className="h-9 w-9 shrink-0 rounded-md border border-border"
                    style={{
                      backgroundColor: `hsl(${form.brandHue}, ${form.brandSaturation}%, ${BRAND_REFERENCE_LIGHTNESS}%)`,
                    }}
                  />
                </div>
                <p className="mt-2 text-xs text-text-subtle">{t('branding.hexHint')}</p>
              </div>

              <div>
                <Label htmlFor="brandHue" className="flex items-center justify-between">
                  <span>{t('branding.hueLabel')}</span>
                  <Badge variant="outline">{form.brandHue}°</Badge>
                </Label>
                <input
                  id="brandHue"
                  type="range"
                  min={0}
                  max={360}
                  step={1}
                  value={form.brandHue}
                  onChange={(e) => {
                    setHexDraft(null);
                    setForm((f) => f && { ...f, brandHue: Number(e.target.value) });
                  }}
                  className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-full"
                  style={{
                    background:
                      'linear-gradient(to right, hsl(0,70%,50%), hsl(60,70%,50%), hsl(120,70%,50%), hsl(180,70%,50%), hsl(240,70%,50%), hsl(300,70%,50%), hsl(360,70%,50%))',
                  }}
                />
                <div className="mt-3 flex gap-1">
                  {[50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((step) => (
                    <div
                      key={step}
                      className="h-8 flex-1 rounded-md border border-border"
                      style={{
                        backgroundColor: `hsl(${form.brandHue}, ${form.brandSaturation}%, ${
                          step === 50
                            ? 96
                            : step === 100
                              ? 92
                              : step === 200
                                ? 84
                                : step === 300
                                  ? 72
                                  : step === 400
                                    ? 58
                                    : step === 500
                                      ? 45
                                      : step === 600
                                        ? 38
                                        : step === 700
                                          ? 30
                                          : step === 800
                                            ? 22
                                            : 14
                        }%)`,
                      }}
                      title={`brand-${step}`}
                    />
                  ))}
                </div>
              </div>

              <div>
                <Label htmlFor="brandSaturation" className="flex items-center justify-between">
                  <span>{t('branding.saturationLabel')}</span>
                  <Badge variant="outline">{form.brandSaturation}%</Badge>
                </Label>
                <input
                  id="brandSaturation"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={form.brandSaturation}
                  onChange={(e) => {
                    setHexDraft(null);
                    setForm((f) => f && { ...f, brandSaturation: Number(e.target.value) });
                  }}
                  className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-full bg-surface-3"
                />
                <p className="mt-2 text-xs text-text-subtle">{t('branding.saturationHint')}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('branding.typographyTitle')}</CardTitle>
              <CardDescription>{t('branding.typographyDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="displayFont">{t('branding.displayFontLabel')}</Label>
                <Select
                  id="displayFont"
                  value={form.displayFontFamily}
                  onChange={(e) => setForm((f) => f && { ...f, displayFontFamily: e.target.value })}
                  className="mt-1.5"
                >
                  {DISPLAY_FONTS.map((font) => (
                    <option key={font} value={font}>
                      {font}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="bodyFont">{t('branding.bodyFontLabel')}</Label>
                <Select
                  id="bodyFont"
                  value={form.bodyFontFamily}
                  onChange={(e) => setForm((f) => f && { ...f, bodyFontFamily: e.target.value })}
                  className="mt-1.5"
                >
                  {BODY_FONTS.map((font) => (
                    <option key={font} value={font}>
                      {font}
                    </option>
                  ))}
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('branding.logoTitle')}</CardTitle>
              <CardDescription>{t('branding.logoDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <LogoUploader
                currentLogoUrl={form.logoUrl}
                isUploaded={theme?.logoUploaded ?? false}
                onUploaded={(url) => {
                  setForm((f) => f && { ...f, logoUrl: url });
                  // Sin esto, `theme.logoUploaded` queda desactualizado tras
                  // subir (solo se refresca en save/reset) y el bloque "Logo
                  // subido" (con el botón Eliminar) no aparece hasta recargar
                  // la página, aunque la vista previa de arriba sí lo muestre.
                  setTheme((th) => th && { ...th, logoUploaded: true, logoUrl: url });
                }}
                onRemoved={() => {
                  setForm((f) => f && { ...f, logoUrl: '' });
                  setTheme((th) => th && { ...th, logoUploaded: false, logoUrl: null });
                }}
              />

              {/* Cómo se presenta la marca donde aparece (sidebar, /signin,
                  bienvenida): el logo solo a su ancho natural, o compacto con
                  el nombre al lado. Misma elección que ofrece el asistente. */}
              <fieldset>
                <legend className="text-sm font-medium">{t('branding.logoModeLabel')}</legend>
                <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      { valor: 'logo_only', titulo: 'logoModeOnly', ayuda: 'logoModeOnlyHint' },
                      {
                        valor: 'logo_and_name',
                        titulo: 'logoModeWithName',
                        ayuda: 'logoModeWithNameHint',
                      },
                    ] as const
                  ).map((op) => {
                    const activo = form.logoDisplayMode === op.valor;
                    return (
                      <button
                        key={op.valor}
                        type="button"
                        aria-pressed={activo}
                        onClick={() =>
                          setForm(
                            (f) => f && { ...f, logoDisplayMode: op.valor as LogoDisplayMode },
                          )
                        }
                        className={`rounded-lg border p-3 text-left transition-colors ${
                          activo
                            ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500'
                            : 'border-border bg-surface hover:border-brand-300'
                        }`}
                      >
                        <span className="block text-sm font-semibold">
                          {t(`branding.${op.titulo}` as never)}
                        </span>
                        <span className="mt-0.5 block text-xs text-text-muted">
                          {t(`branding.${op.ayuda}` as never)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <div>
                <Label htmlFor="logoUrl">{t('branding.logoUrlLabel')}</Label>
                <Input
                  id="logoUrl"
                  /* type="text" (NO "url"): el logo subido se sirve desde un
                     endpoint RELATIVO (/api/v1/modules/theming/...). Con
                     type="url" el navegador lo rechaza ("Introduce una url") y
                     —como es UN solo <form>— bloquea el submit ENTERO, así que
                     tampoco se guardaban los colores. El backend (safeImageUrl)
                     ya valida https:// | /api/v1/... */
                  type="text"
                  inputMode="url"
                  placeholder={t('branding.logoUrlPlaceholder')}
                  value={form.logoUrl}
                  onChange={(e) => setForm((f) => f && { ...f, logoUrl: e.target.value })}
                  className="mt-1.5"
                />
                <p className="mt-1 text-xs text-text-subtle">{t('branding.logoUrlHint')}</p>
              </div>
              {/* Favicon: subida propia (feedback de onboarding — «no vi la
                  posibilidad de subir el favicon») + la URL externa de siempre
                  como alternativa. */}
              <FaviconUploader
                currentFaviconUrl={form.faviconUrl}
                isUploaded={theme?.faviconUploaded ?? false}
                logoUploaded={theme?.logoUploaded ?? false}
                logoUrl={form.logoUrl}
                onUploaded={(url) => {
                  setForm((f) => f && { ...f, faviconUrl: url });
                  setTheme((th) => th && { ...th, faviconUploaded: true, faviconUrl: url });
                }}
                onRemoved={() => {
                  setForm((f) => f && { ...f, faviconUrl: '' });
                  setTheme((th) => th && { ...th, faviconUploaded: false, faviconUrl: null });
                }}
              />

              <div>
                <Label htmlFor="faviconUrl">{t('branding.faviconUrlLabel')}</Label>
                <Input
                  id="faviconUrl"
                  /* type="text" (NO "url"): mismo motivo que logoUrl — el
                     favicon subido se sirve desde un endpoint RELATIVO y
                     type="url" bloquearía el submit ENTERO del form. */
                  type="text"
                  inputMode="url"
                  placeholder={t('branding.faviconUrlPlaceholder')}
                  value={form.faviconUrl}
                  onChange={(e) => setForm((f) => f && { ...f, faviconUrl: e.target.value })}
                  className="mt-1.5"
                />
                <p className="mt-1 text-xs text-text-subtle">{t('branding.faviconUrlHint')}</p>
              </div>
            </CardContent>
          </Card>

          {/*
           * Copy del panel de marca de /signin. Vive aquí y no hardcodeado en el
           * web porque es texto DEL TENANT: Didacta es multi-tenant y no puede
           * llevar la frase de ningún tenant en su código.
           */}
          <Card>
            <CardHeader>
              <CardTitle>{t('branding.signinTitle')}</CardTitle>
              <CardDescription>
                {t.rich('branding.signinDescription', {
                  code: (chunks) => <code>{chunks}</code>,
                })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <Label htmlFor="signinHeadline">{t('branding.headlineLabel')}</Label>
                <Input
                  id="signinHeadline"
                  type="text"
                  maxLength={160}
                  placeholder={t('branding.headlinePlaceholder')}
                  value={form.signinHeadline}
                  onChange={(e) => setForm((f) => f && { ...f, signinHeadline: e.target.value })}
                  className="mt-1.5"
                />
                <p className="mt-1 text-xs text-text-subtle">{t('branding.headlineHint')}</p>
              </div>
              <div>
                <Label htmlFor="signinSubheadline">{t('branding.subheadlineLabel')}</Label>
                <Input
                  id="signinSubheadline"
                  type="text"
                  maxLength={240}
                  placeholder={t('branding.subheadlinePlaceholder')}
                  value={form.signinSubheadline}
                  onChange={(e) => setForm((f) => f && { ...f, signinSubheadline: e.target.value })}
                  className="mt-1.5"
                />
                <p className="mt-1 text-xs text-text-subtle">{t('branding.subheadlineHint')}</p>
              </div>
            </CardContent>
          </Card>

          {/*
           * Cómo se presenta la academia en su comunidad (tarjeta de
           * /community, como la de un grupo de Skool). La portada se sube al
           * momento, como el logo; descripción y enlaces van con «Guardar».
           */}
          <Card data-testid="branding-academy-profile">
            <CardHeader>
              <CardTitle>{t('academyProfile.title')}</CardTitle>
              <CardDescription>{t('academyProfile.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <CoverField theme={theme} onTheme={setTheme} />
              <AboutField
                value={form.about}
                onChange={(about) => setForm((f) => f && { ...f, about })}
              />
              <SocialLinksField
                drafts={form.links}
                onChange={(links) => setForm((f) => f && { ...f, links })}
                showErrors={linksChecked}
              />
            </CardContent>
          </Card>

          {/*
           * White-label avanzado (Enterprise): gateado por la capability
           * `feat:white_label` del License SDK. En plan community se muestra
           * un mensaje de upgrade; con licencia EE válida que incluya esta
           * capability, los campos quedan editables.
           *
           * IMPORTANTE: este gate es solo UX. El backend ya gatea los
           * endpoints relevantes con @RequiresCapability — sin licencia EE
           * cualquier intento de PUT/POST con customCss / footerHtml acaba
           * en 402 Payment Required vía LicenseExceptionFilter.
           */}
          <EeGate capability={LICENSE_CAPABILITIES.WHITE_LABEL} fallback={<WhiteLabelUpsellCard />}>
            <Card>
              <CardHeader>
                <CardTitle>{t('branding.cssTitle')}</CardTitle>
                <CardDescription>
                  {t.rich('branding.cssDescription', {
                    code: (chunks) => <code>{chunks}</code>,
                    styleTag: '</style>',
                  })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Textarea
                  value={form.customCss}
                  onChange={(e) => setForm((f) => f && { ...f, customCss: e.target.value })}
                  rows={6}
                  placeholder={t('branding.cssPlaceholder')}
                  className="font-mono text-xs"
                />
                <p className="mt-2 text-xs text-text-subtle">
                  {t('branding.cssBytes', {
                    // Va como NÚMERO: `String(12.3)` pinta "12.3" también en
                    // español, donde el decimal se escribe con coma.
                    kb: Math.round(new TextEncoder().encode(form.customCss).length / 102.4) / 10,
                  })}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('branding.footerTitle')}</CardTitle>
                <CardDescription>{t('branding.footerDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <Textarea
                  value={form.footerHtml}
                  onChange={(e) => setForm((f) => f && { ...f, footerHtml: e.target.value })}
                  rows={3}
                  placeholder={markupOr(
                    t,
                    'branding.footerPlaceholder',
                    {
                      p: (chunks) => `<p>${chunks}</p>`,
                      a: (chunks) => `<a href='...'>${chunks}</a>`,
                    },
                    FOOTER_PLACEHOLDER_FALLBACK,
                  )}
                  className="font-mono text-xs"
                />
              </CardContent>
            </Card>
          </EeGate>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle>{t('branding.previewTitle')}</CardTitle>
              <CardDescription>{t('branding.previewDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-border bg-surface p-4">
                {form.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={form.logoUrl}
                    alt={t('branding.previewLogoAlt')}
                    className="h-10 max-w-full object-contain"
                  />
                ) : (
                  <div
                    className="font-display text-xl font-bold"
                    style={{
                      color: `hsl(${form.brandHue}, ${form.brandSaturation}%, 30%)`,
                    }}
                  >
                    Didacta
                  </div>
                )}
              </div>
              <div
                className="rounded-lg border border-border p-4"
                style={{
                  backgroundColor: `hsl(${form.brandHue}, ${form.brandSaturation}%, 96%)`,
                }}
              >
                <h4
                  className="font-display text-lg font-semibold"
                  style={{
                    color: `hsl(${form.brandHue}, ${form.brandSaturation + 10}%, 14%)`,
                  }}
                >
                  {t('branding.previewCardTitle')}
                </h4>
                <p className="mt-1 text-sm text-text-muted">{t('branding.previewCardMeta')}</p>
              </div>
              <button
                type="button"
                className="w-full rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors"
                style={{
                  backgroundColor: `hsl(${form.brandHue}, ${form.brandSaturation}%, 45%)`,
                }}
              >
                {t('branding.previewButton')}
              </button>
              <Badge
                style={{
                  backgroundColor: `hsl(${form.brandHue}, ${form.brandSaturation}%, 96%)`,
                  color: `hsl(${form.brandHue}, ${form.brandSaturation + 5}%, 30%)`,
                }}
              >
                {t('branding.previewBadge')}
              </Badge>
            </CardContent>
          </Card>
        </aside>

        <div className="flex items-center justify-between gap-4 lg:col-span-3">
          <div className="text-sm">
            {status === 'saved' ? (
              <span className="inline-flex items-center gap-1.5 font-semibold text-success-700">
                <Icon name="check" size={16} />
                {t('branding.savedStatus')}
              </span>
            ) : status === 'error' && error ? (
              <span className="font-semibold text-danger-700">{error}</span>
            ) : (
              <span className="text-text-subtle">{t('branding.saveNotice')}</span>
            )}
          </div>
          <Button type="submit" disabled={status === 'saving'} size="lg">
            {status === 'saving' ? t('branding.saving') : t('branding.saveButton')}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Tarjeta de upsell que se muestra en lugar del bloque white-label cuando el
 * tenant está en plan community (sin licencia EE) o cuando la licencia activa
 * no incluye la capability `feat:white_label`.
 *
 * Mensaje claro: explica qué se desbloquea y dirige al pricing público.
 * No reemplaza el guard del backend — es solo UX. Cualquier intento de
 * persistir customCss / footerHtml sin la capability sigue rebotando con 402.
 */
function WhiteLabelUpsellCard() {
  const t = useTranslations('adminMarca');
  return (
    <Card role="region" aria-label={t('branding.upsellAria')} className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          {t('branding.upsellTitle')}
        </CardTitle>
        <CardDescription>{t('branding.upsellDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          {t.rich('branding.upsellBody', {
            code: (chunks) => (
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{chunks}</code>
            ),
          })}
        </p>
        <a
          href="https://didacta.io/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
        >
          {t('branding.upsellCta')}
          <Icon name="arrow-right" size={14} />
        </a>
      </CardContent>
    </Card>
  );
}

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
const MAX_BYTES = 2 * 1024 * 1024;

function LogoUploader({
  currentLogoUrl,
  isUploaded,
  onUploaded,
  onRemoved,
}: {
  currentLogoUrl: string;
  isUploaded: boolean;
  onUploaded: (url: string) => void;
  onRemoved: () => void;
}) {
  const t = useTranslations('adminMarca');
  const tErrors = useTranslations('errors');
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleUpload(file: File) {
    setError(null);
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError(t('branding.uploadBadType'));
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(t('branding.uploadTooBig'));
      return;
    }
    const token = authStorage.getAccessToken();
    if (!token) return;
    setBusy('upload');
    try {
      const buf = await file.arrayBuffer();
      const data = bufferToBase64(buf);
      const updated = await themingApi.uploadLogo(token, {
        data,
        filename: file.name,
        contentType: file.type,
      });
      publishThemeUpdate(updated);
      if (updated.logoUrl) onUploaded(updated.logoUrl);
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('branding.uploadError'));
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    if (!confirm(t('branding.removeConfirm'))) return;
    const token = authStorage.getAccessToken();
    if (!token) return;
    setBusy('remove');
    setError(null);
    try {
      const updated = await themingApi.removeLogo(token);
      publishThemeUpdate(updated);
      onRemoved();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('branding.removeError'));
    } finally {
      setBusy(null);
    }
  }

  const showPreview = isUploaded && currentLogoUrl;

  return (
    <div className="space-y-3">
      <Label>{t('branding.uploadedLabel')}</Label>
      {showPreview ? (
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-surface-2 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={currentLogoUrl}
            alt={t('branding.uploadedAlt')}
            className="h-12 max-w-[200px] object-contain"
          />
          <div className="flex flex-1 items-center justify-between gap-2">
            <p className="text-xs text-text-muted">{t('branding.uploadedHint')}</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRemove}
              disabled={busy !== null}
            >
              {busy === 'remove' ? t('branding.removing') : t('branding.removeButton')}
            </Button>
          </div>
        </div>
      ) : null}

      <label
        className={
          busy === 'upload'
            ? 'block cursor-wait rounded-lg border-2 border-dashed border-border-strong bg-surface-2 p-6 text-center opacity-60'
            : 'block cursor-pointer rounded-lg border-2 border-dashed border-border-strong bg-surface-2 p-6 text-center transition-colors hover:border-brand-300 hover:bg-brand-50'
        }
      >
        <p className="text-sm font-semibold text-text">
          {busy === 'upload'
            ? t('branding.uploading')
            : showPreview
              ? t('branding.replaceLogo')
              : t('branding.uploadCta')}
        </p>
        <p className="mt-1 text-xs text-text-muted">{t('branding.uploadHint')}</p>
        <input
          type="file"
          accept={ALLOWED_TYPES.join(',')}
          disabled={busy !== null}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleUpload(file);
            e.target.value = '';
          }}
          className="sr-only"
        />
      </label>

      {error ? (
        <div className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700">
          {error}
        </div>
      ) : null}
    </div>
  );
}

const MAX_FAVICON_BYTES = 1 * 1024 * 1024;

/**
 * Hermano pequeño de `LogoUploader` para el favicon: mismo contrato con la
 * página (URL + flag `isUploaded` + callbacks), límite de 1 MB y un atajo
 * «usar el logo como favicon» que copia el logo subido (el backend lo
 * redimensiona a icono). El atajo solo aparece con logo EN STORAGE: una URL
 * externa no es fetcheable desde aquí (CORS) y el navegador ya la tiene.
 */
function FaviconUploader({
  currentFaviconUrl,
  isUploaded,
  logoUploaded,
  logoUrl,
  onUploaded,
  onRemoved,
}: {
  currentFaviconUrl: string;
  isUploaded: boolean;
  logoUploaded: boolean;
  logoUrl: string;
  onUploaded: (url: string) => void;
  onRemoved: () => void;
}) {
  const t = useTranslations('adminMarca');
  const tErrors = useTranslations('errors');
  const [busy, setBusy] = useState<'upload' | 'remove' | 'copy' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function subirBlob(data: string, filename: string, contentType: string) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    const updated = await themingApi.uploadFavicon(token, { data, filename, contentType });
    publishThemeUpdate(updated);
    if (updated.faviconUrl) onUploaded(updated.faviconUrl);
  }

  async function handleUpload(file: File) {
    setError(null);
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError(t('branding.uploadBadType'));
      return;
    }
    if (file.size > MAX_FAVICON_BYTES) {
      setError(t('branding.faviconTooBig'));
      return;
    }
    setBusy('upload');
    try {
      const buf = await file.arrayBuffer();
      await subirBlob(bufferToBase64(buf), file.name, file.type);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('branding.faviconUploadError'),
      );
    } finally {
      setBusy(null);
    }
  }

  /** Copia el logo subido como favicon: fetch same-origin + re-upload. */
  async function handleUseLogo() {
    if (!logoUrl) return;
    setError(null);
    setBusy('copy');
    try {
      const res = await fetch(logoUrl);
      if (!res.ok) throw new Error(`logo fetch ${res.status}`);
      const blob = await res.blob();
      const contentType = blob.type || 'image/png';
      if (!ALLOWED_TYPES.includes(contentType)) {
        setError(t('branding.uploadBadType'));
        return;
      }
      const buf = await blob.arrayBuffer();
      await subirBlob(bufferToBase64(buf), 'logo-como-favicon', contentType);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('branding.faviconUploadError'),
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    if (!confirm(t('branding.faviconRemoveConfirm'))) return;
    const token = authStorage.getAccessToken();
    if (!token) return;
    setBusy('remove');
    setError(null);
    try {
      const updated = await themingApi.removeFavicon(token);
      publishThemeUpdate(updated);
      onRemoved();
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('branding.faviconRemoveError'),
      );
    } finally {
      setBusy(null);
    }
  }

  const showPreview = isUploaded && currentFaviconUrl;

  return (
    <div className="space-y-3">
      <Label>{t('branding.faviconUploadedLabel')}</Label>
      {showPreview ? (
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-surface-2 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={currentFaviconUrl}
            alt={t('branding.faviconUploadedAlt')}
            className="h-8 w-8 rounded object-contain"
          />
          <div className="flex flex-1 items-center justify-between gap-2">
            <p className="text-xs text-text-muted">{t('branding.faviconUploadedHint')}</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRemove}
              disabled={busy !== null}
            >
              {busy === 'remove' ? t('branding.removing') : t('branding.removeButton')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-stretch gap-3">
        <label
          className={
            busy === 'upload'
              ? 'block flex-1 cursor-wait rounded-lg border-2 border-dashed border-border-strong bg-surface-2 p-4 text-center opacity-60'
              : 'block flex-1 cursor-pointer rounded-lg border-2 border-dashed border-border-strong bg-surface-2 p-4 text-center transition-colors hover:border-brand-300 hover:bg-brand-50'
          }
        >
          <p className="text-sm font-semibold text-text">
            {busy === 'upload'
              ? t('branding.uploading')
              : showPreview
                ? t('branding.faviconReplaceCta')
                : t('branding.faviconUploadCta')}
          </p>
          <p className="mt-1 text-xs text-text-muted">{t('branding.faviconUploadHint')}</p>
          <input
            type="file"
            accept={ALLOWED_TYPES.join(',')}
            disabled={busy !== null}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
              e.target.value = '';
            }}
            className="sr-only"
          />
        </label>
        {logoUploaded && logoUrl ? (
          <Button
            type="button"
            variant="outline"
            className="self-center"
            disabled={busy !== null}
            onClick={() => void handleUseLogo()}
          >
            {busy === 'copy' ? t('branding.faviconUseLogoBusy') : t('branding.faviconUseLogo')}
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
