/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { z } from 'zod';
import { MODULE_SURFACES } from '@didacta/module-package-spec';
import {
  DIDACTA_EXTERNAL_SOURCE_REGEX,
  DIDACTA_PERMISSIONS,
  type DidactaPermission,
} from './sandboxed-didacta.types.js';
import { SECRETS_CAPS } from './sandboxed-secrets.types.js';

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

/// Surfaces donde un módulo puede exponer UI.
///
/// La lista NO vive aquí: vive en `@didacta/module-package-spec`, que es el
/// contrato que importan también `module-doctor` y los packagers de terceros.
/// Tenerla solo aquí fue lo que permitió que `modules/theming` declarase
/// durante meses una superficie inexistente (`student`) sin que fallara nada:
/// los `module.json` internos no pasan por este esquema.
export { MODULE_SURFACES, type ModuleSurface } from '@didacta/module-package-spec';

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
/// Caps duros del cliente de BD scoped a un módulo (alpha.51). Mirror
/// de los defaults + caps en `sandboxed-db.types.ts`. Cualquier cambio
/// requiere actualizar los dos sitios.
export const DB_CAPS = {
  /// Tope del timeout por query (ms). 10s. Más alto sería I/O bloqueante
  /// mal diseñado.
  MAX_QUERY_TIMEOUT_MS: 10_000,
  /// Tope de filas devueltas por SELECT. 10_000. Para volúmenes mayores
  /// el módulo debe paginar.
  MAX_ROWS: 10_000,
  /// Tope del statement SQL (chars). 50 KB.
  MAX_STATEMENT_LENGTH: 50_000,
} as const;

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
  .refine((h) => !h.allowedHosts.includes('*') || h.unrestrictedHosts === true, {
    message:
      'Si allowedHosts contiene "*", debés declarar unrestrictedHosts: true como reconocimiento explícito de que el módulo puede salir a cualquier host (sujeto al SSRF guard del core).',
    path: ['unrestrictedHosts'],
  });

// ─────────────────────────────────────────────────────────────────────────────
// Schema para ctx.didacta (alpha.52, Sprint 2 / DD-001)
// ─────────────────────────────────────────────────────────────────────────────
//
// Si el módulo necesita crear o actualizar entidades del core (users, courses,
// lessons, enrollments, etc.), debe declarar el bloque `didacta` en su
// manifest con dos campos obligatorios:
//
//  - `externalSource`: identifica el origen de las entidades importadas. Ej.
//    "learndash" para mod.migrator-learndash. Forma parte de la clave de
//    idempotencia (junto a `externalId`) por lo que NO debe cambiar entre
//    versiones del módulo — si cambia, los upserts del job actual ven datos
//    de cero (otro `external_source`) y van a duplicar entidades.
//  - `permissions`: lista cerrada de métodos a los que el módulo puede
//    invocar. Cualquier llamada a un método NO declarado → DIDACTA_PERMISSION_DENIED.
//    Defense-in-depth: aunque el TS lo permita, el host valida en runtime.
//
// Cualquier permiso fuera de DIDACTA_PERMISSIONS → manifest inválido. La
// lista completa está en `sandboxed-didacta.types.ts` para que módulos y
// host la importen del mismo lugar.

const didactaSchema = z
  .object({
    /// Source del módulo origen (lower-snake-case, max 40 chars). Ej.
    /// "learndash". Forma parte de la clave de idempotencia.
    externalSource: z.string().min(1).max(40).regex(DIDACTA_EXTERNAL_SOURCE_REGEX, {
      message:
        'externalSource inválido. Usá lower-snake-case (a-z 0-9 _ -), max 40 chars. Ej: "learndash", "moodle", "thinkific".',
    }),
    /// Lista de métodos permitidos. Cualquier valor fuera de
    /// DIDACTA_PERMISSIONS → manifest rechazado.
    permissions: z
      .array(z.enum(DIDACTA_PERMISSIONS as readonly [DidactaPermission, ...DidactaPermission[]]))
      .min(1)
      .max(DIDACTA_PERMISSIONS.length),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Schema para jobLifecycle — onJobTick worker (Sprint 3 / JR-003)
// ─────────────────────────────────────────────────────────────────────────────
//
// Si el módulo necesita ejecutar trabajo de larga duración fuera del ciclo
// de un request HTTP (ej. mod.migrator-learndash importando 5_000 cursos
// de WordPress), declara el bloque `jobLifecycle` con el nombre de la
// función que el host debe invocar en cada tick. La función vive en el
// `dist/index.js` del bundle y recibe un `ctx` similar al de un request
// (db, http, didacta scoped) más { jobId, tenantId, tickIndex }. Retorna
// `{ status: 'continue' | 'completed' | 'failed' }` para indicar al
// worker qué hacer a continuación.
//
// Reglas:
//   - Si el manifest declara `jobLifecycle` pero el bundle NO exporta la
//     función referenciada → MODULE_BOOT_FAILED (rechazo en install).
//   - Si el manifest declara `requiresDb=true` y/o `didacta` PERO NO
//     `jobLifecycle`, el host emite warning en boot — esos recursos
//     suelen acompañar jobs largos, y un módulo síncrono que los
//     declare puede ser un anti-pattern (procesamiento en handlers HTTP).
//     El warning NO bloquea el install.
//   - El cap `maxTicksPerHour` actúa como circuit breaker contra bucles
//     infinitos: si un módulo con bug retorna `continue` para siempre
//     sin avanzar trabajo, el worker lo abortará al superar el cap (la
//     enforcement vive en el worker, esto solo declara el límite).
//     Default 600 = 1 tick cada 6s en promedio. Cap duro 3600 = 1/s.

const jobLifecycleSchema = z
  .object({
    /// Nombre del export en `module.exports` que el worker invoca por
    /// cada tick. Debe ser un identifier JS válido — el sandbox lo lee
    /// con `module.exports[onTickFn]` (sin eval).
    onTickFn: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, {
        message: 'onTickFn debe ser un identifier JS válido (^[a-zA-Z_][a-zA-Z0-9_]*$).',
      }),
    /// Tope de ticks por hora — defensa anti-bucle infinito. Default
    /// 600 (1 tick/6s en media). Cap duro 3600.
    maxTicksPerHour: z.number().int().min(1).max(3600).default(600).optional(),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Schema para ctx.secrets — store de credenciales cifradas (alpha.56 / SE-001)
// ─────────────────────────────────────────────────────────────────────────────
//
// Si el módulo necesita persistir credenciales del usuario (WP appPassword del
// migrator, futuras API keys de mod.stripe/mod.zoom-live/mod.fundae), declara
// `requiresSecrets: true`. Sin él, el host inyecta `BlockedSandboxedSecrets`
// y cualquier `ctx.secrets.get/set/delete/list(...)` rechaza con mensaje
// accionable que explica cómo activarlo.
//
// El bloque `secretsLifecycle` es opcional — si falta, se aplican los
// defaults razonables (maxKeys=32, maxValueBytes=8 KB, sin restricción de
// pattern más allá del regex base del core). Cuando está, el módulo declara
// caps más estrictos para auto-defenderse:
//
//   - `maxKeys`: tope de keys vivas para este módulo en este tenant. Cap
//     duro del core SECRETS_CAPS.MAX_KEYS_PER_MODULE=256. Más allá de 32
//     suele ser señal de leak (job-scoped que el módulo olvida limpiar).
//
//   - `maxValueBytes`: tope del value plaintext. Cap duro SECRETS_CAPS.
//     MAX_VALUE_BYTES=64 KB. Más allá de 8 KB suele ser uso indebido
//     (caché o storage de blobs — usá ctx.db para eso).
//
//   - `allowedKeyPattern`: regex que TODA key seteada debe matchear (además
//     del SECRETS_BASE_KEY_REGEX del core). Útil para forzar prefijos que
//     indiquen scope, ej. `^job:[a-f0-9-]+:learndash:.+$` para garantizar
//     que el módulo solo escriba secrets job-scoped y nunca tenant-globales
//     sin pensar.
//
// Cripto at-rest y key resolution son transparentes al módulo — los hace
// el host con `SecretCipherService` (AES-256-GCM) + `loadCipherKey()`
// (env > file > file-new > ephemeral, sin fricción al primer install).

const secretsLifecycleSchema = z
  .object({
    maxKeys: z
      .number()
      .int()
      .min(1)
      .max(SECRETS_CAPS.MAX_KEYS_PER_MODULE, {
        message: `maxKeys no puede superar ${SECRETS_CAPS.MAX_KEYS_PER_MODULE} (cap del core).`,
      })
      .default(32)
      .optional(),
    maxValueBytes: z
      .number()
      .int()
      .min(1)
      .max(SECRETS_CAPS.MAX_VALUE_BYTES, {
        message: `maxValueBytes no puede superar ${SECRETS_CAPS.MAX_VALUE_BYTES} (cap del core: 64 KB).`,
      })
      .default(8 * 1024)
      .optional(),
    /// Regex extra que TODA key debe matchear (además del regex base del
    /// core que valida charset y longitud). El módulo lo usa para forzar
    /// prefijos que indiquen scope (job-scoped vs tenant-scoped) y evitar
    /// que un bug propio le haga escribir keys con shape inesperado.
    allowedKeyPattern: z
      .string()
      .min(1)
      .max(500)
      .refine(
        (p) => {
          try {
            new RegExp(p);
            return true;
          } catch {
            return false;
          }
        },
        { message: 'allowedKeyPattern debe ser una expresión regular JavaScript válida.' },
      )
      .optional(),
  })
  .strict();

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

    // ctx.db scoped al tablePrefix del módulo (alpha.51). Cuando es true,
    // el dispatcher cablea un SandboxedDbService que aplica SQL guard:
    // toda query DEBE referenciar solo tablas que empiezan con
    // `tablePrefix`. DDL prohibida (CREATE/DROP/ALTER) — la estructura
    // viene de prisma/migrations/*.sql aplicadas en install (ADR-013).
    // Si false/undefined, el módulo recibe BlockedSandboxedDb con mensaje
    // accionable explicando cómo activarlo.
    requiresDb: z.boolean().optional(),

    // ctx.didacta — API pública del core (alpha.52, Sprint 2). Permite
    // al módulo crear/upsertear users/courses/lessons/enrollments del
    // core sin tocar Prisma directo. Idempotencia por (externalSource,
    // externalId). Permission matrix declarada explícitamente. Si falta
    // el bloque, el módulo recibe BlockedDidactaApi con mensaje accionable.
    didacta: didactaSchema.optional(),

    // jobLifecycle — onJobTick worker (Sprint 3 / JR-003). Si el módulo
    // declara este bloque, el host registra el handler exportado bajo
    // `manifest.jobLifecycle.onTickFn` en el ModuleJobLifecycleRegistry
    // y lo invoca por cada job de la queue `didacta.mod-jobs` que
    // referencia al módulo. Si el bundle NO exporta esa función → el
    // install falla con MODULE_BOOT_FAILED (validado en sandbox).
    jobLifecycle: jobLifecycleSchema.optional(),

    // ctx.secrets — store de credenciales cifradas (alpha.56 / SE-001).
    // Si true, el dispatcher cablea un ScopedSecretsApi que el módulo
    // recibe en ctx.secrets para guardar/leer secretos at-rest (AES-256-GCM,
    // tenant + módulo scoped). Sin él, el módulo recibe BlockedSandboxedSecrets
    // con mensaje accionable explicando cómo activarlo.
    requiresSecrets: z.boolean().optional(),

    // Configuración opcional del lifecycle de secrets — caps que el módulo
    // se auto-impone (más estrictos que los del core) + pattern de keys
    // permitido para reforzar disciplina (ej. forzar prefijo `job:<uuid>:`
    // para que el módulo solo escriba secrets job-scoped por accidente).
    // Solo aplica si requiresSecrets=true.
    secretsLifecycle: secretsLifecycleSchema.optional(),
  })
  .strict()
  .refine((m) => m.secretsLifecycle === undefined || m.requiresSecrets === true, {
    message:
      'secretsLifecycle declarado sin requiresSecrets=true. Si tu módulo necesita secrets, ' +
      'añadí "requiresSecrets": true al manifest; si no, eliminá el bloque secretsLifecycle.',
    path: ['secretsLifecycle'],
  })
  .refine((m) => m.surfaces?.publico === undefined || m.surfaces.publico === null, {
    // La superficie `publico` se renderiza en servidor desde el registro
    // ESTÁTICO del web (`apps/web/src/modules/*`), no desde el bundle IIFE que
    // se evalúa en el navegador. Un módulo instalado como ZIP no participa en
    // ese registro, así que declararla aquí no renderizaría nada: mejor
    // rechazarlo que aceptar un no-op silencioso.
    message:
      'La superficie "publico" no está soportada en módulos instalados desde el marketplace: ' +
      'requiere renderizado en servidor, que hoy solo tienen los módulos internos del monorepo. ' +
      'Quitá el bloque surfaces.publico del manifest.',
    path: ['surfaces', 'publico'],
  });

export type ModuleManifest = z.infer<typeof moduleManifestSchema>;
export type ModuleDidactaConfig = z.infer<typeof didactaSchema>;
export type ModuleHttpConfig = z.infer<typeof httpSchema>;
export type ModuleSurfaceConfig = z.infer<typeof surfaceSchema>;
export type ModuleConfigField = z.infer<typeof configFieldSchema>;
export type ModuleAssets = z.infer<typeof assetsSchema>;
export type ModuleJobLifecycleConfig = z.infer<typeof jobLifecycleSchema>;
export type ModuleSecretsLifecycleConfig = z.infer<typeof secretsLifecycleSchema>;

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
      errors.push(`Surface "${surface}" declarada pero falta bundle UI: ${expectedBundle}`);
    }
  }

  return errors;
}
