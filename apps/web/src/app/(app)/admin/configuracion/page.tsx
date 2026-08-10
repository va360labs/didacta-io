'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { MemberRegistrationSettingsCard } from '@/components/admin/member-registration-settings-card';
import { SignupPolicyCard } from '@/components/admin/signup-policy-card';
import { SmtpSettingsCard } from '@/components/admin/smtp-settings-card';
import { StripeSettingsCard } from '@/components/admin/stripe-settings-card';
import { TenantIdentityCard } from '@/components/admin/tenant-identity-card';
import { adminModulesApi, type TenantModuleListItem } from '@/lib/admin-modules';
import { meApi } from '@/lib/me';
import { adminTenantsApi, type TenantListItem } from '@/lib/admin-tenants';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { labelOr } from '@/lib/i18n/labels';
import { resolveModuleText, type ModuleLocalizedText } from '@/lib/module-registry';
import { tenantSettingsApi, type TenantSettingMetadata } from '@/lib/tenant-settings';
import { flatAdminConfigTabs } from '@/modules';

// Branding tiene su propia pantalla en /admin/branding con preview live.
// Se removió la tab acá para no duplicar entry-point y confundir al admin.
//
// Tabs DEL CORE: notifications, modules, storage, plantillas, raw. Otros
// tabs los aportan los módulos vía `moduleExtensions` (ver
// `apps/web/src/modules/`). El extension point convierte tabs como
// "Aula virtual" del módulo `mod.zoom-live` en una declaración del
// propio módulo en lugar de un hard-code en el core.

interface ConfigTabSpec {
  key: string;
  /// Solo set para tabs aportados por un módulo. Los tabs del CORE no lo
  /// declaran y se traducen por convención con `configTabs.<key>`; los de un
  /// módulo traen su propio par `{ key, fallback }` porque un módulo de
  /// terceros puede no estar en el catálogo del core (ver `ModuleLocalizedText`).
  label?: ModuleLocalizedText;
  /// Solo set para tabs de extensión (metadata del módulo, hoy sin render).
  description?: ModuleLocalizedText;
  /// Solo set para tabs aportados por un módulo. Si el módulo NO está
  /// activo para el tenant, el tab desaparece. Tabs del core NO declaran
  /// `requiresModule`.
  requiresModule?: string;
  /// Componente que renderiza el contenido del tab. Para tabs del core
  /// es null y el switch `renderTabContent` selecciona; para tabs de
  /// extensión es el `Component` declarado por el módulo.
  Component?: React.ComponentType;
}

/// Tabs base disponibles para cualquier tenant_admin. `general` se inyecta
/// dinámicamente al principio sólo cuando la sesión tiene rol super_admin
/// (la API rechaza el PATCH /admin/tenants/:id con 403 para cualquier otro
/// rol — ocultar el tab evita un click muerto). El copy (label) de cada tab
/// del core vive en el catálogo i18n bajo `adminMarca.configTabs.<key>`.
const CORE_TABS: ConfigTabSpec[] = [
  // Servidor SMTP saliente para emails transaccionales.
  { key: 'notifications' },
  // Cómo entran los miembros: verificadores exigidos (Telegram/OTP), bot y aprobador.
  { key: 'registro' },
  // Cuenta de Stripe para vender cursos sueltos y suscripciones/membresía.
  { key: 'pagos' },
  // Activa o desactiva módulos del producto para tu organización.
  { key: 'modules' },
  // Backend de archivos (S3 o disco local) configurado vía variables de entorno.
  { key: 'storage' },
  // Vista cruda (debug) de todos los valores guardados en este tenant.
  { key: 'raw' },
];

/// Tab "general" (identidad del tenant: nombre usado en emails y header).
/// Va PRIMERO porque renombrar la organización es el setting más
/// fundamental — antes que SMTP, storage o cualquier módulo. Sólo aplica a
/// super_admin (gating duro en `visibleTabs` dentro del componente).
const GENERAL_TAB: ConfigTabSpec = { key: 'general' };

/// Lista combinada CORE + EXTENSIONS, calculada una vez por mount. El
/// orden es: tab general (super_admin), tabs del core en su orden
/// declarado, seguido de los tabs de extensión en el orden del catálogo.
/// Ningún módulo puede pisar el `key` de un tab del core (validado en
/// runtime).
const ALL_TABS: ConfigTabSpec[] = [
  GENERAL_TAB,
  ...CORE_TABS,
  ...flatAdminConfigTabs().map(({ moduleName, tab }) => ({
    key: tab.key,
    label: tab.label,
    description: tab.description,
    requiresModule: moduleName,
    Component: tab.Component,
  })),
];

type TabKey = string;

export default function ConfiguracionPage() {
  const t = useTranslations('adminMarca');
  const tErrors = useTranslations('errors');
  const [items, setItems] = useState<TenantSettingMetadata[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeModules, setActiveModules] = useState<Set<string> | null>(null);

  // El tab "general" (identidad de la organización) sólo se muestra a
  // super_admin porque el endpoint backend que renombra el tenant es
  // super_admin-only. Para el resto de roles el tab inicial sigue siendo
  // "notifications" (compat con el comportamiento previo).
  const isSuperAdmin = (() => {
    const session = authStorage.getSession();
    return session?.user.roles.includes('super_admin') ?? false;
  })();

  /// El tab inicial se puede fijar por query (`?tab=notifications`) para que
  /// se pueda enlazar directamente desde fuera — lo usa el aviso de correo
  /// sin configurar del shell, que si no dejaba al super_admin en "general"
  /// justo cuando se le acaba de decir dónde tiene que ir.
  const searchParams = useSearchParams();
  const tabPedido = searchParams?.get('tab')?.trim() || null;
  const [tab, setTab] = useState<TabKey>(tabPedido || (isSuperAdmin ? 'general' : 'notifications'));

  // Carga la lista de módulos activos del tenant para filtrar tabs cuyo
  // módulo está desactivado (ej. mod.zoom-live → oculta "Aula virtual").
  // Re-ejecuta también cuando otro componente dispara el evento
  // `didacta:modules-changed` (típicamente el ModulesTab de esta misma
  // página tras un toggle), así el filtro se actualiza sin recargar.
  useEffect(() => {
    let cancelled = false;
    function refresh() {
      const token = authStorage.getAccessToken();
      if (!token) return;
      meApi
        .getMyModules(token)
        .then((res) => {
          if (!cancelled) setActiveModules(new Set(res.activeModules));
        })
        .catch(() => {
          // Si falla (red, módulo registry indisponible), pasamos a un
          // set VACÍO en lugar de null para ser ESTRICTOS: ocultamos
          // tabs de módulos hasta que la lista llegue. Antes era
          // permisivo y dejaba el tab visible aunque el módulo
          // estuviera desactivado — ese era el síntoma reportado
          // en alpha.17.
          if (!cancelled) setActiveModules(new Set<string>());
        });
    }
    refresh();
    window.addEventListener('didacta:modules-changed', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('didacta:modules-changed', refresh);
    };
  }, []);

  /// Filtra tabs cuyo `requiresModule` no está activo. Si `activeModules`
  /// aún no llegó del API (estado inicial pre-fetch), ocultamos los tabs
  /// de extensión por seguridad — la versión anterior era permisiva (los
  /// mostraba durante el flash) y el operador veía el tab incluso con el
  /// módulo desactivado. Tabs del core (sin `requiresModule`) siempre
  /// visibles.
  const visibleTabs = ALL_TABS.filter((spec) => {
    if (spec.key === 'general') return isSuperAdmin;
    if (!spec.requiresModule) return true;
    if (!activeModules) return false;
    return activeModules.has(spec.requiresModule);
  });

  // Si la tab seleccionada queda oculta tras el filtro (ej. el admin
  // desactivó mod.zoom-live mientras estaba en el tab "Aula virtual"),
  // saltamos a la primera visible.
  useEffect(() => {
    if (!visibleTabs.find((spec) => spec.key === tab) && visibleTabs[0]) {
      setTab(visibleTabs[0].key);
    }
  }, [activeModules, tab, visibleTabs]);

  // El tab "notifications" delega 100% en `SmtpSettingsCard`, que tiene su
  // propio estado, cliente HTTP y modales. La page sólo gestiona la lista
  // genérica de `tenant_setting` para el tab "Avanzado" (raw).

  async function reload() {
    try {
      setItems(await tenantSettingsApi.listAll());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('config.loadError'));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDelete(scope: string, key: string) {
    if (!confirm(t('config.deleteConfirm', { setting: `${scope}.${key}` }))) return;
    try {
      await tenantSettingsApi.remove(scope, key);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('config.deleteError'));
    }
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('config.title')}</h1>
        <p className="mt-1 max-w-3xl text-text-muted">{t('config.description')}</p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border" role="tablist">
        {visibleTabs.map((spec) => {
          const isActive = tab === spec.key;
          return (
            <button
              key={spec.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setTab(spec.key)}
              className={
                isActive
                  ? 'relative px-4 py-2.5 text-sm font-semibold text-brand-700 transition-colors'
                  : 'relative px-4 py-2.5 text-sm font-medium text-text-muted hover:text-text transition-colors'
              }
            >
              {spec.label
                ? resolveModuleText(t, spec.label)
                : labelOr(t, `configTabs.${spec.key}`, spec.key)}
              {isActive ? (
                <span
                  aria-hidden="true"
                  className="absolute -bottom-px left-3 right-3 h-0.5 rounded-full bg-brand-500"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {tab === 'general' ? <TenantIdentityCard /> : null}

      {tab === 'notifications' ? <SmtpSettingsCard /> : null}

      {tab === 'registro' ? (
        <div className="flex flex-col gap-6">
          <SignupPolicyCard />
          <MemberRegistrationSettingsCard />
        </div>
      ) : null}

      {tab === 'pagos' ? <StripeSettingsCard /> : null}

      {tab === 'modules' ? <ModulesTab /> : null}

      {/* Tabs aportados por módulos vía extension point. Se renderiza el
          Component declarado en `moduleExtensions` cuando el tab activo
          coincide con su `key`. Filtrado por activeModules ya aplicado
          en `visibleTabs`. */}
      {(() => {
        const ext = ALL_TABS.find((spec) => spec.key === tab && spec.Component);
        if (!ext || !ext.Component) return null;
        const Component = ext.Component;
        return <Component />;
      })()}

      {tab === 'storage' ? <StorageTab /> : null}

      {/* tab "plantillas" lo aporta `mod.notifications` vía extension —
          render genérico unos bloques arriba se encarga. */}

      {tab === 'raw' ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle>{t('config.rawTitle')}</CardTitle>
              <Badge variant="warning">{t('config.rawBadge')}</Badge>
            </div>
            <CardDescription>
              {t.rich('config.rawDescription', {
                code: (chunks) => <code>{chunks}</code>,
                secret: (chunks) => <Badge variant="warning">{chunks}</Badge>,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {items === null ? (
              <div className="space-y-2">
                <div className="skeleton h-10 w-full" />
                <div className="skeleton h-10 w-full" />
              </div>
            ) : items.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border-strong bg-surface-2 p-8 text-center text-sm text-text-muted">
                {t('config.rawEmpty')}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left">
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-text-muted">
                      <th className="py-2 pr-4 font-semibold">{t('config.colModule')}</th>
                      <th className="py-2 pr-4 font-semibold">{t('config.colKey')}</th>
                      <th className="py-2 pr-4 font-semibold">{t('config.colType')}</th>
                      <th className="py-2 pr-4 font-semibold">{t('config.colUpdated')}</th>
                      <th className="py-2 text-right" />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => (
                      <tr
                        key={`${it.moduleName}/${it.key}`}
                        className="border-b border-border last:border-0 hover:bg-surface-2"
                      >
                        <td className="py-2 pr-4 font-mono text-xs">{it.moduleName}</td>
                        <td className="py-2 pr-4 font-mono text-xs">{it.key}</td>
                        <td className="py-2 pr-4">
                          {it.isSecret ? (
                            <Badge variant="warning">{t('config.secretBadge')}</Badge>
                          ) : (
                            <Badge variant="muted">{t('config.plainBadge')}</Badge>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-xs text-text-subtle tabular-nums">
                          {formatDate(it.updatedAt, {
                            day: '2-digit',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            onClick={() => handleDelete(it.moduleName, it.key)}
                            className="text-xs font-semibold text-danger-700 hover:underline"
                          >
                            {t('config.deleteAction')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

function ModulesTab() {
  const t = useTranslations('adminMarca');
  const tErrors = useTranslations('errors');
  const [items, setItems] = useState<TenantModuleListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCascade, setConfirmCascade] = useState<{
    name: string;
    dependents: string[];
  } | null>(null);
  const [tenants, setTenants] = useState<TenantListItem[] | null>(null);
  const [targetTenantId, setTargetTenantId] = useState<string | undefined>(undefined);

  const isSuperAdmin = (() => {
    const session = authStorage.getSession();
    return session?.user.roles.includes('super_admin') ?? false;
  })();

  async function reload(tenantId = targetTenantId) {
    try {
      setItems(await adminModulesApi.list(tenantId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('modulesTab.loadError'));
    }
  }

  useEffect(() => {
    void reload(targetTenantId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetTenantId]);

  // Carga lista de tenants para el selector de super_admin (lazy, solo si tiene rol).
  useEffect(() => {
    if (!isSuperAdmin || tenants !== null) return;
    const token = authStorage.getAccessToken();
    if (!token) {
      setTenants([]);
      return;
    }
    adminTenantsApi
      .list(token)
      .then(setTenants)
      .catch(() => setTenants([]));
  }, [isSuperAdmin, tenants]);

  async function toggle(item: TenantModuleListItem, force = false) {
    setBusy(item.name);
    setError(null);
    // Optimistic update: el switch refleja el estado destino al instante
    // y, si la API falla, revertimos. La cascade-confirmation también
    // revierte porque el módulo realmente no se desactivó hasta que el
    // user confirme en el alertdialog.
    const previous = items;
    if (previous) {
      setItems(previous.map((m) => (m.name === item.name ? { ...m, enabled: !m.enabled } : m)));
    }
    try {
      if (item.enabled) {
        await adminModulesApi.disable(item.name, { force, tenantId: targetTenantId });
      } else {
        await adminModulesApi.enable(item.name, targetTenantId);
      }
      setConfirmCascade(null);
      await reload(targetTenantId);
      // Notificar al layout para que el sidebar se refresque sin recargar
      // la página. Listener en apps/web/src/app/(app)/layout.tsx.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('didacta:modules-changed'));
      }
    } catch (e) {
      if (previous) setItems(previous);
      if (e instanceof ApiHttpError && e.status === 409) {
        const dependents = extractDependents(e);
        setConfirmCascade({ name: item.name, dependents });
      } else {
        setError(
          e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('modulesTab.updateError'),
        );
      }
    } finally {
      setBusy(null);
    }
  }

  if (items === null) {
    return (
      <div className="space-y-2">
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {isSuperAdmin && tenants && tenants.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning-200 bg-warning-50/40 p-3 text-sm">
          <span className="font-semibold text-warning-900">{t('modulesTab.superAdminMode')}</span>
          <label className="inline-flex items-center gap-2">
            <span className="text-text-muted">{t('modulesTab.operateOn')}</span>
            <select
              className="rounded border border-border-strong bg-surface px-2 py-1 text-sm"
              value={targetTenantId ?? ''}
              onChange={(e) => setTargetTenantId(e.target.value || undefined)}
            >
              <option value="">{t('modulesTab.myTenant')}</option>
              {tenants.map((tn) => (
                <option key={tn.id} value={tn.id}>
                  {tn.name} · {tn.slug}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {items
        .filter((item) => !item.isCore)
        .map((item) => (
          <Card key={item.name}>
            <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">{item.displayName}</h3>
                  <Badge variant="muted" className="font-mono text-[11px]">
                    {item.name}@{item.version}
                  </Badge>
                  {item.enabled ? (
                    <Badge variant="success">{t('modulesTab.enabled')}</Badge>
                  ) : (
                    <Badge variant="muted">{t('modulesTab.disabled')}</Badge>
                  )}
                </div>
                {item.description ? (
                  <p className="text-sm text-text-muted">{item.description}</p>
                ) : null}
                {item.dependencies.length > 0 ? (
                  <p className="text-xs text-text-subtle">
                    {t('modulesTab.dependsOn')}{' '}
                    <span className="font-mono">{item.dependencies.join(', ')}</span>
                  </p>
                ) : null}
                {item.dependents.length > 0 ? (
                  <p className="text-xs text-text-subtle">
                    {t('modulesTab.usedBy')}{' '}
                    <span className="font-mono">{item.dependents.join(', ')}</span>
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-subtle tabular-nums">
                  {busy === item.name
                    ? t('modulesTab.saving')
                    : item.enabled
                      ? t('modulesTab.enabled')
                      : t('modulesTab.disabled')}
                </span>
                <Switch
                  checked={item.enabled}
                  onCheckedChange={() => toggle(item)}
                  disabled={busy !== null}
                  label={
                    item.enabled
                      ? t('modulesTab.disableLabel', { name: item.displayName })
                      : t('modulesTab.enableLabel', { name: item.displayName })
                  }
                />
              </div>
            </CardContent>
          </Card>
        ))}

      {confirmCascade ? (
        <div
          role="alertdialog"
          className="rounded-lg border border-warning-200 bg-warning-50 p-4 text-sm"
        >
          <p className="font-semibold text-warning-900">
            {t.rich('modulesTab.cascadeTitle', {
              name: confirmCascade.name,
              mono: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </p>
          <p className="mt-1 font-mono text-warning-800">{confirmCascade.dependents.join(', ')}</p>
          <p className="mt-2 text-warning-800">{t('modulesTab.cascadeWarning')}</p>
          <div className="mt-3 flex gap-2">
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const item = items.find((i) => i.name === confirmCascade.name);
                if (item) void toggle(item, true);
              }}
            >
              {t('modulesTab.cascadeConfirm')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmCascade(null)}>
              {t('modulesTab.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function extractDependents(err: ApiHttpError): string[] {
  const anyErr = err as unknown as { details?: { dependents?: unknown } };
  const list = anyErr.details?.dependents;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
}

type StorageDriver = 'local' | 's3';

interface StorageDraft {
  driver: StorageDriver;
  localDir: string;
  s3Bucket: string;
  s3Region: string;
  s3Endpoint: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
}

const EMPTY_STORAGE: StorageDraft = {
  driver: 'local',
  localDir: '/data/storage',
  s3Bucket: '',
  s3Region: 'eu-central-1',
  s3Endpoint: '',
  s3AccessKeyId: '',
  s3SecretAccessKey: '',
};

function StorageTab() {
  const t = useTranslations('adminMarca');
  const tErrors = useTranslations('errors');
  const [draft, setDraft] = useState<StorageDraft>(EMPTY_STORAGE);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Persistimos en 2 keys: `storage.config` (no-secret, hidratable al
  // releer) con el driver y la metadata; `storage.secret` (cifrada) sólo
  // con la access secret. Así el admin ve los valores guardados al volver
  // a la tab y sólo re-tipea el secret si quiere rotarlo.
  useEffect(() => {
    let aborted = false;
    void (async () => {
      try {
        const detail = await tenantSettingsApi
          .get('storage', 'config')
          .catch(() => null as { value: unknown } | null);
        if (aborted || !detail || detail.value == null || typeof detail.value !== 'object') return;
        const value = detail.value as Record<string, unknown>;
        const driver = value['driver'] === 's3' ? 's3' : 'local';
        setDraft({
          driver,
          localDir: typeof value['localDir'] === 'string' ? value['localDir'] : '/data/storage',
          s3Bucket: typeof value['s3Bucket'] === 'string' ? value['s3Bucket'] : '',
          s3Region: typeof value['s3Region'] === 'string' ? value['s3Region'] : 'eu-central-1',
          s3Endpoint: typeof value['s3Endpoint'] === 'string' ? value['s3Endpoint'] : '',
          s3AccessKeyId: typeof value['s3AccessKeyId'] === 'string' ? value['s3AccessKeyId'] : '',
          s3SecretAccessKey: '',
        });
      } catch {
        // Si la lectura falla dejamos los defaults.
      }
    })();
    return () => {
      aborted = true;
    };
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setStatus('saving');
    setError(null);
    try {
      if (draft.driver === 's3' && (!draft.s3Bucket.trim() || !draft.s3AccessKeyId.trim())) {
        throw new Error(t('storage.s3Required'));
      }
      const config =
        draft.driver === 'local'
          ? { driver: 'local' as const, localDir: draft.localDir.trim() || '/data/storage' }
          : {
              driver: 's3' as const,
              s3Bucket: draft.s3Bucket.trim(),
              s3Region: draft.s3Region.trim(),
              s3Endpoint: draft.s3Endpoint.trim() || undefined,
              s3AccessKeyId: draft.s3AccessKeyId.trim(),
            };
      await tenantSettingsApi.upsert('storage', 'config', { isSecret: false, value: config });
      // Sólo escribimos el secret si el admin lo re-tipeó en este turno.
      // Vacío significa "conservar el actual" para no requerir conocerlo.
      if (draft.driver === 's3' && draft.s3SecretAccessKey) {
        await tenantSettingsApi.upsert('storage', 'secret', {
          isSecret: true,
          value: { s3SecretAccessKey: draft.s3SecretAccessKey },
        });
      }
      setStatus('saved');
      setDraft((d) => ({ ...d, s3SecretAccessKey: '' }));
    } catch (e) {
      setStatus('error');
      setError(
        e instanceof ApiHttpError
          ? apiErrorMessage(e, tErrors)
          : e instanceof Error && e.message
            ? e.message
            : t('storage.saveError'),
      );
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('storage.title')}</CardTitle>
        <CardDescription>{t('storage.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="storage-driver">{t('storage.providerLabel')}</Label>
            <Select
              id="storage-driver"
              value={draft.driver}
              onChange={(e) => setDraft({ ...draft, driver: e.target.value as StorageDriver })}
            >
              <option value="local">{t('storage.driverLocal')}</option>
              <option value="s3">{t('storage.driverS3')}</option>
            </Select>
          </div>

          {draft.driver === 'local' ? (
            <div className="space-y-1.5">
              <Label htmlFor="storage-localDir">{t('storage.localDirLabel')}</Label>
              <Input
                id="storage-localDir"
                value={draft.localDir}
                onChange={(e) => setDraft({ ...draft, localDir: e.target.value })}
                placeholder={t('storage.localDirPlaceholder')}
                className="font-mono"
              />
              <p className="text-xs text-text-subtle">{t('storage.localDirHint')}</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="s3-bucket">{t('storage.bucketLabel')}</Label>
                <Input
                  id="s3-bucket"
                  value={draft.s3Bucket}
                  onChange={(e) => setDraft({ ...draft, s3Bucket: e.target.value })}
                  placeholder={t('storage.bucketPlaceholder')}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3-region">{t('storage.regionLabel')}</Label>
                <Input
                  id="s3-region"
                  value={draft.s3Region}
                  onChange={(e) => setDraft({ ...draft, s3Region: e.target.value })}
                  placeholder={t('storage.regionPlaceholder')}
                  required
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="s3-endpoint">{t('storage.endpointLabel')}</Label>
                <Input
                  id="s3-endpoint"
                  value={draft.s3Endpoint}
                  onChange={(e) => setDraft({ ...draft, s3Endpoint: e.target.value })}
                  placeholder={t('storage.endpointPlaceholder')}
                />
                <p className="text-xs text-text-subtle">{t('storage.endpointHint')}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3-accessKey">{t('storage.accessKeyLabel')}</Label>
                <Input
                  id="s3-accessKey"
                  value={draft.s3AccessKeyId}
                  onChange={(e) => setDraft({ ...draft, s3AccessKeyId: e.target.value })}
                  required
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3-secret">{t('storage.secretKeyLabel')}</Label>
                <Input
                  id="s3-secret"
                  type="password"
                  value={draft.s3SecretAccessKey}
                  onChange={(e) => setDraft({ ...draft, s3SecretAccessKey: e.target.value })}
                  placeholder={t('storage.secretKeyPlaceholder')}
                  className="font-mono"
                />
                <p className="text-xs text-text-subtle">{t('storage.secretKeyHint')}</p>
              </div>
            </div>
          )}

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {error}
            </div>
          ) : null}
          {status === 'saved' ? (
            <p className="text-sm text-success-700">{t('storage.saved')}</p>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-border-soft pt-4">
            <Button type="submit" disabled={status === 'saving'}>
              {status === 'saving' ? t('storage.saving') : t('storage.saveButton')}
            </Button>
          </div>
        </form>

        <div className="mt-6 rounded-lg border border-success-200 bg-success-50/50 p-3 text-xs text-success-800">
          {t.rich('storage.activeNote', {
            strong: (chunks) => <strong>{chunks}</strong>,
            code: (chunks) => <code>{chunks}</code>,
          })}
        </div>
      </CardContent>
    </Card>
  );
}
