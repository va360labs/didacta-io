import { Injectable } from '@nestjs/common';
import type { AuditLogService, TenantConfigService } from '@didacta/core-kernel';
import { Prisma } from '@didacta/database';
import { PrismaService } from '../prisma/prisma.service';
import { SecretCipherService } from './secret-cipher.service';

export interface TenantSettingMetadata {
  moduleName: string;
  key: string;
  isSecret: boolean;
  /** True si la fila tiene un valor (cifrado o plano), false si está vacía. */
  hasValue: boolean;
  updatedAt: Date;
  updatedById: string | null;
}

export interface SetSettingOptions {
  /** Si true, el valor se cifra con AES-256-GCM antes de persistir. */
  isSecret?: boolean;
  /** ID del usuario que realiza el cambio (para audit + columna updated_by_id). */
  actorId?: string | null;
}

export interface DeleteSettingOptions {
  actorId?: string | null;
}

/**
 * Implementación real de `TenantConfigService` con persistencia en Postgres y
 * encryption at-rest para credenciales.
 *
 * Reemplaza el stub in-memory `StubTenantConfig`. Cada admin de tenant
 * configura desde `/admin/configuracion` su SMTP, Zoom, etc., y los valores
 * marcados como secretos se cifran con `SecretCipherService` antes de tocar
 * la DB.
 *
 * El servicio cumple el contrato del kernel (`get` + `set`) y añade
 * `delete`, `list` y `has` como extensiones para uso desde los controllers
 * HTTP — los módulos solo ven el contrato del kernel.
 */
@Injectable()
export class PrismaTenantConfigService implements TenantConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipherService,
    private readonly auditLog: AuditLogService,
  ) {}

  async get<T = unknown>(
    tenantId: string,
    moduleName: string,
    key: string,
  ): Promise<T | undefined> {
    const row = await this.prisma.tenantSetting.findUnique({
      where: { tenantId_moduleName_key: { tenantId, moduleName, key } },
    });
    if (!row) return undefined;

    if (row.isSecret) {
      if (!row.valueCipher || !row.valueIv || !row.valueTag) {
        throw new Error(
          `Setting ${moduleName}.${key} marcado como secreto pero sin cipher/iv/tag persistidos`,
        );
      }
      const plaintext = this.cipher.decrypt({
        cipher: Buffer.from(row.valueCipher),
        iv: Buffer.from(row.valueIv),
        tag: Buffer.from(row.valueTag),
      });
      return JSON.parse(plaintext) as T;
    }

    if (row.valueJson === null || row.valueJson === undefined) {
      return undefined;
    }
    return row.valueJson as T;
  }

  async set<T = unknown>(
    tenantId: string,
    moduleName: string,
    key: string,
    value: T,
    options?: SetSettingOptions,
  ): Promise<void> {
    const isSecret = options?.isSecret ?? false;
    const actorId = options?.actorId ?? null;

    const existing = await this.prisma.tenantSetting.findUnique({
      where: { tenantId_moduleName_key: { tenantId, moduleName, key } },
      select: { id: true, isSecret: true },
    });

    if (isSecret) {
      const plaintext = JSON.stringify(value ?? null);
      const enc = this.cipher.encrypt(plaintext);
      await this.prisma.tenantSetting.upsert({
        where: { tenantId_moduleName_key: { tenantId, moduleName, key } },
        create: {
          tenantId,
          moduleName,
          key,
          isSecret: true,
          valueJson: Prisma.DbNull,
          valueCipher: enc.cipher,
          valueIv: enc.iv,
          valueTag: enc.tag,
          updatedById: actorId,
        },
        update: {
          isSecret: true,
          valueJson: Prisma.DbNull,
          valueCipher: enc.cipher,
          valueIv: enc.iv,
          valueTag: enc.tag,
          updatedById: actorId,
        },
      });
    } else {
      const jsonValue = (value ?? null) as Prisma.InputJsonValue | null;
      await this.prisma.tenantSetting.upsert({
        where: { tenantId_moduleName_key: { tenantId, moduleName, key } },
        create: {
          tenantId,
          moduleName,
          key,
          isSecret: false,
          valueJson: jsonValue ?? Prisma.JsonNull,
          valueCipher: null,
          valueIv: null,
          valueTag: null,
          updatedById: actorId,
        },
        update: {
          isSecret: false,
          valueJson: jsonValue ?? Prisma.JsonNull,
          valueCipher: null,
          valueIv: null,
          valueTag: null,
          updatedById: actorId,
        },
      });
    }

    await this.auditLog.record({
      tenantId,
      actorId,
      action: existing ? 'tenant_setting.updated' : 'tenant_setting.created',
      resourceType: 'tenant_setting',
      resourceId: `${moduleName}.${key}`,
      metadata: {
        isSecret,
        previouslySecret: existing?.isSecret ?? false,
      },
    });
  }

  async delete(
    tenantId: string,
    moduleName: string,
    key: string,
    options?: DeleteSettingOptions,
  ): Promise<void> {
    const actorId = options?.actorId ?? null;
    const existing = await this.prisma.tenantSetting.findUnique({
      where: { tenantId_moduleName_key: { tenantId, moduleName, key } },
      select: { id: true, isSecret: true },
    });
    if (!existing) return;

    await this.prisma.tenantSetting.delete({
      where: { tenantId_moduleName_key: { tenantId, moduleName, key } },
    });

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'tenant_setting.deleted',
      resourceType: 'tenant_setting',
      resourceId: `${moduleName}.${key}`,
      metadata: { wasSecret: existing.isSecret },
    });
  }

  async list(tenantId: string, moduleName?: string): Promise<TenantSettingMetadata[]> {
    const rows = await this.prisma.tenantSetting.findMany({
      where: { tenantId, ...(moduleName ? { moduleName } : {}) },
      orderBy: [{ moduleName: 'asc' }, { key: 'asc' }],
    });
    return rows.map((r) => ({
      moduleName: r.moduleName,
      key: r.key,
      isSecret: r.isSecret,
      hasValue: r.isSecret ? r.valueCipher !== null : r.valueJson !== null,
      updatedAt: r.updatedAt,
      updatedById: r.updatedById,
    }));
  }

  async has(tenantId: string, moduleName: string, key: string): Promise<boolean> {
    const row = await this.prisma.tenantSetting.findUnique({
      where: { tenantId_moduleName_key: { tenantId, moduleName, key } },
      select: { id: true },
    });
    return row !== null;
  }
}
