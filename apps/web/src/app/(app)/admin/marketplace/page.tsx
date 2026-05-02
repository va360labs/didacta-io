'use client';

/**
 * Panel super_admin · Marketplace de módulos (ADR-009 PR F).
 *
 * Permite al operador self-host:
 *   1. Subir un paquete `*.didactamod` firmado por VA360 vía drag&drop o
 *      file picker. El paquete viaja como body `application/zip` directo
 *      al endpoint `POST /admin/modules/install` (sin multipart, sin
 *      base64 — coherente con el body parser registrado en `main.ts`).
 *   2. Ver los módulos instalados con su estado (INSTALLING, INSTALLED,
 *      FAILED, DEPRECATED) y `errorMessage` cuando falló.
 *   3. Desinstalar un módulo (borra row + invalida runtime router; NO
 *      borra el blob en object storage para diagnóstico postmortem).
 *
 * Tab "Desde marketplace web" es informativo: el flujo push install vive
 * en didacta.io y aún no está construido (ver `docs/MARKETPLACE-WEB-SPEC.md`).
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import {
  marketplaceApi,
  type InstalledModuleStatus,
  type InstalledModuleSummary,
} from '@/lib/marketplace';

const MAX_BYTES = 50 * 1024 * 1024;

export default function AdminMarketplacePage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-bold tracking-tight">Marketplace de módulos</h1>
        <p className="text-text-muted">
          Subí un paquete <code>*.didactamod</code> firmado por VA360 para añadir un módulo a esta
          instancia sin reiniciar el API. Los módulos quedan disponibles para ser activados por
          tenant en <a href="/admin/configuracion" className="underline">Configuración</a>.
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
    | { kind: 'success'; name: string; version: string }
    | { kind: 'error'; message: string; code?: string }
    | null
  >(null);

  const handleFiles = async (file: File) => {
    setFeedback(null);
    if (file.size > MAX_BYTES) {
      setFeedback({ kind: 'error', message: `El paquete excede 50 MiB (${file.size} bytes).` });
      return;
    }
    setBusy(true);
    try {
      const result = await marketplaceApi.install(file);
      setFeedback({ kind: 'success', name: result.name, version: result.version });
      window.dispatchEvent(new CustomEvent('marketplace:installed'));
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
          Arrastrá el <code>.didactamod</code> aquí o seleccionalo del disco. La instancia valida
          firma + lint del bundle + migrations SQL antes de aceptar.
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
            {busy ? 'Procesando paquete…' : 'Arrastrá el .didactamod aquí'}
          </p>
          <p className="mb-4 text-sm text-text-muted">o</p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            Seleccionar archivo
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".didactamod,application/zip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFiles(file);
              e.target.value = ''; // permite re-seleccionar el mismo archivo
            }}
          />
          <p className="mt-4 text-xs text-text-muted">Máximo 50 MiB · solo paquetes firmados por VA360</p>
        </div>

        {feedback?.kind === 'success' && (
          <div className="mt-4 rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900">
            <strong>{feedback.name}@{feedback.version}</strong> instalado correctamente.
          </div>
        )}
        {feedback?.kind === 'error' && (
          <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            {feedback.code ? <code className="mr-2">[{feedback.code}]</code> : null}
            {feedback.message}
          </div>
        )}
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
          <a href="/admin/configuracion" className="underline">Configuración</a>.
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
            Aún no hay módulos instalados via marketplace. Los módulos compilados en la imagen Docker
            (mod.courses, mod.community, etc.) se gestionan desde Configuración.
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

function InstalledRow({
  row,
  onChange,
}: {
  row: InstalledModuleSummary;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onUninstall = async () => {
    if (!confirm(`¿Desinstalar "${row.name}@${row.version}"? Esta acción no se puede deshacer.`)) return;
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
            <code className="text-xs text-text-muted">{row.name}@{row.version}</code>
            <StatusBadge status={row.status} />
            <VendorBadge vendor={row.vendor} />
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
  const map: Record<InstalledModuleStatus, { variant: 'default' | 'secondary' | 'destructive'; label: string }> = {
    INSTALLING: { variant: 'secondary', label: 'Instalando…' },
    INSTALLED: { variant: 'default', label: 'Instalado' },
    FAILED: { variant: 'destructive', label: 'Falló' },
    DEPRECATED: { variant: 'secondary', label: 'Deprecated' },
  };
  const { variant, label } = map[status];
  return <Badge variant={variant}>{label}</Badge>;
}

function VendorBadge({ vendor }: { vendor: InstalledModuleSummary['vendor'] }) {
  return (
    <Badge variant="secondary" className="text-[10px] uppercase">
      {vendor === 'VA360' ? 'VA360' : 'Community'}
    </Badge>
  );
}

function FromWebMarketplaceTeaser() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Desde el marketplace web (próximamente)</CardTitle>
        <CardDescription>
          Pronto vas a poder navegar el catálogo público de módulos en didacta.io y dispararlos a esta
          instancia con un click. El flujo está descrito en <code>docs/MARKETPLACE-WEB-SPEC.md</code>.
          Mientras, el upload offline de arriba es la forma soportada.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
