import { z } from 'zod';

/** Tipos de grupo de acceso (espejo del enum Prisma AccessGroupKind). */
export const ACCESS_GROUP_KINDS = ['ALL_COURSES', 'COURSE', 'MULTI_COURSE'] as const;
export type AccessGroupKindDto = (typeof ACCESS_GROUP_KINDS)[number];

const slugRegex = /^[a-z0-9-]+$/;

export const createAccessGroupSchema = z
  .object({
    name: z.string().min(1).max(120),
    /** Opcional: si falta, se deriva de `name`. */
    slug: z.string().min(1).max(120).regex(slugRegex).optional(),
    kind: z.enum(ACCESS_GROUP_KINDS),
    description: z.string().max(500).optional(),
    /** Cursos del grupo. Prohibido para ALL_COURSES (otorga todos). */
    courseIds: z.array(z.string().uuid()).optional(),
    autoGrantNewCourses: z.boolean().optional(),
  })
  .strict();
export type CreateAccessGroupDto = z.infer<typeof createAccessGroupSchema>;

export const updateAccessGroupSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    autoGrantNewCourses: z.boolean().optional(),
    isDefaultForApproval: z.boolean().optional(),
  })
  .strict();
export type UpdateAccessGroupDto = z.infer<typeof updateAccessGroupSchema>;

export const setAccessGroupCoursesSchema = z
  .object({
    courseIds: z.array(z.string().uuid()),
  })
  .strict();
export type SetAccessGroupCoursesDto = z.infer<typeof setAccessGroupCoursesSchema>;

export const assignAccessGroupMembersSchema = z
  .object({
    userIds: z.array(z.string().uuid()).min(1).max(500),
  })
  .strict();
export type AssignAccessGroupMembersDto = z.infer<typeof assignAccessGroupMembersSchema>;

/** Deriva un slug a partir del nombre cuando el admin no lo provee. */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
