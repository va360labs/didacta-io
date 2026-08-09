/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Plantilla de email con marca del TENANT, compartida por todos los emisores
 * (NotificationHub, reset de contraseña, inscripción, decisiones, renovaciones…).
 *
 * Objetivo (pedido de producto):
 *  - Los correos se firman con el nombre del TENANT, nunca "Didacta".
 *  - Todos comparten el mismo diseño: header con el logo del tenant, color de
 *    marca, contenido, botón CTA y footer discreto "Powered by Didacta".
 *  - El logo y el color salen del theming per-tenant (`ModThemingTenantTheme`);
 *    el nombre de `tenant.name`. Si falta el logo, se muestra el nombre.
 *
 * Es HTML "email-safe": estilos inline, layout con tablas y max-width 600px
 * para compatibilidad con la mayoría de clientes.
 */

/** Cliente Prisma mínimo que el resolver necesita (evita acoplar al service). */
export interface BrandingPrisma {
  tenant: { findUnique(args: unknown): Promise<{ name: string } | null> };
  modThemingTenantTheme: {
    findUnique(
      args: unknown,
    ): Promise<{ logoUrl: string | null; brandHue: number; brandSaturation: number } | null>;
  };
}

export interface EmailBranding {
  /** Nombre público del tenant (firma y remite). */
  tenantName: string;
  /** URL absoluta del logo, o null si no hay/no se pudo resolver. */
  logoUrl: string | null;
  /** Color de marca en HEX (del theming del tenant). */
  brandColor: string;
}

/**
 * Idioma en el que va redactado el email, para el atributo `lang` del `<html>`.
 *
 * Es la MISMA lista cerrada que `HUB_TEMPLATE_LANGS`
 * (`modules/notifications/email-template-catalog.ts`); se redeclara aquí para
 * que este fichero siga sin dependencias — lo compartimos con 23 emisores y no
 * queremos arrastrar el catálogo (que a su vez importa un paquete de módulo) a
 * cada test que renderice un email. Un test aserta que las dos listas coinciden.
 */
export type EmailLang = 'es' | 'en';

export interface BrandedEmailContent {
  /**
   * Idioma del contenido. OBLIGATORIO a propósito: con un opcional no se
   * distingue «este email va en español» de «se me olvidó pasarlo», y el
   * síntoma —un email inglés marcado como español— no lo ve nadie hasta que un
   * lector de pantalla lo lee con la voz equivocada o Gmail ofrece traducirlo.
   * Los emisores que todavía solo redactan español lo declaran `'es'`.
   */
  lang: EmailLang;
  /** Título destacado (color de marca) arriba del cuerpo. */
  title: string;
  /** Cuerpo ya en HTML (el caller escapa lo que corresponda). */
  bodyHtml: string;
  /** Cuerpo en texto plano (para el `text/plain`). */
  bodyText: string;
  /** Botón CTA opcional. */
  cta?: { url: string; label: string };
  /** Nota de footer (por qué recibe el email). Opcional. */
  footerNote?: string;
}

/** Escapa texto para insertarlo en HTML (contenido, no atributos). */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** HSL (0-360, 0-100, 0-100) → HEX. Para el color de marca del theming. */
export function hslToHex(h: number, s: number, l: number): string {
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const lig = Math.max(0, Math.min(100, l)) / 100;
  const k = (n: number) => (n + (((h % 360) + 360) % 360) / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const color = lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Resuelve el branding de email de un tenant: nombre, logo absoluto y color.
 * Nunca lanza: si algo falla, cae a defaults razonables (sin logo, color
 * Didacta) para no romper el envío por un problema de branding.
 *
 * `webBaseUrl` se usa como fallback para prefijar un `logoUrl` relativo cuando
 * `PUBLIC_API_URL` no está seteado (API y web comparten dominio en Didacta).
 */
export async function resolveEmailBranding(
  prisma: BrandingPrisma,
  tenantId: string,
  webBaseUrl: string,
): Promise<EmailBranding> {
  let tenantName = 'la plataforma';
  let logoUrl: string | null = null;
  let brandColor = '#1E5AA8';
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    if (tenant?.name) tenantName = tenant.name;

    const theme = await prisma.modThemingTenantTheme.findUnique({
      where: { tenantId },
      select: { logoUrl: true, brandHue: true, brandSaturation: true },
    });
    if (theme) {
      brandColor = hslToHex(theme.brandHue, theme.brandSaturation, 45);
      logoUrl = resolveLogoUrl(theme.logoUrl, webBaseUrl);
    }
  } catch {
    // Branding best-effort: seguimos con los defaults.
  }
  return { tenantName, logoUrl, brandColor };
}

/** Un `logoUrl` del theming → URL absoluta (o null). Relativo se prefija. */
function resolveLogoUrl(logoUrl: string | null, webBaseUrl: string): string | null {
  if (!logoUrl) return null;
  if (/^https?:\/\//i.test(logoUrl)) return logoUrl;
  const apiBaseRaw = process.env['PUBLIC_API_URL']?.trim() || webBaseUrl;
  const apiBase = apiBaseRaw.endsWith('/') ? apiBaseRaw.slice(0, -1) : apiBaseRaw;
  const path = logoUrl.startsWith('/') ? logoUrl : `/${logoUrl}`;
  return `${apiBase}${path}`;
}

/**
 * Renderiza un email con la marca del tenant. Devuelve `{ html, text }`.
 * El `text` es un fallback plano coherente (título, cuerpo, CTA como URL, firma
 * y footer) para clientes que no renderizan HTML.
 */
export function renderBrandedEmail(
  branding: EmailBranding,
  content: BrandedEmailContent,
): { html: string; text: string } {
  const name = escapeHtml(branding.tenantName);
  const color = branding.brandColor;

  const header =
    branding.logoUrl && /^https?:\/\//i.test(branding.logoUrl)
      ? `<img src="${escapeHtmlAttr(branding.logoUrl)}" alt="${escapeHtmlAttr(
          branding.tenantName,
        )}" style="max-height:44px;max-width:200px;object-fit:contain;" />`
      : `<span style="font-size:20px;font-weight:700;color:${color};">${name}</span>`;

  const ctaHtml = content.cta
    ? `<tr><td style="padding:8px 0 4px;">
         <a href="${escapeHtmlAttr(content.cta.url)}" style="display:inline-block;background:${color};color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">${escapeHtml(
           content.cta.label,
         )}</a>
       </td></tr>`
    : '';

  const footerNoteHtml = content.footerNote
    ? `<p style="margin:0 0 6px;">${escapeHtml(content.footerNote)}</p>`
    : '';

  const titleHtml = content.title
    ? `<h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:${color};">${escapeHtml(
        content.title,
      )}</h1>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="${content.lang}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr><td style="padding:24px 32px;border-bottom:1px solid #eef2f6;">${header}</td></tr>
        <tr><td style="padding:28px 32px;font-family:'Inter',system-ui,-apple-system,Segoe UI,sans-serif;color:#0D1B2A;line-height:1.6;">
          ${titleHtml}
          <div style="font-size:15px;color:#1f2b3a;">${content.bodyHtml}</div>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px;">${ctaHtml}</table>
          <p style="margin:28px 0 0;font-size:13px;color:#94a3b8;">— ${name}</p>
        </td></tr>
        <tr><td style="padding:16px 32px;background:#f8fafc;border-top:1px solid #eef2f6;font-family:'Inter',system-ui,sans-serif;font-size:12px;color:#94a3b8;">
          ${footerNoteHtml}
          <p style="margin:0;">Powered by Didacta</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const textParts = [
    ...(content.title ? [content.title, ''] : []),
    content.bodyText,
    ...(content.cta ? ['', `${content.cta.label}: ${content.cta.url}`] : []),
    '',
    `— ${branding.tenantName}`,
    '',
    '—',
    ...(content.footerNote ? [content.footerNote] : []),
    'Powered by Didacta',
  ];
  const text = textParts.join('\n');

  return { html, text };
}

/** Escapa un valor para usarlo dentro de un atributo HTML (comillas dobles). */
export function escapeHtmlAttr(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Convierte texto plano (con saltos de línea) en párrafos HTML escapados. */
export function textToHtmlParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px;">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
    .join('');
}
