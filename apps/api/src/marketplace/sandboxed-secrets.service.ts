import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretCipherService } from '../modules/secret-cipher.service';
import type { ModuleSecretsLifecycleConfig } from './module-manifest.schema';
import {
  AnonymousSandboxedSecrets,
  BlockedSandboxedSecrets,
  SECRETS_BASE_KEY_REGEX,
  SECRETS_CAPS,
  SecretsError,
  type SandboxedSecrets,
  type SecretMeta,
  type SecretsErrorCode,
  type SetSecretOptions,
} from './sandboxed-secrets.types';

/**
 * Implementación real del cliente de secrets que el host expone a los módulos
 * third-party del marketplace (alpha.56 — task SE-002 del plan ctx.secrets).
 *
 * Mismo patrón que `SandboxedDbService` (alpha.51) y `ScopedDidactaApiFactory`
 * (alpha.52): NO es un inyectable singleton para los módulos. Cada (módulo,
 * request | onInstall | onJobTick) recibe una instancia scoped via `build()`
 * que congela `moduleName` + `tenantId` + `lifecycleConfig` en la closure —
 * cross-tenant / cross-module leak imposible por descuido del módulo.
 *
 * Cripto: reusa `SecretCipherService` (AES-256-GCM con IV+tag), ya probado
 * para `tenant_setting`. La key se resuelve via `loadCipherKey()` que
 * implementa el patrón "sin fricción al primer install" (env > file >
 * file-new persistido a `${STORAGE_ROOT}/.didacta-secret-key` con 0600 >
 * ephemeral fallback).
 *
 * Cap policy:
 *   1. Cap base del core (SECRETS_CAPS) — el manifest NO puede superar esto.
 *      Validado en module-manifest.schema.ts al validar el ZIP.
 *   2. Cap del manifest (lifecycleConfig) — más estricto que el del core.
 *      Si el módulo no declara nada, defaults razonables (32 keys / 8 KB).
 *   3. Run-time enforcement aquí — counts vía SELECT antes de INSERT nuevo,
 *      tamaños vía byte count, regex en cada key.
 *
 * Expiry: get() y list() filtran rows con `expires_at <= NOW()` en la query.
 * El row físico vive hasta que el GC lo limpia (Sprint 5+ si aparece el caso).
 * Mientras tanto, el módulo no los ve pero ocupan slot en la quota —
 * comportamiento aceptable para keys job-scoped que el módulo limpia
 * explícitamente al cerrar el job (caso normal).
 */

/// Defaults aplicados cuando el manifest no declara `secretsLifecycle`.
/// Mirror de los defaults declarados en module-manifest.schema.ts —
/// cualquier cambio aquí requiere actualizar los dos sitios.
export const SECRETS_DEFAULTS = {
  MAX_KEYS: 32,
  MAX_VALUE_BYTES: 8 * 1024,
} as const;

@Injectable()
export class ScopedSecretsApiFactory {
  private readonly logger = new Logger(ScopedSecretsApiFactory.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipherService,
  ) {}

  /// Construye un cliente de secrets scoped a un módulo y tenant. `tenantId`
  /// DEBE venir resuelto del JWT del request (TenantContextService). Si la
  /// route es anónima (sin Bearer), el caller debe inyectar
  /// `AnonymousSandboxedSecrets` en su lugar — esta factory NO acepta null.
  build(
    moduleName: string,
    tenantId: string,
    lifecycleConfig: ModuleSecretsLifecycleConfig | undefined,
  ): SandboxedSecrets {
    if (!tenantId) {
      // Defense-in-depth: el caller debe haber elegido AnonymousSandboxedSecrets,
      // pero si llegó aquí con tenantId vacío preferimos fallar antes que
      // escribir un row con tenant_id = '' (que viola la columna UUID NOT NULL
      // de todos modos, pero el mensaje será claro).
      throw new SecretsError(
        'SECRETS_TENANT_REQUIRED',
        `ScopedSecretsApiFactory.build(${moduleName}): tenantId vacío. ` +
          `Si la route es anónima, inyectá AnonymousSandboxedSecrets en lugar de llamar a build().`,
      );
    }
    return new ScopedSecretsApi(this.prisma, this.cipher, moduleName, tenantId, lifecycleConfig, this.logger);
  }

  /// Helper para el dispatcher: decidir si construye real o devuelve el
  /// stub apropiado. Centralizado para que las tres call sites (dispatcher
  /// route handler, install lifecycle, job runner) tomen la misma decisión.
  resolve(
    moduleName: string,
    tenantId: string | null,
    requiresSecrets: boolean,
    lifecycleConfig: ModuleSecretsLifecycleConfig | undefined,
  ): SandboxedSecrets {
    if (!requiresSecrets) return new BlockedSandboxedSecrets(moduleName);
    if (!tenantId) return new AnonymousSandboxedSecrets(moduleName);
    return this.build(moduleName, tenantId, lifecycleConfig);
  }
}

/// Implementación real. Privada al archivo — el dispatcher invoca via
/// `ScopedSecretsApiFactory.build()`, los módulos via el `SandboxedSecrets`
/// que reciben en `ctx.secrets`.
class ScopedSecretsApi implements SandboxedSecrets {
  private readonly maxKeys: number;
  private readonly maxValueBytes: number;
  private readonly allowedKeyPattern: RegExp | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipherService,
    private readonly moduleName: string,
    private readonly tenantId: string,
    lifecycleConfig: ModuleSecretsLifecycleConfig | undefined,
    private readonly logger: Logger,
  ) {
    this.maxKeys = lifecycleConfig?.maxKeys ?? SECRETS_DEFAULTS.MAX_KEYS;
    this.maxValueBytes = lifecycleConfig?.maxValueBytes ?? SECRETS_DEFAULTS.MAX_VALUE_BYTES;
    this.allowedKeyPattern = lifecycleConfig?.allowedKeyPattern
      ? new RegExp(lifecycleConfig.allowedKeyPattern)
      : undefined;
  }

  async get(key: string): Promise<string | null> {
    this.validateKey(key);
    try {
      const row = await this.prisma.modSecret.findFirst({
        where: {
          tenantId: this.tenantId,
          moduleId: this.moduleName,
          secretKey: key,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { ciphertext: true, iv: true, tag: true },
      });
      if (!row) return null;
      return this.cipher.decrypt({
        cipher: Buffer.from(row.ciphertext),
        iv: Buffer.from(row.iv),
        tag: Buffer.from(row.tag),
      });
    } catch (e) {
      throw this.mapError(e, 'get', key);
    }
  }

  async set(key: string, value: string, opts: SetSecretOptions = {}): Promise<void> {
    this.validateKey(key);
    const valueBytes = Buffer.byteLength(value, 'utf8');
    if (valueBytes > this.maxValueBytes) {
      throw new SecretsError(
        'SECRETS_VALUE_TOO_LARGE',
        `set(${key}): value de ${valueBytes} bytes excede el cap del manifest (${this.maxValueBytes} bytes). ` +
          `Cap duro del core: ${SECRETS_CAPS.MAX_VALUE_BYTES} bytes. ` +
          `Si el módulo necesita almacenar más, partí el secret en varios values más chicos o reconsiderá el diseño.`,
      );
    }
    try {
      const enc = this.cipher.encrypt(value);
      // Comprobamos quota SOLO si la key es nueva — UPDATE de existente
      // no aumenta el count. Si SELECT exists devuelve true vamos directo a
      // UPDATE; si false, COUNT para verificar cap antes de INSERT.
      const existing = await this.prisma.modSecret.findFirst({
        where: { tenantId: this.tenantId, moduleId: this.moduleName, secretKey: key },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.modSecret.update({
          where: { id: existing.id },
          data: {
            ciphertext: enc.cipher,
            iv: enc.iv,
            tag: enc.tag,
            approxValueBytes: valueBytes,
            expiresAt: opts.expiresAt ?? null,
          },
        });
        return;
      }
      const count = await this.prisma.modSecret.count({
        where: { tenantId: this.tenantId, moduleId: this.moduleName },
      });
      if (count >= this.maxKeys) {
        throw new SecretsError(
          'SECRETS_QUOTA_EXCEEDED',
          `set(${key}): el módulo "${this.moduleName}" ya tiene ${count} keys en este tenant (cap del manifest: ${this.maxKeys}). ` +
            `Borrá keys viejas con delete() antes de escribir nuevas. ` +
            `Si todas son legítimas, subí maxKeys en secretsLifecycle del manifest (cap duro del core: ${SECRETS_CAPS.MAX_KEYS_PER_MODULE}).`,
        );
      }
      await this.prisma.modSecret.create({
        data: {
          tenantId: this.tenantId,
          moduleId: this.moduleName,
          secretKey: key,
          ciphertext: enc.cipher,
          iv: enc.iv,
          tag: enc.tag,
          approxValueBytes: valueBytes,
          expiresAt: opts.expiresAt ?? null,
        },
      });
    } catch (e) {
      if (e instanceof SecretsError) throw e;
      throw this.mapError(e, 'set', key);
    }
  }

  async delete(key: string): Promise<void> {
    this.validateKey(key);
    try {
      await this.prisma.modSecret.deleteMany({
        where: { tenantId: this.tenantId, moduleId: this.moduleName, secretKey: key },
      });
    } catch (e) {
      throw this.mapError(e, 'delete', key);
    }
  }

  async list(): Promise<SecretMeta[]> {
    try {
      const rows = await this.prisma.modSecret.findMany({
        where: {
          tenantId: this.tenantId,
          moduleId: this.moduleName,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { secretKey: true, expiresAt: true, approxValueBytes: true },
        orderBy: { secretKey: 'asc' },
      });
      return rows.map((r) => ({
        key: r.secretKey,
        expiresAt: r.expiresAt,
        approxValueBytes: r.approxValueBytes,
      }));
    } catch (e) {
      throw this.mapError(e, 'list', '*');
    }
  }

  /// Valida key contra el regex base del core + el regex extra del manifest.
  /// Lanza SecretsError directamente — el módulo no debería poder hacer
  /// nada útil con una key inválida más allá de "arreglar la key".
  private validateKey(key: string): void {
    if (typeof key !== 'string' || !SECRETS_BASE_KEY_REGEX.test(key)) {
      throw new SecretsError(
        'SECRETS_KEY_INVALID',
        `Key "${key}" inválida. Debe matchear ${SECRETS_BASE_KEY_REGEX.source} ` +
          `(chars a-zA-Z0-9_-:., max ${SECRETS_CAPS.MAX_KEY_LENGTH} chars).`,
      );
    }
    if (this.allowedKeyPattern && !this.allowedKeyPattern.test(key)) {
      throw new SecretsError(
        'SECRETS_KEY_PATTERN_MISMATCH',
        `Key "${key}" no matchea el allowedKeyPattern del manifest (${this.allowedKeyPattern.source}). ` +
          `Esta restricción la declara el propio módulo en secretsLifecycle.allowedKeyPattern para forzar disciplina ` +
          `(típicamente prefijos que indiquen scope, ej. "^job:[uuid]:..."). Revisá la key o el pattern del manifest.`,
      );
    }
  }

  /// Mapea errores de Prisma/Postgres a SecretsErrorCode tipado. El módulo
  /// solo confía en `code`; `message` es para logs/debug.
  private mapError(e: unknown, op: string, key: string): SecretsError {
    const err = e as { code?: string; message?: string };
    const msg = err?.message ?? String(e);
    let code: SecretsErrorCode = 'SECRETS_NETWORK';
    // Prisma error codes son P2XXX. Postgres SQLSTATE son numéricos en
    // err.meta.code o err.code. Nos importan pocos casos:
    //  - P2002 (Prisma unique violation) → race en INSERT vs UPSERT; recuperable.
    //  - 57014 (Postgres query canceled) → timeout / statement_timeout.
    if (err?.code === 'P2002' || err?.code === '23505') {
      // Carrera: dos sets concurrentes para la misma key llegaron a INSERT.
      // El segundo perdió. El módulo puede reintentar — la UPDATE branch
      // ahora atrapa el row del primer winner. Pero para evitar bucle
      // infinito, devolvemos NETWORK y dejamos que el módulo reintente
      // explícitamente.
      code = 'SECRETS_NETWORK';
    }
    this.logger.warn(
      `[secrets:${this.moduleName}] ${op}(${key}) falló: ${code} (${err?.code ?? 'unknown'}) ${msg}`,
    );
    return new SecretsError(code, `${op}(${key}) falló: ${msg}`, e);
  }
}
