/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHmac } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  VideoBunnyWebhookController,
  VideoUploadsController,
} from '../src/video/cloud/video-cloud.controllers';
import type { VideoCloudEnabled } from '../src/video/cloud/video-cloud.config';
import { VideoCloudError, type VideoCloudService } from '../src/video/cloud/video-cloud.service';
import { SUBSCRIPTION_GATE_EXEMPT, isGateExempt } from '../src/tenancy/subscription-gate';

const SECRET = 'solo-lectura';
const config = { webhookSecret: SECRET } as VideoCloudEnabled;

function request(body: string, headers: Record<string, string>) {
  return { rawBody: Buffer.from(body), headers } as never;
}

function signed(body: string) {
  return {
    'x-bunnystream-signature': createHmac('sha256', SECRET).update(body).digest('hex'),
    'x-bunnystream-signature-version': 'v1',
    'x-bunnystream-signature-algorithm': 'hmac-sha256',
  };
}

async function status(p: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof HttpException ? err.getStatus() : -1;
  }
}

describe('webhook de Bunny', () => {
  const body = JSON.stringify({
    VideoLibraryId: 700900,
    VideoGuid: '657bb740-a71b-4529-a012-528021c31a92',
    Status: 3,
  });

  it('con firma válida, manda a refrescar el vídeo', async () => {
    const handleWebhook = vi.fn().mockResolvedValue('applied');
    const ctrl = new VideoBunnyWebhookController(
      { handleWebhook } as unknown as VideoCloudService,
      config,
    );
    expect(await ctrl.handle(request(body, signed(body)))).toEqual({ result: 'applied' });
    expect(handleWebhook).toHaveBeenCalledWith({
      libraryId: 700900,
      guid: '657bb740-a71b-4529-a012-528021c31a92',
    });
  });

  it('sin firma, o con otra clave: 401 y no toca nada', async () => {
    const handleWebhook = vi.fn();
    const ctrl = new VideoBunnyWebhookController(
      { handleWebhook } as unknown as VideoCloudService,
      config,
    );
    expect(await status(ctrl.handle(request(body, {})))).toBe(401);
    const forged = {
      ...signed(body),
      'x-bunnystream-signature': createHmac('sha256', 'otra').update(body).digest('hex'),
    };
    expect(await status(ctrl.handle(request(body, forged)))).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it('directos y cuerpos raros: 200 ignorado (Bunny no debe reintentar)', async () => {
    const handleWebhook = vi.fn();
    const ctrl = new VideoBunnyWebhookController(
      { handleWebhook } as unknown as VideoCloudService,
      config,
    );
    const live = JSON.stringify({
      VideoLibraryId: 1,
      VideoGuid: 'x',
      Status: 3,
      IsLiveStreamWebhook: true,
    });
    expect(await ctrl.handle(request(live, signed(live)))).toEqual({ result: 'ignored' });
    expect(await ctrl.handle(request('{}', signed('{}')))).toEqual({ result: 'ignored' });
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it('si Bunny no responde al refrescar: 503 para que reintente', async () => {
    const handleWebhook = vi.fn().mockRejectedValue(new Error('timeout'));
    const ctrl = new VideoBunnyWebhookController(
      { handleWebhook } as unknown as VideoCloudService,
      config,
    );
    expect(await status(ctrl.handle(request(body, signed(body))))).toBe(503);
  });

  it('el webhook responde aunque el aula esté en pausa (puerta de suscripción)', () => {
    expect(isGateExempt('POST', '/api/v1/video/bunny/webhook')).toBe(true);
    expect(SUBSCRIPTION_GATE_EXEMPT).toContainEqual({
      method: 'POST',
      path: '/video/bunny/webhook',
    });
    // Control: subir vídeos sí es contenido.
    expect(isGateExempt('POST', '/api/v1/video/uploads')).toBe(false);
  });
});

describe('rutas de subida del creador', () => {
  const user = (roles: string[]) => ({ sub: 'u1', tenantId: 't1', roles }) as never;

  it('un alumno no puede subir ni ver la cuota (403); sin sesión, 401', async () => {
    const service = { quotaView: vi.fn(), createUpload: vi.fn() } as unknown as VideoCloudService;
    const ctrl = new VideoUploadsController(service);
    expect(await status(ctrl.quota(user(['alumno'])))).toBe(403);
    expect(await status(ctrl.quota(undefined))).toBe(401);
    expect(await status(ctrl.create(user(['alumno']), {} as never))).toBe(403);
    expect(service.createUpload).not.toHaveBeenCalled();
  });

  it('formador y tenant_admin sí; el tenant sale de la sesión, no del cuerpo', async () => {
    const createUpload = vi.fn().mockResolvedValue({ asset: {}, upload: {} });
    const ctrl = new VideoUploadsController({ createUpload } as unknown as VideoCloudService);
    const dto = {
      lessonId: '7f0c7a8e-2b1c-4d6e-9f00-112233445566',
      fileName: 'a.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10,
      durationSeconds: 5,
    };
    await ctrl.create(user(['formador']), { ...dto, tenantId: 'otro' } as never);
    expect(createUpload).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', userId: 'u1' }),
    );
  });

  it('los errores del servicio salen con su código y sus números', async () => {
    const createUpload = vi.fn().mockRejectedValue(
      new VideoCloudError('VIDEO_STORAGE_QUOTA', 409, 'VIDEO_STORAGE_QUOTA', {
        usedSeconds: 15600,
        limitSeconds: 18000,
      }),
    );
    const ctrl = new VideoUploadsController({ createUpload } as unknown as VideoCloudService);
    try {
      await ctrl.create(user(['tenant_admin']), {} as never);
      expect.unreachable();
    } catch (err) {
      expect((err as HttpException).getStatus()).toBe(409);
      expect((err as HttpException).getResponse()).toMatchObject({
        code: 'VIDEO_STORAGE_QUOTA',
        usedSeconds: 15600,
        limitSeconds: 18000,
      });
    }
  });
});
