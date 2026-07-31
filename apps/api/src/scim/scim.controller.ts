/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * ScimController — endpoints SCIM 2.0 (séptimo piloto License SDK).
 *
 *   GET    /scim/v2/ServiceProviderConfig   (siempre disponible — discovery)
 *   GET    /scim/v2/ResourceTypes           (siempre disponible — discovery)
 *   GET    /scim/v2/Schemas                 (siempre disponible — discovery)
 *   GET    /scim/v2/Users                   gateado feat:scim
 *   GET    /scim/v2/Users/:id               gateado feat:scim
 *   POST   /scim/v2/Users                   gateado feat:scim
 *   PATCH  /scim/v2/Users/:id               gateado feat:scim
 *   DELETE /scim/v2/Users/:id               gateado feat:scim
 *
 * Por qué ServiceProviderConfig / ResourceTypes / Schemas no van gateados:
 *   Los IdPs los consultan ANTES de configurar el connector — RFC 7644 §4
 *   los define como discovery endpoints públicos. Si los gateáramos con 402,
 *   el admin del IdP no podría siquiera validar la URL del SCIM endpoint.
 *   En cambio, los endpoints CRUD sí van gateados con feat:scim.
 *
 * Auth:
 *   Todos los endpoints (incluidos los discovery) pasan por ScimAuthGuard.
 *   Esto contradice ligeramente la spec —algunos servidores hacen los
 *   discovery 100% anónimos— pero es la postura más segura: el IdP
 *   configura el Bearer token DESDE EL PRINCIPIO, así nada filtra config
 *   antes de tener el token. Okta y Azure AD lo aceptan sin problemas.
 *
 * Prefijo:
 *   El controller usa `@Controller('scim/v2')`. En `main.ts` excluimos `/scim`
 *   del prefijo global `/api/v1`, así que la URL pública queda
 *   `https://<host>/scim/v2/Users` (es lo que los IdPs esperan; si lleva
 *   `/api/v1/scim/v2/...` muchos connectors no aceptan).
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { LICENSE_CAPABILITIES, RequiresCapability } from '@didacta/license-sdk';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { ScimAuthGuard } from './scim-auth.guard';
import { ScimService, buildListResponse } from './scim.service';
import {
  scimCreateUserSchema,
  scimListQuerySchema,
  scimPatchSchema,
  type ScimCreateUserDto,
  type ScimListQueryDto,
  type ScimPatchDto,
} from './scim.dto';
import { SCIM_SCHEMAS, makeScimError, type ScimError } from './scim.types';

function requireScimTenant(req: FastifyRequest): string {
  const tenantId = req.scimTenantId;
  if (!tenantId) {
    // Defensivo: ScimAuthGuard ya lo habría rechazado. Pero tener este check
    // local protege contra mounts erróneos del controller sin guard.
    throw new UnauthorizedException(
      makeScimError(401, 'No tenant resolved from SCIM Bearer token.'),
    );
  }
  return tenantId;
}

@ApiTags('SCIM v2')
@Controller('scim/v2')
@UseGuards(ScimAuthGuard)
export class ScimController {
  constructor(private readonly scim: ScimService) {}

  // ---------------------------------------------------------------------------
  // Discovery endpoints (siempre accesibles tras ScimAuthGuard)
  // ---------------------------------------------------------------------------

  @Get('ServiceProviderConfig')
  @ApiOperation({
    summary:
      'Devuelve la configuración del servicio SCIM 2.0 (qué soporta este servidor). ' +
      'Endpoint público de discovery según RFC 7644 §4. NO requiere capability EE.',
  })
  @ApiResponse({ status: 200 })
  serviceProviderConfig() {
    return {
      schemas: [SCIM_SCHEMAS.SERVICE_PROVIDER_CONFIG],
      documentationUri: 'https://didacta.io/docs/scim',
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description: 'Static API token issued from /admin/scim panel. Per-tenant.',
          specUri: 'https://www.rfc-editor.org/info/rfc6750',
          documentationUri: 'https://didacta.io/docs/scim#auth',
          primary: true,
        },
      ],
      meta: {
        resourceType: 'ServiceProviderConfig',
        location: '/scim/v2/ServiceProviderConfig',
      },
    };
  }

  @Get('ResourceTypes')
  @ApiOperation({
    summary:
      'Lista los tipos de recurso soportados. En este piloto solo "User" — ' +
      'sin Groups. Endpoint público de discovery.',
  })
  @ApiResponse({ status: 200 })
  resourceTypes() {
    return {
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults: 1,
      Resources: [
        {
          schemas: [SCIM_SCHEMAS.RESOURCE_TYPE],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          description: 'User Account (Didacta)',
          schema: SCIM_SCHEMAS.USER,
          schemaExtensions: [],
          meta: {
            resourceType: 'ResourceType',
            location: '/scim/v2/ResourceTypes/User',
          },
        },
      ],
    };
  }

  @Get('Schemas')
  @ApiOperation({
    summary:
      'Devuelve los schemas SCIM soportados. Endpoint público de discovery — ' +
      'permite al IdP introspectar atributos.',
  })
  @ApiResponse({ status: 200 })
  schemas() {
    return {
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults: 1,
      Resources: [
        {
          id: SCIM_SCHEMAS.USER,
          name: 'User',
          description: 'User Account (subset core).',
          attributes: [
            { name: 'userName', type: 'string', required: true, mutability: 'readWrite' },
            { name: 'externalId', type: 'string', required: false, mutability: 'readWrite' },
            { name: 'displayName', type: 'string', required: false, mutability: 'readWrite' },
            { name: 'active', type: 'boolean', required: false, mutability: 'readWrite' },
            { name: 'locale', type: 'string', required: false, mutability: 'readWrite' },
            // emails y name se documentan como complejos pero los enumeramos
            // mínimamente para no inflar el payload.
            { name: 'emails', type: 'complex', multiValued: true, required: false },
            { name: 'name', type: 'complex', required: false },
          ],
          meta: {
            resourceType: 'Schema',
            location: `/scim/v2/Schemas/${SCIM_SCHEMAS.USER}`,
          },
        },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // CRUD Users — gateado feat:scim
  // ---------------------------------------------------------------------------

  @Get('Users')
  @RequiresCapability(LICENSE_CAPABILITIES.SCIM)
  @ApiOperation({
    summary:
      'Lista usuarios del tenant. Paginación SCIM (startIndex 1-based, count). ' +
      'Filtro mínimo `userName eq "valor"`. Requiere capability `feat:scim`.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 402, description: 'Capability `feat:scim` no licenciada.' })
  async listUsers(
    @Req() req: FastifyRequest,
    @Query(new ZodValidationPipe(scimListQuerySchema)) query: ScimListQueryDto,
  ) {
    const tenantId = requireScimTenant(req);
    const result = await this.scim.listUsers(tenantId, query);
    return buildListResponse(result);
  }

  @Get('Users/:id')
  @RequiresCapability(LICENSE_CAPABILITIES.SCIM)
  @ApiOperation({
    summary: 'Devuelve un usuario por id. Requiere capability `feat:scim`.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 402 })
  @ApiResponse({ status: 404 })
  async getUser(@Req() req: FastifyRequest, @Param('id') id: string) {
    const tenantId = requireScimTenant(req);
    return this.scim.getUser(tenantId, id);
  }

  @Post('Users')
  @HttpCode(HttpStatus.CREATED)
  @RequiresCapability(LICENSE_CAPABILITIES.SCIM)
  @ApiOperation({
    summary:
      'Crea un usuario. Idempotencia: si el userName ya existe → 409 con scimType=uniqueness.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 402 })
  @ApiResponse({ status: 409, description: 'userName ya existe.' })
  async createUser(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(scimCreateUserSchema)) dto: ScimCreateUserDto,
  ) {
    const tenantId = requireScimTenant(req);
    return this.scim.createUser(tenantId, dto, { actorId: null });
  }

  @Patch('Users/:id')
  @RequiresCapability(LICENSE_CAPABILITIES.SCIM)
  @ApiOperation({
    summary:
      'Aplica operaciones SCIM PatchOp. Soporta: replace active, name.givenName, ' +
      'name.familyName, locale, displayName y userName. Operaciones sin path con ' +
      'value=objeto también se aceptan (merge parcial).',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 400, description: 'PatchOp inválido.' })
  @ApiResponse({ status: 402 })
  @ApiResponse({ status: 404 })
  async patchUser(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(scimPatchSchema)) dto: ScimPatchDto,
  ) {
    const tenantId = requireScimTenant(req);
    return this.scim.patchUser(tenantId, id, dto, { actorId: null });
  }

  @Delete('Users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequiresCapability(LICENSE_CAPABILITIES.SCIM)
  @ApiOperation({
    summary:
      'Borra (soft delete) un usuario. Los IdPs típicamente NO lo usan — ' +
      'prefieren PATCH active=false. Disponible aquí para casos GDPR.',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 402 })
  @ApiResponse({ status: 404 })
  async deleteUser(@Req() req: FastifyRequest, @Param('id') id: string) {
    const tenantId = requireScimTenant(req);
    await this.scim.deleteUser(tenantId, id, { actorId: null });
    return null;
  }
}

// Helper que el filtro no captura — re-exportamos el shape del error para los
// tests que verifican el status string en SCIM error responses.
export type ScimErrorBody = ScimError;

// Captura para el linter: BadRequestException es importada implicitamente vía
// el service; aquí no la usamos más allá del re-throw. Mantenemos imports
// limpios.
void BadRequestException;
