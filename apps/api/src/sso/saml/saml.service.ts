/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * SamlService — orquestación del 9º piloto License SDK (`feat:sso.saml`).
 *
 * Responsabilidades:
 *   - CRUD de la config SAML del tenant.
 *   - testConnection(cert, url): valida formato del cert PEM y URL sintáctica.
 *   - startFlow(tenantSlug): genera RelayState + AuthnRequest, guarda flow,
 *     devuelve la authorization URL (HTTP-Redirect binding).
 *   - handleAcs(samlResponse, relayState): valida firma con cert IdP, parsea
 *     Assertion, valida InResponseTo y issuer, autoriza email, upsert user,
 *     emite tokens internos.
 *   - getSpMetadataXml(tenantSlug): genera SP metadata XML para IdPs que
 *     prefieren importar metadata en lugar de configurar URLs a mano.
 *
 * Decisiones técnicas (paralelo al patrón OIDC):
 *   - Usamos `@node-saml/node-saml@5` — equivalente robusto a `openid-client`
 *     para SAML. Hace TODA la verificación pesada (firma XML-DSig, schema
 *     SAML 2.0, validación timestamps NotBefore/NotOnOrAfter, AudienceRestriction).
 *     Implementarlo a mano es ~1-2 semanas con alta superficie de bugs CVE-grade.
 *   - State store IN-MEMORY (Map). Suficiente para piloto monoinstance. Se
 *     migra a Redis en sprint 5+ con `feat:multi_tenant.real`.
 *   - El service envuelve `@node-saml/node-saml` en métodos protegidos para
 *     que los tests stubeen sin levantar IdP real ni red.
 *
 * Seguridad:
 *   - Firma XML-DSig validada por la lib (rechaza Assertion sin firma o con
 *     firma con cert distinto al configurado).
 *   - InResponseTo del Response DEBE matchear el requestId que guardamos en el
 *     flow (defensa replay y CSRF cross-tenant).
 *   - Issuer del Response DEBE matchear idpEntityId configurado.
 *   - allowedEmailDomains opt-in: si está poblada, email fuera de la lista → rechazo.
 *   - RelayState random 32 bytes b64url (256 bits entropía).
 */

import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { PrismaAuditLogService } from '../../modules/prisma-audit-log.service';
import { PrismaTenantConfigService } from '../../modules/prisma-tenant-config.service';
import { TokenService, type SignedTokens } from '../../auth/token.service';
import {
  SAML_CONFIG_KEY,
  SAML_CONFIG_MODULE_NAME,
  type ParsedSamlAssertion,
  type SafeSamlConfigView,
  type SamlConnectionProbe,
  type SamlFlowState,
  type TenantSamlConfig,
} from './saml.types';
import type { SamlConfigPutDto } from './saml.dto';
import { SessionRegistryService } from '../../auth/session-registry.service';

export interface SamlAuthorizationParams {
  /** URL completa del IdP con SAMLRequest + RelayState en query string. */
  authorizationUrl: string;
  /** RelayState que el IdP devolverá tal cual al ACS. */
  relayState: string;
  /** ID del AuthnRequest emitido (audit). */
  requestId: string;
}

export interface SamlCallbackResult {
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
const RELAY_STATE_BYTES = 32;

function isValidEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * Forma mínima del SAML provider que dependemos. La envoltura permite tests
 * sin importar @node-saml/node-saml real.
 */
interface SamlProviderLike {
  getAuthorizeUrlAsync(
    relayState: string,
    host: string | undefined,
    options: Record<string, unknown>,
  ): Promise<string>;
  validatePostResponseAsync(container: { SAMLResponse: string }): Promise<{
    profile: {
      nameID: string;
      issuer: string;
      sessionIndex?: string;
      attributes?: Record<string, string | string[]>;
      [key: string]: unknown;
    } | null;
    loggedOut: boolean;
  }>;
  generateServiceProviderMetadata(
    decryptionCert: string | null,
    signingCerts: string[] | string | null,
  ): string;
}

@Injectable()
export class SamlService {
  private readonly logger = new Logger(SamlService.name);

  /**
   * State store de flows pendientes. Clave = relayState.
   *
   * TODO follow-up: migrar a Redis para multi-instance (Sprint 5+ con
   * `feat:multi_tenant.real`).
   */
  private readonly flowStore = new Map<string, SamlFlowState>();

  /** Base pública del API (donde está el ACS). Override por env para reverse proxy. */
  private readonly apiPublicBase: string;
  /** EntityID del SP (Didacta). Construido a partir de apiPublicBase. */
  private readonly spEntityIdBase: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantConfig: PrismaTenantConfigService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionRegistryService,
  ) {
    this.apiPublicBase = stripTrailingSlash(
      process.env['SAML_PUBLIC_API_URL'] ??
        process.env['PUBLIC_API_URL'] ??
        'http://localhost:4000',
    );
    this.spEntityIdBase = process.env['SAML_SP_ENTITY_ID_BASE'] ?? `${this.apiPublicBase}/saml`;
  }

  // ---------------------------------------------------------------------------
  // SP URLs por tenant
  // ---------------------------------------------------------------------------

  spEntityIdForTenant(tenantSlug: string): string {
    return `${stripTrailingSlash(this.spEntityIdBase)}/${tenantSlug}`;
  }

  spAcsUrlForTenant(tenantSlug: string): string {
    return `${this.apiPublicBase}/api/v1/auth/saml/${tenantSlug}/acs`;
  }

  spMetadataUrlForTenant(tenantSlug: string): string {
    return `${this.apiPublicBase}/api/v1/auth/saml/${tenantSlug}/metadata`;
  }

  // ---------------------------------------------------------------------------
  // Config CRUD
  // ---------------------------------------------------------------------------

  async getConfig(tenantId: string): Promise<TenantSamlConfig | null> {
    const record = await this.tenantConfig.get<TenantSamlConfig>(
      tenantId,
      SAML_CONFIG_MODULE_NAME,
      SAML_CONFIG_KEY,
    );
    if (!record) return null;
    if (
      typeof record.idpEntityId !== 'string' ||
      typeof record.idpSsoUrl !== 'string' ||
      typeof record.idpCertificate !== 'string' ||
      typeof record.attributeMapping?.email !== 'string'
    ) {
      this.logger.warn(`SAML config corrupta para tenant ${tenantId} — ignorando.`);
      return null;
    }
    return record;
  }

  async getSafeConfig(tenantId: string, tenantSlug: string): Promise<SafeSamlConfigView | null> {
    const record = await this.getConfig(tenantId);
    if (!record) return null;
    return {
      enabled: record.enabled,
      idpEntityId: record.idpEntityId,
      idpSsoUrl: record.idpSsoUrl,
      idpCertificate: record.idpCertificate,
      attributeMapping: record.attributeMapping,
      allowedEmailDomains: record.allowedEmailDomains,
      autoProvisionUsers: record.autoProvisionUsers,
      spEntityId: this.spEntityIdForTenant(tenantSlug),
      spAcsUrl: this.spAcsUrlForTenant(tenantSlug),
      spMetadataUrl: this.spMetadataUrlForTenant(tenantSlug),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async setConfig(
    tenantId: string,
    tenantSlug: string,
    dto: SamlConfigPutDto,
    actorId: string,
  ): Promise<SafeSamlConfigView> {
    const previous = await this.getConfig(tenantId);
    const now = new Date().toISOString();
    const record: TenantSamlConfig = {
      enabled: dto.enabled,
      idpEntityId: dto.idpEntityId,
      idpSsoUrl: dto.idpSsoUrl,
      idpCertificate: dto.idpCertificate,
      attributeMapping: dto.attributeMapping,
      allowedEmailDomains: dto.allowedEmailDomains.map((d) => d.toLowerCase()),
      autoProvisionUsers: dto.autoProvisionUsers,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };

    await this.tenantConfig.set<TenantSamlConfig>(
      tenantId,
      SAML_CONFIG_MODULE_NAME,
      SAML_CONFIG_KEY,
      record,
      { isSecret: false, actorId },
    );

    await this.auditLog.record({
      tenantId,
      actorId,
      action: previous ? 'sso.saml.config.updated' : 'sso.saml.config.created',
      resourceType: 'saml_config',
      resourceId: tenantId,
      metadata: {
        idpEntityId: record.idpEntityId,
        idpSsoUrl: record.idpSsoUrl,
        enabled: record.enabled,
      },
    });

    const safe = await this.getSafeConfig(tenantId, tenantSlug);
    if (!safe)
      throw new Error('Inconsistencia: getSafeConfig() después de setConfig() devolvió null.');
    return safe;
  }

  async deleteConfig(tenantId: string, actorId: string): Promise<{ deleted: boolean }> {
    const previous = await this.getConfig(tenantId);
    if (!previous) {
      return { deleted: false };
    }
    await this.tenantConfig.delete(tenantId, SAML_CONFIG_MODULE_NAME, SAML_CONFIG_KEY, {
      actorId,
    });

    await this.auditLog.record({
      tenantId,
      actorId,
      action: 'sso.saml.config.deleted',
      resourceType: 'saml_config',
      resourceId: tenantId,
      metadata: { idpEntityId: previous.idpEntityId },
    });

    return { deleted: true };
  }

  /**
   * Devuelve true si el tenant existe, está activo y tiene config SAML
   * habilitada. Lo usa el endpoint /auth/saml/:slug/status que consulta el
   * form de signin para decidir si pintar el botón "Iniciar sesión con SAML".
   */
  async isEnabledForTenantSlug(tenantSlug: string): Promise<boolean> {
    if (!tenantSlug || typeof tenantSlug !== 'string') return false;
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant || tenant.status !== 'ACTIVE') return false;
    // RLS F2: endpoint público — la config se lee bajo el ALS del tenant.
    const config = await runAsTenant(tenant.id, () => this.getConfig(tenant.id), {
      traceLabel: 'saml-status',
    });
    return Boolean(config && config.enabled);
  }

  // ---------------------------------------------------------------------------
  // Test connection (sólo valida formato, NO toca al IdP)
  // ---------------------------------------------------------------------------

  async testConnection(cert: string, url: string): Promise<SamlConnectionProbe> {
    try {
      const certInfo = this.inspectCertificate(cert);
      // URL ya viene validada sintácticamente por Zod; aquí solo confirmamos
      // que se puede instanciar el provider (la lib valida ssoUrl).
      this.buildProvider({
        idpEntityId: 'urn:test',
        idpSsoUrl: url,
        idpCertificate: cert,
        spEntityId: 'urn:test:sp',
        spAcsUrl: 'http://localhost/acs',
      });
      return {
        ok: true,
        ...(certInfo.subject ? { certSubject: certInfo.subject } : {}),
        ...(certInfo.notAfter ? { certNotAfter: certInfo.notAfter } : {}),
        ...(certInfo.signatureAlgorithm
          ? { certSignatureAlgorithm: certInfo.signatureAlgorithm }
          : {}),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  // ---------------------------------------------------------------------------
  // Flow start
  // ---------------------------------------------------------------------------

  async startFlow(tenantSlug: string): Promise<SamlAuthorizationParams> {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant || tenant.status !== 'ACTIVE') {
      throw new NotFoundException({
        message: 'Tenant no encontrado o inactivo.',
        code: 'SSO_TENANT_NOT_FOUND',
      });
    }

    // RLS F2: endpoint público — config + audit bajo el ALS del tenant.
    return runAsTenant(tenant.id, () => this.startFlowInTenant(tenant), {
      traceLabel: 'saml-start',
    });
  }

  private async startFlowInTenant(tenant: {
    id: string;
    slug: string;
  }): Promise<SamlAuthorizationParams> {
    const config = await this.getConfig(tenant.id);
    if (!config || !config.enabled) {
      throw new NotFoundException({
        message: 'Este tenant no tiene SSO SAML habilitado.',
        code: 'SSO_SAML_NOT_ENABLED',
      });
    }

    const relayState = b64url(randomBytes(RELAY_STATE_BYTES));
    const requestId = `_${b64url(randomBytes(20))}`;

    const provider = this.buildProvider({
      idpEntityId: config.idpEntityId,
      idpSsoUrl: config.idpSsoUrl,
      idpCertificate: config.idpCertificate,
      spEntityId: this.spEntityIdForTenant(tenant.slug),
      spAcsUrl: this.spAcsUrlForTenant(tenant.slug),
    });

    let authorizationUrl: string;
    try {
      authorizationUrl = await provider.getAuthorizeUrlAsync(relayState, undefined, {
        additionalParams: {},
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`SAML AuthnRequest build falló para ${config.idpEntityId}: ${msg}`);
      throw new ServiceUnavailableException({
        message: 'No pudimos generar la solicitud SAML. Verifica la configuración del IdP.',
        code: 'SSO_SAML_REQUEST_BUILD_FAILED',
      });
    }

    const flow: SamlFlowState = {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      idpEntityId: config.idpEntityId,
      requestId,
      expiresAt: Date.now() + FLOW_TTL_MS,
      startedAt: new Date().toISOString(),
    };

    this.cleanupExpiredFlows();
    this.flowStore.set(relayState, flow);

    await this.auditLog.record({
      tenantId: tenant.id,
      actorId: null,
      action: 'sso.saml.flow.started',
      resourceType: 'saml_flow',
      resourceId: relayState.slice(0, 12),
      metadata: { idpEntityId: config.idpEntityId },
    });

    return { authorizationUrl, relayState, requestId };
  }

  // ---------------------------------------------------------------------------
  // ACS (Assertion Consumer Service) callback
  // ---------------------------------------------------------------------------

  async handleAcs(params: {
    samlResponse?: string;
    relayState?: string;
  }): Promise<SamlCallbackResult> {
    if (!params.samlResponse || !params.relayState) {
      throw new BadRequestException({
        message: 'Faltan parámetros SAMLResponse / RelayState en el callback.',
        code: 'SSO_SAML_CALLBACK_PARAMS_MISSING',
      });
    }

    const flow = this.flowStore.get(params.relayState);
    if (!flow) {
      throw new UnauthorizedException({
        message: 'RelayState desconocido o expirado.',
        code: 'SSO_SAML_RELAY_STATE_UNKNOWN',
      });
    }
    // Defensa replay: el flow se consume una sola vez.
    this.flowStore.delete(params.relayState);

    if (Date.now() > flow.expiresAt) {
      throw new UnauthorizedException({
        message: 'RelayState expirado.',
        code: 'SSO_SAML_RELAY_STATE_EXPIRED',
      });
    }

    // RLS F2: endpoint público — el cierre del flow (config, upsert de user,
    // sesión, audit) corre bajo el ALS del tenant del flow.
    return runAsTenant(
      flow.tenantId,
      () =>
        this.completeAcs(flow, {
          samlResponse: params.samlResponse!,
          relayState: params.relayState!,
        }),
      { traceLabel: 'saml-acs' },
    );
  }

  private async completeAcs(
    flow: SamlFlowState,
    params: { samlResponse: string; relayState: string },
  ): Promise<SamlCallbackResult> {
    const config = await this.getConfig(flow.tenantId);
    if (!config || !config.enabled) {
      throw new UnauthorizedException({
        message: 'La config SAML del tenant fue deshabilitada durante el flow.',
        code: 'SSO_SAML_CONFIG_DISABLED_MID_FLOW',
      });
    }
    if (config.idpEntityId !== flow.idpEntityId) {
      throw new UnauthorizedException({
        message: 'La config SAML cambió durante el flow. Reintenta el login.',
        code: 'SSO_SAML_CONFIG_CHANGED_MID_FLOW',
      });
    }

    const provider = this.buildProvider({
      idpEntityId: config.idpEntityId,
      idpSsoUrl: config.idpSsoUrl,
      idpCertificate: config.idpCertificate,
      spEntityId: this.spEntityIdForTenant(flow.tenantSlug),
      spAcsUrl: this.spAcsUrlForTenant(flow.tenantSlug),
    });

    let parsed: ParsedSamlAssertion;
    try {
      parsed = await this.validateAndParse(provider, params.samlResponse);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`SAMLResponse rechazado para tenant ${flow.tenantId}: ${msg}`);
      throw new UnauthorizedException({
        message: `SAMLResponse inválido: ${msg}`,
        code: 'SSO_SAML_RESPONSE_INVALID',
        // El motivo real del rechazo (firma, condiciones, reloj) lo produce el
        // validador SAML, no nosotros: viaja aparte para que cada idioma lo
        // enmarque sin borrarlo.
        detail: msg,
      });
    }

    if (parsed.issuer !== config.idpEntityId) {
      throw new UnauthorizedException({
        message: 'Issuer del SAMLResponse no coincide con el IdP configurado.',
        code: 'SSO_SAML_ISSUER_MISMATCH',
      });
    }

    const email = this.resolveEmail(parsed, config.attributeMapping.email);
    if (!isValidEmail(email)) {
      throw new UnauthorizedException({
        message:
          'El IdP no devolvió un email válido en el Assertion. Verifica el attribute mapping.',
        code: 'SSO_SAML_EMAIL_MISSING',
      });
    }

    if (config.allowedEmailDomains.length > 0) {
      const domain = email.split('@')[1];
      if (!domain || !config.allowedEmailDomains.includes(domain)) {
        throw new UnauthorizedException({
          message: `El email "${email}" no pertenece a los dominios permitidos para SSO en este tenant.`,
          code: 'SSO_EMAIL_DOMAIN_NOT_ALLOWED',
          detail: email,
        });
      }
    }

    const displayName = this.composeDisplayName(parsed, config.attributeMapping);

    let user = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: flow.tenantId, email } },
      include: { roles: { include: { role: true } }, tenant: true },
    });

    if (!user) {
      if (!config.autoProvisionUsers) {
        await this.auditLog.record({
          tenantId: flow.tenantId,
          actorId: null,
          action: 'sso.saml.callback.rejected',
          resourceType: 'saml_flow',
          resourceId: params.relayState.slice(0, 12),
          metadata: { reason: 'user_not_provisioned', email },
        });
        throw new UnauthorizedException({
          message:
            'No tienes cuenta en este tenant. Pídele al admin que active el auto-provisioning o que te dé de alta primero.',
          code: 'SSO_USER_NOT_PROVISIONED',
        });
      }

      user = await this.prisma.user.create({
        data: {
          tenantId: flow.tenantId,
          email,
          name: displayName,
          status: 'ACTIVE',
          passwordHash: null,
        },
        include: { roles: { include: { role: true } }, tenant: true },
      });

      await this.auditLog.record({
        tenantId: flow.tenantId,
        actorId: user.id,
        action: 'sso.saml.user.provisioned',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { email, nameId: parsed.nameId, displayName },
      });
    } else {
      if (user.status !== 'ACTIVE') {
        throw new UnauthorizedException({
          message: 'Tu cuenta no está activa. Contacta al admin del tenant.',
          code: 'SSO_ACCOUNT_INACTIVE',
        });
      }
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
      // SAML implica autenticación + (típicamente) MFA en el IdP, igual que OIDC.
      // Saltamos enforcement local para no doble-MFA al usuario.
      mfaVerified: true,
    });

    await this.auditLog.record({
      tenantId: flow.tenantId,
      actorId: user.id,
      action: 'sso.saml.signin.success',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { email, nameId: parsed.nameId, autoProvisioned: !user.passwordHash },
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
  // SP metadata XML
  // ---------------------------------------------------------------------------

  async getSpMetadataXml(tenantSlug: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant || tenant.status !== 'ACTIVE') {
      throw new NotFoundException({
        message: 'Tenant no encontrado o inactivo.',
        code: 'SSO_TENANT_NOT_FOUND',
      });
    }
    // RLS F2: endpoint público — la config se lee bajo el ALS del tenant.
    const config = await runAsTenant(tenant.id, () => this.getConfig(tenant.id), {
      traceLabel: 'saml-metadata',
    });
    if (!config) {
      throw new NotFoundException({
        message: 'Este tenant no tiene config SAML.',
        code: 'SSO_SAML_CONFIG_MISSING',
      });
    }
    const provider = this.buildProvider({
      idpEntityId: config.idpEntityId,
      idpSsoUrl: config.idpSsoUrl,
      idpCertificate: config.idpCertificate,
      spEntityId: this.spEntityIdForTenant(tenant.slug),
      spAcsUrl: this.spAcsUrlForTenant(tenant.slug),
    });
    return provider.generateServiceProviderMetadata(null, null);
  }

  // ---------------------------------------------------------------------------
  // Helpers privados (envueltos para testabilidad)
  // ---------------------------------------------------------------------------

  /**
   * Construye el provider SAML. Wrapper alrededor de
   * `new SAML(...)` de @node-saml/node-saml. Tests stubean este método.
   */
  protected buildProvider(opts: {
    idpEntityId: string;
    idpSsoUrl: string;
    idpCertificate: string;
    spEntityId: string;
    spAcsUrl: string;
  }): SamlProviderLike {
    // Lazy require para no imponer la dep a tests que no quieren red ni XML.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require('@node-saml/node-saml') as {
      SAML: new (config: Record<string, unknown>) => SamlProviderLike;
    };
    return new lib.SAML({
      entryPoint: opts.idpSsoUrl,
      issuer: opts.spEntityId,
      callbackUrl: opts.spAcsUrl,
      idpIssuer: opts.idpEntityId,
      idpCert: opts.idpCertificate,
      // wantAssertionsSigned: false porque algunos IdPs sólo firman el Response.
      // La lib igualmente exige al menos UNA firma válida (Response o Assertion).
      wantAssertionsSigned: false,
      wantAuthnResponseSigned: true,
      // Sin SP signing en este piloto.
      privateKey: undefined,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      acceptedClockSkewMs: 5000,
      disableRequestedAuthnContext: true,
    });
  }

  /**
   * Wrapper sobre `provider.validatePostResponseAsync({ SAMLResponse })`.
   * Devuelve el ParsedSamlAssertion ya con attributes planos.
   *
   * En tests stub-eamos este método con vi.spyOn(...).
   */
  protected async validateAndParse(
    provider: SamlProviderLike,
    samlResponseB64: string,
  ): Promise<ParsedSamlAssertion> {
    const result = await provider.validatePostResponseAsync({
      SAMLResponse: samlResponseB64,
    });
    if (result.loggedOut || !result.profile) {
      throw new Error('SAMLResponse vacío o de logout.');
    }
    const profile = result.profile;
    return {
      nameId: profile.nameID,
      issuer: profile.issuer,
      attributes: profile.attributes ?? {},
      responseId: typeof profile['responseId'] === 'string' ? profile['responseId'] : '',
      ...(typeof profile['inResponseTo'] === 'string'
        ? { inResponseTo: profile['inResponseTo'] }
        : {}),
    };
  }

  /**
   * Inspecciona un cert PEM con node:crypto X509Certificate. Usado por
   * testConnection() para devolver feedback útil al admin sin tocar al IdP.
   */
  protected inspectCertificate(pem: string): {
    subject?: string;
    notAfter?: string;
    signatureAlgorithm?: string;
  } {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { X509Certificate } = require('node:crypto') as {
      X509Certificate: new (input: string) => {
        subject: string;
        validTo: string;
        publicKey: { asymmetricKeySize?: number };
      };
    };
    try {
      const cert = new X509Certificate(pem);
      return {
        subject: cert.subject,
        notAfter: new Date(cert.validTo).toISOString(),
        signatureAlgorithm: 'X.509',
      };
    } catch {
      throw new Error('El certificado no es PEM válido o está corrupto.');
    }
  }

  private resolveEmail(parsed: ParsedSamlAssertion, mappingKey: string): string {
    const fromAttr = parsed.attributes[mappingKey];
    const value = Array.isArray(fromAttr) ? fromAttr[0] : fromAttr;
    if (value && typeof value === 'string') return value.trim().toLowerCase();
    // Fallback: si nameID parece email, usarlo.
    if (parsed.nameId && parsed.nameId.includes('@')) {
      return parsed.nameId.trim().toLowerCase();
    }
    return '';
  }

  private composeDisplayName(
    parsed: ParsedSamlAssertion,
    mapping: { firstName?: string; lastName?: string },
  ): string | null {
    const pick = (key: string | undefined): string | null => {
      if (!key) return null;
      const v = parsed.attributes[key];
      const value = Array.isArray(v) ? v[0] : v;
      return value && typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    };
    const first = pick(mapping.firstName);
    const last = pick(mapping.lastName);
    if (first && last) return `${first} ${last}`;
    return first ?? last;
  }

  private cleanupExpiredFlows(): void {
    const now = Date.now();
    for (const [state, flow] of this.flowStore) {
      if (flow.expiresAt <= now) {
        this.flowStore.delete(state);
      }
    }
  }

  /** Para tests: inserta un flow ya construido. */
  __insertFlowForTest(relayState: string, flow: SamlFlowState): void {
    this.flowStore.set(relayState, flow);
  }

  /** Para tests: limpia state. */
  __resetForTest(): void {
    this.flowStore.clear();
  }

  /** Para tests: número de flows activos. */
  get __activeFlowsForTest(): number {
    return this.flowStore.size;
  }
}
