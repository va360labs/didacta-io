import {
  Body,
  Controller,
  ForbiddenException,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { createPostSchema, type CreatePostDto } from '@didacta/mod-community';
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

  @Post('posts')
  @ApiOperation({
    summary: 'Publicar en la comunidad con API key (autor = dueño de la key)',
    description:
      'Crea un post en el feed de la comunidad firmado por el usuario dueño de la API key. ' +
      'El dueño debe ser admin (super_admin/tenant_admin) del tenant. Para colocar el post en ' +
      'un espacio, incluye su tag en `tags` (los espacios filtran por tag). Con `notifyAll` ' +
      'se avisa además por email + campana a todos los miembros (`important` ignora las bajas ' +
      'de avisos). Requiere una API key con scope `community:post` en el header ' +
      '`Authorization: ApiKey lmsk_…`. El post queda marcado con origen API y es auditable ' +
      'en /admin/comunidad/publicaciones-api.',
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
        tags: {
          type: 'array',
          items: { type: 'string', maxLength: 40 },
          maxItems: 10,
          description: 'Tags del post. Usa el tag de un espacio para publicarlo en ese espacio.',
          example: ['general'],
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
  @ApiResponse({ status: 429, description: 'Límite de peticiones superado.' })
  async createPost(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createPostSchema)) dto: CreatePostDto,
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
    if (!owner) throw new UnauthorizedException('El usuario dueño de la API key no existe.');
    const roleNames = owner.roles.map((r) => r.role.name);
    if (!roleNames.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException(
        'Solo las API keys de un admin (super_admin/tenant_admin) pueden publicar en la comunidad.',
      );
    }

    const author = { id: user.sub, displayName: owner.name ?? owner.email ?? null };
    const svc = this.registry.getCommunityService();
    const post = await svc.createPost(user.tenantId, author, dto, 'api');

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
