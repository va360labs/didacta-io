'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState, type FormEvent } from 'react';
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
  label: string;
  description: string;
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
/// rol — ocultar el tab evita un click muerto).
const CORE_TABS: ConfigTabSpec[] = [
  {
    key: 'notifications',
    label: 'Notificaciones',
    description: 'Servidor SMTP saliente para emails transaccionales.',
  },
  {
    key: 'registro',
    label: 'Registro',
    description:
      'Cómo entran los miembros: verificadores exigidos (Telegram/OTP), bot y aprobador.',
  },
  {
    key: 'pagos',
    label: 'Pagos',
    description: 'Cuenta de Stripe para vender cursos sueltos y suscripciones/membresía.',
  },
  {
    key: 'modules',
    label: 'Módulos',
    description: 'Activa o desactiva módulos del producto para tu organización.',
  },
  {
    key: 'storage',
    label: 'Storage',
    description: 'Backend de archivos (S3 o disco local) configurado vía variables de entorno.',
  },
  {
    key: 'raw',
    label: 'Avanzado',
    description:
      'Vista cruda (debug) de todos los valores guardados en este tenant, agrupados por módulo. Útil para troubleshooting; lo normal es usar las tabs específicas.',
  },
];

/// Tab "general" (identidad del tenant). Va PRIMERO porque renombrar la
/// organización es el setting más fundamental — antes que SMTP, storage o
/// cualquier módulo. Sólo aplica a super_admin (gating duro en
/// `visibleTabs` dentro del componente).
const GENERAL_TAB: ConfigTabSpec = {
  key: 'general',
  label: 'General',
  description: 'Nombre de la organización (usado en emails y header).',
};

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
  const [tab, setTab] = useState<TabKey>(isSuperAdmin ? 'general' : 'notifications');

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
  const visibleTabs = ALL_TABS.filter((t) => {
    if (t.key === 'general') return isSuperAdmin;
    if (!t.requiresModule) return true;
    if (!activeModules) return false;
    return activeModules.has(t.requiresModule);
  });

  // Si la tab seleccionada queda oculta tras el filtro (ej. el admin
  // desactivó mod.zoom-live mientras estaba en el tab "Aula virtual"),
  // saltamos a la primera visible.
  useEffect(() => {
    if (!visibleTabs.find((t) => t.key === tab) && visibleTabs[0]) {
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
      setError(
        e instanceof ApiHttpError
          ? e.message
          : 'No pudimos cargar la configuración. Prueba a refrescar la página.',
      );
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleDelete(scope: string, key: string) {
    if (
      !confirm(
        `¿Eliminar ${scope}.${key}? Si era una credencial, la integración asociada va a dejar de funcionar.`,
      )
    )
      return;
    try {
      await tenantSettingsApi.remove(scope, key);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos eliminar el setting.');
    }
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">Configuración del tenant</h1>
        <p className="mt-1 max-w-3xl text-text-muted">
          Credenciales y preferencias de los módulos para tu organización. Los secretos se almacenan
          cifrados (AES-256-GCM) y nunca se devuelven en claro desde la API.
        </p>
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
        {visibleTabs.map((t) => {
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setTab(t.key)}
              className={
                isActive
                  ? 'relative px-4 py-2.5 text-sm font-semibold text-brand-700 transition-colors'
                  : 'relative px-4 py-2.5 text-sm font-medium text-text-muted hover:text-text transition-colors'
              }
            >
              {t.label}
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
        const ext = ALL_TABS.find((t) => t.key === tab && t.Component);
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
              <CardTitle>Avanzado · vista debug</CardTitle>
              <Badge variant="warning">Solo troubleshooting</Badge>
            </div>
            <CardDescription>
              Lista todos los valores guardados en <code>tenant_setting</code> agrupados por módulo.
              Lo normal es configurar cada cosa desde su tab específica (Notificaciones, Storage,
              etc.). Esta vista es útil cuando hay que revisar/limpiar settings huérfanos. Los
              valores marcados como <Badge variant="warning">secreto •••</Badge> están cifrados
              at-rest y no se pueden leer desde la UI por diseño; sólo el servidor los descifra al
              consumirlos. <strong>Eliminar</strong> remueve el setting completo y desactiva la
              integración asociada.
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
                Aún no configuraste nada en este tenant.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left">
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-text-muted">
                      <th className="py-2 pr-4 font-semibold">Módulo</th>
                      <th className="py-2 pr-4 font-semibold">Clave</th>
                      <th className="py-2 pr-4 font-semibold">Tipo</th>
                      <th className="py-2 pr-4 font-semibold">Actualizado</th>
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
                            <Badge variant="warning">secreto •••</Badge>
                          ) : (
                            <Badge variant="muted">plano</Badge>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-xs text-text-subtle tabular-nums">
                          {new Date(it.updatedAt).toLocaleDateString('es-ES', {
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
                            Eliminar
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
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los módulos.');
    }
  }

  useEffect(() => {
    void reload(targetTenantId);
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
        setError(e instanceof ApiHttpError ? e.message : 'No pudimos actualizar el módulo.');
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
          <span className="font-semibold text-warning-900">Modo super_admin:</span>
          <label className="inline-flex items-center gap-2">
            <span className="text-text-muted">operar sobre tenant</span>
            <select
              className="rounded border border-border-strong bg-surface px-2 py-1 text-sm"
              value={targetTenantId ?? ''}
              onChange={(e) => setTargetTenantId(e.target.value || undefined)}
            >
              <option value="">(el mío)</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.slug}
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
                    <Badge variant="success">Activo</Badge>
                  ) : (
                    <Badge variant="muted">Desactivado</Badge>
                  )}
                </div>
                {item.description ? (
                  <p className="text-sm text-text-muted">{item.description}</p>
                ) : null}
                {item.dependencies.length > 0 ? (
                  <p className="text-xs text-text-subtle">
                    Depende de: <span className="font-mono">{item.dependencies.join(', ')}</span>
                  </p>
                ) : null}
                {item.dependents.length > 0 ? (
                  <p className="text-xs text-text-subtle">
                    Usado por: <span className="font-mono">{item.dependents.join(', ')}</span>
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-subtle tabular-nums">
                  {busy === item.name ? 'Guardando…' : item.enabled ? 'Activo' : 'Desactivado'}
                </span>
                <Switch
                  checked={item.enabled}
                  onCheckedChange={() => toggle(item)}
                  disabled={busy !== null}
                  label={`${item.enabled ? 'Desactivar' : 'Activar'} ${item.displayName}`}
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
            Hay módulos activos que dependen de{' '}
            <span className="font-mono">{confirmCascade.name}</span>:
          </p>
          <p className="mt-1 font-mono text-warning-800">{confirmCascade.dependents.join(', ')}</p>
          <p className="mt-2 text-warning-800">
            Si confirmas, se desactivarán también esos módulos en cascada.
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const item = items.find((i) => i.name === confirmCascade.name);
                if (item) void toggle(item, true);
              }}
            >
              Desactivar en cascada
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmCascade(null)}>
              Cancelar
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
        throw new Error('Bucket y Access Key ID son requeridos para S3.');
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
      setError(e instanceof Error ? e.message : 'No pudimos guardar la configuración de storage.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Storage</CardTitle>
        <CardDescription>
          Backend de archivos para uploads (avatares, certificados, lecciones, evidencias). Disco
          local del container o un bucket S3-compatible (AWS, Hetzner, MinIO, Backblaze).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="storage-driver">Provider</Label>
            <Select
              id="storage-driver"
              value={draft.driver}
              onChange={(e) => setDraft({ ...draft, driver: e.target.value as StorageDriver })}
            >
              <option value="local">Disco local del container (volumen Docker)</option>
              <option value="s3">S3-compatible (AWS, Hetzner, MinIO, Backblaze)</option>
            </Select>
          </div>

          {draft.driver === 'local' ? (
            <div className="space-y-1.5">
              <Label htmlFor="storage-localDir">Directorio del volumen</Label>
              <Input
                id="storage-localDir"
                value={draft.localDir}
                onChange={(e) => setDraft({ ...draft, localDir: e.target.value })}
                placeholder="/data/storage"
                className="font-mono"
              />
              <p className="text-xs text-text-subtle">
                Asegúrate de montar un volumen Docker apuntando a esta ruta para que los archivos
                sobrevivan a redespliegues.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="s3-bucket">Bucket *</Label>
                <Input
                  id="s3-bucket"
                  value={draft.s3Bucket}
                  onChange={(e) => setDraft({ ...draft, s3Bucket: e.target.value })}
                  placeholder="mi-tenant-uploads"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3-region">Region *</Label>
                <Input
                  id="s3-region"
                  value={draft.s3Region}
                  onChange={(e) => setDraft({ ...draft, s3Region: e.target.value })}
                  placeholder="eu-central-1"
                  required
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="s3-endpoint">Endpoint (opcional)</Label>
                <Input
                  id="s3-endpoint"
                  value={draft.s3Endpoint}
                  onChange={(e) => setDraft({ ...draft, s3Endpoint: e.target.value })}
                  placeholder="https://s3.eu-central-1.hetzner.com"
                />
                <p className="text-xs text-text-subtle">
                  Sólo necesario para S3-compatible no-AWS (Hetzner, MinIO, Backblaze).
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3-accessKey">Access Key ID *</Label>
                <Input
                  id="s3-accessKey"
                  value={draft.s3AccessKeyId}
                  onChange={(e) => setDraft({ ...draft, s3AccessKeyId: e.target.value })}
                  required
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3-secret">Secret Access Key</Label>
                <Input
                  id="s3-secret"
                  type="password"
                  value={draft.s3SecretAccessKey}
                  onChange={(e) => setDraft({ ...draft, s3SecretAccessKey: e.target.value })}
                  placeholder="(dejar vacío para conservar el actual)"
                  className="font-mono"
                />
                <p className="text-xs text-text-subtle">
                  Se cifra con AES-256-GCM antes de persistir. La API nunca lo devuelve en claro.
                </p>
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
            <p className="text-sm text-success-700">Guardado correctamente.</p>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-border-soft pt-4">
            <Button type="submit" disabled={status === 'saving'}>
              {status === 'saving' ? 'Guardando…' : 'Guardar configuración'}
            </Button>
          </div>
        </form>

        <div className="mt-6 rounded-lg border border-success-200 bg-success-50/50 p-3 text-xs text-success-800">
          <strong>Activo:</strong> los uploads de imágenes y los archivos del tenant ya usan esta
          configuración cuando el driver es <code>s3</code>. Si eliges disco local o no completas el
          bucket, el server cae al adapter global del env.
        </div>
      </CardContent>
    </Card>
  );
}
