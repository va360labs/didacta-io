/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/// Monitor en tiempo real de jobs del migrator-learndash.
///
/// alpha.60: movido a modules/migrator-learndash/src/ui/ desde apps/web/ —
/// ahora vive dentro del módulo y se distribuye como parte del ZIP firmado.
/// Imports SOLO desde `./_runtime` y `./client` — sin dependencias directas
/// a `react` ni `@/components/ui/*` (ADR-015).

import {
  React,
  useState,
  useEffect,
  useRef,
  useCallback,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Badge,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './_runtime';
import {
  migratorLearndashApi,
  type DlqEntry,
  type DlqPage,
  type JobReport,
  type JobStatus,
} from './client';
import { formatDateTime, formatNumber, t, type MessageKey } from './i18n';
import { tRich } from './i18n-rich';

const ACTIVE_STATES: ReadonlySet<JobStatus['status']> = new Set([
  'pending',
  'preflight',
  'extracting',
  'transforming',
  'loading',
  'reconciling',
]);

const POLL_INTERVAL_MS = 3000;

/// Mapa status → variante de badge (alineado con badge.tsx primitives del host).
/// `label` es la CLAVE del diccionario (`i18n.ts`), que se traduce al pintar.
const STATUS_BADGE: Record<
  JobStatus['status'],
  {
    variant: 'primary' | 'info' | 'warning' | 'success' | 'danger' | 'muted' | 'outline';
    label: MessageKey;
  }
> = {
  pending: { variant: 'muted', label: 'monitor.status.pending' },
  preflight: { variant: 'info', label: 'monitor.status.preflight' },
  extracting: { variant: 'info', label: 'monitor.status.extracting' },
  transforming: { variant: 'info', label: 'monitor.status.transforming' },
  loading: { variant: 'info', label: 'monitor.status.loading' },
  reconciling: { variant: 'info', label: 'monitor.status.reconciling' },
  completed: { variant: 'success', label: 'monitor.status.completed' },
  failed: { variant: 'danger', label: 'monitor.status.failed' },
  cancelled: { variant: 'outline', label: 'monitor.status.cancelled' },
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
      totalsPerEntity:
        p.totalsPerEntity && typeof p.totalsPerEntity === 'object' ? p.totalsPerEntity : undefined,
    };
  }
  return null;
}

function formatCursor(job: JobStatus): string {
  const c = parseProgressCursor(job.progress);
  if (!c) return job.status;
  if (c.phase === 'extract') {
    const totals = c.totalsPerEntity
      ? Object.entries(c.totalsPerEntity)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
      : '';
    return totals
      ? t('monitor.cursor.extractWithTotals', { current: c.current, page: c.page, totals })
      : t('monitor.cursor.extract', { current: c.current, page: c.page });
  }
  if (c.phase === 'transform') {
    const done = c.completed?.length ?? 0;
    return t('monitor.cursor.transform', { current: c.current, done });
  }
  if (c.phase === 'load') {
    const done = c.completed?.length ?? 0;
    return t('monitor.cursor.load', { current: c.current, done });
  }
  return job.status;
}

export function JobsMonitor(): React.ReactElement {
  const [jobs, setJobs] = useState<JobStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    report?: JobReport;
    dlq?: DlqPage;
    loading: boolean;
  } | null>(null);
  const [, forceTick] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobsRef = useRef<JobStatus[] | null>(null);
  const expandedIdRef = useRef<string | null>(null);

  const fetchJobs = useCallback(async (): Promise<void> => {
    try {
      const result = await migratorLearndashApi.listJobs();
      setJobs(result.items);
      jobsRef.current = result.items;
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message ?? t('monitor.error.loadJobs'));
    }
  }, []);

  const fetchDetail = useCallback(async (jobId: string): Promise<void> => {
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

  useEffect(() => {
    void fetchJobs();
    pollRef.current = setInterval(() => {
      forceTick((n: number) => n + 1);
      const current = jobsRef.current;
      const hasActive = !!current && current.some((j) => ACTIVE_STATES.has(j.status));
      if (hasActive) {
        void fetchJobs();
        const expanded = expandedIdRef.current;
        if (expanded) {
          const job = current!.find((j) => j.id === expanded);
          if (job && ACTIVE_STATES.has(job.status)) {
            void fetchDetail(expanded);
          }
        }
      }
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    expandedIdRef.current = expandedId;
  }, [expandedId]);

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
      setLoadError(e?.message ?? t('monitor.error.cancelJob'));
    }
  };

  if (jobs === null) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-text-muted">{t('monitor.loading')}</CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <p className="text-sm text-destructive">
            {t('monitor.loadErrorLine', { error: loadError })}
          </p>
          <Button size="sm" onClick={() => void fetchJobs()}>
            {t('monitor.retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (jobs.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 space-y-2 text-sm text-text-muted">
          <p>{t('monitor.empty')}</p>
          <p>{tRich('monitor.emptyHint', { tab: t('admin.tabs.wizard') })}</p>
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
            ? t('monitor.activeSummary', {
                count: active.length,
                seconds: POLL_INTERVAL_MS / 1000,
              })
            : t('monitor.noActive')}
        </p>
        <Button size="sm" variant="ghost" onClick={() => void fetchJobs()}>
          {t('monitor.refresh')}
        </Button>
      </div>

      {active.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted">
            {t('monitor.activeTitle')}
          </h3>
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
          <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted">
            {t('monitor.historyTitle')}
          </h3>
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
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
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
                title={t('monitor.copyId')}
                aria-label={t('monitor.copyId')}
              >
                ⎘
              </button>
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={badge.variant}>{t(badge.label)}</Badge>
              <span className="text-xs text-text-muted">
                {elapsedSince(job.startedAt)}{' '}
                {isActive
                  ? t('monitor.running')
                  : t('monitor.finished', {
                      date: job.completedAt ? formatDateTime(job.completedAt) : '',
                    })}
              </span>
            </div>
            {isActive && <p className="text-xs text-text-muted font-mono pt-1">{cursorText}</p>}
            {job.error && (
              <p className="text-xs text-destructive pt-1">
                <strong>{job.error.code}:</strong> {job.error.message}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" variant="outline" onClick={onExpand}>
              {expanded ? t('monitor.hide') : t('monitor.showDetail')}
            </Button>
            {onCancel && (
              <>
                <Button size="sm" variant="destructive" onClick={() => setCancelDialogOpen(true)}>
                  {t('monitor.cancel')}
                </Button>
                <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('monitor.cancelDialog.title')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('monitor.cancelDialog.body')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel onClick={() => setCancelDialogOpen(false)}>
                        {t('common.back')}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          setCancelDialogOpen(false);
                          onCancel();
                        }}
                      >
                        {t('monitor.cancelDialog.confirm')}
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

function JobDetail({
  detail,
}: {
  detail: { report?: JobReport; dlq?: DlqPage; loading: boolean } | null;
}): React.ReactElement {
  if (!detail || detail.loading) {
    return <p className="text-sm text-text-muted">{t('monitor.detail.loading')}</p>;
  }
  const { report, dlq } = detail;
  return (
    <div className="space-y-5">
      {report && report.byEntity.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">{t('monitor.detail.reconciliationTitle')}</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b text-left text-text-muted">
                <tr>
                  <th className="py-2 pr-3">{t('common.entity')}</th>
                  <th className="py-2 pr-3 text-right">{t('monitor.detail.colStaged')}</th>
                  <th className="py-2 pr-3 text-right">{t('monitor.detail.colValid')}</th>
                  <th className="py-2 pr-3 text-right">{t('monitor.detail.colLoaded')}</th>
                  <th className="py-2 pr-3 text-right">{t('monitor.detail.colSkipped')}</th>
                  <th className="py-2 pr-3 text-right">{t('monitor.detail.colFailed')}</th>
                </tr>
              </thead>
              <tbody>
                {report.byEntity.map((e) => (
                  <tr key={e.entityType} className="border-b">
                    <td className="py-1.5 pr-3 font-mono">{e.entityType}</td>
                    <td className="py-1.5 pr-3 text-right">{formatNumber(e.stagedCount)}</td>
                    <td className="py-1.5 pr-3 text-right">{formatNumber(e.validCount)}</td>
                    <td className="py-1.5 pr-3 text-right font-semibold text-success-700">
                      {formatNumber(e.loadedCount)}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-text-muted">
                      {formatNumber(e.skippedCount)}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-destructive">
                      {formatNumber(e.failedCount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t font-semibold">
                <tr>
                  <td className="py-2 pr-3">{t('monitor.detail.total')}</td>
                  <td className="py-2 pr-3 text-right">—</td>
                  <td className="py-2 pr-3 text-right">—</td>
                  <td className="py-2 pr-3 text-right text-success-700">
                    {formatNumber(report.totals.loadedCount)}
                  </td>
                  <td className="py-2 pr-3 text-right text-text-muted">
                    {formatNumber(report.totals.skippedCount)}
                  </td>
                  <td className="py-2 pr-3 text-right text-destructive">
                    {formatNumber(report.totals.failedCount)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          {report.auditChain.eventsCount > 0 && (
            <p className="text-xs text-text-muted">
              {t(
                report.auditChain.verified
                  ? 'monitor.detail.auditVerified'
                  : 'monitor.detail.auditUnverifiable',
                { count: report.auditChain.eventsCount },
              )}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-text-muted">{t('monitor.detail.noReconciliation')}</p>
      )}

      {dlq && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">
            {t('monitor.dlq.title')}{' '}
            {dlq.total > 0 && (
              <span className="text-text-muted font-normal">
                {t('monitor.dlq.count', { total: dlq.total, shown: dlq.items.length })}
              </span>
            )}
          </h4>
          {dlq.items.length === 0 ? (
            <p className="text-xs text-text-muted">{t('monitor.dlq.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b text-left text-text-muted">
                  <tr>
                    <th className="py-2 pr-3">{t('common.entity')}</th>
                    <th className="py-2 pr-3">{t('monitor.dlq.colSourceId')}</th>
                    <th className="py-2 pr-3">{t('monitor.dlq.colPhase')}</th>
                    <th className="py-2 pr-3">{t('monitor.dlq.colError')}</th>
                    <th className="py-2 pr-3">{t('monitor.dlq.colMessage')}</th>
                  </tr>
                </thead>
                <tbody>
                  {dlq.items.map((e: DlqEntry, idx: number) => (
                    <tr key={`${e.entityType}-${e.sourceId}-${idx}`} className="border-b align-top">
                      <td className="py-1.5 pr-3 font-mono">{e.entityType}</td>
                      <td className="py-1.5 pr-3 font-mono">{e.sourceId ?? '—'}</td>
                      <td className="py-1.5 pr-3">
                        <Badge variant="outline">{e.phase}</Badge>
                      </td>
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
