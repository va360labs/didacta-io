import { z } from 'zod';

/// Schema Zod del manifest de un módulo `*.didactamod`.
///
/// Une el contrato base (ADR-008 — campos que todo módulo declara: nombre,
/// versión, tablePrefix, apiNamespace, eventos, hooks, permisos) con las
/// extensiones específicas del marketplace (ADR-009 §2): vendor, signedAt,
/// requiredCapabilities, requiredEnvVars, isolation.
///
/// Distribución de la firma: el paquete trae un único archivo `manifest.jwt`
/// (JWS compact ES256 firmado por AWS KMS `alias/didacta-issuer-2026`). El
/// payload del JWT ES el manifest serializado. La canonicalización la hace
/// `jose` — no necesitamos lógica propia. Ver ADR-009 §"Esquema de firma".

export const MODULE_NAME_REGEX = /^mod\.[a-z0-9][a-z0-9-]{0,40}$/;
export const TABLE_PREFIX_REGEX = /^mod_[a-z0-9_]{1,40}_$/;
export const API_NAMESPACE_REGEX = /^\/modules\/[a-z0-9-]{1,40}$/;
export const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const SEMVER_RANGE_REGEX = /^[\^~>=<]?\s?\d+\.\d+\.\d+/;

/// Vendors confiados por la instancia. En MVP solo `didacta` (Didacta firma
/// todos los paquetes con su KMS, incluso los de terceros tras revisión
/// manual). El valor `community` queda reservado para Fase 2+ cuando
/// exista marketplace público con review automatizado y firma propia.
export const MODULE_VENDOR = ['didacta', 'community'] as const;
export const MODULE_ISOLATION = ['vm', 'worker_thread'] as const;

const eventSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});

const hookSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});

const permissionSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});

export const moduleManifestSchema = z
  .object({
    name: z.string().regex(MODULE_NAME_REGEX, {
      message: 'name debe ser "mod.<slug-kebab>" (ej. "mod.gamification")',
    }),
    version: z.string().regex(SEMVER_REGEX, { message: 'version debe ser SemVer' }),
    displayName: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    coreVersionRequired: z
      .string()
      .regex(SEMVER_RANGE_REGEX, { message: 'coreVersionRequired debe ser un rango SemVer' }),
    tablePrefix: z.string().regex(TABLE_PREFIX_REGEX, {
      message: 'tablePrefix debe ser "mod_<slug>_" (ej. "mod_gamification_")',
    }),
    apiNamespace: z.string().regex(API_NAMESPACE_REGEX, {
      message: 'apiNamespace debe ser "/modules/<slug>"',
    }),
    vendor: z.enum(MODULE_VENDOR),
    signedAt: z
      .string()
      .datetime({ offset: true, message: 'signedAt debe ser ISO-8601 con offset' }),
    permissions: z.array(permissionSchema).max(50).default([]),
    eventsEmitted: z.array(eventSchema).max(50).default([]),
    eventsConsumed: z.array(eventSchema).max(50).default([]),
    hooksProvided: z.array(hookSchema).max(50).default([]),
    hooksConsumed: z.array(hookSchema).max(50).default([]),
    requiredCapabilities: z.array(z.string().min(1).max(60)).max(20).default([]),
    requiredEnvVars: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/, 'env var en SCREAMING_SNAKE_CASE'))
      .max(20)
      .default([]),
    isolation: z.enum(MODULE_ISOLATION).default('vm'),
  })
  .strict();

export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

/// Coherencia cruzada: el `tablePrefix` y el `apiNamespace` deben derivar del
/// mismo slug que `name`. Evita que un módulo declare un nombre y use el
/// prefix de otro (vector de leak entre tablas).
export function validateManifestConsistency(manifest: ModuleManifest): string[] {
  const errors: string[] = [];
  const slug = manifest.name.replace(/^mod\./, '');
  const slugSnake = slug.replace(/-/g, '_');
  const expectedPrefix = `mod_${slugSnake}_`;
  const expectedNamespace = `/modules/${slug}`;
  if (manifest.tablePrefix !== expectedPrefix) {
    errors.push(
      `tablePrefix "${manifest.tablePrefix}" no deriva de name "${manifest.name}" (esperado "${expectedPrefix}")`,
    );
  }
  if (manifest.apiNamespace !== expectedNamespace) {
    errors.push(
      `apiNamespace "${manifest.apiNamespace}" no deriva de name "${manifest.name}" (esperado "${expectedNamespace}")`,
    );
  }
  return errors;
}
