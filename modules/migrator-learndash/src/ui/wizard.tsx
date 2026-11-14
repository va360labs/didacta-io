/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/// Wizard multi-paso del migrador LearnDash.
///
/// Flujo (v1.0.30):
///   welcome → connect → preflight → options
///     → sample-run       (importa un curso aleatorio + 5 alumnos)
///     → sample-done      (cifras del sample + confirmación)
///     → complete-run     (importa el resto, idempotente)
///     → done             (reporte final)
///
/// El paso "sample" reemplaza al dry-run de versiones anteriores: ahora la
/// prueba SÍ escribe en Didacta, pero solo un curso y unos alumnos, así el
/// admin puede verificar de un vistazo si el mapping y permisos son correctos
/// antes de comprometerse al volumen completo. El loader es idempotente por
/// sourceId, por lo que la integración completa NO duplica el sample —
/// hace upsert sobre lo ya cargado y añade el resto.

import {
  React,
  useState,
  useEffect,
  useRef,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Input,
  Label,
} from './_runtime';
import {
  migratorLearndashApi,
  type ImportOptions,
  type JobNotice,
  type JobReport,
  type JobStatus,
  type PreflightResult,
  type PreflightSample,
  type SourceCredentials,
} from './client';
import { formatDay, formatNumber, t, type MessageKey } from './i18n';
import { tRich } from './i18n-rich';

function Alert({
  children,
  variant = 'default',
}: {
  children: React.ReactNode;
  variant?: 'default' | 'destructive';
}): React.ReactElement {
  const cls =
    variant === 'destructive'
      ? 'rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive'
      : 'rounded-md border bg-muted/40 p-4 text-sm';
  return (
    <div role="alert" className={cls}>
      {children}
    </div>
  );
}
function AlertTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="mb-1 font-semibold">{children}</div>;
}
function AlertDescription({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div>{children}</div>;
}

type Step =
  | 'welcome'
  | 'connect'
  | 'preflight'
  | 'options'
  | 'sample-run'
  | 'sample-done'
  | 'complete-run'
  | 'done';

const SAMPLE_DEFAULTS = { courses: 1, usersPerCourse: 5 } as const;

const DEFAULT_OPTIONS: ImportOptions = {
  mode: 'all',
  dedupeUsersBy: ['email'],
  passwordStrategy: 'activation_reset',
  copyMediaBinaries: true,
  preserveAttemptHistory: false,
  groupModelHint: 'cohort',
  scope: {
    courses: true,
    users: true,
    groups: true,
    enrollments: true,
    progress: true,
    media: true,
    quizzes: true,
  },
  retentionDays: 30,
};

/// Presets de "qué migrar" (v1.1.0+). Al elegir un modo, seteamos a la vez el
/// `mode` (que el backend lee directo) y los booleanos de `scope` coherentes,
/// para que ambos caminos de lectura del backend (mode explícito o derivar de
/// scope) den el mismo resultado. Rótulo y ayuda son CLAVES del diccionario
/// (`i18n.ts`): se traducen al pintar, no al cargar el bundle.
const SCOPE_PRESETS: Record<
  ImportOptions['mode'],
  { label: MessageKey; help: MessageKey; scope: ImportOptions['scope'] }
> = {
  courses: {
    label: 'wizard.scope.courses.label',
    help: 'wizard.scope.courses.help',
    scope: {
      courses: true,
      quizzes: true,
      users: false,
      groups: false,
      enrollments: false,
      progress: false,
      media: true,
    },
  },
  'enrolled-students': {
    label: 'wizard.scope.enrolledStudents.label',
    help: 'wizard.scope.enrolledStudents.help',
    scope: {
      courses: false,
      quizzes: false,
      users: true,
      groups: false,
      enrollments: true,
      progress: false,
      media: false,
    },
  },
  all: {
    label: 'wizard.scope.all.label',
    help: 'wizard.scope.all.help',
    scope: {
      courses: true,
      quizzes: true,
      users: true,
      groups: true,
      enrollments: true,
      progress: true,
      media: true,
    },
  },
};

const POLL_INTERVAL_MS = 3000;
const TERMINAL_STATUSES: ReadonlyArray<JobStatus['status']> = ['completed', 'failed', 'cancelled'];

export function MigratorWizard(): React.ReactElement {
  const [step, setStep] = React.useState<Step>('welcome');
  const [creds, setCreds] = React.useState<SourceCredentials>({
    baseUrl: '',
    username: '',
    appPassword: '',
  });
  const [preflight, setPreflight] = React.useState<PreflightResult | null>(null);
  const [jobNotice, setJobNotice] = React.useState<JobNotice | null>(null);
  const [options, setOptions] = React.useState<ImportOptions>(DEFAULT_OPTIONS);
  const [job, setJob] = React.useState<JobStatus | null>(null);
  const [sampleReport, setSampleReport] = React.useState<JobReport | null>(null);
  const [finalReport, setFinalReport] = React.useState<JobReport | null>(null);
  const [error, setError] = React.useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Auto-polling del job status mientras estamos en *-run. Se limpia al
  // cambiar de step o al desmontar. Cuando llega a estado terminal,
  // dispara la transición correspondiente.
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const isRunningStep = step === 'sample-run' || step === 'complete-run';
    if (!isRunningStep || !job) return;

    const tick = async (): Promise<void> => {
      try {
        const updated = await migratorLearndashApi.getJob(job.id);
        setJob(updated);
        if (TERMINAL_STATUSES.includes(updated.status)) {
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
          if (updated.status === 'completed') {
            const report = await migratorLearndashApi.getReport(updated.id);
            if (step === 'sample-run') {
              setSampleReport(report);
              setStep('sample-done');
            } else if (step === 'complete-run') {
              setFinalReport(report);
              setStep('done');
            }
          } else {
            setError({
              code: updated.error?.code,
              message:
                updated.error?.message ??
                (updated.status === 'cancelled'
                  ? t('wizard.error.jobCancelled')
                  : t('wizard.error.jobFailed')),
            });
          }
        }
      } catch (e: any) {
        // Errores transitorios del polling no rompen el flow; se reintenta.
        // Errores permanentes se manifiestan vía status del job.
      }
    };

    void tick();
    pollingRef.current = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [step, job?.id]);

  const goNext = (): void => {
    const order: Step[] = ['welcome', 'connect', 'preflight', 'options'];
    const idx = order.indexOf(step);
    if (idx >= 0 && idx < order.length - 1) setStep(order[idx + 1]!);
  };

  const goBack = (): void => {
    const order: Step[] = ['welcome', 'connect', 'preflight', 'options'];
    const idx = order.indexOf(step);
    if (idx > 0) setStep(order[idx - 1]!);
  };

  const onConnect = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const result = await migratorLearndashApi.preflight(creds);
      if (!result.ok) {
        setError({
          code: result.error?.code,
          message: result.error?.message ?? t('wizard.error.preflightFailed'),
        });
        return;
      }
      setPreflight(result);
      setStep('preflight');
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? t('wizard.error.connection') });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Arranca un job. `sampleMode=true` enciende el extractor-sample del
   * backend: 1 curso aleatorio (con alumnos) + 5 alumnos del curso + jerarquía.
   * `sampleMode=false` lanza el import completo según `options.scope`.
   */
  const onStartJob = async (sampleMode: boolean): Promise<void> => {
    setError(null);
    setBusy(true);
    setJob(null);
    setJobNotice(null);
    try {
      const optionsToSend: ImportOptions = sampleMode
        ? { ...options, sample: { ...SAMPLE_DEFAULTS } }
        : { ...options, sample: undefined };
      const resp = await migratorLearndashApi.startJob(creds, optionsToSend);
      const status = await migratorLearndashApi.getJob(resp.jobId);
      setJob(status);
      setJobNotice(resp.notice ?? null);
      setStep(sampleMode ? 'sample-run' : 'complete-run');
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? t('wizard.error.createJob') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Stepper current={step} />

      {error && (
        <Alert variant="destructive">
          <AlertTitle>{error.code ?? t('common.error')}</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {step === 'welcome' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('wizard.welcome.title')}</CardTitle>
            <CardDescription>{t('wizard.welcome.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="list-disc pl-6 text-sm">
              <li>{t('wizard.welcome.reqAdmin')}</li>
              <li>{t('wizard.welcome.reqAppPassword')}</li>
              <li>{t('wizard.welcome.reqPublic')}</li>
            </ul>
            <Button onClick={goNext}>{t('wizard.welcome.start')}</Button>
          </CardContent>
        </Card>
      )}

      {step === 'connect' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('wizard.connect.title')}</CardTitle>
            <CardDescription>{t('wizard.connect.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="ld-url">{t('wizard.connect.urlLabel')}</Label>
              <Input
                id="ld-url"
                type="url"
                placeholder={t('wizard.connect.urlPlaceholder')}
                value={creds.baseUrl}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setCreds({ ...creds, baseUrl: e.target.value })
                }
              />
            </div>
            <div>
              <Label htmlFor="ld-user">{t('wizard.connect.userLabel')}</Label>
              <Input
                id="ld-user"
                placeholder="admin"
                value={creds.username}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setCreds({ ...creds, username: e.target.value })
                }
              />
            </div>
            <div>
              <Label htmlFor="ld-app">{t('wizard.connect.appPasswordLabel')}</Label>
              <Input
                id="ld-app"
                type="password"
                placeholder="abcd EFGH ijkl MNOP"
                value={creds.appPassword}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setCreds({ ...creds, appPassword: e.target.value })
                }
                autoComplete="off"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={goBack}>
                {t('common.back')}
              </Button>
              <Button onClick={() => void onConnect()} disabled={busy}>
                {busy ? t('wizard.connect.checking') : t('wizard.connect.submit')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'preflight' && preflight && (
        <Card>
          <CardHeader>
            <CardTitle>{t('wizard.preflight.title')}</CardTitle>
            <CardDescription>
              {preflight.siteName ?? t('wizard.preflight.sourceFallback')}
              {preflight.wpVersion ? ` · WP ${preflight.wpVersion}` : ''}
              {' · '}
              {t('wizard.preflight.latency', { ms: preflight.latencyMs })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <table className="w-full text-sm">
              <tbody>
                {ENTITY_KEYS.map((key) => (
                  <tr key={key}>
                    <td>{t(LABELS[key])}</td>
                    <td className="text-right font-mono">{formatCount(preflight.counts[key])}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {preflight.samples && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">{t('wizard.preflight.samplesTitle')}</h3>
                {ENTITY_KEYS.map((key) => {
                  const items = preflight.samples?.[key] ?? [];
                  if (items.length === 0) return null;
                  return <SampleList key={key} label={t(LABELS[key])} items={items} />;
                })}
                <p className="text-xs text-muted-foreground">{t('wizard.preflight.samplesNote')}</p>
              </div>
            )}

            {preflight.warnings.length > 0 && (
              <Alert>
                <AlertTitle>{t('wizard.preflight.warningsTitle')}</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-6">
                    {preflight.warnings.map((w, i) => (
                      <li key={i}>
                        <code>{w.code}</code>: {w.message}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={goBack}>
                {t('common.back')}
              </Button>
              <Button onClick={goNext}>{t('common.continue')}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'options' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('wizard.options.title')}</CardTitle>
            <CardDescription>{t('wizard.options.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>{t('wizard.options.whatLabel')}</Label>
              <div className="space-y-1">
                {(['courses', 'enrolled-students', 'all'] as const).map((m) => (
                  <label key={m} className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name="migration-mode"
                      className="mt-1"
                      checked={options.mode === m}
                      onChange={() =>
                        setOptions({ ...options, mode: m, scope: SCOPE_PRESETS[m].scope })
                      }
                    />
                    <span>
                      <span className="font-medium">{t(SCOPE_PRESETS[m].label)}</span>
                      <span className="block text-muted-foreground">
                        {t(SCOPE_PRESETS[m].help)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {options.mode === 'enrolled-students' && (
                <div className="mt-2">
                  <Alert>
                    <AlertTitle>{t('wizard.options.coursesFirstTitle')}</AlertTitle>
                    <AlertDescription>
                      {t('wizard.options.coursesFirstBody', {
                        coursesOnly: t(SCOPE_PRESETS.courses.label),
                        everything: t(SCOPE_PRESETS.all.label),
                      })}
                    </AlertDescription>
                  </Alert>
                </div>
              )}
            </div>
            <div>
              <Label>{t('wizard.options.passwordsLabel')}</Label>
              <div className="space-y-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={options.passwordStrategy === 'activation_reset'}
                    onChange={() =>
                      setOptions({ ...options, passwordStrategy: 'activation_reset' })
                    }
                  />
                  {t('wizard.options.passwordActivation')}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={options.passwordStrategy === 'preserve_hash'}
                    onChange={() => setOptions({ ...options, passwordStrategy: 'preserve_hash' })}
                  />
                  {t('wizard.options.passwordPreserve')}
                </label>
              </div>
            </div>
            <div>
              <Label>{t('wizard.options.imagesLabel')}</Label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={options.copyMediaBinaries}
                  onChange={(e) => setOptions({ ...options, copyMediaBinaries: e.target.checked })}
                />
                {t('wizard.options.copyImages')}
              </label>
            </div>
            <Alert>
              <AlertTitle>{t('wizard.options.howTitle')}</AlertTitle>
              <AlertDescription>
                {tRich('wizard.options.howBody', { users: SAMPLE_DEFAULTS.usersPerCourse })}
              </AlertDescription>
            </Alert>
            <div className="flex gap-2">
              <Button variant="outline" onClick={goBack}>
                {t('common.back')}
              </Button>
              <Button onClick={() => void onStartJob(true)} disabled={busy}>
                {busy ? t('wizard.options.starting') : t('wizard.options.startSample')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'sample-run' && job && (
        <RunningCard
          title={t('wizard.sampleRun.title')}
          description={t('wizard.sampleRun.description', {
            courses: SAMPLE_DEFAULTS.courses,
            users: SAMPLE_DEFAULTS.usersPerCourse,
          })}
          job={job}
          jobNotice={jobNotice}
        />
      )}

      {step === 'sample-done' && sampleReport && (
        <Card>
          <CardHeader>
            <CardTitle>{t('wizard.sampleDone.title')}</CardTitle>
            <CardDescription>{t('wizard.sampleDone.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ReportTotals report={sampleReport} />
            {sampleReport.byEntity.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-semibold">
                  {t('wizard.sampleDone.byEntityTitle')}
                </h3>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th>{t('common.entity')}</th>
                      <th className="text-right">{t('wizard.stats.source')}</th>
                      <th className="text-right">{t('wizard.stats.loaded')}</th>
                      <th className="text-right">{t('wizard.stats.skipped')}</th>
                      <th className="text-right">{t('wizard.stats.failed')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sampleReport.byEntity.map((b) => (
                      <tr key={b.entityType}>
                        <td>{b.entityType}</td>
                        <td className="text-right font-mono">{formatNumber(b.sourceCount)}</td>
                        <td className="text-right font-mono">{formatNumber(b.loadedCount)}</td>
                        <td className="text-right font-mono">{formatNumber(b.skippedCount)}</td>
                        <td className="text-right font-mono">{formatNumber(b.failedCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Alert>
              <AlertTitle>{t('wizard.sampleDone.proceedTitle')}</AlertTitle>
              <AlertDescription>{tRich('wizard.sampleDone.proceedBody')}</AlertDescription>
            </Alert>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep('done')}>
                {t('wizard.sampleDone.stopHere')}
              </Button>
              <Button onClick={() => void onStartJob(false)} disabled={busy}>
                {busy ? t('wizard.sampleDone.starting') : t('wizard.sampleDone.proceed')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'complete-run' && job && (
        <RunningCard
          title={t('wizard.completeRun.title')}
          description={t('wizard.completeRun.description')}
          job={job}
          jobNotice={jobNotice}
        />
      )}

      {step === 'done' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('wizard.done.title')}</CardTitle>
            <CardDescription>
              {finalReport
                ? t('wizard.done.fullReport', { jobId: finalReport.jobId })
                : sampleReport
                  ? t('wizard.done.sampleOnly', { jobId: sampleReport.jobId })
                  : t('wizard.done.noReport')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {(finalReport ?? sampleReport) && (
              <>
                <ReportTotals report={(finalReport ?? sampleReport)!} />
                <p className="text-xs text-muted-foreground">
                  {t(
                    (finalReport ?? sampleReport)!.auditChain.verified
                      ? 'wizard.done.auditVerified'
                      : 'wizard.done.auditAltered',
                    { count: (finalReport ?? sampleReport)!.auditChain.eventsCount },
                  )}
                </p>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/// Las cuatro cifras de un reporte (origen / cargados / saltados / fallidos).
function ReportTotals({ report }: { report: JobReport }): React.ReactElement {
  return (
    <div className="grid grid-cols-4 gap-4 text-center">
      <Stat label={t('wizard.stats.source')} value={report.totals.sourceCount} />
      <Stat label={t('wizard.stats.loaded')} value={report.totals.loadedCount} />
      <Stat label={t('wizard.stats.skipped')} value={report.totals.skippedCount} />
      <Stat label={t('wizard.stats.failed')} value={report.totals.failedCount} />
    </div>
  );
}

function RunningCard({
  title,
  description,
  job,
  jobNotice,
}: {
  title: string;
  description: string;
  job: JobStatus;
  jobNotice: JobNotice | null;
}): React.ReactElement {
  const phase = job.phase ?? job.status;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTitle>{t('wizard.running.statusTitle')}</AlertTitle>
          <AlertDescription>
            {job.phase
              ? tRich('wizard.running.statusWithPhase', {
                  jobId: job.id,
                  status: job.status,
                  phase,
                })
              : tRich('wizard.running.status', { jobId: job.id, status: job.status })}
          </AlertDescription>
        </Alert>
        {jobNotice && <NoticeAlert notice={jobNotice} />}
        <p className="text-xs text-muted-foreground">
          {t('wizard.running.autoRefresh', { seconds: POLL_INTERVAL_MS / 1000 })}
        </p>
      </CardContent>
    </Card>
  );
}

const ENTITY_KEYS = ['courses', 'lessons', 'topics', 'quizzes', 'groups', 'users'] as const;

const LABELS: Record<(typeof ENTITY_KEYS)[number], MessageKey> = {
  courses: 'entity.courses',
  lessons: 'entity.lessons',
  topics: 'entity.topics',
  quizzes: 'entity.quizzes',
  groups: 'entity.groups',
  users: 'entity.users',
};

/// Cifra del preflight: `'unknown'` (WP no mandó `X-WP-Total`) se pinta tal cual.
function formatCount(value: number | 'unknown'): string {
  return typeof value === 'number' ? formatNumber(value) : value;
}

const STATUS_BADGE: Record<string, string> = {
  publish: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  draft: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  private: 'bg-slate-500/10 text-slate-700 dark:text-slate-400',
  future: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  pending: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  user: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
};

function SampleList({
  label,
  items,
}: {
  label: string;
  items: PreflightSample[];
}): React.ReactElement {
  return (
    <details className="rounded-md border bg-muted/20 px-3 py-2 text-sm">
      <summary className="cursor-pointer select-none font-medium">
        {label} <span className="text-muted-foreground">({items.length})</span>
      </summary>
      <ul className="mt-2 space-y-1">
        {items.map((it) => (
          <li key={it.id} className="flex items-baseline gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_BADGE[it.status] ?? 'bg-muted text-muted-foreground'}`}
            >
              {it.status}
            </span>
            <span className="flex-1 truncate" title={it.slug}>
              {it.title || t('wizard.preflight.untitled', { id: it.id })}
            </span>
            {it.modified && (
              <span className="text-xs text-muted-foreground" title={it.modified}>
                {formatDay(it.modified)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function NoticeAlert({ notice }: { notice: JobNotice }): React.ReactElement {
  const variant: 'default' | 'destructive' =
    notice.severity === 'error' ? 'destructive' : 'default';
  const icon = notice.severity === 'error' ? '⛔' : notice.severity === 'warning' ? '⚠️' : 'ℹ️';
  return (
    <Alert variant={variant}>
      <AlertTitle>
        {icon}{' '}
        {notice.severity === 'warning'
          ? t('wizard.notice.warning')
          : notice.severity === 'error'
            ? t('wizard.notice.error')
            : t('wizard.notice.info')}
      </AlertTitle>
      <AlertDescription>{notice.message}</AlertDescription>
    </Alert>
  );
}

function Stat({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <div className="rounded-md border p-3">
      <div className="text-2xl font-semibold">{formatNumber(value)}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Stepper({ current }: { current: Step }): React.ReactElement {
  // Stepper visible: agrupamos sample-run/sample-done en "Prueba" y
  // complete-run/done en "Migración completa" para que el usuario vea
  // solo 6 hitos en lugar de los 8 internos.
  const visible: { keys: Step[]; label: MessageKey }[] = [
    { keys: ['welcome'], label: 'wizard.stepper.welcome' },
    { keys: ['connect'], label: 'wizard.stepper.connect' },
    { keys: ['preflight'], label: 'wizard.stepper.preflight' },
    { keys: ['options'], label: 'wizard.stepper.options' },
    { keys: ['sample-run', 'sample-done'], label: 'wizard.stepper.sample' },
    { keys: ['complete-run', 'done'], label: 'wizard.stepper.complete' },
  ];
  const idx = visible.findIndex((s) => s.keys.includes(current));
  return (
    <ol className="flex items-center gap-2 text-xs">
      {visible.map((s, i) => (
        <li
          key={s.label}
          className={
            i === idx
              ? 'rounded-full bg-primary px-2 py-1 text-primary-foreground'
              : i < idx
                ? 'rounded-full bg-muted px-2 py-1 text-muted-foreground'
                : 'rounded-full border px-2 py-1 text-muted-foreground'
          }
        >
          {i + 1}. {t(s.label)}
        </li>
      ))}
    </ol>
  );
}
