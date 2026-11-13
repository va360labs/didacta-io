/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Portada de la academia (`/modules/theming/me/cover`): solo la sube o la quita
 * quien administra, siempre en SU aula (la de la sesión, nunca una del body), y
 * el endpoint público responde 404 sin portada.
 */

import { ForbiddenException } from '@nestjs/common';
import { LicenseService } from '@didacta/license-sdk';
import { CoverNotFoundError } from '@didacta/mod-theming';
import { describe, expect, it, vi } from 'vitest';
import { ThemingController } from '../src/modules/theming.controller';

type User = Parameters<ThemingController['uploadCover']>[0];

const admin = {
  sub: 'u-admin',
  tenantId: 'tenant-a',
  roles: ['tenant_admin'],
  mfaVerified: true,
  email: 'admin@a.test',
} as User;
const alumno = { ...admin, sub: 'u-alumno', roles: ['alumno'] } as User;

function make() {
  const service = {
    uploadCover: vi.fn().mockResolvedValue({ coverUrl: '/x' }),
    removeCover: vi.fn().mockResolvedValue({ coverUrl: null }),
    getCoverBlob: vi.fn(),
  };
  const registry = { getThemingService: () => service };
  const controller = new ThemingController(registry as never, new LicenseService());
  return { controller, service };
}

const dto = { data: 'iVBORw0KGgo=', filename: 'p.png', contentType: 'image/png' as const };

describe('ThemingController · portada', () => {
  it('quien administra la sube y la quita en su aula', async () => {
    const { controller, service } = make();
    await controller.uploadCover(admin, dto);
    expect(service.uploadCover).toHaveBeenCalledWith('tenant-a', dto);
    await controller.removeCover(admin);
    expect(service.removeCover).toHaveBeenCalledWith('tenant-a');
  });

  it('un alumno no puede subirla ni quitarla', async () => {
    const { controller, service } = make();
    await expect(controller.uploadCover(alumno, dto)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.removeCover(alumno)).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.uploadCover).not.toHaveBeenCalled();
    expect(service.removeCover).not.toHaveBeenCalled();
  });

  it('el endpoint público sirve la portada con su tipo, o 404 si no hay', async () => {
    const { controller, service } = make();
    const reply = () => {
      const r = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        body: undefined as unknown,
        status(c: number) {
          r.statusCode = c;
          return r;
        },
        header(k: string, v: string) {
          r.headers[k] = v;
          return r;
        },
        send(b: unknown) {
          r.body = b;
          return r;
        },
      };
      return r;
    };

    service.getCoverBlob.mockResolvedValueOnce({
      buffer: Buffer.from('img'),
      mimeType: 'image/webp',
    });
    const ok = reply();
    await controller.getPublicCover('tenant-a', ok as never);
    expect(service.getCoverBlob).toHaveBeenCalledWith('tenant-a');
    expect(ok.headers['Content-Type']).toBe('image/webp');
    expect(ok.body).toEqual(Buffer.from('img'));

    service.getCoverBlob.mockRejectedValueOnce(new CoverNotFoundError());
    const none = reply();
    await controller.getPublicCover('tenant-b', none as never);
    expect(none.statusCode).toBe(404);
    expect(none.body).toEqual({ error: 'cover_not_found' });
  });
});
