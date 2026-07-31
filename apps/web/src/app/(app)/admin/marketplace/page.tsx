'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Panel super_admin · Marketplace de módulos (ADR-009 PR F + DISC-002).
 *
 * Permite al operador self-host:
 *   1. Subir un paquete `*.zip` vía drag&drop o file picker. Acepta tanto
 *      paquetes firmados por Didacta como uploads directos sin firma
 *      (DISC-002). El paquete viaja como body `application/zip` directo
 *      al endpoint `POST /admin/modules/install`.
 *   2. Ver los módulos instalados con su estado (INSTALLING, INSTALLED,
 *      FAILED, DEPRECATED) y badges de origen (Oficial, Comunidad, No
 *      verificado) según DISC-002.
 *   3. Desinstalar un módulo (borra row + invalida runtime router; NO
 *      borra el blob en object storage para diagnóstico postmortem).
 *
 * Cuando se sube un módulo sin firma válida, se muestra un AlertDialog de
 * advertencia para que el operador sea consciente del nivel de confianza.
 *
 * Tab "Desde marketplace web" es informativo: el flujo push install vive
 * en didacta.io y aún no está construido (ver `docs/MARKETPLACE-WEB-SPEC.md`).
 */

import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '@/components/icon';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import {
  marketplaceApi,
  type InstalledModuleSource,
  type InstalledModuleStatus,
  type InstalledModuleSummary,
  type InstallSuccessResponse,
} from '@/lib/marketplace';

const MAX_BYTES = 50 * 1024 * 1024;

export default function AdminMarketplacePage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">Marketplace de módulos</h1>
        <p className="text-text-muted">
          Sube un paquete <code>.zip</code> firmado por Didacta para añadir un módulo a esta
          instancia sin reiniciar el API. Los módulos quedan disponibles para ser activados por
          tenant en{' '}
          <a href="/admin/configuracion" className="underline">
            Configuración
          </a>
          .
        </p>
      </header>

      <UploadCard />
      <InstalledList />
      <FromWebMarketplaceTeaser />
    </div>
  );
}

function UploadCard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<
    | {
        kind: 'success';
        name: string;
        version: string;
        signatureVerified: boolean;
        signatureError?: string;
      }
    | { kind: 'error'; message: string; code?: string }
    | null
  >(null);
  // Modal de warning para módulos no verificados (DISC-002)
  const [warningOpen, setWarningOpen] = useState(false);

  const handleFiles = async (file: File) => {
    setFeedback(null);
    if (file.size > MAX_BYTES) {
      setFeedback({ kind: 'error', message: `El paquete excede 50 MiB (${file.size} bytes).` });
      return;
    }
    setBusy(true);
    try {
      const result = await marketplaceApi.install(file);
      const successFeedback = {
        kind: 'success' as const,
        name: result.name,
        version: result.version,
        signatureVerified: result.signatureVerified,
        signatureError: result.signatureError,
      };
      setFeedback(successFeedback);
      window.dispatchEvent(new CustomEvent('marketplace:installed'));
      // Si el módulo no está verificado, mostrar warning (DISC-002)
      if (!result.signatureVerified) {
        setWarningOpen(true);
      }
    } catch (e) {
      setFeedback({
        kind: 'error',
        message: e instanceof ApiHttpError ? e.message : 'Error desconocido al subir el paquete.',
        code: e instanceof ApiHttpError ? e.code : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subir paquete</CardTitle>
        <CardDescription>
          Arrastra el <code>.zip</code> aquí o selecciónalo del disco. La instancia valida firma +
          lint del bundle + migrations SQL antes de aceptar.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void handleFiles(file);
          }}
          className={[
            'rounded-lg border-2 border-dashed p-8 text-center transition-colors',
            drag ? 'border-primary bg-primary/5' : 'border-border',
            busy ? 'opacity-60 pointer-events-none' : '',
          ].join(' ')}
        >
          <Icon name="package" className="mx-auto mb-3 h-10 w-10 text-text-muted" />
          <p className="mb-2 font-medium">
            {busy ? 'Procesando paquete…' : 'Arrastra el .zip aquí'}
          </p>
          <p className="mb-4 text-sm text-text-muted">o</p>
          <Button variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            Seleccionar archivo
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFiles(file);
              e.target.value = ''; // permite re-seleccionar el mismo archivo
            }}
          />
          <p className="mt-4 text-xs text-text-muted">
            Máximo 50 MiB · solo paquetes firmados por Didacta
          </p>
        </div>

        {feedback?.kind === 'success' && (
          <div
            className={[
              'mt-4 rounded border p-3 text-sm',
              feedback.signatureVerified
                ? 'border-green-300 bg-green-50 text-green-900'
                : 'border-amber-300 bg-amber-50 text-amber-900',
            ].join(' ')}
          >
            <strong>
              {feedback.name}@{feedback.version}
            </strong>{' '}
            instalado correctamente.
            {!feedback.signatureVerified && (
              <span className="ml-2 font-normal">(sin verificar — ver advertencia)</span>
            )}
          </div>
        )}
        {feedback?.kind === 'error' && (
          <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            {feedback.code ? <code className="mr-2">[{feedback.code}]</code> : null}
            {feedback.message}
          </div>
        )}

        {/* Modal de advertencia para módulos no verificados (DISC-002) */}
        <AlertDialog open={warningOpen} onOpenChange={setWarningOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2 text-amber-600">
                <Icon name="alert" className="h-5 w-5" />
                Módulo no verificado
              </AlertDialogTitle>
              <AlertDialogDescription className="space-y-3">
                <p>
                  El módulo{' '}
                  <strong>
                    {feedback?.kind === 'success' ? `${feedback.name}@${feedback.version}` : ''}
                  </strong>{' '}
                  se instaló correctamente pero <strong>no tiene firma verificada</strong> de
                  Didacta.
                </p>
                <p>
                  Esto significa que el paquete fue subido directamente y no pasó por el proceso de
                  revisión y firma del marketplace oficial.
                </p>
                {feedback?.kind === 'success' && feedback.signatureError && (
                  <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                    <strong>Detalle:</strong> {feedback.signatureError}
                  </div>
                )}
                <p className="text-amber-700">
                  Solo confía en módulos de fuentes que conozcas. Si no reconoces este paquete,
                  considera desinstalarlo desde la lista de módulos.
                </p>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogAction onClick={() => setWarningOpen(false)}>Entendido</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

function InstalledList() {
  const [rows, setRows] = useState<InstalledModuleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      const out = await marketplaceApi.list();
      setRows(out.modules);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Error al listar módulos instalados.');
    }
  };

  useEffect(() => {
    void refresh();
    const onInstalled = () => void refresh();
    window.addEventListener('marketplace:installed', onInstalled);
    return () => window.removeEventListener('marketplace:installed', onInstalled);
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Módulos instalados</CardTitle>
        <CardDescription>
          Lista a nivel de instancia. La activación por tenant sigue viviendo en{' '}
          <a href="/admin/configuracion" className="underline">
            Configuración
          </a>
          .
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="mb-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            {error}
          </div>
        )}
        {rows === null && !error && <p className="text-sm text-text-muted">Cargando…</p>}
        {rows && rows.length === 0 && (
          <p className="text-sm text-text-muted">
            Aún no hay módulos instalados via marketplace. Los módulos compilados en la imagen
            Docker (mod.courses, mod.community, etc.) se gestionan desde Configuración.
          </p>
        )}
        {rows && rows.length > 0 && (
          <div className="flex flex-col gap-2">
            {rows.map((row) => (
              <InstalledRow key={row.id} row={row} onChange={() => void refresh()} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InstalledRow({ row, onChange }: { row: InstalledModuleSummary; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onUninstall = async () => {
    if (!confirm(`¿Desinstalar "${row.name}@${row.version}"? Esta acción no se puede deshacer.`))
      return;
    setBusy(true);
    setError(null);
    try {
      await marketplaceApi.uninstall(row.name);
      onChange();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Error al desinstalar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <strong className="font-medium">{row.displayName}</strong>
            <code className="text-xs text-text-muted">
              {row.name}@{row.version}
            </code>
            <StatusBadge status={row.status} />
            <SourceBadge source={row.source} />
          </div>
          {row.description && <p className="text-sm text-text-muted">{row.description}</p>}
          <p className="text-xs text-text-muted">
            Namespace: <code>{row.apiNamespace}</code> · prefix: <code>{row.tablePrefix}</code>
            {row.installedAt && ` · instalado ${new Date(row.installedAt).toLocaleString()}`}
          </p>
          {row.status === 'FAILED' && row.errorMessage && (
            <p className="text-xs text-red-700">
              <strong>Error:</strong> {row.errorMessage}
            </p>
          )}
        </div>
        <Button variant="destructive" size="sm" disabled={busy} onClick={onUninstall}>
          {busy ? 'Desinstalando…' : 'Desinstalar'}
        </Button>
      </div>
      {error && <div className="mt-2 text-xs text-red-700">{error}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: InstalledModuleStatus }) {
  // El map cubre los valores tipados, pero la API puede devolver rows legacy
  // o futuros con un status que el frontend todavía no conoce. Fallback antes
  // de destructurar para que la página no se rompa entera por una fila exótica.
  const map: Record<
    InstalledModuleStatus,
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

function SourceBadge({ source }: { source: InstalledModuleSource }) {
  // Mismo principio que StatusBadge: la API puede devolver módulos built-in
  // del core con `source` null o con un valor legacy fuera del enum tipado.
  // Si destructuramos sin fallback, un solo módulo exótico revienta toda
  // la página /admin/marketplace.
  const config: Record<
    InstalledModuleSource,
    { variant: 'success' | 'info' | 'warning'; label: string; icon: IconName }
  > = {
    MARKETPLACE_OFFICIAL: { variant: 'success', label: 'Oficial', icon: 'check' },
    MARKETPLACE_COMMUNITY: { variant: 'info', label: 'Comunidad', icon: 'users' },
    DIRECT_UPLOAD: { variant: 'warning', label: 'No verificado', icon: 'alert' },
  };
  const entry = config[source] ?? {
    variant: 'warning' as const,
    label: String(source ?? 'Desconocido'),
    icon: 'alert' as IconName,
  };
  return (
    <Badge variant={entry.variant} className="gap-1 text-[10px]">
      <Icon name={entry.icon} className="h-3 w-3" />
      {entry.label}
    </Badge>
  );
}

function FromWebMarketplaceTeaser() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Desde el marketplace web (próximamente)</CardTitle>
        <CardDescription>
          Pronto vas a poder navegar el catálogo público de módulos en didacta.io y dispararlos a
          esta instancia con un click. El flujo está descrito en{' '}
          <code>docs/MARKETPLACE-WEB-SPEC.md</code>. Mientras, el upload offline de arriba es la
          forma soportada.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
