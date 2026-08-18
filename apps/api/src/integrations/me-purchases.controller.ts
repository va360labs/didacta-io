/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { SessionClaims } from '../auth/token.service';
import { IntegrationsService } from './integrations.service';

/**
 * Las compras del alumno **que está mirando su propio perfil**.
 *
 * Existe por separado de `/integrations/learners/orders` porque las dos
 * preguntas se parecen y no son la misma:
 *
 * - `/integrations/learners/orders` la hace una TIENDA con su API key, por
 *   email, y puede preguntar por cualquier alumno del tenant. Por eso su scope
 *   está separado.
 * - esta la hace el ALUMNO con su sesión, sobre sí mismo y sin poder indicar de
 *   quién. No hay parámetro que manipular: el sujeto es el token.
 *
 * Es lo que hace que el historial de compra viva de verdad en el perfil, y no
 * solo en una tabla que únicamente sabe leer quien lo escribió.
 */
@ApiTags('Me')
@ApiBearerAuth()
@Controller('me/purchases')
@UseGuards(JwtAuthGuard)
export class MePurchasesController {
  constructor(private readonly service: IntegrationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Mis compras hechas en la tienda externa del centro',
    description:
      'Los pedidos que la tienda del centro dejó en `POST /integrations/orders`, con su ' +
      'importe y —si se emitió— el número de factura y el enlace al PDF que sirve quien la ' +
      'emitió. Didacta no factura: aquí no se genera ningún documento. ' +
      'La lista sale vacía, y eso es lo normal, en cualquier instalación donde no venda una ' +
      'tienda externa.',
  })
  @ApiResponse({ status: 200, description: 'Mis compras, de la más reciente a la más antigua.' })
  @ApiResponse({ status: 401, description: 'Sin sesión.' })
  async list(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.service.listOwnOrders(user.tenantId, user.sub);
  }
}
