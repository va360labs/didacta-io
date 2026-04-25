import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiKeyService } from './api-key.service';
import { CurrentUser } from './decorators';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ZodValidationPipe } from './zod-validation.pipe';
import type { SessionClaims } from './token.service';

const createSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string().min(1)).default([]),
  expiresAt: z.string().datetime().optional(),
});

@ApiTags('Auth · API Keys')
@ApiBearerAuth()
@Controller('auth/api-keys')
@UseGuards(JwtAuthGuard)
export class ApiKeyController {
  constructor(private readonly apiKeys: ApiKeyService) {}

  @Post()
  @ApiOperation({ summary: 'Crear API key. El token solo se devuelve una vez aquí.' })
  async create(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.apiKeys.create({
      tenantId: user.tenantId,
      userId: user.sub,
      name: body.name,
      scopes: body.scopes,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
  }

  @Get()
  @ApiOperation({ summary: 'Listar API keys del usuario actual (sin tokens en plano)' })
  async list(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.apiKeys.listForUser(user.tenantId, user.sub);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revocar API key (no la borra, marca revokedAt)' })
  async revoke(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    if (!user) throw new UnauthorizedException();
    await this.apiKeys.revoke(user.tenantId, user.sub, id);
  }
}
