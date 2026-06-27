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
/// scope) den el mismo resultado.
const SCOPE_PRESETS: Record<
  ImportOptions['mode'],
  { label: string; help: string; scope: ImportOptions['scope'] }
> = {
  courses: {
    label: 'Solo cursos',
    help: 'Importa el contenido: cursos, lecciones, temas y quizzes. No crea usuarios ni matrículas.',
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
    label: 'Solo alumnos matriculados en cursos',
    help: 'Importa los alumnos con al menos una matrícula y sus inscripciones. Requiere que los cursos ya estén migrados (modo diferido).',
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
    label: 'Todo',
    help: 'Importa contenido + usuarios + matrículas. Es la opción completa.',
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
                (updated.status === 'cancelled' ? 'Job cancelado' : 'Job falló'),
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
      setError({ code: e?.code, message: e?.message ?? 'No se pudo crear el job' });
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
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setCreds({ ...creds, baseUrl: e.target.value })
                }
              />
            </div>
            <div>
              <Label htmlFor="ld-user">Usuario administrador</Label>
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
              <Label htmlFor="ld-app">Application Password</Label>
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
                Volver
              </Button>
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
                <tr>
                  <td>Cursos</td>
                  <td className="text-right font-mono">{String(preflight.counts.courses)}</td>
                </tr>
                <tr>
                  <td>Lecciones</td>
                  <td className="text-right font-mono">{String(preflight.counts.lessons)}</td>
                </tr>
                <tr>
                  <td>Temas</td>
                  <td className="text-right font-mono">{String(preflight.counts.topics)}</td>
                </tr>
                <tr>
                  <td>Quizzes</td>
                  <td className="text-right font-mono">{String(preflight.counts.quizzes)}</td>
                </tr>
                <tr>
                  <td>Grupos</td>
                  <td className="text-right font-mono">{String(preflight.counts.groups)}</td>
                </tr>
                <tr>
                  <td>Alumnos</td>
                  <td className="text-right font-mono">{String(preflight.counts.users)}</td>
                </tr>
              </tbody>
            </table>

            {preflight.samples && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">
                  Muestras de las últimas 5 entidades por tipo
                </h3>
                {(['courses', 'lessons', 'topics', 'quizzes', 'groups', 'users'] as const).map(
                  (key) => {
                    const items = preflight.samples?.[key] ?? [];
                    if (items.length === 0) return null;
                    return <SampleList key={key} label={LABELS[key]} items={items} />;
                  },
                )}
                <p className="text-xs text-muted-foreground">
                  Mostramos las 5 más recientes por tipo (incluye drafts, privadas y futuras
                  programadas). Para revisar todo en detalle, abre tu WordPress origen — la
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
                Volver
              </Button>
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
              <Label>¿Qué quieres migrar?</Label>
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
                      <span className="font-medium">{SCOPE_PRESETS[m].label}</span>
                      <span className="block text-muted-foreground">{SCOPE_PRESETS[m].help}</span>
                    </span>
                  </label>
                ))}
              </div>
              {options.mode === 'enrolled-students' && (
                <div className="mt-2">
                  <Alert>
                    <AlertTitle>Migra los cursos primero</AlertTitle>
                    <AlertDescription>
                      Este modo solo trae alumnos y matrículas. Las inscripciones se vinculan a los
                      cursos que ya existan en Didacta: si un curso aún no se ha migrado, esa
                      matrícula quedará registrada como incidencia en el informe. Lanza antes una
                      migración de “Solo cursos” (o “Todo”).
                    </AlertDescription>
                  </Alert>
                </div>
              )}
            </div>
            <div>
              <Label>Contraseñas</Label>
              <div className="space-y-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={options.passwordStrategy === 'activation_reset'}
                    onChange={() =>
                      setOptions({ ...options, passwordStrategy: 'activation_reset' })
                    }
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
            <Alert>
              <AlertTitle>Cómo va a funcionar</AlertTitle>
              <AlertDescription>
                Primero hacemos una <b>prueba</b>: importamos un curso de tu academia con hasta{' '}
                {SAMPLE_DEFAULTS.usersPerCourse} alumnos para que verifiques que todo se ve bien en
                Didacta. Si te convence, te preguntamos si seguir con la
                <b> integración completa</b>; el curso de la prueba no se vuelve a importar (se
                reutiliza lo ya cargado), solo añadimos lo que falta.
              </AlertDescription>
            </Alert>
            <div className="flex gap-2">
              <Button variant="outline" onClick={goBack}>
                Volver
              </Button>
              <Button onClick={() => void onStartJob(true)} disabled={busy}>
                {busy ? 'Iniciando...' : 'Empezar la prueba'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'sample-run' && job && (
        <RunningCard
          title="Importando muestra…"
          description="Estamos trayendo 1 curso aleatorio y hasta 5 alumnos para que verifiques el resultado."
          job={job}
          jobNotice={jobNotice}
        />
      )}

      {step === 'sample-done' && sampleReport && (
        <Card>
          <CardHeader>
            <CardTitle>Prueba completada</CardTitle>
            <CardDescription>Estos son los resultados de la muestra:</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-4 gap-4 text-center">
              <Stat label="Origen" value={sampleReport.totals.sourceCount} />
              <Stat label="Cargados" value={sampleReport.totals.loadedCount} />
              <Stat label="Saltados" value={sampleReport.totals.skippedCount} />
              <Stat label="Fallidos" value={sampleReport.totals.failedCount} />
            </div>
            {sampleReport.byEntity.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-semibold">Detalle por entidad</h3>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th>Entidad</th>
                      <th className="text-right">Origen</th>
                      <th className="text-right">Cargados</th>
                      <th className="text-right">Saltados</th>
                      <th className="text-right">Fallidos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sampleReport.byEntity.map((b) => (
                      <tr key={b.entityType}>
                        <td>{b.entityType}</td>
                        <td className="text-right font-mono">{b.sourceCount}</td>
                        <td className="text-right font-mono">{b.loadedCount}</td>
                        <td className="text-right font-mono">{b.skippedCount}</td>
                        <td className="text-right font-mono">{b.failedCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Alert>
              <AlertTitle>¿Quieres proceder con la integración completa?</AlertTitle>
              <AlertDescription>
                Importaremos el resto de cursos, alumnos y contenidos. El curso y alumnos de la
                muestra <b>no se duplican</b>: se conservan tal como están y solo se añade lo que
                falta. Esta operación puede tardar varios minutos según el tamaño de tu academia.
              </AlertDescription>
            </Alert>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep('done')}>
                Terminar aquí (conservo solo la muestra)
              </Button>
              <Button onClick={() => void onStartJob(false)} disabled={busy}>
                {busy ? 'Iniciando…' : 'Sí, hacer integración completa'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'complete-run' && job && (
        <RunningCard
          title="Importando integración completa…"
          description="Estamos trayendo el resto de tu academia. Puede tardar varios minutos."
          job={job}
          jobNotice={jobNotice}
        />
      )}

      {step === 'done' && (
        <Card>
          <CardHeader>
            <CardTitle>Migración finalizada</CardTitle>
            <CardDescription>
              {finalReport
                ? `Reporte completo (job ${finalReport.jobId})`
                : sampleReport
                  ? `Solo se importó la muestra (job ${sampleReport.jobId}). Puedes lanzar la integración completa más tarde desde el dashboard del módulo.`
                  : 'Sin reporte disponible.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {(finalReport ?? sampleReport) && (
              <>
                <div className="grid grid-cols-4 gap-4 text-center">
                  <Stat label="Origen" value={(finalReport ?? sampleReport)!.totals.sourceCount} />
                  <Stat
                    label="Cargados"
                    value={(finalReport ?? sampleReport)!.totals.loadedCount}
                  />
                  <Stat
                    label="Saltados"
                    value={(finalReport ?? sampleReport)!.totals.skippedCount}
                  />
                  <Stat
                    label="Fallidos"
                    value={(finalReport ?? sampleReport)!.totals.failedCount}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Cadena de auditoría: {(finalReport ?? sampleReport)!.auditChain.eventsCount}{' '}
                  eventos
                  {(finalReport ?? sampleReport)!.auditChain.verified
                    ? ' (✓ verificada)'
                    : ' (⚠ alterada)'}
                  .
                </p>
              </>
            )}
          </CardContent>
        </Card>
      )}
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
          <AlertTitle>Estado actual</AlertTitle>
          <AlertDescription>
            Job <code>{job.id}</code> · {job.status}
            {job.phase && (
              <>
                {' '}
                · fase <code>{phase}</code>
              </>
            )}
          </AlertDescription>
        </Alert>
        {jobNotice && <NoticeAlert notice={jobNotice} />}
        <p className="text-xs text-muted-foreground">
          Esta pantalla se actualiza automáticamente cada 3 segundos. Puedes cerrar el navegador: el
          job continúa en segundo plano y al volver verás el reporte en el dashboard del módulo.
        </p>
      </CardContent>
    </Card>
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
  const variant: 'default' | 'destructive' =
    notice.severity === 'error' ? 'destructive' : 'default';
  const icon = notice.severity === 'error' ? '⛔' : notice.severity === 'warning' ? '⚠️' : 'ℹ️';
  return (
    <Alert variant={variant}>
      <AlertTitle>
        {icon}{' '}
        {notice.severity === 'warning'
          ? 'Importante'
          : notice.severity === 'error'
            ? 'Error'
            : 'Info'}
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
  // Stepper visible: agrupamos sample-run/sample-done en "Prueba" y
  // complete-run/done en "Migración completa" para que el usuario vea
  // solo 6 hitos en lugar de los 8 internos.
  const visible: { keys: Step[]; label: string }[] = [
    { keys: ['welcome'], label: 'Inicio' },
    { keys: ['connect'], label: 'Conectar' },
    { keys: ['preflight'], label: 'Resumen' },
    { keys: ['options'], label: 'Opciones' },
    { keys: ['sample-run', 'sample-done'], label: 'Prueba' },
    { keys: ['complete-run', 'done'], label: 'Completa' },
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
          {i + 1}. {s.label}
        </li>
      ))}
    </ol>
  );
}
