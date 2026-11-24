/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommunityBroadcastWorker } from './community-broadcast.worker';

/**
 * Aviso masivo de un post de un espacio con nivel: a quien no puede verlo no se
 * le manda NADA (ni correo ni campana: el extracto del post va dentro), no cuenta
 * en el progreso y el cursor avanza igual para no repetir el lote en bucle.
 */

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';

// El enlace de baja del correo va firmado: hace falta un secreto de pruebas.
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env['AUTH_SECRET'];
  process.env['AUTH_SECRET'] = 'b'.repeat(64);
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env['AUTH_SECRET'];
  else process.env['AUTH_SECRET'] = previousSecret;
});

function setup(recipients: Array<{ userId: string; canSee: boolean; optedOut?: boolean }>) {
  const sends: Array<{ to: string; channel: string }> = [];
  const hub = {
    send: vi.fn(async (n: { to: string; channel: string }) => {
      sends.push({ to: n.to, channel: n.channel });
    }),
  };
  const factory = {
    build: () => ({ notificationHub: hub }),
    getTenantWebBaseUrl: async () => 'https://aula.example.test',
  };
  const community = {
    claimBroadcastBatch: vi.fn().mockResolvedValue({
      broadcast: {
        id: 'b1',
        tenantId: TENANT,
        subject: 'Nuevo en Pro',
        bodyText: 'Extracto',
        important: false,
        postId: 'p1',
        cursorUserId: null,
      },
      recipients: recipients.map((r) => ({
        userId: r.userId,
        email: `${r.userId}@example.test`,
        optedOut: r.optedOut ?? false,
        canSee: r.canSee,
      })),
      done: false,
    }),
    commitBroadcastBatch: vi.fn().mockResolvedValue(undefined),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const worker = new CommunityBroadcastWorker(
    factory as never,
    { getCommunityService: () => community } as never,
    logger as never,
  );
  return { worker, sends, community };
}

describe('CommunityBroadcastWorker · espacios con nivel', () => {
  it('quien no puede ver el post no recibe nada y no cuenta; el cursor avanza', async () => {
    const { worker, sends, community } = setup([
      { userId: 'u-basico', canSee: false },
      { userId: 'u-pro', canSee: true },
    ]);
    await (worker as unknown as { processBatch(id: string): Promise<boolean> }).processBatch('b1');

    expect(sends.map((s) => s.to)).toEqual(['u-pro', 'u-pro']); // correo + campana
    expect(community.commitBroadcastBatch).toHaveBeenNthCalledWith(1, 'b1', {
      sent: 0,
      failed: 0,
      skipped: 0,
      lastUserId: 'u-basico',
    });
    expect(community.commitBroadcastBatch).toHaveBeenNthCalledWith(2, 'b1', {
      sent: 1,
      failed: 0,
      skipped: 0,
      lastUserId: 'u-pro',
    });
  });

  it('un aviso importante tampoco salta el nivel (solo salta la baja)', async () => {
    const { worker, sends, community } = setup([{ userId: 'u-basico', canSee: false }]);
    community.claimBroadcastBatch.mockResolvedValueOnce({
      ...(await community.claimBroadcastBatch()),
      broadcast: {
        id: 'b1',
        tenantId: TENANT,
        subject: 'Urgente',
        bodyText: 'x',
        important: true,
        postId: 'p1',
        cursorUserId: null,
      },
    });
    await (worker as unknown as { processBatch(id: string): Promise<boolean> }).processBatch('b1');
    expect(sends).toEqual([]);
  });
});
