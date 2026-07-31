/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { CertificatesController } from './certificates.controller';
import { PublicCertificatesController } from './public-certificates.controller';
import { CertificatesErrorFilter } from './certificates-error.filter';

/// Backend del módulo `mod.certificates`. Encapsula el controller (CRUD
/// templates + emisión + descarga PDF) y el filter.
///
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [CertificatesController, PublicCertificatesController],
  providers: [{ provide: APP_FILTER, useClass: CertificatesErrorFilter }],
})
export class CertificatesModule {}
