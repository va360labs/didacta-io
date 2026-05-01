import { z } from 'zod';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HOSTNAME_RE = /^[a-z0-9.-]{1,253}$/;

export const setupInitSchema = z.object({
  organization: z.object({
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(SLUG_RE, 'Slug debe ser DNS-safe: minúsculas, números y guiones')
      .optional(),
    primaryHostname: z
      .string()
      .min(1)
      .max(253)
      .regex(HOSTNAME_RE, 'Hostname inválido')
      .optional(),
  }),
  admin: z.object({
    name: z.string().min(1).max(120),
    email: z.string().email().max(200),
    password: z.string().min(12).max(128),
  }),
});

export type SetupInitDto = z.infer<typeof setupInitSchema>;
