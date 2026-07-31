/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Contrato del store de secretos que el host expone a los módulos third-party
 * del marketplace. Introducido en alpha.56 (Sprint 4 / SE-001) para cerrar el
 * hueco descubierto al cablear el extract phase real del migrator-learndash:
 * el worker BullMQ invoca `onJobTick` con ctx fresco por cada tick, sin
 * estado in-process — necesita una forma de recuperar credenciales (WP
 * appPassword, futuras API keys de Stripe/Zoom/etc.) que no viven en
 * source_profile del job porque esa columna NO debe llevar secrets en claro.
 *
 * Antes de alpha.56 los módulos tenían dos opciones malas:
 *  1. Persistir el secret en su propia tabla con cripto ad-hoc — anti-pattern
 *     (cada módulo reinventaría AES + key management).
 *  2. Mantenerlo en memory in-process — explota con BullMQ porque el worker
 *     procesa ticks en procesos/instancias distintas al request que creó el job.
 *
 * Este contrato vive en archivo separado para que tres consumidores lo
 * compartan sin ciclos de import (mismo patrón que sandboxed-db.types y
 * sandboxed-jobs.types):
 *  1. `module-router.service.ts` — `ModuleRouteRequestContext.secrets`
 *  2. `modules-dispatcher.controller.ts` — construye `ctx.secrets` por request
 *  3. `sandboxed-secrets.service.ts` — `ScopedSecretsApiFactory` (impl real, SE-002)
 *
 * Reglas estructurales (todas impuestas por el host):
 *  - **Solo módulos con `requiresSecrets=true` en manifest** pueden usar
 *    `ctx.secrets`. Si no lo declara → recibe `BlockedSandboxedSecrets` que
 *    rechaza con `SECRETS_NOT_DECLARED` + mensaje accionable (cómo activarlo
 *    en el manifest y reinstalar).
 *  - **tenantId implícito**: el módulo NUNCA pasa `tenantId`. La factory lo
 *    extrae del request (mismo patrón que ScopedDidactaApi / ScopedJobsApi)
 *    y lo congela en la closure — cross-tenant leak imposible por descuido.
 *  - **moduleName implícito**: idéntico. El módulo no puede leer/escribir
 *    secrets de otro módulo — la factory lo congela.
 *  - **Routes anónimas reciben BlockedSandboxedSecrets**: invocaciones sin
 *    Bearer (preflight, ping) no tienen tenantId del JWT — secrets requiere
 *    tenant para scope, no aceptamos tenantId del body (vector spoofing).
 *  - **Cripto at-rest invisible al módulo**: el módulo lee/escribe plaintext;
 *    el host cifra/descifra en BD via SecretCipherService (AES-256-GCM con
 *    IV+tag). La key se resuelve via loadCipherKey() — env > file > file-new
 *    > ephemeral, sin fricción al primer install.
 *  - **`list()` NUNCA devuelve values**: solo metadata (key + expiresAt).
 *    Para leer un value hay que llamar `get(key)` explícitamente — un módulo
 *    bugueado que loguee el resultado de list() no leakea secretos.
 */

/// Códigos de error tipados que `ctx.secrets` puede lanzar. El módulo decide
/// qué hacer (propagar 503 al user, persistir el job como `failed`, etc.).
export type SecretsErrorCode =
  /// El manifest del módulo no declara `requiresSecrets: true`. El módulo
  /// NO puede usar `ctx.secrets` hasta que añada el campo al manifest y
  /// se reinstale.
  | 'SECRETS_NOT_DECLARED'
  /// La route que invocó `ctx.secrets` es anónima (sin Bearer). El host
  /// no puede determinar el tenantId sin JWT — secretos son tenant-scoped.
  /// Mover el handler a una route autenticada o no usar secretos en
  /// callbacks públicos (preflight, webhooks externos, etc.).
  | 'SECRETS_TENANT_REQUIRED'
  /// La key viola el formato exigido por el manifest (`allowedKeyPattern`
  /// o el regex base del core: solo `a-zA-Z0-9_-:.` y max 128 chars).
  | 'SECRETS_KEY_INVALID'
  /// El value excede `secretsLifecycle.maxValueBytes` declarado en el
  /// manifest (cap duro del core: 64 KB). El módulo debe partir el secret
  /// en varios values más chicos o reconsiderar el diseño.
  | 'SECRETS_VALUE_TOO_LARGE'
  /// El (tenant, módulo) ya tiene tantas keys vivas como
  /// `secretsLifecycle.maxKeys` declarado (default 32, cap duro 256). El
  /// módulo debe borrar keys viejas antes de escribir nuevas (típicamente
  /// pasa con job-scoped secrets que el módulo olvidó limpiar en cancel).
  | 'SECRETS_QUOTA_EXCEEDED'
  /// La key viola el `allowedKeyPattern` del manifest. Distinta de
  /// SECRETS_KEY_INVALID (que es formato base): esta es violación de la
  /// regex que el propio módulo declara como restricción adicional.
  | 'SECRETS_KEY_PATTERN_MISMATCH'
  /// Postgres rechazó la operación (red caída, OOM, contención).
  /// Transitorio — el módulo puede reintentar con backoff.
  | 'SECRETS_NETWORK';

export class SecretsError extends Error {
  constructor(
    public readonly code: SecretsErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SecretsError';
  }
}

/// Opciones del `set()`. Por ahora solo `expiresAt` — secrets job-scoped
/// (como WP appPassword) se setean con expiresAt = now + retentionDays.
/// El host filtra expired en get() y list(); un GC periódico los borra del
/// disco para que la quota no crezca indefinidamente con basura caducada.
export interface SetSecretOptions {
  /// Si está presente, después de esta fecha `get()` devuelve null y
  /// `list()` no incluye la key. El row físico vive hasta que el GC lo
  /// limpia (typically <24h después de expirar).
  expiresAt?: Date;
}

/// Metadata que `list()` devuelve por cada key — NUNCA incluye el value
/// (el módulo debe pedirlo explícitamente con `get()` para evitar leaks
/// accidentales en logs).
export interface SecretMeta {
  key: string;
  expiresAt: Date | null;
  /// Tamaño aproximado del value (bytes plaintext). Útil para el módulo
  /// que necesita decidir si está cerca del cap antes de escribir más.
  /// No es el tamaño del ciphertext en disco — el GCM cipher añade ~28 bytes
  /// de overhead pero al módulo NO le importa.
  approxValueBytes: number;
}

/// Cliente que el módulo recibe vía `ctx.secrets` en sus route handlers y
/// en `onJobTick`. Todas las ops son async (BD round trip) — el módulo
/// debe esperarlas. Cripto at-rest y key resolution son transparentes.
export interface SandboxedSecrets {
  /// Lee un secret descifrado. Devuelve null si no existe o si expiró
  /// (no distingue ambos casos para no leak info de "esta key existió
  /// en el pasado"). En caso de error de BD lanza SecretsError.
  get(key: string): Promise<string | null>;

  /// Crea o actualiza un secret. Idempotente — si la key ya existe,
  /// sobreescribe value + iv + tag + expiresAt + updatedAt. Si la key
  /// es nueva y el (tenant, módulo) ya tiene `secretsLifecycle.maxKeys`,
  /// lanza SECRETS_QUOTA_EXCEEDED.
  set(key: string, value: string, opts?: SetSecretOptions): Promise<void>;

  /// Borra un secret. Silente si no existe (idempotente — repetir el
  /// delete tras un crash no es error). Sí lanza si BD falla.
  delete(key: string): Promise<void>;

  /// Lista metadata de todos los secrets vivos (no expirados) del
  /// (tenant, módulo). Útil para que un módulo verifique qué tiene
  /// guardado antes de decidir un cleanup masivo. NUNCA devuelve values.
  list(): Promise<SecretMeta[]>;
}

/// Caps duros del core para `ctx.secrets`. Mirror de DB_CAPS/HTTP_CAPS en
/// module-manifest.schema.ts. Cualquier cambio aquí requiere actualizar
/// los dos sitios + bumpar la versión del paquete @didacta/module-package-spec.
export const SECRETS_CAPS = {
  /// Tope de keys vivas por (tenant, módulo). Default razonable 32; cap
  /// duro 256. Más que esto es señal de diseño raro — los módulos
  /// típicos guardan 1-3 keys (API credentials), no cientos.
  MAX_KEYS_PER_MODULE: 256,
  /// Tope de bytes del value plaintext. Default razonable 8 KB; cap duro
  /// 64 KB. Más que esto es probable que el módulo esté tratando de
  /// usar secrets como caché o storage de blobs — usá `ctx.db` para eso.
  MAX_VALUE_BYTES: 64 * 1024,
  /// Tope de la key (chars). Las keys viajan en logs y métricas — más
  /// largo es señal de que el módulo está embebiendo datos en la key
  /// (anti-pattern; usá UUIDs o slugs cortos + meta dentro del value).
  MAX_KEY_LENGTH: 128,
} as const;

/// Regex base que TODAS las keys deben cumplir, sin importar lo que diga
/// el manifest. Pensado para keys legibles en logs sin escapado raro y
/// composable con namespaces (`prefix:subkey`). El módulo puede declarar
/// `allowedKeyPattern` para reforzar MÁS (típicamente para forzar prefijos
/// que indiquen scope, ej. `^job:[a-f0-9-]+:learndash:.+$`).
export const SECRETS_BASE_KEY_REGEX = /^[a-zA-Z0-9_\-:.]{1,128}$/;

/// Implementación que el host inyecta cuando el módulo NO declara
/// `requiresSecrets: true`. Cualquier intento de uso falla con un
/// SecretsError que explica exactamente qué hay que añadir al manifest.
export class BlockedSandboxedSecrets implements SandboxedSecrets {
  constructor(private readonly moduleName: string) {}

  private fail(op: string): never {
    throw new SecretsError(
      'SECRETS_NOT_DECLARED',
      `El módulo "${this.moduleName}" no declara "requiresSecrets" en su manifest. ` +
        `Para usar ctx.secrets.${op}(...) añadí: "requiresSecrets": true al manifest ` +
        `(opcional: "secretsLifecycle": { "maxKeys": N, "maxValueBytes": M, ` +
        `"allowedKeyPattern": "^prefix:.+$" }), bumpealo de versión, re-firmá el ZIP, y reinstalalo.`,
    );
  }

  async get(_key: string): Promise<string | null> {
    this.fail('get');
  }
  async set(_key: string, _value: string, _opts?: SetSecretOptions): Promise<void> {
    this.fail('set');
  }
  async delete(_key: string): Promise<void> {
    this.fail('delete');
  }
  async list(): Promise<SecretMeta[]> {
    this.fail('list');
  }
}

/// Implementación que el host inyecta cuando la route es anónima (sin
/// Bearer) — el host no puede determinar el tenantId sin JWT. Distinta
/// de Blocked* porque el módulo SÍ declara requiresSecrets, simplemente
/// la invocación cae en un contexto que no soporta secretos.
export class AnonymousSandboxedSecrets implements SandboxedSecrets {
  constructor(private readonly moduleName: string) {}

  private fail(op: string): never {
    throw new SecretsError(
      'SECRETS_TENANT_REQUIRED',
      `El módulo "${this.moduleName}" invocó ctx.secrets.${op}(...) en una route anónima ` +
        `(sin Bearer JWT). Los secretos son tenant-scoped y el host no acepta tenantId del ` +
        `body para evitar spoofing. Mové el handler a una route que requiera auth, o leé ` +
        `el secreto desde un handler autenticado previo y pasalo por parámetro.`,
    );
  }

  async get(_key: string): Promise<string | null> {
    this.fail('get');
  }
  async set(_key: string, _value: string, _opts?: SetSecretOptions): Promise<void> {
    this.fail('set');
  }
  async delete(_key: string): Promise<void> {
    this.fail('delete');
  }
  async list(): Promise<SecretMeta[]> {
    this.fail('list');
  }
}
