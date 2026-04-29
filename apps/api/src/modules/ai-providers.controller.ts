import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiKeyCipher } from '../ai/api-key-cipher';
import { ProviderRegistry } from '../ai/provider-registry';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { PrismaService } from '../prisma/prisma.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const purposeSchema = z.enum(['chat', 'embed']);
const providerIdSchema = z.enum([
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'mistral',
  'groq',
  'ollama',
  'voyage',
]);

const upsertConfigSchema = z.object({
  provider: providerIdSchema,
  model: z.string().trim().max(200).optional(),
  apiKey: z.string().min(1).max(1000),
  baseUrl: z.string().url().optional(),
  extraHeaders: z.record(z.string()).optional(),
  enabled: z.boolean().optional(),
  notas: z.string().max(2000).optional(),
});
type UpsertConfigDto = z.infer<typeof upsertConfigSchema>;

/**
 * Endpoints admin para gestionar la configuración multi-provider IA del
 * tenant (LMS-90.E).
 *
 *   GET    /admin/ai/providers/catalog          → lista providers built-in
 *   GET    /admin/ai/providers                  → configs actuales del tenant
 *   PUT    /admin/ai/providers/:purpose         → upsert config para chat o embed
 *   DELETE /admin/ai/providers/:purpose         → borra config (cae a default global)
 *
 * La API key se cifra con AES-256-GCM antes de persistir y NUNCA se
 * devuelve en plaintext. El GET muestra solo metadatos (provider, model,
 * enabled, etc.) — para verificar la key, el admin la re-introduce.
 */
@ApiTags('Admin · AI · Providers')
@ApiBearerAuth()
@Controller('admin/ai/providers')
@UseGuards(JwtAuthGuard)
export class AiProvidersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: ApiKeyCipher,
    private readonly registry: ProviderRegistry,
  ) {}

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new UnauthorizedException(
        'Solo super_admin y tenant_admin pueden gestionar providers IA.',
      );
    }
    return user;
  }

  @Get('catalog')
  @ApiOperation({ summary: 'Lista providers IA disponibles con sus capabilities.' })
  async catalog(@CurrentUser() user: SessionClaims | undefined) {
    this.requireAdmin(user);
    return this.registry.list();
  }

  @Get()
  @ApiOperation({ summary: 'Configs actuales del tenant (sin API keys).' })
  async list(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    const rows = await this.prisma.tenantAiProviderConfig.findMany({
      where: { tenantId: u.tenantId },
      orderBy: { purpose: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      purpose: r.purpose,
      provider: r.provider,
      model: r.model,
      baseUrl: r.baseUrl,
      enabled: r.enabled,
      notas: r.notas,
      hasApiKey: true, // Si la fila existe, hay key cifrada
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  @Put(':purpose')
  @ApiOperation({
    summary:
      'Crea o reemplaza la config IA para chat o embed en este tenant. La API key se cifra antes de persistir.',
  })
  async upsert(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('purpose') purpose: string,
    @Body(new ZodValidationPipe(upsertConfigSchema)) dto: UpsertConfigDto,
  ) {
    const u = this.requireAdmin(user);
    const purposeParsed = purposeSchema.parse(purpose);

    // Validar capability del provider para el purpose pedido
    const adapter = this.registry.get(dto.provider);
    if (!adapter) {
      throw new UnauthorizedException(`Provider ${dto.provider} no registrado.`);
    }
    if (!adapter.capabilities.includes(purposeParsed)) {
      throw new UnauthorizedException(
        `Provider ${dto.provider} no soporta ${purposeParsed}. Capabilities: ${adapter.capabilities.join(', ')}.`,
      );
    }

    if (!this.cipher.isReady()) {
      throw new UnauthorizedException(
        'AI_CONFIG_ENCRYPTION_KEY no está configurada en el cluster. Pide al super_admin que la configure antes de gestionar providers per-tenant.',
      );
    }
    const enc = this.cipher.encrypt(dto.apiKey);

    const existing = await this.prisma.tenantAiProviderConfig.findFirst({
      where: { tenantId: u.tenantId, purpose: purposeParsed },
      select: { id: true },
    });
    if (existing) {
      const updated = await this.prisma.tenantAiProviderConfig.update({
        where: { id: existing.id },
        data: {
          provider: dto.provider,
          model: dto.model ?? '',
          apiKeyCipher: enc.cipher,
          apiKeyIv: enc.iv,
          apiKeyTag: enc.tag,
          baseUrl: dto.baseUrl ?? null,
          extraHeaders: (dto.extraHeaders ?? {}) as never,
          enabled: dto.enabled ?? true,
          notas: dto.notas ?? null,
        },
      });
      return this.toView(updated);
    }
    const created = await this.prisma.tenantAiProviderConfig.create({
      data: {
        tenantId: u.tenantId,
        purpose: purposeParsed,
        provider: dto.provider,
        model: dto.model ?? '',
        apiKeyCipher: enc.cipher,
        apiKeyIv: enc.iv,
        apiKeyTag: enc.tag,
        baseUrl: dto.baseUrl ?? null,
        extraHeaders: (dto.extraHeaders ?? {}) as never,
        enabled: dto.enabled ?? true,
        notas: dto.notas ?? null,
      },
    });
    return this.toView(created);
  }

  @Delete(':purpose')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Elimina la config del tenant para ese purpose. El gateway caerá al default global del cluster si está configurado.',
  })
  async remove(@CurrentUser() user: SessionClaims | undefined, @Param('purpose') purpose: string) {
    const u = this.requireAdmin(user);
    const purposeParsed = purposeSchema.parse(purpose);
    await this.prisma.tenantAiProviderConfig.deleteMany({
      where: { tenantId: u.tenantId, purpose: purposeParsed },
    });
    return { deleted: true };
  }

  private toView(row: {
    id: string;
    purpose: string;
    provider: string;
    model: string;
    baseUrl: string | null;
    enabled: boolean;
    notas: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      purpose: row.purpose,
      provider: row.provider,
      model: row.model,
      baseUrl: row.baseUrl,
      enabled: row.enabled,
      notas: row.notas,
      hasApiKey: true,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
