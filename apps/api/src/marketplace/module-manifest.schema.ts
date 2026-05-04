import { z } from 'zod';

/// Schema Zod del manifest de un módulo `*.zip`.
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

/// Surfaces donde un módulo puede exponer UI. Cada surface corresponde a un
/// rol/contexto del sistema: admin (backoffice), formador (instructor view),
/// alumno (student view), auditor (reporting), empresa_manager (B2B).
export const MODULE_SURFACES = ['admin', 'formador', 'alumno', 'auditor', 'empresa_manager'] as const;
export type ModuleSurface = (typeof MODULE_SURFACES)[number];

/// Tipos de campos soportados en config.schema para generación de forms.
export const CONFIG_FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'url',
  'email',
  'secret',
  'select',
  'multiselect',
  'textarea',
  'json',
] as const;
export type ConfigFieldType = (typeof CONFIG_FIELD_TYPES)[number];

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

// ─────────────────────────────────────────────────────────────────────────────
// Schema para HTTP saliente (alpha.49)
// ─────────────────────────────────────────────────────────────────────────────
//
// Si el módulo necesita hacer requests HTTP a sistemas externos (ej.
// migrator-learndash → WordPress origen del cliente, mod.zoom → API de
// Zoom), debe declarar el bloque `http` en su manifest. Sin él, los
// handlers que invoquen `ctx.http.get/post(...)` reciben un cliente que
// rechaza TODA URL con `HTTP_BLOCKED_HOST`.
//
// Caps duros del core: NO se pueden superar declarando un valor más alto
// en el manifest. Si lo hacés, el manifest se rechaza con `MANIFEST_INVALID`.
// La razón es defense-in-depth — un módulo malicioso podría declarar
// `requestsPerSecond: 10000` para tirar a un upstream. El dev legítimo
// que necesite throughput mayor abre un PR al core para subir el cap
// global o pide whitelist explícita por (módulo, host).

/// Caps duros del cliente HTTP scoped a un módulo. Mirror de los defaults
/// + caps en `sandboxed-http.types.ts` (alpha.49). Cualquier cambio
/// requiere actualizar los dos sitios + bumpar la versión del paquete
/// `@didacta/module-package-spec` (caps son parte del contrato público).
export const HTTP_CAPS = {
  /// Tope de requests por segundo por (módulo, host). Más alto que esto
  /// ya está abusando del upstream (5rps contra una API es muchísimo).
  /// Si necesitás más, hablá con el upstream o usá batching/bulk endpoints.
  MAX_REQUESTS_PER_SECOND: 50,
  /// Tope de burst del token bucket. Permite ráfagas cortas sobre el rate
  /// medio sin bloquear inmediatamente.
  MAX_BURST: 100,
  /// Tope del body de respuesta (bytes). 100 MB. Más que esto no se
  /// procesa en memoria — usá streaming externo.
  MAX_BODY_BYTES: 100 * 1024 * 1024,
} as const;

const httpRateLimitSchema = z
  .object({
    requestsPerSecond: z
      .number()
      .int()
      .min(1)
      .max(HTTP_CAPS.MAX_REQUESTS_PER_SECOND, {
        message: `requestsPerSecond no puede superar ${HTTP_CAPS.MAX_REQUESTS_PER_SECOND} (cap del core).`,
      }),
    burst: z
      .number()
      .int()
      .min(1)
      .max(HTTP_CAPS.MAX_BURST, {
        message: `burst no puede superar ${HTTP_CAPS.MAX_BURST} (cap del core).`,
      }),
  })
  .strict();

const httpSchema = z
  .object({
    /// Lista de hosts contra los que el módulo puede hacer requests.
    /// Wildcard `*` permite cualquier host (subject al SSRF guard que
    /// igual bloquea privadas/loopback). Para usar `*` hay que poner
    /// `unrestrictedHosts: true` como reconocimiento explícito.
    /// Hosts específicos: `wp.cliente.com` (exacto), `*.cliente.com`
    /// (subdominios). Sin scheme ni path — solo el host.
    allowedHosts: z
      .array(
        z
          .string()
          .min(1)
          .max(253) // RFC 1035 limit
          .regex(/^(\*|(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i, {
            message:
              'Host inválido. Usá `*`, `dominio.tld`, o `*.dominio.tld` (sin scheme ni path).',
          }),
      )
      .min(1)
      .max(20),
    /// REQUIRED si `allowedHosts` contiene `*`. Refuerzo: el dev tiene
    /// que reconocer explícitamente que el módulo puede salir a cualquier
    /// host. Para módulos con destino conocido (Zoom, Stripe, Fundae),
    /// debe ser `false` o omitido.
    unrestrictedHosts: z.boolean().optional(),
    rateLimitPerHost: httpRateLimitSchema,
    /// Tope del body de respuesta (bytes) para requests del módulo.
    /// Si una respuesta excede este valor, el cliente aborta el stream y
    /// lanza HTTP_BODY_TOO_LARGE. Cap del core: 100 MB.
    maxBodyBytes: z
      .number()
      .int()
      .min(1024) // 1 KB mínimo — si necesitás menos, hay un bug en el handler
      .max(HTTP_CAPS.MAX_BODY_BYTES, {
        message: `maxBodyBytes no puede superar ${HTTP_CAPS.MAX_BODY_BYTES} bytes (100 MB cap del core).`,
      }),
  })
  .strict()
  .refine(
    (h) => !h.allowedHosts.includes('*') || h.unrestrictedHosts === true,
    {
      message:
        'Si allowedHosts contiene "*", debés declarar unrestrictedHosts: true como reconocimiento explícito de que el módulo puede salir a cualquier host (sujeto al SSRF guard del core).',
      path: ['unrestrictedHosts'],
    },
  );

// ─────────────────────────────────────────────────────────────────────────────
// Schemas para UI Surfaces (DISC-001.5)
// ─────────────────────────────────────────────────────────────────────────────

const routeSchema = z.object({
  path: z.string().min(1).max(200),
  component: z.string().min(1).max(200),
  roles: z.array(z.string().min(1).max(60)).max(20).default([]),
});

const menuSchema = z.object({
  label: z.string().min(1).max(60),
  icon: z.string().min(1).max(60).optional(),
  order: z.number().int().min(0).max(9999).default(100),
});

const surfaceSchema = z.object({
  entry: z.string().min(1).max(200),
  roles: z.array(z.string().min(1).max(60)).max(20).default([]),
  routes: z.array(routeSchema).max(50).default([]),
  menu: menuSchema.optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema para Config (form auto-generado)
// ─────────────────────────────────────────────────────────────────────────────

const selectOptionSchema = z.object({
  value: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
});

const configFieldSchema = z.object({
  type: z.enum(CONFIG_FIELD_TYPES),
  label: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  placeholder: z.string().max(200).optional(),
  // String constraints
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).optional(),
  pattern: z.string().max(500).optional(),
  // Number constraints
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  // Select/Multiselect
  options: z.array(selectOptionSchema).max(100).optional(),
  // Textarea/JSON
  rows: z.number().int().min(1).max(50).optional(),
  // JSON schema validation (for type: 'json')
  schema: z.record(z.unknown()).optional(),
});

const moduleConfigSchema = z.record(z.string().min(1).max(60), configFieldSchema).optional();

// ─────────────────────────────────────────────────────────────────────────────
// Schema para Assets
// ─────────────────────────────────────────────────────────────────────────────

const assetsSchema = z.object({
  icon: z.string().max(200).optional(),
  banner: z.string().max(200).optional(),
  screenshots: z.array(z.string().max(200)).max(10).default([]),
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
    /// signedAt es opcional para módulos de subida directa (DISC-002).
    /// Solo presente si el módulo fue firmado por el marketplace.
    signedAt: z
      .string()
      .datetime({ offset: true, message: 'signedAt debe ser ISO-8601 con offset' })
      .optional(),
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

    // UI Surfaces (DISC-001.5): cada surface tiene su bundle en dist/ui/<surface>.js
    surfaces: z
      .record(
        z.enum(MODULE_SURFACES),
        surfaceSchema.nullable(), // null para desactivar una surface heredada
      )
      .optional(),

    // Config schema: define los campos configurables del módulo
    config: moduleConfigSchema,

    // Assets: iconos, banners, screenshots para el marketplace
    assets: assetsSchema.optional(),

    // HTTP saliente (alpha.49). Opcional — si falta, el módulo recibe un
    // cliente que rechaza toda URL con HTTP_BLOCKED_HOST (defensa: módulos
    // que no piden http no obtienen http).
    http: httpSchema.optional(),
  })
  .strict();

export type ModuleManifest = z.infer<typeof moduleManifestSchema>;
export type ModuleHttpConfig = z.infer<typeof httpSchema>;
export type ModuleSurfaceConfig = z.infer<typeof surfaceSchema>;
export type ModuleConfigField = z.infer<typeof configFieldSchema>;
export type ModuleAssets = z.infer<typeof assetsSchema>;

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

/// Valida que las surfaces declaradas en el manifest tengan sus bundles UI
/// presentes en el ZIP. Los bundles deben estar en dist/ui/<surface>.js.
///
/// @param manifest - El manifest del módulo
/// @param zipEntries - Set de paths de archivos en el ZIP
/// @returns Array de errores (vacío si todo OK)
export function validateSurfaceBundles(
  manifest: ModuleManifest,
  zipEntries: Set<string>,
): string[] {
  const errors: string[] = [];

  if (!manifest.surfaces) {
    return errors;
  }

  for (const [surface, config] of Object.entries(manifest.surfaces)) {
    // null significa que la surface está explícitamente desactivada
    if (config === null) continue;

    const expectedBundle = `dist/ui/${surface}.js`;
    if (!zipEntries.has(expectedBundle)) {
      errors.push(
        `Surface "${surface}" declarada pero falta bundle UI: ${expectedBundle}`,
      );
    }
  }

  return errors;
}
