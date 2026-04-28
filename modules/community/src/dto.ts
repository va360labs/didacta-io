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
