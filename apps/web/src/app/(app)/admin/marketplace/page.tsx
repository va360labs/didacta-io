'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Panel super_admin · Marketplace de módulos (ADR-009 PR F + DISC-002).
 *
 * Permite al operador self-host:
 *   1. Subir un paquete `*.zip` vía drag&drop o file picker. El paquete
 *      viaja como body `application/zip` directo al endpoint
 *      `POST /admin/modules/install`.
 *      Sólo se aceptan paquetes con firma verificable: el código de un
 *      módulo se ejecuta dentro del proceso de la API y con sus mismos
 *      permisos. Un ZIP sin firma válida se rechaza con 403
 *      (`MODULE_SIGNATURE_REQUIRED`) ANTES de instalar nada, salvo que el
 *      operador haya arrancado la API con
 *      `DIDACTA_ALLOW_UNVERIFIED_MODULES=true`.
 *   2. Ver los módulos instalados con su estado (INSTALLING, INSTALLED,
 *      FAILED, DEPRECATED) y badges de origen (Oficial, Comunidad, No
 *      verificado) según DISC-002.
 *   3. Desinstalar un módulo (borra row + invalida runtime router; NO
 *      borra el blob en object storage para diagnóstico postmortem).
 *
 * El AlertDialog de advertencia sólo llega a verse en instalaciones que han
 * activado `DIDACTA_ALLOW_UNVERIFIED_MODULES`: en el resto, el módulo sin
 * firma ni siquiera se instala y el operador ve el error del endpoint.
 *
 * Tab "Desde marketplace web" es informativo: el flujo push install vive
 * en didacta.io y aún no está construido.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
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
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDateTime } from '@/lib/i18n/format';
import { labelOr } from '@/lib/i18n/labels';
import {
  marketplaceApi,
  type InstalledModuleSource,
  type InstalledModuleStatus,
  type InstalledModuleSummary,
  type InstallSuccessResponse,
} from '@/lib/marketplace';

const MAX_BYTES = 50 * 1024 * 1024;

export default function AdminMarketplacePage() {
  const t = useTranslations('adminMonetizacion.marketplace');
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-text-muted">
          {t.rich('intro', {
            code: (chunks) => <code>{chunks}</code>,
            link: (chunks) => (
              <a href="/admin/configuracion" className="underline">
                {chunks}
              </a>
            ),
          })}
        </p>
      </header>

      <UploadCard />
      <InstalledList />
      <FromWebMarketplaceTeaser />
    </div>
  );
}

function UploadCard() {
  const t = useTranslations('adminMonetizacion.marketplace');
  const tErrors = useTranslations('errors');
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
      setFeedback({ kind: 'error', message: t('packageTooBig', { bytes: file.size }) });
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
        message: apiErrorMessage(e, tErrors),
        code: e instanceof ApiHttpError ? e.code : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('uploadTitle')}</CardTitle>
        <CardDescription>
          {t.rich('uploadDescription', { code: (chunks) => <code>{chunks}</code> })}
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
          <p className="mb-2 font-medium">{busy ? t('processing') : t('dropHere')}</p>
          <p className="mb-4 text-sm text-text-muted">{t('or')}</p>
          <Button variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {t('selectFile')}
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
          <p className="mt-4 text-xs text-text-muted">{t('maxNote')}</p>
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
            {t('installedOk')}
            {!feedback.signatureVerified && (
              <span className="ml-2 font-normal">{t('unverifiedTag')}</span>
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
                {t('unverifiedTitle')}
              </AlertDialogTitle>
              <AlertDialogDescription className="space-y-3">
                <p>
                  {t.rich('unverifiedBody', {
                    strong: (chunks) => <strong>{chunks}</strong>,
                    module:
                      feedback?.kind === 'success' ? `${feedback.name}@${feedback.version}` : '',
                  })}
                </p>
                <p>{t('unverifiedExplain')}</p>
                {feedback?.kind === 'success' && feedback.signatureError && (
                  <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                    <strong>{t('detailLabel')}</strong> {feedback.signatureError}
                  </div>
                )}
                <p className="text-amber-700">{t('unverifiedAdvice')}</p>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogAction onClick={() => setWarningOpen(false)}>
                {t('understood')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

function InstalledList() {
  const t = useTranslations('adminMonetizacion.marketplace');
  const tErrors = useTranslations('errors');
  const [rows, setRows] = useState<InstalledModuleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      const out = await marketplaceApi.list();
      setRows(out.modules);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
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
        <CardTitle>{t('installedTitle')}</CardTitle>
        <CardDescription>
          {t.rich('installedDescription', {
            link: (chunks) => (
              <a href="/admin/configuracion" className="underline">
                {chunks}
              </a>
            ),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="mb-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            {error}
          </div>
        )}
        {rows === null && !error && <p className="text-sm text-text-muted">{t('loading')}</p>}
        {rows && rows.length === 0 && (
          <p className="text-sm text-text-muted">{t('installedEmpty')}</p>
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
  const t = useTranslations('adminMonetizacion.marketplace');
  const tErrors = useTranslations('errors');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onUninstall = async () => {
    if (!confirm(t('confirmUninstall', { module: `${row.name}@${row.version}` }))) return;
    setBusy(true);
    setError(null);
    try {
      await marketplaceApi.uninstall(row.name);
      onChange();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
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
            {t.rich('metaLine', {
              code: (chunks) => <code>{chunks}</code>,
              ns: row.apiNamespace,
              prefix: row.tablePrefix,
            })}
            {row.installedAt && ` · ${t('installedAt', { date: formatDateTime(row.installedAt) })}`}
          </p>
          {row.status === 'FAILED' && row.errorMessage && (
            <p className="text-xs text-red-700">
              <strong>{t('errorLabel')}</strong> {row.errorMessage}
            </p>
          )}
        </div>
        <Button variant="destructive" size="sm" disabled={busy} onClick={onUninstall}>
          {busy ? t('uninstalling') : t('uninstall')}
        </Button>
      </div>
      {error && <div className="mt-2 text-xs text-red-700">{error}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: InstalledModuleStatus }) {
  // El map cubre los valores tipados, pero la API puede devolver rows legacy
  // o futuros con un status que el frontend todavía no conoce. Fallback antes
  // de indexar (labelOr) para que la página no se rompa entera por una fila exótica.
  const t = useTranslations('adminMonetizacion.moduleStatus');
  const variants: Record<InstalledModuleStatus, 'info' | 'success' | 'danger' | 'muted'> = {
    INSTALLING: 'info',
    INSTALLED: 'success',
    FAILED: 'danger',
    DEPRECATED: 'muted',
  };
  return (
    <Badge variant={variants[status] ?? 'muted'}>{labelOr(t, status, String(status ?? '—'))}</Badge>
  );
}

function SourceBadge({ source }: { source: InstalledModuleSource }) {
  // Mismo principio que StatusBadge: la API puede devolver módulos built-in
  // del core con `source` null o con un valor legacy fuera del enum tipado.
  // Si indexamos sin fallback, un solo módulo exótico revienta toda
  // la página /admin/marketplace.
  const t = useTranslations('adminMonetizacion.moduleSource');
  const config: Record<
    InstalledModuleSource,
    { variant: 'success' | 'info' | 'warning'; icon: IconName }
  > = {
    MARKETPLACE_OFFICIAL: { variant: 'success', icon: 'check' },
    MARKETPLACE_COMMUNITY: { variant: 'info', icon: 'users' },
    DIRECT_UPLOAD: { variant: 'warning', icon: 'alert' },
  };
  const entry = config[source] ?? { variant: 'warning' as const, icon: 'alert' as IconName };
  const label = source ? labelOr(t, source, String(source)) : t('unknown');
  return (
    <Badge variant={entry.variant} className="gap-1 text-[10px]">
      <Icon name={entry.icon} className="h-3 w-3" />
      {label}
    </Badge>
  );
}

function FromWebMarketplaceTeaser() {
  const t = useTranslations('adminMonetizacion.marketplace');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('teaserTitle')}</CardTitle>
        <CardDescription>
          {t.rich('teaserDescription', { code: (chunks) => <code>{chunks}</code> })}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
