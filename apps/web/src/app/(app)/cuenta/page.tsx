'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, type IconName } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { AccountSecurityTab } from '@/components/account-security-tab';
import { SubscriptionTab } from '@/components/subscription-tab';
import { AvatarUpload } from '@/components/avatar-upload';
import { CompetencyRadar } from '@/components/competency-radar';
import { NotificationMatrix, fullMatrix } from '@/components/notification-preferences-form';
import { ApiHttpError } from '@/lib/api-client';
import { toSupportedLocale } from '@/i18n/config';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate, formatDateTime } from '@/lib/i18n/format';
import { writeLocaleCookie } from '@/lib/i18n/locale-cookie';
import type { TranslatorLike } from '@/lib/i18n/labels';
import { learningApi, type MyCompetencies } from '@/lib/learning';
import { authStorage } from '@/lib/auth-storage';
import { loadProfileStats, type ProfileStats } from '@/lib/profile-stats';
import { communityApi } from '@/modules/community';
import { certificatesApi, type Certificate } from '@/modules/certificates';
import {
  LOCALE_OPTIONS,
  meApi,
  TIMEZONE_OPTIONS,
  type NotificationPreference,
  type UserProfile,
} from '@/lib/me';

/** Rol (enum del backend) → key del catálogo. Clave abierta: desconocido → crudo. */
const ROLE_KEYS: Record<string, string> = {
  super_admin: 'cuenta.roleSuperAdmin',
  tenant_admin: 'cuenta.roleAdmin',
  formador: 'cuenta.roleFormador',
  alumno: 'cuenta.roleAlumno',
  auditor: 'cuenta.roleAuditor',
  empresa_manager: 'cuenta.roleManager',
};

function humanRole(role: string, t: TranslatorLike): string {
  const key = ROLE_KEYS[role];
  return key ? t(key) : role;
}

function getInitials(name: string | null, email: string): string {
  const source = (name ?? email.split('@')[0] ?? '').trim();
  if (!source) return '?';
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function localeLabel(value: string): string {
  return LOCALE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

function monthYear(iso: string): string {
  const s = formatDate(iso, { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function CuentaPage() {
  const router = useRouter();
  const t = useTranslations('alumnoSocial');
  const tErrors = useTranslations('errors');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [recentCerts, setRecentCerts] = useState<Certificate[] | null>(null);
  const [competencies, setCompetencies] = useState<MyCompetencies | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [success, setSuccess] = useState(false);
  const [pending, setPending] = useState(false);

  // Form state (modo edición)
  const [name, setName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [location, setLocation] = useState('');
  const [locale, setLocale] = useState('es-AR');
  const [timezone, setTimezone] = useState('UTC');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [bio, setBio] = useState('');

  // Notificaciones
  const [prefs, setPrefs] = useState<NotificationPreference[]>(fullMatrix([]));
  const [prefsPending, setPrefsPending] = useState(false);
  const [prefsSaved, setPrefsSaved] = useState(false);
  const [digestAvailable, setDigestAvailable] = useState(true);

  function hydrateForm(p: UserProfile) {
    setName(p.name ?? '');
    setJobTitle(p.jobTitle ?? '');
    setDepartment(p.department ?? '');
    setLocation(p.location ?? '');
    setBio(p.bio ?? '');
    setLocale(p.locale);
    setTimezone(p.timezone);
    setAvatarUrl(p.avatarUrl ?? '');
    setDocumentId(p.documentId ?? '');
  }

  async function reload() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      setError(null);
      const p = await meApi.getProfile(token);
      setProfile(p);
      hydrateForm(p);
      let matrix = fullMatrix((await meApi.getNotificationPreferences(token)).preferences);
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
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('cuenta.errorPerfil'));
    }
  }

  useEffect(() => {
    void reload();
    // Stats y certificados recientes: best-effort, no bloquean el perfil.
    void loadProfileStats()
      .then(setStats)
      .catch(() => setStats(null));
    void certificatesApi
      .listMine()
      .then((list) => setRecentCerts(list.filter((c) => c.revokedAt === null).slice(0, 3)))
      .catch(() => setRecentCerts([]));
    void learningApi
      .getMyCompetencies()
      .then(setCompetencies)
      .catch(() => setCompetencies({ competencies: [], globalScore: null, globalLevel: null }));
  }, []);

  async function handleSavePrefs() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setPrefsPending(true);
    setPrefsSaved(false);
    try {
      const res = await meApi.updateNotificationPreferences(token, prefs);
      setPrefs(fullMatrix(res.preferences));
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
      /* el usuario puede reintentar */
    } finally {
      setPrefsPending(false);
    }
  }

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
        jobTitle: jobTitle.trim() === '' ? null : jobTitle.trim(),
        department: department.trim() === '' ? null : department.trim(),
        location: location.trim() === '' ? null : location.trim(),
        bio: bio.trim() === '' ? null : bio.trim(),
        locale,
        timezone,
        avatarUrl: avatarUrl.trim() || null,
        documentId: documentId.trim() === '' ? null : documentId.trim().toUpperCase(),
      });
      // Refrescar nombre/avatar en la sesión y avisar al sidebar.
      const session = authStorage.getSession();
      if (session) {
        session.user.name = name.trim();
        session.user.avatarUrl = avatarUrl.trim() || null;
        authStorage.saveSession(session);
        window.dispatchEvent(new Event('didacta:session-updated'));
      }
      // Cambio de idioma: además del evento (que LocaleSync resuelve async con
      // un GET /me), escribimos la cookie YA y refrescamos los RSC para que la
      // UI cambie de idioma en este mismo ciclo, sin carrera con la red.
      if (profile && locale !== profile.locale) {
        writeLocaleCookie(toSupportedLocale(locale));
        router.refresh();
      }
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2500);
      await reload();
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('cuenta.errorGuardar'));
    } finally {
      setPending(false);
    }
  }

  if (!profile && !error) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
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

  const isAdmin = profile.roles.some((r) => r === 'super_admin' || r === 'tenant_admin');
  // Pestaña inicial desde la URL (?tab=seguridad) — usado por el gate de
  // contraseña temporal, que redirige a /cuenta?tab=seguridad.
  const initialTab =
    typeof window !== 'undefined'
      ? (new URLSearchParams(window.location.search).get('tab') ?? 'datos')
      : 'datos';

  return (
    <div className="flex flex-col gap-6">
      {/* ── Cabecera ── */}
      <header className="flex flex-wrap items-start gap-5">
        <div className="relative shrink-0">
          <div
            aria-hidden="true"
            className="grid h-16 w-16 place-items-center overflow-hidden rounded-full font-display text-xl font-bold text-white"
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
          <span
            className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface bg-success-500"
            title={t('cuenta.enLinea')}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1
              className="font-display text-2xl font-bold tracking-tight text-text"
              style={{ letterSpacing: '-0.02em' }}
            >
              {profile.name ?? profile.email}
            </h1>
            {profile.roles.slice(0, 1).map((r) => (
              <Badge key={r} variant={isAdmin ? 'premium' : 'info'}>
                {humanRole(r, t)}
              </Badge>
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Icon name="mail" size={14} />
              {profile.email}
            </span>
            {profile.jobTitle ? (
              <span className="inline-flex items-center gap-1.5">
                <Icon name="briefcase" size={14} />
                {profile.jobTitle}
              </span>
            ) : null}
            {profile.location ? (
              <span className="inline-flex items-center gap-1.5">
                <Icon name="map-pin" size={14} />
                {profile.location}
              </span>
            ) : null}
          </div>
        </div>

        {!editing ? (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            <Icon name="edit" size={16} />
            {t('cuenta.editarPerfil')}
          </Button>
        ) : null}
      </header>

      <Tabs defaultValue={initialTab} className="space-y-6">
        <TabsList>
          <TabsTrigger value="datos">{t('cuenta.tabDatos')}</TabsTrigger>
          <TabsTrigger value="notificaciones">{t('cuenta.tabNotificaciones')}</TabsTrigger>
          <TabsTrigger value="suscripcion">{t('cuenta.tabSuscripcion')}</TabsTrigger>
          <TabsTrigger value="seguridad">{t('cuenta.tabSeguridad')}</TabsTrigger>
        </TabsList>

        {/* ── Datos ── */}
        <TabsContent value="datos" className="space-y-6">
          {editing ? (
            <EditProfileForm
              name={name}
              setName={setName}
              jobTitle={jobTitle}
              setJobTitle={setJobTitle}
              department={department}
              setDepartment={setDepartment}
              location={location}
              setLocation={setLocation}
              bio={bio}
              setBio={setBio}
              locale={locale}
              setLocale={setLocale}
              timezone={timezone}
              setTimezone={setTimezone}
              avatarUrl={avatarUrl}
              setAvatarUrl={setAvatarUrl}
              documentId={documentId}
              setDocumentId={setDocumentId}
              email={profile.email}
              error={error}
              success={success}
              pending={pending}
              onSubmit={onSubmit}
              onCancel={() => {
                hydrateForm(profile);
                setError(null);
                setEditing(false);
              }}
            />
          ) : (
            <>
              <StatCards stats={stats} />
              <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_1fr]">
                <div className="flex flex-col gap-6">
                  <PersonalInfoCard profile={profile} />
                  {profile.bio ? (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">{t('cuenta.biografia')}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-muted">
                          {profile.bio}
                        </p>
                      </CardContent>
                    </Card>
                  ) : null}
                  <AccountInfoCard profile={profile} />
                </div>
                <div className="flex flex-col gap-6">
                  <CompetencyMapCard data={competencies} />
                  <RecentCertificatesCard certs={recentCerts} />
                </div>
              </div>
            </>
          )}
        </TabsContent>

        {/* ── Notificaciones ── */}
        <TabsContent value="notificaciones" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('cuenta.notificaciones')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <NotificationMatrix value={prefs} onChange={setPrefs} disabled={prefsPending} />
              {!digestAvailable ? (
                <p className="text-xs text-text-subtle">{t('cuenta.comunidadNoHabilitada')}</p>
              ) : null}
              <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                {prefsSaved ? (
                  <span className="text-sm font-semibold text-success-700">
                    {t('cuenta.preferenciasGuardadas')}
                  </span>
                ) : (
                  <span className="text-sm text-text-subtle">{t('cuenta.cambiosAlGuardar')}</span>
                )}
                <Button
                  type="button"
                  onClick={() => void handleSavePrefs()}
                  disabled={prefsPending}
                >
                  {prefsPending ? t('cuenta.guardando') : t('cuenta.guardarPreferencias')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Suscripción ── */}
        <TabsContent value="suscripcion" className="space-y-6">
          <SubscriptionTab />
        </TabsContent>

        {/* ── Seguridad ── */}
        <TabsContent value="seguridad" className="space-y-6">
          <AccountSecurityTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Sub-componentes ──────────────────────────────────────────────────────────

function StatCards({ stats }: { stats: ProfileStats | null }) {
  const t = useTranslations('alumnoSocial');
  const items: Array<{ icon: IconName; value: string; label: string; accent: string }> = [
    {
      icon: 'book',
      value: stats?.completedCourses != null ? String(stats.completedCourses) : '—',
      label: t('cuenta.statCursosCompletados'),
      accent: '#2E7DCE',
    },
    {
      icon: 'clock',
      value:
        stats?.trainingHours != null
          ? t('cuenta.statHorasValor', { hours: stats.trainingHours })
          : '—',
      label: t('cuenta.statHorasFormacion'),
      accent: '#18B5A8',
    },
    {
      icon: 'award',
      value: stats?.certificates != null ? String(stats.certificates) : '—',
      label: t('cuenta.statCertificados'),
      accent: '#1E5AA8',
    },
    {
      icon: 'trending',
      value:
        stats?.rankingTopPercent != null
          ? t('cuenta.statTop', { percent: stats.rankingTopPercent })
          : '—',
      label: t('cuenta.statRanking'),
      accent: '#FF6F61',
    },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((s) => (
        <Card key={s.label}>
          <CardContent className="flex items-center gap-3 p-4">
            <div
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
              style={{
                backgroundColor: `color-mix(in srgb, ${s.accent} 14%, transparent)`,
                color: s.accent,
              }}
            >
              <Icon name={s.icon} size={20} />
            </div>
            <div className="min-w-0">
              <div className="font-display text-xl font-bold leading-tight text-text">
                {s.value}
              </div>
              <div className="truncate text-xs text-text-muted">{s.label}</div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function InfoRow({ icon, label, value }: { icon: IconName; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="inline-flex items-center gap-2 text-sm text-text-muted">
        <Icon name={icon} size={15} className="text-text-subtle" />
        {label}
      </span>
      <span className="truncate text-right text-sm font-medium text-text">{value || '—'}</span>
    </div>
  );
}

function PersonalInfoCard({ profile }: { profile: UserProfile }) {
  const t = useTranslations('alumnoSocial');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('cuenta.infoPersonal')}</CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-[#F1F5F9] py-0">
        <InfoRow icon="briefcase" label={t('cuenta.cargo')} value={profile.jobTitle} />
        <InfoRow icon="building" label={t('cuenta.departamento')} value={profile.department} />
        <InfoRow icon="globe" label={t('cuenta.idioma')} value={localeLabel(profile.locale)} />
        <InfoRow icon="clock" label={t('cuenta.zonaHoraria')} value={profile.timezone} />
        <InfoRow
          icon="calendar"
          label={t('cuenta.miembroDesde')}
          value={monthYear(profile.createdAt)}
        />
        <InfoRow icon="shield" label={t('cuenta.dniNie')} value={profile.documentId} />
      </CardContent>
    </Card>
  );
}

function AccountInfoCard({ profile }: { profile: UserProfile }) {
  const t = useTranslations('alumnoSocial');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('cuenta.infoCuenta')}</CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-[#F1F5F9] py-0">
        <div className="flex items-center justify-between gap-3 py-2.5">
          <span className="inline-flex items-center gap-2 text-sm text-text-muted">
            <Icon name="lock" size={15} className="text-text-subtle" />
            {t('cuenta.mfa')}
          </span>
          {profile.mfaEnabled ? (
            <Badge variant="success" dot>
              {t('cuenta.mfaActivo')}
            </Badge>
          ) : (
            <Badge variant="muted">{t('cuenta.mfaNoConfigurado')}</Badge>
          )}
        </div>
        <InfoRow
          icon="calendar"
          label={t('cuenta.cuentaCreada')}
          value={formatDate(profile.createdAt, {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          })}
        />
        <InfoRow
          icon="clock"
          label={t('cuenta.ultimoAcceso')}
          value={profile.lastLoginAt ? formatDateTime(profile.lastLoginAt) : '—'}
        />
      </CardContent>
    </Card>
  );
}

function RecentCertificatesCard({ certs }: { certs: Certificate[] | null }) {
  const t = useTranslations('alumnoSocial');
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">{t('cuenta.certsRecientes')}</CardTitle>
        <Link
          href="/mis-certificados"
          className="text-xs font-medium text-brand-700 hover:underline"
        >
          {t('cuenta.verTodos')}
        </Link>
      </CardHeader>
      <CardContent>
        {certs === null ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : certs.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-muted">{t('cuenta.sinCertificados')}</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {certs.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-3 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3"
              >
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white text-[#1E5AA8]">
                  <Icon name="award" size={20} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text">
                    {c.snapshot?.courseTitle ?? t('cuenta.certificadoNumero', { number: c.number })}
                  </p>
                  <p className="text-xs text-text-muted">
                    {t('cuenta.emitidoEl', {
                      date: formatDate(c.issuedAt, {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                      }),
                    })}
                  </p>
                </div>
                <Badge variant="success" dot>
                  {t('cuenta.verificado')}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function CompetencyMapCard({ data }: { data: MyCompetencies | null }) {
  const t = useTranslations('alumnoSocial');
  if (data === null) {
    return (
      <Card>
        <CardContent className="p-6">
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (data.competencies.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('cuenta.mapaCompetencias')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="py-8 text-center text-sm text-text-muted">{t('cuenta.sinCompetencias')}</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>{t('cuenta.mapaCompetencias')}</CardTitle>
          <p className="mt-0.5 text-sm text-text-muted">{t('cuenta.basadoProgreso')}</p>
        </div>
        {data.globalScore != null ? (
          <div className="rounded-xl border border-border bg-surface-2 px-3 py-1.5 text-right">
            <div className="label-uppercase text-[10px] text-text-subtle">
              {t('cuenta.nivelGlobal')}
            </div>
            <div className="font-display text-sm font-bold text-text">
              {t('cuenta.nivelValor', { level: data.globalLevel ?? '', score: data.globalScore })}
            </div>
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="grid items-center gap-6 lg:grid-cols-2">
          <div className="grid place-items-center">
            <CompetencyRadar data={data.competencies} />
          </div>
          <ul className="flex flex-col gap-3">
            {data.competencies.map((c) => (
              <li key={c.id}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="font-medium text-text">{c.name}</span>
                  <span className="tabular-nums font-semibold text-text">{c.score}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#F1F5F9]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(0, Math.min(100, c.score))}%`,
                      backgroundColor: '#FF6F61',
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function EditProfileForm(props: {
  name: string;
  setName: (v: string) => void;
  jobTitle: string;
  setJobTitle: (v: string) => void;
  department: string;
  setDepartment: (v: string) => void;
  location: string;
  setLocation: (v: string) => void;
  bio: string;
  setBio: (v: string) => void;
  locale: string;
  setLocale: (v: string) => void;
  timezone: string;
  setTimezone: (v: string) => void;
  avatarUrl: string;
  setAvatarUrl: (v: string) => void;
  documentId: string;
  setDocumentId: (v: string) => void;
  email: string;
  error: string | null;
  success: boolean;
  pending: boolean;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
}) {
  const p = props;
  const t = useTranslations('alumnoSocial');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('cuenta.editarPerfil')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={p.onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t('cuenta.fotoPerfil')}</Label>
            <AvatarUpload
              value={p.avatarUrl || null}
              onChange={(u) => p.setAvatarUrl(u ?? '')}
              name={p.name || null}
              email={p.email}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="name">{t('cuenta.nombreCompleto')}</Label>
              <Input
                id="name"
                value={p.name}
                onChange={(e) => p.setName(e.target.value)}
                maxLength={120}
              />
              <p className="text-xs text-text-subtle">{t('cuenta.nombreAyuda')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">{t('cuenta.email')}</Label>
              <Input id="email" value={p.email} disabled />
              <p className="text-xs text-text-subtle">{t('cuenta.emailAyuda')}</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="jobTitle">{t('cuenta.cargo')}</Label>
              <Input
                id="jobTitle"
                value={p.jobTitle}
                onChange={(e) => p.setJobTitle(e.target.value)}
                maxLength={120}
                placeholder={t('cuenta.cargoPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="department">{t('cuenta.departamento')}</Label>
              <Input
                id="department"
                value={p.department}
                onChange={(e) => p.setDepartment(e.target.value)}
                maxLength={120}
                placeholder={t('cuenta.departamentoPlaceholder')}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="location">{t('cuenta.ubicacion')}</Label>
            <Input
              id="location"
              value={p.location}
              onChange={(e) => p.setLocation(e.target.value)}
              maxLength={120}
              placeholder={t('cuenta.ubicacionPlaceholder')}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="locale">{t('cuenta.idioma')}</Label>
              <Select id="locale" value={p.locale} onChange={(e) => p.setLocale(e.target.value)}>
                {LOCALE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timezone">{t('cuenta.zonaHoraria')}</Label>
              <Select
                id="timezone"
                value={p.timezone}
                onChange={(e) => p.setTimezone(e.target.value)}
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
            <Label htmlFor="bio">{t('cuenta.biografia')}</Label>
            <Textarea
              id="bio"
              value={p.bio}
              onChange={(e) => p.setBio(e.target.value)}
              maxLength={280}
              rows={3}
              placeholder={t('cuenta.bioPlaceholder')}
            />
            <p className="text-right text-xs text-text-subtle">
              {t('cuenta.bioLimite', { count: p.bio.length })}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="documentId">{t('cuenta.dniNie')}</Label>
            <Input
              id="documentId"
              value={p.documentId}
              onChange={(e) => p.setDocumentId(e.target.value)}
              placeholder={t('cuenta.dniPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              maxLength={20}
            />
            <p className="text-xs text-text-subtle">{t('cuenta.dniAyuda')}</p>
          </div>

          {p.error ? (
            <p role="alert" className="text-sm text-danger-700">
              {p.error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
            {p.success ? (
              <span className="mr-auto text-sm font-semibold text-success-700">
                {t('cuenta.cambiosGuardados')}
              </span>
            ) : null}
            <Button type="button" variant="ghost" onClick={p.onCancel} disabled={p.pending}>
              {t('cuenta.cancelar')}
            </Button>
            <Button type="submit" disabled={p.pending}>
              {p.pending ? t('cuenta.guardando') : t('cuenta.guardarCambios')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
