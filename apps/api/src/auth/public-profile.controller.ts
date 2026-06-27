import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from './decorators';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { SessionClaims } from './token.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Perfil público de usuarios del MISMO tenant. Lo consume la comunidad para:
 *   - pintar avatares en posts/comentarios (batch por ids), y
 *   - la página de perfil público `/u/[id]` (nombre, avatar, cargo, depto,
 *     ubicación, bio).
 *
 * Requiere sesión (JwtAuthGuard) y SIEMPRE filtra por el tenant del viewer: un
 * usuario solo ve perfiles de su propia organización. No expone email ni datos
 * sensibles (DNI, roles, etc.).
 */
@ApiTags('Users · Public profile')
@ApiBearerAuth()
@Controller('users')
@UseGuards(JwtAuthGuard)
export class PublicProfileController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Datos públicos mínimos (id, name, avatarUrl) de varios usuarios del tenant.
   * `?ids=a,b,c` (máx 100). Para resolver avatares del feed sin N requests.
   */
  @Get('public')
  @ApiOperation({ summary: 'Avatar + nombre de varios usuarios del tenant (?ids=a,b,c).' })
  @ApiResponse({ status: 200 })
  async batch(@CurrentUser() user: SessionClaims, @Query('ids') ids?: string) {
    const idList = (ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 100);
    if (idList.length === 0) return { users: [] };
    const users = await this.prisma.user.findMany({
      where: { tenantId: user.tenantId, id: { in: idList }, deletedAt: null },
      select: { id: true, name: true, avatarUrl: true },
    });
    return { users };
  }

  /** Perfil público completo de un usuario del tenant. */
  @Get(':id/public-profile')
  @ApiOperation({
    summary:
      'Perfil público (nombre, avatar, cargo, depto, ubicación, bio) de un usuario del tenant.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado en este tenant.' })
  async profile(@CurrentUser() user: SessionClaims, @Param('id') id: string) {
    const u = await this.prisma.user.findFirst({
      where: { id, tenantId: user.tenantId, deletedAt: null },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        bio: true,
        jobTitle: true,
        department: true,
        location: true,
        createdAt: true,
      },
    });
    if (!u) throw new NotFoundException('Usuario no encontrado.');
    return u;
  }
}
