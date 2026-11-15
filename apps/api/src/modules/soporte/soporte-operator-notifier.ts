/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Logger } from '@nestjs/common';
import type { AvisoOperadorTicket, TipoTicket } from '@didacta/mod-soporte';
import {
  renderBrandedEmail,
  textToHtmlParagraphs,
  type EmailBranding,
} from '../../common/branded-email';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import type { SmtpAdapterService } from '../smtp-adapter.service';
import type { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';

/**
 * Correo inmediato al OPERADOR de la plataforma (Didacta Cloud) por cada
 * ticket de soporte nuevo de cualquier aula. Va en español —lo lee el
 * operador, no el aula— y lleva todo lo necesario para actuar sin abrir nada:
 * el aula (nombre y dominio), el tipo, el texto entero, quién lo abre (nombre
 * y correo), si trae captura y el enlace directo al ticket en la bandeja del
 * aula.
 *
 * Sale por el SMTP GLOBAL del despliegue (el de la plataforma), así que llega
 * aunque el aula no tenga SMTP propio; solo si el despliegue no tiene ninguno
 * se intenta con el del aula. Cualquier fallo (sin SMTP, el servidor de correo
 * lo rechaza, una excepción) queda en el log con nivel de error y prefijo
 * `alert:`, que es lo que vigila el operador. Nunca lanza: el ticket ya está
 * guardado y el equipo del aula ya tiene su aviso.
 */

const OPERATOR_BRAND: EmailBranding = {
  tenantName: 'Didacta · soporte',
  logoUrl: null,
  brandColor: '#1E5AA8',
};

const SENDER_NAME = 'Didacta soporte';

const TIPO_ES: Readonly<Record<TipoTicket, string>> = {
  FALLO: 'Algo no funciona',
  PROBLEMA: 'Tiene un problema',
  MEJORA: 'Una sugerencia',
};

/** Lo mínimo de Prisma que hace falta (lecturas bajo la RLS del aula). */
export interface OperatorNotifierPrisma {
  tenant: {
    findUnique(args: {
      where: { id: string };
      select: { name: true };
    }): Promise<{ name: string } | null>;
  };
  user: {
    findFirst(args: {
      where: { id: string; tenantId: string };
      select: { email: true; name: true };
    }): Promise<{ email: string; name: string | null } | null>;
  };
}

export interface SoporteOperatorNotifierDeps {
  readonly prisma: OperatorNotifierPrisma;
  readonly smtpResolver: Pick<TenantSmtpResolverService, 'resolveGlobal' | 'resolve'>;
  readonly smtp: Pick<SmtpAdapterService, 'send'>;
  /** `https://academia.didacta.io` (sin barra final) o `''` si no se sabe. */
  readonly webBaseUrl: (tenantId: string) => Promise<string>;
  /** `SUPPORT_OPERATOR_ALERT_EMAIL`; sin ella no se construye este notificador. */
  readonly alertEmail: string;
  /** Inyectable para los tests; por defecto, el Logger de Nest. */
  readonly logger?: Pick<Logger, 'error' | 'log'>;
}

export interface OperatorEmail {
  subject: string;
  text: string;
  html: string;
}

export interface OperatorEmailData {
  academy: string;
  domain: string;
  tipo: TipoTicket;
  texto: string;
  autorNombre: string;
  autorEmail: string | null;
  tieneCaptura: boolean;
  createdAt: Date;
  /** Enlace directo al ticket en la bandeja del aula; `''` si no se sabe el dominio. */
  ticketUrl: string;
}

function una(linea: string, max: number): string {
  const s = linea.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** El correo al operador, en español. Pura: la prueban los tests tal cual. */
export function buildOperatorEmail(d: OperatorEmailData): OperatorEmail {
  const tipo = TIPO_ES[d.tipo];
  const autor = d.autorNombre.trim() || '(sin nombre)';
  const quien = d.autorEmail ? `${autor} <${d.autorEmail}>` : autor;
  const fecha = new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Madrid',
  }).format(d.createdAt);
  const subject = una(`[Soporte] ${d.academy}: ${tipo.toLowerCase()} — ${autor}`, 150);
  const title = `Ticket nuevo en «${d.academy}»`;
  const captura = d.tieneCaptura ? 'Sí (se ve en el ticket)' : 'No';
  const { html, text } = renderBrandedEmail(OPERATOR_BRAND, {
    lang: 'es',
    title,
    preheader: una(d.texto, 140),
    bodyHtml: textToHtmlParagraphs(d.texto),
    bodyText: d.texto,
    ...(d.ticketUrl
      ? { cta: { label: 'Abrir el ticket en la bandeja del aula', url: d.ticketUrl } }
      : {}),
    sections: [
      { heading: 'Aula', lines: [d.academy, d.domain || '(sin dominio)'] },
      { heading: 'Tipo', lines: [tipo] },
      { heading: 'Quién lo abre', lines: [quien] },
      { heading: 'Captura', lines: [captura] },
      { heading: 'Recibido', lines: [`${fecha} (hora peninsular)`] },
    ],
    signature: false,
    footerNote:
      'Te llega porque este despliegue tiene SUPPORT_OPERATOR_ALERT_EMAIL. El equipo del aula recibe su propio aviso.',
  });
  return { subject, text, html };
}

export class SoporteOperatorNotifier {
  private readonly logger: Pick<Logger, 'error' | 'log'>;

  constructor(private readonly deps: SoporteOperatorNotifierDeps) {
    this.logger = deps.logger ?? new Logger('SoporteOperatorNotifier');
  }

  async avisar(aviso: AvisoOperadorTicket): Promise<void> {
    const { tenantId, ticketId } = aviso;
    try {
      const resolved =
        this.deps.smtpResolver.resolveGlobal() ?? (await this.deps.smtpResolver.resolve(tenantId));
      if (!resolved) {
        this.logger.error(
          `alert: soporte.operator.no_smtp aula=${tenantId} ticket=${ticketId}: ni SMTP de la plataforma ni del aula, el operador no se entera`,
        );
        return;
      }
      const [academy, autor, base] = await Promise.all([
        this.academyName(tenantId),
        this.autor(tenantId, aviso.autorId),
        this.base(tenantId),
      ]);
      const email = buildOperatorEmail({
        academy,
        domain: dominio(base),
        tipo: aviso.tipo,
        texto: aviso.texto,
        autorNombre: aviso.autorNombre || autor?.name?.trim() || '',
        autorEmail: autor?.email ?? null,
        tieneCaptura: aviso.tieneCaptura,
        createdAt: aviso.createdAt,
        ticketUrl: base ? `${base}/admin/support?ticket=${ticketId}` : '',
      });
      const result = await this.deps.smtp.send(
        resolved.config,
        { to: this.deps.alertEmail, subject: email.subject, text: email.text, html: email.html },
        SENDER_NAME,
      );
      if (!result.ok) {
        this.logger.error(
          `alert: soporte.operator.send_failed aula=${tenantId} ticket=${ticketId}: ${result.error ?? 'sin detalle'}`,
        );
        return;
      }
      this.logger.log(`soporte: aviso al operador enviado (aula ${tenantId}, ticket ${ticketId})`);
    } catch (err) {
      this.logger.error(
        `alert: soporte.operator.exception aula=${tenantId} ticket=${ticketId}: ${(err as Error).message}`,
      );
    }
  }

  private async academyName(tenantId: string): Promise<string> {
    try {
      const t = await runAsTenant(tenantId, () =>
        this.deps.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      );
      return t?.name?.trim() || tenantId;
    } catch {
      return tenantId;
    }
  }

  private async autor(
    tenantId: string,
    userId: string,
  ): Promise<{ email: string; name: string | null } | null> {
    try {
      return await runAsTenant(tenantId, () =>
        this.deps.prisma.user.findFirst({
          where: { id: userId, tenantId },
          select: { email: true, name: true },
        }),
      );
    } catch {
      return null;
    }
  }

  private async base(tenantId: string): Promise<string> {
    try {
      return (await this.deps.webBaseUrl(tenantId)).trim().replace(/\/+$/, '');
    } catch {
      return '';
    }
  }
}

/** `https://academia.didacta.io` → `academia.didacta.io`; `''` si no es una URL. */
export function dominio(base: string): string {
  try {
    return base ? new URL(base).host : '';
  } catch {
    return '';
  }
}
