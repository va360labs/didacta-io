/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * NestJS integration: decorator @RequiresCapability(...) + LicenseGuard.
 *
 * Diseñado como import condicional: si Nest no está disponible (proyecto
 * frontend, tests aislados), no rompe.
 */

import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { LicenseCapability } from './capabilities.js';
import { LicenseService } from './runtime.js';
import { CapabilityRequiredError } from './types.js';

export const REQUIRES_CAPABILITY_KEY = 'didacta:requires_capability';
export const LICENSE_SERVICE_TOKEN = 'DIDACTA_LICENSE_SERVICE';

/**
 * Decorator que marca un endpoint o un método como gateado por una capability.
 * Si la licencia no tiene esa capability, el LicenseGuard rechaza la petición
 * con CapabilityRequiredError (HTTP 402 Payment Required cuando se serializa).
 *
 * @example
 *   @Post('configure')
 *   @RequiresCapability(LICENSE_CAPABILITIES.SSO_SAML)
 *   configure(@Body() dto: ConfigureSamlDto) { ... }
 */
export function RequiresCapability(
  capability: LicenseCapability | string,
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(REQUIRES_CAPABILITY_KEY, capability),
    UseGuards(LicenseGuard),
  );
}

/**
 * Guard de NestJS que lee el metadata `didacta:requires_capability` y comprueba
 * la licencia activa. Espera que el LicenseService esté registrado en el módulo
 * raíz como provider con token `LICENSE_SERVICE_TOKEN` o como clase directa.
 */
@Injectable()
export class LicenseGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(LicenseService)
    private readonly license: LicenseService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<
      LicenseCapability | string | undefined
    >(REQUIRES_CAPABILITY_KEY, [ctx.getHandler(), ctx.getClass()]);

    if (!required) return true;

    if (!this.license.isCapabilityEnabled(required)) {
      throw new CapabilityRequiredError(required);
    }
    return true;
  }
}
