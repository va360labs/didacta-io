'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
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
import { themeCache, themingApi, type TenantTheme } from '@/lib/theming';

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
      themeCache.save(updated);
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
      themeCache.save(fresh);
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
            Personalizá la identidad visual de tu organización. Los cambios se guardan al hacer clic
            en <span className="font-semibold">Guardar</span>; podés ver una vista previa mientras
            editás.
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
                Movés el matiz y la saturación; los 10 escalones de la paleta se derivan
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
              <CardTitle>Logos</CardTitle>
              <CardDescription>
                Pegá la URL pública (https) del logo y favicon. La subida directa con el gestor de
                archivos llegará en una versión posterior.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="logoUrl">URL del logo principal</Label>
                <Input
                  id="logoUrl"
                  type="url"
                  placeholder="https://cdn.tudominio.com/logo.svg"
                  value={form.logoUrl}
                  onChange={(e) => setForm((f) => f && { ...f, logoUrl: e.target.value })}
                  className="mt-1.5"
                />
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
                {Math.round(new TextEncoder().encode(form.customCss).length / 102.4) / 10} KB de 16
                KB
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Footer personalizado</CardTitle>
              <CardDescription>
                HTML del footer (sanitizado a etiquetas básicas). Aparece en el pie de las pantallas
                autenticadas. Máximo 4&nbsp;KB.
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
