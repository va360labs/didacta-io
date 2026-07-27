import {
  Body,
  Controller,
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

const createEventSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  location: z.string().max(200).optional(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  capacity: z.number().int().positive().optional(),
});

type CreateEventDto = z.infer<typeof createEventSchema>;

@ApiTags('Modules · Events')
@ApiBearerAuth()
@Controller('modules/events')
@UseGuards(JwtAuthGuard)
export class EventsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Lista eventos del tenant en rango de fechas' })
  async listEvents(
    @CurrentUser() user: SessionClaims | undefined,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limitStr?: string,
    @Query('order') order?: string,
  ) {
    if (!user) throw new UnauthorizedException();
    const limit = Math.min(100, Math.max(1, parseInt(limitStr ?? '50', 10) || 50));
    // `desc` sirve para consultar el pasado reciente: con `asc` el tope de
    // `limit` devuelve los eventos MÁS ANTIGUOS del rango y esconde los de
    // la semana pasada (el calendario pide el histórico en desc).
    const sortOrder: 'asc' | 'desc' = order === 'desc' ? 'desc' : 'asc';

    const now = new Date();
    const startFrom = from ? new Date(from) : now;
    const endTo = to
      ? new Date(to)
      : new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());

    const events = await this.prisma.modEvent.findMany({
      where: {
        tenantId: user.tenantId,
        deletedAt: null,
        startAt: { gte: startFrom, lte: endTo },
      },
      include: {
        _count: { select: { registrations: true } },
        registrations: {
          where: { userId: user.sub },
          select: { id: true },
        },
      },
      orderBy: { startAt: sortOrder },
      take: limit,
    });

    return events.map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      location: e.location,
      startAt: e.startAt,
      endAt: e.endAt,
      capacity: e.capacity,
      registeredCount: e._count.registrations,
      isFull: e.capacity !== null && e._count.registrations >= e.capacity,
      isRegistered: e.registrations.length > 0,
    }));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle del evento' })
  async getEvent(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();

    const event = await this.prisma.modEvent.findFirst({
      where: { id, tenantId: user.tenantId, deletedAt: null },
      include: {
        _count: { select: { registrations: true } },
        registrations: {
          where: { userId: user.sub },
          select: { id: true },
        },
      },
    });

    if (!event) throw new NotFoundException('Evento no encontrado');

    return {
      id: event.id,
      title: event.title,
      description: event.description,
      location: event.location,
      startAt: event.startAt,
      endAt: event.endAt,
      capacity: event.capacity,
      registeredCount: event._count.registrations,
      isFull: event.capacity !== null && event._count.registrations >= event.capacity,
      isRegistered: event.registrations.length > 0,
    };
  }

  @Post()
  @ApiOperation({ summary: 'Crear evento (solo admin/formador)' })
  async createEvent(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createEventSchema)) dto: CreateEventDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const isAdmin = user.roles.some((r) => ['super_admin', 'tenant_admin', 'formador'].includes(r));
    if (!isAdmin) throw new UnauthorizedException('Solo admins o formadores pueden crear eventos');

    return this.prisma.modEvent.create({
      data: {
        tenantId: user.tenantId,
        title: dto.title,
        description: dto.description,
        location: dto.location,
        startAt: new Date(dto.startAt),
        endAt: new Date(dto.endAt),
        capacity: dto.capacity,
        createdById: user.sub,
      },
    });
  }

  @Post(':id/register')
  @HttpCode(200)
  @ApiOperation({ summary: 'Inscribirse a un evento' })
  async registerToEvent(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();

    const event = await this.prisma.modEvent.findFirst({
      where: { id, tenantId: user.tenantId, deletedAt: null },
      include: { _count: { select: { registrations: true } } },
    });
    if (!event) throw new NotFoundException('Evento no encontrado');
    if (event.capacity !== null && event._count.registrations >= event.capacity) {
      return { registered: false, reason: 'full' };
    }

    await this.prisma.modEventRegistration.upsert({
      where: { mod_event_registration_unique: { eventId: id, userId: user.sub } },
      create: { eventId: id, tenantId: user.tenantId, userId: user.sub },
      update: {},
    });

    return { registered: true };
  }

  @Post(':id/unregister')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar inscripción a un evento' })
  async unregisterFromEvent(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
  ) {
    if (!user) throw new UnauthorizedException();

    const existing = await this.prisma.modEventRegistration.findUnique({
      where: { mod_event_registration_unique: { eventId: id, userId: user.sub } },
    });
    if (!existing) return { unregistered: false };

    await this.prisma.modEventRegistration.delete({
      where: { mod_event_registration_unique: { eventId: id, userId: user.sub } },
    });

    return { unregistered: true };
  }
}
