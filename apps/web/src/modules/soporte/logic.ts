/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Lógica pura de mod.soporte («Ayuda y sugerencias»): tipos, validación y cómo
 * se arma lo que se envía. Sin React, sin red y SIN TEXTOS: devuelve claves
 * del catálogo `modSoporte` (es/en/pt) y la pantalla las traduce.
 */

export type TipoTicket = 'FALLO' | 'PROBLEMA' | 'MEJORA';
export type EstadoTicket = 'NUEVO' | 'EN_CURSO' | 'RESUELTO' | 'DESCARTADO';
export type TipoCaptura = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ContextoTicket {
  url?: string;
  userAgent?: string;
  viewport?: string;
  at?: string;
}

export interface CapturaInput {
  /** Contenido en base64, sin el prefijo `data:...,`. */
  data: string;
  filename: string;
  contentType: TipoCaptura;
}

export interface CrearTicketInput {
  tipo: TipoTicket;
  texto: string;
  contexto?: ContextoTicket;
  captura?: CapturaInput;
}

/**
 * Los tres tipos, en el orden en que salen en la ventana. La sugerencia va la
 * primera y viene marcada: la ventana es también el buzón de sugerencias. Sus
 * textos (etiqueta, ayuda, pregunta y pista) están en `modSoporte.tipos.<TIPO>`.
 */
export const TIPOS: readonly TipoTicket[] = ['MEJORA', 'FALLO', 'PROBLEMA'];

export const ESTADOS: readonly EstadoTicket[] = ['NUEVO', 'EN_CURSO', 'RESUELTO', 'DESCARTADO'];

export type VarianteBadge = 'info' | 'warning' | 'success' | 'muted';

const BADGE_ESTADO: Record<EstadoTicket, VarianteBadge> = {
  NUEVO: 'info',
  EN_CURSO: 'warning',
  RESUELTO: 'success',
  DESCARTADO: 'muted',
};

export const TEXTO_MIN = 5;
export const TEXTO_MAX = 4000;
export const NOTA_MAX = 4000;
export const CAPTURA_MAX_BYTES = 5 * 1024 * 1024;
export const TIPOS_CAPTURA: readonly TipoCaptura[] = ['image/png', 'image/jpeg', 'image/webp'];

export function estadoBadge(estado: EstadoTicket): VarianteBadge {
  return BADGE_ESTADO[estado] ?? 'muted';
}

/** Clave de `modSoporte.validacion` del texto, o `null` si vale. Cuenta sin los espacios de los bordes. */
export function validarTexto(texto: string): 'vacio' | 'corto' | 'largo' | null {
  const t = texto.trim();
  if (!t) return 'vacio';
  if (t.length < TEXTO_MIN) return 'corto';
  if (t.length > TEXTO_MAX) return 'largo';
  return null;
}

/** Clave de `modSoporte.validacion` de la captura, o `null` si vale. */
export function validarCaptura(file: {
  type: string;
  size: number;
}): 'capturaTipo' | 'capturaPesada' | null {
  if (!(TIPOS_CAPTURA as readonly string[]).includes(file.type)) return 'capturaTipo';
  if (file.size > CAPTURA_MAX_BYTES) return 'capturaPesada';
  return null;
}

/**
 * La página sin parámetros ni ancla: a veces llevan claves de un solo uso (un
 * enlace de restablecer contraseña, por ejemplo) y el equipo no las necesita.
 */
export function paginaSinParametros(href: string): string {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}`;
  } catch {
    return href.split(/[?#]/)[0] ?? '';
  }
}

/** Lo que se manda sin que la persona lo escriba: página, navegador, ventana y hora. */
export function construirContexto(env: {
  href: string;
  userAgent: string;
  innerWidth: number;
  innerHeight: number;
  now: Date;
}): Required<ContextoTicket> {
  return {
    url: paginaSinParametros(env.href),
    userAgent: env.userAgent,
    viewport: `${env.innerWidth}x${env.innerHeight}`,
    at: env.now.toISOString(),
  };
}

export function construirPayload(input: CrearTicketInput): CrearTicketInput {
  const payload: CrearTicketInput = { tipo: input.tipo, texto: input.texto.trim() };
  if (input.contexto) payload.contexto = input.contexto;
  if (input.captura) payload.captura = input.captura;
  return payload;
}

export function filtrosAQuery(f: { estado?: EstadoTicket | ''; tipo?: TipoTicket | '' }): string {
  const qs = new URLSearchParams();
  if (f.estado) qs.set('estado', f.estado);
  if (f.tipo) qs.set('tipo', f.tipo);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/** El `?ticket=<id>` de la URL, o `null`. */
export function ticketPedido(valor: string | null | undefined): string | null {
  const v = valor?.trim();
  return v ? v : null;
}

/** La bandeja del equipo es solo de super_admin y tenant_admin (ni formador ni moderador). */
export function puedeVerBandeja(roles: readonly string[]): boolean {
  return roles.includes('super_admin') || roles.includes('tenant_admin');
}

/**
 * La URL del contexto solo se enlaza si es http(s): la manda el navegador del
 * miembro y podría traer un `javascript:`. Lo demás se pinta como texto.
 */
export function urlEnlazable(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
