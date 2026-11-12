/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Post,
  Put,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { ModuleContextFactory } from '../modules/module-context.factory';
import { PrismaService } from '../prisma/prisma.service';
import { SmtpEncryptionSchema, type SmtpEncryption } from '../modules/smtp-adapter.service';
import { TenantSmtpResolverService } from '../modules/tenant-smtp-resolver.service';
import {
  SENDER_SETTING_KEY,
  SENDER_SETTING_MODULE,
  sanitizeReplyTo,
  type TenantSenderSetting,
} from '../modules/smtp-sender-identity';
import {
  resolveEmailBranding,
  renderBrandedEmail,
  textToHtmlParagraphs,
  type BrandingPrisma,
} from '../common/branded-email';
import {
  HUB_DEFAULT_LOCALE,
  interpolate,
  resolveFixedEmailCopy,
  resolveHubDefault,
  resolveRecipientLocale,
  toHubTemplateLang,
} from '../modules/notifications/email-template-catalog';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

/**
 * Relleno del `message` cuando el MTA rechaza el envío SIN devolver texto.
 * En ese caso NO se manda `detail`: el front detecta su ausencia y pinta el
 * `message` crudo en vez de una frase traducida con el hueco vacío. Es el
 * único camino en que un admin anglófono ve español aquí, y es deliberado:
 * no hay diagnóstico que traducir.
 */
const SMTP_NO_DETAIL = 'sin detalle';

/** Key del catálogo del hub que corresponde al email de prueba de SMTP. */
const SMTP_TEST_TEMPLATE_KEY = 'admin.smtp.test';

/**
 * Body del PUT /admin/tenant-settings/smtp. `password` opcional: si no se
 * envía o viene vacío, se conserva el password actual del tenant.
 *
 * `encryption` es el modo de cifrado explícito (tls / starttls / none). El
 * boolean `secure` se sigue aceptando por compatibilidad con clientes viejos,
 * pero si viajan los dos gana `encryption` y `secure` se descarta. Si no viene
 * ninguno, el adapter infiere por puerto (465 → TLS implícito, resto → claro
 * con STARTTLS oportunista).
 *
 * `fromName` opcional — se concatena con `fromEmail` como "Name <email>" si
 * está presente. El schema interno del SmtpAdapter sólo guarda el email,
 * así que el name viaja en un campo `fromName` paralelo en el setting.
 */
const SmtpUpsertSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  encryption: SmtpEncryptionSchema.optional(),
  secure: z.boolean().optional(),
  username: z.string().min(1).max(255),
  password: z.string().max(2048).optional(),
  fromEmail: z.string().email().max(255),
  fromName: z.string().max(255).optional(),
});

/**
 * «Correo para respuestas» del aula. Vacío o null = quitarlo (las respuestas
 * vuelven a ir al administrador principal). Además de `email()`, pasa por
 * `sanitizeReplyTo`: una sola dirección, sin nada que parta la cabecera.
 */
export const SenderUpsertSchema = z.object({
  replyToEmail: z
    .union([z.literal(''), z.string().trim().max(254).email(), z.null()])
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || sanitizeReplyTo(v) === v, { message: 'Dirección no válida' }),
});

interface SenderResponseDto {
  /** Lo que el admin escribió, o null. */
  replyToEmail: string | null;
  /**
   * Adónde van de verdad las respuestas hoy (lo que saldrá en `Reply-To`), o
   * null si no llevan ninguno. Con el SMTP compartido y sin correo propio es el
   * del administrador principal; con SMTP propio, su dirección de envío.
   */
  effectiveReplyTo: string | null;
  /** True si los correos salen por el SMTP propio del aula (modo avanzado). */
  usesOwnSmtp: boolean;
}

const SmtpTestSchema = z.object({
  toEmail: z.string().email(),
});

/**
 * Envío de prueba de una plantilla CONCRETA del catálogo. Distinto del test de
 * SMTP: aquel manda un texto fijo para validar credenciales; este manda el
 * email real que recibiría un miembro, con el override del tenant si lo hay.
 *
 * Sirve para ver cómo queda un correo antes de que salga a cientos de personas,
 * y para reproducir uno ya enviado pasándole las mismas variables.
 */
const TemplateTestSchema = z.object({
  toEmail: z.string().email(),
  templateKey: z.string().trim().min(1).max(120),
  /** Variables de la plantilla. Las que falten se quedan vacías. */
  variables: z.record(z.string()).optional(),
  /**
   * Idioma a previsualizar (ej. `en-US`). Si se omite, el de referencia del
   * producto. Se resuelve con la MISMA precedencia que usa el hub al enviar,
   * para que la vista previa no mienta sobre lo que recibirá el miembro.
   */
  locale: z.string().trim().min(2).max(35).optional(),
});

interface SmtpResponseDto {
  host: string | null;
  port: number | null;
  /**
   * Modo de cifrado efectivo. Para configs legadas sin el campo se deriva del
   * boolean `secure` (o del puerto), para que el form pueda preseleccionar.
   */
  encryption: SmtpEncryption | null;
  secure: boolean | null;
  username: string | null;
  hasPassword: boolean;
  fromEmail: string | null;
  fromName: string | null;
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  /** True si el tenant tiene config propia; false si solo hereda el fallback global. */
  hasTenantConfig: boolean;
  /** True si el despliegue tiene env globales que sirven de fallback. */
  hasGlobalFallback: boolean;
}

function requireAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  const isAdmin = user.roles.some((r) => ADMIN_ROLES.has(r));
  if (!isAdmin) {
    throw new ForbiddenException({
      message: 'Solo super_admin o tenant_admin pueden gestionar SMTP',
      code: 'ADMIN_SMTP_FORBIDDEN',
    });
  }
  return user;
}

/**
 * Endpoints admin para gestionar SMTP per-tenant. Wrappea el almacenamiento
 * genérico de `tenant_setting` con un contrato dedicado: el frontend trabaja
 * con un DTO plano (host/port/username/...) en lugar de tener que entender
 * el modelo `{moduleName, key, value, isSecret}`.
 *
 * Almacenamiento:
 * - Credenciales: `tenant_setting` scope=`notifications`, key=`smtp`, isSecret=true.
 *   Cifrado AES-256-GCM por `SecretCipherService`.
 * - Metadata de verificación: `tenant_setting` scope=`notifications`,
 *   key=`smtp_meta`, isSecret=false. Sólo guarda `{verifiedAt, verifiedByUserId}`.
 *
 * Por qué dos rows: separa secreto (rotable) de metadata (auditable sin
 * descifrar). Si en el futuro se rota la clave de cifrado, la metadata
 * sigue legible.
 */
@ApiTags('Admin SMTP')
@ApiBearerAuth()
@Controller('admin/tenant-settings/smtp')
@UseGuards(JwtAuthGuard)
export class AdminSmtpController {
  private readonly logger = new Logger(AdminSmtpController.name);

  constructor(
    private readonly modules: ModuleContextFactory,
    private readonly prisma: PrismaService,
    private readonly resolver: TenantSmtpResolverService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Devuelve la config SMTP del tenant (sin password). `hasPassword` indica si hay secret guardado.',
  })
  async getCurrent(@CurrentUser() user: SessionClaims | undefined): Promise<SmtpResponseDto> {
    const claims = requireAdmin(user);
    const dto = await this.readDto(claims.tenantId);
    return dto;
  }

  @Put()
  @ApiOperation({
    summary:
      'Crea o actualiza la config SMTP del tenant. Reset `verifiedAt`. Si `password` viene vacío, conserva el actual.',
  })
  async upsert(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(SmtpUpsertSchema))
    body: z.infer<typeof SmtpUpsertSchema>,
  ): Promise<SmtpResponseDto> {
    const claims = requireAdmin(user);
    const config = this.modules.getTenantConfig();

    // Para conservar password cuando el form lo deja vacío, leemos el
    // previo, hacemos merge, y guardamos. Si descifrar falla (clave rotada)
    // y el body no trae password, exigimos uno nuevo — sin él no podríamos
    // reconstruir credenciales válidas.
    let existingPassword: string | undefined;
    try {
      const previous = (await config.get(claims.tenantId, 'notifications', 'smtp')) as
        | { password?: string }
        | undefined;
      existingPassword = previous?.password;
    } catch (err) {
      this.logger.warn(
        `[admin-smtp] no se pudo descifrar SMTP previo del tenant ${claims.tenantId}: ` +
          `${(err as Error).message.slice(0, 200)}. Si el body no trae password se rechaza el update.`,
      );
    }

    const finalPassword =
      body.password && body.password.length > 0 ? body.password : existingPassword;
    if (!finalPassword) {
      throw new BadRequestException({
        message:
          'Falta password: no hay password previo guardado o no se pudo descifrar. Envía uno nuevo en el body.',
        code: 'ADMIN_SMTP_PASSWORD_REQUIRED',
      });
    }

    // Si viaja `encryption` no persistimos el `secure` legado: dos fuentes de
    // verdad para lo mismo solo pueden desincronizarse.
    const secret = {
      host: body.host,
      port: body.port,
      user: body.username,
      password: finalPassword,
      from: body.fromEmail,
      ...(body.encryption
        ? { encryption: body.encryption }
        : body.secure !== undefined
          ? { secure: body.secure }
          : {}),
    };

    await config.set(claims.tenantId, 'notifications', 'smtp', secret, {
      isSecret: true,
      actorId: claims.sub,
    });

    // Metadata pública (no-secret) — incluye `fromName` (que no viaja en el
    // schema cifrado) + reset de `verifiedAt`. Cualquier change → re-verify.
    await config.set(
      claims.tenantId,
      'notifications',
      'smtp_meta',
      {
        fromName: body.fromName ?? null,
        verifiedAt: null,
        verifiedByUserId: null,
      },
      { isSecret: false, actorId: claims.sub },
    );

    return this.readDto(claims.tenantId);
  }

  @Get('sender')
  @ApiOperation({
    summary: '«Correo para respuestas» del aula y adónde van hoy las respuestas de sus correos.',
  })
  async getSender(@CurrentUser() user: SessionClaims | undefined): Promise<SenderResponseDto> {
    const claims = requireAdmin(user);
    return this.readSenderDto(claims.tenantId);
  }

  @Put('sender')
  @ApiOperation({
    summary:
      'Guarda el «Correo para respuestas» (Reply-To de los correos del aula). null o vacío lo quita.',
  })
  async upsertSender(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(SenderUpsertSchema))
    body: z.infer<typeof SenderUpsertSchema>,
  ): Promise<SenderResponseDto> {
    const claims = requireAdmin(user);
    const value: TenantSenderSetting = { replyToEmail: body.replyToEmail };
    await this.modules
      .getTenantConfig()
      .set(claims.tenantId, SENDER_SETTING_MODULE, SENDER_SETTING_KEY, value, {
        isSecret: false,
        actorId: claims.sub,
      });
    return this.readSenderDto(claims.tenantId);
  }

  private async readSenderDto(tenantId: string): Promise<SenderResponseDto> {
    const stored = (await this.modules
      .getTenantConfig()
      .get(tenantId, SENDER_SETTING_MODULE, SENDER_SETTING_KEY)
      .catch(() => undefined)) as Partial<TenantSenderSetting> | undefined;
    // Se pregunta al MISMO resolver que usan los envíos: lo que se enseña es
    // exactamente lo que saldrá en la cabecera, no una reconstrucción aparte.
    // Sin SMTP propio se calcula aunque el despliegue aún no tenga SMTP
    // compartido: el creador ve adónde irán las respuestas cuando lo haya.
    const own = await this.resolver.resolveTenantOnly(tenantId);
    const usesOwnSmtp = own !== null;
    const effectiveReplyTo = own
      ? (own.config.sender?.replyTo ?? own.config.from)
      : await this.resolver.sharedReplyTo(tenantId);
    return {
      replyToEmail: sanitizeReplyTo(stored?.replyToEmail),
      effectiveReplyTo,
      usesOwnSmtp,
    };
  }

  @Post('test')
  @ApiOperation({
    summary:
      'Envía un email de prueba a `toEmail` usando la config SMTP del tenant. Si éxito, marca `verifiedAt`.',
  })
  async test(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(SmtpTestSchema))
    body: z.infer<typeof SmtpTestSchema>,
  ): Promise<{ ok: true; sentTo: string; messageId?: string; verifiedAt: string }> {
    const claims = requireAdmin(user);
    const smtp = this.modules.getSmtpAdapter();

    const resolved = await this.resolver.resolveTenantOnly(claims.tenantId);
    if (!resolved) {
      throw new BadRequestException({
        message: 'SMTP no configurado para este tenant — guarda credenciales antes de probar.',
        code: 'ADMIN_SMTP_NOT_CONFIGURED',
      });
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: claims.tenantId },
      select: { slug: true, name: true },
    });

    const branding = await resolveEmailBranding(
      this.prisma as unknown as BrandingPrisma,
      claims.tenantId,
      // Aula del tenant (no `WEB_PUBLIC_URL`): de ahí cuelga el logo del correo.
      // Best-effort, como el resto del branding: sin ella el correo sale sin logo.
      await this.modules.getTenantWebBaseUrl(claims.tenantId).catch(() => ''),
    );
    // El email de prueba sale en el idioma del ADMIN que lo dispara: es él
    // quien lo va a leer para comprobar que el SMTP funciona. La key
    // `admin.smtp.test` ya vive en el catálogo del hub traducida a los dos
    // idiomas, así que aquí no se redacta copy: se resuelve e interpola.
    const locale = await this.resolveActorLocale(claims.tenantId, claims.sub);
    const def = resolveHubDefault(SMTP_TEST_TEMPLATE_KEY, locale)!;
    const vars = {
      tenantName: branding.tenantName,
      tenantSlug: tenant?.slug ?? resolveFixedEmailCopy('value.unknown_tenant_slug', locale),
      timestamp: new Date().toISOString(),
    };
    const subject = interpolate(def.subject ?? '', vars);
    const bodyText = interpolate(def.body, vars);
    const { html, text } = renderBrandedEmail(branding, {
      lang: toHubTemplateLang(locale),
      title: resolveFixedEmailCopy('title.smtp_test', locale),
      bodyHtml: textToHtmlParagraphs(bodyText),
      bodyText,
    });
    const result = await smtp.send(
      resolved.config,
      { to: body.toEmail, subject, text, html },
      branding.tenantName,
    );

    if (!result.ok) {
      // El error real del MTA (auth failed, host inválido, etc.) viaja en
      // la respuesta para que el admin pueda diagnosticar — no es secreto.
      // `detail` va aparte del `message` para que el front lo pueda enmarcar
      // en su idioma en vez de perderlo al traducir el `code` (ver
      // `CODES_WITH_DETAIL` en apps/web/src/lib/i18n/api-error.ts).
      throw new BadRequestException({
        message: `SMTP falló: ${result.error ?? SMTP_NO_DETAIL}`,
        code: 'ADMIN_SMTP_TEST_FAILED',
        ...(result.error ? { detail: result.error } : {}),
      });
    }

    // Marca verificado: actualiza meta sin tocar las credenciales.
    const config = this.modules.getTenantConfig();
    const prevMeta = (await config
      .get(claims.tenantId, 'notifications', 'smtp_meta')
      .catch(() => undefined)) as { fromName?: string | null } | undefined;
    const verifiedAt = new Date().toISOString();
    await config.set(
      claims.tenantId,
      'notifications',
      'smtp_meta',
      {
        fromName: prevMeta?.fromName ?? null,
        verifiedAt,
        verifiedByUserId: claims.sub,
      },
      { isSecret: false, actorId: claims.sub },
    );

    return { ok: true, sentTo: body.toEmail, messageId: result.messageId, verifiedAt };
  }

  @Post('test-template')
  @ApiOperation({
    summary:
      'Envía a `toEmail` el email REAL de una plantilla del catálogo, con el override del tenant si lo tiene. Para previsualizar antes de que salga a cientos de personas.',
  })
  async testTemplate(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(TemplateTestSchema))
    body: z.infer<typeof TemplateTestSchema>,
  ): Promise<{ ok: true; sentTo: string; subject: string | null; messageId?: string }> {
    const claims = requireAdmin(user);

    // A diferencia del test de SMTP, aquí sí vale el global del despliegue: lo
    // que se quiere probar es el email, no las credenciales del tenant.
    const resolved = await this.resolver.resolve(claims.tenantId);
    if (!resolved) {
      throw new BadRequestException({
        message: 'No hay SMTP configurado ni en el tenant ni en el despliegue.',
        code: 'ADMIN_SMTP_NOT_CONFIGURED_ANYWHERE',
      });
    }

    const variables = body.variables ?? {};
    const locale = body.locale ?? HUB_DEFAULT_LOCALE;
    // Misma precedencia que `renderForTenant` del hub: override en el locale
    // pedido → override en el de referencia → default del producto. Si el
    // tenant solo personalizó el español, la vista previa en inglés enseña ese
    // override, que es exactamente lo que saldría por correo.
    const override =
      (await this.prisma.notificationTemplate.findUnique({
        where: {
          tenantId_key_channel_locale: {
            tenantId: claims.tenantId,
            key: body.templateKey,
            channel: 'EMAIL',
            locale,
          },
        },
      })) ??
      (locale !== HUB_DEFAULT_LOCALE
        ? await this.prisma.notificationTemplate.findUnique({
            where: {
              tenantId_key_channel_locale: {
                tenantId: claims.tenantId,
                key: body.templateKey,
                channel: 'EMAIL',
                locale: HUB_DEFAULT_LOCALE,
              },
            },
          })
        : null);
    const fallback = resolveHubDefault(body.templateKey, locale);
    if (!override && !fallback) {
      throw new BadRequestException({
        message: `No existe la plantilla "${body.templateKey}".`,
        code: 'ADMIN_SMTP_TEMPLATE_NOT_FOUND',
        detail: body.templateKey,
      });
    }

    const branding = await resolveEmailBranding(
      this.prisma as unknown as BrandingPrisma,
      claims.tenantId,
      // Aula del tenant (no `WEB_PUBLIC_URL`): de ahí cuelga el logo del correo.
      // Best-effort, como el resto del branding: sin ella el correo sale sin logo.
      await this.modules.getTenantWebBaseUrl(claims.tenantId).catch(() => ''),
    );
    // `tenantName` lo inyecta el hub en todos sus envíos: sin él la plantilla
    // saldría con un hueco donde va el nombre de la plataforma.
    const vars = { tenantName: branding.tenantName, ...variables };

    const rawSubject = override?.subject ?? fallback?.subject ?? null;
    const rawBody = override?.body ?? fallback?.body ?? '';
    const subject = rawSubject ? interpolate(rawSubject, vars) : null;
    const bodyText = interpolate(rawBody, vars);

    const { html, text } = renderBrandedEmail(branding, {
      lang: toHubTemplateLang(locale),
      title: subject ?? branding.tenantName,
      bodyHtml: textToHtmlParagraphs(bodyText),
      bodyText,
    });
    const result = await this.modules
      .getSmtpAdapter()
      .send(
        resolved.config,
        { to: body.toEmail, subject: subject ?? branding.tenantName, text, html },
        branding.tenantName,
      );

    if (!result.ok) {
      throw new BadRequestException({
        message: `SMTP falló: ${result.error ?? SMTP_NO_DETAIL}`,
        code: 'ADMIN_SMTP_TEST_FAILED',
        ...(result.error ? { detail: result.error } : {}),
      });
    }
    this.logger.log(
      `Prueba de plantilla "${body.templateKey}" enviada a ${body.toEmail} (tenant ${claims.tenantId})`,
    );
    return { ok: true, sentTo: body.toEmail, subject, messageId: result.messageId };
  }

  /**
   * Idioma del admin que dispara la prueba, leído de su fila de `user`.
   *
   * DOS caminos degradados, los dos a `HUB_DEFAULT_LOCALE` y a propósito:
   *  (a) la consulta falla o el actor no tiene fila en este tenant (sesión de
   *      un usuario borrado entre el login y el click) — no hay a quién
   *      preguntarle el idioma y la prueba de SMTP no se aborta por eso;
   *  (b) la fila existe pero `locale` viene vacío, que es lo que absorbe
   *      `resolveRecipientLocale`.
   * Ninguno rompe el envío: el email de prueba tiene que salir igual.
   */
  private async resolveActorLocale(tenantId: string, userId: string): Promise<string> {
    try {
      const actor = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { locale: true, tenantId: true },
      });
      if (!actor || actor.tenantId !== tenantId) return HUB_DEFAULT_LOCALE;
      return resolveRecipientLocale(actor.locale);
    } catch (err) {
      this.logger.warn(
        `[admin-smtp] no se pudo leer el idioma del admin ${userId}, se usa ${HUB_DEFAULT_LOCALE}: ${(err as Error).message.slice(0, 200)}`,
      );
      return HUB_DEFAULT_LOCALE;
    }
  }

  private async readDto(tenantId: string): Promise<SmtpResponseDto> {
    const config = this.modules.getTenantConfig();
    let secret:
      | {
          host?: string;
          port?: number;
          user?: string;
          password?: string;
          from?: string;
          encryption?: SmtpEncryption;
          secure?: boolean;
        }
      | undefined;
    try {
      secret = (await config.get(tenantId, 'notifications', 'smtp')) as typeof secret;
    } catch (err) {
      this.logger.warn(
        `[admin-smtp] decrypt falló leyendo SMTP del tenant ${tenantId}: ${(err as Error).message.slice(0, 200)}`,
      );
      secret = undefined;
    }
    const meta =
      ((await config.get(tenantId, 'notifications', 'smtp_meta').catch(() => undefined)) as
        | { fromName?: string | null; verifiedAt?: string | null; verifiedByUserId?: string | null }
        | undefined) ?? {};

    const globalResolved = await this.resolver.resolve(tenantId);
    const hasGlobalFallback = globalResolved?.source === 'global';

    // Deriva el modo para configs legadas: `secure:false` se presenta como
    // `starttls` (la intención era "no TLS implícito"; al re-guardar pasa a
    // STARTTLS estricto) y sin boolean se infiere por puerto.
    const encryption: SmtpEncryption | null = !secret
      ? null
      : (secret.encryption ??
        (secret.secure === true
          ? 'tls'
          : secret.secure === false
            ? 'starttls'
            : secret.port === 465
              ? 'tls'
              : 'starttls'));

    return {
      host: secret?.host ?? null,
      port: secret?.port ?? null,
      encryption,
      secure: secret?.secure ?? null,
      username: secret?.user ?? null,
      hasPassword: Boolean(secret?.password),
      fromEmail: secret?.from ?? null,
      fromName: meta.fromName ?? null,
      verifiedAt: meta.verifiedAt ?? null,
      verifiedByUserId: meta.verifiedByUserId ?? null,
      hasTenantConfig: Boolean(secret),
      hasGlobalFallback,
    };
  }
}
