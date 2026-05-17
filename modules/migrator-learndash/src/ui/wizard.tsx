/* eslint-disable @typescript-eslint/no-explicit-any */
/// Wizard multi-paso del migrador LearnDash.
/// alpha.60: movido a modules/migrator-learndash/src/ui/ desde apps/web/.
/// Imports SOLO desde `./_runtime` y `./client` (ADR-015).

import {
  React,
  useState,
  Card, CardContent, CardDescription, CardHeader, CardTitle,
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

// Alert component no existe en este repo; usamos divs estilados como en otros módulos.
function Alert({ children, variant = 'default' }: { children: React.ReactNode; variant?: 'default' | 'destructive' }): React.ReactElement {
  const cls =
    variant === 'destructive'
      ? 'rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive'
      : 'rounded-md border bg-muted/40 p-4 text-sm';
  return <div role="alert" className={cls}>{children}</div>;
}
function AlertTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="mb-1 font-semibold">{children}</div>;
}
function AlertDescription({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div>{children}</div>;
}

type Step = 'welcome' | 'connect' | 'preflight' | 'options' | 'dryrun' | 'execute' | 'done';

const DEFAULT_OPTIONS: ImportOptions = {
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
  dryRun: false,
  retentionDays: 30,
};

export function MigratorWizard(): React.ReactElement {
  const [step, setStep] = React.useState<Step>('welcome');
  const [creds, setCreds] = React.useState<SourceCredentials>({ baseUrl: '', username: '', appPassword: '' });
  const [preflight, setPreflight] = React.useState<PreflightResult | null>(null);
  const [jobNotice, setJobNotice] = React.useState<JobNotice | null>(null);
  const [options, setOptions] = React.useState<ImportOptions>(DEFAULT_OPTIONS);
  const [job, setJob] = React.useState<JobStatus | null>(null);
  const [report, setReport] = React.useState<JobReport | null>(null);
  const [error, setError] = React.useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  const goNext = (): void => {
    const order: Step[] = ['welcome', 'connect', 'preflight', 'options', 'dryrun', 'execute', 'done'];
    const idx = order.indexOf(step);
    if (idx >= 0 && idx < order.length - 1) setStep(order[idx + 1]!);
  };

  const goBack = (): void => {
    const order: Step[] = ['welcome', 'connect', 'preflight', 'options', 'dryrun', 'execute', 'done'];
    const idx = order.indexOf(step);
    if (idx > 0) setStep(order[idx - 1]!);
  };

  const onConnect = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const result = await migratorLearndashApi.preflight(creds);
      if (!result.ok) {
        setError({ code: result.error?.code, message: result.error?.message ?? 'Preflight falló' });
        return;
      }
      setPreflight(result);
      setStep('preflight');
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? 'Error de conexión' });
    } finally {
      setBusy(false);
    }
  };

  const onStartJob = async (dryRun: boolean): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const resp = await migratorLearndashApi.startJob(creds, { ...options, dryRun });
      const status = await migratorLearndashApi.getJob(resp.jobId);
      setJob(status);
      setJobNotice(resp.notice ?? null);
      setStep(dryRun ? 'dryrun' : 'execute');
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? 'No se pudo crear el job' });
    } finally {
      setBusy(false);
    }
  };

  const onFinalize = async (): Promise<void> => {
    if (!job) return;
    setBusy(true);
    try {
      const r = await migratorLearndashApi.getReport(job.id);
      setReport(r);
      setStep('done');
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? 'No se pudo cargar el reporte' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Stepper current={step} />

      {error && (
        <Alert variant="destructive">
          <AlertTitle>{error.code ?? 'Error'}</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {step === 'welcome' && (
        <Card>
          <CardHeader>
            <CardTitle>¿Listo para traer tu academia a Didacta?</CardTitle>
            <CardDescription>
              Te guiamos paso a paso. Necesitas un Application Password de tu WordPress (te
              enseñamos cómo crearlo) y unos minutos. Tu sitio actual no se modifica.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="list-disc pl-6 text-sm">
              <li>Acceso de administrador a tu WordPress con LearnDash.</li>
              <li>Application Password (no la contraseña normal).</li>
              <li>Sitio accesible públicamente (HTTPS).</li>
            </ul>
            <Button onClick={goNext}>Comenzar</Button>
          </CardContent>
        </Card>
      )}

      {step === 'connect' && (
        <Card>
          <CardHeader>
            <CardTitle>Conectar con tu WordPress</CardTitle>
            <CardDescription>URL del sitio + Application Password.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="ld-url">URL de tu WordPress</Label>
              <Input
                id="ld-url"
                type="url"
                placeholder="https://miacademia.com"
                value={creds.baseUrl}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCreds({ ...creds, baseUrl: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="ld-user">Usuario administrador</Label>
              <Input
                id="ld-user"
                placeholder="admin"
                value={creds.username}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCreds({ ...creds, username: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="ld-app">Application Password</Label>
              <Input
                id="ld-app"
                type="password"
                placeholder="abcd EFGH ijkl MNOP"
                value={creds.appPassword}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCreds({ ...creds, appPassword: e.target.value })}
                autoComplete="off"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={goBack}>Volver</Button>
              <Button onClick={() => void onConnect()} disabled={busy}>
                {busy ? 'Comprobando...' : 'Comprobar y continuar'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'preflight' && preflight && (
        <Card>
          <CardHeader>
            <CardTitle>Esto es lo que vamos a migrar</CardTitle>
            <CardDescription>
              {preflight.siteName ?? 'Origen'}
              {preflight.wpVersion ? ` · WP ${preflight.wpVersion}` : ''}
              {' · '}latencia {preflight.latencyMs} ms
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <table className="w-full text-sm">
              <tbody>
                <tr><td>Cursos</td><td className="text-right font-mono">{String(preflight.counts.courses)}</td></tr>
                <tr><td>Lecciones</td><td className="text-right font-mono">{String(preflight.counts.lessons)}</td></tr>
                <tr><td>Temas</td><td className="text-right font-mono">{String(preflight.counts.topics)}</td></tr>
                <tr><td>Quizzes</td><td className="text-right font-mono">{String(preflight.counts.quizzes)}</td></tr>
                <tr><td>Grupos</td><td className="text-right font-mono">{String(preflight.counts.groups)}</td></tr>
                <tr><td>Alumnos</td><td className="text-right font-mono">{String(preflight.counts.users)}</td></tr>
              </tbody>
            </table>

            {preflight.samples && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Muestras de las últimas 5 entidades por tipo</h3>
                {(['courses', 'lessons', 'topics', 'quizzes', 'groups', 'users'] as const).map((key) => {
                  const items = preflight.samples?.[key] ?? [];
                  if (items.length === 0) return null;
                  return (
                    <SampleList
                      key={key}
                      label={LABELS[key]}
                      items={items}
                    />
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  Mostramos las 5 más recientes por tipo (incluye drafts, privadas y futuras
                  programadas). Para revisar todo en detalle, abrí tu WordPress origen — la
                  migración traerá lo que coincida con las opciones que elijas en el siguiente paso.
                </p>
              </div>
            )}

            {preflight.warnings.length > 0 && (
              <Alert>
                <AlertTitle>Avisos del origen</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-6">
                    {preflight.warnings.map((w, i) => (
                      <li key={i}><code>{w.code}</code>: {w.message}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={goBack}>Volver</Button>
              <Button onClick={goNext}>Continuar</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'options' && (
        <Card>
          <CardHeader>
            <CardTitle>¿Cómo quieres hacer la migración?</CardTitle>
            <CardDescription>Los valores por defecto son los más seguros.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Contraseñas</Label>
              <div className="space-y-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={options.passwordStrategy === 'activation_reset'}
                    onChange={() => setOptions({ ...options, passwordStrategy: 'activation_reset' })}
                  />
                  Enviar email de activación (recomendado)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={options.passwordStrategy === 'preserve_hash'}
                    onChange={() => setOptions({ ...options, passwordStrategy: 'preserve_hash' })}
                  />
                  Conservar contraseña original (avanzado)
                </label>
              </div>
            </div>
            <div>
              <Label>Imágenes</Label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={options.copyMediaBinaries}
                  onChange={(e) => setOptions({ ...options, copyMediaBinaries: e.target.checked })}
                />
                Copiar imágenes a Didacta (recomendado)
              </label>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={goBack}>Volver</Button>
              <Button onClick={goNext}>Continuar</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'dryrun' && (
        <Card>
          <CardHeader>
            <CardTitle>Comprobación previa (sin tocar nada)</CardTitle>
            <CardDescription>Hacemos una prueba SIN escribir en Didacta.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!job && (
              <Button onClick={() => void onStartJob(true)} disabled={busy}>
                {busy ? 'Iniciando...' : 'Empezar la prueba'}
              </Button>
            )}
            {job && (
              <>
                <Alert>
                  <AlertTitle>Job creado</AlertTitle>
                  <AlertDescription>
                    ID: <code>{job.id}</code> · estado: {job.status}
                  </AlertDescription>
                </Alert>
                {jobNotice && <NoticeAlert notice={jobNotice} />}
              </>
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={goBack}>Ajustar opciones</Button>
              <Button onClick={() => void onStartJob(false)} disabled={busy}>
                Sí, ejecutar la migración real
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'execute' && job && (
        <Card>
          <CardHeader>
            <CardTitle>Migrando...</CardTitle>
            <CardDescription>
              Job <code>{job.id}</code> · estado: {job.status}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {jobNotice ? (
              <NoticeAlert notice={jobNotice} />
            ) : (
              <Alert>
                <AlertTitle>Esperando al worker</AlertTitle>
                <AlertDescription>
                  El job se creó correctamente. El procesamiento real comenzará cuando el
                  worker tome la cola.
                </AlertDescription>
              </Alert>
            )}
            <div className="flex gap-2">
              <Button onClick={() => void onFinalize()} disabled={busy}>
                Ver reporte
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'done' && report && (
        <Card>
          <CardHeader>
            <CardTitle>Resultado de la migración</CardTitle>
            <CardDescription>Job {report.jobId}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-4 gap-4 text-center">
              <Stat label="Origen" value={report.totals.sourceCount} />
              <Stat label="Cargados" value={report.totals.loadedCount} />
              <Stat label="Saltados" value={report.totals.skippedCount} />
              <Stat label="Fallidos" value={report.totals.failedCount} />
            </div>
            <p className="text-xs text-muted-foreground">
              Cadena de auditoría: {report.auditChain.eventsCount} eventos
              {report.auditChain.verified ? ' (✓ verificada)' : ' (⚠ alterada)'}.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const LABELS: Record<'courses' | 'lessons' | 'topics' | 'quizzes' | 'groups' | 'users', string> = {
  courses: 'Cursos',
  lessons: 'Lecciones',
  topics: 'Temas',
  quizzes: 'Quizzes',
  groups: 'Grupos',
  users: 'Alumnos',
};

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
              {it.title || `(sin título · id=${it.id})`}
            </span>
            {it.modified && (
              <span className="text-xs text-muted-foreground" title={it.modified}>
                {it.modified.slice(0, 10)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function NoticeAlert({ notice }: { notice: JobNotice }): React.ReactElement {
  const variant: 'default' | 'destructive' = notice.severity === 'error' ? 'destructive' : 'default';
  const icon = notice.severity === 'error' ? '⛔' : notice.severity === 'warning' ? '⚠️' : 'ℹ️';
  return (
    <Alert variant={variant}>
      <AlertTitle>
        {icon} {notice.severity === 'warning' ? 'Importante' : notice.severity === 'error' ? 'Error' : 'Info'}
      </AlertTitle>
      <AlertDescription>{notice.message}</AlertDescription>
    </Alert>
  );
}

function Stat({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <div className="rounded-md border p-3">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Stepper({ current }: { current: Step }): React.ReactElement {
  const steps: { key: Step; label: string }[] = [
    { key: 'welcome', label: 'Inicio' },
    { key: 'connect', label: 'Conectar' },
    { key: 'preflight', label: 'Resumen' },
    { key: 'options', label: 'Opciones' },
    { key: 'dryrun', label: 'Comprobación' },
    { key: 'execute', label: 'Migrar' },
    { key: 'done', label: 'Resultado' },
  ];
  const idx = steps.findIndex((s) => s.key === current);
  return (
    <ol className="flex items-center gap-2 text-xs">
      {steps.map((s, i) => (
        <li
          key={s.key}
          className={
            i === idx
              ? 'rounded-full bg-primary px-2 py-1 text-primary-foreground'
              : i < idx
                ? 'rounded-full bg-muted px-2 py-1 text-muted-foreground'
                : 'rounded-full border px-2 py-1 text-muted-foreground'
          }
        >
          {i + 1}. {s.label}
        </li>
      ))}
    </ol>
  );
}
