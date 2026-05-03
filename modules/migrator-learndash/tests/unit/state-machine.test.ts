import { describe, expect, it } from 'vitest';
import { reducer, INITIAL_STATE, DEFAULT_OPTIONS } from '../../web/lib/state-machine.js';

describe('wizard reducer', () => {
  it('NEXT desde welcome avanza a connect', () => {
    const next = reducer(INITIAL_STATE, { type: 'NEXT' });
    expect(next.step).toBe('connect');
  });

  it('BACK desde welcome no hace nada', () => {
    const next = reducer(INITIAL_STATE, { type: 'BACK' });
    expect(next.step).toBe('welcome');
  });

  it('SET_CREDENTIALS guarda credenciales', () => {
    const next = reducer(INITIAL_STATE, {
      type: 'SET_CREDENTIALS',
      credentials: { baseUrl: 'https://x', username: 'u', appPassword: 'pppppppp' },
    });
    expect(next.credentials?.username).toBe('u');
  });

  it('PREFLIGHT_OK → step=preflight', () => {
    const next = reducer(INITIAL_STATE, {
      type: 'PREFLIGHT_OK',
      preflight: {
        ok: true,
        latencyMs: 100,
        counts: { courses: 5, lessons: 10, topics: 2, quizzes: 3, groups: 1, users: 50, media: 30 },
        warnings: [],
        capabilities: { learndashV1: true, learndashV2: false, wpRest: true },
      },
    });
    expect(next.step).toBe('preflight');
  });

  it('JOB_STARTED transiciona a execute', () => {
    const next = reducer(INITIAL_STATE, { type: 'JOB_STARTED', jobId: 'abc', isDryRun: false });
    expect(next.step).toBe('execute');
    expect(next.status).toBe('running');
  });

  it('PROGRESS_EVENT acumula y completa al recibir job.completed', () => {
    let s = reducer(INITIAL_STATE, { type: 'JOB_STARTED', jobId: 'abc', isDryRun: false });
    s = reducer(s, {
      type: 'PROGRESS_EVENT',
      event: { type: 'phase.started', phase: 'extract', at: 'now' },
    });
    s = reducer(s, {
      type: 'PROGRESS_EVENT',
      event: { type: 'job.completed', summary: [], at: 'now' },
    });
    expect(s.events).toHaveLength(2);
    expect(s.status).toBe('completed');
  });

  it('BACK durante execute con status=running NO retrocede', () => {
    let s = reducer(INITIAL_STATE, { type: 'JOB_STARTED', jobId: 'abc', isDryRun: false });
    s = reducer(s, { type: 'BACK' });
    expect(s.step).toBe('execute');
  });

  it('RESET vuelve al estado inicial', () => {
    let s = reducer(INITIAL_STATE, { type: 'NEXT' });
    s = reducer(s, { type: 'RESET' });
    expect(s).toEqual(INITIAL_STATE);
    expect(s.options).toEqual(DEFAULT_OPTIONS);
  });
});
