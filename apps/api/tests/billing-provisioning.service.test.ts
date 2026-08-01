import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingProvisioningService } from '../src/modules/billing/billing-provisioning.service';

/**
 * Tests unit del provisioning del comprador ANÓNIMO de cursos (viaje 2):
 * find-or-create del user + bienvenida best-effort con enlace de contraseña.
 * Réplica del patrón de la membresía con copy/plantilla/audit propios.
 */

const TENANT = 'tenant-1';
const CTX = { ip: '203.0.113.9', userAgent: 'vitest' } as never;

function makeMocks(opts?: {
  existingUserId?: string | null;
  role?: { id: string } | null;
  smtpResolved?: boolean;
  smtpOk?: boolean;
  issuedToken?: { rawToken: string } | null;
}) {
  const created = { id: 'user-nuevo' };
  const userRoleCreate = vi.fn();
  const tx = {
    user: { create: vi.fn().mockResolvedValue(created) },
    userRole: { create: userRoleCreate },
  };
  const prisma = {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          opts?.existingUserId === undefined || opts.existingUserId === null
            ? null
            : { id: opts.existingUserId },
        ),
    },
    role: {
      findUnique: vi
        .fn()
        .mockResolvedValue(opts?.role === undefined ? { id: 'role-alumno' } : opts.role),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    // resolveEmailBranding y fetchEmailOverride (ambos best-effort): mock mínimo.
    tenant: { findUnique: vi.fn().mockResolvedValue({ name: 'Academia Demo' }) },
    modThemingTenantTheme: { findUnique: vi.fn().mockResolvedValue(null) },
    notificationTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
  } as never;
  const passwords = { hash: vi.fn().mockResolvedValue('$argon2$hash') } as never;
  const passwordReset = {
    request: vi
      .fn()
      .mockResolvedValue(
        opts?.issuedToken === undefined ? { rawToken: 'tok-123' } : opts.issuedToken,
      ),
  } as never;
  const smtpResolver = {
    resolve: vi
      .fn()
      .mockResolvedValue(
        (opts?.smtpResolved ?? true) ? { config: { host: 'smtp.example.com' } } : null,
      ),
  } as never;
  const smtp = {
    send: vi.fn().mockResolvedValue({ ok: opts?.smtpOk ?? true }),
  } as never;
  const auditLog = { record: vi.fn() } as never;
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

  const svc = new BillingProvisioningService(
    prisma,
    passwords,
    passwordReset,
    smtpResolver,
    smtp,
    auditLog,
    logger,
  );
  return { svc, prisma, tx, userRoleCreate, passwordReset, smtp, auditLog, logger };
}

const args = {
  tenantId: TENANT,
  email: 'compradora@example.com',
  name: 'Ana',
  webBaseUrl: 'https://academia.example.com',
  ctx: CTX,
};

describe('BillingProvisioningService.provision', () => {
  beforeEach(() => vi.clearAllMocks());

  it('comprador con cuenta EXISTENTE: la reutiliza sin crear nada ni enviar email', async () => {
    const { svc, tx, smtp, auditLog } = makeMocks({ existingUserId: 'user-viejo' });

    const result = await svc.provision(args);

    expect(result).toEqual({ userId: 'user-viejo', created: false });
    expect(tx.user.create).not.toHaveBeenCalled();
    expect((smtp as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
    expect((auditLog as { record: ReturnType<typeof vi.fn> }).record).not.toHaveBeenCalled();
  });

  it('comprador nuevo: user ACTIVE con rol alumno, audit billing.buyer_created y bienvenida', async () => {
    const { svc, tx, userRoleCreate, smtp, auditLog, passwordReset } = makeMocks();

    const result = await svc.provision(args);

    expect(result).toEqual({ userId: 'user-nuevo', created: true });
    const data = tx.user.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      tenantId: TENANT,
      email: 'compradora@example.com',
      name: 'Ana',
      status: 'ACTIVE',
      mustChangePassword: false,
    });
    expect(userRoleCreate).toHaveBeenCalledWith({
      data: { userId: 'user-nuevo', roleId: 'role-alumno' },
    });
    expect((auditLog as { record: ReturnType<typeof vi.fn> }).record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.buyer_created', resourceId: 'user-nuevo' }),
    );
    // El enlace del email es el token single-use de contraseña con TTL 7 días.
    expect((passwordReset as { request: ReturnType<typeof vi.fn> }).request).toHaveBeenCalledWith(
      { email: 'compradora@example.com', resolvedTenantId: TENANT },
      CTX,
      { ttlMinutes: 7 * 24 * 60 },
    );
    const sent = (smtp as { send: ReturnType<typeof vi.fn> }).send.mock.calls[0][1];
    expect(sent.to).toBe('compradora@example.com');
    expect(sent.text).toContain('reset-password?token=tok-123');
  });

  it('sin SMTP del tenant: el user se crea igual y el webhook NO falla', async () => {
    const { svc, smtp, logger } = makeMocks({ smtpResolved: false });

    const result = await svc.provision(args);

    expect(result.created).toBe(true);
    expect((smtp as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });

  it('fallo del envío SMTP: best-effort, no propaga (el comprador tiene «olvidé mi contraseña»)', async () => {
    const { svc } = makeMocks({ smtpOk: false });
    await expect(svc.provision(args)).resolves.toMatchObject({ created: true });
  });

  it('rol alumno inexistente: crea el user sin rol y deja warn (no revienta el pago)', async () => {
    const { svc, userRoleCreate, logger } = makeMocks({ role: null });

    const result = await svc.provision(args);

    expect(result.created).toBe(true);
    expect(userRoleCreate).not.toHaveBeenCalled();
    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-nuevo' }),
      expect.stringContaining('sin rol'),
    );
  });
});
