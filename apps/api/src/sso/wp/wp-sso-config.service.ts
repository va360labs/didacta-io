/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { WpSsoTokenError } from '@didacta/mod-wp-sso';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { PrismaAuditLogService } from '../../modules/prisma-audit-log.service';
import { PrismaTenantConfigService } from '../../modules/prisma-tenant-config.service';
import { resolveWebBaseUrlForAuthRedirect } from '../../common/resolve-web-base-url';
import {
  WP_SSO_AUDIENCE_DEFAULT,
  WP_SSO_CONFIG_KEY,
  WP_SSO_CONFIG_MODULE_NAME,
  type SafeWpSsoConfigView,
  type TenantWpSsoConfig,
  type WpSsoPublicStatus,
} from './wp-sso-config.types';
import type { WpSsoConfigPutDto } from './wp-sso.dto';

/**
 * WpSsoConfigService — CRUD de la config WP-SSO por tenant (cifrada at-rest) +
 * resolución de la config en el callback público + status para el signin.
 *
 * La config vive en `tenant_setting` (módulo `wp-sso`, key `config`), guardada
 * como UN objeto cifrado (isSecret) porque incluye `sharedSecret`. NO hay env
 * WP_SSO_*: el admin lo gestiona desde el panel, igual que OIDC con su config.
 */
@Injectable()
export class WpSsoConfigService {
  private readonly logger = new Logger(WpSsoConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantConfig: PrismaTenantConfigService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  /** Lee la config completa (con secreto en claro) de un tenant. Null si no hay. */
  async getConfig(tenantId: string): Promise<TenantWpSsoConfig | null> {
    const record = await this.tenantConfig.get<TenantWpSsoConfig>(
      tenantId,
      WP_SSO_CONFIG_MODULE_NAME,
      WP_SSO_CONFIG_KEY,
    );
    if (!record) return null;
    if (typeof record.sharedSecret !== 'string') {
      this.logger.warn(`WP-SSO config corrupta para tenant ${tenantId} — ignorando.`);
      return null;
    }
    return record;
  }

  /** Vista para el panel admin (sin el secreto en claro). */
  async getSafeConfig(tenantId: string): Promise<SafeWpSsoConfigView | null> {
    const record = await this.getConfig(tenantId);
    if (!record) return null;
    return {
      enabled: record.enabled,
      hasSecret: typeof record.sharedSecret === 'string' && record.sharedSecret.length > 0,
      issuer: record.issuer ?? '',
      audience: record.audience ?? WP_SSO_AUDIENCE_DEFAULT,
      autoCreate: record.autoCreate,
      autoRedirect: record.autoRedirect,
      callbackUrl: await this.computeCallbackUrl(tenantId),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * URL de callback que el admin pega en `DIDACTA_SSO_CALLBACK` de wp-config.php.
   * Incluye el slug del tenant: `{web}/api/v1/modules/wp-sso/{slug}/callback`.
   */
  async computeCallbackUrl(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true },
    });
    const slug = tenant?.slug ?? '';
    // Base sólo desde WEB_PUBLIC_URL (infra), nunca de un header (no hay request aquí).
    const base = resolveWebBaseUrlForAuthRedirect();
    return `${base}/api/v1/modules/wp-sso/${encodeURIComponent(slug)}/callback`;
  }

  /**
   * Crea o actualiza la config. Si `sharedSecret` no viene (o vacío), preserva el
   * guardado; si viene, rota. El primer guardado exige secreto.
   */
  async setConfig(
    tenantId: string,
    dto: WpSsoConfigPutDto,
    actorId: string,
  ): Promise<SafeWpSsoConfigView> {
    const previous = await this.getConfig(tenantId);
    const incomingSecret =
      dto.sharedSecret && dto.sharedSecret.length > 0 ? dto.sharedSecret : null;
    const finalSecret = incomingSecret ?? previous?.sharedSecret;
    if (!finalSecret) {
      throw new BadRequestException(
        'El secreto compartido es obligatorio la primera vez. Pégalo (el mismo que en wp-config.php); no se mostrará después.',
      );
    }

    const now = new Date().toISOString();
    const record: TenantWpSsoConfig = {
      enabled: dto.enabled,
      sharedSecret: finalSecret,
      issuer: dto.issuer && dto.issuer.trim().length > 0 ? dto.issuer.trim() : undefined,
      audience: dto.audience && dto.audience.trim().length > 0 ? dto.audience.trim() : undefined,
      autoCreate: dto.autoCreate,
      autoRedirect: dto.autoRedirect,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };

    await this.tenantConfig.set<TenantWpSsoConfig>(
      tenantId,
      WP_SSO_CONFIG_MODULE_NAME,
      WP_SSO_CONFIG_KEY,
      record,
      { isSecret: true, actorId },
    );

    await this.auditLog.record({
      tenantId,
      actorId,
      action: previous ? 'sso.wp.config.updated' : 'sso.wp.config.created',
      resourceType: 'wp_sso_config',
      resourceId: tenantId,
      metadata: {
        enabled: record.enabled,
        issuer: record.issuer ?? null,
        rotatedSecret: incomingSecret !== null,
        autoCreate: record.autoCreate,
        autoRedirect: record.autoRedirect,
      },
    });

    const safe = await this.getSafeConfig(tenantId);
    if (!safe) throw new Error('Inconsistencia: getSafeConfig() null tras setConfig().');
    return safe;
  }

  async deleteConfig(tenantId: string, actorId: string): Promise<{ deleted: boolean }> {
    const previous = await this.getConfig(tenantId);
    if (!previous) return { deleted: false };
    await this.tenantConfig.delete(tenantId, WP_SSO_CONFIG_MODULE_NAME, WP_SSO_CONFIG_KEY, {
      actorId,
    });
    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'sso.wp.config.deleted',
      resourceType: 'wp_sso_config',
      resourceId: tenantId,
      metadata: {},
    });
    return { deleted: true };
  }

  /**
   * Estado público (sin auth) para el signin: si el tenant tiene WP-SSO activo,
   * si debe auto-rebotar y a qué WordPress. No expone secretos.
   */
  async getPublicStatus(tenantSlug: string): Promise<WpSsoPublicStatus> {
    const off: WpSsoPublicStatus = { configured: false, autoRedirect: false, wordpressUrl: null };
    if (!tenantSlug) return off;
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant || tenant.status !== 'ACTIVE') return off;
    // RLS F2: endpoint público — la config del tenant se lee bajo su ALS.
    const config = await runAsTenant(tenant.id, () => this.getConfig(tenant.id), {
      traceLabel: 'wp-sso-status',
    });
    if (!config || !config.enabled || !config.sharedSecret) return off;
    return {
      configured: true,
      autoRedirect: config.autoRedirect,
      wordpressUrl: config.issuer ?? null,
    };
  }

  /**
   * Resuelve tenant + config para el callback. Lanza WpSsoTokenError si el tenant
   * no existe o el SSO no está configurado/habilitado.
   */
  async resolveTenantConfig(
    tenantSlug: string,
  ): Promise<{ tenant: { id: string; slug: string }; config: TenantWpSsoConfig }> {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) {
      throw new WpSsoTokenError('not_configured', `El tenant "${tenantSlug}" no existe.`);
    }
    // RLS F2: idem getPublicStatus — lectura de config bajo el ALS del tenant.
    const config = await runAsTenant(tenant.id, () => this.getConfig(tenant.id), {
      traceLabel: 'wp-sso-config',
    });
    if (!config || !config.enabled || !config.sharedSecret) {
      throw new WpSsoTokenError(
        'not_configured',
        'WP-SSO no está configurado o habilitado para este tenant. Actívalo en el panel admin.',
      );
    }
    return { tenant: { id: tenant.id, slug: tenant.slug }, config };
  }
}
