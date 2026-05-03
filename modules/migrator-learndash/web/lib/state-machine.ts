/**
 * State machine del wizard. Implementación con reducer tipado en lugar
 * de xstate para no añadir dependencia. Las transiciones inválidas
 * lanzan en dev y se loggean en prod.
 */
import type { ImportOptionsDto, JobReportDto, PreflightResultDto, ProgressEventDto, SourceCredentialsDto } from '../../src/dto.js';

export type WizardStep =
  | 'welcome'
  | 'connect'
  | 'preflight'
  | 'options'
  | 'dryrun'
  | 'execute'
  | 'done';

export interface WizardState {
  step: WizardStep;
  credentials?: SourceCredentialsDto;
  preflight?: PreflightResultDto;
  options: ImportOptionsDto;
  jobId?: string;
  events: ProgressEventDto[];
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: { code: string; message: string };
  report?: JobReportDto;
  isDryRun: boolean;
}

export type WizardAction =
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'RESET' }
  | { type: 'SET_CREDENTIALS'; credentials: SourceCredentialsDto }
  | { type: 'PREFLIGHT_OK'; preflight: PreflightResultDto }
  | { type: 'PREFLIGHT_FAILED'; error: { code: string; message: string } }
  | { type: 'SET_OPTIONS'; options: ImportOptionsDto }
  | { type: 'JOB_STARTED'; jobId: string; isDryRun: boolean }
  | { type: 'PROGRESS_EVENT'; event: ProgressEventDto }
  | { type: 'EXECUTION_DONE'; report: JobReportDto }
  | { type: 'EXECUTION_FAILED'; error: { code: string; message: string } }
  | { type: 'EXECUTION_CANCELLED' };

export const DEFAULT_OPTIONS: ImportOptionsDto = {
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

export const INITIAL_STATE: WizardState = {
  step: 'welcome',
  options: DEFAULT_OPTIONS,
  events: [],
  status: 'idle',
  isDryRun: false,
};

const STEP_ORDER: WizardStep[] = ['welcome', 'connect', 'preflight', 'options', 'dryrun', 'execute', 'done'];

export function reducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'NEXT': {
      const idx = STEP_ORDER.indexOf(state.step);
      if (idx === -1 || idx === STEP_ORDER.length - 1) return state;
      return { ...state, step: STEP_ORDER[idx + 1] };
    }
    case 'BACK': {
      // No permitir BACK durante execute con job en curso
      if (state.step === 'execute' && state.status === 'running') return state;
      const idx = STEP_ORDER.indexOf(state.step);
      if (idx <= 0) return state;
      return { ...state, step: STEP_ORDER[idx - 1] };
    }
    case 'RESET':
      return INITIAL_STATE;
    case 'SET_CREDENTIALS':
      return { ...state, credentials: action.credentials, error: undefined };
    case 'PREFLIGHT_OK':
      return { ...state, preflight: action.preflight, step: 'preflight', error: undefined };
    case 'PREFLIGHT_FAILED':
      return { ...state, error: action.error };
    case 'SET_OPTIONS':
      return { ...state, options: action.options };
    case 'JOB_STARTED':
      return {
        ...state,
        jobId: action.jobId,
        isDryRun: action.isDryRun,
        events: [],
        status: 'running',
        step: 'execute',
      };
    case 'PROGRESS_EVENT': {
      const next = { ...state, events: [...state.events, action.event] };
      if (action.event.type === 'job.completed') {
        next.status = 'completed';
      } else if (action.event.type === 'phase.failed') {
        next.status = 'failed';
        next.error = action.event.error;
      } else if (action.event.type === 'job.cancelled') {
        next.status = 'cancelled';
      }
      return next;
    }
    case 'EXECUTION_DONE':
      return { ...state, report: action.report, status: 'completed', step: 'done' };
    case 'EXECUTION_FAILED':
      return { ...state, error: action.error, status: 'failed' };
    case 'EXECUTION_CANCELLED':
      return { ...state, status: 'cancelled' };
    default:
      return state;
  }
}

/** Persistencia local: guardar estado mínimo para recuperar tras refresh. */
export interface PersistedState {
  step: WizardStep;
  credentials?: { baseUrl: string; username: string }; // sin password
  options: ImportOptionsDto;
  jobId?: string;
}

export function pickPersisted(state: WizardState): PersistedState {
  return {
    step: state.step,
    credentials: state.credentials
      ? { baseUrl: state.credentials.baseUrl, username: state.credentials.username }
      : undefined,
    options: state.options,
    jobId: state.jobId,
  };
}
