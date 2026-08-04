'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Panel admin · Licencia (B1 de `work/migracion-env-a-panel.md`).
 *
 * super_admin-only (enforced por el backend — `LicenseAdminController`). Si
 * `DIDACTA_LICENSE_KEY` está fijada por env, el formulario de activación no
 * se muestra: el env gana siempre (§1 del documento), y aquí solo se ve el
 * estado con el badge "definido por el operador".
 *
 * No hay servidor de licencias en este flujo (eso es el "motor" de
 * `work/motor-licencias-propuesta.md`, decisión de producto aparte): la
 * verificación es 100% local con las claves públicas embebidas en el SDK.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import {
  adminLicenseApi,
  LICENSE_STATUS_LABEL,
  type AdminLicenseStatusDto,
} from '@/lib/admin-license';

interface ToastState {
  variant: 'success' | 'error';
  message: string;
}

export default function AdminLicenciaPage() {
  const [status, setStatus] = useState<AdminLicenseStatusDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await adminLicenseApi.get();
      setStatus(data);
    } catch (err) {
      setLoadError(
        err instanceof ApiHttpError ? err.message : 'No se pudo cargar el estado de la licencia.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setToast(null);
    if (!keyInput.trim()) {
      setToast({ variant: 'error', message: 'Pega la clave de licencia.' });
      return;
    }
    setSaving(true);
    try {
      const updated = await adminLicenseApi.setKey(keyInput.trim());
      setStatus(updated);
      setKeyInput('');
      setToast({
        variant: 'success',
        message: `Licencia activada: ${LICENSE_STATUS_LABEL[updated.status]}.`,
      });
    } catch (err) {
      setToast({
        variant: 'error',
        message: err instanceof ApiHttpError ? err.message : 'No se pudo activar la licencia.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleRefresh(): Promise<void> {
    setRefreshing(true);
    try {
      const updated = await adminLicenseApi.refresh();
      setStatus(updated);
    } catch (err) {
      setToast({
        variant: 'error',
        message: err instanceof ApiHttpError ? err.message : 'No se pudo revalidar el estado.',
      });
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setDeleting(true);
    try {
      const updated = await adminLicenseApi.clearKey();
      setStatus(updated);
      setToast({ variant: 'success', message: 'Licencia eliminada del panel.' });
      setDeleteDialogOpen(false);
    } catch (err) {
      setToast({
        variant: 'error',
        message: err instanceof ApiHttpError ? err.message : 'No se pudo eliminar la licencia.',
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">Licencia</h1>
        <p className="text-text-muted">
          Activa una licencia Enterprise pegando la clave que recibiste al comprarla. La
          verificación es local — la instancia no llama a ningún servidor externo para comprobarla.
        </p>
      </header>

      {loadError ? (
        <Card>
          <CardContent className="p-6 text-sm text-danger-700">{loadError}</CardContent>
        </Card>
      ) : status === null ? (
        <div className="skeleton h-40 w-full" />
      ) : (
        <>
          <StatusCard
            status={status}
            onRefresh={() => void handleRefresh()}
            refreshing={refreshing}
          />

          <Card>
            <CardHeader>
              <CardTitle>
                {status.hasKeyConfigured ? 'Cambiar clave' : 'Activar licencia'}
              </CardTitle>
              <CardDescription>
                {status.managedByEnv
                  ? 'La clave está fijada por la variable de entorno DIDACTA_LICENSE_KEY del operador del despliegue — no se puede cambiar desde aquí.'
                  : 'Pega el JWT (empieza por "eyJ") que recibiste al comprar tu licencia Enterprise.'}
              </CardDescription>
            </CardHeader>
            {status.managedByEnv ? null : (
              <CardContent className="space-y-4">
                <form onSubmit={handleSubmit} aria-busy={saving} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="license-key">Clave de licencia</Label>
                    <Textarea
                      id="license-key"
                      rows={4}
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      placeholder="eyJhbGciOiJFUzI1NiIs..."
                      className="font-mono text-xs"
                    />
                  </div>

                  {toast ? (
                    <div
                      role="status"
                      aria-live="polite"
                      className={
                        'rounded-md border p-3 text-sm ' +
                        (toast.variant === 'success'
                          ? 'border-success-200 bg-success-50 text-success-700'
                          : 'border-danger-100 bg-danger-50 text-danger-700')
                      }
                      data-testid="license-toast"
                    >
                      {toast.message}
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-soft pt-4">
                    <Button type="submit" disabled={saving}>
                      {saving
                        ? 'Activando…'
                        : status.hasKeyConfigured
                          ? 'Guardar nueva clave'
                          : 'Activar'}
                    </Button>
                    {status.hasKeyConfigured ? (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setDeleteDialogOpen(true)}
                        className="text-danger-700 hover:bg-danger-50"
                      >
                        Quitar licencia
                      </Button>
                    ) : null}
                  </div>
                </form>
              </CardContent>
            )}
          </Card>

          {status.capabilities.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Capabilities activas</CardTitle>
                <CardDescription>
                  Funcionalidades Enterprise habilitadas por esta licencia.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {status.capabilities.map((cap) => (
                    <Badge key={cap} variant="outline" className="font-mono text-xs">
                      {cap}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quitar licencia</DialogTitle>
            <DialogDescription>
              La instalación volverá a modo Community (o al valor de DIDACTA_LICENSE_KEY si el
              operador fijó uno por env). Las capabilities Enterprise se desactivan de inmediato.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              {deleting ? 'Quitando…' : 'Quitar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const STATUS_STYLE: Record<
  AdminLicenseStatusDto['status'],
  { border: string; bg: string; text: string; icon: 'check' | 'clock' | 'alert' }
> = {
  active: {
    border: 'border-success-200',
    bg: 'bg-success-50',
    text: 'text-success-700',
    icon: 'check',
  },
  dev: {
    border: 'border-warning-200',
    bg: 'bg-warning-50',
    text: 'text-warning-700',
    icon: 'alert',
  },
  grace: {
    border: 'border-warning-200',
    bg: 'bg-warning-50',
    text: 'text-warning-700',
    icon: 'clock',
  },
  expired: {
    border: 'border-danger-100',
    bg: 'bg-danger-50',
    text: 'text-danger-700',
    icon: 'alert',
  },
  invalid: {
    border: 'border-danger-100',
    bg: 'bg-danger-50',
    text: 'text-danger-700',
    icon: 'alert',
  },
  community: {
    border: 'border-border-soft',
    bg: 'bg-surface-2',
    text: 'text-text-muted',
    icon: 'check',
  },
};

function formatDate(iso: string | undefined | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatusCard({
  status,
  onRefresh,
  refreshing,
}: {
  status: AdminLicenseStatusDto;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const style = STATUS_STYLE[status.status];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="shield" size={18} />
          Estado de la licencia
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          role="status"
          data-testid="license-status-banner"
          className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${style.border} ${style.bg} ${style.text}`}
        >
          <span className="flex items-center gap-2">
            <Icon name={style.icon} size={16} aria-hidden="true" />
            <strong>{LICENSE_STATUS_LABEL[status.status]}</strong>
            {status.organizationName ? <span>— {status.organizationName}</span> : null}
          </span>
          {status.managedByEnv ? (
            <Badge variant="outline" title="Fijada por DIDACTA_LICENSE_KEY">
              definido por el operador · solo lectura
            </Badge>
          ) : null}
        </div>

        {status.status !== 'community' ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {status.plan ? (
              <div>
                <dt className="text-text-subtle">Plan</dt>
                <dd className="font-medium">{status.plan}</dd>
              </div>
            ) : null}
            {status.edition ? (
              <div>
                <dt className="text-text-subtle">Edición</dt>
                <dd className="font-medium capitalize">{status.edition}</dd>
              </div>
            ) : null}
            {formatDate(status.issuedAt) ? (
              <div>
                <dt className="text-text-subtle">Emitida</dt>
                <dd className="font-medium">{formatDate(status.issuedAt)}</dd>
              </div>
            ) : null}
            {formatDate(status.expiresAt) ? (
              <div>
                <dt className="text-text-subtle">Expira</dt>
                <dd className="font-medium">{formatDate(status.expiresAt)}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {status.warnings.length > 0 ? (
          <ul className="space-y-1 rounded-md border border-warning-200 bg-warning-50 p-3 text-sm text-warning-700">
            {status.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-center justify-between border-t border-border-soft pt-3">
          <span className="text-xs text-text-subtle">
            Última revisión: {formatDate(status.loadedAt) ?? '—'}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? 'Revalidando…' : 'Revalidar estado'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
