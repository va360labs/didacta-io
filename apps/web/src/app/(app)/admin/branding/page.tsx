'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { EeGate, LICENSE_CAPABILITIES } from '@didacta/license-sdk/react';
import { Icon } from '@/components/icon';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { publishThemeUpdate, themingApi, type TenantTheme } from '@/lib/theming';

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

interface FormState {
  brandHue: number;
  brandSaturation: number;
  displayFontFamily: string;
  bodyFontFamily: string;
  logoUrl: string;
  faviconUrl: string;
  customCss: string;
  footerHtml: string;
}

function themeToForm(t: TenantTheme): FormState {
  return {
    brandHue: t.brandHue,
    brandSaturation: t.brandSaturation,
    displayFontFamily: t.displayFontFamily,
    bodyFontFamily: t.bodyFontFamily,
    logoUrl: t.logoUrl ?? '',
    faviconUrl: t.faviconUrl ?? '',
    customCss: t.customCss ?? '',
    footerHtml: t.footerHtml ?? '',
  };
}

export default function BrandingPage() {
  const [theme, setTheme] = useState<TenantTheme | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [resetStatus, setResetStatus] = useState<'idle' | 'resetting'>('idle');

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    void (async () => {
      try {
        const t = await themingApi.getMine(token);
        setTheme(t);
        setForm(themeToForm(t));
      } catch (e) {
        setError(e instanceof ApiHttpError ? e.message : 'No se pudo cargar el theme');
      }
    })();
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
    setStatus('saving');
    setError(null);
    try {
      const updated = await themingApi.update(token, {
        brandHue: form.brandHue,
        brandSaturation: form.brandSaturation,
        displayFontFamily: form.displayFontFamily,
        bodyFontFamily: form.bodyFontFamily,
        logoUrl: form.logoUrl.trim() || null,
        faviconUrl: form.faviconUrl.trim() || null,
        customCss: form.customCss.trim() || null,
        footerHtml: form.footerHtml.trim() || null,
      });
      setTheme(updated);
      setForm(themeToForm(updated));
      publishThemeUpdate(updated);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (e) {
      setStatus('error');
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo guardar el theme');
    }
  }

  async function handleReset() {
    if (!confirm('¿Restaurar el theme a los valores por defecto Didacta?')) return;
    const token = authStorage.getAccessToken();
    if (!token) return;
    setResetStatus('resetting');
    try {
      const fresh = await themingApi.reset(token);
      setTheme(fresh);
      setForm(themeToForm(fresh));
      publishThemeUpdate(fresh);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo resetear');
    } finally {
      setResetStatus('idle');
    }
  }

  if (error && !form) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-3xl font-bold">Branding</h1>
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
        <h1 className="font-display text-3xl font-bold">Branding</h1>
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
          <h1 className="font-display text-3xl font-bold tracking-tight">Branding</h1>
          <p className="mt-1 text-text-muted">
            Personaliza la identidad visual de tu organización. Los cambios se guardan al hacer clic
            en <span className="font-semibold">Guardar</span>; puedes ver una vista previa mientras
            editas.
          </p>
        </div>
        <Button variant="ghost" onClick={handleReset} disabled={resetStatus === 'resetting'}>
          {resetStatus === 'resetting' ? 'Restaurando…' : 'Restaurar valores por defecto'}
        </Button>
      </header>

      <form onSubmit={handleSave} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Color de marca</CardTitle>
              <CardDescription>
                Mueves el matiz y la saturación; los 10 escalones de la paleta se derivan
                automáticamente sobre HSL.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <Label htmlFor="brandHue" className="flex items-center justify-between">
                  <span>Matiz (hue)</span>
                  <Badge variant="outline">{form.brandHue}°</Badge>
                </Label>
                <input
                  id="brandHue"
                  type="range"
                  min={0}
                  max={360}
                  step={1}
                  value={form.brandHue}
                  onChange={(e) => setForm((f) => f && { ...f, brandHue: Number(e.target.value) })}
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
                  <span>Saturación</span>
                  <Badge variant="outline">{form.brandSaturation}%</Badge>
                </Label>
                <input
                  id="brandSaturation"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={form.brandSaturation}
                  onChange={(e) =>
                    setForm((f) => f && { ...f, brandSaturation: Number(e.target.value) })
                  }
                  className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-full bg-surface-3"
                />
                <p className="mt-2 text-xs text-text-subtle">
                  Saturaciones bajas dan tonos pastel; saturaciones altas, colores vibrantes.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tipografía</CardTitle>
              <CardDescription>
                Sora + Inter es el default Didacta. Otras combinaciones están limitadas a Google
                Fonts compatibles con la jerarquía del sistema.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="displayFont">Fuente de titulares (display)</Label>
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
                <Label htmlFor="bodyFont">Fuente del cuerpo (body)</Label>
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
              <CardTitle>Logo y favicon</CardTitle>
              <CardDescription>
                Sube el logo del tenant directamente al storage o pega una URL externa (https).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <LogoUploader
                currentLogoUrl={form.logoUrl}
                isUploaded={theme?.logoUploaded ?? false}
                onUploaded={(url) => setForm((f) => f && { ...f, logoUrl: url })}
                onRemoved={() => setForm((f) => f && { ...f, logoUrl: '' })}
              />

              <div>
                <Label htmlFor="logoUrl">URL del logo (alternativa)</Label>
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
                  placeholder="https://cdn.tudominio.com/logo.svg"
                  value={form.logoUrl}
                  onChange={(e) => setForm((f) => f && { ...f, logoUrl: e.target.value })}
                  className="mt-1.5"
                />
                <p className="mt-1 text-xs text-text-subtle">
                  Si pegas aquí una URL externa pisará el logo subido (al guardar).
                </p>
              </div>
              <div>
                <Label htmlFor="faviconUrl">URL del favicon</Label>
                <Input
                  id="faviconUrl"
                  type="url"
                  placeholder="https://cdn.tudominio.com/favicon.png"
                  value={form.faviconUrl}
                  onChange={(e) => setForm((f) => f && { ...f, faviconUrl: e.target.value })}
                  className="mt-1.5"
                />
              </div>
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
                <CardTitle>CSS personalizado (avanzado)</CardTitle>
                <CardDescription>
                  Solo para usuarios técnicos. Se sanitiza en el servidor: <code>@import</code>,{' '}
                  <code>expression()</code>, <code>javascript:</code> y cierre de{' '}
                  <code>&lt;/style&gt;</code> están bloqueados. Máximo 16&nbsp;KB.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Textarea
                  value={form.customCss}
                  onChange={(e) => setForm((f) => f && { ...f, customCss: e.target.value })}
                  rows={6}
                  placeholder=":root { --radius-card: 12px; }"
                  className="font-mono text-xs"
                />
                <p className="mt-2 text-xs text-text-subtle">
                  {Math.round(new TextEncoder().encode(form.customCss).length / 102.4) / 10} KB de
                  16 KB
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Footer personalizado</CardTitle>
                <CardDescription>
                  HTML del footer (sanitizado a etiquetas básicas). Aparece en el pie de las
                  pantallas autenticadas. Máximo 4&nbsp;KB.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Textarea
                  value={form.footerHtml}
                  onChange={(e) => setForm((f) => f && { ...f, footerHtml: e.target.value })}
                  rows={3}
                  placeholder="<p>&copy; 2026 Tu Organización · <a href='...'>Privacidad</a></p>"
                  className="font-mono text-xs"
                />
              </CardContent>
            </Card>
          </EeGate>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle>Vista previa</CardTitle>
              <CardDescription>
                Así se ve tu marca en la plataforma. Los cambios se aplican en vivo.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-border bg-surface p-4">
                {form.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={form.logoUrl}
                    alt="Logo del tenant"
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
                  Tarjeta destacada
                </h4>
                <p className="mt-1 text-sm text-text-muted">Curso de liderazgo · 12 módulos</p>
              </div>
              <button
                type="button"
                className="w-full rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors"
                style={{
                  backgroundColor: `hsl(${form.brandHue}, ${form.brandSaturation}%, 45%)`,
                }}
              >
                Botón primario
              </button>
              <Badge
                style={{
                  backgroundColor: `hsl(${form.brandHue}, ${form.brandSaturation}%, 96%)`,
                  color: `hsl(${form.brandHue}, ${form.brandSaturation + 5}%, 30%)`,
                }}
              >
                Etiqueta
              </Badge>
            </CardContent>
          </Card>
        </aside>

        <div className="flex items-center justify-between gap-4 lg:col-span-3">
          <div className="text-sm">
            {status === 'saved' ? (
              <span className="inline-flex items-center gap-1.5 font-semibold text-success-700">
                <Icon name="check" size={16} />
                Cambios guardados
              </span>
            ) : status === 'error' && error ? (
              <span className="font-semibold text-danger-700">{error}</span>
            ) : (
              <span className="text-text-subtle">
                Al guardar, los cambios afectarán a todos los usuarios de tu organización.
              </span>
            )}
          </div>
          <Button type="submit" disabled={status === 'saving'} size="lg">
            {status === 'saving' ? 'Guardando…' : 'Guardar cambios'}
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
  return (
    <Card
      role="region"
      aria-label="Funcionalidades Enterprise white-label"
      className="border-dashed"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="lock" size={18} />
          Función Enterprise — actualiza tu plan
        </CardTitle>
        <CardDescription>
          El CSS personalizado y el footer HTML del tenant son parte del paquete white-label de
          Didacta Enterprise. Tu plan actual (community) no incluye esta funcionalidad.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          Con la licencia Enterprise activa podrás inyectar reglas CSS propias, sustituir el footer
          por HTML personalizado y ocultar la marca Didacta. La capability requerida es{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
            feat:white_label
          </code>
          .
        </p>
        <a
          href="https://didacta.io/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
        >
          Ver planes Enterprise
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
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleUpload(file: File) {
    setError(null);
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Formato no soportado. Sube PNG, JPG, SVG o WebP.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('El archivo supera los 2 MB.');
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
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos subir el logo.');
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    if (!confirm('¿Eliminar el logo subido? Volverás al wordmark Didacta.')) return;
    const token = authStorage.getAccessToken();
    if (!token) return;
    setBusy('remove');
    setError(null);
    try {
      const updated = await themingApi.removeLogo(token);
      publishThemeUpdate(updated);
      onRemoved();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos eliminar el logo.');
    } finally {
      setBusy(null);
    }
  }

  const showPreview = isUploaded && currentLogoUrl;

  return (
    <div className="space-y-3">
      <Label>Logo subido</Label>
      {showPreview ? (
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-surface-2 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={currentLogoUrl}
            alt="Logo subido del tenant"
            className="h-12 max-w-[200px] object-contain"
          />
          <div className="flex flex-1 items-center justify-between gap-2">
            <p className="text-xs text-text-muted">
              El logo está subido en el storage del tenant. Para cambiarlo, sube otro archivo.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRemove}
              disabled={busy !== null}
            >
              {busy === 'remove' ? 'Eliminando…' : 'Eliminar'}
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
            ? 'Subiendo…'
            : showPreview
              ? 'Reemplazar logo'
              : 'Subir logo al storage'}
        </p>
        <p className="mt-1 text-xs text-text-muted">
          PNG, JPG, SVG o WebP. Máximo 2 MB. Arrastra o haz clic para seleccionar.
        </p>
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

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
