import { Controller, Get, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import type { SessionClaims } from '../auth/token.service';

type Range = 'week' | 'month' | 'all';

@ApiTags('Leaderboard')
@ApiBearerAuth()
@Controller('leaderboard')
@UseGuards(JwtAuthGuard)
export class LeaderboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({
    summary: 'Ranking de usuarios por puntos (posts, comentarios, lecciones completadas)',
  })
  async getLeaderboard(
    @CurrentUser() user: SessionClaims | undefined,
    @Query('range') range?: string,
  ) {
    if (!user) throw new UnauthorizedException();

    const validRange: Range = range === 'week' || range === 'month' ? range : 'all';

    let since: Date | undefined;
    const now = new Date();
    if (validRange === 'week') {
      since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
    } else if (validRange === 'month') {
      since = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    }

    const dateFilter = since ? { gte: since } : undefined;

    // Obtener posts y comentarios agrupados por autor en el tenant
    const [posts, comments] = await Promise.all([
      this.prisma.modCommunityPost.groupBy({
        by: ['authorId'],
        where: {
          tenantId: user.tenantId,
          deletedAt: null,
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
        _count: { id: true },
      }),
      this.prisma.modCommunityComment.groupBy({
        by: ['authorId'],
        where: {
          tenantId: user.tenantId,
          deletedAt: null,
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
        _count: { id: true },
      }),
    ]);

    // Calcular puntos: post × 10, comentario × 5
    const pointsMap = new Map<string, number>();
    for (const p of posts) {
      pointsMap.set(p.authorId, (pointsMap.get(p.authorId) ?? 0) + p._count.id * 10);
    }
    for (const c of comments) {
      pointsMap.set(c.authorId, (pointsMap.get(c.authorId) ?? 0) + c._count.id * 5);
    }

    if (pointsMap.size === 0) return [];

    // Resolver nombres de usuario
    const userIds = Array.from(pointsMap.keys());
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds }, tenantId: user.tenantId, deletedAt: null },
      select: { id: true, name: true, email: true },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));

    // Ordenar por puntos desc, asignar rank
    const ranked = Array.from(pointsMap.entries())
      .map(([userId, points]) => {
        const u = userMap.get(userId);
        return {
          userId,
          displayName: u?.name ?? u?.email ?? userId.slice(0, 8),
          points,
        };
      })
      .filter((e) => userMap.has(e.userId))
      .sort((a, b) => b.points - a.points)
      .slice(0, 50)
      .map((e, i) => ({ ...e, rank: i + 1 }));

    return ranked;
  }
}
