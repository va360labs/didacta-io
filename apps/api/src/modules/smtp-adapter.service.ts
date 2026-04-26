import { Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod';

/**
 * Schema de la config SMTP que cada tenant configura desde
 * `/admin/configuracion`. Se persiste cifrada con AES-256-GCM en
 * `tenant_setting` bajo (moduleName='notifications', key='smtp', is_secret=true).
 */
export const SmtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  password: z.string().min(1),
  from: z.string().email(),
  /** STARTTLS si es true; TLS implícito si false (port 465). Default: auto por puerto. */
  secure: z.boolean().optional(),
});

export type SmtpConfig = z.infer<typeof SmtpConfigSchema>;

export interface SmtpSendInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
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
   */
  async send(config: SmtpConfig, input: SmtpSendInput): Promise<SmtpSendResult> {
    const transporter = this.createTransporter(config);
    try {
      const info = await transporter.sendMail({
        from: config.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
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

  private createTransporter(config: SmtpConfig): Transporter {
    const secure = config.secure ?? config.port === 465;
    return nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure,
      auth: {
        user: config.user,
        pass: config.password,
      },
    });
  }
}
