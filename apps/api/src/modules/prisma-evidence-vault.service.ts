/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash } from 'node:crypto';
import type { EvidenceVaultService, StorageService } from '@didacta/core-kernel';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Vault de evidencia inmutable: persiste el blob en storage + registra hash en BD.
 *
 * Si llega el mismo (tenantId, resourceType, resourceId, hash), reutiliza el
 * registro existente para evitar duplicados.
 */
export class PrismaEvidenceVaultService implements EvidenceVaultService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async store(artifact: {
    tenantId: string;
    resourceType: string;
    resourceId: string;
    data: Buffer | Uint8Array;
    contentType?: string;
  }): Promise<{ id: string; hash: string; storageKey: string }> {
    const buffer = Buffer.isBuffer(artifact.data) ? artifact.data : Buffer.from(artifact.data);
    const hash = createHash('sha256').update(buffer).digest('hex');

    const existing = await this.prisma.evidenceVaultEntry.findFirst({
      where: {
        tenantId: artifact.tenantId,
        resourceType: artifact.resourceType,
        resourceId: artifact.resourceId,
        hash,
      },
    });
    if (existing) {
      return { id: existing.id, hash: existing.hash, storageKey: existing.storageKey };
    }

    const storageKey = `evidence/${artifact.tenantId}/${artifact.resourceType}/${artifact.resourceId}/${hash}.bin`;
    await this.storage.upload(
      storageKey,
      buffer,
      artifact.contentType ?? 'application/octet-stream',
    );

    const entry = await this.prisma.evidenceVaultEntry.create({
      data: {
        tenantId: artifact.tenantId,
        resourceType: artifact.resourceType,
        resourceId: artifact.resourceId,
        storageKey,
        hash,
        size: BigInt(buffer.length),
        contentType: artifact.contentType ?? null,
      },
    });

    return { id: entry.id, hash: entry.hash, storageKey: entry.storageKey };
  }
}
