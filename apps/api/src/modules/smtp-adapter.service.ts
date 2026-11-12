/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod';
import { resolveSenderName, type SmtpSenderIdentity } from './smtp-sender-identity';

/**
 * Schema de la config SMTP que cada tenant configura desde
 * `/admin/configuracion`. Se persiste cifrada con AES-256-GCM en
 * `tenant_setting` bajo (moduleName='notifications', key='smtp', is_secret=true).
 */
/**
 * Modo de cifrado explícito de la conexión SMTP:
 *  - `tls`: TLS implícito desde el primer byte (puerto 465).
 *  - `starttls`: conexión en claro que se actualiza con STARTTLS (puerto 587).
 *    Obligatorio: si el servidor no ofrece el upgrade, el envío falla en vez
 *    de degradar a texto plano.
 *  - `none`: sin cifrado (MTAs internos tipo mailpit o postfix local).
 */
export const SmtpEncryptionSchema = z.enum(['tls', 'starttls', 'none']);

export type SmtpEncryption = z.infer<typeof SmtpEncryptionSchema>;

export const SmtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  password: z.string().min(1),
  from: z.string().email(),
  encryption: SmtpEncryptionSchema.optional(),
  /**
   * Legado (configs guardadas antes de existir `encryption`): true → TLS
   * implícito; false → claro con STARTTLS oportunista; ausente → inferencia
   * por puerto (465 → TLS implícito). Solo se consulta si falta `encryption`.
   */
  secure: z.boolean().optional(),
});

export type SmtpConfig = z.infer<typeof SmtpConfigSchema>;

/**
 * Config lista para enviar: la de `SmtpConfigSchema` más la identidad del
 * remitente que añade `TenantSmtpResolverService` (nombre visible y Reply-To).
 * No forma parte del schema persistido: se calcula en cada resolución.
 */
export type SmtpSendConfig = SmtpConfig & { sender?: SmtpSenderIdentity };

export interface SmtpSendInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * Enlace de baja en un clic (RFC 8058). Con él, el correo lleva
   * `List-Unsubscribe` + `List-Unsubscribe-Post` y Gmail/Outlook enseñan
   * «Cancelar suscripción» junto al remitente, que hace un POST a esta URL.
   * Solo para correos de los que uno se puede dar de baja (nunca un reset de
   * contraseña).
   */
  unsubscribeUrl?: string;
  /**
   * Adjuntos (p. ej. el PDF de una factura). Sin ellos el correo sale
   * exactamente igual que antes.
   */
  attachments?: ReadonlyArray<{ filename: string; content: Buffer; contentType?: string }>;
}

export interface SmtpSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Adapter SMTP construido sobre nodemailer.
 *
 * El servicio es **stateless** desde el punto de vista de sesiones: por cada
 * `send()` crea un transporter con la config recibida, envía y lo descarta.
 * Esto es lo más simple para multi-tenant: no hay que cachear conexiones por
 * tenant ni invalidarlas al cambiar la config. El overhead por mensaje es
 * mínimo (handshake STARTTLS) y los volúmenes esperados de un LMS son bajos.
 *
 * Si en el futuro un tenant tiene volumen alto, se introduce un cache de
 * transporters por tenant con invalidación al actualizar la config.
 */
@Injectable()
export class SmtpAdapterService {
  /**
   * Valida y parsea la config raw que viene del TenantConfigService.
   * Lanza ZodError si la config no cumple el schema.
   */
  parseConfig(raw: unknown): SmtpConfig {
    return SmtpConfigSchema.parse(raw);
  }

  isConfigValid(raw: unknown): boolean {
    return SmtpConfigSchema.safeParse(raw).success;
  }

  /**
   * Envía un mail a través del SMTP del tenant. Devuelve `{ ok: true, messageId }`
   * en éxito o `{ ok: false, error }` en fallo (no relanza).
   *
   * `fromName` (opcional) es el nombre de la academia que pasa el emisor. La
   * DIRECCIÓN es siempre `config.from`; el nombre visible sale de
   * `resolveSenderName`: el fijado por el SMTP propio del aula → `fromName` →
   * el de la plataforma. Todo nombre se sanea contra inyección de cabeceras y
   * suplantación (ver `smtp-sender-identity.ts`). Si la identidad trae
   * Reply-To, se añade.
   */
  async send(
    config: SmtpSendConfig,
    input: SmtpSendInput,
    fromName?: string,
  ): Promise<SmtpSendResult> {
    const transporter = this.createTransporter(config);
    const name = resolveSenderName(config.sender, fromName);
    const from = name ? { name, address: config.from } : config.from;
    const replyTo = config.sender?.replyTo;
    try {
      const info = await transporter.sendMail({
        from,
        ...(replyTo && replyTo.toLowerCase() !== config.from.toLowerCase() ? { replyTo } : {}),
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
        ...(input.unsubscribeUrl
          ? {
              list: { unsubscribe: input.unsubscribeUrl },
              headers: { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
            }
          : {}),
        ...(input.attachments && input.attachments.length > 0
          ? {
              attachments: input.attachments.map((a) => ({
                filename: a.filename,
                content: a.content,
                ...(a.contentType ? { contentType: a.contentType } : {}),
              })),
            }
          : {}),
      });
      return { ok: true, messageId: info.messageId };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      transporter.close();
    }
  }

  /**
   * Verifica que el SMTP responda al handshake con las credenciales actuales.
   * Útil para el botón "Probar envío" del panel de configuración.
   */
  async verify(config: SmtpConfig): Promise<SmtpSendResult> {
    const transporter = this.createTransporter(config);
    try {
      await transporter.verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      transporter.close();
    }
  }

  /**
   * `secure` de nodemailer significa TLS IMPLÍCITO desde el primer byte: contra
   * un puerto STARTTLS (587) el handshake revienta con "wrong version number"
   * (issue #60). De ahí el modo explícito: `starttls` fuerza `requireTLS` (si
   * el servidor no ofrece el upgrade, falla — nunca degrada a claro) y `none`
   * apaga también el upgrade oportunista. Sin `encryption` se conserva el
   * comportamiento legado: boolean `secure` o inferencia por puerto, con
   * STARTTLS oportunista cuando la conexión empieza en claro.
   */
  private tlsOptions(config: SmtpConfig): {
    secure: boolean;
    requireTLS?: boolean;
    ignoreTLS?: boolean;
  } {
    switch (config.encryption) {
      case 'tls':
        return { secure: true };
      case 'starttls':
        return { secure: false, requireTLS: true };
      case 'none':
        return { secure: false, ignoreTLS: true };
      default:
        return { secure: config.secure ?? config.port === 465 };
    }
  }

  private createTransporter(config: SmtpConfig): Transporter {
    return nodemailer.createTransport({
      host: config.host,
      port: config.port,
      ...this.tlsOptions(config),
      auth: {
        user: config.user,
        pass: config.password,
      },
      // Sin esto, nodemailer usa sus defaults (hasta 2 min de connectionTimeout
      // + 2 min de socketTimeout): un host SMTP mal configurado o inalcanzable
      // colgaba `send()`/`verify()` minutos enteros. Como quien invita a un
      // alumno (`AdminUsersService.invite`) espera este envío en el mismo
      // request-response (try/catch fail-soft, pero SÍNCRONO), el alta entera
      // parecía congelada/rota en vez de simplemente "sin email". Acotado a
      // unos segundos: sigue siendo tiempo de sobra para un SMTP sano.
      connectionTimeout: 8_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
  }
}
