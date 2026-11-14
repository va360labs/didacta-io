/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Body, Controller, Get, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractClientContext } from '../auth/client-context';
import { CurrentUser, MfaExempt } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { SupportAccessService } from './support-access.service';
import { LoginRateLimit } from '../rate-limit/login-limit.interceptor';

const redeemSchema = z.object({
  token: z.string().min(1).max(200),
});
type RedeemDto = z.infer<typeof redeemSchema>;

/**
 * Canje de un acceso de soporte (U8).
 *
 * Público por necesidad: quien canjea todavía no tiene sesión — precisamente
 * está pidiendo una. Lo que lo protege es el propio token: 256 bits de
 * aleatoriedad, de un solo uso y con una ventana de minutos.
 *
 * Vive fuera de `AdminTenantsController` a propósito. Ese controller es la
 * superficie que abre la credencial de provisioning, y su test de superficie
 * cuenta las rutas de una en una; meter aquí un endpoint sin guard habría hecho
 * ese recuento menos legible justo en el sitio donde tiene que serlo más.
 */
@ApiTags('Auth')
@Controller('auth/support-access')
export class SupportAccessController {
  constructor(private readonly supportAccess: SupportAccessService) {}

  @Post('redeem')
  @LoginRateLimit('support-redeem')
  @ApiOperation({
    summary: 'Canjea un token de acceso de soporte por una sesión de duración limitada.',
    description: [
      'Devuelve un `accessToken` que caduca cuando caduca la concesión y **no trae',
      'refresh token**: una sesión de soporte no se renueva, se acaba.',
      '',
      'Errores: `400 SUPPORT_ACCESS_INVALID` (token que no existe),',
      '`410 SUPPORT_ACCESS_EXPIRED` / `SUPPORT_ACCESS_ALREADY_REDEEMED` /',
      '`SUPPORT_ACCESS_REVOKED` (existió y ya no vale) y',
      '`403 SUPPORT_ACCESS_TENANT_UNAVAILABLE`.',
    ].join('\n'),
  })
  async redeem(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(redeemSchema)) dto: RedeemDto,
  ) {
    return this.supportAccess.redeem(dto.token, extractClientContext(req));
  }

  /**
   * ¿La sesión que hace esta llamada es un acceso de soporte, y sigue viva?
   *
   * Lo consume el aula para pintar el aviso permanente y su cuenta atrás. Que
   * la fuente sea el servidor y no lo que quedó guardado en el navegador
   * importa: una concesión revocada tiene que apagar el aviso —y con él la
   * sesión— sin esperar a que nadie recargue.
   *
   * Devuelve `{ support: null }` para cualquier sesión normal, que es el caso
   * de casi todo el mundo casi siempre.
   */
  @Get('current')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @MfaExempt()
  @ApiOperation({
    summary: 'Acceso de soporte de la sesión actual, o null si es una sesión normal.',
  })
  async current(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    if (!user.sup) return { support: null };
    return { support: await this.supportAccess.describeActive(user.sup) };
  }
}
