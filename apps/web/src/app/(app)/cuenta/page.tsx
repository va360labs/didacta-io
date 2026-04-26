'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { LOCALE_OPTIONS, meApi, TIMEZONE_OPTIONS, type UserProfile } from '@/lib/me';

function getInitials(name: string | null, email: string): string {
  const source = (name ?? email.split('@')[0] ?? '').trim();
  if (!source) return '?';
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export default function CuentaPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState('');
  const [locale, setLocale] = useState('es-AR');
  const [timezone, setTimezone] = useState('UTC');
  const [avatarUrl, setAvatarUrl] = useState('');

  async function reload() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      setError(null);
      const p = await meApi.getProfile(token);
      setProfile(p);
      setName(p.name ?? '');
      setLocale(p.locale);
      setTimezone(p.timezone);
      setAvatarUrl(p.avatarUrl ?? '');
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar tu perfil.');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const token = authStorage.getAccessToken();
    if (!token) return;
    setPending(true);
    setError(null);
    setSuccess(false);
    try {
      await meApi.updateProfile(token, {
        name: name.trim(),
        locale,
        timezone,
        avatarUrl: avatarUrl.trim() || null,
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2500);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos guardar los cambios.');
    } finally {
      setPending(false);
    }
  }

  if (!profile && !error) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-12 w-64" />
        <div className="skeleton h-48 w-full" />
      </div>
    );
  }

  if (error && !profile) {
    return (
      <Card>
        <CardContent className="p-6 text-danger-700">{error}</CardContent>
      </Card>
    );
  }

  if (!profile) return null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-4">
        <div
          className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-500 text-text-on-brand text-xl font-bold"
          style={
            profile.avatarUrl
              ? { backgroundImage: `url(${profile.avatarUrl})`, backgroundSize: 'cover' }
              : undefined
          }
        >
          {profile.avatarUrl ? null : getInitials(profile.name, profile.email)}
        </div>
        <div className="flex-1">
          <h1 className="font-display text-3xl font-bold tracking-tight">
            {profile.name ?? profile.email}
          </h1>
          <p className="text-text-muted">{profile.email}</p>
        </div>
        <Button variant="secondary" asChild>
          <Link href="/cuenta/seguridad">Seguridad</Link>
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Perfil</CardTitle>
          <CardDescription>
            Tu nombre, idioma y zona horaria. Estos datos se muestran a tus formadores y se usan
            para formatear fechas y horas.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="name">Nombre completo</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input id="email" value={profile.email} disabled />
                <p className="text-xs text-text-subtle">
                  Para cambiar tu email, pedile a tu admin.
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="locale">Idioma</Label>
                <Select id="locale" value={locale} onChange={(e) => setLocale(e.target.value)}>
                  {LOCALE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="timezone">Zona horaria</Label>
                <Select
                  id="timezone"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                >
                  {TIMEZONE_OPTIONS.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.values.map((tz) => (
                        <option key={tz} value={tz}>
                          {tz}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="avatarUrl">URL del avatar</Label>
              <Input
                id="avatarUrl"
                type="url"
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                placeholder="https://… (deja vacío para usar tus iniciales)"
              />
            </div>

            {error ? (
              <p role="alert" className="text-sm text-danger-700">
                {error}
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              {success ? (
                <span className="text-sm font-semibold text-success-700">✓ Cambios guardados</span>
              ) : (
                <span className="text-sm text-text-subtle">
                  Los cambios se aplican al recargar la página.
                </span>
              )}
              <Button type="submit" disabled={pending}>
                {pending ? 'Guardando…' : 'Guardar cambios'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Información de la cuenta</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <p className="text-text-subtle">Roles</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {profile.roles.map((r) => (
                <Badge key={r} variant="muted">
                  {r}
                </Badge>
              ))}
            </div>
          </div>
          <div>
            <p className="text-text-subtle">MFA</p>
            <p>
              {profile.mfaEnabled ? (
                <Badge variant="success">Activo</Badge>
              ) : (
                <Badge variant="muted">No configurado</Badge>
              )}
            </p>
          </div>
          <div>
            <p className="text-text-subtle">Creada</p>
            <p className="tabular-nums">
              {new Date(profile.createdAt).toLocaleDateString('es-AR', {
                day: '2-digit',
                month: 'long',
                year: 'numeric',
              })}
            </p>
          </div>
          <div>
            <p className="text-text-subtle">Último login</p>
            <p className="tabular-nums">
              {profile.lastLoginAt ? new Date(profile.lastLoginAt).toLocaleString('es-AR') : '—'}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
