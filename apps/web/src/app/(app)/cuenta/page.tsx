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
import { Textarea } from '@/components/ui/textarea';
import { AvatarUpload } from '@/components/avatar-upload';
import { NotificationMatrix, fullMatrix } from '@/components/notification-preferences-form';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { communityApi } from '@/modules/community';
import {
  LOCALE_OPTIONS,
  meApi,
  TIMEZONE_OPTIONS,
  type NotificationPreference,
  type UserProfile,
} from '@/lib/me';

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
  const [bio, setBio] = useState('');
  const [prefs, setPrefs] = useState<NotificationPreference[]>(fullMatrix([]));
  const [prefsPending, setPrefsPending] = useState(false);
  const [prefsSaved, setPrefsSaved] = useState(false);
  // Si el módulo community está deshabilitado, getMyPreferences devuelve 403;
  // en ese caso no sincronizamos la celda Comunidad×Email con el digest.
  const [digestAvailable, setDigestAvailable] = useState(true);

  async function reload() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      setError(null);
      const p = await meApi.getProfile(token);
      setProfile(p);
      setName(p.name ?? '');
      setBio(p.bio ?? '');
      setLocale(p.locale);
      setTimezone(p.timezone);
      setAvatarUrl(p.avatarUrl ?? '');
      setDocumentId(p.documentId ?? '');
      // Matriz de preferencias de notificación (core).
      let matrix = fullMatrix((await meApi.getNotificationPreferences(token)).preferences);
      // Reconciliar Comunidad×Email con el digest del módulo community. Si está
      // deshabilitado, el endpoint devuelve 403/404 y dejamos el default.
      try {
        const c = await communityApi.getMyPreferences();
        matrix = matrix.map((m) =>
          m.category === 'COMMUNITY' && m.channel === 'EMAIL'
            ? { ...m, enabled: !c.digestOptOut }
            : m,
        );
        setDigestAvailable(true);
      } catch (e) {
        if (e instanceof ApiHttpError && (e.status === 403 || e.status === 404)) {
          setDigestAvailable(false);
        }
      }
      setPrefs(matrix);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar tu perfil.');
    }
  }

  async function handleSavePrefs() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setPrefsPending(true);
    setPrefsSaved(false);
    try {
      const res = await meApi.updateNotificationPreferences(token, prefs);
      setPrefs(fullMatrix(res.preferences));
      // Reconciliar el digest de community con la celda Comunidad×Email.
      const communityEmail = prefs.find((p) => p.category === 'COMMUNITY' && p.channel === 'EMAIL');
      if (communityEmail && digestAvailable) {
        try {
          await communityApi.updateMyPreferences({ digestOptOut: !communityEmail.enabled });
        } catch {
          /* community deshabilitado */
        }
      }
      setPrefsSaved(true);
      setTimeout(() => setPrefsSaved(false), 2500);
    } catch {
      // Dejamos el estado como está; el usuario puede reintentar.
    } finally {
      setPrefsPending(false);
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
        bio: bio.trim() === '' ? null : bio.trim(),
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
            className="font-display text-2xl font-bold tracking-tight"
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
                      Para cambiar tu email, pídele a tu admin.
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
                  <Label>Foto de perfil</Label>
                  <AvatarUpload
                    value={avatarUrl || null}
                    onChange={(u) => setAvatarUrl(u ?? '')}
                    name={name || null}
                    email={profile.email}
                  />
                  <p className="text-xs text-text-subtle">
                    Los cambios de la foto se aplican al pulsar «Guardar cambios».
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="bio">Biografía</Label>
                  <Textarea
                    id="bio"
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    maxLength={280}
                    rows={3}
                    placeholder="Cuéntanos algo sobre ti (máx 280 caracteres)"
                  />
                  <p className="text-right text-xs text-text-subtle">{bio.length}/280</p>
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
                  {new Date(profile.createdAt).toLocaleDateString('es-ES', {
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
                    ? new Date(profile.lastLoginAt).toLocaleString('es-ES')
                    : '—'}
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notificaciones" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Notificaciones</CardTitle>
              <CardDescription>
                Elige por qué canal quieres recibir cada tipo de aviso. Los avisos críticos
                (seguridad, cuenta) se envían siempre.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <NotificationMatrix value={prefs} onChange={setPrefs} disabled={prefsPending} />
              {!digestAvailable ? (
                <p className="text-xs text-text-subtle">
                  La comunidad no está habilitada en tu organización todavía; la fila «Comunidad» no
                  tendrá efecto hasta que se active.
                </p>
              ) : null}
              <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                {prefsSaved ? (
                  <span className="text-sm font-semibold text-success-700">
                    ✓ Preferencias guardadas
                  </span>
                ) : (
                  <span className="text-sm text-text-subtle">
                    Tus cambios se aplican al guardar.
                  </span>
                )}
                <Button
                  type="button"
                  onClick={() => void handleSavePrefs()}
                  disabled={prefsPending}
                >
                  {prefsPending ? 'Guardando…' : 'Guardar preferencias'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="seguridad" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Seguridad</CardTitle>
              <CardDescription>
                Cambia tu contraseña, configura MFA y gestiona las sesiones activas.
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
