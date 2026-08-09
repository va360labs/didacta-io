import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CertificatesController } from '../src/modules/certificates/certificates.controller';
import type { ModuleRegistryService } from '../src/modules/module-registry.service';
import type { SessionClaims } from '../src/auth/token.service';

/**
 * Check de propiedad en la lectura/descarga de certificados (hallazgo del
 * inventario de docs): el service solo filtra por tenant, así que antes
 * cualquier usuario del tenant leía y descargaba certificados ajenos (PII).
 * Ahora: titular u staff (formador/admin); un ajeno recibe 404 (no 403) para
 * no confirmar la existencia del certificado.
 */

function makeUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sub: 'user-1',
    tenantId: 'tenant-A',
    roles: ['alumno'],
    email: 'a@example.com',
    mfaVerified: true,
    ...(overrides as Record<string, unknown>),
  } as SessionClaims;
}

function makeController(certUserId = 'owner-1') {
  const cert = {
    id: 'cert-1',
    userId: certUserId,
    number: 'CERT-0001',
    snapshot: { studentName: 'Alumno Demo', courseTitle: 'Curso' },
  };
  const certs = {
    getById: vi.fn(async () => cert),
    renderCertificatePdf: vi.fn(async () => Buffer.from('%PDF-fake')),
  };
  const registry = { getCertificatesService: () => certs } as unknown as ModuleRegistryService;
  return { controller: new CertificatesController(registry), spies: certs, cert };
}

function makeReply() {
  const reply = {
    header: vi.fn(() => reply),
    send: vi.fn(() => reply),
  };
  return reply;
}

describe('CertificatesController · propiedad en getById/download', () => {
  it('getById: rechaza sin sesión con 401', async () => {
    const { controller } = makeController();
    await expect(controller.getById(undefined, 'cert-1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('getById: el titular ve su certificado', async () => {
    const { controller, cert } = makeController('user-1');
    await expect(controller.getById(makeUser(), 'cert-1')).resolves.toEqual(cert);
  });

  it('getById: un alumno AJENO recibe 404 (no confirma existencia)', async () => {
    const { controller } = makeController('otro-user');
    await expect(controller.getById(makeUser(), 'cert-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it.each(['formador', 'tenant_admin', 'super_admin'] as const)(
    'getById: staff %s ve certificados de otros',
    async (role) => {
      const { controller, cert } = makeController('otro-user');
      await expect(controller.getById(makeUser({ roles: [role] }), 'cert-1')).resolves.toEqual(
        cert,
      );
    },
  );

  it('download: un alumno ajeno recibe 404 y NO se renderiza el PDF', async () => {
    const { controller, spies } = makeController('otro-user');
    const reply = makeReply();
    await expect(controller.download(makeUser(), 'cert-1', reply as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(spies.renderCertificatePdf).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('download: el titular descarga su PDF', async () => {
    const { controller, spies } = makeController('user-1');
    const reply = makeReply();
    await controller.download(makeUser(), 'cert-1', reply as never);
    expect(spies.renderCertificatePdf).toHaveBeenCalledWith('tenant-A', 'cert-1');
    expect(reply.send).toHaveBeenCalled();
  });
});
