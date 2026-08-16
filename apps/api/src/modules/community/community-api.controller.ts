/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { createPostSchema } from '@didacta/mod-community';
import { JwtOrApiKeyGuard } from '../../auth/api-key.guard';
import { ApiScopeGuard } from '../../auth/api-scope.guard';
import { RequireApiScopes } from '../../auth/api-scope.decorator';
import { CurrentUser } from '../../auth/decorators';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ModuleRegistryService } from '../module-registry.service';
import { CommunityBroadcastWorker } from './community-broadcast.worker';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

/**
 * Body del endpoint externo: el de la UI + `space` EXPLÍCITO (slug del
 * espacio). Se valida contra los espacios reales del tenant y se convierte en
 * el PRIMER tag del post — el mismo convenio que usa el composer de la web
 * (el feed de un espacio filtra por su slug como tag).
 */
const apiCreatePostSchema = createPostSchema.extend({
  space: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,59}$/)
    .optional(),
});
type ApiCreatePostDto = z.infer<typeof apiCreatePostSchema>;

/**
 * API EXTERNA de la comunidad (integradores: n8n, Zapier, scripts…).
 *
 * Autenticada con API key del tenant (`Authorization: ApiKey lmsk_…`, se crean
 * en /admin/api-keys) y scope `community:post` — sin tokens que caducan cada
 * hora. El AUTOR del post es el usuario dueño de la key (quien la creó): cada
 * admin usa su propia key y lo publicado queda firmado por él. Los posts
 * creados por aquí llevan `source='api'` y se auditan en
 * /admin/comunidad/publicaciones-api.
 */
@ApiTags('Comunidad (API externa)')
@ApiSecurity('ApiKey')
@Controller('community-api')
@UseGuards(JwtOrApiKeyGuard, ApiScopeGuard)
@RequireApiScopes('community:post')
export class CommunityApiController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
    private readonly broadcast: CommunityBroadcastWorker,
  ) {}

  @Get('spaces')
  @ApiOperation({
    summary: 'Listar los espacios de la comunidad (para elegir dónde publicar)',
    description:
      'Devuelve los espacios reales del tenant con su `slug` — el valor que se pasa en el ' +
      'campo `space` de POST /community-api/posts. Requiere scope `community:post`.',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        spaces: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string', example: 'general' },
              title: { type: 'string', example: 'General' },
            },
          },
        },
      },
    },
  })
  async listSpaces(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const spaces = await this.registry.getCommunityService().listSpaces(user.tenantId);
    return { spaces: spaces.map((s) => ({ slug: s.slug, title: s.title })) };
  }

  @Post('posts')
  @ApiOperation({
    summary: 'Publicar en la comunidad con API key (autor = dueño de la key)',
    description:
      'Crea un post en el feed de la comunidad firmado por el usuario dueño de la API key. ' +
      'El dueño debe ser admin (super_admin/tenant_admin) del tenant. `space` elige el ' +
      'espacio (slug de GET /community-api/spaces; 422 si no existe; sin él, el post va al ' +
      'espacio "general" si existe). Con `notifyAll: true` se avisa además por EMAIL + ' +
      'campana a todos los miembros (`important` ignora las bajas de avisos). Requiere una ' +
      'API key con scope `community:post` en el header `Authorization: ApiKey lmsk_…`. El ' +
      'post queda marcado con origen API y es auditable en /admin/comunidad/publicaciones-api.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['title', 'body'],
      properties: {
        title: { type: 'string', minLength: 3, maxLength: 200, example: 'Novedades de la semana' },
        body: {
          type: 'string',
          minLength: 1,
          maxLength: 10_000,
          example: 'Esta semana hemos publicado…',
        },
        space: {
          type: 'string',
          description:
            'Slug del espacio donde publicar (GET /community-api/spaces). 422 si no existe. ' +
            'Por defecto: "general" (si el tenant lo tiene).',
          example: 'general',
        },
        tags: {
          type: 'array',
          items: { type: 'string', maxLength: 40 },
          maxItems: 10,
          description: 'Tags ADICIONALES del post (el espacio ya va como primer tag).',
          example: ['anuncio'],
        },
        courseId: {
          type: 'string',
          format: 'uuid',
          description: 'Opcional: liga el post a un curso.',
        },
        notifyAll: {
          type: 'boolean',
          description: 'Además de publicar, avisa por email + campana a TODOS los miembros.',
        },
        important: {
          type: 'boolean',
          description: 'Con notifyAll: ignora la baja de avisos de los receptores.',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Post creado (devuelve el post completo con su id).' })
  @ApiResponse({ status: 401, description: 'API key ausente, inválida, expirada o revocada.' })
  @ApiResponse({
    status: 403,
    description: 'La key no tiene el scope `community:post` o su dueño ya no es admin.',
  })
  @ApiResponse({
    status: 422,
    description: 'El `space` indicado no existe (la respuesta lista los slugs válidos).',
  })
  @ApiResponse({ status: 429, description: 'Límite de peticiones superado.' })
  async createPost(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(apiCreatePostSchema)) dto: ApiCreatePostDto,
  ) {
    if (!user) throw new UnauthorizedException();

    // El autor es el dueño de la key. Verificamos que exista en el tenant y
    // que SIGA siendo admin (una key de un admin degradado deja de publicar).
    const owner = await this.prisma.user.findFirst({
      where: { id: user.sub, tenantId: user.tenantId, deletedAt: null },
      select: {
        name: true,
        email: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!owner)
      throw new UnauthorizedException({
        message: 'El usuario dueño de la API key no existe.',
        code: 'COMMUNITY_API_KEY_OWNER_NOT_FOUND',
      });
    const roleNames = owner.roles.map((r) => r.role.name);
    if (!roleNames.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException({
        message:
          'Solo las API keys de un admin (super_admin/tenant_admin) pueden publicar en la comunidad.',
        code: 'COMMUNITY_API_KEY_ADMIN_REQUIRED',
      });
    }

    const author = { id: user.sub, displayName: owner.name ?? owner.email ?? null };
    const svc = this.registry.getCommunityService();

    // Espacio destino → PRIMER tag (convenio del composer web). Con `space`
    // explícito validamos contra los espacios reales; sin él caemos al
    // espacio "general" si el tenant lo tiene (default de la UI).
    const spaces = await svc.listSpaces(user.tenantId);
    let spaceSlug: string | null;
    if (dto.space) {
      const match = spaces.find((s) => s.slug === dto.space);
      if (!match) {
        throw new UnprocessableEntityException({
          message: `El espacio "${dto.space}" no existe. Espacios válidos: ${
            spaces.map((s) => s.slug).join(', ') ||
            '(ninguno — créalos en /admin/comunidad/espacios)'
          }. Consulta GET /community-api/spaces.`,
          code: 'COMMUNITY_SPACE_UNKNOWN',
        });
      }
      spaceSlug = match.slug;
    } else {
      spaceSlug = spaces.find((s) => s.slug === 'general')?.slug ?? null;
    }
    const { space: _space, ...postInput } = dto;
    const finalTags = [...new Set([...(spaceSlug ? [spaceSlug] : []), ...(dto.tags ?? [])])];
    const post = await svc.createPost(
      user.tenantId,
      author,
      { ...postInput, tags: finalTags },
      'api',
    );

    // Mismo comportamiento que la UI: notifyAll crea el broadcast (email +
    // campana). El dueño ya está verificado como admin.
    if (dto.notifyAll) {
      const markerIdx = post.body.indexOf('<!--didacta-attachments:');
      const cleanBody = (markerIdx === -1 ? post.body : post.body.slice(0, markerIdx)).trim();
      const b = await svc.createBroadcast(user.tenantId, user.sub, {
        subject: post.title,
        bodyText: `${author.displayName ?? 'Un administrador'} ha publicado en la comunidad:\n\n${cleanBody.slice(0, 600)}`,
        important: dto.important,
        postId: post.id,
      });
      await this.broadcast.enqueue(b.id);
    }

    return post;
  }
}
