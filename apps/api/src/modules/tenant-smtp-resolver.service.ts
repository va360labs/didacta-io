/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger } from '@nestjs/common';
import type { TenantConfigService } from '@didacta/core-kernel';
import { SmtpAdapterService, type SmtpConfig, type SmtpSendConfig } from './smtp-adapter.service';
import {
  SENDER_SETTING_KEY,
  SENDER_SETTING_MODULE,
  displayNameFromAddress,
  sanitizeReplyTo,
  sanitizeSenderName,
  type SmtpSenderIdentity,
  type TenantSenderSetting,
} from './smtp-sender-identity';

/**
 * Origen efectivo de la config SMTP devuelta por el resolver. Útil para
 * logging y observabilidad sin filtrar credenciales: nos dice si el envío
 * va a salir con la config del tenant (verificada o no) o con el fallback
 * global del despliegue.
 */
export type SmtpSource = 'tenant' | 'tenant_unverified' | 'global' | 'none';

export interface ResolvedSmtp {
  /** Lista para `SmtpAdapterService.send`: incluye nombre visible y Reply-To. */
  config: SmtpSendConfig;
  source: SmtpSource;
  /** Si la config viene del tenant, ¿fue probada al menos una vez con éxito? */
  verified: boolean;
}

/**
 * Lo que el resolver necesita saber del aula para el Reply-To por defecto.
 * Interfaz estrecha (no PrismaService) para que los tests no monten Prisma.
 */
export interface TenantSenderDirectory {
  /** Correo del administrador principal del aula (el primer tenant_admin activo), o null. */
  primaryAdminEmail(tenantId: string): Promise<string | null>;
}

/**
 * Resolutor centralizado de credenciales SMTP por tenant.
 *
 * Estrategia (alpha.75):
 * 1. Si el tenant tiene config SMTP propia válida en `tenant_setting`
 *    (scope=`notifications`, key=`smtp`) → usar esa.
 * 2. Si no, si hay env globales (`SMTP_HOST` + `SMTP_PORT` + `SMTP_FROM`)
 *    → usar fallback global del despliegue. Esto cubre el caso
 *    "instalación on-prem con un solo MTA compartido".
 * 3. Si nada de lo anterior aplica → devuelve `null`. El caller debe
 *    decidir si log+skip o marcar el envío como fallido.
 *
 * NO loguea credenciales nunca. Sólo `source` y `verified` para que el
 * caller pueda correlacionar fallos con la fuente real.
 *
 * Convención de variables de entorno (compat con env.example):
 * - `SMTP_HOST`, `SMTP_PORT` (number), `SMTP_USER` (opt), `SMTP_PASS`
 *   o `SMTP_PASSWORD` (opt), `SMTP_FROM` (email o "Nombre <email>"),
 *   `SMTP_ENCRYPTION` (`tls`/`starttls`/`none`, opcional),
 *   `SMTP_SECURE` (`true`/`false`, legado — autodetect por puerto).
 */
@Injectable()
export class TenantSmtpResolverService {
  private readonly logger = new Logger(TenantSmtpResolverService.name);

  constructor(
    private readonly tenantConfig: TenantConfigService,
    private readonly smtp: SmtpAdapterService,
    /** Opcional: sin él no hay Reply-To de respaldo al administrador del aula. */
    private readonly directory?: TenantSenderDirectory,
  ) {}

  /**
   * Resuelve la config SMTP que debe usar `tenantId`. Aplica la cascada
   * tenant → global → none descrita arriba.
   *
   * Errores de descifrado del tenant_setting (clave rotada, etc.) se
   * tratan como "tenant sin config" y caen al global — esto evita que
   * un problema operativo de claves rompa el envío de notifications a
   * todos los tenants. El admin del tenant puede recuperarse re-tipeando.
   */
  async resolve(tenantId: string): Promise<ResolvedSmtp | null> {
    const tenantResolved = await this.readTenantConfig(tenantId);
    if (tenantResolved) {
      return tenantResolved;
    }
    const globalConfig = this.readGlobalConfig();
    if (globalConfig) {
      return {
        config: { ...globalConfig, sender: await this.globalSender(tenantId) },
        source: 'global',
        verified: false,
      };
    }
    return null;
  }

  /**
   * Identidad con el SMTP COMPARTIDO: la dirección es la de la plataforma, el
   * nombre lo pone el emisor (la academia) y las respuestas van al «correo
   * para respuestas» del aula o, si no lo puso, a su administrador principal.
   * Si el nombre de la academia faltara, se firma con el de `SMTP_FROM`.
   */
  private async globalSender(tenantId: string): Promise<SmtpSenderIdentity> {
    const fallbackName = displayNameFromAddress(process.env['SMTP_FROM']) ?? undefined;
    const replyTo = await this.sharedReplyTo(tenantId);
    return {
      ...(fallbackName ? { fallbackName } : {}),
      ...(replyTo ? { replyTo } : {}),
    };
  }

  /**
   * Reply-To con el SMTP compartido: el «correo para respuestas» del aula o, si
   * no lo puso, su administrador principal. Público para que el panel enseñe
   * exactamente lo mismo que saldrá en la cabecera.
   */
  async sharedReplyTo(tenantId: string): Promise<string | null> {
    return (await this.configuredReplyTo(tenantId)) ?? (await this.primaryAdminReplyTo(tenantId));
  }

  /** «Correo para respuestas» del aula. Un fallo de lectura no bloquea el envío. */
  private async configuredReplyTo(tenantId: string): Promise<string | null> {
    try {
      const raw = (await this.tenantConfig.get(
        tenantId,
        SENDER_SETTING_MODULE,
        SENDER_SETTING_KEY,
      )) as Partial<TenantSenderSetting> | undefined;
      return sanitizeReplyTo(raw?.replyToEmail);
    } catch {
      return null;
    }
  }

  private async primaryAdminReplyTo(tenantId: string): Promise<string | null> {
    if (!this.directory) return null;
    try {
      return sanitizeReplyTo(await this.directory.primaryAdminEmail(tenantId));
    } catch (err) {
      this.logger.warn(
        `[smtp-resolver] no se pudo leer el administrador del tenant ${tenantId} para el Reply-To: ${(err as Error).message.slice(0, 200)}`,
      );
      return null;
    }
  }

  /**
   * Variante para uso operativo: igual que `resolve` pero NO cae al global
   * si el tenant no tiene config. Usar para el endpoint de "probar SMTP"
   * desde el panel — ahí queremos validar la config del tenant explícita,
   * no la global del despliegue.
   */
  async resolveTenantOnly(tenantId: string): Promise<ResolvedSmtp | null> {
    return this.readTenantConfig(tenantId);
  }

  /** True si el tenant tiene configurado SMTP propio (verificado o no). */
  async hasTenantConfig(tenantId: string): Promise<boolean> {
    const tenant = await this.readTenantConfig(tenantId);
    return tenant !== null;
  }

  /** True si el despliegue tiene SMTP compartido (env globales válidas) para todas las aulas. */
  hasGlobalConfig(): boolean {
    return this.readGlobalConfig() !== null;
  }

  private async readTenantConfig(tenantId: string): Promise<ResolvedSmtp | null> {
    let raw: unknown;
    try {
      raw = await this.tenantConfig.get(tenantId, 'notifications', 'smtp');
    } catch (err) {
      this.logger.warn(
        `[smtp-resolver] no se pudo leer SMTP del tenant ${tenantId}: ${(err as Error).message.slice(0, 200)}. ` +
          'Cae al fallback global si está disponible.',
      );
      return null;
    }
    if (!raw) return null;

    const parsed = this.smtp.parseConfig(raw);
    let meta: { verifiedAt?: string | null; fromName?: string | null } | undefined;
    try {
      meta = (await this.tenantConfig.get(tenantId, 'notifications', 'smtp_meta')) as
        | { verifiedAt?: string | null; fromName?: string | null }
        | undefined;
    } catch {
      meta = undefined;
    }
    const verified = Boolean(meta?.verifiedAt);
    // SMTP propio (modo avanzado): se respeta el «nombre del remitente» que
    // configuró; el Reply-To solo si lo puso a mano (su dirección ya es suya).
    const fixedName = sanitizeSenderName(meta?.fromName) ?? undefined;
    const replyTo = await this.configuredReplyTo(tenantId);
    return {
      config: {
        ...parsed,
        sender: { ...(fixedName ? { fixedName } : {}), ...(replyTo ? { replyTo } : {}) },
      },
      source: verified ? 'tenant' : 'tenant_unverified',
      verified,
    };
  }

  /**
   * Lee la config SMTP global del proceso. Acepta tanto `SMTP_PASS` como
   * `SMTP_PASSWORD` (compat: env.example tradicionalmente usa `SMTP_PASS`;
   * docker-compose.alpha usa `SMTP_PASSWORD`). `from` puede venir como
   * "Nombre <email>" — extraemos el email para validar el schema y dejamos
   * el formato original al transporter.
   */
  private readGlobalConfig(): SmtpConfig | null {
    const host = process.env['SMTP_HOST']?.trim();
    const portStr = process.env['SMTP_PORT']?.trim();
    const fromRaw = process.env['SMTP_FROM']?.trim();
    if (!host || !portStr || !fromRaw) return null;

    const port = Number(portStr);
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null;

    const user = process.env['SMTP_USER']?.trim() || '';
    const password = process.env['SMTP_PASS']?.trim() || process.env['SMTP_PASSWORD']?.trim() || '';
    const secureRaw = process.env['SMTP_SECURE']?.trim().toLowerCase();
    const secure = secureRaw === 'true' ? true : secureRaw === 'false' ? false : undefined;
    const encryptionRaw = process.env['SMTP_ENCRYPTION']?.trim().toLowerCase();
    const encryption =
      encryptionRaw === 'tls' || encryptionRaw === 'starttls' || encryptionRaw === 'none'
        ? encryptionRaw
        : undefined;

    // El schema exige host + port + from email. user/password son opcionales
    // en MTAs locales (mailpit, postfix sin auth). Si user está vacío, el
    // schema no lo acepta — para esos casos colocamos un placeholder válido
    // y dejamos al transporter conectar anónimo (nodemailer no exige auth).
    const from = this.extractEmail(fromRaw);
    if (!from) return null;

    const candidate = {
      host,
      port,
      user: user || 'anonymous',
      password: password || 'anonymous',
      from,
      ...(encryption !== undefined ? { encryption } : secure !== undefined ? { secure } : {}),
    };
    if (!this.smtp.isConfigValid(candidate)) return null;
    return this.smtp.parseConfig(candidate);
  }

  /** Extrae el email de "Nombre <email@x>" o devuelve el string tal cual si ya es email. */
  private extractEmail(raw: string): string | null {
    const m = raw.match(/<([^>]+)>/);
    if (m && m[1]) return m[1].trim();
    return /@/.test(raw) ? raw : null;
  }
}
