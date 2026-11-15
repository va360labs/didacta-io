/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CAPTURA_MAX_BYTES,
  ESTADOS_TICKET,
  LIMITES,
  TicketNoEncontradoError,
  TIPOS_TICKET,
  type EstadoTicket,
  type TipoTicket,
} from '@didacta/mod-soporte';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { ModuleRegistryService } from '../module-registry.service';
import {
  CAPTURA_RESPONSE_HEADERS,
  callerDe,
  capturaDisposition,
  resolverAutorTicket,
} from './soporte.ports';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Tope del base64 de la captura: algo más que 5 MB decodificados, para que lo
 * que se pase por poco lo rechace el servicio con SOPORTE_CAPTURA_PESADA, y lo
 * que se pase por mucho no llegue ni a decodificarse.
 */
const CAPTURA_MAX_BASE64 = Math.ceil((CAPTURA_MAX_BYTES * 1.2) / 3) * 4;

/**
 * Solo la forma del cuerpo (tipos y tamaños máximos holgados). Las reglas de
 * negocio —texto de 5 a 4000, captura de verdad PNG/JPEG/WebP de hasta 5 MB,
 * el contexto recortado, el límite diario— son del servicio del módulo, que da
 * el `code` que la web traduce.
 */
export const crearTicketSchema = z.object({
  tipo: z.enum(TIPOS_TICKET),
  texto: z.string().max(LIMITES.textoMax * 2),
  contexto: z
    .object({
      url: z.string().max(4000).nullable().optional(),
      userAgent: z.string().max(4000).nullable().optional(),
      viewport: z.string().max(200).nullable().optional(),
      at: z.string().max(100).nullable().optional(),
    })
    .nullable()
    .optional(),
  captura: z
    .object({
      /** Bytes en base64, sin el prefijo `data:...,`. */
      data: z.string().max(CAPTURA_MAX_BASE64),
      filename: z.string().max(200),
      contentType: z.string().max(100),
    })
    .nullable()
    .optional(),
});
type CrearTicketDto = z.infer<typeof crearTicketSchema>;

export const actualizarTicketSchema = z
  .object({
    estado: z.enum(ESTADOS_TICKET).optional(),
    notaInterna: z
      .string()
      .max(LIMITES.notaInterna * 2)
      .nullable()
      .optional(),
  })
  .refine((b) => b.estado !== undefined || b.notaInterna !== undefined, {
    message: 'Indica el estado o la nota interna.',
  });
type ActualizarTicketDto = z.infer<typeof actualizarTicketSchema>;

/**
 * Backend HTTP de `mod.soporte` («Ayuda y sugerencias»). Fino a propósito:
 * resuelve quién llama (y si administra el aula) y el nombre del autor, y
 * delega todo lo demás en el servicio del módulo, que es quien decide quién ve
 * qué. Con el módulo apagado para el aula, el `ModuleAccessInterceptor` corta
 * antes de llegar aquí (403).
 */
@ApiTags('Modules · Soporte')
@ApiBearerAuth()
@Controller('modules/soporte')
@UseGuards(JwtAuthGuard)
export class SoporteController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('tickets')
  @ApiOperation({
    summary:
      'Abrir un ticket (algo no funciona, tengo un problema, tengo una sugerencia) con captura opcional. Un miembro escribe al equipo del aula; quien administra el aula, a Didacta. Como mucho 5 en 24 horas. Responde en cuanto se guarda; los avisos salen después.',
  })
  async crear(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(crearTicketSchema)) dto: CrearTicketDto,
  ) {
    const u = this.requireUser(user);
    // El destino (aula o Didacta) lo decide el servicio con los roles de la
    // sesión; el esquema del cuerpo ni siquiera admite un campo `destino`.
    return this.service().crear(u.tenantId, await resolverAutorTicket(this.prisma, u), dto);
  }

  @Get('canal')
  @ApiOperation({
    summary:
      'A quién iría un ticket de quien llama (AULA si es miembro, PLATAFORMA si administra el aula) y si hay alguien al otro lado. La web no enseña el botón si no.',
  })
  async canal(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireUser(user);
    return this.service().canal(callerDe(u));
  }

  @Get('tickets/mios')
  @ApiOperation({ summary: 'Mis tickets y su estado, del más nuevo al más antiguo.' })
  async mios(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireUser(user);
    return this.service().mios(u.tenantId, u.sub);
  }

  @Get('tickets/:id/captura')
  @ApiOperation({
    summary:
      'La captura de un ticket, para su autor o quien administra el aula (404 a cualquier otro).',
  })
  async captura(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const u = this.requireUser(user);
    const archivo = await this.service().captura(u.tenantId, callerDe(u), this.uuid(id));
    for (const [name, value] of Object.entries(CAPTURA_RESPONSE_HEADERS)) {
      reply.header(name, value);
    }
    return new StreamableFile(archivo.data, {
      type: archivo.contentType,
      disposition: capturaDisposition(archivo.nombre),
      length: archivo.data.length,
    });
  }

  @Get('admin/tickets')
  @ApiOperation({
    summary:
      'Equipo del aula: tickets con filtros ?estado=&tipo= (los 200 más nuevos) y cuántos hay en cada estado.',
  })
  async listarAdmin(
    @CurrentUser() user: SessionClaims | undefined,
    @Query('estado') estado?: string,
    @Query('tipo') tipo?: string,
  ) {
    const u = this.requireUser(user);
    return this.service().listarAdmin(u.tenantId, callerDe(u), {
      // Un filtro desconocido no filtra: se ignora.
      estado: (ESTADOS_TICKET as readonly string[]).includes(estado ?? '')
        ? (estado as EstadoTicket)
        : undefined,
      tipo: (TIPOS_TICKET as readonly string[]).includes(tipo ?? '')
        ? (tipo as TipoTicket)
        : undefined,
    });
  }

  @Get('admin/menu')
  @ApiOperation({
    summary:
      '`allowed` dice si quien llama ve la bandeja y `badge` cuántos tickets nuevos hay sin coger.',
  })
  async menuAdmin(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireUser(user);
    return this.service().menuAdmin(u.tenantId, callerDe(u));
  }

  @Get('admin/tickets/:id')
  @ApiOperation({ summary: 'Equipo del aula: un ticket con su autor, contexto y nota interna.' })
  async obtenerAdmin(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireUser(user);
    return this.service().obtenerAdmin(u.tenantId, callerDe(u), this.uuid(id));
  }

  @Patch('admin/tickets/:id')
  @ApiOperation({
    summary:
      'Equipo del aula: cambiar el estado o la nota interna. Si el estado cambia, se avisa a quien lo abrió.',
  })
  async actualizarAdmin(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(actualizarTicketSchema)) dto: ActualizarTicketDto,
  ) {
    const u = this.requireUser(user);
    return this.service().actualizarAdmin(u.tenantId, callerDe(u), this.uuid(id), dto);
  }

  private service() {
    return this.registry.getSoporteService();
  }

  private requireUser(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    return user;
  }

  /** Un id que no es uuid no puede existir: 404 sin preguntar a la base. */
  private uuid(id: string): string {
    if (!UUID_RE.test(id)) throw new TicketNoEncontradoError();
    return id;
  }
}
