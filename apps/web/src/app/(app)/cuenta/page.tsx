'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { communityApi } from '@/lib/community';
import { LOCALE_OPTIONS, meApi, TIMEZONE_OPTIONS, type UserProfile } from '@/lib/me';

function humanRole(role: string): string {
  switch (role) {
    case 'super_admin':
      return 'Super admin';
    case 'tenant_admin':
      return 'Admin';
    case 'formador':
      return 'Formador';
    case 'alumno':
      return 'Alumno';
    case 'auditor':
      return 'Auditor';
    case 'empresa_manager':
      return 'Manager';
    default:
      return role;
  }
}

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
  const [documentId, setDocumentId] = useState('');
  const [digestOptOut, setDigestOptOut] = useState(false);
  const [digestPending, setDigestPending] = useState(false);
  const [digestSaved, setDigestSaved] = useState(false);
  // Si el módulo community está deshabilitado para el tenant, el endpoint
  // devuelve 403 y ocultamos la card directamente (no tiene sentido
  // mostrarle al usuario un toggle que no funciona).
  const [digestAvailable, setDigestAvailable] = useState(true);

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
      setDocumentId(p.documentId ?? '');
      // Cargar preferencias en paralelo. Si community está deshabilitado en
      // el tenant, el endpoint devuelve 403 y ocultamos la card.
      try {
        const prefs = await communityApi.getMyPreferences();
        setDigestOptOut(prefs.digestOptOut);
        setDigestAvailable(true);
      } catch (e) {
        if (e instanceof ApiHttpError && (e.status === 403 || e.status === 404)) {
          setDigestAvailable(false);
        }
      }
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar tu perfil.');
    }
  }

  async function handleDigestToggle(next: boolean) {
    setDigestPending(true);
    setDigestSaved(false);
    try {
      const r = await communityApi.updateMyPreferences({ digestOptOut: next });
      setDigestOptOut(r.digestOptOut);
      setDigestSaved(true);
      setTimeout(() => setDigestSaved(false), 2500);
    } catch {
      // Revertir en caso de fallo.
      setDigestOptOut(!next);
    } finally {
      setDigestPending(false);
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
        documentId: documentId.trim() === '' ? null : documentId.trim().toUpperCase(),
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
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-48 w-full" />
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
      <header className="flex flex-wrap items-center gap-5">
        <div
          aria-hidden="true"
          className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-full font-display text-xl font-bold text-white"
          style={
            profile.avatarUrl
              ? {
                  backgroundImage: `url(${profile.avatarUrl})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }
              : { background: 'linear-gradient(135deg, #2E7DCE 0%, #18B5A8 100%)' }
          }
        >
          {profile.avatarUrl ? null : getInitials(profile.name, profile.email)}
        </div>
        <div className="min-w-0 flex-1">
          <h1
            className="font-display text-3xl font-bold tracking-tight"
            style={{ letterSpacing: '-0.02em' }}
          >
            {profile.name ?? profile.email}
          </h1>
          <p className="mt-0.5 text-text-muted">{profile.email}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {profile.roles.map((r) => (
              <Badge
                key={r}
                variant={r === 'super_admin' || r === 'tenant_admin' ? 'premium' : 'info'}
              >
                {humanRole(r)}
              </Badge>
            ))}
          </div>
        </div>
      </header>

      <Tabs defaultValue="datos" className="space-y-6">
        <TabsList>
          <TabsTrigger value="datos">Datos</TabsTrigger>
          <TabsTrigger value="notificaciones">Notificaciones</TabsTrigger>
          <TabsTrigger value="seguridad">Seguridad</TabsTrigger>
        </TabsList>

        <TabsContent value="datos" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Perfil</CardTitle>
              <CardDescription>
                Tu nombre, idioma, zona horaria y DNI/NIE para Fundae.
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

                <div className="space-y-1.5">
                  <Label htmlFor="documentId">DNI / NIE</Label>
                  <Input
                    id="documentId"
                    value={documentId}
                    onChange={(e) => setDocumentId(e.target.value)}
                    placeholder="12345678Z o X1234567L (vacío si no aplica)"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={20}
                  />
                  <p className="text-xs text-text-subtle">
                    Solo necesario si vas a participar en acciones formativas Fundae. Aceptamos DNI
                    o NIE español. Lo guardamos normalizado en mayúsculas.
                  </p>
                </div>

                {error ? (
                  <p role="alert" className="text-sm text-danger-700">
                    {error}
                  </p>
                ) : null}

                <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                  {success ? (
                    <span className="text-sm font-semibold text-success-700">
                      ✓ Cambios guardados
                    </span>
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
            <CardContent className="grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <p className="label-uppercase text-text-muted">MFA</p>
                <div className="mt-1.5">
                  {profile.mfaEnabled ? (
                    <Badge variant="success" dot>
                      Activo
                    </Badge>
                  ) : (
                    <Badge variant="muted">No configurado</Badge>
                  )}
                </div>
              </div>
              <div>
                <p className="label-uppercase text-text-muted">Cuenta creada</p>
                <p className="mt-1.5 tabular-nums">
                  {new Date(profile.createdAt).toLocaleDateString('es-AR', {
                    day: '2-digit',
                    month: 'long',
                    year: 'numeric',
                  })}
                </p>
              </div>
              <div>
                <p className="label-uppercase text-text-muted">Último login</p>
                <p className="mt-1.5 tabular-nums">
                  {profile.lastLoginAt
                    ? new Date(profile.lastLoginAt).toLocaleString('es-AR')
                    : '—'}
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notificaciones" className="space-y-6">
          {digestAvailable ? (
            <Card>
              <CardHeader>
                <CardTitle>Notificaciones</CardTitle>
                <CardDescription>
                  Controlá qué emails y avisos recibís de la plataforma. Los avisos críticos
                  (seguridad, cuenta) se envían siempre.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <label className="flex items-start gap-3 rounded-lg border border-border-soft p-4 transition hover:border-border-strong">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-border-strong"
                    checked={!digestOptOut}
                    disabled={digestPending}
                    onChange={(e) => void handleDigestToggle(!e.target.checked)}
                  />
                  <span className="flex-1 space-y-1">
                    <span className="block font-medium text-text">
                      Resumen semanal de comunidad
                    </span>
                    <span className="block text-sm text-text-muted">
                      Email cada lunes con tus menciones y respuestas de la semana. Si lo
                      desactivás, no recibirás este resumen pero sigues viendo todo en{' '}
                      <Link href="/comunidad" className="underline">
                        Comunidad
                      </Link>
                      .
                    </span>
                    {digestSaved ? (
                      <span className="block text-xs font-semibold text-success-700">
                        ✓ Guardado
                      </span>
                    ) : null}
                  </span>
                </label>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-6 text-text-muted">
                Tu organización no tiene la funcionalidad de comunidad habilitada todavía. Cuando se
                active, vas a poder gestionar tus emails de resumen desde acá.
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="seguridad" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Seguridad</CardTitle>
              <CardDescription>
                Cambiá tu contraseña, configurá MFA y gestioná las sesiones activas.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm text-text-muted">
                  MFA actual:{' '}
                  {profile.mfaEnabled ? (
                    <Badge variant="success" dot>
                      Activo
                    </Badge>
                  ) : (
                    <Badge variant="muted">No configurado</Badge>
                  )}
                </p>
              </div>
              <Button asChild>
                <Link href="/cuenta/seguridad">
                  <Icon name="lock" size={16} />
                  Ir a seguridad
                </Link>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
