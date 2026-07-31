/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import type { SessionClaims } from '../../auth/token.service';

@ApiTags('Modules · Notifications (alumno)')
@ApiBearerAuth()
@Controller('me/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Listar mis notificaciones IN_APP, más recientes primero' })
  async listMine(@CurrentUser() user: SessionClaims | undefined): Promise<unknown[]> {
    if (!user) throw new UnauthorizedException();
    return this.prisma.notification.findMany({
      where: { tenantId: user.tenantId, userId: user.sub, channel: 'IN_APP' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marcar una notificación como leída' })
  async markRead(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    await this.prisma.notification.updateMany({
      where: { id, tenantId: user.tenantId, userId: user.sub, readAt: null },
      data: { readAt: new Date() },
    });
    return { read: true };
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marcar todas las notificaciones IN_APP como leídas' })
  async markAllRead(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const result = await this.prisma.notification.updateMany({
      where: {
        tenantId: user.tenantId,
        userId: user.sub,
        channel: 'IN_APP',
        readAt: null,
      },
      data: { readAt: new Date() },
    });
    return { count: result.count };
  }
}
