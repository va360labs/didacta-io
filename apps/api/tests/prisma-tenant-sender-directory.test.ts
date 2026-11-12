import { describe, expect, it } from 'vitest';
import { prismaTenantSenderDirectory } from '../src/modules/prisma-tenant-sender-directory';
import { tenantContextStorage } from '../src/tenancy/tenant-context.storage';

describe('prismaTenantSenderDirectory.primaryAdminEmail', () => {
  it('pide el primer admin activo y no borrado del aula (sin el de soporte), con el contexto de ESA aula', async () => {
    const seen: { args: unknown; ctxTenant: string | undefined }[] = [];
    const prisma = {
      user: {
        async findFirst(args: unknown) {
          seen.push({ args, ctxTenant: tenantContextStorage.getStore()?.tenantId });
          return { email: 'creador@academia.es' };
        },
      },
    };
    const email = await prismaTenantSenderDirectory(prisma).primaryAdminEmail('tenant-a');
    expect(email).toBe('creador@academia.es');
    expect(seen).toHaveLength(1);
    // Sin contexto previo (un worker): la consulta corre igualmente acotada al aula.
    expect(seen[0]!.ctxTenant).toBe('tenant-a');
    expect(seen[0]!.args).toEqual({
      where: {
        tenantId: 'tenant-a',
        status: 'ACTIVE',
        deletedAt: null,
        // El usuario de acceso de soporte también es tenant_admin: nunca es el destino.
        email: { not: 'soporte@didacta.invalid' },
        roles: { some: { role: { name: { in: ['tenant_admin', 'super_admin'] } } } },
      },
      orderBy: { createdAt: 'asc' },
      select: { email: true },
    });
  });

  it('null si el aula no tiene administrador', async () => {
    const prisma = { user: { findFirst: async () => null } };
    expect(await prismaTenantSenderDirectory(prisma).primaryAdminEmail('t')).toBeNull();
  });
});
