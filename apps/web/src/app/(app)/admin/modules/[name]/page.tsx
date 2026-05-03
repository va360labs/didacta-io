'use client';

/**
 * Página de administración de módulo individual.
 *
 * Muestra la configuración, rutas y UI de un módulo instalado vía marketplace.
 * Permite al admin configurar el módulo y ver/usar su interfaz.
 *
 * @see DISC-001.3 — Página /admin/modules/[name]
 * @see module-loader.ts — Carga dinámica de UI
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ModuleRenderer } from '@/components/module-renderer';
import { ApiHttpError } from '@/lib/api-client';
import { marketplaceApi, type InstalledModuleSummary } from '@/lib/marketplace';
import { Icon } from '@/components/icon';

export default function ModuleDetailPage() {
  const params = useParams<{ name: string }>();
  const router = useRouter();
  const moduleName = params.name ? `mod.${params.name}` : null;

  const [module, setModule] = useState<InstalledModuleSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'general' | 'config' | 'ui' | 'routes'>('general');

  // Cargar metadata del módulo
  useEffect(() => {
    if (!moduleName) return;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const list = await marketplaceApi.list();
        const found = list.modules.find((m) => m.name === moduleName);
        if (!found) {
          setError(`Módulo "${moduleName}" no encontrado.`);
          return;
        }
        setModule(found);
      } catch (e) {
        setError(e instanceof ApiHttpError ? e.message : 'Error cargando módulo.');
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [moduleName]);

  if (!moduleName) {
    return <ErrorCard message="Nombre de módulo no especificado." />;
  }

  if (loading) {
    return <LoadingSkeleton />;
  }

  if (error || !module) {
    return <ErrorCard message={error ?? 'Módulo no encontrado.'} onBack={() => router.back()} />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => router.back()}>
              <Icon name="arrow-left" className="h-4 w-4" />
            </Button>
            <h1 className="font-display text-3xl font-bold tracking-tight">{module.displayName}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 pl-12">
            <code className="text-sm text-text-muted">{module.name}@{module.version}</code>
            <StatusBadge status={module.status} />
            <VendorBadge vendor={module.vendor} />
          </div>
          {module.description && (
            <p className="pl-12 text-text-muted">{module.description}</p>
          )}
        </div>
      </header>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="config">Configuración</TabsTrigger>
          <TabsTrigger value="ui">Interfaz</TabsTrigger>
          <TabsTrigger value="routes">Rutas API</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-4 pt-4">
          <GeneralTab module={module} />
        </TabsContent>

        <TabsContent value="config" className="space-y-4 pt-4">
          <ConfigTab module={module} />
        </TabsContent>

        <TabsContent value="ui" className="space-y-4 pt-4">
          <UITab module={module} />
        </TabsContent>

        <TabsContent value="routes" className="space-y-4 pt-4">
          <RoutesTab module={module} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab: General
// ─────────────────────────────────────────────────────────────────────────────

function GeneralTab({ module }: { module: InstalledModuleSummary }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Información</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <InfoRow label="Nombre técnico" value={module.name} mono />
          <InfoRow label="Versión" value={module.version} />
          <InfoRow label="API Namespace" value={module.apiNamespace} mono />
          <InfoRow label="Table Prefix" value={module.tablePrefix} mono />
          {module.installedAt && (
            <InfoRow label="Instalado" value={new Date(module.installedAt).toLocaleString()} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Estado</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm">Estado de instalación</span>
            <StatusBadge status={module.status} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Vendor</span>
            <VendorBadge vendor={module.vendor} />
          </div>
          {module.status === 'FAILED' && module.errorMessage && (
            <div className="rounded bg-red-50 p-3 text-sm text-red-800">
              <strong>Error:</strong> {module.errorMessage}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sección de activación por tenant - placeholder */}
      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>Activación por tenant</CardTitle>
          <CardDescription>
            Controla si este módulo está activo para el tenant actual.
            La activación/desactivación se gestiona desde{' '}
            <a href="/admin/configuracion" className="underline">Configuración → Módulos</a>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4 rounded-lg border border-dashed border-border p-4">
            <Switch disabled label="Activar módulo" />
            <span className="text-sm text-text-muted">
              (Gestión de activación próximamente aquí)
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab: Configuración
// ─────────────────────────────────────────────────────────────────────────────

function ConfigTab({ module }: { module: InstalledModuleSummary }) {
  // TODO: DISC-001.4 — Renderizar form desde config.schema del module.json
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuración del módulo</CardTitle>
        <CardDescription>
          Valores configurables definidos por el módulo. El form se genera automáticamente
          desde el schema declarado en <code>module.json</code>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-2 p-12 text-center">
          <Icon name="settings" className="mb-4 h-12 w-12 text-text-muted" />
          <p className="text-sm text-text-muted">
            El renderizador de configuración está en desarrollo.
          </p>
          <p className="mt-1 text-xs text-text-subtle">
            Ver DISC-001.4 — Config Schema Form Renderer
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab: UI
// ─────────────────────────────────────────────────────────────────────────────

function UITab({ module }: { module: InstalledModuleSummary }) {
  const [hasUI, setHasUI] = useState<boolean | null>(null);

  // Verificar si el módulo tiene UI para admin
  useEffect(() => {
    // TODO: Obtener esta info del manifest del módulo
    // Por ahora asumimos que tiene UI si está instalado
    setHasUI(true);
  }, [module.name]);

  if (hasUI === null) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (!hasUI) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Interfaz del módulo</CardTitle>
          <CardDescription>
            Este módulo no tiene interfaz gráfica para la surface <code>admin</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-amber-200 bg-amber-50 p-12 text-center">
            <Icon name="layout" className="mb-4 h-12 w-12 text-amber-600" />
            <p className="text-sm text-amber-800">
              El módulo solo tiene backend o su UI está en otra surface (alumno, formador, etc.)
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Interfaz del módulo</CardTitle>
        <CardDescription>
          UI cargada dinámicamente desde el bundle del módulo.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ModuleRenderer
          moduleName={module.name}
          surface="admin"
          config={{}}
          loadingFallback={
            <div className="space-y-3 p-4">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-32 w-full" />
            </div>
          }
        />
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab: Rutas
// ─────────────────────────────────────────────────────────────────────────────

function RoutesTab({ module }: { module: InstalledModuleSummary }) {
  // TODO: Obtener rutas del manifest del módulo
  return (
    <Card>
      <CardHeader>
        <CardTitle>Endpoints API</CardTitle>
        <CardDescription>
          Rutas HTTP registradas por el módulo bajo <code>{module.apiNamespace}</code>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-2 p-12 text-center">
          <Icon name="route" className="mb-4 h-12 w-12 text-text-muted" />
          <p className="text-sm text-text-muted">
            La lista de rutas se extraerá del manifest del módulo.
          </p>
          <p className="mt-2 text-xs text-text-subtle">
            Namespace: <code>{module.apiNamespace}</code>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componentes auxiliares
// ─────────────────────────────────────────────────────────────────────────────

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-text-muted">{label}</span>
      <span className={`text-sm ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: InstalledModuleSummary['status'] }) {
  // Fallback defensivo: si la API devuelve un status fuera del enum tipado
  // (rows legacy, futuras extensiones), no rompemos la página completa.
  const map: Record<
    typeof status,
    { variant: 'info' | 'success' | 'danger' | 'muted'; label: string }
  > = {
    INSTALLING: { variant: 'info', label: 'Instalando…' },
    INSTALLED: { variant: 'success', label: 'Instalado' },
    FAILED: { variant: 'danger', label: 'Falló' },
    DEPRECATED: { variant: 'muted', label: 'Deprecated' },
  };
  const entry = map[status] ?? { variant: 'muted' as const, label: String(status ?? '—') };
  return <Badge variant={entry.variant}>{entry.label}</Badge>;
}

function VendorBadge({ vendor }: { vendor: InstalledModuleSummary['vendor'] }) {
  if (vendor === 'DIDACTA') {
    return <Badge variant="success">Verificado</Badge>;
  }
  return <Badge variant="outline">Comunidad</Badge>;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10" />
        <Skeleton className="h-10 w-64" />
      </div>
      <Skeleton className="h-12 w-full" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    </div>
  );
}

function ErrorCard({ message, onBack }: { message: string; onBack?: () => void }) {
  return (
    <Card className="border-red-200 bg-red-50">
      <CardHeader>
        <CardTitle className="text-red-900">Error</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-red-800">{message}</p>
        {onBack && (
          <Button variant="secondary" onClick={onBack}>
            Volver
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
