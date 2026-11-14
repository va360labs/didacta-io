/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * La vista previa de una plantilla de certificado sale en el idioma de quien la
 * mira: el controller le pasa al módulo QUIÉN mira (el módulo lee su idioma;
 * ver `modules/certificates/tests/issue.service.test.ts`).
 */

import { describe, expect, it, vi } from 'vitest';
import { CertificatesController } from '../src/modules/certificates/certificates.controller';

describe('CertificatesController · vista previa en el idioma de quien la mira', () => {
  it('pasa el usuario de la sesión al render de la vista previa', async () => {
    const renderTemplatePreview = vi.fn(async () => Buffer.from('%PDF-1.3'));
    const controller = new CertificatesController({
      getCertificatesService: () => ({ renderTemplatePreview }),
    } as never);
    const reply = {
      header: vi.fn(() => reply),
      send: vi.fn(() => reply),
    };
    const dto = { name: 'Modelo', body: 'Corpo' };

    await controller.previewTemplate(
      { sub: 'u-formadora', tenantId: 't1', roles: ['formador'], mfaVerified: true } as never,
      dto,
      reply as never,
    );

    expect(renderTemplatePreview).toHaveBeenCalledWith('t1', dto, 'u-formadora');
    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'application/pdf');
  });
});
