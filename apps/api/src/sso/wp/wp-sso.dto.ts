import { z } from 'zod';

/**
 * DTO del PUT de config WP-SSO (panel admin). `sharedSecret` es opcional en
 * updates posteriores: sólo se envía cuando se quiere rotar (vacío = preserva el
 * guardado). Mismo criterio que el clientSecret de OIDC.
 */
export const wpSsoConfigPutSchema = z.object({
  enabled: z.boolean(),
  sharedSecret: z
    .string()
    .min(16, 'El secreto compartido debe tener al menos 16 caracteres.')
    .optional(),
  issuer: z
    .string()
    .trim()
    .url('El issuer debe ser una URL (el home_url de tu WordPress).')
    .optional()
    .or(z.literal('')),
  audience: z.string().trim().max(120).optional().or(z.literal('')),
  autoCreate: z.boolean(),
  autoRedirect: z.boolean(),
});

export type WpSsoConfigPutDto = z.infer<typeof wpSsoConfigPutSchema>;
