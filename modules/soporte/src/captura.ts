/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { CapturaInvalidaError } from './errors.js';

/**
 * Captura de pantalla de un ticket: qué se admite y cómo se comprueba, sin
 * fiarse del navegador. Una imagen PNG, JPEG o WebP (nunca SVG, que puede
 * llevar código) de hasta 5 MB, enviada en base64.
 */

export const CAPTURA_TIPOS = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type CapturaTipo = (typeof CAPTURA_TIPOS)[number];

export const CAPTURA_MAX_BYTES = 5 * 1024 * 1024;

/** Largo máximo del nombre que se guarda y se enseña. */
const NOMBRE_MAX = 120;

const EXT_POR_TIPO: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface CapturaInput {
  /** Bytes en base64, sin el prefijo `data:...,`. */
  data: string;
  filename: string;
  contentType: string;
}

export interface CapturaValida {
  contentType: CapturaTipo;
  /** Nombre saneado, con la extensión de su tipo. */
  nombre: string;
  data: Buffer;
}

/** Extensión que corresponde a un tipo de imagen (`bin` si no es uno conocido). */
export function extensionDe(contentType: string): string {
  return EXT_POR_TIPO[contentType] ?? 'bin';
}

function empiezaPor(data: Buffer, bytes: number[], offset = 0): boolean {
  if (data.length < offset + bytes.length) return false;
  return bytes.every((b, i) => data[offset + i] === b);
}

/** Tipo real por los primeros bytes; null si no es una imagen admitida. */
export function tipoReal(data: Buffer): CapturaTipo | null {
  if (empiezaPor(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (empiezaPor(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // RIFF....WEBP
  if (empiezaPor(data, [0x52, 0x49, 0x46, 0x46]) && empiezaPor(data, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return null;
}

/**
 * Nombre que se guarda y se enseña: solo el último tramo de la ruta, sin
 * caracteres de control ni de dirección del texto (con ellos «gpj.exe» se lee
 * «exe.jpg»), recortado y con la extensión de su tipo.
 */
export function sanearNombre(filename: string, contentType: string): string {
  const ext = extensionDe(contentType);
  const ultimo = filename.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const limpio = ultimo.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '').trim();
  const punto = limpio.lastIndexOf('.');
  const base = (punto > 0 ? limpio.slice(0, punto) : limpio).trim() || 'captura';
  return `${base.slice(0, NOMBRE_MAX - ext.length - 1)}.${ext}`;
}

/**
 * Comprueba la captura antes de guardar nada: tipo de la lista, base64 bien
 * formado, ni vacía ni de más de 5 MB, y bytes que casan con el tipo declarado
 * (una página HTML que dice ser PNG no pasa).
 */
export function validarCaptura(input: CapturaInput): CapturaValida {
  const declarado = (typeof input.contentType === 'string' ? input.contentType : '')
    .trim()
    .toLowerCase();
  if (!(CAPTURA_TIPOS as readonly string[]).includes(declarado)) {
    throw new CapturaInvalidaError('TIPO');
  }
  const b64 = typeof input.data === 'string' ? input.data.trim() : '';
  if (!b64) throw new CapturaInvalidaError('VACIA');
  if (b64.length % 4 === 1 || !BASE64_RE.test(b64)) {
    throw new CapturaInvalidaError('ILEGIBLE');
  }
  // Antes de decodificar: el base64 ocupa 4/3 de los bytes.
  if (Math.floor((b64.length * 3) / 4) > CAPTURA_MAX_BYTES + 2) {
    throw new CapturaInvalidaError('PESADA');
  }
  const data = Buffer.from(b64, 'base64');
  if (data.length === 0) throw new CapturaInvalidaError('VACIA');
  if (data.length > CAPTURA_MAX_BYTES) throw new CapturaInvalidaError('PESADA');
  if (tipoReal(data) !== declarado) throw new CapturaInvalidaError('NO_CASA');
  return {
    contentType: declarado as CapturaTipo,
    nombre: sanearNombre(typeof input.filename === 'string' ? input.filename : '', declarado),
    data,
  };
}
