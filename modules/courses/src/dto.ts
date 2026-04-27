import { z } from 'zod';

export const lessonTypeSchema = z.enum(['VIDEO', 'HTML', 'PDF', 'TEXT', 'QUIZ', 'SCORM']);

export const courseStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);

export const slugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Slug debe ser kebab-case sin acentos ni espacios');

export const createCourseSchema = z.object({
  slug: slugSchema,
  title: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  thumbnailUrl: z.string().url().optional(),
  language: z.string().min(2).max(10).default('es-ES'),
  estimatedMinutes: z.number().int().positive().optional(),
  category: z.string().max(60).optional(),
});
export type CreateCourseDto = z.infer<typeof createCourseSchema>;

export const updateCourseSchema = createCourseSchema.partial().extend({
  status: courseStatusSchema.optional(),
  /// UUID de la plantilla de certificado preferida. null = usar default del tenant.
  certificateTemplateId: z.string().uuid().nullable().optional(),
});
export type UpdateCourseDto = z.infer<typeof updateCourseSchema>;

export const createModuleSchema = z.object({
  title: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  position: z.number().int().min(0).optional(),
});
export type CreateModuleDto = z.infer<typeof createModuleSchema>;

export const lessonContentSchema = z.record(z.string(), z.unknown());

export const createLessonSchema = z.object({
  type: lessonTypeSchema,
  title: z.string().min(1).max(160),
  position: z.number().int().min(0).optional(),
  content: lessonContentSchema.default({}),
  durationMinutes: z.number().int().positive().optional(),
});
export type CreateLessonDto = z.infer<typeof createLessonSchema>;

export const updateLessonSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  content: lessonContentSchema.optional(),
  durationMinutes: z.number().int().positive().nullable().optional(),
});
export type UpdateLessonDto = z.infer<typeof updateLessonSchema>;
