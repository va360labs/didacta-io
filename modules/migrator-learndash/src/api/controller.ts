/**
 * Handlers HTTP del módulo migrator-learndash.
 *
 * IMPORTANTE: este módulo NO declara decoradores NestJS. Sigue la
 * convención del marketplace ADR-009 — los controllers reales viven en
 * `apps/api/src/modules/<name>/` del host, que importa esta factory y
 * aplica sus propios decoradores. Esto mantiene el bundle del ZIP libre
 * de la dependencia NestJS y permite que el host elija el runtime
 * (Fastify, Express, lo que sea).
 *
 * El host obtiene los handlers vía `createHandlers(deps)` y los conecta
 * a sus routes con la firma que necesite. Tipos exportados para que el
 * host los reuse.
 */
import { z } from 'zod';

import type { EtlOrchestrator } from '../etl/orchestrator.js';
import {
  preflightRequestSchema,
  startImportRequestSchema,
  type JobReportDto,
  type PreflightResultDto,
  type ProgressEventDto,
} from '../dto.js';

export interface RequestContext {
  tenantId: string;
  userId: string;
}

export interface MigratorHandlers {
  preflight(body: unknown): Promise<PreflightResultDto>;
  startJob(body: unknown, ctx: RequestContext): Promise<{ jobId: string }>;
  getJob(jobId: string): Promise<unknown>;
  observeProgress(jobId: string): { subscribe: (cb: (event: ProgressEventDto) => void) => () => void };
  cancel(jobId: string, ctx: RequestContext): Promise<{ ok: true }>;
  rollback(jobId: string, ctx: RequestContext): Promise<{ ok: true }>;
  getReport(jobId: string, format?: string): Promise<JobReportDto | string>;
}

export interface HandlersDeps {
  orchestrator: EtlOrchestrator;
}

export class HandlerValidationError extends Error {
  override readonly name = 'HandlerValidationError';
  readonly code = 'VALIDATION_ERROR';
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
  }
}

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new HandlerValidationError(message);
  }
  return result.data;
}

/**
 * Construye los handlers para los endpoints del módulo. El host conecta
 * cada handler a su path correspondiente bajo
 * `/api/v1/modules/migrator-learndash/*`.
 */
export function createHandlers(deps: HandlersDeps): MigratorHandlers {
  const { orchestrator } = deps;

  return {
    /** POST /preflight */
    async preflight(body) {
      const validated = parseOrThrow(preflightRequestSchema, body);
      return orchestrator.preflight(validated.credentials);
    },

    /** POST /jobs */
    async startJob(body, ctx) {
      const validated = parseOrThrow(startImportRequestSchema, body);
      return orchestrator.startJob(ctx.tenantId, ctx.userId, validated);
    },

    /** GET /jobs/:id */
    async getJob(jobId) {
      return orchestrator.getJob(jobId);
    },

    /**
     * GET /jobs/:id/progress (SSE).
     * Devuelve un objeto subscribible compatible con cualquier framework.
     * El host adapta esto a su mecanismo SSE/WebSocket.
     */
    observeProgress(jobId) {
      const observable = orchestrator.observeProgress(jobId);
      return {
        subscribe(cb) {
          const sub = observable.subscribe({
            next: (event) => cb(event),
          });
          return () => sub.unsubscribe();
        },
      };
    },

    /** POST /jobs/:id/cancel */
    async cancel(jobId, ctx) {
      await orchestrator.cancelJob(jobId, ctx.userId);
      return { ok: true };
    },

    /** POST /jobs/:id/rollback */
    async rollback(jobId, ctx) {
      await orchestrator.rollback(jobId, ctx.userId);
      return { ok: true };
    },

    /** GET /jobs/:id/report?format=csv|json */
    async getReport(jobId, format) {
      const report = await orchestrator.getReport(jobId);
      if (format === 'csv') {
        return reportToCsv(report);
      }
      return report;
    },
  };
}

function reportToCsv(report: JobReportDto): string {
  const lines = ['entityType,sourceCount,loadedCount,skippedCount,failedCount'];
  for (const row of report.byEntity) {
    lines.push(
      [row.entityType, row.sourceCount, row.loadedCount, row.skippedCount, row.failedCount].join(','),
    );
  }
  return lines.join('\n');
}
