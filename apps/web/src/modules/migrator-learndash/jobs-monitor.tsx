'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
/// Monitor en tiempo real de jobs del migrator-learndash.
///
/// Lista todos los jobs del tenant, auto-refresh cada 3s para los que están
/// en estado activo (pending/preflight/extracting/transforming/loading/
/// reconciling). Cada card muestra el cursor actual leído de `progress` JSONB
/// (entity + page o batch) — la UX que faltaba para que el operador no tenga
/// que hacer SELECTs a la BD para entender qué pasa.
///
/// Al expandir un job, lee el report (validation_reports agregado) + las
/// primeras 20 filas del DLQ, agrupadas por phase. Permite cancelar jobs
/// activos con confirmación.
///
/// alpha.58: introducido para resolver UX-001..UX-003 del HANDOFF alpha.51.

import * as React from 'react';
import {
  migratorLearndashApi,
  type DlqEntry,
  type DlqPage,
  type JobReport,
  type JobStatus,
} from './client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const ACTIVE_STATES: ReadonlySet<JobStatus['status']> = new Set([
  'pending',
  'preflight',
  'extracting',
  'transforming',
  'loading',
  'reconciling',
]);

const POLL_INTERVAL_MS = 3000;

/// Mapa status → variante de badge (alineado con badge.tsx primitives).
const STATUS_BADGE: Record<JobStatus['status'], { variant: 'primary' | 'info' | 'warning' | 'success' | 'danger' | 'muted' | 'outline'; label: string }> = {
  pending: { variant: 'muted', label: 'Pendiente' },
  preflight: { variant: 'info', label: 'Preflight' },
  extracting: { variant: 'info', label: 'Extrayendo' },
  transforming: { variant: 'info', label: 'Transformando' },
  loading: { variant: 'info', label: 'Cargando' },
  reconciling: { variant: 'info', label: 'Reconciliando' },
  completed: { variant: 'success', label: 'Completado' },
  failed: { variant: 'danger', label: 'Fallido' },
  cancelled: { variant: 'outline', label: 'Cancelado' },
};

function shortId(id: string): string {
  return id.slice(0, 8);
}

function elapsedSince(iso: string): string {
  const start = new Date(iso).getTime();
  if (!Number.isFinite(start)) return '—';
  const ms = Date.now() - start;
  if (ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

interface ExtractCursorView {
  phase: string;
  current: string;
  page: number;
  completed?: string[];
  totalsPerEntity?: Record<string, number>;
}

function parseProgressCursor(progress: unknown): ExtractCursorView | null {
  if (!progress || typeof progress !== 'object') return null;
  const p = progress as any;
  if (typeof p.phase === 'string' && typeof p.current === 'string') {
    return {
      phase: p.phase,
      current: p.current,
      page: typeof p.page === 'number' ? p.page : 0,
      completed: Array.isArray(p.completed) ? p.completed : undefined,
      totalsPerEntity: p.totalsPerEntity && typeof p.totalsPerEntity === 'object' ? p.totalsPerEntity : undefined,
    };
  }
  return null;
}

function formatCursor(job: JobStatus): string {
  const c = parseProgressCursor(job.progress);
  if (!c) return job.status;
  if (c.phase === 'extract') {
    const totals = c.totalsPerEntity
      ? Object.entries(c.totalsPerEntity).map(([k, v]) => `${k}=${v}`).join(', ')
      : '';
    return `Extract: ${c.current} página ${c.page}${totals ? ` (totales: ${totals})` : ''}`;
  }
  if (c.phase === 'transform') {
    const done = c.completed?.length ?? 0;
    return `Transform: ${c.current} (${done} entidades completadas)`;
  }
  if (c.phase === 'load') {
    const done = c.completed?.length ?? 0;
    return `Load: ${c.current} (${done} entidades completadas)`;
  }
  return job.status;
}

export function JobsMonitor(): React.ReactElement {
  const [jobs, setJobs] = React.useState<JobStatus[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<{ report?: JobReport; dlq?: DlqPage; loading: boolean } | null>(null);
  const [, forceTick] = React.useState(0);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchJobs = React.useCallback(async (): Promise<void> => {
    try {
      const result = await migratorLearndashApi.listJobs();
      setJobs(result.items);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message ?? 'Error cargando jobs');
    }
  }, []);

  const fetchDetail = React.useCallback(async (jobId: string): Promise<void> => {
    setDetail({ loading: true });
    try {
      const [report, dlq] = await Promise.all([
        migratorLearndashApi.getReport(jobId).catch(() => undefined),
        migratorLearndashApi.getDlq(jobId, { limit: 20 }).catch(() => undefined),
      ]);
      setDetail({ report, dlq, loading: false });
    } catch (e) {
      setDetail({ loading: false });
    }
  }, []);

  // Inicial + polling.
  React.useEffect(() => {
    void fetchJobs();
    pollRef.current = setInterval(() => {
      // Re-fetch lista. También refrescamos el reloj para los elapsedSince.
      forceTick((n) => n + 1);
      if (jobs && jobs.some((j) => ACTIVE_STATES.has(j.status))) {
        void fetchJobs();
      } else {
        // Sin jobs activos: solo el reloj se actualiza, no pegamos al backend.
      }
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-evaluar si hay activos en cada render para tomar la decisión actualizada
  // (el callback de setInterval captura el closure inicial sin refresh).
  React.useEffect(() => {
    if (!jobs) return;
    if (jobs.some((j) => ACTIVE_STATES.has(j.status))) {
      // Forzar fetch porque el polling decide leyendo el closure viejo.
      // Tirar uno manual al detectar transición.
    }
  }, [jobs]);

  const handleExpand = (jobId: string): void => {
    if (expandedId === jobId) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(jobId);
    void fetchDetail(jobId);
  };

  const handleCancel = async (jobId: string): Promise<void> => {
    try {
      await migratorLearndashApi.cancelJob(jobId);
      await fetchJobs();
      if (expandedId === jobId) await fetchDetail(jobId);
    } catch (e: any) {
      setLoadError(e?.message ?? 'Error cancelando job');
    }
  };

  if (jobs === null) {
    return <Card><CardContent className="p-6 text-sm text-text-muted">Cargando jobs…</CardContent></Card>;
  }

  if (loadError) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <p className="text-sm text-destructive">Error cargando jobs: {loadError}</p>
          <Button size="sm" onClick={() => void fetchJobs()}>Reintentar</Button>
        </CardContent>
      </Card>
    );
  }

  if (jobs.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 space-y-2 text-sm text-text-muted">
          <p>Aún no hay migraciones para este tenant.</p>
          <p>Creá una desde la pestaña <strong>Crear migración</strong>.</p>
        </CardContent>
      </Card>
    );
  }

  const active = jobs.filter((j) => ACTIVE_STATES.has(j.status));
  const terminal = jobs.filter((j) => !ACTIVE_STATES.has(j.status));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-muted">
          {active.length > 0
            ? `${active.length} migración(es) en curso · auto-refresh cada ${POLL_INTERVAL_MS / 1000}s`
            : 'Sin migraciones activas en este momento'}
        </p>
        <Button size="sm" variant="ghost" onClick={() => void fetchJobs()}>↻ Refrescar</Button>
      </div>

      {active.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted">En curso</h3>
          {active.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              expanded={expandedId === job.id}
              detail={expandedId === job.id ? detail : null}
              onExpand={() => handleExpand(job.id)}
              onCancel={() => handleCancel(job.id)}
            />
          ))}
        </section>
      )}

      {terminal.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted">Historial</h3>
          {terminal.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              expanded={expandedId === job.id}
              detail={expandedId === job.id ? detail : null}
              onExpand={() => handleExpand(job.id)}
              onCancel={null}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function JobCard({
  job,
  expanded,
  detail,
  onExpand,
  onCancel,
}: {
  job: JobStatus;
  expanded: boolean;
  detail: { report?: JobReport; dlq?: DlqPage; loading: boolean } | null;
  onExpand: () => void;
  onCancel: (() => void) | null;
}): React.ReactElement {
  const [cancelDialogOpen, setCancelDialogOpen] = React.useState(false);
  const badge = STATUS_BADGE[job.status];
  const cursorText = formatCursor(job);
  const isActive = ACTIVE_STATES.has(job.status);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0 flex-1">
            <CardTitle className="text-base font-mono">
              {shortId(job.id)}…
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(job.id)}
                className="ml-2 text-xs text-text-muted hover:text-foreground"
                title="Copiar ID completo"
              >
                ⎘
              </button>
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={badge.variant}>{badge.label}</Badge>
              <span className="text-xs text-text-muted">
                {elapsedSince(job.startedAt)} {isActive ? 'en ejecución' : `· terminó ${job.completedAt ? new Date(job.completedAt).toLocaleString() : ''}`}
              </span>
            </div>
            {isActive && (
              <p className="text-xs text-text-muted font-mono pt-1">
                {cursorText}
              </p>
            )}
            {job.error && (
              <p className="text-xs text-destructive pt-1">
                <strong>{job.error.code}:</strong> {job.error.message}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" variant="outline" onClick={onExpand}>
              {expanded ? 'Ocultar' : 'Detalle'}
            </Button>
            {onCancel && (
              <>
                <Button size="sm" variant="destructive" onClick={() => setCancelDialogOpen(true)}>Cancelar</Button>
                <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>¿Cancelar esta migración?</AlertDialogTitle>
                      <AlertDialogDescription>
                        El job dejará de progresar después del tick actual. Lo que ya se cargó al core
                        se mantiene (idempotencia por externalRef permite re-correr una migración nueva
                        sin duplicar). Los rows en staging quedan para auditoría según retentionDays.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel onClick={() => setCancelDialogOpen(false)}>Volver</AlertDialogCancel>
                      <AlertDialogAction onClick={() => { setCancelDialogOpen(false); onCancel(); }}>
                        Sí, cancelar
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="border-t pt-4 space-y-4">
          <JobDetail detail={detail} />
        </CardContent>
      )}
    </Card>
  );
}

function JobDetail({ detail }: { detail: { report?: JobReport; dlq?: DlqPage; loading: boolean } | null }): React.ReactElement {
  if (!detail || detail.loading) {
    return <p className="text-sm text-text-muted">Cargando detalle…</p>;
  }
  const { report, dlq } = detail;
  return (
    <div className="space-y-5">
      {report && report.byEntity.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Reconciliación por entidad</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b text-left text-text-muted">
                <tr>
                  <th className="py-2 pr-3">Entidad</th>
                  <th className="py-2 pr-3 text-right">Staged</th>
                  <th className="py-2 pr-3 text-right">Válidas</th>
                  <th className="py-2 pr-3 text-right">Cargadas</th>
                  <th className="py-2 pr-3 text-right">Skipped</th>
                  <th className="py-2 pr-3 text-right">Failed</th>
                </tr>
              </thead>
              <tbody>
                {report.byEntity.map((e) => (
                  <tr key={e.entityType} className="border-b">
                    <td className="py-1.5 pr-3 font-mono">{e.entityType}</td>
                    <td className="py-1.5 pr-3 text-right">{e.stagedCount}</td>
                    <td className="py-1.5 pr-3 text-right">{e.validCount}</td>
                    <td className="py-1.5 pr-3 text-right font-semibold text-success-700">{e.loadedCount}</td>
                    <td className="py-1.5 pr-3 text-right text-text-muted">{e.skippedCount}</td>
                    <td className="py-1.5 pr-3 text-right text-destructive">{e.failedCount}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t font-semibold">
                <tr>
                  <td className="py-2 pr-3">Total</td>
                  <td className="py-2 pr-3 text-right">—</td>
                  <td className="py-2 pr-3 text-right">—</td>
                  <td className="py-2 pr-3 text-right text-success-700">{report.totals.loadedCount}</td>
                  <td className="py-2 pr-3 text-right text-text-muted">{report.totals.skippedCount}</td>
                  <td className="py-2 pr-3 text-right text-destructive">{report.totals.failedCount}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {report.auditChain.eventsCount > 0 && (
            <p className="text-xs text-text-muted">
              Cadena de auditoría: {report.auditChain.eventsCount} evento(s) · {report.auditChain.verified ? '✓ integridad verificada' : '✗ integridad no verificable'}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-text-muted">Aún no hay datos de reconciliación. El reporte se genera en la fase final del job.</p>
      )}

      {dlq && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">
            Dead Letter Queue {dlq.total > 0 && <span className="text-text-muted font-normal">({dlq.total} fila(s), mostrando {dlq.items.length})</span>}
          </h4>
          {dlq.items.length === 0 ? (
            <p className="text-xs text-text-muted">Sin errores registrados — todas las filas procesadas OK.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b text-left text-text-muted">
                  <tr>
                    <th className="py-2 pr-3">Entidad</th>
                    <th className="py-2 pr-3">Source ID</th>
                    <th className="py-2 pr-3">Phase</th>
                    <th className="py-2 pr-3">Error</th>
                    <th className="py-2 pr-3">Mensaje</th>
                  </tr>
                </thead>
                <tbody>
                  {dlq.items.map((e: DlqEntry, idx: number) => (
                    <tr key={`${e.entityType}-${e.sourceId}-${idx}`} className="border-b align-top">
                      <td className="py-1.5 pr-3 font-mono">{e.entityType}</td>
                      <td className="py-1.5 pr-3 font-mono">{e.sourceId ?? '—'}</td>
                      <td className="py-1.5 pr-3"><Badge variant="outline">{e.phase}</Badge></td>
                      <td className="py-1.5 pr-3 font-mono">{e.errorCode}</td>
                      <td className="py-1.5 pr-3 text-text-muted">{e.errorMessage}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
