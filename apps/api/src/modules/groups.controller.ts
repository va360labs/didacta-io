import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import type { SessionClaims } from '../auth/token.service';

const createGroupSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/),
  description: z.string().max(500).optional(),
});

type CreateGroupDto = z.infer<typeof createGroupSchema>;

@ApiTags('Modules · Groups')
@ApiBearerAuth()
@Controller('modules/groups')
@UseGuards(JwtAuthGuard)
export class GroupsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Lista grupos del tenant (paginada)' })
  async listGroups(
    @CurrentUser() user: SessionClaims | undefined,
    @Query('page') pageStr?: string,
    @Query('limit') limitStr?: string,
  ) {
    if (!user) throw new UnauthorizedException();
    const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(limitStr ?? '20', 10) || 20));
    const skip = (page - 1) * limit;

    const where = { tenantId: user.tenantId, deletedAt: null };
    const [groups, total] = await Promise.all([
      this.prisma.modGroup.findMany({
        where,
        include: { _count: { select: { members: true } } },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.modGroup.count({ where }),
    ]);

    return {
      groups: groups.map((g) => ({ ...g, memberCount: g._count.members })),
      total,
    };
  }

  @Get('me')
  @ApiOperation({ summary: 'Grupos a los que pertenece el usuario autenticado' })
  async listMyGroups(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();

    const memberships = await this.prisma.modGroupMember.findMany({
      where: { tenantId: user.tenantId, userId: user.sub },
      include: { group: true },
    });

    return memberships
      .filter((m) => !m.group.deletedAt)
      .map((m) => ({ ...m.group, myRole: m.role }));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle del grupo' })
  async getGroup(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();

    const group = await this.prisma.modGroup.findFirst({
      where: { id, tenantId: user.tenantId, deletedAt: null },
      include: {
        members: {
          select: { userId: true, role: true, joinedAt: true },
          take: 50,
        },
        _count: { select: { members: true } },
      },
    });

    if (!group) throw new NotFoundException('Grupo no encontrado');
    return { ...group, memberCount: group._count.members };
  }

  @Post()
  @ApiOperation({ summary: 'Crear grupo (solo admin/formador)' })
  async createGroup(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createGroupSchema)) dto: CreateGroupDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const isAdmin = user.roles.some((r) => ['super_admin', 'tenant_admin', 'formador'].includes(r));
    if (!isAdmin) throw new UnauthorizedException('Solo admins o formadores pueden crear grupos');

    const group = await this.prisma.modGroup.create({
      data: {
        tenantId: user.tenantId,
        name: dto.name,
        slug: dto.slug,
        description: dto.description,
      },
    });

    await this.prisma.modGroupMember.create({
      data: {
        groupId: group.id,
        tenantId: user.tenantId,
        userId: user.sub,
        role: 'owner',
      },
    });

    return { ...group, memberCount: 1 };
  }

  @Post(':id/join')
  @HttpCode(200)
  @ApiOperation({ summary: 'Unirse a un grupo' })
  async joinGroup(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();

    const group = await this.prisma.modGroup.findFirst({
      where: { id, tenantId: user.tenantId, deletedAt: null },
    });
    if (!group) throw new NotFoundException('Grupo no encontrado');

    await this.prisma.modGroupMember.upsert({
      where: { mod_group_member_unique: { groupId: id, userId: user.sub } },
      create: { groupId: id, tenantId: user.tenantId, userId: user.sub, role: 'member' },
      update: {},
    });

    await this.prisma.modGroup.update({
      where: { id },
      data: { memberCount: { increment: 1 } },
    });

    return { joined: true };
  }

  @Delete(':id/leave')
  @HttpCode(200)
  @ApiOperation({ summary: 'Abandonar un grupo' })
  async leaveGroup(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();

    const existing = await this.prisma.modGroupMember.findUnique({
      where: { mod_group_member_unique: { groupId: id, userId: user.sub } },
    });
    if (!existing) return { left: false };

    await this.prisma.modGroupMember.delete({
      where: { mod_group_member_unique: { groupId: id, userId: user.sub } },
    });

    await this.prisma.modGroup.update({
      where: { id },
      data: { memberCount: { decrement: 1 } },
    });

    return { left: true };
  }
}
