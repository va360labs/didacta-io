/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * Componente principal del wizard. Implementación con React 19 + Next.js 15.
 *
 * Notas de integración:
 * - El host provee shadcn/ui en `@/components/ui/*`. Para mantener este
 *   archivo independiente, declaramos imports relativos a la app y el
 *   bundler del host los resuelve en runtime.
 * - Los componentes se entregan como JSX/TSX y el host los compila como
 *   parte del catálogo de extensiones (apps/web/src/modules/*).
 */
import * as React from 'react';
import type { ModuleRoute } from '../types.js';
import { reducer, INITIAL_STATE, pickPersisted, type WizardAction, type WizardState } from '../lib/state-machine.js';
import { MigratorApiClient } from '../lib/api-client.js';
import { WIZARD_COPY, copyForError } from '../lib/copy.js';
import {
  WelcomeStep,
  ConnectStep,
  PreflightStep,
  OptionsStep,
  DryRunStep,
  ExecuteStep,
  DoneStep,
} from './steps/index.js';

const STORAGE_KEY = 'didacta:wizard:migrator-learndash:v1';

export interface WizardProps {
  baseUrl: string;
  getAuthToken: () => Promise<string>;
  onClose?: () => void;
}

export function MigratorWizard({ baseUrl, getAuthToken, onClose }: WizardProps): JSX.Element {
  const apiRef = React.useRef<MigratorApiClient | null>(null);
  if (!apiRef.current) {
    apiRef.current = new MigratorApiClient({ baseUrl, getAuthToken });
  }
  const api = apiRef.current;

  const [state, dispatch] = React.useReducer(
    reducer,
    INITIAL_STATE,
    (initial): WizardState => {
      try {
        const raw = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
        if (!raw) return initial;
        const parsed = JSON.parse(raw) as Partial<WizardState>;
        return { ...initial, ...parsed };
      } catch {
        return initial;
      }
    },
  );

  // Persistencia
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pickPersisted(state)));
    } catch {
      // localStorage lleno o bloqueado: ignorar
    }
  }, [state]);

  // Suscripción a SSE cuando hay jobId activo
  React.useEffect(() => {
    if (!state.jobId || state.status !== 'running') return;
    const dispose = api.subscribeProgress(
      state.jobId,
      (event) => dispatch({ type: 'PROGRESS_EVENT', event }),
      (err) => dispatch({ type: 'EXECUTION_FAILED', error: { code: 'SSE_LOST', message: err.message } }),
    );
    return dispose;
  }, [api, state.jobId, state.status]);

  // Al detectar completed via SSE, fetch del report
  React.useEffect(() => {
    if (state.status !== 'completed' || !state.jobId || state.report) return;
    void (async () => {
      try {
        const report = await api.getReport(state.jobId!);
        dispatch({ type: 'EXECUTION_DONE', report });
      } catch (err) {
        dispatch({ type: 'EXECUTION_FAILED', error: { code: 'REPORT_FETCH_FAILED', message: (err as Error).message } });
      }
    })();
  }, [api, state.status, state.jobId, state.report]);

  const handlers = {
    onConnectSubmit: async (credentials: WizardState['credentials']): Promise<void> => {
      if (!credentials) return;
      try {
        const preflight = await api.preflight(credentials);
        if (!preflight.ok) {
          dispatch({ type: 'PREFLIGHT_FAILED', error: preflight.error ?? { code: 'PREFLIGHT_FAILED', message: '' } });
          return;
        }
        dispatch({ type: 'SET_CREDENTIALS', credentials });
        dispatch({ type: 'PREFLIGHT_OK', preflight });
      } catch (err) {
        const e = err as Error & { code?: string };
        dispatch({ type: 'PREFLIGHT_FAILED', error: { code: e.code ?? 'CONNECT_FAILED', message: e.message } });
      }
    },
    onOptionsSubmit: (options: WizardState['options']): void => {
      dispatch({ type: 'SET_OPTIONS', options });
      dispatch({ type: 'NEXT' });
    },
    onDryRunStart: async (): Promise<void> => {
      if (!state.credentials) return;
      const job = await api.startJob(state.credentials, { ...state.options, dryRun: true });
      dispatch({ type: 'JOB_STARTED', jobId: job.jobId, isDryRun: true });
    },
    onExecuteStart: async (): Promise<void> => {
      if (!state.credentials) return;
      const job = await api.startJob(state.credentials, { ...state.options, dryRun: false });
      dispatch({ type: 'JOB_STARTED', jobId: job.jobId, isDryRun: false });
    },
    onCancel: async (): Promise<void> => {
      if (!state.jobId) return;
      await api.cancelJob(state.jobId);
    },
    onBack: (): void => dispatch({ type: 'BACK' }),
    onNext: (): void => dispatch({ type: 'NEXT' }),
    onReset: (): void => dispatch({ type: 'RESET' }),
  };

  return (
    <div className="didacta-wizard" data-step={state.step}>
      <header className="wizard-header">
        <Stepper current={state.step} />
        {onClose ? <button type="button" onClick={onClose} aria-label="Cerrar">×</button> : null}
      </header>

      <main className="wizard-body">
        {state.step === 'welcome' && <WelcomeStep onContinue={handlers.onNext} />}
        {state.step === 'connect' && (
          <ConnectStep
            initial={state.credentials}
            error={state.error}
            onSubmit={handlers.onConnectSubmit}
            onBack={handlers.onBack}
          />
        )}
        {state.step === 'preflight' && state.preflight && (
          <PreflightStep preflight={state.preflight} onContinue={handlers.onNext} onBack={handlers.onBack} />
        )}
        {state.step === 'options' && (
          <OptionsStep value={state.options} onSubmit={handlers.onOptionsSubmit} onBack={handlers.onBack} />
        )}
        {state.step === 'dryrun' && (
          <DryRunStep
            jobId={state.isDryRun ? state.jobId : undefined}
            events={state.events}
            status={state.status}
            onStart={handlers.onDryRunStart}
            onExecuteReal={handlers.onExecuteStart}
            onBack={handlers.onBack}
          />
        )}
        {state.step === 'execute' && (
          <ExecuteStep
            jobId={state.jobId!}
            events={state.events}
            status={state.status}
            error={state.error}
            onCancel={handlers.onCancel}
          />
        )}
        {state.step === 'done' && state.report && (
          <DoneStep report={state.report} onReset={handlers.onReset} />
        )}
      </main>
    </div>
  );
}

function Stepper({ current }: { current: WizardState['step'] }): JSX.Element {
  const steps: WizardState['step'][] = ['welcome', 'connect', 'preflight', 'options', 'dryrun', 'execute', 'done'];
  return (
    <ol className="wizard-stepper" role="list">
      {steps.map((s, i) => (
        <li key={s} aria-current={s === current ? 'step' : undefined}>
          <span className="step-index">{i + 1}</span>
          <span className="step-label">{stepLabel(s)}</span>
        </li>
      ))}
    </ol>
  );
}

function stepLabel(s: WizardState['step']): string {
  switch (s) {
    case 'welcome': return 'Bienvenida';
    case 'connect': return 'Conectar';
    case 'preflight': return 'Resumen';
    case 'options': return 'Opciones';
    case 'dryrun': return 'Comprobación';
    case 'execute': return 'Migrar';
    case 'done': return 'Resultado';
  }
}

// ---- Route export ----------------------------------------------------

const WizardPage: React.ComponentType<unknown> = () => {
  // El host inyecta baseUrl/token vía contexto; aquí placeholder.
  return (
    <MigratorWizard
      baseUrl=""
      getAuthToken={async () => ''}
    />
  );
};

export const wizardRoute: ModuleRoute = {
  path: '/admin/modules/migrator-learndash',
  Component: WizardPage,
  surface: 'admin',
  requiredCapability: 'feat:migrators.learndash',
};
