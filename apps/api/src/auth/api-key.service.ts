import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreatedApiKey {
  id: string;
  name: string;
  /** Token en plano. Se devuelve UNA SOLA VEZ al crearla. */
  token: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
}

export interface ApiKeyDescriptor {
  id: string;
  name: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  preview: string;
}

/** Descriptor de API key para el panel admin: incluye quién la creó. */
export interface TenantApiKeyDescriptor extends ApiKeyDescriptor {
  createdByEmail: string | null;
  createdByName: string | null;
}

const TOKEN_PREFIX = 'lmsk_';

/**
 * API keys con prefijo `lmsk_` + 32 bytes random base64url.
 * En la BD se guarda solo el SHA-256 del token. El plano se devuelve una vez al crearla.
 */
@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  generateToken(): { plain: string; hash: string; preview: string } {
    const random = randomBytes(32).toString('base64url');
    const plain = `${TOKEN_PREFIX}${random}`;
    const hash = this.hashToken(plain);
    const preview = `${plain.slice(0, 12)}…${plain.slice(-4)}`;
    return { plain, hash, preview };
  }

  hashToken(plain: string): string {
    return createHash('sha256').update(plain).digest('hex');
  }

  async create(params: {
    tenantId: string;
    userId: string;
    name: string;
    scopes: string[];
    expiresAt?: Date | null;
  }): Promise<CreatedApiKey> {
    const { plain, hash } = this.generateToken();
    const created = await this.prisma.apiKey.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        name: params.name,
        scopes: params.scopes,
        tokenHash: hash,
        expiresAt: params.expiresAt ?? null,
      },
    });
    return {
      id: created.id,
      name: created.name,
      token: plain,
      scopes: created.scopes,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
    };
  }

  async listForUser(tenantId: string, userId: string): Promise<ApiKeyDescriptor[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: { tenantId, userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      scopes: r.scopes,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      preview: `${TOKEN_PREFIX}…${r.id.slice(0, 4)}`,
    }));
  }

  async revoke(tenantId: string, userId: string, id: string): Promise<void> {
    await this.prisma.apiKey.updateMany({
      where: { id, tenantId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Lista TODAS las API keys del tenant (de cualquier usuario), para el panel
   * de administración. Incluye el email/nombre del creador para que el admin
   * identifique de quién es cada clave. No expone tokens en plano.
   */
  async listForTenant(tenantId: string): Promise<TenantApiKeyDescriptor[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true, name: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      scopes: r.scopes,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      preview: `${TOKEN_PREFIX}…${r.id.slice(0, 4)}`,
      createdByEmail: r.user?.email ?? null,
      createdByName: r.user?.name ?? null,
    }));
  }

  /**
   * Revoca cualquier API key del tenant (variante admin: no exige que la clave
   * pertenezca al usuario que la revoca, solo al mismo tenant).
   */
  async revokeForTenant(tenantId: string, id: string): Promise<void> {
    await this.prisma.apiKey.updateMany({
      where: { id, tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Resuelve tenant/usuario/scopes de un token de API key SIN efectos
   * secundarios (no toca `lastUsedAt`). Lo usa `TenantMiddleware` para poblar
   * el contexto de tenant (RLS) en requests autenticados por API key, antes de
   * que `JwtOrApiKeyGuard` haga la validación completa con `findValidByToken()`
   * (que sí actualiza `lastUsedAt`). Así el `lastUsedAt` se actualiza una sola
   * vez por request.
   */
  async resolveContext(token: string): Promise<{
    id: string;
    tenantId: string;
    userId: string;
    scopes: string[];
  } | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const hash = this.hashToken(token);
    const row = await this.prisma.apiKey.findUnique({ where: { tokenHash: hash } });
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      scopes: row.scopes,
    };
  }

  async findValidByToken(token: string): Promise<{
    id: string;
    tenantId: string;
    userId: string;
    scopes: string[];
  } | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const hash = this.hashToken(token);
    const row = await this.prisma.apiKey.findUnique({ where: { tokenHash: hash } });
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

    await this.prisma.apiKey.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    });

    return {
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      scopes: row.scopes,
    };
  }
}
