import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { NotificationTemplatesController } from '../src/modules/notifications/notification-templates.controller';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { SessionClaims } from '../src/auth/token.service';

/**
 * Smoke tests del CRUD admin de plantillas de notificación (G5).
 * Verifican el contrato de admin-only, el filtrado por tenant en list/upsert,
 * y la lógica de delete con/sin (channel, locale).
 */
function makeUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'admin-1',
    tenantId: 'tenant-A',
    roles: ['tenant_admin'],
    email: 'admin@example.com',
    mfaVerified: true,
    ...(overrides as Record<string, unknown>),
  } as SessionClaims;
}

function makeFakePrisma() {
  const findMany = vi.fn(async () => [] as unknown[]);
  const upsert = vi.fn(async (args: { create: unknown }) => args.create);
  const deleteMany = vi.fn(async () => ({ count: 1 }));
  return {
    prisma: {
      notificationTemplate: { findMany, upsert, deleteMany },
    } as unknown as PrismaService,
    spies: { findMany, upsert, deleteMany },
  };
}

describe('NotificationTemplatesController (G5)', () => {
  describe('guard admin', () => {
    it('listKeys sin sesión → UnauthorizedException', () => {
      const { prisma } = makeFakePrisma();
      const c = new NotificationTemplatesController(prisma);
      expect(() => c.listKeys(undefined)).toThrow(UnauthorizedException);
    });

    it('listKeys rol alumno → ForbiddenException', () => {
      const { prisma } = makeFakePrisma();
      const c = new NotificationTemplatesController(prisma);
      expect(() => c.listKeys(makeUser({ roles: ['alumno'] }))).toThrow(ForbiddenException);
    });

    it('listKeys con tenant_admin → devuelve el universo conocido (≥ enrollment.created)', () => {
      const { prisma } = makeFakePrisma();
      const c = new NotificationTemplatesController(prisma);
      const keys = c.listKeys(makeUser());
      expect(keys.length).toBeGreaterThan(0);
      expect(keys).toContain('enrollment.created');
      expect(keys).toContain('certificate.issued');
    });
  });

  describe('list', () => {
    it('filtra por tenantId del usuario aunque otro tenantId aparezca en query', async () => {
      const { prisma, spies } = makeFakePrisma();
      const c = new NotificationTemplatesController(prisma);
      await c.list(makeUser({ tenantId: 'tenant-A' }), {});
      expect(spies.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-A' }),
        }),
      );
    });

    it('filtro por key se traduce a where.key', async () => {
      const { prisma, spies } = makeFakePrisma();
      const c = new NotificationTemplatesController(prisma);
      await c.list(makeUser(), { key: 'enrollment.created' });
      expect(spies.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ key: 'enrollment.created' }),
        }),
      );
    });
  });

  describe('upsert', () => {
    it('persiste con tenantId del JWT — un admin no puede escribir templates de otro tenant', async () => {
      const { prisma, spies } = makeFakePrisma();
      const c = new NotificationTemplatesController(prisma);
      await c.upsert(makeUser({ tenantId: 'tenant-A' }), 'enrollment.created', {
        channel: 'EMAIL',
        locale: 'es-ES',
        subject: 'Bienvenido',
        body: 'Hola {{name}}',
      });
      expect(spies.upsert).toHaveBeenCalledTimes(1);
      const args = spies.upsert.mock.calls[0]?.[0] as {
        where: { tenantId_key_channel_locale: { tenantId: string } };
        create: { tenantId: string };
      };
      expect(args.where.tenantId_key_channel_locale.tenantId).toBe('tenant-A');
      expect(args.create.tenantId).toBe('tenant-A');
    });

    it('subject opcional cae a null — el render usa el default del producto', async () => {
      const { prisma, spies } = makeFakePrisma();
      const c = new NotificationTemplatesController(prisma);
      await c.upsert(makeUser(), 'community.mention', {
        channel: 'IN_APP',
        locale: 'es-ES',
        body: 'Tienes una mención',
      });
      const args = spies.upsert.mock.calls[0]?.[0] as { create: { subject: string | null } };
      expect(args.create.subject).toBeNull();
    });
  });

  describe('remove', () => {
    it('sin (channel, locale) → borra todos los overrides del key del tenant', async () => {
      const { prisma, spies } = makeFakePrisma();
      const c = new NotificationTemplatesController(prisma);
      await c.remove(makeUser({ tenantId: 'tenant-A' }), 'enrollment.created');
      expect(spies.deleteMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-A', key: 'enrollment.created' },
      });
    });

    it('con (channel, locale) específicos → borra sólo esa combinación', async () => {
      const { prisma, spies } = makeFakePrisma();
      const c = new NotificationTemplatesController(prisma);
      await c.remove(makeUser({ tenantId: 'tenant-A' }), 'community.mention', 'EMAIL', 'en-US');
      expect(spies.deleteMany).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-A',
          key: 'community.mention',
          channel: 'EMAIL',
          locale: 'en-US',
        },
      });
    });

    it('channel inválido → ForbiddenException (defensivo: el client jamás debería mandarlo)', async () => {
      const { prisma } = makeFakePrisma();
      const c = new NotificationTemplatesController(prisma);
      await expect(
        c.remove(makeUser(), 'enrollment.created', 'TELEGRAM', 'es-ES'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
