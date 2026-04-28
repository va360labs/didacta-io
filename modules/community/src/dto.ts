import { z } from 'zod';

export const createPostSchema = z.object({
  title: z.string().min(3).max(200),
  body: z.string().min(1).max(10_000),
  courseId: z.string().uuid().optional(),
  tags: z.array(z.string().min(1).max(40)).max(10).optional(),
});
export type CreatePostDto = z.infer<typeof createPostSchema>;

/**
 * Orden del listado.
 * - `recent`: createdAt DESC (default; es lo que el listado mostraba antes
 *   sin opción configurable).
 * - `oldest`: createdAt ASC.
 * - `most_commented`: comentarios DESC, createdAt DESC como tiebreaker
 *   determinístico.
 *
 * Lo dejamos opcional en el schema (sin default) para que el tipo
 * inferido sea `PostSort | undefined`. El service aplica el default
 * `'recent'` si viene undefined, evitando que los callers TS estén
 * obligados a pasarlo siempre.
 */
export const postSortSchema = z.enum(['recent', 'oldest', 'most_commented']);
export type PostSort = z.infer<typeof postSortSchema>;

export const listPostsQuerySchema = z.object({
  courseId: z.string().uuid().optional(),
  authorId: z.string().uuid().optional(),
  tag: z.string().min(1).max(40).optional(),
  sort: postSortSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});
export type ListPostsQueryDto = z.infer<typeof listPostsQuerySchema>;

export const createCommentSchema = z.object({
  body: z.string().min(1).max(5_000),
  /** UUID del comentario padre para nested replies. 1 nivel max — si el
   * padre ya tiene padre, el service rechaza con `NestedRepliesTooDeepError`. */
  parentCommentId: z.string().uuid().nullable().optional(),
});
export type CreateCommentDto = z.infer<typeof createCommentSchema>;

export const moderationActionSchema = z.object({
  hidden: z.boolean(),
  reason: z.string().min(1).max(500).optional(),
});
export type ModerationActionDto = z.infer<typeof moderationActionSchema>;

export const addReactionSchema = z
  .object({
    postId: z.string().uuid().optional(),
    commentId: z.string().uuid().optional(),
    emoji: z.string().min(1).max(8),
  })
  .superRefine((r, ctx) => {
    const targets = [r.postId, r.commentId].filter(Boolean);
    if (targets.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Debe enviarse exactamente uno de postId o commentId',
      });
    }
  });
export type AddReactionDto = z.infer<typeof addReactionSchema>;

export const userPreferencesSchema = z.object({
  /** True = no recibir el email digest semanal. Default: false (recibirlo). */
  digestOptOut: z.boolean().optional(),
});
export type UserPreferencesDto = z.infer<typeof userPreferencesSchema>;

/**
 * Color hexadecimal de 6 dígitos con `#` (ej. `#1E5AA8`). La UI lo
 * inyecta directo como `style.background`/`style.color`, así que la
 * validación tiene que ser estricta para evitar inyección de CSS.
 */
const hexColorRegex = /^#[0-9a-fA-F]{6}$/;

/**
 * Set de iconos del icon-set interno permitidos para los tags. Solo
 * incluimos iconos que existen en `apps/web/src/components/icon.tsx`
 * para que la admin no pueda elegir uno que la UI no sabe pintar.
 */
export const COMMUNITY_TAG_ICONS = [
  'message',
  'help',
  'sparkles',
  'book',
  'users',
  'award',
  'bell',
  'shield',
  'alert',
] as const;

export const createTagSchema = z.object({
  /**
   * Nombre canónico. Hasta 40 chars, sin espacios al inicio/fin. La app
   * lo normaliza a minúsculas antes de persistir para que el unique
   * `(tenantId, name)` dispare en colisiones case-insensitive.
   */
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(hexColorRegex, 'Color debe ser hex 6 dígitos con #'),
  icon: z
    .enum(COMMUNITY_TAG_ICONS)
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});
export type CreateTagDto = z.infer<typeof createTagSchema>;

export const updateTagSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  color: z.string().regex(hexColorRegex).optional(),
  icon: z.enum(COMMUNITY_TAG_ICONS).nullable().optional(),
});
export type UpdateTagDto = z.infer<typeof updateTagSchema>;
