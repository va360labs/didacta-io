/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Steps individuales del wizard. Implementación minimalista — el host
 * los enriquece con shadcn/ui en su entorno. Aquí dejamos JSX semántico
 * y accesible; el styling viene de tokens del host.
 */
import * as React from 'react';
import type {
  ImportOptionsDto,
  JobReportDto,
  PreflightResultDto,
  ProgressEventDto,
  SourceCredentialsDto,
} from '../../../src/dto.js';
import { WIZARD_COPY, copyForError } from '../../lib/copy.js';

// ===== Welcome =======================================================

export function WelcomeStep({ onContinue }: { onContinue: () => void }): JSX.Element {
  const c = WIZARD_COPY.steps.welcome;
  return (
    <section aria-labelledby="welcome-title">
      <h1 id="welcome-title">{c.heading}</h1>
      <p className="lead">{c.lead}</p>
      <ul className="checklist">
        {c.checklist.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <button type="button" onClick={onContinue} className="primary">
        {c.cta}
      </button>
    </section>
  );
}

// ===== Connect =======================================================

export function ConnectStep({
  initial,
  error,
  onSubmit,
  onBack,
}: {
  initial?: SourceCredentialsDto;
  error?: { code: string; message: string };
  onSubmit: (creds: SourceCredentialsDto) => Promise<void>;
  onBack: () => void;
}): JSX.Element {
  const [baseUrl, setBaseUrl] = React.useState(initial?.baseUrl ?? '');
  const [username, setUsername] = React.useState(initial?.username ?? '');
  const [appPassword, setAppPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const c = WIZARD_COPY.steps.connect;
  const errCopy = error ? copyForError(error.code) : undefined;

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onSubmit({ baseUrl: baseUrl.trim(), username: username.trim(), appPassword });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="connect-title">
      <h1 id="connect-title">{c.heading}</h1>
      <p className="lead">{c.lead}</p>
      {errCopy && (
        <div role="alert" className="alert alert-destructive">
          <strong>{errCopy.title}</strong>
          <p>{errCopy.body}</p>
          {'ctaHref' in errCopy && errCopy.ctaHref ? (
            <a href={errCopy.ctaHref}>{errCopy.ctaLabel}</a>
          ) : null}
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <div className="form-row">
          <label htmlFor="baseUrl">{c.fields.sourceUrl.label}</label>
          <input
            id="baseUrl"
            type="url"
            required
            placeholder={c.fields.sourceUrl.placeholder}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <small>{c.fields.sourceUrl.help}</small>
        </div>
        <div className="form-row">
          <label htmlFor="username">{c.fields.username.label}</label>
          <input
            id="username"
            required
            placeholder={c.fields.username.placeholder}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <small>{c.fields.username.help}</small>
        </div>
        <div className="form-row">
          <label htmlFor="appPassword">{c.fields.appPassword.label}</label>
          <input
            id="appPassword"
            type="password"
            required
            minLength={8}
            placeholder={c.fields.appPassword.placeholder}
            value={appPassword}
            onChange={(e) => setAppPassword(e.target.value)}
            autoComplete="off"
          />
          <small>
            {c.fields.appPassword.help} <a href={c.tipsLink.href}>{c.tipsLink.label}</a>
          </small>
        </div>
        <div className="form-actions">
          <button type="button" onClick={onBack} className="secondary">
            Volver
          </button>
          <button type="submit" disabled={submitting} className="primary">
            {submitting ? c.verifying : c.cta}
          </button>
        </div>
      </form>
    </section>
  );
}

// ===== Preflight =====================================================

export function PreflightStep({
  preflight,
  onContinue,
  onBack,
}: {
  preflight: PreflightResultDto;
  onContinue: () => void;
  onBack: () => void;
}): JSX.Element {
  const c = WIZARD_COPY.steps.preflight;
  return (
    <section aria-labelledby="preflight-title">
      <h1 id="preflight-title">{c.title}</h1>
      <p className="lead">{c.lead}</p>
      {preflight.siteName && (
        <p>
          <strong>Sitio detectado:</strong> {preflight.siteName}
        </p>
      )}
      <table className="counts-table">
        <thead>
          <tr>
            <th>Tipo</th>
            <th>Cantidad</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>Cursos</td><td>{preflight.counts.courses}</td></tr>
          <tr><td>Lecciones</td><td>{preflight.counts.lessons}</td></tr>
          <tr><td>Temas</td><td>{preflight.counts.topics}</td></tr>
          <tr><td>Quizzes</td><td>{preflight.counts.quizzes}</td></tr>
          <tr><td>Grupos</td><td>{preflight.counts.groups}</td></tr>
          <tr><td>Alumnos</td><td>{preflight.counts.users}</td></tr>
          <tr><td>Imágenes</td><td>{preflight.counts.media}</td></tr>
        </tbody>
      </table>
      {preflight.warnings.length > 0 && (
        <div className="warnings">
          <h2>{c.warningsTitle}</h2>
          <ul>
            {preflight.warnings.map((w) => (
              <li key={w.code}>
                <code>{w.code}</code>: {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="form-actions">
        <button type="button" onClick={onBack} className="secondary">Volver</button>
        <button type="button" onClick={onContinue} className="primary">{c.cta}</button>
      </div>
    </section>
  );
}

// ===== Options =======================================================

export function OptionsStep({
  value,
  onSubmit,
  onBack,
}: {
  value: ImportOptionsDto;
  onSubmit: (opts: ImportOptionsDto) => void;
  onBack: () => void;
}): JSX.Element {
  const [opts, setOpts] = React.useState(value);
  const c = WIZARD_COPY.steps.options;

  const update = (patch: Partial<ImportOptionsDto>): void => setOpts({ ...opts, ...patch });
  const updateScope = (key: keyof ImportOptionsDto['scope'], val: boolean): void =>
    setOpts({ ...opts, scope: { ...opts.scope, [key]: val } });

  return (
    <section aria-labelledby="options-title">
      <h1 id="options-title">{c.title}</h1>
      <p className="lead">{c.lead}</p>

      <fieldset>
        <legend>{c.sections.users.title}</legend>
        <div className="form-row">
          <span>{c.sections.users.password.label}</span>
          <label>
            <input
              type="radio"
              checked={opts.passwordStrategy === 'activation_reset'}
              onChange={() => update({ passwordStrategy: 'activation_reset' })}
            />
            {c.sections.users.password.options.activation_reset}
          </label>
          <label>
            <input
              type="radio"
              checked={opts.passwordStrategy === 'preserve_hash'}
              onChange={() => update({ passwordStrategy: 'preserve_hash' })}
            />
            {c.sections.users.password.options.preserve_hash}
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>{c.sections.media.title}</legend>
        <label>
          <input
            type="checkbox"
            checked={opts.copyMediaBinaries}
            onChange={(e) => update({ copyMediaBinaries: e.target.checked })}
          />
          {c.sections.media.copyBinaries.label}
        </label>
      </fieldset>

      <fieldset>
        <legend>{c.sections.scope.title}</legend>
        {(['courses', 'quizzes', 'users', 'groups', 'enrollments', 'progress', 'media'] as const).map((k) => (
          <label key={k}>
            <input
              type="checkbox"
              checked={opts.scope[k]}
              onChange={(e) => updateScope(k, e.target.checked)}
            />
            {c.sections.scope[k]}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>{c.sections.groups.title}</legend>
        <label>
          <input
            type="radio"
            checked={opts.groupModelHint === 'cohort'}
            onChange={() => update({ groupModelHint: 'cohort' })}
          />
          {c.sections.groups.modelHint.options.cohort}
        </label>
        <label>
          <input
            type="radio"
            checked={opts.groupModelHint === 'organization'}
            onChange={() => update({ groupModelHint: 'organization' })}
          />
          {c.sections.groups.modelHint.options.organization}
        </label>
      </fieldset>

      <div className="form-actions">
        <button type="button" onClick={onBack} className="secondary">Volver</button>
        <button type="button" onClick={() => onSubmit(opts)} className="primary">{c.cta}</button>
      </div>
    </section>
  );
}

// ===== DryRun ========================================================

export function DryRunStep({
  jobId,
  events,
  status,
  onStart,
  onExecuteReal,
  onBack,
}: {
  jobId?: string;
  events: ProgressEventDto[];
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  onStart: () => Promise<void>;
  onExecuteReal: () => Promise<void>;
  onBack: () => void;
}): JSX.Element {
  const c = WIZARD_COPY.steps.dryrun;
  return (
    <section aria-labelledby="dryrun-title">
      <h1 id="dryrun-title">{c.title}</h1>
      <p className="lead">{c.lead}</p>
      {!jobId && status === 'idle' && (
        <button type="button" onClick={() => void onStart()} className="primary">
          {c.cta}
        </button>
      )}
      {status === 'running' && (
        <div role="status" aria-live="polite">
          <h2>{c.runningTitle}</h2>
          <p>{c.runningLead}</p>
          <ProgressList events={events} />
        </div>
      )}
      {status === 'completed' && (
        <div>
          <p>Comprobación completada. Revisa el resumen y decide si continuar.</p>
          <ProgressList events={events} />
          <div className="form-actions">
            <button type="button" onClick={onBack} className="secondary">{c.ctaBack}</button>
            <button type="button" onClick={() => void onExecuteReal()} className="primary">{c.ctaContinue}</button>
          </div>
        </div>
      )}
    </section>
  );
}

// ===== Execute =======================================================

export function ExecuteStep({
  jobId,
  events,
  status,
  error,
  onCancel,
}: {
  jobId: string;
  events: ProgressEventDto[];
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: { code: string; message: string };
  onCancel: () => Promise<void>;
}): JSX.Element {
  const c = WIZARD_COPY.steps.execute;
  const [confirming, setConfirming] = React.useState(false);

  return (
    <section aria-labelledby="execute-title">
      <h1 id="execute-title">{c.title}</h1>
      <p className="lead">{c.lead}</p>
      <p><small>Job ID: <code>{jobId}</code></small></p>

      <ProgressList events={events} />

      {error && (
        <div role="alert" className="alert alert-destructive">
          <strong>{copyForError(error.code).title}</strong>
          <p>{copyForError(error.code).body}</p>
          <details>
            <summary>{c.detailsToggle}</summary>
            <pre>{JSON.stringify(error, null, 2)}</pre>
          </details>
        </div>
      )}

      {status === 'running' && (
        <div className="form-actions">
          {!confirming ? (
            <button type="button" onClick={() => setConfirming(true)} className="destructive">
              {c.cancelCta}
            </button>
          ) : (
            <>
              <p role="alert">{c.cancelConfirm}</p>
              <button type="button" onClick={() => setConfirming(false)} className="secondary">
                Volver
              </button>
              <button type="button" onClick={() => void onCancel()} className="destructive">
                Sí, cancelar
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ===== Done ==========================================================

export function DoneStep({
  report,
  onReset,
}: {
  report: JobReportDto;
  onReset: () => void;
}): JSX.Element {
  const c = WIZARD_COPY.steps.done;
  return (
    <section aria-labelledby="done-title">
      <h1 id="done-title">{c.title}</h1>
      <p className="lead">{c.lead}</p>
      <ul className="totals">
        <li>Cargados: <strong>{report.totals.loadedCount}</strong></li>
        <li>Saltados: <strong>{report.totals.skippedCount}</strong></li>
        <li>Fallidos: <strong>{report.totals.failedCount}</strong></li>
      </ul>
      <table>
        <thead>
          <tr>
            <th>Tipo</th>
            <th>Origen</th>
            <th>Cargado</th>
            <th>Saltado</th>
            <th>Fallido</th>
          </tr>
        </thead>
        <tbody>
          {report.byEntity.map((row) => (
            <tr key={row.entityType}>
              <td>{row.entityType}</td>
              <td>{row.sourceCount}</td>
              <td>{row.loadedCount}</td>
              <td>{row.skippedCount}</td>
              <td>{row.failedCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="audit-chain">
        <small>
          Cadena de auditoría: {report.auditChain.eventsCount} eventos.{' '}
          {report.auditChain.verified ? '✓ verificada' : '⚠ alterada'}.
        </small>
      </div>
      <div className="form-actions">
        <a
          className="secondary"
          href={`/api/v1/modules/migrator-learndash/jobs/${report.jobId}/report?format=csv`}
        >
          {c.reportCta}
        </a>
        <a className="primary" href="/admin/courses">
          {c.goToCourses}
        </a>
        <button type="button" onClick={onReset} className="ghost">
          Nueva migración
        </button>
      </div>
    </section>
  );
}

// ===== Helpers =======================================================

function ProgressList({ events }: { events: ProgressEventDto[] }): JSX.Element {
  const phases = new Map<string, { current?: number; total?: number; status: 'started' | 'completed' | 'failed' }>();
  for (const e of events) {
    if (e.type === 'phase.started') phases.set(e.phase, { status: 'started' });
    if (e.type === 'phase.progress') {
      const prev = phases.get(e.phase) ?? { status: 'started' as const };
      phases.set(e.phase, { ...prev, current: e.current, total: e.total });
    }
    if (e.type === 'phase.completed') phases.set(e.phase, { status: 'completed' });
    if (e.type === 'phase.failed') phases.set(e.phase, { status: 'failed' });
  }
  return (
    <ol className="phase-list" aria-live="polite">
      {Array.from(phases.entries()).map(([phase, info]) => (
        <li key={phase} data-status={info.status}>
          <span className="phase-name">{phase}</span>
          {info.current !== undefined && (
            <span className="phase-count">
              {info.current}
              {info.total !== undefined ? ` / ${info.total}` : ''}
            </span>
          )}
          <span className="phase-status">{info.status === 'completed' ? '✓' : info.status === 'failed' ? '✗' : '…'}</span>
        </li>
      ))}
    </ol>
  );
}
