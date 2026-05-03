import { z } from 'zod';

/** Credenciales para el sistema origen — el password viaja cifrado en transit y nunca se persiste. */
export const sourceCredentialsSchema = z.object({
  baseUrl: z
    .string()
    .url('Debe ser una URL válida (https://...)')
    .refine((u) => u.startsWith('https://') || u.startsWith('http://localhost'), {
      message: 'Solo HTTPS (excepto localhost para tests)',
    }),
  username: z.string().min(1, 'Usuario requerido'),
  appPassword: z.string().min(8, 'Application Password de WordPress (8+ caracteres)'),
});
export type SourceCredentialsDto = z.infer<typeof sourceCredentialsSchema>;

/** Opciones de la migración. */
export const importOptionsSchema = z.object({
  dedupeUsersBy: z.array(z.enum(['email', 'username'])).default(['email']),
  passwordStrategy: z.enum(['activation_reset', 'preserve_hash']).default('activation_reset'),
  copyMediaBinaries: z.boolean().default(true),
  preserveAttemptHistory: z.boolean().default(false),
  groupModelHint: z.enum(['cohort', 'organization']).default('cohort'),
  scope: z.object({
    courses: z.boolean().default(true),
    users: z.boolean().default(true),
    groups: z.boolean().default(true),
    enrollments: z.boolean().default(true),
    progress: z.boolean().default(true),
    media: z.boolean().default(true),
    quizzes: z.boolean().default(true),
  }).default({}),
  dryRun: z.boolean().default(false),
  retentionDays: z.number().int().min(1).max(365).default(30),
});
export type ImportOptionsDto = z.infer<typeof importOptionsSchema>;

/** Body del POST /preflight. */
export const preflightRequestSchema = z.object({
  credentials: sourceCredentialsSchema,
});
export type PreflightRequestDto = z.infer<typeof preflightRequestSchema>;

/** Resultado del preflight. */
export const preflightResultSchema = z.object({
  ok: z.boolean(),
  siteName: z.string().optional(),
  latencyMs: z.number(),
  counts: z.object({
    courses: z.number().int(),
    lessons: z.number().int(),
    topics: z.number().int(),
    quizzes: z.number().int(),
    groups: z.number().int(),
    users: z.number().int(),
    media: z.number().int(),
  }),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  capabilities: z.object({
    learndashV1: z.boolean(),
    learndashV2: z.boolean(),
    wpRest: z.boolean(),
  }),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type PreflightResultDto = z.infer<typeof preflightResultSchema>;

/** Body del POST /jobs (start migration). */
export const startImportRequestSchema = z.object({
  credentials: sourceCredentialsSchema,
  options: importOptionsSchema,
});
export type StartImportRequestDto = z.infer<typeof startImportRequestSchema>;

/** Estado del job. */
export const jobStatusSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  status: z.enum([
    'pending',
    'preflight',
    'extracting',
    'transforming',
    'loading',
    'reconciling',
    'completed',
    'failed',
    'cancelled',
    'cancelling',
    'rolling_back',
    'rolled_back',
  ]),
  phase: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  progress: z
    .object({
      current: z.number(),
      total: z.number(),
      lastUpdate: z.string(),
    })
    .nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdBy: z.string(),
});
export type JobStatusDto = z.infer<typeof jobStatusSchema>;

/** Eventos de progreso (SSE). */
export const progressEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('phase.started'),
    phase: z.string(),
    estimatedTotal: z.number().optional(),
    at: z.string(),
  }),
  z.object({
    type: z.literal('phase.progress'),
    phase: z.string(),
    current: z.number(),
    total: z.number().optional(),
    etaSec: z.number().optional(),
    at: z.string(),
  }),
  z.object({
    type: z.literal('phase.completed'),
    phase: z.string(),
    counts: z.record(z.string(), z.number()),
    at: z.string(),
  }),
  z.object({
    type: z.literal('phase.failed'),
    phase: z.string(),
    error: z.object({ code: z.string(), message: z.string() }),
    at: z.string(),
  }),
  z.object({
    type: z.literal('job.completed'),
    summary: z.array(
      z.object({
        entityType: z.string(),
        sourceCount: z.number(),
        loadedCount: z.number(),
        skippedCount: z.number(),
        failedCount: z.number(),
      }),
    ),
    at: z.string(),
  }),
  z.object({
    type: z.literal('job.cancelled'),
    at: z.string(),
  }),
]);
export type ProgressEventDto = z.infer<typeof progressEventSchema>;

/** Reporte final del job. */
export const jobReportSchema = z.object({
  jobId: z.string(),
  generatedAt: z.string(),
  totals: z.object({
    sourceCount: z.number(),
    loadedCount: z.number(),
    skippedCount: z.number(),
    failedCount: z.number(),
  }),
  byEntity: z.array(
    z.object({
      entityType: z.string(),
      sourceCount: z.number(),
      stagedCount: z.number(),
      validCount: z.number(),
      loadedCount: z.number(),
      skippedCount: z.number(),
      failedCount: z.number(),
      skipReasons: z.array(z.object({ code: z.string(), count: z.number() })).optional(),
      failureReasons: z
        .array(
          z.object({
            code: z.string(),
            count: z.number(),
            sample: z
              .array(z.object({ sourceId: z.string(), message: z.string() }))
              .optional(),
          }),
        )
        .optional(),
    }),
  ),
  auditChain: z.object({
    eventsCount: z.number(),
    firstHash: z.string().optional(),
    lastHash: z.string().optional(),
    verified: z.boolean(),
  }),
});
export type JobReportDto = z.infer<typeof jobReportSchema>;
