/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Lo que ve la INSPECCIÓN con las claves que el centro comunicó a Fundae
 * (LMS-123).
 *
 * Todo es de lectura y todo está acotado al grupo concedido: no hay un solo
 * verbo de escritura en este controlador, y cada endpoint vuelve a comprobar la
 * concesión contra la base —no se fía del rol— porque el rol dice «esta persona
 * es inspectora de algo» y lo que hace falta saber es «de ESTE grupo».
 *
 * El acceso al CONTENIDO del curso no pasa por aquí: lo da la matrícula
 * `source = INSPECTION` que se crea al conceder el acceso, y por tanto el
 * inspector recorre el aula por los mismos endpoints que un alumno, viendo
 * exactamente lo mismo que ve un alumno. Aquí solo está lo que un alumno no
 * puede ver: el seguimiento de los participantes del grupo.
 *
 * Un `tenant_admin` también entra —quien firma la bonificación necesita ver el
 * expediente tal y como lo verá la inspección antes de comunicarlo—.
 */
@ApiTags('Fundae · Seguimiento')
@ApiBearerAuth()
@Controller('fundae/inspection')
@UseGuards(JwtAuthGuard)
export class FundaeInspectionController {
  constructor(private readonly registry: ModuleRegistryService) {}

  @Get('groups')
  @ApiOperation({
    summary: 'Grupos que esta cuenta puede seguir ahora mismo (concesión viva y sin caducar).',
  })
  async myGroups(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.registry
      .getFundaeInspectorService()
      .listGroupsForInspector(user.tenantId, user.sub);
  }

  @Get('groups/:id')
  @ApiOperation({
    summary:
      'Expediente de seguimiento del grupo: participantes con horas defendibles y recorrido lección a lección (primer y último acceso, tiempo registrado, y qué respalda cada finalización).',
  })
  async inspect(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    const inspectors = this.registry.getFundaeInspectorService();

    // Un tenant_admin ve cualquier grupo de SU tenant; el resto, solo aquel
    // sobre el que tenga una concesión viva. Se comprueba contra la base en
    // cada llamada: una concesión revocada o caducada deja de abrir en el acto.
    const isAdmin = user.roles.some((r) => r === 'super_admin' || r === 'tenant_admin');
    if (!isAdmin) {
      const access = await inspectors.resolveAccess(user.tenantId, user.sub, id);
      if (!access) {
        throw new ForbiddenException({
          message: 'No tienes acceso de seguimiento a este grupo.',
          code: 'FUNDAE_INSPECTION_FORBIDDEN',
        });
      }
    }

    return inspectors.getInspectionView(user.tenantId, id);
  }
}
