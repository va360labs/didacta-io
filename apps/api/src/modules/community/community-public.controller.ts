/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { ModuleRegistryService } from '../module-registry.service';
import { toHubTemplateLang, type HubTemplateLang } from '../notifications/email-template-catalog';
import { verifyUnsubscribeToken } from './broadcast-unsubscribe';

type UnsubscribeOutcome = 'ok' | 'invalid_token' | 'error';

/**
 * Textos de la página de baja, en los mismos idiomas que los correos del hub.
 * Se sirve en el idioma del DESTINATARIO (el del correo desde el que llegó), no
 * en el del navegador: es la continuación de ese correo.
 */
const PAGE_COPY = {
  es: {
    ok: {
      title: 'Te has dado de baja',
      message:
        'Ya no recibirás más correos de la comunidad: ni avisos ni el resumen semanal. Puedes volver a activarlos cuando quieras desde las preferencias de tu cuenta.',
    },
    invalid_token: { title: 'Enlace no válido', message: 'El enlace de baja no es válido.' },
    error: { title: 'Error', message: 'No pudimos procesar tu baja. Inténtalo más tarde.' },
  },
  en: {
    ok: {
      title: 'You have unsubscribed',
      message:
        'You will no longer receive community emails: neither notices nor the weekly digest. You can turn them back on at any time from your account preferences.',
    },
    invalid_token: { title: 'Invalid link', message: 'This unsubscribe link is not valid.' },
    error: {
      title: 'Error',
      message: 'We could not process your request. Please try again later.',
    },
  },
  pt: {
    ok: {
      title: 'Você cancelou a inscrição',
      message:
        'Você não vai mais receber e-mails da comunidade: nem avisos nem o resumo semanal. Pode reativá-los quando quiser nas preferências da sua conta.',
    },
    invalid_token: { title: 'Link inválido', message: 'O link de cancelamento não é válido.' },
    error: {
      title: 'Erro',
      message: 'Não foi possível processar seu pedido. Tente novamente mais tarde.',
    },
  },
} as const satisfies Record<
  HubTemplateLang,
  Record<UnsubscribeOutcome, { title: string; message: string }>
>;

const STATUS: Record<UnsubscribeOutcome, number> = { ok: 200, invalid_token: 400, error: 500 };

/**
 * Endpoints PÚBLICOS de comunidad (sin JwtAuthGuard). Hoy solo la baja de los
 * correos de la comunidad (avisos masivos y resumen semanal), que se abre desde
 * el enlace de un email — el destinatario no tiene por qué estar logueado. La
 * autorización va en el TOKEN firmado del enlace.
 */
@ApiTags('Modules · Community (public)')
@Controller('modules/community')
export class CommunityPublicController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('unsubscribe')
  @ApiOperation({
    summary: 'Baja de los correos de la comunidad vía token firmado (enlace del email).',
  })
  async unsubscribe(
    @Query('token') token: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const { outcome, lang } = await this.optOut(token, req);
    const copy = PAGE_COPY[lang][outcome];
    reply
      .status(STATUS[outcome])
      .header('content-type', 'text/html; charset=utf-8')
      .send(page(lang, copy.title, copy.message));
  }

  /**
   * Baja en un clic desde el propio gestor de correo (RFC 8058): Gmail y
   * Outlook enseñan «Cancelar suscripción» junto al remitente cuando el correo
   * lleva `List-Unsubscribe` + `List-Unsubscribe-Post`, y al pulsarlo hacen un
   * POST a esta misma URL, sin abrir ninguna página.
   */
  @Post('unsubscribe')
  @HttpCode(200)
  @ApiOperation({ summary: 'Baja en un clic (RFC 8058) desde el gestor de correo.' })
  async unsubscribeOneClick(
    @Query('token') token: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const { outcome } = await this.optOut(token, req);
    // Lo lee una máquina: basta el código de estado y una palabra estable.
    reply.status(STATUS[outcome]).header('content-type', 'text/plain; charset=utf-8').send(outcome);
  }

  private async optOut(
    token: string | undefined,
    req: FastifyRequest,
  ): Promise<{ outcome: UnsubscribeOutcome; lang: HubTemplateLang }> {
    let parsed: ReturnType<typeof verifyUnsubscribeToken>;
    try {
      parsed = token ? verifyUnsubscribeToken(token) : null;
    } catch {
      // Verificar lanza si falta el secreto de firma: no se puede afirmar que
      // el enlace sea malo, solo que ahora mismo no se puede comprobar.
      return { outcome: 'error', lang: langFromRequest(req) };
    }
    // Sin token válido no se sabe quién es: solo queda el idioma del navegador.
    if (!parsed) return { outcome: 'invalid_token', lang: langFromRequest(req) };
    try {
      // RLS F2: el tenant viene en el propio token firmado del enlace — la baja
      // (y la lectura del idioma) corren bajo su contexto ALS.
      return await runAsTenant(
        parsed.tenantId,
        async () => {
          await this.registry
            .getCommunityService()
            .setCommunityEmailOptOut(parsed.tenantId, parsed.userId, true);
          return { outcome: 'ok' as const, lang: await this.langOfUser(parsed.userId, req) };
        },
        { userId: parsed.userId, traceLabel: 'unsubscribe' },
      );
    } catch {
      return { outcome: 'error', lang: langFromRequest(req) };
    }
  }

  /**
   * Idioma guardado del destinatario. CAMINO DEGRADADO: sin fila, con el
   * idioma en blanco o si la consulta falla, se usa el del navegador — la baja
   * ya está hecha y no se le va a contestar con un error por no saber el idioma.
   */
  private async langOfUser(userId: string, req: FastifyRequest): Promise<HubTemplateLang> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { locale: true },
      });
      const stored = typeof user?.locale === 'string' ? user.locale.trim() : '';
      if (stored) return toHubTemplateLang(stored);
    } catch {
      // cae al idioma del navegador
    }
    return langFromRequest(req);
  }
}

/** Primer idioma de `Accept-Language`, reducido a los que tienen catálogo. */
function langFromRequest(req: FastifyRequest): HubTemplateLang {
  const header = req.headers?.['accept-language'];
  const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0];
  return toHubTemplateLang(first);
}

/** `lang` del documento: el portugués de los catálogos es el de Brasil. */
const HTML_LANG: Record<HubTemplateLang, string> = { es: 'es', en: 'en', pt: 'pt-BR' };

function page(lang: HubTemplateLang, title: string, message: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    `<!DOCTYPE html><html lang="${HTML_LANG[lang]}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>` +
    `<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;margin:0;padding:40px 16px;color:#0d1b2a">` +
    `<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:32px;text-align:center">` +
    `<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>` +
    `<p style="color:#475569;line-height:1.6;margin:0">${esc(message)}</p></div></body></html>`
  );
}
