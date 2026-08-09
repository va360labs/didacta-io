import { describe, expect, it, vi } from 'vitest';
import type { StorageService } from '@didacta/core-kernel';
import { PrismaEvidenceVaultService } from '../src/modules/prisma-evidence-vault.service';

interface EvidenceRow {
  id: string;
  tenantId: string;
  resourceType: string;
  resourceId: string;
  storageKey: string;
  hash: string;
  size: bigint;
  contentType: string | null;
  createdAt: Date;
}

function makeFakePrisma() {
  const rows: EvidenceRow[] = [];
  let nextId = 1;
  return {
    evidenceVaultEntry: {
      async findFirst(args: {
        where: { tenantId: string; resourceType: string; resourceId: string; hash: string };
      }): Promise<EvidenceRow | null> {
        return (
          rows.find(
            (r) =>
              r.tenantId === args.where.tenantId &&
              r.resourceType === args.where.resourceType &&
              r.resourceId === args.where.resourceId &&
              r.hash === args.where.hash,
          ) ?? null
        );
      },
      async create(args: { data: Omit<EvidenceRow, 'id' | 'createdAt'> }): Promise<EvidenceRow> {
        const row: EvidenceRow = {
          id: `ev-${nextId++}`,
          createdAt: new Date(),
          ...args.data,
        };
        rows.push(row);
        return row;
      },
    },
    _rows: rows,
  };
}

function makeFakeStorage(): StorageService & { uploadCalls: number } {
  const fake = {
    uploadCalls: 0,
    async upload(key: string) {
      fake.uploadCalls++;
      return { key };
    },
    // El vault nunca sube imágenes, pero `StorageService` declara el método:
    // sin él el doble deja de cumplir el contrato que dice implementar.
    async uploadImage(): Promise<never> {
      throw new Error('not used');
    },
    async download() {
      throw new Error('not used');
    },
    async delete() {},
    async getSignedUrl(key: string) {
      return `/storage/${key}`;
    },
  };
  return fake;
}

describe('PrismaEvidenceVaultService', () => {
  it('persiste blob: hash SHA-256 + key + entry en BD', async () => {
    const prisma = makeFakePrisma();
    const storage = makeFakeStorage();
    const svc = new PrismaEvidenceVaultService(prisma as never, storage);

    const result = await svc.store({
      tenantId: 't1',
      resourceType: 'certificate',
      resourceId: 'cert-1',
      data: Buffer.from('hello world'),
      contentType: 'application/pdf',
    });

    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.storageKey).toContain('evidence/t1/certificate/cert-1/');
    expect(prisma._rows).toHaveLength(1);
    expect(storage.uploadCalls).toBe(1);
  });

  it('reutiliza entrada existente si llega el mismo (resource, hash)', async () => {
    const prisma = makeFakePrisma();
    const storage = makeFakeStorage();
    const svc = new PrismaEvidenceVaultService(prisma as never, storage);

    const data = Buffer.from('idempotent payload');
    await svc.store({ tenantId: 't1', resourceType: 'doc', resourceId: 'd1', data });
    await svc.store({ tenantId: 't1', resourceType: 'doc', resourceId: 'd1', data });

    expect(prisma._rows).toHaveLength(1);
    expect(storage.uploadCalls).toBe(1);
  });

  it('separa entradas por tenant', async () => {
    const prisma = makeFakePrisma();
    const storage = makeFakeStorage();
    const svc = new PrismaEvidenceVaultService(prisma as never, storage);

    const data = Buffer.from('shared bytes');
    await svc.store({ tenantId: 't1', resourceType: 'doc', resourceId: 'd1', data });
    await svc.store({ tenantId: 't2', resourceType: 'doc', resourceId: 'd1', data });

    expect(prisma._rows).toHaveLength(2);
    expect(prisma._rows[0]!.tenantId).toBe('t1');
    expect(prisma._rows[1]!.tenantId).toBe('t2');
  });

  it('tolera Uint8Array como entrada (no solo Buffer)', async () => {
    const prisma = makeFakePrisma();
    const storage = makeFakeStorage();
    const svc = new PrismaEvidenceVaultService(prisma as never, storage);

    const data = new Uint8Array([1, 2, 3, 4]);
    const result = await svc.store({
      tenantId: 't1',
      resourceType: 'doc',
      resourceId: 'd1',
      data,
    });
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// Silenciar warning si el módulo importa algo no usado
void vi;
