/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * OidcService — orquestación del 8º piloto License SDK (`feat:sso.oidc`).
 *
 * Responsabilidades:
 *   - CRUD de la config OIDC del tenant (cifrando clientSecret at-rest).
 *   - testDiscovery(issuer): probe del .well-known/openid-configuration.
 *   - startFlow(tenantSlug): genera state+nonce+codeVerifier (PKCE S256),
 *     guarda el flow state in-memory, devuelve la authorization URL del IdP.
 *   - handleCallback(state, params): verifica state, intercambia code por
 *     tokens, valida id_token (iss/aud/exp/nonce), upsert user, emite
 *     tokens internos.
 *
 * Decisiones técnicas:
 *   - Usamos `openid-client@5` (panva): battle-tested, hace TODA la verificación
 *     pesada (firma JWS, JWKS rotation, claim validation, PKCE check).
 *     Implementarlo "a mano" es ~2-3 días con alta superficie de bugs de
 *     seguridad — irresponsable para un piloto.
 *   - State store IN-MEMORY (Map). Suficiente para piloto monoinstance. En
 *     producción real con horizontal scaling debe migrar a Redis. Lo dejo
 *     como TODO documentado y aislado en `flowStore` (un swap del Map por
 *     un wrapper Redis no toca el resto del code).
 *   - El service NO depende de openid-client en su typing público — wrappemos
 *     en métodos privados `discoverIssuer` y `exchangeCode` para que los
 *     tests puedan stub-earlos sin levantar un servidor OIDC fake.
 *
 * Seguridad:
 *   - clientSecret cifrado (AES-256-GCM via PrismaTenantConfigService isSecret).
 *   - Validación de id_token: aud === clientId, iss === issuer (strip trailing
 *     slash en ambos lados), nonce coincide con el guardado, exp > now (esto
 *     último lo hace openid-client de fábrica).
 *   - State token random (32 bytes b64url ≈ 256 bits entropía).
 *   - PKCE S256 obligatorio (nunca permitimos `plain`).
 *   - allowedEmailDomains opt-in: si la lista está poblada y el email del
 *     id_token NO matchea ninguno → rechazo claro al usuario.
 */

import { randomBytes, createHash } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { PrismaAuditLogService } from '../../modules/prisma-audit-log.service';
import { PrismaTenantConfigService } from '../../modules/prisma-tenant-config.service';
import { TokenService, type SignedTokens } from '../../auth/token.service';
import {
  OIDC_CONFIG_KEY,
  OIDC_CONFIG_MODULE_NAME,
  type OidcDiscoveryProbe,
  type OidcFlowState,
  type SafeOidcConfigView,
  type TenantOidcConfig,
} from './oidc.types';
import type { OidcConfigPutDto } from './oidc.dto';
import { SessionRegistryService } from '../../auth/session-registry.service';

/**
 * Forma mínima del Issuer / Client del que dependemos. La envoltura permite
 * tests sin importar openid-client real.
 */
export interface OidcAuthorizationParams {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcCallbackTokenSet {
  /** Claims validados del id_token tras intercambio. */
  idTokenClaims: {
    sub: string;
    iss: string;
    aud: string | string[];
    exp: number;
    nonce?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    given_name?: string;
    family_name?: string;
    preferred_username?: string;
  };
  /** Access token opaco emitido por el IdP. NO lo usamos más allá de logging. */
  accessToken?: string;
}

export interface CallbackResult {
  tokens: SignedTokens;
  user: {
    id: string;
    email: string;
    name: string | null;
    tenantId: string;
    tenantSlug: string;
    roles: string[];
  };
}

const FLOW_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000;
const STATE_BYTES = 32;
const NONCE_BYTES = 32;
const CODE_VERIFIER_BYTES = 64;

/** Email mínimo requerido para crear / matchear users. */
function isValidEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);

  /** Cache del Issuer descubierto: clave = issuer URL normalizado. */
  private readonly discoveryCache = new Map<
    string,
    { client: unknown; issuer: unknown; expiresAt: number }
  >();

  /**
   * State store de flows pendientes. Clave = state token (string b64url).
   *
   * TODO follow-up: migrar a Redis para multi-instance (Sprint 5+ con
   * `feat:multi_tenant.real` real).
   */
  private readonly flowStore = new Map<string, OidcFlowState>();

  /**
   * Redirect URI configurada en este servidor. Se usa para construir la
   * authorization URL del IdP y para validar el callback. Override por env
   * para entornos donde el host público no coincide con el del request
   * (reverse proxy delante).
   */
  private readonly redirectUri: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantConfig: PrismaTenantConfigService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionRegistryService,
  ) {
    this.redirectUri =
      stripTrailingSlash(
        process.env['OIDC_REDIRECT_URI'] ??
          process.env['PUBLIC_API_URL'] ??
          'http://localhost:4000',
      ) + '/api/v1/auth/oidc/callback';
  }

  // ---------------------------------------------------------------------------
  // Config CRUD
  // ---------------------------------------------------------------------------

  /**
   * Lee la config del tenant. Devuelve null si no hay nada guardado o el
   * registro está corrupto. El clientSecret viene en plaintext (la capa de
   * cifrado vive en `PrismaTenantConfigService.get`).
   */
  async getConfig(tenantId: string): Promise<TenantOidcConfig | null> {
    const record = await this.tenantConfig.get<TenantOidcConfig>(
      tenantId,
      OIDC_CONFIG_MODULE_NAME,
      OIDC_CONFIG_KEY,
    );
    if (!record) return null;
    if (
      typeof record.issuer !== 'string' ||
      typeof record.clientId !== 'string' ||
      typeof record.clientSecret !== 'string'
    ) {
      this.logger.warn(`OIDC config corrupta para tenant ${tenantId} — ignorando.`);
      return null;
    }
    return record;
  }

  /**
   * Devuelve la vista pública para el panel admin (sin clientSecret).
   */
  async getSafeConfig(tenantId: string): Promise<SafeOidcConfigView | null> {
    const record = await this.getConfig(tenantId);
    if (!record) return null;
    return {
      enabled: record.enabled,
      issuer: record.issuer,
      clientId: record.clientId,
      hasSecret: typeof record.clientSecret === 'string' && record.clientSecret.length > 0,
      allowedEmailDomains: record.allowedEmailDomains,
      autoProvisionUsers: record.autoProvisionUsers,
      scopes: record.scopes,
      redirectUri: this.redirectUri,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Guarda la config. Si `clientSecret` no viene en el DTO, preserva el ya
   * guardado. Si viene → rota.
   *
   * Devuelve la SafeOidcConfigView resultante.
   */
  async setConfig(
    tenantId: string,
    dto: OidcConfigPutDto,
    actorId: string,
  ): Promise<SafeOidcConfigView> {
    const previous = await this.getConfig(tenantId);

    const incomingSecret = dto.clientSecret ?? null;
    const finalSecret =
      incomingSecret !== null && incomingSecret.length > 0
        ? incomingSecret
        : previous?.clientSecret;

    if (!finalSecret) {
      throw new BadRequestException({
        message:
          'clientSecret es obligatorio en la primera configuración del IdP. Pegalo del panel del IdP (no se mostrará después).',
        code: 'SSO_OIDC_CLIENT_SECRET_REQUIRED',
      });
    }

    const now = new Date().toISOString();
    const issuer = stripTrailingSlash(dto.issuer);
    const record: TenantOidcConfig = {
      enabled: dto.enabled,
      issuer,
      clientId: dto.clientId,
      clientSecret: finalSecret,
      allowedEmailDomains: dto.allowedEmailDomains.map((d) => d.toLowerCase()),
      autoProvisionUsers: dto.autoProvisionUsers,
      scopes: dto.scopes,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };

    await this.tenantConfig.set<TenantOidcConfig>(
      tenantId,
      OIDC_CONFIG_MODULE_NAME,
      OIDC_CONFIG_KEY,
      record,
      { isSecret: true, actorId },
    );

    // Invalidamos cache de discovery por si el admin cambió issuer.
    this.discoveryCache.delete(issuer);

    await this.auditLog.record({
      tenantId,
      actorId,
      action: previous ? 'sso.oidc.config.updated' : 'sso.oidc.config.created',
      resourceType: 'oidc_config',
      resourceId: tenantId,
      metadata: {
        issuer: record.issuer,
        clientId: record.clientId,
        rotatedSecret: incomingSecret !== null,
        enabled: record.enabled,
      },
    });

    const safe = await this.getSafeConfig(tenantId);
    if (!safe)
      throw new Error('Inconsistencia: getSafeConfig() después de setConfig() devolvió null.');
    return safe;
  }

  async deleteConfig(tenantId: string, actorId: string): Promise<{ deleted: boolean }> {
    const previous = await this.getConfig(tenantId);
    if (!previous) {
      return { deleted: false };
    }
    await this.tenantConfig.delete(tenantId, OIDC_CONFIG_MODULE_NAME, OIDC_CONFIG_KEY, {
      actorId,
    });
    this.discoveryCache.delete(previous.issuer);

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'sso.oidc.config.deleted',
      resourceType: 'oidc_config',
      resourceId: tenantId,
      metadata: { issuer: previous.issuer, clientId: previous.clientId },
    });

    return { deleted: true };
  }

  /**
   * Devuelve true si el tenant existe, está activo y tiene config OIDC con
   * `enabled=true`. NO toca cache de discovery ni hace llamadas externas — sólo
   * lee tenant + config.
   *
   * Diseñado para el endpoint público `/auth/oidc/:slug/status` que consume el
   * form de signin: barato, no leakea info sensible, indica si pintar el botón.
   */
  async isEnabledForTenantSlug(tenantSlug: string): Promise<boolean> {
    if (!tenantSlug || typeof tenantSlug !== 'string') return false;
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant || tenant.status !== 'ACTIVE') return false;
    // RLS F2: endpoint público — la config se lee bajo el ALS del tenant.
    const config = await runAsTenant(tenant.id, () => this.getConfig(tenant.id), {
      traceLabel: 'oidc-status',
    });
    return Boolean(config && config.enabled);
  }

  // ---------------------------------------------------------------------------
  // Discovery probe (sin guardar nada)
  // ---------------------------------------------------------------------------

  async testDiscovery(issuer: string): Promise<OidcDiscoveryProbe> {
    const normalized = stripTrailingSlash(issuer);
    try {
      const { issuer: issuerObj } = await this.discoverIssuer(normalized);
      const meta = (issuerObj as { metadata: Record<string, unknown> }).metadata;
      const authorizationEndpoint = String(meta['authorization_endpoint'] ?? '');
      const tokenEndpoint = String(meta['token_endpoint'] ?? '');
      const jwksUri = String(meta['jwks_uri'] ?? '');
      const issuerEcho = String(meta['issuer'] ?? normalized);
      if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) {
        return { ok: false, error: 'discovery devolvió endpoints incompletos' };
      }
      return {
        ok: true,
        authorizationEndpoint,
        tokenEndpoint,
        jwksUri,
        issuer: issuerEcho,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Discovery probe falló para ${normalized}: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  // ---------------------------------------------------------------------------
  // Flow start
  // ---------------------------------------------------------------------------

  /**
   * Inicia el flow OIDC: resuelve el tenant por slug, lee la config, descubre
   * el IdP, genera state+nonce+codeVerifier, guarda el flow y devuelve la URL
   * de autorización para redirigir al usuario.
   *
   * Throws:
   *   - NotFoundException si tenant no existe, no tiene config o config.enabled=false.
   *   - ServiceUnavailableException si el discovery del IdP falla.
   */
  async startFlow(tenantSlug: string): Promise<OidcAuthorizationParams> {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant || tenant.status !== 'ACTIVE') {
      throw new NotFoundException({
        message: 'Tenant no encontrado o inactivo.',
        code: 'SSO_TENANT_NOT_FOUND',
      });
    }

    // RLS F2: endpoint público — config + audit bajo el ALS del tenant.
    return runAsTenant(tenant.id, () => this.startFlowInTenant(tenant), {
      traceLabel: 'oidc-start',
    });
  }

  private async startFlowInTenant(tenant: {
    id: string;
    slug: string;
  }): Promise<OidcAuthorizationParams> {
    const config = await this.getConfig(tenant.id);
    if (!config || !config.enabled) {
      throw new NotFoundException({
        message: 'Este tenant no tiene SSO OIDC habilitado.',
        code: 'SSO_OIDC_NOT_ENABLED',
      });
    }

    const { client } = await this.discoverIssuerOrThrow(config);

    const state = b64url(randomBytes(STATE_BYTES));
    const nonce = b64url(randomBytes(NONCE_BYTES));
    const codeVerifier = b64url(randomBytes(CODE_VERIFIER_BYTES));
    const codeChallenge = pkceChallenge(codeVerifier);

    const authorizationUrl = this.buildAuthorizationUrl(client, {
      scope: config.scopes.join(' '),
      state,
      nonce,
      codeChallenge,
    });

    const flow: OidcFlowState = {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      nonce,
      codeVerifier,
      issuer: config.issuer,
      clientId: config.clientId,
      expiresAt: Date.now() + FLOW_TTL_MS,
      startedAt: new Date().toISOString(),
    };

    this.cleanupExpiredFlows();
    this.flowStore.set(state, flow);

    await this.auditLog.record({
      tenantId: tenant.id,
      actorId: null,
      action: 'sso.oidc.flow.started',
      resourceType: 'oidc_flow',
      resourceId: state.slice(0, 12),
      metadata: { issuer: config.issuer, scopes: config.scopes },
    });

    return { authorizationUrl, state, nonce, codeVerifier };
  }

  // ---------------------------------------------------------------------------
  // Callback
  // ---------------------------------------------------------------------------

  /**
   * Cierra el flow OIDC. Verifica state, intercambia code por tokens (delegado
   * a openid-client), valida id_token, autoriza el email, upsert user y emite
   * tokens internos.
   *
   * Throws:
   *   - UnauthorizedException si state desconocido / expirado / nonce no
   *     coincide / aud o iss no coinciden / email no permitido.
   *   - ServiceUnavailableException si el IdP no responde.
   */
  async handleCallback(params: {
    state?: string;
    code?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<CallbackResult> {
    if (params.error) {
      throw new UnauthorizedException({
        message: `IdP devolvió error: ${params.error}${params.errorDescription ? ` — ${params.errorDescription}` : ''}`,
        code: 'SSO_OIDC_IDP_ERROR',
      });
    }
    if (!params.state || !params.code) {
      throw new BadRequestException({
        message: 'Faltan parámetros state/code en el callback.',
        code: 'SSO_OIDC_CALLBACK_PARAMS_MISSING',
      });
    }

    const flow = this.flowStore.get(params.state);
    if (!flow) {
      throw new UnauthorizedException({
        message: 'State desconocido o expirado.',
        code: 'SSO_OIDC_STATE_UNKNOWN',
      });
    }
    // El flow se consume una sola vez (defensa replay).
    this.flowStore.delete(params.state);

    if (Date.now() > flow.expiresAt) {
      throw new UnauthorizedException({
        message: 'State expirado.',
        code: 'SSO_OIDC_STATE_EXPIRED',
      });
    }

    // RLS F2: endpoint público — el cierre del flow (config, upsert de user,
    // sesión, audit) corre bajo el ALS del tenant del flow.
    return runAsTenant(
      flow.tenantId,
      () => this.completeCallback(flow, { state: params.state!, code: params.code! }),
      { traceLabel: 'oidc-callback' },
    );
  }

  private async completeCallback(
    flow: OidcFlowState,
    params: { state: string; code: string },
  ): Promise<CallbackResult> {
    const config = await this.getConfig(flow.tenantId);
    if (!config || !config.enabled) {
      throw new UnauthorizedException({
        message: 'La config OIDC del tenant fue deshabilitada durante el flow.',
        code: 'SSO_OIDC_CONFIG_DISABLED_MID_FLOW',
      });
    }
    if (config.issuer !== flow.issuer || config.clientId !== flow.clientId) {
      throw new UnauthorizedException({
        message: 'La config OIDC cambió durante el flow. Reintenta el login.',
        code: 'SSO_OIDC_CONFIG_CHANGED_MID_FLOW',
      });
    }

    const { client } = await this.discoverIssuerOrThrow(config);

    const tokenSet = await this.exchangeCode(client, {
      code: params.code,
      state: params.state,
      nonce: flow.nonce,
      codeVerifier: flow.codeVerifier,
    });

    // Defensa-en-profundidad: openid-client ya valida estas, pero si algún
    // adapter futuro las saltea, las re-validamos.
    const claims = tokenSet.idTokenClaims;
    const expectedIss = stripTrailingSlash(config.issuer);
    if (stripTrailingSlash(claims.iss) !== expectedIss) {
      throw new UnauthorizedException({
        message: 'iss del id_token no coincide con el issuer configurado.',
        code: 'SSO_OIDC_ISS_MISMATCH',
      });
    }
    const audOk = Array.isArray(claims.aud)
      ? claims.aud.includes(config.clientId)
      : claims.aud === config.clientId;
    if (!audOk) {
      throw new UnauthorizedException({
        message: 'aud del id_token no coincide con clientId.',
        code: 'SSO_OIDC_AUD_MISMATCH',
      });
    }
    if (claims.nonce !== flow.nonce) {
      throw new UnauthorizedException({
        message: 'nonce del id_token no coincide.',
        code: 'SSO_OIDC_NONCE_MISMATCH',
      });
    }

    const email = (claims.email ?? claims.preferred_username ?? '').toString().trim().toLowerCase();
    if (!isValidEmail(email)) {
      throw new UnauthorizedException({
        message:
          'El IdP no devolvió un email válido en el id_token. Asegúrate de incluir el scope "email" y configurarlo en el IdP.',
        code: 'SSO_OIDC_EMAIL_MISSING',
      });
    }

    if (config.allowedEmailDomains.length > 0) {
      const domain = email.split('@')[1];
      if (!domain || !config.allowedEmailDomains.includes(domain)) {
        throw new UnauthorizedException({
          message: `El email "${email}" no pertenece a los dominios permitidos para SSO en este tenant.`,
          code: 'SSO_EMAIL_DOMAIN_NOT_ALLOWED',
        });
      }
    }

    const displayName = this.composeDisplayName(claims);

    let user = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: flow.tenantId, email } },
      include: { roles: { include: { role: true } }, tenant: true },
    });

    if (!user) {
      if (!config.autoProvisionUsers) {
        await this.auditLog.record({
          tenantId: flow.tenantId,
          actorId: null,
          action: 'sso.oidc.callback.rejected',
          resourceType: 'oidc_flow',
          resourceId: params.state.slice(0, 12),
          metadata: { reason: 'user_not_provisioned', email },
        });
        throw new UnauthorizedException({
          message: `No tienes cuenta en este tenant. Pídele al admin que active el auto-provisioning o que te dé de alta primero.`,
          code: 'SSO_USER_NOT_PROVISIONED',
        });
      }

      user = await this.prisma.user.create({
        data: {
          tenantId: flow.tenantId,
          email,
          name: displayName,
          status: 'ACTIVE',
          // No password — sólo SSO. Si más tarde el admin asigna password, OK.
          passwordHash: null,
        },
        include: { roles: { include: { role: true } }, tenant: true },
      });

      await this.auditLog.record({
        tenantId: flow.tenantId,
        actorId: user.id,
        action: 'sso.oidc.user.provisioned',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { email, sub: claims.sub, displayName },
      });
    } else {
      if (user.status !== 'ACTIVE') {
        throw new UnauthorizedException({
          message: 'Tu cuenta no está activa. Contacta al admin del tenant.',
          code: 'SSO_ACCOUNT_INACTIVE',
        });
      }
      // Refrescamos lastLogin + name si vino en el id_token.
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          lastLoginAt: new Date(),
          ...(displayName && displayName !== user.name ? { name: displayName } : {}),
        },
      });
    }

    const roles = user.roles.map((r: { role: { name: string } }) => r.role.name);
    const tokens = await this.sessions.issue({
      sub: user.id,
      tenantId: flow.tenantId,
      roles,
      // OIDC ya implica fuerte autenticación + (típicamente) MFA en el IdP. No
      // exigimos verify MFA local adicional. Tenants que quieran enforcement
      // local activan `feat:mfa.enforcement` (3er piloto) — el AuthService
      // sigue chequeando esa policy en signins password; SSO la salta por
      // diseño. Documentado en docs/licensing/enterprise.md.
      mfaVerified: true,
    });

    await this.auditLog.record({
      tenantId: flow.tenantId,
      actorId: user.id,
      action: 'sso.oidc.signin.success',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { email, sub: claims.sub, autoProvisioned: !user.passwordHash },
    });

    return {
      tokens,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tenantId: flow.tenantId,
        tenantSlug: flow.tenantSlug,
        roles,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers privados (envueltos para testabilidad)
  // ---------------------------------------------------------------------------

  /**
   * Wrapper alrededor de openid-client `Issuer.discover()` + `new
   * issuer.Client(...)`. Cachea por issuer URL durante 1h. Retornamos el
   * objeto Issuer + Client construidos.
   *
   * En tests stub-eamos este método con vi.spyOn(...).
   */
  protected async discoverIssuer(
    issuer: string,
    config?: TenantOidcConfig,
  ): Promise<{ issuer: unknown; client: unknown }> {
    const normalized = stripTrailingSlash(issuer);
    const cacheKey = config ? `${normalized}::${config.clientId}` : normalized;
    const now = Date.now();
    const cached = this.discoveryCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return { issuer: cached.issuer, client: cached.client };
    }

    // Lazy require para no romper tests que no quieren red real ni dependencia
    // del módulo openid-client en el classpath.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const oidc = require('openid-client') as {
      Issuer: { discover(url: string): Promise<unknown> };
    };
    const issuerObj = await oidc.Issuer.discover(normalized);

    let client: unknown = null;
    if (config) {
      // El Client lo construimos sólo si necesitamos hacer flow real (start/callback).
      // testDiscovery() llega sin config y sólo le interesa el metadata.
      const ClientCtor = (issuerObj as { Client: new (params: unknown) => unknown }).Client;
      client = new ClientCtor({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uris: [this.redirectUri],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      });
    }

    this.discoveryCache.set(cacheKey, {
      issuer: issuerObj,
      client,
      expiresAt: now + DISCOVERY_CACHE_TTL_MS,
    });
    return { issuer: issuerObj, client };
  }

  private async discoverIssuerOrThrow(
    config: TenantOidcConfig,
  ): Promise<{ issuer: unknown; client: unknown }> {
    try {
      const result = await this.discoverIssuer(config.issuer, config);
      if (!result.client) {
        throw new Error('Discovery devolvió Client null para flow real.');
      }
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Discovery falló para ${config.issuer}: ${msg}`);
      throw new ServiceUnavailableException({
        message:
          'No pudimos contactar al proveedor de identidad. Verifica que el issuer esté online y reintenta.',
        code: 'SSO_OIDC_IDP_UNREACHABLE',
      });
    }
  }

  /**
   * Wrapper sobre `client.authorizationUrl(...)` para testabilidad.
   */
  protected buildAuthorizationUrl(
    client: unknown,
    params: { scope: string; state: string; nonce: string; codeChallenge: string },
  ): string {
    const c = client as {
      authorizationUrl(opts: Record<string, unknown>): string;
    };
    return c.authorizationUrl({
      scope: params.scope,
      state: params.state,
      nonce: params.nonce,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  /**
   * Wrapper sobre `client.callback(...)`. Devuelve el TokenSet con los claims
   * ya verificados por la lib (firma JWS, exp, nonce, c_hash si aplica).
   */
  protected async exchangeCode(
    client: unknown,
    params: { code: string; state: string; nonce: string; codeVerifier: string },
  ): Promise<OidcCallbackTokenSet> {
    const c = client as {
      callback(
        redirectUri: string,
        params: { code: string; state: string },
        checks: { state: string; nonce: string; code_verifier: string },
      ): Promise<{
        claims(): OidcCallbackTokenSet['idTokenClaims'];
        access_token?: string;
      }>;
    };
    const tokenSet = await c.callback(
      this.redirectUri,
      { code: params.code, state: params.state },
      { state: params.state, nonce: params.nonce, code_verifier: params.codeVerifier },
    );
    return {
      idTokenClaims: tokenSet.claims(),
      ...(tokenSet.access_token ? { accessToken: tokenSet.access_token } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Internas
  // ---------------------------------------------------------------------------

  private composeDisplayName(claims: OidcCallbackTokenSet['idTokenClaims']): string | null {
    if (claims.name && claims.name.trim().length > 0) return claims.name.trim();
    const given = claims.given_name?.trim();
    const family = claims.family_name?.trim();
    if (given && family) return `${given} ${family}`;
    if (given) return given;
    if (family) return family;
    return null;
  }

  private cleanupExpiredFlows(): void {
    const now = Date.now();
    for (const [state, flow] of this.flowStore) {
      if (flow.expiresAt <= now) {
        this.flowStore.delete(state);
      }
    }
  }

  /** Para tests: inserta un flow ya construido y devuelve el state token. */
  __insertFlowForTest(state: string, flow: OidcFlowState): void {
    this.flowStore.set(state, flow);
  }

  /** Para tests: limpia caches. */
  __resetCachesForTest(): void {
    this.discoveryCache.clear();
    this.flowStore.clear();
  }

  /** Para tests: número de flows activos. */
  get __activeFlowsForTest(): number {
    return this.flowStore.size;
  }

  /** Para tests: redirect URI computada. */
  get __redirectUriForTest(): string {
    return this.redirectUri;
  }
}
