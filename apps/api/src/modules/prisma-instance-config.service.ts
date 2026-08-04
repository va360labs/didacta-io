/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@didacta/database';
import { PrismaService } from '../prisma/prisma.service';
import { SecretCipherService } from './secret-cipher.service';

export interface InstanceSettingMetadata {
  scope: string;
  key: string;
  isSecret: boolean;
  /** True si la fila tiene un valor (cifrado o plano), false si está vacía. */
  hasValue: boolean;
  updatedAt: Date;
  updatedById: string | null;
}

export interface SetInstanceSettingOptions {
  /** Si true, el valor se cifra con AES-256-GCM antes de persistir. */
  isSecret?: boolean;
  /** ID del usuario que realiza el cambio (para la columna updated_by_id). */
  actorId?: string | null;
}

export interface DeleteInstanceSettingOptions {
  actorId?: string | null;
}

/**
 * Config a nivel de INSTALACIÓN (no de tenant): licencia, telemetría, rate
 * limits, crons. Mismo patrón que `PrismaTenantConfigService` pero sobre
 * `core_instance_setting` (sin tenant_id, sin RLS — es la 10ª tabla global).
 *
 * Sin `AuditLogService`: esa interfaz exige `tenantId` (columna NOT NULL de
 * `audit_log`, con cadena de hash por tenant), y estos cambios no tienen
 * tenant. Se registran vía Logger — un cambio de config de instancia es raro
 * (super_admin-only) y de bajo volumen; no justifica una segunda tabla de
 * audit log con su propia cadena de hash solo para esto.
 */
@Injectable()
export class PrismaInstanceConfigService {
  private readonly logger = new Logger(PrismaInstanceConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipherService,
  ) {}

  async get<T = unknown>(scope: string, key: string): Promise<T | undefined> {
    const row = await this.prisma.instanceSetting.findUnique({
      where: { scope_key: { scope, key } },
    });
    if (!row) return undefined;

    if (row.isSecret) {
      if (!row.valueCipher || !row.valueIv || !row.valueTag) {
        throw new Error(
          `Instance setting ${scope}.${key} marcado como secreto pero sin cipher/iv/tag persistidos`,
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
    scope: string,
    key: string,
    value: T,
    options?: SetInstanceSettingOptions,
  ): Promise<void> {
    const isSecret = options?.isSecret ?? false;
    const actorId = options?.actorId ?? null;

    const existing = await this.prisma.instanceSetting.findUnique({
      where: { scope_key: { scope, key } },
      select: { id: true, isSecret: true },
    });

    if (isSecret) {
      const plaintext = JSON.stringify(value ?? null);
      const enc = this.cipher.encrypt(plaintext);
      await this.prisma.instanceSetting.upsert({
        where: { scope_key: { scope, key } },
        create: {
          scope,
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
      await this.prisma.instanceSetting.upsert({
        where: { scope_key: { scope, key } },
        create: {
          scope,
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

    this.logger.log(
      `[instance-setting] ${existing ? 'updated' : 'created'} ${scope}.${key} (isSecret=${isSecret}, actor=${actorId ?? 'system'})`,
    );
  }

  async delete(scope: string, key: string, options?: DeleteInstanceSettingOptions): Promise<void> {
    const actorId = options?.actorId ?? null;
    const existing = await this.prisma.instanceSetting.findUnique({
      where: { scope_key: { scope, key } },
      select: { id: true },
    });
    if (!existing) return;

    await this.prisma.instanceSetting.delete({ where: { scope_key: { scope, key } } });

    this.logger.log(`[instance-setting] deleted ${scope}.${key} (actor=${actorId ?? 'system'})`);
  }

  async list(scope?: string): Promise<InstanceSettingMetadata[]> {
    const rows = await this.prisma.instanceSetting.findMany({
      where: scope ? { scope } : undefined,
      orderBy: [{ scope: 'asc' }, { key: 'asc' }],
    });
    return rows.map((r) => ({
      scope: r.scope,
      key: r.key,
      isSecret: r.isSecret,
      hasValue: r.isSecret ? r.valueCipher !== null : r.valueJson !== null,
      updatedAt: r.updatedAt,
      updatedById: r.updatedById,
    }));
  }

  async has(scope: string, key: string): Promise<boolean> {
    const row = await this.prisma.instanceSetting.findUnique({
      where: { scope_key: { scope, key } },
      select: { id: true },
    });
    return row !== null;
  }
}
