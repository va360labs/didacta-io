/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  academyInitials,
  academyMarkColors,
  drawableWithLatinFont,
  NEUTRAL_GLYPH_PATHS,
  NEUTRAL_MARK_COLORS,
  type MarkColors,
} from './academy-mark';
import type { PublicBrand } from './seo-server';

/**
 * Las imágenes de la marca por defecto del aula, en el JSX que entiende
 * `next/og` (Satori: solo flexbox y estilos en línea). Las sirven
 * `app/academy-brand/icon` (favicon) y `app/academy-brand/og` (vista previa en
 * redes) cuando el aula no tiene favicon, logo ni portada propios.
 *
 * El generador solo lleva una fuente (Noto Sans, alfabeto latino) y no puede
 * pedir otras por red en una instalación propia: un nombre que no se puede
 * dibujar con ella (cirílico, CJK) no se escribe y las iniciales pasan al
 * símbolo neutro; los emojis se quitan.
 */

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

export interface BrandArt {
  /** Iniciales dibujables, o `''` (símbolo neutro). */
  initials: string;
  /** Nombre dibujable, o `''` (no se escribe). */
  name: string;
  colors: MarkColors;
}

/** Qué se dibuja para un aula (o para «ningún aula»: `null`). */
export function brandArt(
  brand: Pick<PublicBrand, 'name' | 'brandHue' | 'brandSaturation'> | null,
): BrandArt {
  const raw = academyInitials(brand?.name);
  const initials = drawableWithLatinFont(raw) ? raw : '';
  const cleanName = (brand?.name ?? '').replace(EMOJI, '').replace(/\s+/g, ' ').trim();
  const name = drawableWithLatinFont(cleanName) ? cleanName : '';
  const colors = raw
    ? academyMarkColors(brand?.brandHue, brand?.brandSaturation)
    : NEUTRAL_MARK_COLORS;
  return { initials, name, colors };
}

function Glyph({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {NEUTRAL_GLYPH_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Favicon: el monograma a sangre, con las esquinas del logo (salvo el de iOS). */
export function IconArt({ art, size, rounded }: { art: BrandArt; size: number; rounded: boolean }) {
  const { initials, colors } = art;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.background,
        borderRadius: rounded ? Math.round(size * 0.22) : 0,
        color: colors.foreground,
        fontSize: Math.round(size * (initials.length > 1 ? 0.46 : 0.58)),
        letterSpacing: initials.length > 1 ? -Math.round(size * 0.015) : 0,
      }}
    >
      {initials || <Glyph size={Math.round(size * 0.6)} color={colors.foreground} />}
    </div>
  );
}

/** Vista previa para redes (1200×630): el monograma grande y el nombre del aula. */
export function OgArt({ art, host }: { art: BrandArt; host: string | null }) {
  const { initials, name, colors } = art;
  const nameSize = name.length <= 22 ? 76 : name.length <= 40 ? 60 : 46;
  const shownName = name.length > 70 ? `${name.slice(0, 69).trimEnd()}…` : name;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 96px',
        backgroundColor: colors.background,
        backgroundImage:
          'radial-gradient(circle at 88% 12%, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0) 46%)',
        color: colors.foreground,
      }}
    >
      <div
        style={{
          width: 184,
          height: 184,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 40,
          backgroundColor: colors.foreground,
          color: colors.background,
          fontSize: initials.length > 1 ? 88 : 104,
          letterSpacing: initials.length > 1 ? -3 : 0,
        }}
      >
        {initials || <Glyph size={112} color={colors.background} />}
      </div>
      {shownName ? (
        <div
          style={{
            display: 'flex',
            marginTop: 52,
            fontSize: nameSize,
            lineHeight: 1.1,
            letterSpacing: -1,
            maxWidth: 1008,
          }}
        >
          {shownName}
        </div>
      ) : null}
      {host && drawableWithLatinFont(host) ? (
        <div style={{ display: 'flex', marginTop: 20, fontSize: 30, opacity: 0.78 }}>{host}</div>
      ) : null}
    </div>
  );
}

/**
 * Redirección a una imagen propia del aula (favicon, logo, portada). Solo una
 * URL `https://` o una ruta del propio dominio: lo que venga raro no se sigue y
 * se genera la marca por defecto.
 */
export function redirectToOwnImage(url: string | null): Response | null {
  if (!url) return null;
  const ok = /^https?:\/\//i.test(url) || (url.startsWith('/') && !url.startsWith('//'));
  if (!ok) return null;
  return new Response(null, {
    status: 302,
    headers: { location: url, 'cache-control': BRAND_IMAGE_CACHE },
  });
}

/**
 * Cinco minutos: un logo nuevo tarda como mucho eso en verse en la pestaña, y
 * los rastreadores de redes no piden la imagen en cada visita.
 */
export const BRAND_IMAGE_CACHE = 'public, max-age=300, stale-while-revalidate=3600';

/**
 * Caché de la imagen generada: la de siempre con la marca del aula, y ninguna
 * sin ella. La versión neutra sale cuando aún no se ha podido saber la marca
 * (la API no contestó y no había una buena guardada): si el navegador se la
 * quedara cinco minutos —más una hora de `stale-while-revalidate`—, la pestaña
 * seguiría sin la marca del aula mucho después de que la API vuelva.
 */
export function brandImageCacheControl(brand: unknown): string {
  return brand ? BRAND_IMAGE_CACHE : 'no-store';
}
