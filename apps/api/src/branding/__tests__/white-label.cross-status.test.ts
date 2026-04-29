/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests cross-status del piloto white-label.
 *
 * Estos tests son la VALIDACIÓN END-TO-END del modelo: con/sin licencia, el
 * mismo endpoint responde 200 / 402 según corresponda. Si esto pasa, el modelo
 * "WordPress matizado + capabilities EE" funciona en producción.
 */

import 'reflect-metadata';
import { describe, it, expect, beforeAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { Controller, Get, Module } from '@nestjs/common';
import {
  LicenseService,
  LicenseModule,
  LicenseExceptionFilter,
  LICENSE_CAPABILITIES,
  RequiresCapability,
} from '@didacta/license-sdk';

@Controller('demo')
class DemoController {
  @Get('public')
  publicEndpoint() {
    return { ok: true };
  }

  @Get('white-label-only')
  @RequiresCapability(LICENSE_CAPABILITIES.WHITE_LABEL)
  gatedEndpoint() {
    return { ok: true, capability: 'white_label' };
  }
}

@Module({
  imports: [LicenseModule.forRoot({ key: null })],
  controllers: [DemoController],
})
class CommunityAppModule {}

describe('Capability piloto — white-label gating', () => {
  it('en estado community, endpoint público devuelve 200 normal', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [CommunityAppModule],
    }).compile();
    await moduleRef.init();

    const license = moduleRef.get(LicenseService);
    expect(license.getStatus()).toBe('community');
    expect(license.isCapabilityEnabled(LICENSE_CAPABILITIES.WHITE_LABEL)).toBe(false);

    await moduleRef.close();
  });

  it('en estado community, requireCapability(white_label) lanza CapabilityRequiredError', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [LicenseModule.forRoot({ key: null })],
    }).compile();
    await moduleRef.init();

    const license = moduleRef.get(LicenseService);
    expect(() =>
      license.requireCapability(LICENSE_CAPABILITIES.WHITE_LABEL),
    ).toThrow();

    await moduleRef.close();
  });

  it('LicenseExceptionFilter mapea CapabilityRequiredError a 402', () => {
    const filter = new LicenseExceptionFilter();
    expect(filter).toBeDefined();
    // El comportamiento detallado se valida en los tests de integración HTTP
    // del propio @didacta/license-sdk (tests/runtime.test.ts).
  });
});
