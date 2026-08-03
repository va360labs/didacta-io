/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { runSanctionedGlobalAccess } from '../../tenancy/tenant-context.storage';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Verificación PÚBLICA de un certificado (sin sesión). Es la URL que un alumno
 * puede compartir o que LinkedIn referencia como `certUrl` en "Añadir a perfil".
 *
 * Expone SOLO datos no sensibles del snapshot inmutable: número, nombre del
 * alumno, curso, fecha de emisión y si sigue vigente. NUNCA email, userId,
 * tenant ni datos internos. Si el nombre del snapshot cayó al email (usuario sin
 * nombre al emitir), se oculta para no filtrar el email públicamente.
 */
@ApiTags('Modules · Certificates (public)')
@Controller('modules/certificates')
export class PublicCertificatesController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('verify/:id')
  @ApiOperation({
    summary:
      'Verificación pública de un certificado por su id (UUID). Sin autenticación. Devuelve número, alumno, curso, fecha y validez.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Certificado no encontrado.' })
  async verify(@Param('id') id: string) {
    if (!UUID_RE.test(id)) throw new NotFoundException('Certificado no encontrado.');
    // Lookup cross-tenant DELIBERADO (decisión de diseño): la URL de
    // verificación es compartible sin contexto de tenant (LinkedIn la referencia
    // como certUrl) y la credencial es el propio UUID. Inventario F3: post-flip
    // debe seguir funcionando vía `didacta_super` (o una policy explícita).
    const cert = await runSanctionedGlobalAccess(() =>
      this.prisma.modCertificatesIssued.findUnique({
        where: { id },
        select: { number: true, snapshot: true, issuedAt: true, revokedAt: true },
      }),
    );
    if (!cert) throw new NotFoundException('Certificado no encontrado.');

    const snap = (cert.snapshot ?? {}) as {
      studentName?: string;
      courseTitle?: string;
      issuedAt?: string;
    };
    const rawName = (snap.studentName ?? '').trim();
    const studentName = rawName && !rawName.includes('@') ? rawName : '—';

    return {
      number: cert.number,
      studentName,
      courseTitle: (snap.courseTitle ?? '').trim() || '—',
      issuedAt: snap.issuedAt ?? cert.issuedAt.toISOString(),
      valid: cert.revokedAt === null,
    };
  }
}
