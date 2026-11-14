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
export type EmailLang = 'es' | 'en' | 'pt';

/**
 * Locale de `Intl` de los avisos redactados en código fuera del catálogo del
 * hub (cobros de la plataforma, factura de la comisión, confirmación de compra,
 * inactividad de vídeo). Su inglés es BRITÁNICO («1 November 2026», «€93.25»)
 * desde que nacieron, y se respeta para no cambiar lo que ya salía; el del hub
 * (`EMAIL_DATE_LOCALE`) es `en-US`. El portugués es el de Brasil en los dos.
 */
export const PLAIN_EMAIL_INTL_LOCALE: Readonly<Record<EmailLang, string>> = {
  es: 'es-ES',
  en: 'en-GB',
  pt: 'pt-BR',
};

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
  /**
   * Texto que los clientes de correo enseñan junto al asunto en la bandeja
   * («Pagado el 14 de noviembre · 49,00 €»). Oculto en el cuerpo.
   */
  preheader?: string;
  /** Línea pequeña bajo el botón («El enlace vale 7 días…»). */
  ctaNote?: string;
  /**
   * Cabecera de RECIBO, encima del título: etiqueta, importe grande y datos
   * cortos (pedido, fecha, método de pago). Es estructural: un texto del
   * creador nunca la quita.
   */
  hero?: EmailHero;
  /** Resumen con el producto y el desglose (subtotal, descuento, total…). */
  summary?: EmailSummary;
  /** Bloques con encabezado: «Vendido por», «Tu derecho de desistimiento»… */
  sections?: EmailSection[];
  /** Letra pequeña del pie, debajo de `footerNote`. */
  finePrint?: string[];
  /**
   * Firma «— Nombre» al final del cuerpo. Por defecto sí: es la de siempre.
   * Un recibo ya dice quién vende en «Vendido por».
   */
  signature?: boolean;
}

/** Cabecera de recibo: «Recibo de Primer Sorbo · 49,00 € · Pagado el …». */
export interface EmailHero {
  eyebrow: string;
  amount: string;
  amountNote?: string;
  facts: Array<{ label: string; value: string }>;
}

export interface EmailSummaryRow {
  label: string;
  value: string;
  /** Fila del total: separada y en negrita. */
  total?: boolean;
}

export interface EmailSummary {
  heading: string;
  item?: {
    title: string;
    subtitle?: string;
    /** Portada del producto (http/https); otra cosa se ignora. */
    imageUrl?: string | null;
    amount?: string;
  };
  rows: EmailSummaryRow[];
  notes?: string[];
}

export interface EmailSection {
  heading: string;
  lines: string[];
  link?: { label: string; url: string };
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

/** Fuentes del cuerpo: la del sistema de cada cliente, sin descargar nada. */
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const INK = '#111827';
const TEXT = '#374151';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const CANVAS = '#f3f4f6';
const PANEL = '#f9fafb';

/**
 * Color del texto que va SOBRE el color de marca (botón, barra): blanco salvo
 * con marcas claras, donde el blanco no se leería (un amarillo, un verde lima).
 */
export function readableTextOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1]!, 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum =
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255);
  // Contraste con blanco = 1.05 / (lum + 0.05). Por debajo de 3:1, texto oscuro.
  return 1.05 / (lum + 0.05) >= 3 ? '#ffffff' : INK;
}

function isHttpUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

/** Botón «a prueba de Outlook»: el color va en la celda (`bgcolor`), no solo en el enlace. */
function buttonHtml(color: string, url: string, label: string): string {
  const fg = readableTextOn(color);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
  <tr><td align="center" bgcolor="${color}" style="background-color:${color};border-radius:10px;">
    <a href="${escapeHtmlAttr(url)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:700;line-height:20px;color:${fg};text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
  </td></tr>
</table>`;
}

function heroHtml(hero: EmailHero): string {
  const facts = hero.facts.filter((f) => f.value.trim());
  const factCells = facts
    .map(
      (f) => `<td class="dc-fact" valign="top" style="padding:12px 12px 12px 0;width:${Math.floor(
        100 / Math.max(facts.length, 1),
      )}%;">
        <div style="font-family:${FONT};font-size:11px;line-height:16px;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};">${escapeHtml(f.label)}</div>
        <div style="font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;color:${INK};">${escapeHtml(f.value)}</div>
      </td>`,
    )
    .join('');
  return `<tr><td class="dc-pad" style="padding:28px 32px 4px;">
    <div style="font-family:${FONT};font-size:13px;line-height:18px;letter-spacing:0.04em;text-transform:uppercase;color:${MUTED};">${escapeHtml(hero.eyebrow)}</div>
    <div class="dc-amount" style="font-family:${FONT};font-size:36px;line-height:44px;font-weight:800;color:${INK};margin-top:4px;">${escapeHtml(hero.amount)}</div>
    ${
      hero.amountNote
        ? `<div style="font-family:${FONT};font-size:14px;line-height:20px;color:${MUTED};">${escapeHtml(hero.amountNote)}</div>`
        : ''
    }
    ${
      factCells
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border-top:1px solid ${LINE};border-bottom:1px solid ${LINE};"><tr>${factCells}</tr></table>`
        : ''
    }
  </td></tr>`;
}

function summaryHtml(summary: EmailSummary): string {
  const item = summary.item;
  const image = isHttpUrl(item?.imageUrl)
    ? `<td width="64" valign="top" style="padding:0 14px 0 0;width:64px;"><img src="${escapeHtmlAttr(
        item!.imageUrl!,
      )}" width="64" height="64" alt="" style="display:block;width:64px;height:64px;border-radius:10px;object-fit:cover;border:0;" /></td>`
    : '';
  const itemRow = item
    ? `<tr><td colspan="2" style="padding:0 0 14px;border-bottom:1px solid ${LINE};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          ${image}
          <td valign="top">
            <div style="font-family:${FONT};font-size:15px;line-height:21px;font-weight:700;color:${INK};">${escapeHtml(item.title)}</div>
            ${
              item.subtitle
                ? `<div style="font-family:${FONT};font-size:13px;line-height:19px;color:${MUTED};margin-top:2px;">${escapeHtml(item.subtitle)}</div>`
                : ''
            }
          </td>
          ${
            item.amount
              ? `<td valign="top" align="right" style="font-family:${FONT};font-size:15px;line-height:21px;font-weight:600;color:${INK};white-space:nowrap;padding-left:12px;">${escapeHtml(item.amount)}</td>`
              : ''
          }
        </tr></table>
      </td></tr>`
    : '';
  const rows = summary.rows
    .map((r) =>
      r.total
        ? `<tr>
            <td style="padding:12px 0 0;border-top:1px solid ${LINE};font-family:${FONT};font-size:16px;line-height:22px;font-weight:800;color:${INK};">${escapeHtml(r.label)}</td>
            <td align="right" style="padding:12px 0 0;border-top:1px solid ${LINE};font-family:${FONT};font-size:16px;line-height:22px;font-weight:800;color:${INK};white-space:nowrap;">${escapeHtml(r.value)}</td>
          </tr>`
        : `<tr>
            <td style="padding:8px 0 0;font-family:${FONT};font-size:14px;line-height:20px;color:${TEXT};">${escapeHtml(r.label)}</td>
            <td align="right" style="padding:8px 0 0;font-family:${FONT};font-size:14px;line-height:20px;color:${TEXT};white-space:nowrap;">${escapeHtml(r.value)}</td>
          </tr>`,
    )
    .join('');
  const notes = (summary.notes ?? [])
    .filter((n) => n.trim())
    .map(
      (n) =>
        `<div style="font-family:${FONT};font-size:13px;line-height:19px;color:${MUTED};margin-top:8px;">${escapeHtml(n)}</div>`,
    )
    .join('');
  return `<tr><td class="dc-pad" style="padding:8px 32px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PANEL}" style="background-color:${PANEL};border:1px solid ${LINE};border-radius:12px;">
      <tr><td style="padding:18px 20px 18px;">
        <div style="font-family:${FONT};font-size:12px;line-height:16px;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};margin-bottom:12px;">${escapeHtml(summary.heading)}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${itemRow}
          ${rows}
        </table>
        ${notes}
      </td></tr>
    </table>
  </td></tr>`;
}

function sectionHtml(section: EmailSection, color: string): string {
  const lines = section.lines
    .filter((l) => l.trim())
    .map(
      (l) =>
        `<div style="font-family:${FONT};font-size:14px;line-height:21px;color:${TEXT};">${linkifyEmail(escapeHtml(l))}</div>`,
    )
    .join('');
  const link =
    section.link && isHttpUrl(section.link.url)
      ? `<div style="margin-top:6px;"><a href="${escapeHtmlAttr(section.link.url)}" target="_blank" style="font-family:${FONT};font-size:14px;line-height:21px;font-weight:600;color:${color};text-decoration:underline;">${escapeHtml(section.link.label)}</a></div>`
      : '';
  return `<tr><td class="dc-pad" style="padding:22px 32px 0;">
    <div style="font-family:${FONT};font-size:12px;line-height:16px;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};margin-bottom:6px;">${escapeHtml(section.heading)}</div>
    ${lines}
    ${link}
  </td></tr>`;
}

/** Un correo suelto en el texto ya escapado → enlace `mailto:`. */
function linkifyEmail(escaped: string): string {
  return escaped.replace(
    /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    (addr) => `<a href="mailto:${addr}" style="color:inherit;">${addr}</a>`,
  );
}

/** Columnas alineadas para la versión de texto: «Total pagado ........ 49,00 €». */
function textRows(rows: Array<{ label: string; value: string }>): string[] {
  return rows.map((r) => `${r.label}: ${r.value}`);
}

/**
 * Renderiza un email con la marca del tenant. Devuelve `{ html, text }`.
 *
 * Maqueta de correo «a prueba de clientes»: tablas, estilos en línea, colores
 * con `bgcolor` además de `background-color` (Outlook y el modo oscuro de
 * Gmail ignoran `background:`), ancho máximo de 600 px y una media query que en
 * el móvil apila las columnas y estrecha los márgenes. El `text` es la misma
 * información en plano (cabecera de recibo, cuerpo, botón como URL, resumen,
 * secciones, firma y pie) para quien no ve HTML.
 */
export function renderBrandedEmail(
  branding: EmailBranding,
  content: BrandedEmailContent,
): { html: string; text: string } {
  const name = escapeHtml(branding.tenantName);
  const color = /^#[0-9a-f]{6}$/i.test(branding.brandColor) ? branding.brandColor : '#1E5AA8';
  const signature = content.signature ?? true;

  const header = isHttpUrl(branding.logoUrl)
    ? `<img src="${escapeHtmlAttr(branding.logoUrl)}" alt="${escapeHtmlAttr(
        branding.tenantName,
      )}" height="40" style="display:block;height:40px;max-height:40px;max-width:220px;width:auto;border:0;" />`
    : `<span style="font-family:${FONT};font-size:20px;line-height:28px;font-weight:800;color:${INK};">${name}</span>`;

  const titleHtml = content.title
    ? `<h1 style="margin:0 0 14px;font-family:${FONT};font-size:22px;line-height:30px;font-weight:800;color:${INK};">${escapeHtml(
        content.title,
      )}</h1>`
    : '';

  const ctaHtml = content.cta
    ? `<div style="margin:22px 0 0;">${buttonHtml(color, content.cta.url, content.cta.label)}</div>${
        content.ctaNote
          ? `<div style="margin-top:10px;font-family:${FONT};font-size:13px;line-height:19px;color:${MUTED};">${escapeHtml(content.ctaNote)}</div>`
          : ''
      }`
    : '';

  const preheader = content.preheader
    ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:${CANVAS};">${escapeHtml(
        content.preheader,
      )}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>`
    : '';

  const footerLines = [
    ...(content.footerNote ? [content.footerNote] : []),
    ...(content.finePrint ?? []),
  ]
    .filter((l) => l.trim())
    .map(
      (l) =>
        `<p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">${linkifyEmail(escapeHtml(l))}</p>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="${content.lang}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="color-scheme" content="light" /><meta name="supported-color-schemes" content="light" />
<style>
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
  a { color:${color}; }
  @media only screen and (max-width:620px) {
    .dc-outer { padding:0 !important; }
    .dc-card { width:100% !important; border-radius:0 !important; border-left:0 !important; border-right:0 !important; }
    .dc-pad { padding-left:20px !important; padding-right:20px !important; }
    .dc-fact { display:block !important; width:100% !important; padding:8px 0 !important; }
    .dc-amount { font-size:30px !important; line-height:38px !important; }
  }
</style></head>
<body style="margin:0;padding:0;background-color:${CANVAS};">
${preheader}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CANVAS}" style="background-color:${CANVAS};">
    <tr><td class="dc-outer" align="center" style="padding:28px 12px;">
      <table role="presentation" class="dc-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid ${LINE};border-radius:16px;overflow:hidden;">
        <tr><td height="5" bgcolor="${color}" style="height:5px;line-height:5px;font-size:0;background-color:${color};">&nbsp;</td></tr>
        <tr><td class="dc-pad" style="padding:24px 32px 0;">${header}</td></tr>
        ${content.hero ? heroHtml(content.hero) : ''}
        <tr><td class="dc-pad" style="padding:26px 32px 4px;">
          ${titleHtml}
          <div style="font-family:${FONT};font-size:15px;line-height:24px;color:${TEXT};">${content.bodyHtml}</div>
          ${ctaHtml}
        </td></tr>
        ${content.summary ? summaryHtml(content.summary) : ''}
        ${(content.sections ?? []).map((s) => sectionHtml(s, color)).join('')}
        <tr><td class="dc-pad" style="padding:26px 32px 28px;">${
          signature
            ? `<p style="margin:0;font-family:${FONT};font-size:14px;line-height:20px;color:${MUTED};">— ${name}</p>`
            : ''
        }</td></tr>
        <tr><td class="dc-pad" bgcolor="${PANEL}" style="padding:18px 32px 20px;background-color:${PANEL};border-top:1px solid ${LINE};">
          ${footerLines}
          <p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:#9ca3af;">Powered by Didacta</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const hero = content.hero
    ? [
        content.hero.eyebrow,
        content.hero.amount,
        ...(content.hero.amountNote ? [content.hero.amountNote] : []),
        ...textRows(content.hero.facts.filter((f) => f.value.trim())),
        '',
      ]
    : [];
  const summary = content.summary
    ? [
        '',
        content.summary.heading.toUpperCase(),
        ...(content.summary.item
          ? [
              [
                content.summary.item.title,
                content.summary.item.subtitle ? `(${content.summary.item.subtitle})` : '',
                content.summary.item.amount ? `— ${content.summary.item.amount}` : '',
              ]
                .filter(Boolean)
                .join(' '),
            ]
          : []),
        ...textRows(content.summary.rows),
        ...(content.summary.notes ?? []).filter((n) => n.trim()),
      ]
    : [];
  const sections = (content.sections ?? []).flatMap((s) => [
    '',
    s.heading.toUpperCase(),
    ...s.lines.filter((l) => l.trim()),
    ...(s.link && isHttpUrl(s.link.url) ? [`${s.link.label}: ${s.link.url}`] : []),
  ]);
  const textParts = [
    ...hero,
    ...(content.title ? [content.title, ''] : []),
    content.bodyText,
    ...(content.cta ? ['', `${content.cta.label}: ${content.cta.url}`] : []),
    ...(content.ctaNote ? [content.ctaNote] : []),
    ...summary,
    ...sections,
    ...(signature ? ['', `— ${branding.tenantName}`] : []),
    '',
    '—',
    ...(content.footerNote ? [content.footerNote] : []),
    ...(content.finePrint ?? []).filter((l) => l.trim()),
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
